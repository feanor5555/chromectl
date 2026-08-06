/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Target registry for chromectl.
 *
 * A caller names a target in plain words. This module turns that name into the
 * browser URL of a running Chrome and into the hex session id that scopes the
 * daemon for it. The digest never leaves the service.
 *
 * The session id belongs to the browser, not to the wording of the request: it
 * is derived from the resolved browser URL, so a registry alias and the bare
 * address behind it land on one daemon. That is what keeps the serialisation
 * intact — the tool mutex lives in the MCP server process the daemon holds, and
 * two daemons on one Chrome would be two mutexes and no order between them.
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
    throw new RegistryError(
      `cannot read target registry ${path}: ${error.message}`,
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new RegistryError(
      `target registry ${path} is not valid JSON: ${error.message}`,
    );
  }
  return parsed.targets ?? {};
}

/**
 * One spelling per browser URL, so that two ways of writing the same endpoint
 * cannot end up as two daemons.
 *
 * Levelled out is what the URL syntax itself declares equal: the case of scheme
 * and host, a port the scheme makes explicit anyway (`:80` on http, `:443` on
 * https), the written form of an IPv6 address, and a path that is empty or a
 * bare slash. Credentials, query and fragment are dropped — none of them names
 * a different Chrome.
 *
 * Left apart is everything that would need a lookup to decide: `localhost` and
 * `127.0.0.1`, or a machine's LAN address and its overlay address, stay
 * separate browsers here even when they are one, because this module resolves
 * no names. A registry entry is the place to give one browser one address.
 */
function canonicalBrowserUrl(browserUrl) {
  let url;
  try {
    url = new URL(browserUrl);
  } catch {
    throw new TargetError(`unusable browserUrl: ${JSON.stringify(browserUrl)}`);
  }
  const path = url.pathname.replace(/\/+$/, '');
  return `${url.protocol}//${url.host}${path}`;
}

/** Short hex digest of a browser URL, usable as a daemon session id. */
export function sessionIdFor(browserUrl) {
  return createHash('sha256')
    .update(canonicalBrowserUrl(browserUrl), 'utf8')
    .digest('hex')
    .slice(0, SESSION_ID_LENGTH);
}

/**
 * Resolves a target name to `{target, browserUrl, sessionId}`.
 *
 * A name found in the registry takes its browser URL from there. Any other
 * legal name is read as a host or `host:port`, so the registry is a
 * convenience and never a gate.
 *
 * Names that arrive at the same browser URL share one session id and therefore
 * one daemon; the returned `target` keeps the caller's own wording, which is
 * what the answer and a screenshot name are built from.
 */
export function resolveTarget(target) {
  if (typeof target !== 'string' || !TARGET_PATTERN.test(target)) {
    throw new TargetError(`illegal target name: ${JSON.stringify(target)}`);
  }

  // Only a name the registry carries itself is an entry: `constructor` and its
  // like are truthy on every object and would be read as an entry without a
  // browser URL instead of falling back to a host.
  const registry = loadRegistry();
  const entry = Object.hasOwn(registry, target) ? registry[target] : undefined;
  const browserUrl = entry
    ? entry.browserUrl
    : target.includes(':')
      ? `http://${target}`
      : `http://${target}:${DEFAULT_CDP_PORT}`;

  if (!browserUrl) {
    throw new TargetError(`registry entry for ${target} has no browserUrl`);
  }

  return {target, browserUrl, sessionId: sessionIdFor(browserUrl)};
}

/** All registered target names. */
export function listTargets() {
  return Object.keys(loadRegistry()).sort();
}
