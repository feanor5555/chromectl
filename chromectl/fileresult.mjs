/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * What one call of the chromectl front hands back.
 *
 * The plan `fileplan.mjs` produced is met here by what the daemon actually did
 * with it: every file is confirmed, made readable, put under the name the answer
 * carries and described with its location and its URL; every staging path the
 * tool names back is exchanged for the path a caller can reach; a result too
 * large to answer with is written out and named instead.
 *
 * This module owns `recordings`, the one piece of state that outlives the call
 * that created it: a screencast is written until a later call stops it. From
 * outside, that map is reached through `forgetRecording(sessionId)` and through
 * nothing else — the daemon lifecycle drops the plan of a recording that can no
 * longer be running by calling it, and never learns what a recording is.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

import {CallError} from './errors.mjs';
import {reportExtension} from './filearguments.mjs';
import {
  fileLocation,
  generatedFileName,
  OUTPUT_DIR,
  OUTPUT_FILE_MODE,
  SPILL_EXTENSION,
} from './filenames.mjs';
import {
  ensureOutputDir,
  releaseOutputName,
  removeStagingDirectory,
  settleLeftoverFile,
} from './fileplan.mjs';

/**
 * From how many bytes of rendered result on the answer names a file instead of
 * carrying the result: an operator setting, like the pacing figures, not a
 * measurement. It sits well above a routine snapshot, which is the caller's
 * source of uids and has to arrive to be of any use, and bites where an inline
 * answer has stopped being one — the page whose text runs into hundreds of
 * kilobytes.
 *
 * The check is on the rendered result rather than on a per-tool argument
 * because that is the only place every payload passes: `wait_for` and every
 * input command called with `includeSnapshot` end in a snapshot and have no
 * `filePath` argument at all.
 */
const SPILL_BYTES = Number(process.env['CHROMECTL_SPILL_BYTES'] ?? 131_072);
if (!Number.isInteger(SPILL_BYTES) || SPILL_BYTES <= 0) {
  // A typo here would read as "never spills", which is the failure the cap
  // exists to prevent, so it is a startup fault.
  throw new Error(
    `CHROMECTL_SPILL_BYTES must be a positive whole number of bytes, got ${JSON.stringify(process.env['CHROMECTL_SPILL_BYTES'])}`,
  );
}

/** How much of a spilled result the answer still carries, in characters. */
const SPILL_HEAD_CHARS = 2_048;

/**
 * The recording each browser has running, keyed by session id. A screencast is
 * the one file that is not there when the call that names it returns: ffmpeg
 * writes it until `screencast_stop`, which takes no path of its own. The plan is
 * therefore kept until then, so the stopping call can put the file under the
 * name the starting call announced and describe it.
 *
 * One plan belongs to one recording, and it goes when that recording can no
 * longer be running: with every `screencast_stop`, whether the stop succeeded or
 * failed, and with every new daemon generation, since ffmpeg is the daemon's
 * child and dies with it. A plan that outlived its recording would otherwise be
 * described by the next stop — a file that nobody wrote, under the name of a
 * recording that had ended long before.
 *
 * A start the daemon refuses because one is already running comes back as a
 * successful call carrying an error line. Nothing will be written to the plan of
 * that call, so the entry already there is kept and it is that entry the answer
 * names: the file the running recording goes to is the one this caller will get.
 */
const recordings = new Map();

/** The command that finishes a recording. */
export const RECORDING_STOP_COMMAND = 'screencast_stop';

/**
 * Drops the plan of a recording that can no longer be running and settles what
 * it left: on the ordinary path the stopping call has already renamed the file
 * onto the caller's name and there is nothing under the staging one, on every
 * other path the staging file is what a recording nobody will ever be told about
 * would sit in.
 */
export async function forgetRecording(sessionId) {
  const recording = recordings.get(sessionId);
  if (recording === undefined) {
    return;
  }
  recordings.delete(sessionId);
  releaseOutputName(recording);
  await settleLeftoverFile(recording);
}

/**
 * Puts the paths of the answer right. A tool names back the path it was handed,
 * which is the front's staging name and is gone a moment later; it names it in
 * its structured fields and in its own response lines alike, so the exchange is
 * made on the rendered result rather than field by field. Every path the front
 * builds is made of the output directory and a generated name, so neither side
 * of the exchange carries anything JSON escapes.
 */
export function withFinalPaths(rendered, replacements) {
  let result = rendered;
  for (const [writePath, filePath] of replacements) {
    if (writePath !== filePath) {
      result = result.split(writePath).join(filePath);
    }
  }
  return result;
}

/**
 * Every path of one call that exists for this process only, each with the path
 * the answer names in its place: the staging name a file is written under, the
 * copy an upload is read from, and the recording of that browser, whose staging
 * file is still being written while other calls run.
 */
function stagingReplacements(plan, sessionId) {
  const pairs = plan.files.map(file => [file.writePath, file.filePath]);
  for (const input of plan.inputs) {
    pairs.push([input.readPath, input.filePath]);
  }
  const recording = recordings.get(sessionId);
  if (recording) {
    pairs.push([recording.writePath, recording.filePath]);
  }
  return pairs;
}

/**
 * Turns a failed call into a storage failure when the daemon choked on a file
 * rather than on the page. A write that fails is an outage of the network drive
 * and must not read as a browser that could not carry the command out.
 *
 * The reason a failure carries is the daemon's own text, and the daemon only
 * ever saw the staging paths, so it is the text that names them; they are
 * exchanged for the paths the answer names, here as everywhere else.
 */
export function reclassifyFileFailure(error, plan, sessionId) {
  if (!(error instanceof CallError) || error.kind !== 'tool') {
    return error;
  }
  const written = [
    ...plan.files,
    ...(plan.directory
      ? [
          {
            kind: 'report directory',
            writePath: plan.directory.path,
            filePath: plan.directory.path,
          },
        ]
      : []),
  ];
  const detail =
    typeof error.detail === 'string'
      ? error.detail
      : JSON.stringify(error.detail ?? '');
  const clean = withFinalPaths(detail, stagingReplacements(plan, sessionId));
  const hit = written.find(file => detail.includes(file.writePath));
  if (hit) {
    return new CallError(
      'storage',
      `${hit.kind} could not be written to ${hit.filePath}`,
      clean,
    );
  }
  if (detail.includes(OUTPUT_DIR)) {
    return new CallError(
      'storage',
      `${plan.command} could not write below ${OUTPUT_DIR}`,
      clean,
    );
  }
  if (clean === detail) {
    return error;
  }
  return new CallError(error.kind, error.message, clean);
}

/**
 * Confirms the file the daemon was told to write really is there and makes it
 * readable for everyone reaching the drive, puts it under the name the answer
 * carries and describes it. A tool call that reports success without a file on
 * disk is a storage failure, not a result — unless the tool writes that file
 * only when the page had the content for it, in which case its absence is
 * reported as no file at all.
 *
 * The rename is what a caller-named file arrives through, and it is the last
 * step: an entry someone put under that name meanwhile is replaced, since
 * `rename` acts on the name and not on what it points at.
 */
async function describeWrittenFile(file, publicBase) {
  let stats;
  try {
    stats = await fs.stat(file.writePath);
    if (!stats.isFile() || stats.size === 0) {
      throw new Error(`${stats.size} bytes`);
    }
    await fs.chmod(file.writePath, OUTPUT_FILE_MODE);
    if (file.writePath !== file.filePath) {
      await fs.rename(file.writePath, file.filePath);
    }
  } catch (error) {
    if (file.optional) {
      await settleLeftoverFile(file);
      return undefined;
    }
    throw new CallError(
      'storage',
      `${file.kind} was not written to ${file.filePath}`,
      // The staging name is this process's business and names nothing a caller
      // can fetch, so it does not travel out in the reason either.
      withFinalPaths(String(error.message), [[file.writePath, file.filePath]]),
    );
  }

  return {
    ...fileLocation(file.fileName, file.filePath, publicBase),
    bytes: stats.size,
  };
}

/**
 * Takes the files a call left in its own directory out of it, under names the
 * fetch route serves, and removes the directory. A report the tool did not write
 * is not one the answer names.
 */
async function collectDirectoryFiles(directory, publicBase) {
  const collected = [];
  for (const [name, kind] of Object.entries(directory.reports)) {
    const source = path.join(directory.path, name);
    const fileName = generatedFileName(directory.target, reportExtension(name));
    const filePath = path.join(OUTPUT_DIR, fileName);
    let stats;
    try {
      stats = await fs.stat(source);
      await fs.chmod(source, OUTPUT_FILE_MODE);
      await fs.rename(source, filePath);
    } catch {
      continue;
    }
    collected.push({
      kind,
      source,
      descriptor: {
        ...fileLocation(fileName, filePath, publicBase),
        bytes: stats.size,
      },
    });
  }
  await removeStagingDirectory(directory.path);
  return collected;
}

/**
 * Describes the files one finished call left behind and says which staging path
 * in its result is which final one.
 *
 * Every path of the call is exchanged, whether or not a file was written under
 * it: the staging name is this process's business, a caller can neither fetch it
 * nor do anything with it, and a tool that names back the path it was handed
 * must not be quoted naming it. The two exchanges the plan alone does not say
 * come first — the file a call's own directory is emptied into, and the
 * recording a refused start is told about, which is the one already running and
 * not the one this call planned.
 */
export async function describeCallFiles(plan, resolved, command, publicBase) {
  const descriptors = {};
  const replacements = [];
  const parked = [];

  for (const file of plan.files) {
    if (file.deferred) {
      const running = recordings.get(resolved.sessionId);
      const started = running ?? file;
      if (running === undefined) {
        parked.push(file);
        recordings.set(resolved.sessionId, file);
      }
      descriptors[file.kind] = {
        ...fileLocation(started.fileName, started.filePath, publicBase),
        pending: true,
      };
      replacements.push([file.writePath, started.filePath]);
      continue;
    }
    const described = await describeWrittenFile(file, publicBase);
    if (described) {
      descriptors[file.kind] = described;
    }
  }

  // An entry parked as a running recording leaves the plan of the call that
  // planned it. Its file is written past the end of that call and its name stays
  // taken until `forgetRecording` gives both back, so nothing that settles or
  // releases the plan may reach it. The plan gets a new array rather than having
  // entries taken out of the one just walked.
  if (parked.length > 0) {
    plan.files = plan.files.filter(file => !parked.includes(file));
  }

  if (plan.directory) {
    for (const collected of await collectDirectoryFiles(
      plan.directory,
      publicBase,
    )) {
      descriptors[collected.kind] = collected.descriptor;
      replacements.push([collected.source, collected.descriptor.path]);
    }
  }

  if (command === RECORDING_STOP_COMMAND) {
    const recording = recordings.get(resolved.sessionId);
    if (recording) {
      // A recording the front promised and that is not on disk, or is on disk
      // with nothing in it, fails the call: the caller asked for that file, and
      // the answer would otherwise report a success for a name leading nowhere.
      descriptors[recording.kind] = await describeWrittenFile(
        recording,
        publicBase,
      );
    }
  }

  replacements.push(...stagingReplacements(plan, resolved.sessionId));
  return {descriptors, replacements};
}

/**
 * The opening of a spilled result, so the answer still says what was found.
 * A slice must not end inside a surrogate pair: half a pair is not a character
 * and would travel as a replacement.
 */
function spillHead(rendered) {
  const head = rendered.slice(0, SPILL_HEAD_CHARS);
  const last = head.charCodeAt(head.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? head.slice(0, -1) : head;
}

/**
 * Writes a result that is too large to answer with and describes it in its
 * place: path, share path, fetch URL, byte count and the first lines.
 *
 * The file is created exclusively: its name is the front's own and carries
 * eight random hex characters, so an entry already sitting there is not this
 * call's file and is never written through — a symlink someone dropped into the
 * guest-writable share least of all.
 */
async function spillResult(target, rendered, publicBase) {
  await ensureOutputDir();
  const fileName = generatedFileName(target, SPILL_EXTENSION);
  const filePath = path.join(OUTPUT_DIR, fileName);
  try {
    await fs.writeFile(filePath, rendered, {
      flag: 'wx',
      mode: OUTPUT_FILE_MODE,
    });
    // The write runs under this process's umask, so the mode is set again.
    await fs.chmod(filePath, OUTPUT_FILE_MODE);
  } catch (error) {
    throw new CallError(
      'storage',
      `the result could not be written to ${filePath}`,
      error.message,
    );
  }

  return {
    spilled: true,
    ...fileLocation(fileName, filePath, publicBase),
    bytes: Buffer.byteLength(rendered),
    head: spillHead(rendered),
  };
}

/**
 * The result the answer carries in place of an oversized one, or nothing when
 * the rendered result is inside the cap. The measurement is on the rendered
 * bytes, which is what the answer would send, and it stays beside the cap and
 * the writing, so `SPILL_BYTES` is a figure of this module alone.
 */
export async function spillIfTooLarge(target, rendered, publicBase) {
  if (Buffer.byteLength(rendered) <= SPILL_BYTES) {
    return undefined;
  }
  return await spillResult(target, rendered, publicBase);
}
