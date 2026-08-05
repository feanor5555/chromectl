/**
 * Target registry for chromectl.
 *
 * A caller names a target in plain words. This module turns that name into the
 * browser URL of a running Chrome and into the hex session id that scopes the
 * daemon for it. The digest never leaves the service.
 *
 * The registry itself lives outside this repository: it holds the addresses of
 * our machines, while the tracked `targets.example.json` shows only the shape.
 * Its path comes from `CHROMECTL_TARGETS`, otherwise from
 * `~/.claude/chromectl/targets.json`.
 */

import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';
import process from 'node:process';

const DEFAULT_REGISTRY_PATH = join(
  homedir(),
  '.claude',
  'chromectl',
  'targets.json',
);

const DEFAULT_CDP_PORT = 9222;
const SESSION_ID_LENGTH = 16;

/** A target name is a plain word, a host, or a host:port. */
const TARGET_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*(:[0-9]{1,5})?$/;

export class TargetError extends Error {}

/** The registry file is missing or unusable — a configuration fault. */
export class RegistryError extends Error {}

/** The file the registry is read from. */
export function registryPath() {
  return process.env['CHROMECTL_TARGETS'] || DEFAULT_REGISTRY_PATH;
}

/**
 * Reads the registry. A missing file is a hard error naming the expected path:
 * falling back to an empty or example registry would silently drive a caller at
 * a host that merely happens to answer under the alias name.
 */
export function loadRegistry() {
  const path = registryPath();
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new RegistryError(
        `chromectl target registry not found at ${path} — ` +
          'create it or point CHROMECTL_TARGETS at it ' +
          '(shape: chromectl/targets.example.json)',
      );
    }
    throw new RegistryError(`cannot read target registry ${path}: ${error.message}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new RegistryError(`target registry ${path} is not valid JSON: ${error.message}`);
  }
  return parsed.targets ?? {};
}

/** Short hex digest of the target name, usable as a daemon session id. */
export function sessionIdFor(target) {
  return createHash('sha256')
    .update(target, 'utf8')
    .digest('hex')
    .slice(0, SESSION_ID_LENGTH);
}

/**
 * Resolves a target name to `{target, browserUrl, sessionId}`.
 *
 * A name found in the registry takes its browser URL from there. Any other
 * legal name is read as a host or `host:port`, so the registry is a
 * convenience and never a gate.
 */
export function resolveTarget(target) {
  if (typeof target !== 'string' || !TARGET_PATTERN.test(target)) {
    throw new TargetError(`illegal target name: ${JSON.stringify(target)}`);
  }

  const entry = loadRegistry()[target];
  const browserUrl = entry
    ? entry.browserUrl
    : target.includes(':')
      ? `http://${target}`
      : `http://${target}:${DEFAULT_CDP_PORT}`;

  if (!browserUrl) {
    throw new TargetError(`registry entry for ${target} has no browserUrl`);
  }

  return {target, browserUrl, sessionId: sessionIdFor(target)};
}

/** All registered target names. */
export function listTargets() {
  return Object.keys(loadRegistry()).sort();
}
