/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The file vocabulary of the chromectl front.
 *
 * Where the files of this service live, which names are legal, which endings
 * exist, what each of them is served as, and how a name and a location are
 * built. Everything here is pure: it decides names and answers questions about
 * them, and it touches no file — the procedures that create, move and serve one
 * take their rules from here.
 *
 * This is one half of what the front refuses to start on: what the front can
 * serve. The other half — what the tools can produce — is held against it in
 * `filearguments.mjs`.
 */

import {randomBytes} from 'node:crypto';
import path from 'node:path';
import process from 'node:process';

import {enumeratedArgument} from './commands.mjs';

/**
 * Where every file a call writes lands: `/home/wu/share/screenshots` on the
 * host the front runs on (`CHROMECTL_SCREENSHOT_DIR`), a directory of the house
 * network drive that is served over Samba and exported over NFS, so every
 * machine reaches the file the front only names. It is the single directory the
 * front lets a call write into, and every path the front hands the daemon
 * points inside it.
 */
export const OUTPUT_DIR =
  process.env['CHROMECTL_SCREENSHOT_DIR'] ?? '/home/wu/share/screenshots';

/** Root of the network drive, used to name the file share-relative. */
const SHARE_ROOT = process.env['CHROMECTL_SHARE_ROOT'] ?? '/home/wu/share';

/** Path prefix the front serves the files of earlier calls under. */
export const FILE_ROUTE = '/files/';

/**
 * The daemon writes with mode 0600 and creates directories under the front's
 * umask. Both are widened afterwards: an NFS client arrives under its own uid
 * and would otherwise be handed a file it cannot read.
 */
export const OUTPUT_DIR_MODE = 0o775;
export const OUTPUT_FILE_MODE = 0o644;

/**
 * Mode of a directory one call works in. Nothing but the front and the daemon it
 * started ever looks inside one, and both run as the same user, so it is theirs
 * alone; what comes out of it is moved into `OUTPUT_DIR` and made readable
 * there.
 */
export const STAGING_DIR_MODE = 0o700;

/**
 * The longest name a caller may pick. A filesystem takes 255 bytes, and this
 * sits well under it, with room for the generated staging name that stands
 * beside a caller's own. The bound is what keeps a mistyped name a mistyped
 * name: without it such a name reaches the drive and comes back as
 * `ENAMETOOLONG`, which is indistinguishable from a drive that is broken.
 */
export const MAX_FILE_NAME_LENGTH = 128;

/**
 * The only shape of file name a caller may name, for a file to be written as
 * well as for one to be read. It carries no directory separator and does not
 * start with a dot, so such a name can neither leave `OUTPUT_DIR` nor address
 * one of its parents, and `..` cannot be written at all.
 */
export const PLAIN_FILE_NAME_PATTERN = new RegExp(
  `^[A-Za-z0-9][A-Za-z0-9._-]{0,${MAX_FILE_NAME_LENGTH - 1}}$`,
);

/**
 * The endings a file of this service carries. Every tool that writes one
 * enforces its own ending on the path it was handed (`McpContext.saveFile`
 * replaces whatever extension arrives), so this is that set, plus the one a
 * spilled result gets. Demanding the ending on a name a caller picks keeps the
 * path in the answer the path that lands on disk.
 *
 * The screenshot endings are the formats upstream declares for `take_screenshot`
 * rather than a copy of them. The rest a tool decides inside its own code, which
 * is nowhere declared, so those stay a list — one `assertExtensionsAccountedFor`
 * holds against what the tables can actually produce.
 */
export const FILE_EXTENSIONS = [
  ...enumeratedArgument('take_screenshot', 'format').values,
  'txt',
  'json',
  'json.gz',
  'spill.json',
  'heapsnapshot',
  'network-request',
  'network-response',
  'mp4',
  'webm',
  'html',
];

const EXTENSION_ALTERNATION = FILE_EXTENSIONS.map(extension =>
  extension.replaceAll('.', '\\.'),
).join('|');

/** The stem of every name the front builds itself: target, moment, randomness. */
const GENERATED_NAME_STEM =
  'chromectl-[A-Za-z0-9-]+-[0-9]{8}T[0-9]{9}Z-[0-9a-f]{8}';

/**
 * The longest name a file of this service can carry: what a filesystem takes,
 * so nothing that exists on the drive is excluded. A generated name carries the
 * name of its target, and a tighter bound would tie fetchability to how long
 * that name is. Beyond it a name only reaches the drive to come back as
 * `ENAMETOOLONG`, which is indistinguishable from a drive that is broken.
 */
const MAX_SERVED_FILE_NAME_LENGTH = 255;

/** A file of this service: a plain name with an ending the front knows. */
export const SERVED_FILE_NAME_PATTERN = new RegExp(
  `^(?=.{1,${MAX_SERVED_FILE_NAME_LENGTH}}$)` +
    `[A-Za-z0-9][A-Za-z0-9._-]*\\.(?:${EXTENSION_ALTERNATION})$`,
);

/** The file names the front builds itself. */
export const GENERATED_FILE_NAME_PATTERN = new RegExp(
  `^${GENERATED_NAME_STEM}\\.(?:${EXTENSION_ALTERNATION})$`,
);

/**
 * The directory names the front builds itself: the same stem without an ending,
 * which is what a call's staging directory carries and no file of the front does.
 */
export const GENERATED_DIRECTORY_NAME_PATTERN = new RegExp(
  `^${GENERATED_NAME_STEM}$`,
);

export const CONTENT_TYPE_BY_EXTENSION = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  txt: 'text/plain; charset=utf-8',
  json: 'application/json; charset=utf-8',
  'json.gz': 'application/gzip',
  'spill.json': 'application/json; charset=utf-8',
  heapsnapshot: 'application/json; charset=utf-8',
  'network-request': 'application/octet-stream',
  'network-response': 'application/octet-stream',
  mp4: 'video/mp4',
  webm: 'video/webm',
  html: 'text/html; charset=utf-8',
};

/**
 * What a file is served as. The longest known ending a name carries decides, so
 * `.json.gz` is not read as the `.json` it also ends in.
 */
export function contentTypeFor(fileName) {
  const extension = FILE_EXTENSIONS.filter(candidate =>
    fileName.endsWith(`.${candidate}`),
  ).sort((left, right) => right.length - left.length)[0];
  return CONTENT_TYPE_BY_EXTENSION[extension] ?? 'application/octet-stream';
}

/** The ending a spilled result carries, which is what the pruning goes by. */
export const SPILL_EXTENSION = 'spill.json';

/**
 * How long a spilled result stays on the drive.
 *
 * A spilled file is the only one nobody asked for: the caller wanted the result
 * in its answer, and the file exists because the answer could not carry it — the
 * text of a permanently logged-in page among them, as a world-readable file on a
 * password-less share. It therefore expires, while a screenshot and a
 * caller-named snapshot are artifacts someone asked for and stay until someone
 * removes them.
 */
export const SPILL_RETENTION_MS = Number(
  process.env['CHROMECTL_SPILL_RETENTION_MS'] ?? 86_400_000,
);
if (!Number.isInteger(SPILL_RETENTION_MS) || SPILL_RETENTION_MS <= 0) {
  // A typo here would read as "keeps them forever", which is the exposure the
  // retention exists to end, so it is a startup fault.
  throw new Error(
    `chromectl: CHROMECTL_SPILL_RETENTION_MS must be a positive whole number of milliseconds, got ${JSON.stringify(process.env['CHROMECTL_SPILL_RETENTION_MS'])}`,
  );
}

/**
 * Builds the name of one entry the front creates: the target the call ran on,
 * the UTC moment down to the millisecond and eight random hex characters. Two
 * calls running at the same time therefore cannot land on the same name even
 * within one millisecond. The name carries no colons, so a Windows client
 * reaching the drive over Samba can open it.
 *
 * A target name without a single letter or digit slugs to nothing, and a name
 * with an empty slug is not one `GENERATED_FILE_NAME_PATTERN` matches: the file
 * would sit on the drive while the URL in the answer came back a 400. The
 * registry lets no such name through today (`TARGET_PATTERN` demands a letter or
 * digit first), so the fixed slug is what keeps the two patterns tied to each
 * other rather than to that rule.
 */
export function generatedName(target) {
  const slug =
    target.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'target';
  const stamp = new Date().toISOString().replace(/[-:.]/g, '');
  return `chromectl-${slug}-${stamp}-${randomBytes(4).toString('hex')}`;
}

/** The same name with the ending the file it stands for carries. */
export function generatedFileName(target, extension) {
  return `${generatedName(target)}.${extension}`;
}

/**
 * One name of the front's own and where that file lies: the two travel together
 * everywhere, since the name is what the fetch route serves and the path is
 * what a write goes to, and `OUTPUT_DIR` is the only directory either can name.
 */
export function generatedFilePath(target, extension) {
  const fileName = generatedFileName(target, extension);
  return {fileName, filePath: path.join(OUTPUT_DIR, fileName)};
}

/**
 * The address a written file is fetched under. Every name the front hands out
 * is made of letters, digits, dot, underscore and hyphen, so the encoding
 * changes nothing; it is applied so that the answer stays a URL whatever a name
 * ever comes to carry.
 */
function fileUrl(publicBase, fileName) {
  return `${publicBase}${FILE_ROUTE}${encodeURIComponent(fileName)}`;
}

/**
 * Where a file is to be found. Every file carries a fetch URL: the client is
 * bash and curl, so the share path presumes a mount it may not have while the
 * URL is reachable wherever the call itself was sent from.
 */
export function fileLocation(fileName, filePath, publicBase) {
  return {
    file: fileName,
    path: filePath,
    share_path: path.relative(SHARE_ROOT, filePath),
    url: fileUrl(publicBase, fileName),
  };
}
