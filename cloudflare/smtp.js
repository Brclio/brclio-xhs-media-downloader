import nodemailer from 'nodemailer';

const MAX_REPLY_BYTES = 65_536;
const MAX_REPLY_LINES = 100;
const MAX_MESSAGE_BYTES = 131_072;
const MAX_OPERATION_MS = 30_000;

class SmtpError extends Error {
  constructor(code = 'ESOCKET') {
    super('SMTP operation failed.');
    this.name = 'SmtpError';
    this.code = code;
  }
}
const ensure = (condition, code) => { if (!condition) throw new SmtpError(code); };
const nativeConnect = async (...args) => (await import('cloudflare:sockets')).connect(...args);

function envelopeAddress(value) {
  // SMTP envelope commands accept a single bare ASCII addr-spec, never display
  // names, recipient lists, quoted addresses or protocol delimiters.
  ensure(typeof value === 'string' && value.length <= 254 && /^[\x21-\x7e]+$/.test(value), 'EENVELOPE');
  const parts = value.split('@');
  ensure(parts.length === 2 && parts[0].length <= 64 && parts[0].split('.').every(atom => /^[A-Za-z0-9!#$%&*+/=?^_`{|}~-]+$/.test(atom)), 'EENVELOPE');
  ensure(parts[1].split('.').length >= 2 && parts[1].split('.').every(label => /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label)), 'EENVELOPE');
  return value;
}

/**
 * Nodemailer-compatible transport for the existing mailer injection point.
 * Nodemailer composes MIME locally; Workers-native sockets handle SMTP so its
 * Node DNS/TLS shims never participate. No retries after an uncertain DATA write.
 */
export function createNativeSmtpTransport(options, {
  connectImpl = nativeConnect,
  createMessageTransport = nodemailer.createTransport,
  operationTimeoutMs = MAX_OPERATION_MS,
} = {}) {
  const port = Number(options.port);
  ensure([465, 587].includes(port) && options.secure === (port === 465) && options.requireTLS === true, 'ETLS');
  ensure(options.tls?.rejectUnauthorized !== false, 'ETLS');
  ensure(typeof options.host === 'string' && /^[A-Za-z0-9.-]+$/.test(options.host), 'EDNS');
  ensure(typeof options.auth?.user === 'string' && typeof options.auth?.pass === 'string' && options.auth.user && options.auth.pass && !/[\0\r\n]/.test(options.auth.user + options.auth.pass), 'EAUTH');
  const duration = (value, fallback) => Number.isFinite(value) && value > 0 ? Math.min(value, MAX_OPERATION_MS) : fallback;
  const connectionMs = duration(options.connectionTimeout, 10_000);
  const greetingMs = duration(options.greetingTimeout, 10_000);
  const commandMs = duration(options.socketTimeout, 15_000);
  let currentSocket;
  let active = false;
  let closed = false;

  function close() {
    closed = true;
    // Socket.close() force-closes both streams and unblocks pending reads.
    try { currentSocket?.close().catch(() => {}); } catch { /* already closed */ }
  }

  async function operation(delivery) {
    ensure(!active && !closed, 'ECONNECTION');
    active = true;
    const deadline = Date.now() + duration(operationTimeoutMs, MAX_OPERATION_MS);
    let reader, writer;
    let pending = '';
    let encrypted = false;
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    async function bounded(promise, maximum = commandMs) {
      let timer;
      const remaining = Math.min(maximum, deadline - Date.now());
      ensure(remaining > 0 && !closed, 'ETIMEDOUT');
      try {
        return await Promise.race([promise, new Promise((_, reject) => {
          timer = setTimeout(() => { reject(new SmtpError('ETIMEDOUT')); close(); }, remaining);
        })]);
      } finally { clearTimeout(timer); }
    }
    function streams(socket) {
      currentSocket = socket;
      socket.closed.catch(() => {});
      reader = socket.readable.getReader();
      writer = socket.writable.getWriter();
    }
    async function reply(maximum = commandMs) {
      const replyDeadline = Math.min(deadline, Date.now() + maximum);
      const lines = [];
      let code;
      let receivedBytes = pending.length;
      for (;;) {
        const end = pending.indexOf('\n');
        if (end < 0) {
          const part = await bounded(reader.read(), replyDeadline - Date.now());
          ensure(!part.done, 'ECONNECTION');
          receivedBytes += part.value.byteLength;
          ensure(receivedBytes <= MAX_REPLY_BYTES, 'EPROTOCOL');
          pending += decoder.decode(part.value, { stream: true });
          continue;
        }
        const line = pending.slice(0, end).replace(/\r$/, '');
        pending = pending.slice(end + 1);
        const match = /^(\d{3})([ -])(.*)$/.exec(line);
        ensure(match && lines.length < MAX_REPLY_LINES, 'EPROTOCOL');
        const nextCode = Number(match[1]);
        ensure(code === undefined || code === nextCode, 'EPROTOCOL');
        code = nextCode;
        lines.push(match[3]);
        if (match[2] === ' ') return { code, lines };
      }
    }
    async function command(value, codes, maximum = commandMs) {
      await bounded(writer.write(encoder.encode(`${value}\r\n`)), maximum);
      const result = await reply(maximum);
      ensure(codes.includes(result.code), 'EPROTOCOL');
      return result;
    }
    async function quit() {
      try { await command('QUIT', [221], 1000); } catch { /* accepted DATA or AUTH already confirmed */ }
    }
    try {
      const socket = await bounded(Promise.resolve(connectImpl({ hostname: options.host, port }, { secureTransport: port === 465 ? 'on' : 'starttls' })), connectionMs);
      streams(socket);
      await bounded(socket.opened, connectionMs);
      encrypted = port === 465;
      ensure((await reply(greetingMs)).code === 220, 'EPROTOCOL');
      let capabilities = await command('EHLO brclio.com', [250]);
      if (port === 587) {
        ensure(capabilities.lines.some(line => /^STARTTLS(?:\s|$)/i.test(line)), 'ETLS');
        await command('STARTTLS', [220]);
        ensure(pending === '', 'EPROTOCOL');
        reader.releaseLock();
        writer.releaseLock();
        const secureSocket = socket.startTls();
        streams(secureSocket);
        await bounded(secureSocket.opened, connectionMs);
        encrypted = true;
        capabilities = await command('EHLO brclio.com', [250]);
      }
      ensure(encrypted && capabilities.lines.some(line => /^AUTH(?:=|\s).*\bPLAIN\b/i.test(line)), 'EAUTH');
      const auth = Buffer.from(`\0${options.auth.user}\0${options.auth.pass}`).toString('base64');
      const authReply = await command(`AUTH PLAIN ${auth}`, [235, 334]);
      if (authReply.code === 334) await command(auth, [235]);
      if (!delivery) {
        await quit();
        return true;
      }
      await command(`MAIL FROM:<${delivery.from}>`, [250]);
      await command(`RCPT TO:<${delivery.to}>`, [250, 251]);
      await command('DATA', [354]);
      await bounded(writer.write(delivery.message));
      ensure((await reply()).code === 250, 'EMESSAGE');
      // A failed QUIT cannot undo the SMTP server's explicit DATA acceptance.
      await quit();
      return { accepted: [delivery.to], rejected: [] };
    } catch (error) {
      // Never propagate server replies, authentication commands or socket errors
      // that may contain connection or credential details.
      throw error instanceof SmtpError ? error : new SmtpError();
    } finally {
      close();
      try { reader?.releaseLock(); } catch { /* read interrupted by close */ }
      try { writer?.releaseLock(); } catch { /* write interrupted by close */ }
      active = false;
    }
  }

  return {
    verify: () => operation(),
    async sendMail(message) {
      ensure(!active && !closed, 'ECONNECTION');
      const composer = createMessageTransport({ streamTransport: true, buffer: true, newline: 'windows', logger: false, debug: false });
      let composed;
      try { composed = await composer.sendMail(message); }
      catch { throw new SmtpError('EMESSAGE'); }
      finally { composer.close(); }
      const from = envelopeAddress(composed.envelope?.from);
      ensure(Array.isArray(composed.envelope?.to) && composed.envelope.to.length === 1, 'EENVELOPE');
      const to = envelopeAddress(composed.envelope.to[0]);
      ensure(Buffer.isBuffer(composed.message) && composed.message.length > 0 && composed.message.length <= MAX_MESSAGE_BYTES, 'EMESSAGE');
      // Latin-1 preserves every MIME byte; the composer produces CRLF lines.
      let data = composed.message.toString('latin1').replace(/(^|\r\n)\./g, '$1..');
      if (!data.endsWith('\r\n')) data += '\r\n';
      return operation({ from, to, message: Buffer.from(`${data}.\r\n`, 'latin1') });
    },
    close,
  };
}
