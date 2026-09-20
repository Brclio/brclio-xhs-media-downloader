import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, appendFile, symlink } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { DiagnosticLog, splitDiagnosticParts } from '../desktop/diagnostic-log.js';
import { sanitizeDiagnostic, containsDiagnosticSecrets } from '../lib/diagnostic-sanitize.js';
import { validateFeedbackChunk } from '../server/auth/feedback.js';

const temporary = async t => { const dir = await mkdtemp(path.join(os.tmpdir(), 'xhs-diagnostics-')); t.after(() => rm(dir, { recursive: true, force: true })); return dir; };
test('diagnostics redact credentials, signed URLs, personal paths with spaces, IDs and email idempotently', () => {
  const dirty = { cookie: 'secret-cookie', nested: { privateKey: 'private-key' },
    message: 'Bearer secret-token\nCookie: a1=private\nhttps://cdn.example/a.mp4?xsec_token=private#fragment\n"/Users/Full Name/Secret Folder/file"\n"C:\\Users\\Full Name\\Secret Folder\\file"\nuser@example.com github_pat_secrettoken 123e4567-e89b-12d3-a456-426614174000',
    long: '中'.repeat(20000), list: Array.from({ length: 300 }, (_, i) => i) };
  const clean = sanitizeDiagnostic(dirty), serialized = JSON.stringify(clean);
  for (const secret of ['secret-cookie', 'private-key', 'secret-token', 'xsec_token', 'Full Name', 'Secret Folder', 'user@example', 'github_pat_', '123e4567']) assert.ok(!serialized.includes(secret), secret);
  assert.ok(serialized.includes('https://cdn.example/a.mp4'));
  assert.deepEqual(sanitizeDiagnostic(clean), clean);
  assert.equal(containsDiagnosticSecrets(clean), false);
  assert.equal(containsDiagnosticSecrets(dirty), true);
});

test('rolling logs retain bounded complete records across restarts and validate with the actual upload parser', async t => {
  const directory = await temporary(t), maxBytes = 64000;
  const logger = await new DiagnosticLog({ directory, maxBytes }).initialize();
  for (let i = 0; i < 200; i++) await logger.record('request.failed', { index: i, message: '中'.repeat(250), cookie: 'never-save' }, 'warn');
  const snapshot = await logger.snapshot({ app: 'test' });
  assert.ok(snapshot.truncated); assert.ok(snapshot.totalBytes <= maxBytes);
  assert.ok(snapshot.text.includes('"index":199')); assert.ok(!snapshot.text.includes('never-save'));
  const parts = splitDiagnosticParts(snapshot.text, 5000);
  assert.equal(parts.join(''), snapshot.text); parts.forEach(part => validateFeedbackChunk(part));
  const restarted = await new DiagnosticLog({ directory, maxBytes }).initialize();
  const next = await restarted.snapshot(); assert.ok(next.truncated); assert.ok(next.text.includes('"index":199'));
  assert.ok((await readdir(directory)).filter(name => name.endsWith('.ndjson')).length <= 8);
});

test('snapshot includes all queued records before capture, tolerates corrupt lines, and handles clocks going backwards', async t => {
  let now = Date.parse('2026-09-20T10:00:00Z');
  const directory = await temporary(t), logger = await new DiagnosticLog({ directory, now: () => now }).initialize();
  await logger.record('before', { authorization: 'never-save' });
  now -= 100000; await logger.record('clock.changed', { value: true });
  await appendFile(logger.file(), 'not-json\n');
  const capture = logger.snapshot(); const later = logger.record('after');
  const snapshot = await capture; await later;
  assert.ok(!snapshot.text.includes('"event":"after"')); assert.ok(snapshot.text.includes('"event":"before"'));
  assert.equal(snapshot.oldestAt, new Date(now).toISOString());
  assert.equal(snapshot.newestAt, '2026-09-20T10:00:00.000Z');
  assert.ok(snapshot.truncated); splitDiagnosticParts(snapshot.text).forEach(part => validateFeedbackChunk(part));
});

test('logging failures are reported and do not follow a log-file symlink', { skip: process.platform === 'win32' }, async t => {
  const directory = await temporary(t), target = path.join(directory, 'unrelated.txt');
  await appendFile(target, 'preserve'); await symlink(target, path.join(directory, 'events.ndjson'));
  const logger = new DiagnosticLog({ directory });
  await assert.rejects(logger.initialize(), /Invalid log file/);
  await logger.record('test'); assert.ok(logger.lastError);
  assert.equal(await readFile(target, 'utf8'), 'preserve');
});

test('chunk splitting preserves UTF-8 and rejects partial or oversized log records', () => {
  const text = ['中文', '😀😀', 'hello'].map(value => JSON.stringify(value) + '\n').join('');
  const parts = splitDiagnosticParts(text, 16); assert.equal(parts.join(''), text);
  assert.ok(parts.every(part => Buffer.byteLength(part) <= 16));
  assert.throws(() => splitDiagnosticParts('partial'), /完整行/);
  assert.throws(() => splitDiagnosticParts('123456789\n', 4), /超过/);
});

test('large multibyte messages and historical entries stay below the server line-byte limit', async t => {
  const directory = await temporary(t), logger = await new DiagnosticLog({ directory }).initialize();
  await logger.record('fixture.large', { message: '中'.repeat(12000) });
  await appendFile(logger.file(), JSON.stringify({ at: new Date().toISOString(), level: 'warn', event: 'legacy.large', details: { message: '😀'.repeat(12000) } }) + '\n');
  const snapshot = await logger.snapshot();
  assert.ok(snapshot.text.includes('diagnostics.entry_reduced'));
  for (const line of snapshot.text.trimEnd().split('\n')) assert.ok(Buffer.byteLength(line) < 24000);
  splitDiagnosticParts(snapshot.text).forEach(part => validateFeedbackChunk(part));
});
