/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import {after, before, describe, it} from 'node:test';
import {pathToFileURL} from 'node:url';

import {assertValidSessionId} from '../../src/daemon/utils.js';

/**
 * The front runs `chromectl/` as plain ESM straight from the source tree,
 * outside the TypeScript program, and this test loads the very same file the
 * same way rather than a compiled copy of it.
 */
const REGISTRY_MODULE = pathToFileURL(
  path.resolve('chromectl/registry.mjs'),
).href;

interface ResolvedTarget {
  target: string;
  browserUrl: string;
  sessionId: string;
}

interface Registry {
  resolveTarget(target: string): ResolvedTarget;
  sessionIdFor(browserUrl: string): string;
}

const PAUL = 'http://100.89.199.44:9222';

const REGISTRY_FILE = {
  targets: {
    paul: {browserUrl: PAUL},
    // The same browser, written as loudly as the URL syntax allows.
    'paul-loud': {browserUrl: 'HTTP://100.89.199.44:9222/'},
    'paul-http-port': {browserUrl: 'http://100.89.199.44:80'},
    jonas: {browserUrl: 'http://100.89.136.112:9222'},
  },
};

describe('chromectl target registry', () => {
  let registry: Registry;
  let registryDir: string;
  let previousPath: string | undefined;

  before(async () => {
    registryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chromectl-registry-'));
    const registryFile = path.join(registryDir, 'targets.json');
    fs.writeFileSync(registryFile, JSON.stringify(REGISTRY_FILE), 'utf8');
    previousPath = process.env['CHROMECTL_TARGETS'];
    process.env['CHROMECTL_TARGETS'] = registryFile;
    registry = (await import(REGISTRY_MODULE)) as Registry;
  });

  after(() => {
    if (previousPath === undefined) {
      delete process.env['CHROMECTL_TARGETS'];
    } else {
      process.env['CHROMECTL_TARGETS'] = previousPath;
    }
    fs.rmSync(registryDir, {recursive: true, force: true});
  });

  it('gives one browser one session id, however it is named', () => {
    const alias = registry.resolveTarget('paul').sessionId;

    // The bare address behind the alias.
    assert.strictEqual(
      registry.resolveTarget('100.89.199.44:9222').sessionId,
      alias,
    );
    // The port the front fills in for a name that carries none.
    assert.strictEqual(
      registry.resolveTarget('100.89.199.44').sessionId,
      alias,
    );
    // Scheme case, host case and a trailing slash.
    assert.strictEqual(registry.resolveTarget('paul-loud').sessionId, alias);
    assert.strictEqual(
      registry.sessionIdFor('http://100.89.199.44:9222/'),
      alias,
    );
    assert.strictEqual(
      registry.sessionIdFor('HTTP://100.89.199.44:9222'),
      alias,
    );
  });

  it('gives two browsers two session ids', () => {
    const paul = registry.resolveTarget('paul').sessionId;

    // Another machine.
    assert.notStrictEqual(registry.resolveTarget('jonas').sessionId, paul);
    // The same machine, another debugging port.
    assert.notStrictEqual(
      registry.sessionIdFor('http://100.89.199.44:9333'),
      paul,
    );
    assert.notStrictEqual(
      registry.resolveTarget('paul-http-port').sessionId,
      paul,
    );
  });

  it('levels out a port the scheme declares anyway', () => {
    assert.strictEqual(
      registry.sessionIdFor('http://100.89.199.44:80'),
      registry.sessionIdFor('http://100.89.199.44'),
    );
    assert.strictEqual(
      registry.sessionIdFor('https://100.89.199.44:443'),
      registry.sessionIdFor('https://100.89.199.44'),
    );
    // http and https are two endpoints, not two spellings of one.
    assert.notStrictEqual(
      registry.sessionIdFor('http://100.89.199.44:9222'),
      registry.sessionIdFor('https://100.89.199.44:9222'),
    );
  });

  it('keeps the caller wording in the resolved target', () => {
    const resolved = registry.resolveTarget('100.89.199.44:9222');
    assert.strictEqual(resolved.target, '100.89.199.44:9222');
    assert.strictEqual(resolved.browserUrl, PAUL);
  });

  it('produces a session id the daemon accepts', () => {
    const {sessionId} = registry.resolveTarget('paul');
    assert.match(sessionId, /^[0-9a-f]{16}$/);
    assert.doesNotThrow(() => {
      assertValidSessionId(sessionId);
    });
  });
});
