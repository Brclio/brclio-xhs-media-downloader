import { MEMBERSHIP_PLANS } from './lib/membership-plans.js';

// Keep introduction prices aligned with the account purchase dialog.
// HTML provides readable prices and working navigation without JavaScript.
for (const plan of MEMBERSHIP_PLANS) {
  const card = document.querySelector(`[data-plan="${plan.id}"]`);
  if (!card) continue;
  card.querySelector('[data-plan-name]').textContent = plan.name;
  card.querySelector('[data-plan-price]').textContent = plan.priceLabel;
  card.querySelector('[data-plan-days]').textContent = String(plan.days);
}
const startingPlan = MEMBERSHIP_PLANS.reduce((minimum, plan) =>
  !minimum || plan.priceCents < minimum.priceCents ? plan : minimum, null);
if (startingPlan) document.querySelector('[data-starting-price]').textContent = `¥${startingPlan.priceLabel}`;
