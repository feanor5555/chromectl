/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import {after, before, describe, it} from 'node:test';
import {pathToFileURL} from 'node:url';

/**
 * The front runs `chromectl/` as plain ESM straight from the source tree,
 * outside the TypeScript program, and this test loads the very same file the
 * same way rather than a compiled copy of it.
 *
 * What is covered here is the reachability probe and the argument list a daemon
 * start is built from. They are the parts of the daemon layer a test process can
 * drive in process: a plain fetch of the target's CDP endpoint, and a list built
 * from a resolved target. The lifecycle beside them — starting, stopping and
 * replacing a daemon — is exercised through the front's own process in
 * `front.test.ts`, because provoking it here would have this test runner write
 * and be signalled through the daemon pid file.
 */
const DAEMON_MODULE = pathToFileURL(path.resolve('chromectl/daemon.mjs')).href;

interface CallFailure {
  kind: string;
  message: string;
  detail?: string;
}

interface Daemon {
  assertTargetReachable(browserUrl: string): Promise<void>;
  daemonStartArgs(resolved: {
    browserUrl: string;
    emulateFocusedPages?: boolean;
  }): string[];
}

/** A port nothing listens on: bound to find a free one, then given up again. */
async function closedPort(): Promise<number> {
  const probe = net.createServer();
  await new Promise<void>(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = (probe.address() as net.AddressInfo).port;
  await new Promise<void>(resolve => probe.close(() => resolve()));
  return port;
}

describe('chromectl target probe', () => {
  let daemon: Daemon;
  let failing: http.Server;
  let failingUrl: string;

  before(async () => {
    daemon = (await import(DAEMON_MODULE)) as Daemon;
    failing = http.createServer((_request, response) => {
      response.writeHead(500);
      response.end('no');
    });
    await new Promise<void>(resolve => failing.listen(0, '127.0.0.1', resolve));
    failingUrl = `http://127.0.0.1:${(failing.address() as net.AddressInfo).port}`;
  });

  after(async () => {
    await new Promise<void>(resolve => failing.close(() => resolve()));
  });

  it('reports a target that does not answer as unreachable', async () => {
    const browserUrl = `http://127.0.0.1:${await closedPort()}`;
    await assert.rejects(daemon.assertTargetReachable(browserUrl), failure => {
      const {kind, message, detail} = failure as CallFailure;
      assert.strictEqual(kind, 'unreachable');
      assert.ok(
        message.includes(browserUrl),
        `${message} does not name ${browserUrl}`,
      );
      // The reason the fetch gave stays on the answer: a refused connection and
      // a name that does not resolve are the same kind and different outages.
      assert.ok(detail !== undefined && detail.length > 0);
      return true;
    });
  });

  it('reports a target that answers with a failure as unreachable', async () => {
    await assert.rejects(daemon.assertTargetReachable(failingUrl), failure => {
      const {kind, message} = failure as CallFailure;
      assert.strictEqual(kind, 'unreachable');
      assert.ok(message.includes('500'), `${message} does not name the status`);
      return true;
    });
  });

  it('gives the daemon of an unfocused target the flag for it', () => {
    const browserUrl = 'http://127.0.0.1:9222';
    const off = daemon.daemonStartArgs({
      browserUrl,
      emulateFocusedPages: false,
    });
    const on = daemon.daemonStartArgs({browserUrl, emulateFocusedPages: true});
    const unset = daemon.daemonStartArgs({browserUrl});

    assert.ok(off.includes('--no-emulate-focused-pages'));
    // The daemon emulates a focused page by default, so nothing is passed for
    // the targets that keep it.
    assert.ok(!on.includes('--no-emulate-focused-pages'));
    assert.deepStrictEqual(on, unset);
    // The flag is the only difference; the browser and the server flags stay.
    assert.deepStrictEqual(
      off.filter(arg => arg !== '--no-emulate-focused-pages'),
      on,
    );
    assert.ok(on.includes(`--browserUrl=${browserUrl}`));
  });

  it('starts every daemon with the CrUX call switched off', () => {
    const args = daemon.daemonStartArgs({browserUrl: 'http://127.0.0.1:9222'});

    // Upstream fetches field data by default, which sends the URLs of a trace
    // to Google as soon as a trace is stopped. The flag is the only thing that
    // holds them back, so it belongs to every daemon this front starts.
    assert.ok(
      args.includes('--performanceCrux=false'),
      `${args.join(' ')} does not switch CrUX off`,
    );
  });

  it('takes a target that answers its version', async () => {
    const serving = http.createServer((_request, response) => {
      response.writeHead(200, {'content-type': 'application/json'});
      response.end('{"Browser": "Chrome/1.0"}');
    });
    await new Promise<void>(resolve => serving.listen(0, '127.0.0.1', resolve));
    const port = (serving.address() as net.AddressInfo).port;
    try {
      await daemon.assertTargetReachable(`http://127.0.0.1:${port}`);
    } finally {
      await new Promise<void>(resolve => serving.close(() => resolve()));
    }
  });
});
