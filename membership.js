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
    if (!reply?.ok || catalog?.mode !== 'live' || catalog?.currency !== 'CNY' || typeof catalog?.enabled !== 'boolean' || !Array.isArray(catalog.plans)) throw new Error();
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
    status.textContent = cheapest
      ? '以上为最新在线报价，按次购买，不自动续费。在线付款经服务端核实后开通；人工扫码套餐以开通窗口展示为准，兑换激活码后生效。已有未到期时长可顺延。'
      : '在线购买暂未开放。原有人工扫码与激活码流程仍可在「账号与会员 → 开通会员」查看。';
  } catch {
    for (const card of document.querySelectorAll('[data-plan]')) {
      card.querySelector('[data-plan-price]').textContent = '待查询';
      card.querySelector('[data-plan-currency]').hidden = true;
    }
    document.querySelector('[data-starting-price]').textContent = '报价暂不可用';
    document.querySelector('[data-starting-suffix]').hidden = true;
    if (status) status.textContent = '暂时无法读取在线报价，请在开通窗口刷新。原有人工扫码与激活码流程仍可使用，人工套餐以开通窗口展示为准。';
  }
}

void showLatestCatalog();
