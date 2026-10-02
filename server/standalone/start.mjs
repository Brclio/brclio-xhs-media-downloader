import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAccountHandler } from '../../api/account.js';
import { createAccountService } from '../auth/service.js';
import { readConfig } from '../auth/config.js';
import { createGithubStore } from '../auth/store.js';
import { createMailer } from '../auth/mailer.js';
import { assertPrivateMigrationPath } from '../storage-migration.js';
import { createStandaloneMemberVideoHandler, createStandaloneServer } from './http.js';
import { createMediaRuntime } from './media.js';

const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));

function integer(env, key, fallback, min, max) {
  const value = Number(env[key] || fallback);
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${key} must be an integer between ${min} and ${max}.`);
  return value;
}

export async function startStandalone({ env = process.env } = {}) {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 13)) throw new Error('Standalone server requires Node.js 22.13 or newer (Node.js 24 recommended).');
  if (Buffer.byteLength(env.AUTH_SECRET_PEPPER || '') < 32) throw new Error('AUTH_SECRET_PEPPER must contain at least 32 bytes. Keep the same value when migrating existing accounts.');
  const driver = env.AUTH_STORAGE_DRIVER || 'sqlite';
  if (!['sqlite', 'github'].includes(driver)) throw new Error('AUTH_STORAGE_DRIVER must be sqlite or github.');
  // Reject invalid runtime settings before opening or creating persistent storage.
  const mediaOptions = { python: env.PYTHON_BIN || 'python3',
    timeoutMs: integer(env, 'SERVER_MEDIA_TIMEOUT_MS', 25_000, 1000, 120_000),
    nodeConcurrency: integer(env, 'SERVER_NODE_CONCURRENCY', 4, 1, 32),
    pythonConcurrency: integer(env, 'SERVER_PYTHON_CONCURRENCY', 2, 1, 16),
  };
  const serverOptions = {
    requestTimeoutMs: integer(env, 'SERVER_REQUEST_TIMEOUT_MS', 60_000, 1000, 180_000),
    maxRequests: integer(env, 'SERVER_MAX_REQUESTS', 32, 1, 256),
  };
  const port = integer(env, 'PORT', 3000, 0, 65_535);
  const config = readConfig(env);
  const staticRoot = path.join(repositoryRoot, 'dist-web');
  const sqlitePath = path.resolve(env.AUTH_SQLITE_PATH || './data/accounts.sqlite');
  // Check before opening/creating the database, including existing symlink aliases.
  // Source assets/admin are copied into other deployments and must stay public-only.
  if (driver === 'sqlite') await assertPrivateMigrationPath(sqlitePath);
  const store = driver === 'sqlite'
    ? new (await import('../auth/sqlite-store.js')).SqliteStateStore({ path: sqlitePath })
    : createGithubStore(env);
  let media, runtime;
  try {
    media = createMediaRuntime(mediaOptions);
    await store.read();
    try { await media.check(); }
    catch { throw new Error('Python runtime is unavailable. Install Python 3.10+ and CA certificates, or set PYTHON_BIN to the interpreter path.'); }
    const service = createAccountService({ store, mailer: createMailer(env), config });
    const accountHandler = createAccountHandler({ service, config, clientIp: req => req.clientIp });
    runtime = await createStandaloneServer({ staticRoot, accountHandler,
      memberVideoHandler: createStandaloneMemberVideoHandler({ env, accountHandler, media }),
      storageCheck: () => store.read(), media, trustedProxy: env.SERVER_TRUST_PROXY || '',
      ...serverOptions,
    });
    const address = await runtime.listen(port, env.HOST || '127.0.0.1');
    return { address, driver, store, async close() { await runtime.close(); store.close?.(); } };
  } catch (error) { media?.close(); if (runtime) await runtime.close(); store.close?.(); throw error; }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const runtime = await startStandalone();
    console.log(`Standalone server listening on ${runtime.address.address}:${runtime.address.port} (storage: ${runtime.driver})`);
    let stopping = false;
    const shutdown = async () => {
      if (stopping) return;
      stopping = true;
      const forced = setTimeout(() => process.exit(1), 15_000);
      forced.unref();
      try { await runtime.close(); clearTimeout(forced); }
      catch { process.exitCode = 1; }
    };
    process.once('SIGTERM', shutdown);
    process.once('SIGINT', shutdown);
  } catch (error) {
    console.error(`Standalone startup failed: ${error.message}`);
    process.exitCode = 1;
  }
}
