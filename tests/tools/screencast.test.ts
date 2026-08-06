/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {describe, it, before, after, afterEach} from 'node:test';

import sinon from 'sinon';

import type {ParsedArguments} from '../../src/bin/chrome-devtools-mcp-cli-options.js';
import {startScreencast, stopScreencast} from '../../src/tools/screencast.js';
import {withMcpContext} from '../utils.js';

function createMockRecorder() {
  return {
    stop: sinon.stub().resolves(),
  };
}

/**
 * Stand-ins for ffmpeg builds that do and do not know the mp4 muxer option the
 * recorder passes, so the format check answers the same on every machine.
 */
let ffmpegStubDir: string;
let capableFfmpeg: string;
let incapableFfmpeg: string;

async function writeFfmpegStub(
  name: string,
  muxerHelp: string,
): Promise<string> {
  const filePath = path.join(ffmpegStubDir, name);
  await fs.writeFile(filePath, `#!/bin/sh\ncat <<'EOF'\n${muxerHelp}\nEOF\n`, {
    mode: 0o755,
  });
  return filePath;
}

describe('screencast', () => {
  before(async () => {
    ffmpegStubDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ffmpeg-stub-'));
    capableFfmpeg = await writeFfmpegStub(
      'ffmpeg-hybrid-fragmented',
      '  -movflags <flags> E.......... MOV muxer flags\n     hybrid_fragmented E.......... Write a hybrid fragmented file',
    );
    incapableFfmpeg = await writeFfmpegStub(
      'ffmpeg-plain',
      '  -movflags <flags> E.......... MOV muxer flags\n     frag_keyframe E.......... Fragment at video keyframes',
    );
  });

  after(async () => {
    await fs.rm(ffmpegStubDir, {recursive: true, force: true});
  });

  afterEach(() => {
    sinon.restore();
  });

  describe('screencast_start', () => {
    it('starts a screencast recording with filePath', async () => {
      await withMcpContext(async (response, context) => {
        const mockRecorder = createMockRecorder();
        const selectedPage = context.getSelectedMcpPage().pptrPage;
        const screencastStub = sinon
          .stub(selectedPage, 'screencast')
          .resolves(mockRecorder as never);

        await startScreencast({
          experimentalFfmpegPath: capableFfmpeg,
        } as ParsedArguments).handler(
          {
            params: {filePath: path.join(os.tmpdir(), 'test-recording.mp4')},
            page: context.getSelectedMcpPage(),
          },
          response,
          context,
        );

        sinon.assert.calledOnce(screencastStub);
        const callArgs = screencastStub.firstCall.args[0];
        assert.ok(callArgs);
        assert.ok(callArgs.path?.endsWith('test-recording.mp4'));

        assert.ok(context.getScreenRecorder() !== null);
        assert.ok(
          response.responseLines
            .join('\n')
            .includes('Screencast recording started'),
        );

        await stopScreencast.handler(
          {params: {}, page: context.getSelectedMcpPage()},
          response,
          context,
        );
      });
    });

    it('refuses mp4 if the ffmpeg cannot write a fragmented file', async () => {
      await withMcpContext(async (response, context) => {
        const selectedPage = context.getSelectedMcpPage().pptrPage;
        const screencastStub = sinon.stub(selectedPage, 'screencast');

        await assert.rejects(
          startScreencast({
            experimentalFfmpegPath: incapableFfmpeg,
          } as ParsedArguments).handler(
            {
              params: {filePath: path.join(os.tmpdir(), 'test-recording.mp4')},
              page: context.getSelectedMcpPage(),
            },
            response,
            context,
          ),
          /cannot record mp4/,
        );

        sinon.assert.notCalled(screencastStub);
        assert.strictEqual(context.getScreenRecorder(), null);
      });
    });

    it('generates a WebM temp path if the ffmpeg cannot record mp4', async () => {
      await withMcpContext(async (response, context) => {
        const mockRecorder = createMockRecorder();
        const selectedPage = context.getSelectedMcpPage().pptrPage;
        const screencastStub = sinon
          .stub(selectedPage, 'screencast')
          .resolves(mockRecorder as never);

        await startScreencast({
          experimentalFfmpegPath: incapableFfmpeg,
        } as ParsedArguments).handler(
          {params: {}, page: context.getSelectedMcpPage()},
          response,
          context,
        );

        const callArgs = screencastStub.firstCall.args[0];
        assert.ok(callArgs);
        assert.strictEqual(callArgs.format, 'webm');
        assert.ok(callArgs.path?.endsWith('.webm'));

        await stopScreencast.handler(
          {params: {}, page: context.getSelectedMcpPage()},
          response,
          context,
        );
      });
    });

    it('records WebM for an uppercase extension (case-insensitive)', async () => {
      await withMcpContext(async (response, context) => {
        const mockRecorder = createMockRecorder();
        const selectedPage = context.getSelectedMcpPage().pptrPage;
        const screencastStub = sinon
          .stub(selectedPage, 'screencast')
          .resolves(mockRecorder as never);

        await startScreencast().handler(
          {
            params: {filePath: path.join(os.tmpdir(), 'test-recording.WEBM')},
            page: context.getSelectedMcpPage(),
          },
          response,
          context,
        );

        sinon.assert.calledOnce(screencastStub);
        const callArgs = screencastStub.firstCall.args[0];
        assert.ok(callArgs);
        assert.strictEqual(callArgs.format, 'webm');
        assert.ok(callArgs.path?.endsWith('.webm'));

        await stopScreencast.handler(
          {params: {}, page: context.getSelectedMcpPage()},
          response,
          context,
        );
      });
    });

    it('rejects an unsupported extension instead of silently using mp4', async () => {
      await withMcpContext(async (response, context) => {
        const selectedPage = context.getSelectedMcpPage().pptrPage;
        const screencastStub = sinon.stub(selectedPage, 'screencast');

        await assert.rejects(
          startScreencast().handler(
            {
              params: {filePath: path.join(os.tmpdir(), 'recording.avi')},
              page: context.getSelectedMcpPage(),
            },
            response,
            context,
          ),
          /Unsupported screencast file extension/,
        );

        sinon.assert.notCalled(screencastStub);
        assert.strictEqual(context.getScreenRecorder(), null);
      });
    });

    it('starts a screencast recording with temp file when no filePath', async () => {
      await withMcpContext(async (response, context) => {
        const mockRecorder = createMockRecorder();
        const selectedPage = context.getSelectedMcpPage().pptrPage;
        const screencastStub = sinon
          .stub(selectedPage, 'screencast')
          .resolves(mockRecorder as never);

        await startScreencast({
          experimentalFfmpegPath: capableFfmpeg,
        } as ParsedArguments).handler(
          {params: {}, page: context.getSelectedMcpPage()},
          response,
          context,
        );

        sinon.assert.calledOnce(screencastStub);
        const callArgs = screencastStub.firstCall.args[0];
        assert.ok(callArgs);
        assert.ok(callArgs.path?.endsWith('.mp4'));
        assert.ok(context.getScreenRecorder() !== null);

        await stopScreencast.handler(
          {params: {}, page: context.getSelectedMcpPage()},
          response,
          context,
        );
      });
    });

    it('errors if a recording is already active', async () => {
      await withMcpContext(async (response, context) => {
        const mockRecorder = createMockRecorder();
        context.setScreenRecorder({
          recorder: mockRecorder as never,
          filePath: path.join(os.tmpdir(), 'existing.mp4'),
        });

        const selectedPage = context.getSelectedMcpPage().pptrPage;
        const screencastStub = sinon.stub(selectedPage, 'screencast');

        await startScreencast().handler(
          {params: {}, page: context.getSelectedMcpPage()},
          response,
          context,
        );

        sinon.assert.notCalled(screencastStub);
        assert.ok(
          response.responseLines
            .join('\n')
            .includes('a screencast recording is already in progress'),
        );
      });
    });

    it('provides a clear error when ffmpeg is not found', async () => {
      await withMcpContext(async (response, context) => {
        const selectedPage = context.getSelectedMcpPage().pptrPage;
        const error = new Error('spawn ffmpeg ENOENT');
        sinon.stub(selectedPage, 'screencast').rejects(error);

        await assert.rejects(
          startScreencast({
            experimentalFfmpegPath: capableFfmpeg,
          } as ParsedArguments).handler(
            {
              params: {filePath: path.join(os.tmpdir(), 'test.mp4')},
              page: context.getSelectedMcpPage(),
            },
            response,
            context,
          ),
          /ffmpeg is required for screencast recording/,
        );

        assert.strictEqual(context.getScreenRecorder(), null);
      });
    });

    it('cleans up the generated temp directory if recording fails to start', async () => {
      await withMcpContext(async (response, context) => {
        const selectedPage = context.getSelectedMcpPage().pptrPage;
        const screencastStub = sinon
          .stub(selectedPage, 'screencast')
          .rejects(new Error('spawn ffmpeg ENOENT'));

        await assert.rejects(
          startScreencast({
            experimentalFfmpegPath: capableFfmpeg,
          } as ParsedArguments).handler(
            {params: {}, page: context.getSelectedMcpPage()},
            response,
            context,
          ),
          /ffmpeg is required for screencast recording/,
        );

        // The temp directory generateTempFilePath() created must be removed.
        const tempPath = screencastStub.firstCall.args[0]?.path as string;
        assert.ok(tempPath);
        await assert.rejects(fs.access(path.dirname(tempPath)));
        assert.strictEqual(context.getScreenRecorder(), null);
      });
    });

    it('passes ffmpegPath from args to puppeteer', async () => {
      await withMcpContext(async (response, context) => {
        const mockRecorder = createMockRecorder();
        const selectedPage = context.getSelectedMcpPage().pptrPage;
        const screencastStub = sinon
          .stub(selectedPage, 'screencast')
          .resolves(mockRecorder as never);

        await startScreencast({
          experimentalFfmpegPath: capableFfmpeg,
        } as ParsedArguments).handler(
          {params: {}, page: context.getSelectedMcpPage()},
          response,
          context,
        );

        sinon.assert.calledOnce(screencastStub);
        const callArgs = screencastStub.firstCall.args[0];
        assert.strictEqual(callArgs?.ffmpegPath, capableFfmpeg);

        await stopScreencast.handler(
          {params: {}, page: context.getSelectedMcpPage()},
          response,
          context,
        );
      });
    });

    it('reports a missing ffmpeg before a recording is started', async () => {
      await withMcpContext(async (response, context) => {
        const selectedPage = context.getSelectedMcpPage().pptrPage;
        const screencastStub = sinon.stub(selectedPage, 'screencast');

        await assert.rejects(
          startScreencast({
            experimentalFfmpegPath: path.join(ffmpegStubDir, 'does-not-exist'),
          } as ParsedArguments).handler(
            {
              params: {filePath: path.join(os.tmpdir(), 'test.mp4')},
              page: context.getSelectedMcpPage(),
            },
            response,
            context,
          ),
          /ffmpeg is required for screencast recording/,
        );

        sinon.assert.notCalled(screencastStub);
        assert.strictEqual(context.getScreenRecorder(), null);
      });
    });
  });

  describe('screencast_stop', () => {
    it('returns an error message if no recording is active', async () => {
      await withMcpContext(async (response, context) => {
        assert.strictEqual(context.getScreenRecorder(), null);
        await stopScreencast.handler(
          {params: {}, page: context.getSelectedMcpPage()},
          response,
          context,
        );
        assert.ok(
          response.responseLines
            .join('\n')
            .includes('no active screencast recording to stop'),
        );
      });
    });

    it('stops an active recording and reports the file path', async () => {
      await withMcpContext(async (response, context) => {
        const mockRecorder = createMockRecorder();
        const filePath = path.join(os.tmpdir(), 'test-recording.mp4');
        context.setScreenRecorder({
          recorder: mockRecorder as never,
          filePath,
        });

        await stopScreencast.handler(
          {params: {}, page: context.getSelectedMcpPage()},
          response,
          context,
        );

        sinon.assert.calledOnce(mockRecorder.stop);
        assert.strictEqual(context.getScreenRecorder(), null);
        assert.ok(
          response.responseLines
            .join('\n')
            .includes(`stopped and saved to ${filePath}`),
        );
      });
    });

    it('says so if the recording file stayed empty', async () => {
      await withMcpContext(async (response, context) => {
        const mockRecorder = createMockRecorder();
        const filePath = path.join(ffmpegStubDir, 'empty-recording.webm');
        await fs.writeFile(filePath, '');
        context.setScreenRecorder({
          recorder: mockRecorder as never,
          filePath,
        });

        await stopScreencast.handler(
          {params: {}, page: context.getSelectedMcpPage()},
          response,
          context,
        );

        assert.ok(
          response.responseLines.join('\n').includes('The file is empty'),
        );
      });
    });

    it('clears the recorder even if stop() throws', async () => {
      await withMcpContext(async (response, context) => {
        const mockRecorder = createMockRecorder();
        mockRecorder.stop.rejects(new Error('ffmpeg process error'));
        context.setScreenRecorder({
          recorder: mockRecorder as never,
          filePath: path.join(os.tmpdir(), 'test.mp4'),
        });

        await assert.rejects(
          stopScreencast.handler(
            {params: {}, page: context.getSelectedMcpPage()},
            response,
            context,
          ),
          /ffmpeg process error/,
        );

        assert.strictEqual(context.getScreenRecorder(), null);
      });
    });
  });
});
