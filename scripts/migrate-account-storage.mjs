#!/usr/bin/env node
import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { emptyState } from '../server/auth/store.js';
import { fail } from '../server/auth/errors.js';
import { assertPrivateMigrationPath, createGithubMigrationStore, migrateStorage } from '../server/storage-migration.js';

const help = `Usage: node scripts/migrate-account-storage.mjs --from github|sqlite --to sqlite|github [options]

  --sqlite-path PATH   SQLite file (default: AUTH_SQLITE_PATH or data/accounts.sqlite)
  --apply              Apply the migration; without this option only preview data
  --dry-run            Explicitly request the default read-only preview
  --replace            Replace existing target data; automatically back it up first
  --backup-dir PATH    Backup directory (default: data/migration-backups)
  --help, -h           Show this help

GitHub configuration: AUTH_GITHUB_OWNER, AUTH_GITHUB_REPO, AUTH_GITHUB_TOKEN,
AUTH_GITHUB_BRANCH (main), AUTH_GITHUB_PATH (state/accounts.json).
The repository must be private and its branch must already have an initial commit.
Stop writes on both services before applying. Source and target revisions are
rechecked before import, but this does not lock the source against later writes.
Keep account signing keys, hashing
secrets and mail settings unchanged when switching storage; they are not migrated.
Backups contain private account data. Keep them outside public/static directories.
`;

async function exists(path) {
  try { await access(path, constants.F_OK); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

/** The destination is opened for writing only after --apply and all preflight checks. */
function lazySqliteTarget(SqliteStateStore, path) {
  return {
    async exportSnapshot() {
      if (!(await exists(path))) return { state: emptyState(), parts: [], revision: 0 };
      const store = new SqliteStateStore({ path, readOnly: true, openExisting: true });
      try { return await store.exportSnapshot(); } finally { store.close(); }
    },
    async importSnapshot(snapshot, options) {
      const store = new SqliteStateStore({ path });
      try { return await store.importSnapshot(snapshot, options); } finally { store.close(); }
    },
  };
}

export async function main(argv = process.argv.slice(2), env = process.env, { fetchImpl, output = line => process.stdout.write(`${line}\n`) } = {}) {
  const { values } = parseArgs({ args: argv, strict: true, allowPositionals: false, options: {
    from: { type: 'string' }, to: { type: 'string' }, 'sqlite-path': { type: 'string' }, 'backup-dir': { type: 'string' },
    apply: { type: 'boolean', default: false }, replace: { type: 'boolean', default: false },
    'dry-run': { type: 'boolean', default: false }, help: { type: 'boolean', short: 'h', default: false },
  } });
  if (values.help) { output(help); return; }
  if (!['github', 'sqlite'].includes(values.from) || !['github', 'sqlite'].includes(values.to) || values.from === values.to) fail('MIGRATION_ARGUMENTS', '请指定 --from github --to sqlite 或 --from sqlite --to github。');
  if (values.apply && values['dry-run']) fail('MIGRATION_ARGUMENTS', '--apply 与 --dry-run 不能同时使用。');
  const sqlitePath = resolve(values['sqlite-path'] || env.AUTH_SQLITE_PATH || 'data/accounts.sqlite');
  await assertPrivateMigrationPath(sqlitePath);
  if (values['backup-dir']) await assertPrivateMigrationPath(values['backup-dir']);
  const github = createGithubMigrationStore(env, fetchImpl ? { fetchImpl } : {});
  // Node's SQLite runtime stays out of Vercel and Cloudflare dependency graphs.
  const { SqliteStateStore } = await import('../server/auth/sqlite-store.js');
  let sqliteSource;
  try {
    if (values.from === 'sqlite') {
      if (!(await exists(sqlitePath))) fail('MIGRATION_SOURCE_MISSING', 'SQLite 源文件不存在，迁移未执行。');
      sqliteSource = new SqliteStateStore({ path: sqlitePath, readOnly: true, openExisting: true });
    }
    const result = await migrateStorage({
      source: values.from === 'github' ? github : sqliteSource,
      target: values.to === 'github' ? github : lazySqliteTarget(SqliteStateStore, sqlitePath),
      from: values.from, to: values.to, apply: values.apply, replace: values.replace,
      backupDirectory: values['backup-dir'] || 'data/migration-backups',
      onPreview: preview => output(JSON.stringify(preview, null, 2)),
      onBackup: backup => output(JSON.stringify({ backup }, null, 2)),
    });
    if (result.applied) output(JSON.stringify({ applied: true, revision: result.revision, backup: result.backup }, null, 2));
    else output('仅预览，未写入。确认数量后添加 --apply 执行迁移。');
    return result;
  } finally { sqliteSource?.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => {
    // Do not print request bodies, raw provider errors, credentials, or account data.
    const expected = error?.name === 'AccountError';
    process.stderr.write(`${expected ? error.code : 'MIGRATION_FAILED'}: ${expected ? error.message : '迁移失败；请检查参数、路径权限及运行环境。'}\n`);
    process.exitCode = 1;
  });
}
