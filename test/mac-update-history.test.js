import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MacUpdateHistory } from '../desktop/mac-update-history.js';

async function fixture(t) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'xhs-history-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cache = path.join(root, 'updates'), current = path.join(root, 'Current.app');
  await mkdir(cache); await mkdir(current);
  const pointer = path.join(cache, 'mac-last-install.json');
  const updates = [];
  const options = { cacheDirectory: cache, currentAppPath: current, currentVersion: '1.8.8',
    onUpdate: value => updates.push(value) };
  const record = { appId: 'cn.bornforthis.xhs-downloader', status: 'cleanup_failed',
    currentAppPath: current, version: '1.8.3', backupVersion: '1.8.2',
    preparedAt: '2026-09-22T02:03:04.000Z', startupConfirmed: true,
    message: '新版已启动 /private/secret', startupToken: 'private-startup-token',
    backupPath: path.join(root, 'previous.app') };
  await mkdir(record.backupPath);
  await writeFile(path.join(record.backupPath, 'keep.txt'), 'recovery backup');
  async function save(value = record, transaction = 'Ab1234') {
    const directory = path.join(cache, `mac-install-${transaction}`);
    await mkdir(directory, { recursive: true });
    const filename = path.join(directory, 'install-result.json');
    await writeFile(filename, JSON.stringify(value));
    await writeFile(pointer, JSON.stringify({ resultPath: filename }));
    return filename;
  }
  const filename = await save();
  const history = new MacUpdateHistory(options);
  return { root, cache, current, pointer, options, record, filename, save, history, updates };
}

test('old cleanup result is versioned history without raw messages, paths, or startup tokens', async t => {
  const f = await fixture(t), before = await readFile(f.pointer, 'utf8');
  const notice = await f.history.refresh();
  assert.equal(notice.targetVersion, '1.8.3');
  assert.equal(notice.previousVersion, '1.8.2');
  assert.equal(notice.currentVersion, '1.8.8');
  assert.equal(notice.recordedAt, f.record.preparedAt);
  assert.match(notice.outcome, /该次安装.*尚未清理/);
  assert.doesNotMatch(JSON.stringify(notice), /新版已启动|private|startupToken|backupPath|Current\.app/);
  assert.equal(await readFile(f.pointer, 'utf8'), before);
  notice.outcome = 'mutated renderer copy';
  assert.notEqual(f.history.snapshot().outcome, notice.outcome);
  await f.history.refresh();
  assert.equal(f.updates.length, 1, 'unchanged historical result does not re-emit');
});

test('dismiss survives process restart and cleanup retries without deleting pointer, journal, or backup', async t => {
  const f = await fixture(t);
  const notice = await f.history.refresh();
  const before = await readFile(f.pointer, 'utf8');
  assert.equal(await f.history.dismiss(notice.id), null);
  assert.equal(await readFile(f.pointer, 'utf8'), before);
  assert.equal(await readFile(path.join(f.record.backupPath, 'keep.txt'), 'utf8'), 'recovery backup');
  assert.equal(JSON.parse(await readFile(f.filename, 'utf8')).status, 'cleanup_failed');
  await f.save({ ...f.record, preparedAt: '2026-09-23T02:03:04.000Z', cleanupFailure: { code: 'RETRY_FAILED' } });
  assert.equal(await new MacUpdateHistory(f.options).refresh(), null, 'rewritten retry is still the same installation');
  await f.save(f.record, 'Cd5678');
  assert.ok(await new MacUpdateHistory(f.options).refresh(), 'a separate installation still gets its own notice');
});

test('late dismissal cannot acknowledge a newer result', async t => {
  const f = await fixture(t), old = await f.history.refresh();
  const filename = await f.save({ ...f.record, version: '1.8.7', status: 'rolled_back' }, 'Cd5678');
  const current = await f.history.dismiss(old.id);
  assert.equal(current.targetVersion, '1.8.7');
  assert.notEqual(current.id, old.id);
  assert.equal(JSON.parse(await readFile(f.pointer, 'utf8')).resultPath, filename);
  assert.equal((await new MacUpdateHistory(f.options).refresh()).id, current.id);
});

test('pointer replaced during read is never deleted or reported as the current history', async t => {
  const f = await fixture(t);
  let replaced = false, next;
  const history = new MacUpdateHistory(f.options, { readJson: async filename => {
    const record = JSON.parse(await readFile(filename, 'utf8'));
    if (filename === f.filename && !replaced) {
      replaced = true;
      next = await f.save({ ...f.record, version: '1.8.8', status: 'awaiting_startup' }, 'Cd5678');
    }
    return record;
  } });
  assert.equal(await history.refresh(), null);
  assert.equal(JSON.parse(await readFile(f.pointer, 'utf8')).resultPath, next);
  assert.equal(await history.refresh(), null);
});

test('new pointer arriving during acknowledgement remains unread and available', async t => {
  const f = await fixture(t);
  let dismissed = false, next;
  const history = new MacUpdateHistory(f.options, { readJson: async filename => {
    const record = JSON.parse(await readFile(filename, 'utf8'));
    if (filename.endsWith('mac-install-notices.json') && !dismissed) {
      dismissed = true;
      next = await f.save({ ...f.record, version: '1.8.7', status: 'rollback_failed' }, 'Cd5678');
    }
    return record;
  } });
  const old = await history.refresh();
  await history.dismiss(old.id);
  const current = await history.refresh();
  assert.equal(current.status, 'rollback_failed');
  assert.equal(current.targetVersion, '1.8.7');
  assert.equal(JSON.parse(await readFile(f.pointer, 'utf8')).resultPath, next);
});

test('successful and active installation states never become warning notices', async t => {
  const f = await fixture(t);
  for (const status of ['installed', 'preparing', 'opening', 'verifying', 'copying', 'checking', 'prepared',
    'ready', 'waiting', 'validating', 'replacing', 'launching', 'awaiting_startup', 'rolling_back',
    'cleanup_pending', 'cleaning', 'cancelled', 'unknown_future_state']) {
    await f.save({ ...f.record, status });
    assert.equal(await f.history.refresh(), null, status);
  }
});

test('rollback failures and unconfirmed startup remain visible even with a newer running version', async t => {
  const f = await fixture(t);
  for (const status of ['rolled_back', 'rollback_failed', 'rollback_blocked', 'startup_unconfirmed', 'helper_failed']) {
    await f.save({ ...f.record, status });
    const notice = await f.history.refresh();
    assert.equal(notice.status, status);
    assert.ok(notice.outcome && notice.action);
    assert.doesNotMatch(notice.outcome, /新版已.*启动/);
  }
});

test('changed outcome in the same installation is not hidden by an earlier acknowledgement', async t => {
  const f = await fixture(t);
  await f.history.dismiss((await f.history.refresh()).id);
  await f.save({ ...f.record, status: 'rollback_failed' });
  assert.equal((await f.history.refresh()).status, 'rollback_failed');
});

test('legacy missing date/version never manufactures current success or a timestamp', async t => {
  const f = await fixture(t);
  await f.save({ ...f.record, preparedAt: undefined, version: undefined, backupVersion: 'invalid' });
  const notice = await f.history.refresh();
  assert.equal(notice.recordedAt, null);
  assert.equal(notice.targetVersion, null);
  assert.equal(notice.previousVersion, null);
  await f.save({ ...f.record, preparedAt: 'not a date', version: '<script>bad</script>' });
  assert.equal((await f.history.refresh()).targetVersion, null);
  assert.equal(f.history.snapshot().recordedAt, null);
});

test('wrong app identity, bundle path, or pointer outside the transaction is ignored', async t => {
  const f = await fixture(t);
  for (const changed of [{ appId: 'other.app' }, { currentAppPath: path.join(f.root, 'Other.app') }]) {
    await f.save({ ...f.record, ...changed });
    assert.equal(await f.history.refresh(), null);
  }
  for (const resultPath of [path.join(f.root, 'install-result.json'), path.join(f.cache, 'a', 'install-result.json'),
    path.join(f.cache, 'mac-install-Ab1234', 'private.json'), '../install-result.json']) {
    await writeFile(f.pointer, JSON.stringify({ resultPath }));
    assert.equal(await f.history.refresh(), null);
  }
});

test('absent, malformed and oversized receipts do not produce a misleading notice', async t => {
  const f = await fixture(t);
  await rm(f.filename);
  assert.equal(await f.history.refresh(), null);
  await writeFile(f.filename, 'not json');
  await assert.rejects(f.history.refresh());
  assert.equal(f.history.snapshot(), null);
  await writeFile(f.filename, ' '.repeat(16001));
  await assert.rejects(f.history.refresh(), /Invalid update history file/);
  assert.equal(f.history.snapshot(), null);
});

test('a corrupt later receipt clears a previously displayed result instead of retaining stale history', async t => {
  const f = await fixture(t);
  assert.ok(await f.history.refresh());
  await writeFile(f.filename, '{partial');
  await assert.rejects(f.history.refresh());
  assert.equal(f.history.snapshot(), null);
  assert.equal(f.updates.at(-1), null);
});

test('corrupt acknowledgement preferences cannot hide rollback failures and recover on explicit dismissal', async t => {
  const f = await fixture(t);
  await f.save({ ...f.record, status: 'rollback_failed' });
  const filename = path.join(f.cache, 'mac-install-notices.json');
  await writeFile(filename, 'corrupt preferences');
  const notice = await f.history.refresh();
  assert.equal(notice.status, 'rollback_failed');
  assert.equal(await readFile(filename, 'utf8'), 'corrupt preferences', 'read has no write side effects');
  assert.equal(await f.history.dismiss(notice.id), null);
  assert.deepEqual(JSON.parse(await readFile(filename, 'utf8')).ids, [notice.id]);
});

test('unexpected acknowledgement JSON shapes are ignored without suppressing a result', async t => {
  const f = await fixture(t);
  for (const value of [null, [], 1, { ids: 'invalid' }, { ids: [null, 'not-an-id'] }]) {
    await writeFile(path.join(f.cache, 'mac-install-notices.json'), JSON.stringify(value));
    assert.equal((await f.history.refresh()).status, 'cleanup_failed');
  }
});

test('symlinked receipt or transaction directory is not followed', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t);
  const external = path.join(f.root, 'external.json'); await writeFile(external, JSON.stringify(f.record));
  await rm(f.filename); await symlink(external, f.filename);
  await assert.rejects(f.history.refresh());
  assert.equal(f.history.snapshot(), null);
  const parent = path.dirname(f.filename);
  await rm(parent, { recursive: true });
  const outside = path.join(f.root, 'outside'); await mkdir(outside);
  await writeFile(path.join(outside, 'install-result.json'), JSON.stringify(f.record));
  await symlink(outside, parent);
  assert.equal(await f.history.refresh(), null);
});

test('unwritable acknowledgement preserves the notice and recovery files', async t => {
  const f = await fixture(t), notice = await f.history.refresh();
  await mkdir(path.join(f.cache, 'mac-install-notices.json'));
  await assert.rejects(f.history.dismiss(notice.id));
  assert.equal(f.history.snapshot().id, notice.id);
  assert.equal(JSON.parse(await readFile(f.filename, 'utf8')).status, 'cleanup_failed');
  assert.equal(await readFile(path.join(f.record.backupPath, 'keep.txt'), 'utf8'), 'recovery backup');
});
