// One browser-safe catalog for the desktop, admin UI and account service.
// Prices are displayed for manual payment; issuing a code does not verify payment.
export const MEMBERSHIP_PLANS = Object.freeze([
  Object.freeze({ id: 'daily', name: '日付', days: 1, priceCents: 200, priceLabel: '2' }),
  Object.freeze({ id: 'monthly', name: '月付', days: 30, priceCents: 990, priceLabel: '9.9' }),
  Object.freeze({ id: 'yearly', name: '年付', days: 365, priceCents: 3990, priceLabel: '39.9' }),
]);

export const getMembershipPlan = id => MEMBERSHIP_PLANS.find(plan => plan.id === id) || null;

export function formatMembershipPrice(planOrCents) {
  const cents = typeof planOrCents === 'object' ? planOrCents?.priceCents : planOrCents;
  return Number.isSafeInteger(cents) && cents >= 0 ? String(cents / 100) : '';
}
