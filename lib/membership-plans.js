// One browser-safe catalog for the desktop, admin UI and account service.
// Targeted plan-code receipts use the price saved when the code was issued.
export const MEMBERSHIP_PLANS = Object.freeze([
  Object.freeze({ id: 'daily', name: '日付', days: 1, priceCents: 300, priceLabel: '3' }),
  Object.freeze({ id: 'monthly', name: '月付', days: 30, priceCents: 1990, priceLabel: '19.9' }),
  Object.freeze({ id: 'yearly', name: '年付', days: 365, priceCents: 6990, priceLabel: '69.9' }),
]);

export const getMembershipPlan = id => MEMBERSHIP_PLANS.find(plan => plan.id === id) || null;

export function formatMembershipPrice(planOrCents) {
  const cents = typeof planOrCents === 'object' ? planOrCents?.priceCents : planOrCents;
  return Number.isSafeInteger(cents) && cents >= 0 ? String(cents / 100) : '';
}
