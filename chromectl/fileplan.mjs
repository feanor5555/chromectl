/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * What one call of the chromectl front writes and reads.
 *
 * This is where the front's ownership of every file path is enforced. A caller
 * names at most a file, never a directory and never a path: `planCall` fills
 * every path argument of the command table in itself, and `daemonPathArguments`
 * is the only thing that produces what the daemon is handed. Around those two
 * sits everything that keeps the ownership true over the life of a call — the
 * caller-chosen names in flight, the staging copies, and what a call that failed
 * left behind. The chores each of those ends in are `filestore.mjs`'s.
 *
 * The table of path arguments is read here and declared in
 * `filearguments.mjs`; importing that module is what holds the table against
 * the command table and against the endings the front can serve, so nothing
 * reaches the daemon under an argument nobody accounted for.
 */

import {createWriteStream} from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import {pipeline} from 'node:stream/promises';

import {CallError} from './errors.mjs';
import {extensionsOf, FILE_ARGUMENTS} from './filearguments.mjs';
import {
  generatedFilePath,
  generatedName,
  MAX_FILE_NAME_LENGTH,
  OUTPUT_DIR,
  OUTPUT_FILE_MODE,
  PLAIN_FILE_NAME_PATTERN,
  STAGING_DIR_MODE,
} from './filenames.mjs';
import {
  ensureOutputDir,
  removeStagingDirectory,
  settleLeftoverFile,
} from './filestore.mjs';

/**
 * The caller-chosen output names in flight, each with the browser that took it
 * and how many of its calls hold it. `OUTPUT_DIR` is flat and its names carry no
 * target, so two browsers writing `page.txt` at the same time would both stage
 * under their own random name and then both rename onto that one file: nothing
 * is corrupted, the loser's answer merely names a file that holds the other
 * browser's page, with its own byte count beside it and no way for either caller
 * to notice. Two calls of the same browser are the caller's own sequence and
 * keep the last one, as any two writes to one name do.
 */
const claimedOutputNames = new Map();

/**
 * Takes one caller-chosen name for the browser that is about to write it, or
 * refuses the call while another browser holds it. The refusal is a `busy`, the
 * same kind a call queued behind another gets: the name is free again as soon as
 * that call has ended, and picking another one is the caller's other way on.
 */
function claimOutputName(command, argument, fileName, resolved) {
  const claim = claimedOutputNames.get(fileName);
  if (claim === undefined) {
    claimedOutputNames.set(fileName, {
      sessionId: resolved.sessionId,
      holders: 1,
    });
    return;
  }
  if (claim.sessionId !== resolved.sessionId) {
    throw new CallError(
      'busy',
      `${command}: ${argument} ${fileName} is being written by another browser ` +
        'right now — name another file, or wait for that call to end',
    );
  }
  claim.holders += 1;
}

/** Gives one name back. */
export function releaseOutputName(file) {
  if (!file.claimed) {
    return;
  }
  file.claimed = false;
  const claim = claimedOutputNames.get(file.fileName);
  if (claim === undefined) {
    return;
  }
  claim.holders -= 1;
  if (claim.holders <= 0) {
    claimedOutputNames.delete(file.fileName);
  }
}

/**
 * Gives the names of one finished call back. The name of a recording is not one
 * of them: its file is written until the stopping call renames it, so the claim
 * stays with the entry and is given back when that entry is dropped.
 *
 * Such an entry is not in this plan: `detachPlanFile` takes it out where
 * `fileresult.mjs` parks it as the running recording of a browser, and
 * `forgetRecording` gives the name back through `releaseOutputName` and settles
 * what the recording left.
 */
export function releaseOutputNames(plan) {
  for (const file of plan.files) {
    releaseOutputName(file);
  }
}

/**
 * Takes one file out of a plan, so that nothing which settles or releases the
 * plan reaches it any more.
 *
 * The plan gets a new array rather than having the entry taken out of the one
 * it holds: a caller may be walking that array, and an iteration begun over it
 * keeps the array it started on.
 */
export function detachPlanFile(plan, file) {
  plan.files = plan.files.filter(entry => entry !== file);
}

/**
 * Plans one file a call writes.
 *
 * The front runs without authentication, so a path taken from the caller would
 * write anywhere the front's user can write, with page-controlled content. The
 * directory is therefore the front's decision and the caller names at most the
 * file: a name that is not a plain file name with the ending the tool enforces
 * is refused rather than bent into one, so nobody believes their path was
 * honoured. A caller that names none gets a name of the front's own.
 *
 * A caller's name never reaches the daemon. The daemon writes to `writePath`, a
 * name the front builds itself with eight random characters, and the written
 * file is renamed onto the caller's name afterwards. That is what keeps the
 * write inside the directory: the drive is writable over Samba and NFS, so
 * anyone reaching it can put a symlink or a hardlink under a name a caller
 * announced, and a check the front makes here says nothing about the entry the
 * daemon meets a moment later, in another process. Against the random name there
 * is nothing to plant, and `rename` replaces the name rather than writing
 * through what sits under it, so no interleaving reaches an inode outside
 * `OUTPUT_DIR`. A file the front names itself is written straight where the
 * answer points, since there is nothing to plant under that name either.
 *
 * The checks below are pre-flight only: they turn the ordinary mistake — a name
 * that is a directory today, a name someone hardlinked — into a clear 400 before
 * the browser is driven at all. They are no longer the boundary, and an entry
 * planted after them is replaced by the rename rather than refused.
 */
async function planOutputFile(command, argument, spec, resolved, toolArgs) {
  const extensions = extensionsOf(command, spec, toolArgs);
  const requested = toolArgs[argument];

  if (requested === undefined) {
    const {fileName, filePath} = generatedFilePath(
      resolved.target,
      extensions[0],
    );
    return {
      ...spec,
      argument,
      fileName,
      filePath,
      writePath: filePath,
    };
  }

  const extension = extensions.find(candidate =>
    requested.endsWith(`.${candidate}`),
  );
  if (!PLAIN_FILE_NAME_PATTERN.test(requested) || extension === undefined) {
    throw new CallError(
      'usage',
      `${command}: ${argument} must be a plain file name of at most ` +
        `${MAX_FILE_NAME_LENGTH} characters ending in ` +
        `${extensions.map(candidate => `.${candidate}`).join(' or ')} — the ` +
        `front writes it to ${OUTPUT_DIR} and no path leaves that directory`,
    );
  }

  const filePath = path.join(OUTPUT_DIR, requested);
  let existing;
  try {
    existing = await fs.lstat(filePath);
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw new CallError('storage', `cannot write ${filePath}`, error.message);
    }
  }
  if (existing !== undefined && !existing.isFile()) {
    throw new CallError(
      'usage',
      `${command}: ${requested} exists in ${OUTPUT_DIR} and is not a regular file`,
    );
  }
  if (existing !== undefined && existing.nlink !== 1) {
    throw new CallError(
      'usage',
      `${command}: ${requested} exists in ${OUTPUT_DIR} under more than one name`,
    );
  }
  claimOutputName(command, argument, requested, resolved);

  const staging = generatedFilePath(resolved.target, extension);
  return {
    ...spec,
    argument,
    fileName: requested,
    filePath,
    claimed: true,
    writePath: staging.filePath,
  };
}

/**
 * Plans the directory a call fills with files it names itself.
 *
 * The names inside are the tool's, not the front's, so two calls sharing one
 * directory would write over each other and neither file would be one the fetch
 * route recognises. Each call therefore gets a directory of its own, whose name
 * carries the same eight random characters every generated name does, and the
 * files are taken out of it afterwards. The whole location is the front's
 * business here: a caller-named directory would be a location the caller may not
 * reach, so the argument is refused instead of being silently overwritten.
 */
async function planOutputDirectory(command, argument, spec, target, toolArgs) {
  if (toolArgs[argument] !== undefined) {
    throw new CallError(
      'usage',
      `${command}: ${argument} is not a caller argument — the front collects ` +
        `the files into ${OUTPUT_DIR} and returns their locations`,
    );
  }
  const directoryPath = path.join(OUTPUT_DIR, generatedName(target));
  try {
    await fs.mkdir(directoryPath, {mode: STAGING_DIR_MODE});
  } catch (error) {
    throw new CallError(
      'storage',
      `cannot create ${directoryPath}`,
      error.message,
    );
  }
  return {argument, path: directoryPath, reports: spec.reports, target};
}

/**
 * Plans one file or directory a call reads.
 *
 * It has to lie directly in `OUTPUT_DIR`, so the caller names it and nothing
 * else: the directory is the network drive every machine reaches, which is how a
 * file gets to the front's machine at all, and a path from the caller would
 * otherwise read anything the front's user can read.
 *
 * A file that is uploaded into a page is copied to a staging name first and the
 * daemon is handed the copy. That is the same reasoning as for a written file,
 * in the other direction: an entry someone plants under the announced name
 * between this check and the daemon's open would otherwise be followed out of
 * the directory, and what a page then receives is whatever that entry pointed
 * at. The copy is read through a handle this process opened itself, with
 * symlinks refused by the open and a hardlink refused by the count on the open
 * handle, so what is uploaded is the file this check saw.
 *
 * A directory and a heap snapshot are read in place: a snapshot is hundreds of
 * megabytes and is addressed by its path again by every following reader call,
 * so the check here is pre-flight and stays what it is — it catches the ordinary
 * mistake, not someone with write access to the share swapping the entry
 * underneath the call.
 */
async function planInputFile(command, argument, spec, target, toolArgs) {
  const requested = toolArgs[argument];
  const endings = extensionsOf(command, spec, toolArgs);
  if (
    !PLAIN_FILE_NAME_PATTERN.test(requested) ||
    (endings.length > 0 &&
      !endings.some(candidate => requested.endsWith(`.${candidate}`)))
  ) {
    throw new CallError(
      'usage',
      `${command}: ${argument} must be a plain name of at most ` +
        `${MAX_FILE_NAME_LENGTH} characters` +
        (endings.length > 0
          ? ` ending in ${endings.map(candidate => `.${candidate}`).join(' or ')}`
          : '') +
        ` of an entry in ${OUTPUT_DIR} — that directory is the drive every ` +
        'machine reaches, and no path leaves it',
    );
  }

  const filePath = path.join(OUTPUT_DIR, requested);
  let stats;
  try {
    stats = await fs.lstat(filePath);
  } catch (error) {
    throw new CallError(
      'usage',
      `${command}: there is no ${requested} in ${OUTPUT_DIR}`,
      error.message,
    );
  }
  if (spec.direction === 'in-dir') {
    if (!stats.isDirectory()) {
      throw new CallError(
        'usage',
        `${command}: ${requested} in ${OUTPUT_DIR} is not a directory`,
      );
    }
    return {argument, filePath, readPath: filePath};
  }
  if (!stats.isFile()) {
    throw new CallError(
      'usage',
      `${command}: ${requested} in ${OUTPUT_DIR} is not a regular file`,
    );
  }
  if (stats.nlink !== 1) {
    throw new CallError(
      'usage',
      `${command}: ${requested} in ${OUTPUT_DIR} exists under more than one name`,
    );
  }
  if (!spec.staged) {
    return {argument, filePath, readPath: filePath};
  }
  return await stageInputFile(command, argument, target, requested, filePath);
}

/**
 * Copies the file a call is to read into a directory of its own and hands back
 * the copy. The name inside the directory stays the caller's, because that is
 * the name a page receiving an upload is shown.
 */
async function stageInputFile(command, argument, target, fileName, filePath) {
  const directoryPath = path.join(OUTPUT_DIR, generatedName(target));
  const readPath = path.join(directoryPath, fileName);
  let handle;
  try {
    await fs.mkdir(directoryPath, {mode: STAGING_DIR_MODE});
    handle = await fs.open(
      filePath,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
    );
    const stats = await handle.stat();
    if (!stats.isFile() || stats.nlink !== 1) {
      throw new Error('not a single-named regular file of this directory');
    }
    await pipeline(
      handle.createReadStream(),
      createWriteStream(readPath, {flags: 'wx', mode: OUTPUT_FILE_MODE}),
    );
  } catch (error) {
    await removeStagingDirectory(directoryPath);
    throw new CallError(
      'usage',
      `${command}: ${argument} ${fileName} cannot be read from ${OUTPUT_DIR}`,
      error.message,
    );
  } finally {
    await handle?.close();
  }
  return {argument, filePath, readPath, directoryPath};
}

/** What one call writes and reads, from its arguments and `FILE_ARGUMENTS`. */
export async function planCall(command, resolved, toolArgs) {
  const specs = FILE_ARGUMENTS[command];
  const plan = {command, files: [], inputs: [], directory: undefined};
  if (!specs) {
    return plan;
  }

  await ensureOutputDir();
  try {
    for (const [argument, spec] of Object.entries(specs)) {
      const named = toolArgs[argument] !== undefined;
      if (spec.direction === 'out-dir') {
        plan.directory = await planOutputDirectory(
          command,
          argument,
          spec,
          resolved.target,
          toolArgs,
        );
      } else if (spec.direction === 'out') {
        if (named || spec.always) {
          plan.files.push(
            await planOutputFile(command, argument, spec, resolved, toolArgs),
          );
        }
      } else if (named) {
        plan.inputs.push(
          await planInputFile(
            command,
            argument,
            spec,
            resolved.target,
            toolArgs,
          ),
        );
      }
    }
  } catch (error) {
    // A call whose plan does not come together drives nothing, so what an
    // earlier argument of it already put on the drive goes again, and the names
    // it had taken are free for the next call.
    await settleLeftoverFiles(plan);
    await removeStagedInputs(plan);
    releaseOutputNames(plan);
    throw error;
  }

  // The echoed argument is the path the caller ends up with; what the daemon is
  // handed is the staging path beside it. The directory of a call is gone by the
  // time the answer is written, so it is echoed to nobody.
  for (const entry of [...plan.files, ...plan.inputs]) {
    toolArgs[entry.argument] = entry.filePath;
  }
  return plan;
}

/** The paths the daemon is handed in place of the echoed ones. */
export function daemonPathArguments(plan) {
  const paths = {};
  for (const file of plan.files) {
    paths[file.argument] = file.writePath;
  }
  for (const input of plan.inputs) {
    paths[input.argument] = input.readPath;
  }
  if (plan.directory) {
    paths[plan.directory.argument] = plan.directory.path;
  }
  return paths;
}

/**
 * Deals with what a failed call left behind: every file of its plan, and its
 * own directory with what is in it, since none of that was ever named in an
 * answer.
 */
export async function settleLeftoverFiles(plan) {
  for (const file of plan.files) {
    await settleLeftoverFile(file);
  }
  if (plan.directory) {
    await removeStagingDirectory(plan.directory.path);
  }
}

/** Removes the copies a call was handed to read. */
export async function removeStagedInputs(plan) {
  for (const input of plan.inputs) {
    if (input.directoryPath) {
      await removeStagingDirectory(input.directoryPath);
    }
  }
}
