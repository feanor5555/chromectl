/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The chores of the chromectl front on the drive.
 *
 * The output directory is made ready and kept clear of what the front itself
 * left there, a directory one call worked in is removed again, and a file a
 * failed call left half-written is settled. Each of these is handed the one
 * entry it acts on and holds nothing of its own: which names are taken, what a
 * call planned and which file belongs to which call stays with `fileplan.mjs`
 * and `fileresult.mjs`, and both reach the drive through here.
 *
 * One thing about a plan entry is known here: `settleLeftoverFile` reads a file
 * record's `writePath` and `filePath` to tell a file written straight under the
 * name the answer carries from one written under a name of the front's own.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import {CallError} from './errors.mjs';
import {
  GENERATED_DIRECTORY_NAME_PATTERN,
  GENERATED_FILE_NAME_PATTERN,
  OUTPUT_DIR,
  OUTPUT_DIR_MODE,
  OUTPUT_FILE_MODE,
  SPILL_EXTENSION,
  SPILL_RETENTION_MS,
} from './filenames.mjs';

/**
 * Removes what the front left behind and has outlived `SPILL_RETENTION_MS`:
 * spilled results and staging directories.
 *
 * Only those two are touched, and both have to carry a name the front built
 * itself — a spill additionally the `spill.json` ending only a spill gets, a
 * staging directory the bare stem no file of the front carries. A screenshot, a
 * trace, a caller-named file and anything else lying in the directory are left
 * where they are. The entry has to be of the kind its name claims: a file for
 * the one, a directory for the other, decided on an `lstat` that follows
 * nothing, so a symlink planted under either shape in the guest-writable share
 * matches neither and stays.
 *
 * Every path that creates a staging directory removes it again, so this catches
 * the one case none of them can: a front killed between the creation and the
 * removal. The retention is a day and a call lasts at most minutes, so a
 * directory old enough to be swept here belongs to no call that is still
 * running.
 *
 * Best effort throughout: this runs beside a caller's call, and neither an
 * unreadable directory nor an entry that vanished between the listing and the
 * `lstat` is that caller's business.
 *
 * The residual is accepted rather than solved with a scheduler: a front nobody
 * calls again prunes nothing and keeps its last spills, because the prune hangs
 * off the next call rather than off a timer of its own.
 */
async function pruneExpiredEntries() {
  const deadline = Date.now() - SPILL_RETENTION_MS;
  let names;
  try {
    names = await fs.readdir(OUTPUT_DIR);
  } catch {
    return;
  }
  for (const name of names) {
    const isSpill =
      GENERATED_FILE_NAME_PATTERN.test(name) &&
      name.endsWith(`.${SPILL_EXTENSION}`);
    const isStaging = GENERATED_DIRECTORY_NAME_PATTERN.test(name);
    if (!isSpill && !isStaging) {
      continue;
    }
    const entryPath = path.join(OUTPUT_DIR, name);
    try {
      const stats = await fs.lstat(entryPath);
      if (stats.mtimeMs >= deadline) {
        continue;
      }
      if (isSpill && stats.isFile()) {
        await fs.unlink(entryPath);
      } else if (isStaging && stats.isDirectory()) {
        await fs.rm(entryPath, {recursive: true, force: true});
      }
    } catch {
      // Gone already, or not this process's to remove.
    }
  }
}

/** Makes sure the output directory exists and this process can write into it. */
export async function ensureOutputDir() {
  try {
    const created = await fs.mkdir(OUTPUT_DIR, {
      recursive: true,
      mode: OUTPUT_DIR_MODE,
    });
    if (created !== undefined) {
      await fs.chmod(OUTPUT_DIR, OUTPUT_DIR_MODE);
    }
    await fs.access(OUTPUT_DIR, fs.constants.W_OK | fs.constants.X_OK);
  } catch (error) {
    throw new CallError(
      'storage',
      `output directory ${OUTPUT_DIR} is not writable`,
      error.message,
    );
  }
  // Every write passes here, which is the only moment the front is awake for
  // sure: the expiry rides along with it instead of on a timer.
  await pruneExpiredEntries();
}

/** Removes a staging directory and everything left in it; best effort. */
export async function removeStagingDirectory(directoryPath) {
  try {
    await fs.rm(directoryPath, {recursive: true, force: true});
  } catch {
    // Not this process's to remove: the call's own outcome is what counts.
  }
}

/**
 * Deals with what a failed call left behind. A call that hits its deadline or
 * fails after a write still leaves the daemon's 0600 file on the drive.
 *
 * A file the front named itself is written straight under the name the answer
 * would have carried, so a partial one stays and is only made readable: a file
 * only the front's uid can read is of no use to an NFS client arriving under its
 * own. A caller-named file is written under a name of the front's own that is
 * renamed onto the caller's only on success; a failed one therefore sits under a
 * name no answer mentioned and no route serves, and is removed instead of left
 * on the drive for good.
 *
 * Best effort by design: a call that failed before the write leaves nothing
 * here, and neither a chmod nor an unlink that fails must displace the failure
 * being reported to the caller.
 */
export async function settleLeftoverFile(file) {
  try {
    if (file.writePath === file.filePath) {
      await fs.chmod(file.writePath, OUTPUT_FILE_MODE);
    } else {
      await fs.unlink(file.writePath);
    }
  } catch {
    // No file written, or one this process cannot touch.
  }
}
