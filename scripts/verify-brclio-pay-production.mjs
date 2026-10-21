#!/usr/bin/env node
// Anonymous release checks only: no login, email, checkout, signed payment event
// or real business order. Reports include only public catalog data and fixed errors.
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs, runSmoke } from './verify-cloudflare.mjs';

const FIXTURE_ID = '00000000-0000-4000-8000-000000000000';
const JSON_HEADERS = { 'content-type': 'application/json' };
class PaymentCheckError extends Error {}
const requireCheck = (condition, message) => { if (!condition) throw new PaymentCheckError(message); };
const jsonRequest = value => ({ method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(value) });
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

function paymentOptions(args) {
  const remaining = [], extra = {};
  for (let index = 0; index < args.length; index++) {
    if (['--source-sha', '--output', '--catalog-version'].includes(args[index])) {
      const key = { '--source-sha': 'sourceSha', '--output': 'output', '--catalog-version': 'catalogVersion' }[args[index]];
      requireCheck(!extra[key] && args[index + 1] && !args[index + 1].startsWith('--'), 'Missing or duplicate verification argument.');
      extra[key] = args[++index];
    } else remaining.push(args[index]);
  }
  if (extra.sourceSha) requireCheck(/^[a-f0-9]{7,40}$/.test(extra.sourceSha), 'Source SHA is invalid.');
  if (extra.catalogVersion) requireCheck(/^[a-f0-9]{64}$/.test(extra.catalogVersion), 'Catalog version is invalid.');
  return { ...parseArgs(remaining), ...extra };
}

function json(response, status, errorCode) {
  requireCheck(response.status === status, `Expected HTTP ${status}.`);
  requireCheck(/application\/json/i.test(response.headers.get('content-type') || ''), 'Expected JSON content type.');
  requireCheck(/\bno-store\b/i.test(response.headers.get('cache-control') || ''), 'Missing no-store header.');
  requireCheck(response.headers.get('x-content-type-options') === 'nosniff', 'Missing nosniff header.');
  requireCheck(!response.headers.has('set-cookie'), 'Anonymous request unexpectedly set a cookie.');
  const payload = JSON.parse(response.text);
  requireCheck(payload && typeof payload === 'object' && !Array.isArray(payload), 'Expected a JSON object.');
  if (errorCode) requireCheck(payload.ok === false && payload.error?.code === errorCode, 'Error contract did not match.');
  else requireCheck(payload.ok === true, 'Expected a successful response.');
  return payload;
}

export function buildPaymentChecks({ baseUrl, sourceSha, catalogVersion }, metadata = {}) {
  const checks = [];
  const add = (name, path, init, verify, extra = {}) => {
    const check = { name, path, init, ...extra };
    check.verify = response => {
      try { verify(response); }
      catch (error) {
        check.failureReason = error instanceof PaymentCheckError ? error.message : 'Response contract did not match.';
        throw error;
      }
    };
    checks.push(check);
  };
  let home;
  add('payment/health', '/api/health', {}, response => {
    const payload = json(response, 200);
    requireCheck(payload.platform === 'cloudflare' && typeof payload.version === 'string' && typeof payload.deploymentId === 'string', 'Cloudflare deployment metadata was missing.');
    metadata.deployment = { version: payload.version, deploymentId: payload.deploymentId };
  });
  add('payment/home', '/', {}, response => {
    requireCheck(response.status === 200 && /text\/html/i.test(response.headers.get('content-type') || ''), 'Homepage was unavailable.');
    requireCheck(!response.headers.has('set-cookie'), 'Homepage unexpectedly set a cookie.');
    home = response.text;
  }, { allowRedirect: true });
  add('payment/return-reference-is-static', `/?payment_order=${FIXTURE_ID}&success=true&status=PAID`, {}, response => {
    requireCheck(response.status === 200 && response.text === home, 'Payment return did not serve the unchanged homepage.');
    requireCheck(!response.headers.has('set-cookie'), 'Payment return unexpectedly set a cookie.');
  }, { allowRedirect: true });
  for (const [name, path, markers] of [
    ['membership-page', '/membership', ['membership-catalog-status', '在线付款', '支付宝继续使用安全收银台', '二维码自动收起并刷新会员及功能权限']],
    ['account-ui', '/account-ui.js', ['membership-online-pay', 'membership-online-restart', 'payment_order', 'payment-catalog', 'payment-create', 'payment-resume']],
    ['payment-qr', '/lib/payment-qr.js', ['paymentQrSvg', 'renderPaymentQr', 'crispEdges']],
    ['payment-qr-encoder', '/lib/vendor/qrcodegen.js', ['MIT License', 'QrCode', 'export { qrcodegen }']],
    ['membership-ui', '/membership.js', ['payment-catalog', 'catalog.plans']],
    ['browser-account', '/lib/browser-account.js', ['payment-catalog', 'payment-create', 'payment-resume', 'payment-status']],
    ['manual-commerce-preserved', '/commerce-ui.js', ['wechat:', 'alipay:', 'activation_code:', 'brclio_pay:']],
  ]) add(`payment/static/${name}`, path, {}, response => {
    requireCheck(response.status === 200 && response.bytes.length > 0, 'Payment static asset was unavailable.');
    requireCheck(markers.every(marker => response.text.includes(marker)), 'Payment static asset markers were missing.');
    if (sourceSha && path.endsWith('.js')) {
      const source = execFileSync('git', ['show', `${sourceSha}:${path.slice(1)}`], { encoding: 'buffer', stdio: ['ignore', 'pipe', 'ignore'] });
      requireCheck(sha256(source) === sha256(response.bytes), 'Released static asset differs from the release source commit.');
      (metadata.sourceAssets ||= []).push({ path, sha256: sha256(source) });
    }
  }, { allowRedirect: true });
  add('payment/live-signed-catalog', '/api/account', jsonRequest({ action: 'payment-catalog' }), response => {
    const payload = json(response, 200), catalog = payload.catalog;
    requireCheck(catalog?.enabled === true && catalog.mode === 'live' && catalog.currency === 'CNY' && typeof catalog.version === 'string' && catalog.version.length > 0 && Array.isArray(catalog.plans), 'Public live catalog contract did not match.');
    if (catalogVersion) requireCheck(catalog.version === catalogVersion, 'Product catalog differs from the expected payment-center catalog version.');
    requireCheck(catalog.plans.length === 3 && new Set(catalog.plans.map(plan => plan.id)).size === 3, 'Expected all three distinct membership products.');
    const days = { daily: 1, monthly: 30, yearly: 365 };
    for (const plan of catalog.plans) requireCheck(Object.hasOwn(days, plan.id) && plan.days === days[plan.id] && /^(?:0|[1-9]\d*)\.\d{2}$/.test(plan.amount) && Number.isSafeInteger(plan.priceCents) && plan.priceCents > 0 && Number(plan.amount.replace('.', '')) === plan.priceCents, 'Public catalog price or entitlement was invalid.');
    metadata.catalog = { version: catalog.version, mode: catalog.mode, currency: catalog.currency, plans: catalog.plans.map(({ id, amount, days }) => ({ id, amount, days })) };
  });
  add('payment/anonymous-order-denied', '/api/account', { ...jsonRequest({ action: 'payment-create', input: { client: 'browser', expectedUserId: FIXTURE_ID, requestId: 'anonymous-production-verification', planId: 'daily', amount: '3.00', catalogVersion: 'anonymous-production-verification' } }), headers: { ...JSON_HEADERS, Origin: baseUrl } }, response => json(response, 401, 'ACCOUNT_REQUIRED'));
  add('payment/anonymous-status-denied', '/api/account', { ...jsonRequest({ action: 'payment-status', input: { client: 'browser', expectedUserId: FIXTURE_ID, orderId: FIXTURE_ID, success: true, status: 'PAID' } }), headers: { ...JSON_HEADERS, Origin: baseUrl } }, response => json(response, 401, 'ACCOUNT_REQUIRED'));
  add('payment/anonymous-resume-denied', '/api/account', { ...jsonRequest({ action: 'payment-resume', input: { client: 'browser', expectedUserId: FIXTURE_ID, orderId: FIXTURE_ID } }), headers: { ...JSON_HEADERS, Origin: baseUrl } }, response => json(response, 401, 'ACCOUNT_REQUIRED'));
  for (const [name, path, init, status, code] of [
    ['method', '/api/brclio-payment', {}, 405, 'METHOD_NOT_ALLOWED'],
    ['content-type', '/api/brclio-payment', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' }, 415, 'UNSUPPORTED_MEDIA_TYPE'],
    ['query', '/api/brclio-payment?success=true', jsonRequest({}), 400, 'INVALID_REQUEST'],
    ['oversize', '/api/brclio-payment', jsonRequest({ padding: 'x'.repeat(16_384) }), 413, 'REQUEST_TOO_LARGE'],
    ['unsigned', '/api/brclio-payment', jsonRequest({}), 401, 'PAYMENT_INVALID_SIGNATURE'],
    ['wrong-signature', '/api/brclio-payment', { ...jsonRequest({}), headers: { ...JSON_HEADERS, 'X-Brclio-Timestamp': String(Math.floor(Date.now() / 1000)), 'X-Brclio-Event': 'evt_production_invalid_signature', 'X-Brclio-Signature': '0'.repeat(64) } }, 401, 'PAYMENT_INVALID_SIGNATURE'],
  ]) add(`payment/webhook/${name}`, path, init, response => json(response, status, code));
  add('wechat/registered-catalog', '/api/account', jsonRequest({ action: 'payment-catalog', input: { provider: 'wechat' } }), response => {
    const catalog = json(response, 200).catalog;
    requireCheck(catalog?.enabled === true && catalog.provider === 'wechat' && catalog.mode === 'live' && catalog.currency === 'CNY'
      && JSON.stringify(catalog.channels) === '["native"]' && typeof catalog.version === 'string', 'WeChat product configuration did not match.');
    const prices = { daily: [300, 1], monthly: [1990, 30], yearly: [6990, 365] };
    requireCheck(Array.isArray(catalog.plans) && catalog.plans.length === 3 && new Set(catalog.plans.map(p => p.id)).size === 3, 'Expected three distinct WeChat plans.');
    for (const plan of catalog.plans) requireCheck(prices[plan.id]?.[0] === plan.priceCents && prices[plan.id]?.[1] === plan.days && plan.amount === (plan.priceCents / 100).toFixed(2), 'WeChat price or entitlement did not match.');
    metadata.wechatCatalog = { version: catalog.version, channels: catalog.channels, plans: catalog.plans.map(({ id, amount, days }) => ({ id, amount, days })) };
  });
  add('wechat/anonymous-order-denied', '/api/account', { ...jsonRequest({ action: 'payment-create', input: { provider: 'wechat', client: 'browser', expectedUserId: FIXTURE_ID, requestId: 'anonymous-wechat-verification', planId: 'daily', amount: '3.00', catalogVersion: 'anonymous-wechat-verification' } }), headers: { ...JSON_HEADERS, Origin: baseUrl } }, response => json(response, 401, 'ACCOUNT_REQUIRED'));
  for (const [name, init, status, code] of [
    ['method', {}, 405, 'METHOD_NOT_ALLOWED'],
    ['content-type', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' }, 415, 'UNSUPPORTED_MEDIA_TYPE'],
    ['oversize', jsonRequest({ padding: 'x'.repeat(16_384) }), 413, 'REQUEST_TOO_LARGE'],
    ['unsigned', jsonRequest({}), 401, 'PAYMENT_INVALID_SIGNATURE'],
    ['wrong-signature', { ...jsonRequest({}), headers: { ...JSON_HEADERS, 'X-Brclio-Timestamp': String(Math.floor(Date.now() / 1000)), 'X-Brclio-Nonce': 'a'.repeat(32), 'X-Brclio-Event': 'payment.success.production_invalid_signature', 'X-Brclio-Signature': '0'.repeat(64) } }, 401, 'PAYMENT_INVALID_SIGNATURE'],
  ]) add(`wechat/webhook/${name}`, '/api/brclio-wechat-payment', init, response => json(response, status, code));
  add('wechat/webhook/query', '/api/brclio-wechat-payment?success=true', jsonRequest({}), response => json(response, 400, 'INVALID_REQUEST'));
  add('payment/online-only-ui', '/account-ui.js', {}, response => {
    requireCheck(response.status === 200 && response.text.includes('membership-online-method') && response.text.includes('https://paywc.bornforthis.cn'), 'Online payment method selector is missing.');
    requireCheck(!['membership-report-paid', 'membership-payment-image', 'assets/membership/alipay.png', 'assets/membership/wechat-pay.png'].some(s => response.text.includes(s)), 'Removed manual payment controls were still published.');
  });
  for (const name of ['alipay', 'wechat-pay']) add(`payment/removed-manual-asset/${name}`, `/assets/membership/${name}.png`, {}, response => requireCheck(response.status === 404, 'A removed manual payment code is still public.'));
  return checks;
}

export async function main(args = process.argv.slice(2)) {
  try {
    const options = paymentOptions(args);
    if (options.help) {
      console.log('Usage: node scripts/verify-brclio-pay-production.mjs [BASE_ORIGIN] [--json] [--source-sha SHA] [--catalog-version SHA256] [--output NEW_JSON_FILE]\nAnonymous production verification; no login, mail, order creation, checkout or signed payment callback. Catalog reads are server-signed. Anonymous purchase/status checks cause backend read-only authentication checks. A static return check does not prove authenticated fulfillment. Source SHA checks compare released JavaScript bytes with that Git commit; output files are created exclusively.');
      return 0;
    }
    if (options.noteUrl || options.imageToken || options.videoUrl) throw new Error('Media arguments are unsupported.');
    const metadata = { ...(options.sourceSha ? { sourceSha: options.sourceSha } : {}), ...(options.catalogVersion ? { expectedCatalogVersion: options.catalogVersion } : {}) };
    const checks = buildPaymentChecks(options, metadata);
    const report = await runSmoke(options, { checks, onResult: result => {
      const failureReason = checks.find(check => check.name === result.name)?.failureReason;
      if (!result.ok && failureReason) result.reason = failureReason;
      if (!options.json) console.log(`${result.ok ? 'PASS' : 'FAIL'} ${result.name}${result.status ? ` HTTP ${result.status}` : ''}${result.reason ? `: ${result.reason}` : ''}`);
    } });
    Object.assign(report, metadata, { authenticatedPurchaseVerified: false, realPaymentVerified: false, productionEntitlementGrantVerified: false });
    if (options.output) {
      const target = path.resolve(options.output);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o644 });
    }
    if (options.json) console.log(JSON.stringify(report, null, 2));
    else console.log(`${report.passed}/${report.total} passed. No real payment or production entitlement grant was attempted.`);
    return report.ok ? 0 : 1;
  } catch {
    console.error('Payment production verifier failed. Use --help for supported arguments.');
    return 2;
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) process.exitCode = await main();
