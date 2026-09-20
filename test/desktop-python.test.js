import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { PythonBackend } from '../desktop/python-backend.js';

const appDirectory = fileURLToPath(new URL('..', import.meta.url));

test('desktop executes the real Python handler without starting an HTTP server', async (context) => {
  const backend = new PythonBackend({ appDirectory });
  const runtimeDirectory = path.join(appDirectory, 'desktop-runtime', `${process.platform === 'darwin' ? 'mac' : process.platform === 'win32' ? 'win' : 'linux'}-${process.arch}`, 'python');
  const required = process.env.XHS_REQUIRE_BUNDLED_PYTHON === '1' || existsSync(runtimeDirectory);
  const available = await backend.initialize();
  if (required) {
    assert.equal(available, true, 'The bundled Python worker must start');
    assert.ok(backend.command.startsWith(runtimeDirectory + path.sep), 'The installed bundle must not use system Python');
  } else if (!available) { context.skip('Developer Python not installed; packaged CI separately requires the frozen worker.'); return; }
  try {
    const result = await backend.request({ path: '/api/python_parse', method: 'POST', headers: {},
      body: JSON.stringify({ text: 'https://ci.xiaohongshu.com/abc123?imageView2/format/jpg' }) });
    assert.equal(result.status, 200);
    const parsed = await result.json();
    assert.equal(parsed.engine, 'python');
    assert.equal(parsed.count, 1);
    const image = await backend.request({ path: '/api/python_image?token=..%2Fetc', method: 'GET' });
    assert.equal(image.status, 400);
    const video = await backend.request({ path: '/api/python_video?url=https%3A%2F%2Fevil.test%2Fclip.mp4', method: 'GET' });
    assert.equal(video.status, 400);
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(backend.request({ path: '/api/python_parse', method: 'GET' }, controller.signal));
  } finally { backend.close(); }
});

test('packaged desktop never falls back to system Python', async () => {
  const missing = await mkdtemp(path.join(os.tmpdir(), 'xhs-no-python-'));
  try {
    const backend = new PythonBackend({ appDirectory, resourcesDirectory: missing, packaged: true });
    assert.equal(await backend.initialize(), false);
  } finally { await rm(missing, { recursive: true, force: true }); }
});
