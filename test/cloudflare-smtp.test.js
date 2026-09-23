import test from 'node:test';
import assert from 'node:assert/strict';
import { createNativeSmtpTransport } from '../cloudflare/smtp.js';
import { createCloudflareMailer } from '../cloudflare/mailer.js';

const options = port => ({ host: 'smtp.example.test', port, secure: port === 465, requireTLS: true, auth: { user: 'sender@example.test', pass: 'fixture-secret' }, tls: { rejectUnauthorized: true }, connectionTimeout: 100, greetingTimeout: 100, socketTimeout: 100 });
const message = { from: 'Brclio <sender@example.test>', to: { address: 'recipient@example.test' }, subject: '验证码', text: '正文\n.first\n.\n最后一行', headers: { 'X-Account-Delivery-ID': 'fixture-delivery' } };

function smtpServer({ responseFor, fragmented = false, authChallenge = false, quitFailure = false } = {}) {
  const commands = [];
  const writes = [];
  const sockets = [];
  let dataMode = false;
  let awaitingChallenge = false;
  let tls = false;
  let accepted = 0;
  function socket(greeting) {
    let controller;
    let ended = false;
    const emit = value => {
      if (value === null || ended) return;
      const encoded = new TextEncoder().encode(value);
      if (fragmented) for (const byte of encoded) controller.enqueue(Uint8Array.of(byte));
      else controller.enqueue(encoded);
    };
    const value = {
      opened: Promise.resolve({}), closed: Promise.resolve(),
      readable: new ReadableStream({ start(c) { controller = c; if (greeting) emit('220 fixture SMTP\r\n'); } }),
      writable: new WritableStream({ async write(bytes) {
        const text = Buffer.from(bytes).toString('utf8');
        writes.push(Buffer.from(bytes));
        const kind = dataMode ? 'MESSAGE' : awaitingChallenge ? 'AUTH-RESPONSE' : text.trim().split(' ')[0];
        commands.push(kind);
        if (kind.startsWith('AUTH')) assert.equal(tls, true, 'Authentication occurred before TLS');
        const overridden = responseFor?.(kind, text);
        if (overridden !== undefined) { emit(overridden); return; }
        if (kind === 'EHLO') emit('250-fixture\r\n250-STARTTLS\r\n250-AUTH PLAIN LOGIN\r\n250 SIZE 999999\r\n');
        else if (kind === 'STARTTLS') emit('220 Go ahead\r\n');
        else if (kind === 'AUTH' && authChallenge) { awaitingChallenge = true; emit('334 \r\n'); }
        else if (kind === 'AUTH' || kind === 'AUTH-RESPONSE') { awaitingChallenge = false; emit('235 Authenticated\r\n'); }
        else if (kind === 'MAIL') emit('250 Sender accepted\r\n');
        else if (kind === 'RCPT') emit('251 Recipient accepted\r\n');
        else if (kind === 'DATA') { dataMode = true; emit('354 Send data\r\n'); }
        else if (kind === 'MESSAGE') { dataMode = false; accepted++; emit('250 Queued\r\n'); }
        else if (kind === 'QUIT') { if (quitFailure) throw new Error('PRIVATE-server-error'); emit('221 Bye\r\n'); }
        else throw new Error('Unexpected fixture command');
      } }),
      startTls() { tls = true; return socket(false); },
      async close() { if (!ended) { ended = true; controller.close(); } },
      get wasClosed() { return ended; },
    };
    sockets.push(value);
    return value;
  }
  return {
    commands, writes, sockets, get accepted() { return accepted; },
    connectImpl(address, mode) {
      assert.equal(address.hostname, 'smtp.example.test');
      assert.equal(mode.secureTransport, address.port === 465 ? 'on' : 'starttls');
      tls = mode.secureTransport === 'on';
      return socket(true);
    },
  };
}

test('native SMTP verify authenticates over implicit TLS or mandatory STARTTLS without sending mail', async () => {
  for (const port of [465, 587]) {
    const server = smtpServer({ fragmented: true, authChallenge: true });
    const transport = createNativeSmtpTransport(options(port), server);
    assert.equal(await transport.verify(), true);
    assert.deepEqual(server.commands, port === 465 ? ['EHLO', 'AUTH', 'AUTH-RESPONSE', 'QUIT'] : ['EHLO', 'STARTTLS', 'EHLO', 'AUTH', 'AUTH-RESPONSE', 'QUIT']);
    assert.equal(server.accepted, 0);
    assert.ok(server.sockets.at(-1).wasClosed);
  }
});

test('native SMTP composes unchanged MIME, dot-stuffs the body, and requires explicit DATA acceptance', async () => {
  const server = smtpServer();
  const result = await createNativeSmtpTransport(options(465), server).sendMail(message);
  assert.deepEqual(result, { accepted: ['recipient@example.test'], rejected: [] });
  assert.deepEqual(server.commands, ['EHLO', 'AUTH', 'MAIL', 'RCPT', 'DATA', 'MESSAGE', 'QUIT']);
  const data = server.writes[server.commands.indexOf('MESSAGE')].toString('utf8');
  assert.match(data, /Content-Type: text\/plain; charset=utf-8/);
  assert.match(data, /X-Account-Delivery-ID: fixture-delivery/);
  assert.match(data, /Content-Transfer-Encoding: base64/);
  assert.equal(Buffer.from(data.split('\r\n\r\n')[1].replace(/\r\n\.\r\n$/, ''), 'base64').toString('utf8'), message.text);
  assert.ok(data.endsWith('\r\n.\r\n'));
  assert.equal(server.accepted, 1);
  assert.ok(server.sockets[0].wasClosed);
  const asciiServer = smtpServer();
  await createNativeSmtpTransport(options(465), asciiServer).sendMail({ ...message, text: 'first\n.line\n.\nlast' });
  assert.match(asciiServer.writes[asciiServer.commands.indexOf('MESSAGE')].toString('utf8'), /\r\n\.\.line\r\n\.\.\r\n/);
});

test('negative recipient or DATA replies fail without retrying or claiming acceptance', async () => {
  for (const stage of ['RCPT', 'MESSAGE']) {
    const server = smtpServer({ responseFor: kind => kind === stage ? '550 PRIVATE-provider-detail\r\n' : undefined });
    await assert.rejects(createNativeSmtpTransport(options(465), server).sendMail(message), error => error.message === 'SMTP operation failed.' && !error.message.includes('PRIVATE'));
    assert.equal(server.commands.filter(kind => kind === stage).length, 1);
    assert.equal(server.accepted, 0);
    assert.ok(server.sockets[0].wasClosed);
  }
});

test('failed QUIT after DATA 250 retains the confirmed successful acceptance', async () => {
  const server = smtpServer({ quitFailure: true });
  const result = await createNativeSmtpTransport(options(465), server).sendMail(message);
  assert.deepEqual(result.accepted, ['recipient@example.test']);
  assert.equal(server.accepted, 1);
});

test('invalid, oversized and stalled SMTP replies fail boundedly and close sockets', async () => {
  for (const reply of ['250-first\r\n550 wrong-code\r\n', 'x'.repeat(65_537), null]) {
    const server = smtpServer({ responseFor: kind => kind === 'EHLO' ? reply : undefined });
    await assert.rejects(createNativeSmtpTransport(options(465), { ...server, operationTimeoutMs: 20 }).verify(), error => ['EPROTOCOL', 'ETIMEDOUT'].includes(error.code));
    assert.ok(!server.commands.includes('AUTH'));
    assert.ok(server.sockets[0].wasClosed);
  }
});

test('587 cannot authenticate if STARTTLS is missing or the TLS handshake fails', async () => {
  const server = smtpServer({ responseFor: kind => kind === 'EHLO' ? '250 AUTH PLAIN\r\n' : undefined });
  await assert.rejects(createNativeSmtpTransport(options(587), server).verify(), { code: 'ETLS' });
  assert.ok(!server.commands.includes('AUTH'));
  const failed = smtpServer();
  const connect = failed.connectImpl;
  failed.connectImpl = (...args) => {
    const socket = connect(...args);
    socket.startTls = () => { throw new Error('PRIVATE-TLS-detail'); };
    return socket;
  };
  await assert.rejects(createNativeSmtpTransport(options(587), failed).verify(), { message: 'SMTP operation failed.' });
  assert.ok(!failed.commands.includes('AUTH'));
});

test('rejects unsafe SMTP options, multiple recipients and oversized MIME before connecting', async () => {
  for (const bad of [{ port: 25 }, { secure: false }, { requireTLS: false }, { tls: { rejectUnauthorized: false } }, { host: 'evil\r\n.test' }]) {
    assert.throws(() => createNativeSmtpTransport({ ...options(465), ...bad }));
  }
  const connectImpl = () => assert.fail('Invalid message reached network');
  await assert.rejects(createNativeSmtpTransport(options(465), { connectImpl }).sendMail({ ...message, to: ['a@example.test', 'b@example.test'] }), { code: 'EENVELOPE' });
  await assert.rejects(createNativeSmtpTransport(options(465), { connectImpl }).sendMail({ ...message, text: 'x'.repeat(150_000) }), { code: 'EMESSAGE' });
});

test('Cloudflare mailer keeps shared OTP template and non-SMTP providers unchanged', async () => {
  const env = { AUTH_MAIL_PROVIDER: 'smtp', AUTH_SMTP_HOST: 'smtp.example.test', AUTH_SMTP_USER: 'sender@example.test', AUTH_SMTP_PASS: 'fixture-secret', AUTH_MAIL_FROM: 'Brclio <sender@example.test>' };
  const server = smtpServer();
  const mailer = createCloudflareMailer(env, undefined, server);
  assert.equal(mailer.configured, true);
  await mailer.send({ email: 'recipient@example.test', code: '123456', expiresInMinutes: 5, deliveryId: 'fixture-delivery' });
  assert.equal(server.accepted, 1);
  const calls = [];
  const resend = createCloudflareMailer({ AUTH_MAIL_PROVIDER: 'resend', AUTH_MAIL_API_KEY: 'fixture', AUTH_MAIL_FROM: 'sender@example.test' }, async (url, init) => { calls.push({ url, body: JSON.parse(init.body) }); return new Response('{}'); }, { connectImpl: () => assert.fail('Non-SMTP used a socket') });
  await resend.send({ email: 'recipient@example.test', code: '123456', expiresInMinutes: 5, deliveryId: 'fixture-delivery' });
  assert.equal(calls[0].url, 'https://api.resend.com/emails');
  assert.match(calls[0].body.text, /123456/);
  assert.match(calls[0].body.text, /Not spam/);
});

test('Cloudflare native SMTP carries the activation template and stable delivery identifier', async () => {
  const server = smtpServer();
  const mailer = createCloudflareMailer({ AUTH_MAIL_PROVIDER: 'smtp', AUTH_SMTP_HOST: 'smtp.example.test', AUTH_SMTP_USER: 'sender@example.test', AUTH_SMTP_PASS: 'fixture-secret', AUTH_MAIL_FROM: 'Brclio <sender@example.test>' }, undefined, server);
  const code = `Brclio-${'B'.repeat(40)}`;
  await mailer.sendActivation({ email: 'recipient@example.test', code, plan: { id: 'daily', name: '日付', days: 1, priceCents: 200 }, redeemBy: null, deliveryId: 'activation-fixture' });
  assert.equal(server.accepted, 1);
  const data = server.writes[server.commands.indexOf('MESSAGE')].toString('utf8');
  assert.match(data, /X-Account-Delivery-ID: activation-fixture/);
  const body = Buffer.from(data.split('\r\n\r\n')[1].replace(/\r\n\.\r\n$/, ''), 'base64').toString('utf8');
  assert.ok(body.includes(code)); assert.match(body, /日付 · 2 元/); assert.match(body, /会员时长：1 天/); assert.match(body, /不设兑换截止时间/);
});
