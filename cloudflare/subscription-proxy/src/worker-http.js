import { WorkerTransportError } from '../worker-transport.js';

const fail = () => { throw new WorkerTransportError('PROXY_HTTP_REJECTED'); };
const concat = (parts, length) => { const output = new Uint8Array(length); let at = 0; for (const part of parts) { output.set(part, at); at += part.length; } return output; };
const text = new TextDecoder('latin1');

// Single bounded HTTP/1.1 response, without pipelining or ambiguous framing.
export class HTTPResponseDecoder {
  constructor(maxBytes) {
    this.maxBytes = maxBytes; this.header = new Uint8Array(0); this.parts = []; this.length = 0;
    this.status = null; this.headers = null; this.done = false; this.mode = null;
    this.chunkState = 'size'; this.line = []; this.delimiter = 0; this.rawBytes = 0;
  }

  push(input) {
    if (!(input instanceof Uint8Array)) fail();
    this.rawBytes += input.length;
    if (this.rawBytes > this.maxBytes + 131_072) fail();
    if (this.done) { if (input.length) fail(); return true; }
    if (this.status == null) {
      const previous = this.header.length;
      this.header = concat([this.header, input], previous + input.length);
      let at = -1;
      for (let index = Math.max(0, previous - 3); index + 3 < this.header.length; index++) {
        if (this.header[index] === 13 && this.header[index + 1] === 10 && this.header[index + 2] === 13 && this.header[index + 3] === 10) { at = index; break; }
      }
      if (at < 0) { if (this.header.length > 65_536) fail(); return false; }
      if (at > 65_536) fail();
      const lines = text.decode(this.header.subarray(0, at)).split('\r\n');
      const status = /^HTTP\/1\.[01] ([2-5]\d\d)(?: [^\r\n]*)?$/.exec(lines.shift());
      if (!status || lines.length > 100) fail();
      this.status = Number(status[1]); this.headers = new Headers();
      const raw = new Map();
      for (const line of lines) {
        const match = /^([!#$%&'*+.^_`|~\da-z-]+):[ \t]*([^\x00-\x08\x0a-\x1f\x7f]*)$/i.exec(line);
        if (!match) fail();
        const name = match[1].toLowerCase(), value = match[2].trim();
        if (raw.has(name) && ['content-length', 'transfer-encoding', 'content-range', 'location', 'content-encoding'].includes(name)) fail();
        raw.set(name, value);
        if (['content-type', 'content-length', 'content-range', 'accept-ranges', 'location', 'content-encoding'].includes(name)) this.headers.set(name, value);
      }
      const transfer = raw.get('transfer-encoding'), length = raw.get('content-length');
      if (transfer && length) fail();
      if (transfer && transfer.toLowerCase() !== 'chunked') fail();
      if (length != null && (!/^\d{1,16}$/.test(length) || !Number.isSafeInteger(Number(length)) || Number(length) > this.maxBytes)) fail();
      if (this.status === 204 || this.status === 304) { if (transfer || (length != null && Number(length) !== 0)) fail(); this.mode = 'length'; this.remaining = 0; }
      else if (transfer) this.mode = 'chunked';
      else if (length != null) { this.mode = 'length'; this.remaining = Number(length); }
      else this.mode = 'eof';
      input = this.header.subarray(at + 4); this.header = new Uint8Array(0);
    }
    if (this.mode === 'length') {
      if (input.length > this.remaining) fail();
      this._append(input); this.remaining -= input.length; this.done = this.remaining === 0;
    } else if (this.mode === 'eof') this._append(input);
    else this._chunks(input);
    return this.done;
  }

  _append(input) {
    if (!input.length) return;
    this.length += input.length;
    if (this.length > this.maxBytes) fail();
    this.parts.push(input.slice());
  }

  _chunks(input) {
    let at = 0;
    while (at < input.length) {
      if (this.done) fail();
      if (this.chunkState === 'data') {
        const count = Math.min(this.remaining, input.length - at);
        this._append(input.subarray(at, at + count)); at += count; this.remaining -= count;
        if (this.remaining === 0) { this.chunkState = 'delimiter'; this.delimiter = 0; }
      } else if (this.chunkState === 'delimiter') {
        if (input[at++] !== (this.delimiter === 0 ? 13 : 10)) fail();
        if (++this.delimiter === 2) this.chunkState = 'size';
      } else {
        const byte = input[at++]; this.line.push(byte);
        if (this.line.length > 8_192) fail();
        if (byte !== 10) continue;
        if (this.line.length < 2 || this.line[this.line.length - 2] !== 13) fail();
        const line = text.decode(Uint8Array.from(this.line.slice(0, -2))); this.line = [];
        if (this.chunkState === 'trailers') {
          if (!line) this.done = true;
          else if (!/^[!#$%&'*+.^_`|~\da-z-]+:[^\r\n]*$/i.test(line)) fail();
          continue;
        }
        const match = /^([a-f\d]{1,8})(?:;[^\x00-\x1f\x7f]*)?$/i.exec(line);
        if (!match) fail();
        this.remaining = Number.parseInt(match[1], 16);
        if (this.remaining > this.maxBytes - this.length) fail();
        this.chunkState = this.remaining ? 'data' : 'trailers';
      }
    }
  }

  finish() {
    if (this.status == null || (!this.done && this.mode !== 'eof')) fail();
    this.done = true;
    return { status: this.status, headers: this.headers, body: concat(this.parts, this.length) };
  }
}
