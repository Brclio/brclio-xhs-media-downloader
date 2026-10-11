import { Readable } from 'node:stream';
import { stringify } from 'yaml';

export const NOTE = 'https://www.xiaohongshu.com/explore/668d2967000000002500100a?xsec_token=test-token';
export const MEDIA = 'https://sns-webpic-qc.xhscdn.com/image-path';
export const SUBSCRIPTION = 'https://subscription.example.com/current?token=private-test-token';
export const proxyNode = (index = 1, overrides = {}) => ({
  name: `PRIVATE_NAME_${index}`, type: 'vless', server: `node${index}.example.com`, port: 443,
  uuid: `11111111-2222-3333-4444-${String(index).padStart(12, '0')}`,
  tls: true, servername: 'tls.example.com', network: 'ws',
  'client-fingerprint': 'chrome', 'ws-opts': { path: '/private-path?key=private-node-token', headers: { Host: 'ws.example.com' } },
  ...overrides,
});
export const subscription = (nodes = [proxyNode()]) => stringify({ proxies: nodes, 'proxy-providers': { evil: { url: 'https://bad.example/secret' } }, rules: ['MATCH,DIRECT'] });
export function upstream(status, headers = {}, value = '') {
  const body = Readable.from([Buffer.from(value)]);
  return { status, headers, body, closed: false, close() { this.closed = true; body.destroy(); } };
}
export async function collect(response) {
  const chunks = [];
  for await (const chunk of response.body) chunks.push(chunk);
  return { status: response.status, headers: response.headers, body: Buffer.concat(chunks) };
}
