#!/usr/bin/env node
// Default is read-only. Subscription and existing admin session are file inputs,
// never command arguments or report fields. This tool cannot send login mail.
import { createHash, randomUUID } from 'node:crypto';
import { lstat, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { subscriptionUrlsValue, subscriptionUrlValue } from '../server/auth/update-proxy.js';

const help = `Usage: node scripts/manage-update-proxy-config.mjs [options]
  --origin HTTPS_ORIGIN   Default: https://xhs.download.brclio.com
  --config-file PATH      Private JSON: {enabled, subscriptionUrls, reason}
  --session-file PATH     Private JSON: {adminSession: "existing session token"}
  --operation-file PATH   Private retry identity; required with --apply
  --verify                Require current config to match --config-file
  --apply                 Save through the authenticated administrator API
  --help                  Show help
Without --apply this tool only reads. All private files must be regular files
owned by the current user with mode 600 (or stricter). No login codes are sent.
Retain the same operation file when retrying an uncertain save; use a new file
for a different configuration. Reports contain no subscription or session data.`;

function reject(code) { const error = new Error(code); error.code = code; throw error; }
async function privateJSON(filename, maximum = 49152) {
  const stat = await lstat(filename).catch(() => reject('PRIVATE_FILE_UNAVAILABLE'));
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maximum ||
      (process.platform !== 'win32' && ((stat.mode & 0o077) || (process.getuid && stat.uid !== process.getuid())))) reject('PRIVATE_FILE_UNSAFE');
  const content = await readFile(filename, 'utf8').catch(() => reject('PRIVATE_FILE_UNAVAILABLE'));
  try { return JSON.parse(content); } catch { reject('PRIVATE_FILE_INVALID_JSON'); }
}
function desiredConfiguration(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.enabled !== 'boolean') reject('CONFIG_INVALID');
  let subscriptionUrls;
  try { subscriptionUrls = subscriptionUrlsValue(Object.hasOwn(value, 'subscriptionUrls') ? value.subscriptionUrls : [value.subscriptionUrl], { enabled: value.enabled }); }
  catch { reject('CONFIG_INVALID_SUBSCRIPTIONS'); }
  const reason = typeof value.reason === 'string' ? value.reason.trim() : '';
  if (reason.length < 2 || reason.length > 500) reject('CONFIG_INVALID_REASON');
  return { enabled: value.enabled, subscriptionUrls, reason };
}
function viewConfiguration(value) {
  if (!value || typeof value.enabled !== 'boolean' || !Number.isSafeInteger(value.revision) || value.revision < 0) reject('CONFIG_RESPONSE_INVALID');
  let subscriptionUrls;
  try { subscriptionUrls = subscriptionUrlsValue(Object.hasOwn(value, 'subscriptionUrls') ? value.subscriptionUrls : [value.subscriptionUrl || ''], { enabled: value.enabled }); }
  catch { reject('CONFIG_RESPONSE_INVALID'); }
  if (value.revision === 0 && (value.enabled || subscriptionUrls.length)) reject('CONFIG_RESPONSE_INVALID');
  return { enabled: value.enabled, subscriptionUrls, revision: value.revision };
}
const equalConfiguration = (left, right) => left.enabled === right.enabled && JSON.stringify(left.subscriptionUrls) === JSON.stringify(right.subscriptionUrls);

export async function manageUpdateProxyConfig(argv = process.argv.slice(2), { fetchImpl = fetch, output = line => process.stdout.write(`${line}\n`) } = {}) {
  let values;
  try { ({ values } = parseArgs({ args: argv, strict: true, allowPositionals: false, options: {
    origin: { type: 'string', default: 'https://xhs.download.brclio.com' },
    'config-file': { type: 'string' }, 'session-file': { type: 'string' }, 'operation-file': { type: 'string' },
    apply: { type: 'boolean', default: false }, verify: { type: 'boolean', default: false }, help: { type: 'boolean', default: false },
  } })); } catch { reject('ARGUMENTS_INVALID'); }
  if (values.help) { output(help); return; }
  let origin;
  try { origin = new URL(values.origin); subscriptionUrlValue(`${origin.origin}/api/account`); } catch { reject('ORIGIN_INVALID'); }
  if (origin.origin !== values.origin) reject('ORIGIN_INVALID');
  if (values.apply && (!values['config-file'] || !values['session-file'] || !values['operation-file'])) reject('APPLY_REQUIRES_PRIVATE_CONFIG_SESSION_AND_OPERATION_FILES');
  if (values.verify && !values['config-file']) reject('VERIFY_REQUIRES_CONFIG_FILE');
  const desired = values['config-file'] ? desiredConfiguration(await privateJSON(resolve(values['config-file']))) : null;
  let adminSession;
  if (values['session-file']) {
    const session = await privateJSON(resolve(values['session-file']), 4096);
    adminSession = session?.adminSession;
    if (typeof adminSession !== 'string' || !/^[A-Za-z0-9_-]{32,200}$/.test(adminSession)) reject('ADMIN_SESSION_FILE_INVALID');
  }
  async function call(action, input = {}, authenticated = false) {
    let response;
    try {
      response = await fetchImpl(`${origin.origin}/api/account`, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
        headers: { 'Content-Type': 'application/json', ...(authenticated ? { Origin: origin.origin, Cookie: `__Host-xhs-admin=${adminSession}` } : {}) }, body: JSON.stringify({ action, input }) });
    } catch { reject('CONFIG_NETWORK_UNCERTAIN'); }
    let value;
    try { const body = await response.text(); if (body.length > 65536) reject('CONFIG_RESPONSE_TOO_LARGE'); value = JSON.parse(body); }
    catch { reject('CONFIG_RESPONSE_INVALID'); }
    const code = value?.error?.code || value?.code;
    if (!response.ok || value?.ok !== true) reject(/^[A-Z][A-Z0-9_]{0,79}$/.test(code || '') ? code : 'CONFIG_API_REJECTED');
    return value;
  }
  let current = viewConfiguration((await call('update-proxy-config')).proxyConfig);
  if (adminSession) {
    const admin = viewConfiguration((await call('admin-update-proxy-config', {}, true)).proxyConfig);
    if (!equalConfiguration(current, admin) || current.revision !== admin.revision) reject('CONFIG_CHANGED_DURING_READ');
  }
  let saved;
  if (values.apply) {
    const operationPath = resolve(values['operation-file']);
    const configurationHash = createHash('sha256').update(JSON.stringify(desired)).digest('hex');
    let operation;
    try { await lstat(operationPath); operation = await privateJSON(operationPath, 4096); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      operation = { requestId: randomUUID(), expectedRevision: current.revision, origin: origin.origin, configurationHash };
      await writeFile(operationPath, `${JSON.stringify(operation)}\n`, { flag: 'wx', mode: 0o600 }).catch(() => reject('OPERATION_FILE_CREATE_FAILED'));
    }
    if (!operation || operation.origin !== origin.origin || operation.configurationHash !== configurationHash ||
        !/^[0-9a-f-]{36}$/i.test(operation.requestId || '') || !Number.isSafeInteger(operation.expectedRevision) || operation.expectedRevision < 0) reject('OPERATION_FILE_MISMATCH');
    saved = await call('admin-save-update-proxy-config', { ...desired, expectedRevision: operation.expectedRevision, requestId: operation.requestId }, true);
    if (saved.saved !== true || !Number.isSafeInteger(saved.appliedRevision)) reject('CONFIG_SAVE_UNCONFIRMED');
    current = viewConfiguration((await call('update-proxy-config')).proxyConfig);
    if (!equalConfiguration(current, desired)) reject('CONFIG_CHANGED_AFTER_SAVE');
  }
  const matchesExpected = desired ? equalConfiguration(current, desired) : undefined;
  if (values.verify && !matchesExpected) reject('CONFIG_MISMATCH');
  const report = { result: 'PASS', mode: values.apply ? 'apply' : 'read-only', configured: current.revision > 0,
    enabled: current.enabled, revision: current.revision, sources: current.subscriptionUrls.length,
    directConnection: !current.enabled, administratorSessionVerified: Boolean(adminSession), matchesExpected,
    ...(saved ? { appliedRevision: saved.appliedRevision, replayed: Boolean(saved.replayed) } : {}) };
  output(JSON.stringify(report)); return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  manageUpdateProxyConfig().catch(error => {
    process.stderr.write(`${/^[A-Z][A-Z0-9_]{0,99}$/.test(error?.code || '') ? error.code : 'CONFIG_TOOL_FAILED'}: 配置操作未确认完成；请检查后台版本、权限和私有输入文件。\n`);
    process.exitCode = 1;
  });
}
