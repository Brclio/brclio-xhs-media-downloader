import { MEMBERSHIP_PLANS } from './lib/membership-plans.js';
import { getAccountBridge } from './lib/browser-account.js';

const { document } = globalThis.brclioPageContext?.() ?? globalThis;

async function showLatestCatalog() {
  const status = document.getElementById('membership-catalog-status');
  try {
    const bridge = getAccountBridge();
    if (!bridge?.commerceRequest) throw new Error();
    const reply = await bridge.commerceRequest('payment-catalog');
    const catalog = reply?.result?.catalog;
    if (!reply?.ok || catalog?.mode !== 'live' || catalog?.currency !== 'CNY' || typeof catalog?.enabled !== 'boolean' || (catalog.acceptingPayments !== undefined && typeof catalog.acceptingPayments !== 'boolean') || !Array.isArray(catalog.plans)) throw new Error();
    const plans = new Map();
    for (const plan of catalog.plans) {
      const rule = MEMBERSHIP_PLANS.find(item => item.id === plan.id);
      if (!rule || plans.has(plan.id) || plan.days !== rule.days || typeof plan.name !== 'string' || !plan.name ||
        !Number.isSafeInteger(plan.priceCents) || plan.priceCents <= 0 || !/^\d+\.\d{2}$/.test(plan.amount) || Number(plan.amount.replace('.', '')) !== plan.priceCents) throw new Error();
      plans.set(plan.id, plan);
    }
    for (const rule of MEMBERSHIP_PLANS) {
      const card = document.querySelector(`[data-plan="${rule.id}"]`), plan = catalog.enabled && plans.get(rule.id);
      if (!card) continue;
      card.querySelector('[data-plan-price]').textContent = plan ? plan.amount : '停售';
      card.querySelector('[data-plan-currency]').hidden = !plan;
      if (plan) card.querySelector('[data-plan-name]').textContent = plan.name;
    }
    const cheapest = catalog.enabled && [...plans.values()].reduce((minimum, plan) => !minimum || plan.priceCents < minimum.priceCents ? plan : minimum, null);
    document.querySelector('[data-starting-price]').textContent = cheapest ? `¥${cheapest.amount}` : '在线购买暂停';
    document.querySelector('[data-starting-suffix]').hidden = !cheapest;
    status.textContent = cheapest && catalog.acceptingPayments === false
      ? '以上为支付宝最新在线报价。该渠道支付中心尚未启用在线收款，请稍后刷新；可在「账号与会员 → 开通会员」查看微信在线付款。'
      : cheapest
      ? '以上为支付宝最新在线报价，按次购买，不自动续费。开通窗口可另选微信在线付款并核对该渠道报价；微信付款二维码直接显示在开通窗口，手机网页需另一台设备展示后扫码。服务端确认付款后自动收起二维码、刷新会员结果，已有未到期时长可顺延。'
      : '该渠道在线购买暂未开放，请在开通窗口查看其他在线付款渠道，或稍后刷新。';
  } catch {
    for (const card of document.querySelectorAll('[data-plan]')) {
      card.querySelector('[data-plan-price]').textContent = '待查询';
      card.querySelector('[data-plan-currency]').hidden = true;
    }
    document.querySelector('[data-starting-price]').textContent = '报价暂不可用';
    document.querySelector('[data-starting-suffix]').hidden = true;
    if (status) status.textContent = '暂时无法读取在线报价，请在开通窗口选择支付宝或微信并刷新报价。已有激活码可在账号页兑换。';
  }
}

void showLatestCatalog();
