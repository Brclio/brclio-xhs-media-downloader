import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildPaymentChecks } from '../scripts/verify-brclio-pay-production.mjs';

const membershipPage = readFileSync(new URL('../membership.html', import.meta.url), 'utf8');
const requiredMarkers = [
  'membership-catalog-status',
  '在线付款',
  '支付宝继续使用安全收银台',
  '二维码自动收起并刷新会员及功能权限',
];
const membershipCheck = () => buildPaymentChecks({ baseUrl: 'https://deployment.example.test' })
  .find(check => check.name === 'payment/static/membership-page');
const response = text => ({ status: 200, bytes: Buffer.from(text), text });

test('the production membership verifier accepts the actual page without the retired payment brand copy', () => {
  assert.equal(membershipPage.includes('Brclio Pay'), false);
  for (const marker of requiredMarkers) assert.ok(membershipPage.includes(marker), marker);
  assert.doesNotThrow(() => membershipCheck().verify(response(membershipPage)));
});

for (const marker of requiredMarkers) {
  test(`the production membership verifier rejects the page without ${marker}`, () => {
    const incomplete = membershipPage.replaceAll(marker, '');
    assert.equal(incomplete.includes(marker), false);
    assert.throws(() => membershipCheck().verify(response(incomplete)), /Payment static asset markers were missing/);
  });
}
