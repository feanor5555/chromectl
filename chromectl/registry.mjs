/**
 * Target registry for chromectl.
 *
 * A caller names a target in plain words. This module turns that name into the
 * browser URL of a running Chrome and into the hex session id that scopes the
 * daemon for it. The digest never leaves the service.
 */

import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REGISTRY_PATH = join(HERE, 'targets.json');

const DEFAULT_CDP_PORT = 9222;
const SESSION_ID_LENGTH = 16;

/** A target name is a plain word, a host, or a host:port. */
const TARGET_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*(:[0-9]{1,5})?$/;

export class TargetError extends Error {}

function loadRegistry() {
  let raw;
  try {
    raw = readFileSync(REGISTRY_PATH, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') {
      return {};
    }
    throw error;
  }
  const parsed = JSON.parse(raw);
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
