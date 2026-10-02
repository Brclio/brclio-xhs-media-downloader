import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { manageUpdateProxyConfig } from '../scripts/manage-update-proxy-config.mjs';

const origin = 'https://app.example.test';
const urls = ['https://first.example.test/private-fixture?token=fixture-first', 'https://second.example.test/private-fixture?token=fixture-second'];
const token = 'fixture-existing-admin-session-'.repeat(2);
const desired = { enabled: true, subscriptionUrls: urls, reason: '发布后设置更新专用订阅' };
const empty = { enabled: false, subscriptionUrls: [], subscriptionUrl: '', revision: 0, updatedAt: null };
async function files(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'brclio-config-tool-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const config = path.join(directory, 'config.json'), session = path.join(directory, 'session.json'), operation = path.join(directory, 'operation.json');
  await writeFile(config, JSON.stringify(desired), { mode: 0o600 });
  await writeFile(session, JSON.stringify({ adminSession: token }), { mode: 0o600 });
  return { config, session, operation };
}

test('live config tool defaults to read-only, reports direct state, and never sends login requests or credentials', async t => {
  const { config } = await files(t), calls = [], output = [];
  const report = await manageUpdateProxyConfig(['--origin', origin, '--config-file', config], { output: line => output.push(line), fetchImpl: async (url, options) => {
    calls.push(JSON.parse(options.body).action);
    assert.equal(options.headers.Cookie, undefined); assert.equal(options.redirect, 'error');
    return Response.json({ ok: true, proxyConfig: empty });
  } });
  assert.deepEqual(calls, ['update-proxy-config']);
  assert.equal(report.mode, 'read-only'); assert.equal(report.directConnection, true);
  assert.equal(report.revision, 0); assert.equal(report.sources, 0); assert.equal(report.matchesExpected, false);
  assert.equal(output.join('').includes('private-fixture'), false);
  assert.equal(output.join('').includes('fixture-first'), false);
});

test('authenticated live tool recovers uncertain saves with one operation ID and verifies the public two-source config', async t => {
  const { config, session, operation } = await files(t), calls = [], output = [];
  let state = structuredClone(empty), requestId, writes = 0, lose = true;
  const fetchImpl = async (_url, options) => {
    const body = JSON.parse(options.body); calls.push(body);
    if (body.action.startsWith('admin-')) { assert.equal(options.headers.Cookie, `__Host-xhs-admin=${token}`); assert.equal(options.headers.Origin, origin); }
    else assert.equal(options.headers.Cookie, undefined);
    if (body.action === 'admin-save-update-proxy-config') {
      if (!requestId) { requestId = body.input.requestId; writes++; state = { ...desired, subscriptionUrl: urls[0], revision: 1 }; }
      else assert.equal(body.input.requestId, requestId);
      assert.equal(body.input.expectedRevision, 0, 'retry retains the original compared revision');
      if (lose) { lose = false; return Response.json({ ok: false, error: { code: 'STORAGE_WRITE_UNCERTAIN', message: '响应不确定' } }, { status: 503 }); }
      return Response.json({ ok: true, saved: true, appliedRevision: 1, replayed: true, proxyConfig: state });
    }
    assert.ok(['update-proxy-config', 'admin-update-proxy-config'].includes(body.action), 'tool has no email, login or account mutation action');
    return Response.json({ ok: true, proxyConfig: state });
  };
  const args = ['--origin', origin, '--config-file', config, '--session-file', session, '--operation-file', operation, '--apply', '--verify'];
  await assert.rejects(manageUpdateProxyConfig(args, { fetchImpl, output: line => output.push(line) }), { code: 'STORAGE_WRITE_UNCERTAIN' });
  const report = await manageUpdateProxyConfig(args, { fetchImpl, output: line => output.push(line) });
  assert.equal(writes, 1); assert.equal(report.replayed, true); assert.equal(report.sources, 2); assert.equal(report.matchesExpected, true);
  const ledger = await readFile(operation, 'utf8');
  for (const secret of [...urls, token, 'fixture-first', 'fixture-second']) {
    assert.equal(ledger.includes(secret), false, 'local retry identity never stores subscription/session credentials');
    assert.equal(output.join('').includes(secret), false, 'sanitized reports never echo private inputs');
  }
  await writeFile(config, JSON.stringify({ ...desired, reason: '另一个修改原因' }), { mode: 0o600 });
  await assert.rejects(manageUpdateProxyConfig(args, { fetchImpl, output: () => {} }), { code: 'OPERATION_FILE_MISMATCH' });
  assert.equal(calls.filter(value => value.action === 'admin-save-update-proxy-config').length, 2);
});

test('live config tool validates private permissions and complete apply arguments before network mutation', async t => {
  const { config } = await files(t); let calls = 0;
  const options = { fetchImpl: async () => { calls++; throw Error('must not reach network'); }, output: () => {} };
  await assert.rejects(manageUpdateProxyConfig(['--apply'], options), { code: 'APPLY_REQUIRES_PRIVATE_CONFIG_SESSION_AND_OPERATION_FILES' });
  if (process.platform !== 'win32') {
    await chmod(config, 0o644);
    await assert.rejects(manageUpdateProxyConfig(['--config-file', config], options), { code: 'PRIVATE_FILE_UNSAFE' });
  }
  await assert.rejects(manageUpdateProxyConfig(['--origin', 'https://app.example.test/admin/'], options), { code: 'ORIGIN_INVALID' });
  assert.equal(calls, 0);
});

test('live config verification fails closed on mismatches and sanitizes provider failures', async t => {
  const { config } = await files(t);
  await assert.rejects(manageUpdateProxyConfig(['--config-file', config, '--verify'], { output: () => {}, fetchImpl: async () => Response.json({ ok: true, proxyConfig: empty }) }), { code: 'CONFIG_MISMATCH' });
  await assert.rejects(manageUpdateProxyConfig([], { output: () => {}, fetchImpl: async () => { throw Error(urls[0]); } }), error => error.code === 'CONFIG_NETWORK_UNCERTAIN' && !error.message.includes('fixture-first'));
});
