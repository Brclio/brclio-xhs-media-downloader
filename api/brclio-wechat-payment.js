import { createBrclioPaymentHandler } from './brclio-payment.js';

// Separate product secret and raw-body route keep existing Alipay deliveries valid.
export const config = { api: { bodyParser: false } };
export const createBrclioWechatPaymentHandler = options => createBrclioPaymentHandler({ ...options, provider: 'wechat' });
export default createBrclioWechatPaymentHandler();
