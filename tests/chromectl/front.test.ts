/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert';
import type {ChildProcess} from 'node:child_process';
import {spawn} from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import {after, before, describe, it} from 'node:test';
import {pathToFileURL} from 'node:url';

import {commands} from '../../src/bin/chrome-devtools-cli-options.js';

/**
 * The front runs `chromectl/` as plain ESM straight from the source tree, and
 * this test drives that very file over the surface a caller reaches: it starts
 * as a process of its own on an ephemeral port, with the network drive, the
 * target registry, the target browser and its daemon replaced by directories,
 * servers and sockets of this test. Nothing reaches into the module, so the
 * boundaries stay covered however the module is cut up later.
 */
const FRONT_MODULE = path.resolve('chromectl/front.mjs');

const REGISTRY_MODULE = pathToFileURL(
  path.resolve('chromectl/registry.mjs'),
).href;

interface Registry {
  sessionIdFor(browserUrl: string): string;
}

/** The content of a file that lies outside the served directory. */
const SECRET = 'behind the boundary\n';

/** What the fake daemon writes when it is told to produce a snapshot. */
const SNAPSHOT_TEXT = 'uid=1_0 page\n';

/** How long the front is given to come up. */
const START_TIMEOUT_MS = 20_000;

/** The size of the file the streaming route is measured on. */
const LARGE_FILE_BYTES = 256 * 1024 * 1024;

/**
 * How much peak memory the front may gain over one large download. The bound
 * sits halfway between the two outcomes it separates: a streaming run gains a
 * fraction of the file size, a buffered read gains the file itself, so the
 * margin to either side is about the same factor and normal machine load
 * cannot reach across it.
 */
const STREAMING_HEADROOM_KB = 128 * 1024;

interface Answer {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

interface StreamedAnswer {
  status: number;
  headers: http.IncomingHttpHeaders;
  head: Buffer;
  bytes: number;
}

interface DaemonCall {
  method: string;
  tool?: string;
  args?: Record<string, string>;
}

interface DaemonReply {
  success: boolean;
  result?: string;
  error?: string;
}

type DaemonHandler = (call: DaemonCall) => DaemonReply;

let tmpRoot: string;
let outputDir: string;
let outsideDir: string;
let frontProcess: ChildProcess;
let frontPid: number;
let frontPort: number;
let frontErrors = '';
let browserServer: http.Server;
let daemonServer: net.Server;
const daemonSockets = new Set<net.Socket>();

/** The answer the fake daemon gives, and what the front handed it, per test. */
let daemonHandler: DaemonHandler = () => ({
  success: false,
  result: '',
  error: 'this test set no daemon handler',
});
let daemonCalls: DaemonCall[] = [];

/** A port nothing listens on any more by the time it is handed back. */
async function freePort(): Promise<number> {
  return await new Promise(resolve => {
    const probe = net.createServer();
    probe.listen(0, '127.0.0.1', () => {
      const {port} = probe.address() as net.AddressInfo;
      probe.close(() => {
        resolve(port);
      });
    });
  });
}

/**
 * One request against the front, with the path sent as written: the route has
 * to answer for what a caller puts on the wire, not for what a URL parser makes
 * of it first.
 */
async function send(
  pathname: string,
  options: {method?: string; body?: string} = {},
): Promise<Answer> {
  return await new Promise((resolve, reject) => {
    const request = http.request(
      {
        host: '127.0.0.1',
        port: frontPort,
        path: pathname,
        method: options.method ?? 'GET',
        headers:
          options.body === undefined
            ? {}
            : {
                'content-type': 'application/json',
                'content-length': Buffer.byteLength(options.body),
              },
      },
      response => {
        const chunks: Buffer[] = [];
        response.on('data', chunk => chunks.push(chunk as Buffer));
        response.on('end', () => {
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks),
          });
        });
      },
    );
    request.on('error', reject);
    if (options.body !== undefined) {
      request.write(options.body);
    }
    request.end();
  });
}

/** The same request, with the body counted instead of kept. */
async function stream(pathname: string): Promise<StreamedAnswer> {
  return await new Promise((resolve, reject) => {
    const request = http.request(
      {host: '127.0.0.1', port: frontPort, path: pathname},
      response => {
        let head = Buffer.alloc(0);
        let bytes = 0;
        response.on('data', chunk => {
          const buffer = chunk as Buffer;
          bytes += buffer.length;
          if (head.length === 0) {
            head = Buffer.from(buffer.subarray(0, 64));
          }
        });
        response.on('end', () => {
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            head,
            bytes,
          });
        });
      },
    );
    request.on('error', reject);
    request.end();
  });
}

async function call(body: unknown): Promise<Answer> {
  return await send('/call', {method: 'POST', body: JSON.stringify(body)});
}

async function budget(body: unknown): Promise<Answer> {
  return await send('/budget', {method: 'POST', body: JSON.stringify(body)});
}

function payload(answer: Answer): Record<string, unknown> {
  return JSON.parse(answer.body.toString('utf8')) as Record<string, unknown>;
}

/** A refusal the caller is answerable for, not a fault of the service. */
function assertUsage(answer: Answer, what: string): void {
  const body = payload(answer);
  assert.strictEqual(
    answer.status,
    400,
    `${what}: ${answer.status} ${answer.body.toString('utf8')}`,
  );
  assert.strictEqual(body['kind'], 'usage', `${what}: ${String(body['kind'])}`);
  assert.strictEqual(body['ok'], false);
}

/** A file of the served directory. */
function writeOutput(fileName: string, content: string | Buffer): string {
  const filePath = path.join(outputDir, fileName);
  fs.writeFileSync(filePath, content);
  return filePath;
}

/**
 * What the front left in the served directory under a name it builds itself:
 * a staging file, which is the name no answer carries and nothing prunes.
 */
function stagingLeftovers(): string[] {
  return fs
    .readdirSync(outputDir)
    .filter(name => name.startsWith('chromectl-'));
}

/** The peak resident memory of one process, where the system reports it. */
function peakRssKb(pid: number): number | undefined {
  let status;
  try {
    status = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
  } catch {
    return undefined;
  }
  const match = /^VmHWM:\s+(\d+) kB$/m.exec(status);
  return match ? Number(match[1]) : undefined;
}

/** A daemon answer that carries a rendered tool result. */
function toolSuccess(): DaemonReply {
  return {
    success: true,
    result: JSON.stringify({
      content: [{type: 'text', text: 'ok'}],
      structuredContent: {textSnapshot: 'ok', pages: []},
    }),
  };
}

/** The unix socket the front's daemon client talks to, with no daemon behind it. */
function startFakeDaemon(socketPath: string): Promise<void> {
  daemonServer = net.createServer(socket => {
    daemonSockets.add(socket);
    socket.on('error', () => {
      // A front that walked away mid-command is the front's business.
    });
    socket.on('close', () => daemonSockets.delete(socket));
    let pending = Buffer.alloc(0);
    socket.on('data', chunk => {
      pending = Buffer.concat([pending, chunk as Buffer]);
      let end = pending.indexOf(0);
      while (end !== -1) {
        const message = pending.subarray(0, end).toString('utf8');
        pending = pending.subarray(end + 1);
        const parsed = JSON.parse(message) as DaemonCall;
        daemonCalls.push(parsed);
        const reply = daemonHandler(parsed);
        socket.write(`${JSON.stringify(reply)}\0`);
        end = pending.indexOf(0);
      }
    });
  });
  return new Promise(resolve => {
    daemonServer.listen(socketPath, resolve);
  });
}

/** The CDP endpoint the front probes before it involves the daemon. */
function startFakeBrowser(): Promise<number> {
  browserServer = http.createServer((request, response) => {
    if (request.url === '/json/version') {
      response.writeHead(200, {'content-type': 'application/json'});
      response.end(JSON.stringify({Browser: 'Chrome/0.0.0.0'}));
      return;
    }
    response.writeHead(404).end();
  });
  return new Promise(resolve => {
    browserServer.listen(0, '127.0.0.1', () => {
      resolve((browserServer.address() as net.AddressInfo).port);
    });
  });
}

async function waitForFront(): Promise<void> {
  const deadline = Date.now() + START_TIMEOUT_MS;
  for (;;) {
    try {
      const answer = await send('/health');
      if (answer.status === 200) {
        return;
      }
    } catch {
      // Not listening yet.
    }
    if (Date.now() >= deadline) {
      throw new Error(`front did not come up: ${frontErrors}`);
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

before(async () => {
  const registry = (await import(REGISTRY_MODULE)) as Registry;

  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'chromectl-front-'));
  outputDir = path.join(tmpRoot, 'screenshots');
  outsideDir = path.join(tmpRoot, 'outside');
  const runtimeDir = path.join(tmpRoot, 'run');
  fs.mkdirSync(outputDir);
  fs.mkdirSync(outsideDir);
  fs.writeFileSync(path.join(outsideDir, 'secret.txt'), SECRET);

  const browserUrl = `http://127.0.0.1:${await startFakeBrowser()}`;
  const sessionId = registry.sessionIdFor(browserUrl);
  const daemonHome = path.join(runtimeDir, `chrome-devtools-mcp-${sessionId}`);
  fs.mkdirSync(daemonHome, {recursive: true});
  // The front asks the pid file whether a daemon is there and signals that pid;
  // this process is the one that is certainly alive and answers on the socket.
  fs.writeFileSync(path.join(daemonHome, 'daemon.pid'), String(process.pid));
  await startFakeDaemon(path.join(daemonHome, 'server.sock'));

  const registryFile = path.join(tmpRoot, 'targets.json');
  fs.writeFileSync(
    registryFile,
    JSON.stringify({targets: {fake: {browserUrl}}}),
    'utf8',
  );

  frontPort = await freePort();
  frontProcess = spawn(process.execPath, [FRONT_MODULE], {
    stdio: ['ignore', 'ignore', 'pipe'],
    env: {
      ...process.env,
      CHROMECTL_HOST: '127.0.0.1',
      CHROMECTL_PORT: String(frontPort),
      CHROMECTL_PUBLIC_URL: `http://127.0.0.1:${frontPort}`,
      CHROMECTL_TARGETS: registryFile,
      CHROMECTL_SCREENSHOT_DIR: outputDir,
      CHROMECTL_SHARE_ROOT: tmpRoot,
      XDG_RUNTIME_DIR: runtimeDir,
    },
  });
  frontPid = frontProcess.pid ?? 0;
  frontProcess.stderr?.on('data', chunk => {
    frontErrors += String(chunk);
  });
  await waitForFront();
});

after(async () => {
  frontProcess.kill('SIGKILL');
  for (const socket of daemonSockets) {
    socket.destroy();
  }
  await new Promise(resolve => daemonServer.close(resolve));
  await new Promise(resolve => browserServer.close(resolve));
  fs.rmSync(tmpRoot, {recursive: true, force: true});
});

describe('chromectl front file route', () => {
  it('serves nothing under a name it does not hand out', async () => {
    const refused = [
      // A path that leaves the directory, in every spelling that survives the
      // way to the route.
      '/files/../../etc/passwd',
      '/files/%2e%2e%2fsecret.txt',
      '/files/..%2Fsecret.txt',
      '/files/%2e%2e/secret.txt',
      // A path of its own, absolute or with a directory in it.
      '/files//etc/passwd',
      '/files/%2Fetc%2Fpasswd',
      `/files/${encodeURIComponent(path.join(os.tmpdir(), 'secret.txt'))}`,
      '/files/sub/inner.txt',
      // A name the front never builds: hidden, unknown ending, no ending, a
      // space, and an ending that only looks like a known one.
      '/files/.hidden.txt',
      '/files/plain.bin',
      '/files/noending',
      '/files/space%20name.txt',
      '/files/report.txt.exe',
      // A percent that decodes to nothing.
      '/files/%zz.txt',
    ];

    for (const pathname of refused) {
      const answer = await send(pathname);
      assertUsage(answer, pathname);
      assert.ok(
        !answer.body.toString('utf8').includes(SECRET.trim()),
        `${pathname} answered with the file behind the boundary`,
      );
    }
  });

  it('does not follow a symlink out of the directory', async () => {
    fs.symlinkSync(
      path.join(outsideDir, 'secret.txt'),
      path.join(outputDir, 'escape.txt'),
    );

    const answer = await send('/files/escape.txt');

    assert.strictEqual(answer.status, 500);
    assert.strictEqual(payload(answer)['kind'], 'storage');
    assert.ok(!answer.body.toString('utf8').includes(SECRET.trim()));
  });

  it('does not serve a file that carries a second name', async () => {
    fs.linkSync(
      path.join(outsideDir, 'secret.txt'),
      path.join(outputDir, 'twin.txt'),
    );

    const answer = await send('/files/twin.txt');

    assert.strictEqual(answer.status, 500);
    assert.strictEqual(payload(answer)['kind'], 'storage');
    assert.ok(!answer.body.toString('utf8').includes(SECRET.trim()));
  });

  it('does not serve a directory that carries a file name', async () => {
    fs.mkdirSync(path.join(outputDir, 'folder.txt'));

    const answer = await send('/files/folder.txt');

    assert.strictEqual(answer.status, 500);
    assert.strictEqual(payload(answer)['kind'], 'storage');
  });

  it('answers a name that is not on the drive with a not-found', async () => {
    const answer = await send(
      '/files/chromectl-fake-20260101T000000000Z-abcdef12.txt',
    );

    assert.strictEqual(answer.status, 404);
    assert.strictEqual(payload(answer)['kind'], 'notfound');
  });

  it('takes a name of 255 characters and refuses one of 256', async () => {
    const served = `${'a'.repeat(251)}.txt`;
    assert.strictEqual(served.length, 255);
    writeOutput(served, 'served\n');

    const answer = await send(`/files/${served}`);
    assert.strictEqual(answer.status, 200);
    assert.strictEqual(answer.body.toString('utf8'), 'served\n');

    // One character more never reaches the drive: an `ENAMETOOLONG` from there
    // would read as a broken drive rather than as a caller's mistake.
    assertUsage(await send(`/files/${'a'.repeat(252)}.txt`), '256 characters');
  });

  it('hands a file over with its length, its type and as a download', async () => {
    const archive = Buffer.alloc(4096, 7);
    writeOutput('result.json.gz', archive);
    writeOutput('page.txt', 'page text\n');
    writeOutput('memory.heapsnapshot', '{}');

    const cases = [
      // The longest known ending decides, so `.json.gz` is not read as `.json`.
      {name: 'result.json.gz', type: 'application/gzip', bytes: archive.length},
      {name: 'page.txt', type: 'text/plain; charset=utf-8', bytes: 10},
      {
        name: 'memory.heapsnapshot',
        type: 'application/json; charset=utf-8',
        bytes: 2,
      },
    ];

    for (const {name, type, bytes} of cases) {
      const answer = await send(`/files/${name}`);
      assert.strictEqual(answer.status, 200, name);
      assert.strictEqual(answer.headers['content-type'], type, name);
      assert.strictEqual(answer.headers['content-length'], String(bytes), name);
      assert.strictEqual(answer.body.length, bytes, name);
      assert.strictEqual(
        answer.headers['content-disposition'],
        `attachment; filename="${name}"`,
        name,
      );
      assert.strictEqual(answer.headers['x-content-type-options'], 'nosniff');
    }
  });

  it('decides the route on the path alone', async () => {
    const answer = await send('/files/page.txt?v=1');

    assert.strictEqual(answer.status, 200);
    assert.strictEqual(answer.body.toString('utf8'), 'page text\n');
  });

  it('streams a large file instead of holding it in memory', async t => {
    const before = peakRssKb(frontPid);
    if (before === undefined) {
      t.skip('peak memory of a process is readable on Linux only');
      return;
    }
    const filePath = writeOutput('huge.heapsnapshot', 'CHROMECTL');
    fs.truncateSync(filePath, LARGE_FILE_BYTES);

    const answer = await stream('/files/huge.heapsnapshot');

    assert.strictEqual(answer.status, 200);
    assert.strictEqual(
      answer.headers['content-length'],
      String(LARGE_FILE_BYTES),
    );
    assert.strictEqual(answer.bytes, LARGE_FILE_BYTES);
    assert.strictEqual(
      answer.head.subarray(0, 9).toString('utf8'),
      'CHROMECTL',
    );

    const after = peakRssKb(frontPid) ?? Number.MAX_SAFE_INTEGER;
    assert.ok(
      after - before < STREAMING_HEADROOM_KB,
      `the front gained ${after - before} kB of peak memory over a ` +
        `${LARGE_FILE_BYTES} byte download, so it held the file`,
    );

    fs.rmSync(filePath);
  });
});

describe('chromectl front output names', () => {
  it('refuses a name that is not a plain file name of the directory', async () => {
    daemonCalls = [];
    const refused = [
      'sub/name.txt',
      '../name.txt',
      '/etc/name.txt',
      '.hidden.txt',
      'name with space.txt',
      'näme.txt',
      // The ending is the tool's, not the caller's.
      'name.png',
      'name',
      // One character over the bound, which is where a name would otherwise
      // reach the drive and come back as `ENAMETOOLONG`.
      `${'a'.repeat(125)}.txt`,
    ];

    for (const fileName of refused) {
      const answer = await call({
        target: 'fake',
        command: 'take_snapshot',
        args: {filePath: fileName},
      });
      assertUsage(answer, fileName);
      assert.match(String(payload(answer)['error']), /plain file name/);
    }

    // None of them was driven: the refusal comes before the browser.
    assert.deepStrictEqual(daemonCalls, []);
    assert.deepStrictEqual(stagingLeftovers(), []);
  });

  it('takes a name of 128 characters and never hands it to the daemon', async () => {
    const fileName = `${'a'.repeat(124)}.txt`;
    assert.strictEqual(fileName.length, 128);
    daemonCalls = [];
    daemonHandler = daemonCall => {
      fs.writeFileSync(String(daemonCall.args?.['filePath']), SNAPSHOT_TEXT);
      return toolSuccess();
    };

    const answer = await call({
      target: 'fake',
      command: 'take_snapshot',
      args: {filePath: fileName},
    });

    assert.strictEqual(answer.status, 200, answer.body.toString('utf8'));
    const snapshot = payload(answer)['snapshot'] as Record<string, unknown>;
    assert.strictEqual(snapshot['file'], fileName);
    assert.strictEqual(
      snapshot['url'],
      `http://127.0.0.1:${frontPort}/files/${fileName}`,
    );
    assert.strictEqual(
      fs.readFileSync(path.join(outputDir, fileName), 'utf8'),
      SNAPSHOT_TEXT,
    );

    // The daemon wrote under a name of the front's own and the file was
    // renamed onto the caller's afterwards, so nothing of it stays behind.
    const handed = String(
      daemonCalls.find(entry => entry.method === 'invoke_tool')?.args?.[
        'filePath'
      ],
    );
    assert.strictEqual(path.dirname(handed), outputDir);
    assert.match(path.basename(handed), /^chromectl-fake-/);
    assert.deepStrictEqual(stagingLeftovers(), []);

    fs.rmSync(path.join(outputDir, fileName));
  });

  it('hands back a fetchable file for every screenshot format upstream declares', async () => {
    const formats = commands['take_screenshot']?.args['format'];
    const declared = (formats?.enum ?? []).map(String);
    assert.ok(declared.length > 0, 'the command table declares no format');
    daemonHandler = daemonCall => {
      fs.writeFileSync(String(daemonCall.args?.['filePath']), 'image bytes');
      return toolSuccess();
    };

    // A format the front does not know an ending or a media type for would be
    // written, named in the answer and refused by the front's own file route.
    for (const format of [...declared, undefined]) {
      const answer = await call({
        target: 'fake',
        command: 'take_screenshot',
        args: format === undefined ? {} : {format},
      });

      assert.strictEqual(answer.status, 200, answer.body.toString('utf8'));
      const screenshot = payload(answer)['screenshot'] as Record<
        string,
        unknown
      >;
      const fileName = String(screenshot['file']);
      // With no format named the ending is the one upstream defaults to.
      const expected = format ?? String(formats?.default);
      assert.ok(
        fileName.endsWith(`.${expected}`),
        `${String(format)}: ${fileName}`,
      );

      const served = await send(`/files/${fileName}`);
      assert.strictEqual(served.status, 200, `${fileName}: ${served.status}`);
      assert.match(String(served.headers['content-type']), /^image\//);

      fs.rmSync(path.join(outputDir, fileName));
    }
    assert.deepStrictEqual(stagingLeftovers(), []);
  });
});

describe('chromectl front command surface', () => {
  it('offers exactly the commands of the upstream table', async () => {
    const answer = await send('/health');

    assert.strictEqual(answer.status, 200);
    assert.deepStrictEqual(
      payload(answer)['commands'],
      Object.keys(commands).sort(),
    );
  });

  it('brings a caller argument to the declared type', async () => {
    // `/budget` runs the whole argument check and drives no browser, so the
    // coercion is measured where it happens and nowhere else.
    const accepted = [
      // A caller that can only send text writes every value as one.
      {command: 'wait_for', args: {text: 'ready'}, full_speed: 'true'},
      {command: 'wait_for', args: {text: 'ready', timeout: '5'}},
      {command: 'wait_for', args: {text: ['ready', 'done'], timeout: 5}},
    ];
    for (const body of accepted) {
      const answer = await budget(body);
      assert.strictEqual(
        answer.status,
        200,
        `${JSON.stringify(body)}: ${answer.body.toString('utf8')}`,
      );
      assert.strictEqual(payload(answer)['command'], body.command);
    }

    const refused = [
      // A boolean is the two written words and nothing beside them.
      {
        body: {command: 'wait_for', args: {text: 'ready'}, full_speed: 'yes'},
        error: /full_speed must be a boolean/,
      },
      {
        body: {command: 'wait_for', args: {text: 'ready', timeout: 'x'}},
        error: /timeout must be a number/,
      },
      {
        body: {command: 'wait_for', args: {timeout: 5}},
        error: /required argument text is missing/,
      },
      {
        body: {command: 'wait_for', args: {text: 'ready', timeout: 1.5}},
        error: /timeout must be an integer/,
      },
      {
        body: {command: 'take_screenshot', args: {format: 'bmp'}},
        error: /format must be one of/,
      },
      {
        body: {command: 'no_such_tool', args: {}},
        error: /unknown command/,
      },
    ];
    for (const {body, error} of refused) {
      const answer = await budget(body);
      assertUsage(answer, JSON.stringify(body));
      assert.match(String(payload(answer)['error']), error);
    }
  });
});

describe('chromectl front argument and target lookups', () => {
  it('reads no argument off the prototype', async () => {
    for (const name of [
      'constructor',
      '__proto__',
      'toString',
      'hasOwnProperty',
      'valueOf',
    ]) {
      const answer = await budget({
        command: 'take_snapshot',
        args: {[name]: 'x'},
      });
      assertUsage(answer, name);
      assert.ok(
        String(payload(answer)['error']).includes(`unknown argument ${name}`),
        `${name}: ${String(payload(answer)['error'])}`,
      );
    }
  });

  it('reads no target off the prototype', async () => {
    daemonCalls = [];
    for (const target of ['constructor', 'toString', 'valueOf']) {
      const answer = await call({target, command: 'take_snapshot'});

      // A name the registry does not carry is read as a host, so the call ends
      // at the browser that is not there instead of at an entry without a URL.
      assert.strictEqual(answer.status, 503, target);
      const body = payload(answer);
      assert.strictEqual(body['kind'], 'unreachable', target);
      assert.match(String(body['error']), /http:\/\/[a-zA-Z]+:9222/);
    }
    assert.deepStrictEqual(daemonCalls, []);
  });
});

describe('chromectl front staging', () => {
  it('leaves no staging file when the file it was promised is empty', async () => {
    daemonHandler = daemonCall => {
      fs.writeFileSync(String(daemonCall.args?.['filePath']), '');
      return toolSuccess();
    };

    const answer = await call({
      target: 'fake',
      command: 'take_snapshot',
      args: {filePath: 'promised.txt'},
    });

    assert.strictEqual(answer.status, 500);
    const body = payload(answer);
    assert.strictEqual(body['kind'], 'storage');
    assert.match(String(body['error']), /promised\.txt/);
    assert.ok(!fs.existsSync(path.join(outputDir, 'promised.txt')));
    assert.deepStrictEqual(stagingLeftovers(), []);
  });

  it('leaves no staging file when no file was written at all', async () => {
    daemonHandler = () => toolSuccess();

    const answer = await call({
      target: 'fake',
      command: 'take_snapshot',
      args: {filePath: 'missing.txt'},
    });

    assert.strictEqual(answer.status, 500);
    assert.strictEqual(payload(answer)['kind'], 'storage');
    assert.ok(!fs.existsSync(path.join(outputDir, 'missing.txt')));
    assert.deepStrictEqual(stagingLeftovers(), []);
  });

  it('gives a name back after the call that held it', async () => {
    daemonHandler = daemonCall => {
      fs.writeFileSync(String(daemonCall.args?.['filePath']), SNAPSHOT_TEXT);
      return toolSuccess();
    };

    // The name the failed calls above took has to be free again, otherwise a
    // caller is told another browser holds a name no call is writing.
    const answer = await call({
      target: 'fake',
      command: 'take_snapshot',
      args: {filePath: 'promised.txt'},
    });

    assert.strictEqual(answer.status, 200, answer.body.toString('utf8'));
    assert.deepStrictEqual(stagingLeftovers(), []);

    fs.rmSync(path.join(outputDir, 'promised.txt'));
  });
});
