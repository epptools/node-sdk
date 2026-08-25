'use strict';

const tls = require('tls');
const fs = require('fs');
const { ConnectionError } = require('./errors');

// The raw EPP-over-TLS transport: a TLS socket plus RFC 5734 framing (each message is
// prefixed with a 4-byte big-endian total length that INCLUDES the 4 header bytes). Knows
// nothing about EPP semantics — it ships and receives byte frames. All methods are async.
//
// Framing uses Buffer byte lengths, so multibyte (Cyrillic / IDN) payloads are correct.

const MAX_FRAME = 1048576; // 1 MiB guard against a runaway length prefix
// Ceiling on bytes held for a reader that has not asked yet. Pipelining means a few complete
// frames may legitimately queue up, but an unbounded queue would let a chatty (or hostile) peer
// grow the heap by tens of megabytes a second while no readFrame() is pending.
const MAX_BUFFER = 4 * MAX_FRAME;

// Config timeouts are MILLISECONDS, validated on Config construction. The floor here is a second
// line of defence so a stray 0/NaN can never mean "give up immediately".
function timeoutMs(value, fallback) {
  const ms = Math.floor(Number(value));
  return Number.isFinite(ms) && ms > 0 ? Math.max(1000, ms) : fallback;
}

class Connection {
  constructor(config) {
    this.config = config;
    this.socket = null;
    this._chunks = []; // received but unread bytes, coalesced only once a whole frame is in
    this._buffered = 0;
    this._waiters = []; // pending readFrame() resolvers: {resolve, reject, timer, done}
    this._fatal = null; // a terminal error once the socket dies
  }

  open() {
    const cfg = this.config;
    // A Connection is reopenable: detach the previous socket's listeners so they stop writing to
    // the shared read buffer, settle any pending waiters, and clear the fatal state — otherwise a
    // reconnected client would keep failing with the previous socket's error.
    if (this.socket) this.socket.removeAllListeners();
    for (const w of this._waiters) {
      clearTimeout(w.timer);
      w.reject(this._fatal || new ConnectionError('Connection reopened'));
    }
    this._waiters = [];
    this._chunks = [];
    this._buffered = 0;
    this._fatal = null;

    return new Promise((resolve, reject) => {
      const options = {
        host: cfg.host,
        port: cfg.port,
        servername: cfg.host, // SNI
        minVersion: 'TLSv1.2',
        rejectUnauthorized: cfg.verifyPeer,
        checkServerIdentity: cfg.verifyPeerName ? undefined : () => undefined,
      };
      if (cfg.caFile) options.ca = fs.readFileSync(cfg.caFile);
      if (cfg.clientCert) options.cert = fs.readFileSync(cfg.clientCert);
      if (cfg.clientKey) options.key = fs.readFileSync(cfg.clientKey);
      if (cfg.clientKeyPassphrase) options.passphrase = cfg.clientKeyPassphrase;

      let settled = false;
      let connectTimer = null;
      const socket = tls.connect(options, () => {
        settled = true;
        clearTimeout(connectTimer);
        resolve();
      });
      this.socket = socket;
      // The handshake gets its own one-shot deadline. socket.setTimeout() is an INACTIVITY
      // timer: left armed for readTimeout it would destroy a healthy idle EPP session (no command
      // in flight, nothing to receive), so reads are timed per readFrame() instead.
      const connectMs = timeoutMs(cfg.connectTimeout, 10000);
      connectTimer = setTimeout(() => {
        if (settled) return;
        settled = true;
        const e = new ConnectionError(`Connect to ${cfg.host}:${cfg.port} timed out after ${connectMs} ms`);
        socket.destroy();
        this._fail(e);
        reject(e);
      }, connectMs);

      socket.on('data', (chunk) => this._onData(chunk));
      socket.on('error', (err) => {
        const e = new ConnectionError(`TLS/socket error on ${cfg.host}:${cfg.port} — ${err.message}`);
        if (!settled) { settled = true; clearTimeout(connectTimer); reject(e); }
        this._fail(e);
      });
      socket.on('close', () => this._fail(new ConnectionError('Connection closed')));
    });
  }

  isOpen() {
    return this.socket !== null && !this.socket.destroyed && this._fatal === null;
  }

  writeFrame(xml) {
    return new Promise((resolve, reject) => {
      if (!this.socket || this.socket.destroyed) {
        reject(new ConnectionError('Not connected'));
        return;
      }
      const body = Buffer.from(xml, 'utf8');
      const header = Buffer.alloc(4);
      header.writeUInt32BE(body.length + 4, 0);
      this.socket.write(Buffer.concat([header, body]), (err) => {
        if (err) reject(new ConnectionError(`Write failed: ${err.message}`));
        else resolve();
      });
    });
  }

  readFrame() {
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, timer: null, done: false };
      this._waiters.push(waiter);
      this._pump();
      if (waiter.done) return;
      // A frame that is ALREADY buffered wins over a dead socket: RFC 5730 lets the server
      // answer 2501/2502 and close at once, so the buffered reply is delivered first. Checking
      // _fatal ahead of it would surface "Connection closed" in place of the EPP code that
      // explains the close.
      if (this._fatal) {
        this._drop(waiter);
        reject(this._fatal);
        return;
      }
      const ms = timeoutMs(this.config.readTimeout, 30000);
      waiter.timer = setTimeout(() => {
        // A late reply desynchronizes the stream — the next read would return THIS command's
        // response — so a read timeout is terminal, not retryable.
        const e = new ConnectionError(`Read timed out after ${ms} ms`);
        this._fail(e);
        if (this.socket) this.socket.destroy();
      }, ms);
    });
  }

  close() {
    if (this.socket && !this.socket.destroyed) this.socket.destroy();
    this._fail(new ConnectionError('Connection closed'));
  }

  _onData(chunk) {
    this._chunks.push(chunk);
    this._buffered += chunk.length;
    // Validated as bytes arrive, not only in _pump: with no readFrame() pending nothing else
    // applies the 1 MiB guard, and the queue would grow without limit.
    const total = this._peekTotal();
    if (total !== -1 && (total < 4 || total > MAX_FRAME)) {
      this._fail(new ConnectionError(`Invalid EPP frame length: ${total}`));
      if (this.socket) this.socket.destroy();
      return;
    }
    if (this._buffered > MAX_BUFFER) {
      this._fail(new ConnectionError(`Unread EPP data exceeded ${MAX_BUFFER} bytes`));
      if (this.socket) this.socket.destroy();
      return;
    }
    this._pump();
  }

  // Declared total length of the frame at the head of the queue, or -1 with fewer than 4 bytes
  // buffered. Read across chunk boundaries so the queue is concatenated only once a whole frame
  // has arrived — a Buffer.concat on every chunk would be O(n²) on a large split frame.
  _peekTotal() {
    if (this._buffered < 4) return -1;
    let total = 0;
    let seen = 0;
    for (const chunk of this._chunks) {
      for (let k = 0; k < chunk.length && seen < 4; k++, seen++) {
        total = (total * 256) + chunk[k];
      }
      if (seen === 4) break;
    }
    return total;
  }

  _pump() {
    while (this._waiters.length > 0) {
      const total = this._peekTotal();
      if (total === -1 || total < 4 || total > MAX_FRAME || this._buffered < total) return;
      const buf = this._chunks.length === 1 ? this._chunks[0] : Buffer.concat(this._chunks, this._buffered);
      const frame = buf.slice(4, total).toString('utf8');
      this._chunks = total === this._buffered ? [] : [buf.slice(total)];
      this._buffered -= total;
      const waiter = this._waiters.shift();
      waiter.done = true;
      clearTimeout(waiter.timer);
      waiter.resolve(frame);
    }
  }

  _drop(waiter) {
    const at = this._waiters.indexOf(waiter);
    if (at !== -1) this._waiters.splice(at, 1);
    clearTimeout(waiter.timer);
  }

  _fail(err) {
    if (this._fatal) return;
    this._fatal = err;
    // One last pump: a complete frame already in the queue (the 2501/2502 the server sent just
    // before closing) is delivered before anyone hears about the failure.
    this._pump();
    const waiters = this._waiters;
    this._waiters = [];
    for (const w of waiters) {
      clearTimeout(w.timer);
      w.reject(err);
    }
  }
}

module.exports = { Connection };
