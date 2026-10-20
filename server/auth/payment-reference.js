// Historical manual receipts and automatic WeChat orders use different stored
// paymentKey formats. Compare their real transaction references without changing
// either historical hash or the original receipt text.
export const normalizePaymentReference = value => typeof value === 'string' ? value.trim().toLowerCase() : '';

export function hasWechatTransaction(state, reference, exceptOrderId) {
  const normalized = normalizePaymentReference(reference);
  return Boolean(normalized) && Object.values(state.orders || {}).some(order => order.id !== exceptOrderId
    && order.status === 'confirmed'
    && (order.paymentMethod === 'wechat' || order.paymentMethod === 'brclio_wechat' || order.source === 'brclio_wechat')
    && normalizePaymentReference(order.transactionReference) === normalized);
}
