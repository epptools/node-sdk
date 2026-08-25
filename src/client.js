'use strict';

const ns = require('./namespaces');
const { ResultCode } = require('./resultCode');
const { Frame } = require('./frame');
const { Response } = require('./response');
const { Connection } = require('./transport');
const { Domain, Contact, Host, Poll } = require('./commands');
const { ConfigError, ConnectionError, CommandError, AuthError, commandErrorFor } = require('./errors');

// EPP client for the Registry service. Open a connection, log in, then reach the object
// commands through the resource getters — client.domain, .contact, .host, .poll. Every
// command returns a Promise<Response>. By default any EPP error code (>= 2000) is thrown as a
// CommandError; call throwOnFailure(false) to inspect codes yourself instead.
//
//   const client = new Client(new Config({ host: 'epp.registry.example', clid: 'YOUR-CLID', password: '...' }));
//   await client.connect();
//   await client.login();
//   const avail = (await client.domain.check(['example.com.ua'])).availability();
//   await client.logout();
//   client.disconnect();

// Matches <pw> and <newPW> in any namespace prefix, including <loginSec:pw>. The open tag may
// carry attributes (`<domain:pw roid="D1-EXAMPLE">`), so anything up to '>' is accepted.
const PW_RE = /(<(?:[\w.-]+:)?(?:pw|newPW)(?:\s[^>]*)?>)([\s\S]*?)(<\/(?:[\w.-]+:)?(?:pw|newPW)\s*>)/g;

// Bounds of the RFC 5730 <pw> / <newPW> schema type (epp:pwType, minLength 6 / maxLength 16).
// The login frame is always schema-validated, so anything outside this range is rejected as an
// opaque 2001 with no hint about which field was wrong.
const PW_MIN = 6;
const PW_MAX = 16;

// Maximum password length when the server supports the Login Security extension (RFC 8807),
// which carries the password outside the 16-character <pw> element. Applies only when the
// server's <greeting> advertises the extension; otherwise PW_MAX applies.
const PW_MAX_LOGINSEC = 128;

// Client version, sent to the server as <loginSec:app> when RFC 8807 is in use. Read from
// package.json so it cannot drift from the published release.
const VERSION = require('../package.json').version;

function utcStamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
}

class Client {
  constructor(config, connection = null, logger = null) {
    this._config = config;
    this._connection = connection || new Connection(config);
    this._logger = logger;
    this._greeting = null;
    this._loggedIn = false;
    this._throw = true;
    this._tridCounter = 0;
    // Per-process component of the client transaction id (clTRID): ids from one process share
    // a stable middle segment and stay unique across concurrent processes.
    this._processToken = String(process.pid);
    this._handlers = {};
  }

  static async connectAndLogin(config) {
    const client = new Client(config);
    await client.connect();
    await client.login();
    return client;
  }

  // Toggle automatic CommandError throwing on EPP error codes.
  throwOnFailure(value = true) {
    this._throw = value;
    return this;
  }

  setLogger(logger) {
    this._logger = logger;
    return this;
  }

  // --- session ---------------------------------------------------------------

  async connect() {
    if (this._config.host === '') throw new ConfigError('Config: host must not be empty');
    if (!this._connection.isOpen()) await this._connection.open();
    const raw = await this._connection.readFrame();
    this._logDebug('EPP << greeting', raw);
    this._greeting = Response.fromXml(raw);
    return this._greeting;
  }

  get greeting() {
    return this._greeting;
  }

  // Send <hello>; the server replies with a fresh <greeting>.
  async hello() {
    await this._connection.writeFrame(`<?xml version="1.0" encoding="UTF-8"?><epp xmlns="${ns.EPP}"><hello/></epp>`);
    this._greeting = Response.fromXml(await this._connection.readFrame());
    return this._greeting;
  }

  // Authenticate. Advertises exactly the services the greeting offered unless
  // Config.objUris / extUris override them. Pass newPassword to rotate the EPP password.
  async login(newPassword = null) {
    if (this._config.clid === '' || this._config.password === '') {
      throw new ConfigError(
        `login requires a non-empty clID and password (clID ${this._config.clid ? 'set' : 'EMPTY'}, password ${this._config.password ? 'set' : 'EMPTY'}) — check your config`,
      );
    }
    // Bounds that hold for every server are checked before connecting, so a misconfigured password
    // never opens a socket. Whether a password longer than PW_MAX is usable depends on the server
    // advertising RFC 8807, so that check happens once the greeting has been read.
    for (const [value, label] of [[this._config.password, 'Config.password'], [newPassword, 'the new password']]) {
      if (value === null) continue;
      const length = [...value].length;
      if (length < PW_MIN || length > PW_MAX_LOGINSEC) {
        throw new ConfigError(`${label} must be ${PW_MIN}-${PW_MAX_LOGINSEC} characters long (got ${length})`);
      }
    }
    if (this._greeting === null) await this.connect();

    const greetingObj = this._greeting ? this._greeting.serviceObjUris() : [];
    const greetingExt = this._greeting ? this._greeting.serviceExtUris() : [];
    let objUris = this._config.objUris || (greetingObj.length ? greetingObj : ns.DEFAULT_OBJ_URIS);
    const extUris = this._config.extUris !== null ? this._config.extUris : (greetingExt.length ? greetingExt : ns.DEFAULT_EXT_URIS);
    // The epp-1.0 base URI is not an object service and is never listed in <login>.
    objUris = objUris.filter((u) => u !== ns.EPP);

    // Two separate decisions about the Login Security extension (RFC 8807), both needing the server
    // to advertise it: whether to TAKE PART (see Config.loginSecurity — that is what makes the
    // server's security events come back) and whether a password has to TRAVEL in it, which is
    // forced only by one longer than the 16 characters the base <pw> element allows.
    const overBaseLimit = (pw) => typeof pw === 'string' && [...pw].length > PW_MAX;
    const loginSecAvailable = extUris.includes(ns.LOGINSEC);
    for (const [value, label] of [[this._config.password, 'Config.password'], [newPassword, 'the new password']]) {
      if (value !== null && overBaseLimit(value) && !loginSecAvailable) {
        throw new ConfigError(
          `${label} is ${[...value].length} characters, but this server does not advertise ${ns.LOGINSEC} — `
          + `the EPP <pw> schema type allows at most ${PW_MAX}, so the server would answer a bare 2001`,
        );
      }
    }
    // Decided PER ELEMENT, not once for the frame. The sentinel means "the real value is in the
    // matching loginSec element", so putting it in an element whose value was NOT relocated points
    // the server at something that is not there. Rotation across the 16-character boundary is
    // exactly that case: changing a short password to a long one relocates newPW alone, and a
    // frame-wide sentinel would send <pw>[LOGIN-SECURITY]</pw> with no <loginSec:pw> beside it,
    // which the server rejects.
    const relocatePw = loginSecAvailable && overBaseLimit(this._config.password);
    const relocateNewPw = loginSecAvailable && newPassword !== null && overBaseLimit(newPassword);
    // The block is also sent when nothing has to be relocated, because that is what makes the
    // server's security events reach you: it returns them only to a client that took part in the
    // extension, since announcing a URI proves nothing. Config.loginSecurity turns this off; a
    // relocated password still sends the block, having no other way to travel.
    const useLoginSec = relocatePw || relocateNewPw || (loginSecAvailable && this._config.loginSecurity);

    const frame = this.frame();
    const login = frame.verb('login');
    frame.epp(login, 'clID', this._config.clid);
    frame.epp(login, 'pw', relocatePw ? ns.LOGINSEC_SENTINEL : this._config.password);
    if (newPassword !== null) frame.epp(login, 'newPW', relocateNewPw ? ns.LOGINSEC_SENTINEL : newPassword);
    const options = frame.epp(login, 'options');
    frame.epp(options, 'version', '1.0');
    frame.epp(options, 'lang', this._config.lang);
    const svcs = frame.epp(login, 'svcs');
    for (const uri of objUris) frame.epp(svcs, 'objURI', uri);
    if (extUris.length) {
      const svcExt = frame.epp(svcs, 'svcExtension');
      for (const uri of extUris) frame.epp(svcExt, 'extURI', uri);
    }
    if (useLoginSec) {
      // <extension> is a sibling of <login> within <command>. The password travels in
      // <loginSec:pw>; the <pw> element above carries the sentinel that points at it.
      const ext = frame.extension();
      const block = frame.ns(ext, ns.LOGINSEC, 'loginSec:loginSec');
      const ua = frame.ns(block, ns.LOGINSEC, 'loginSec:userAgent');
      // app, tech and os in that order — the schema's userAgentType is a sequence, and a registry
      // support desk asked "which client, on what" answers both from one login.
      frame.ns(ua, ns.LOGINSEC, 'loginSec:app', `EppTools Node SDK ${VERSION}`);
      frame.ns(ua, ns.LOGINSEC, 'loginSec:tech', `Node ${process.version}`);
      frame.ns(ua, ns.LOGINSEC, 'loginSec:os', process.platform);
      if (relocatePw) {
        frame.ns(block, ns.LOGINSEC, 'loginSec:pw', this._config.password);
      }
      if (relocateNewPw) {
        frame.ns(block, ns.LOGINSEC, 'loginSec:newPW', newPassword);
      }
    }

    const response = await this._transact(frame.toXml());
    if (response.code() !== 1000) {
      const message = `Login failed (EPP ${response.code()}): ${response.message() || 'no message'}`;
      // Only 2200 means the credentials are wrong. A login can also be refused because the account
      // is at its session limit (2502), because the server is closing (2501), because a service in
      // <svcs> is not offered (2307), because this connection is already logged in (2002), or over
      // the protocol version (2100) — each with its own class and its own remedy. Calling them all
      // an authentication failure sends the reader to rotate a password that was never the problem.
      throw response.code() === ResultCode.AUTHENTICATION_ERROR
        ? new AuthError(response.code(), message, response)
        : commandErrorFor(response.code(), message, response);
    }
    this._loggedIn = true;
    return response;
  }

  async logout() {
    const frame = this.frame();
    frame.verb('logout');
    const response = await this._transact(frame.toXml()); // 1500; the server then closes the link
    this._loggedIn = false;
    return response;
  }

  disconnect() {
    this._connection.close();
    this._loggedIn = false;
  }

  isConnected() {
    return this._connection.isOpen();
  }

  isLoggedIn() {
    return this._loggedIn;
  }

  // --- resource handlers -----------------------------------------------------

  get domain() {
    return this._handlers.domain || (this._handlers.domain = new Domain(this));
  }

  get contact() {
    return this._handlers.contact || (this._handlers.contact = new Contact(this));
  }

  get host() {
    return this._handlers.host || (this._handlers.host = new Host(this));
  }

  get poll() {
    return this._handlers.poll || (this._handlers.poll = new Poll(this));
  }

  // --- the registry's own extensions -----------------------------------------

  // The namespace this registry uses for its own object extensions, or null if it advertises none.
  // Configured value first, otherwise read out of the greeting.
  registryExtUri() {
    if (this._config.registryExtUri != null) return this._config.registryExtUri;
    return ns.registryExtension(this._greeting ? this._greeting.serviceExtUris() : []);
  }

  // The namespace this registry uses for account balance, or null if it advertises none.
  registryBalanceUri() {
    if (this._config.registryBalanceUri != null) return this._config.registryBalanceUri;
    return ns.registryBalance(this._greeting ? this._greeting.serviceExtUris() : []);
  }

  // The registry extension namespace, or an explanation of why there isn't one.
  //
  // Callers that MUST have it use this rather than registryExtUri(), because the alternative to
  // failing here is failing invisibly: an extension sent under a namespace the server does not
  // recognise is ignored, not rejected, so the command succeeds with the licence quietly missing.
  requireRegistryExtUri(what) {
    const uri = this.registryExtUri();
    if (uri != null) return uri;
    const advertised = (this._greeting ? this._greeting.serviceExtUris() : []).join(', ');
    throw new ConfigError(
      `${what} needs the registry's own EPP extension, and ${this._config.host} does not advertise one. `
      + `It offered: ${advertised || '(no greeting read yet)'}. `
      + 'If this registry does support it under a name discovery cannot guess, set registryExtUri in Config.',
    );
  }

  // Query the registrar account balance (creditLimit / balance / availableCredit).
  //
  // Not an RFC command — it exists only where a registry defines it, which is why the namespace is
  // discovered rather than assumed.
  balance() {
    const uri = this.registryBalanceUri();
    if (uri == null) {
      const advertised = (this._greeting ? this._greeting.serviceExtUris() : []).join(', ');
      throw new ConfigError(
        `${this._config.host} advertises no account-balance EPP extension. `
        + `It offered: ${advertised || '(no greeting read yet)'}. `
        + 'If this registry does support one under a name discovery cannot guess, set '
        + 'registryBalanceUri in Config.',
      );
    }
    const frame = this.frame();
    frame.ns(frame.verb('info'), uri, 'balance:info');
    return this.request(frame);
  }

  // --- low-level -------------------------------------------------------------

  // A new command frame with an auto-generated clTRID already stamped.
  frame() {
    return Frame.command(this._nextClTrid());
  }

  // Send a frame (a Frame or raw XML string) and resolve to the parsed Response. Rejects with
  // CommandError on an EPP error code unless throwOnFailure(false) is set.
  async request(frame) {
    const xml = typeof frame === 'string' ? frame : frame.toXml();
    const response = await this._transact(xml);
    if (this._throw && !response.isSuccess()) {
      // The message names the SUBJECT when the registry identified one. On a command carrying five
      // names, "EPP 2302: Object exists" leaves the reader to work out which of the five, and the
      // answer is sitting in <extValue> unread.
      let subject = null;
      for (const ext of response.extValues()) { if (ext.text) { subject = ext.text; break; } }
      const message = `EPP ${response.code()}: ${response.message() || 'command failed'}`
        + (subject ? ` ('${subject}')` : '');
      throw commandErrorFor(response.code(), message, response);
    }
    return response;
  }

  // --- internals -------------------------------------------------------------

  async _transact(xml) {
    if (!this._connection.isOpen()) throw new ConnectionError('Not connected — call connect() first');
    this._logDebug('EPP >> request', this._redact(xml));
    await this._connection.writeFrame(xml);
    const raw = await this._connection.readFrame();
    this._logDebug('EPP << response', this._redact(raw));
    const response = Response.fromXml(raw);
    this._assertBelongsToThisCommand(xml, response);
    if (this._logger) {
      const level = response.isSuccess() ? 'info' : 'warn';
      const fn = this._logger[level] || this._logger.log;
      if (fn) fn.call(this._logger, `EPP result ${response.code()} (svTRID=${response.svTRID()} clTRID=${response.clTRID()})`);
    }
    return response;
  }

  // Every command carries a clTRID and the server echoes it back. Checking it turns a
  // desynchronised stream — a stray unsolicited frame, or two commands in flight at once — from a
  // silent mix-up into a loud failure. Without it, a reply belonging to the previous command is
  // indistinguishable from this one's, and for a renew or a create that means booking the wrong
  // domain as done: renew('b') returns 1000 carrying a's exDate, and both are billed.
  //
  // The connection is closed, not just reported: once the offsets disagree, every later frame on
  // this stream is suspect too.
  //
  // Compared against the CLAMPED form of the clTRID sent: epp-1.0's trIDStringType is 3..64
  // characters, so a server that echoes a caller-supplied clTRID legitimately returns a truncated
  // or padded value. Raw equality would reject those valid replies — the check must catch a WRONG
  // transaction, not a normalised one.
  _assertBelongsToThisCommand(xml, response) {
    const sent = /<clTRID>([^<]*)<\/clTRID>/.exec(xml);
    if (!sent) return;
    const echoed = response.clTRID();
    if (echoed === null || echoed === '') return;
    const sentTrid = sent[1];
    // eslint-disable-next-line no-control-regex
    const clean = sentTrid.replace(/[\x00-\x1F\x7F]/g, '').trim().slice(0, 64);
    const expected = clean.length >= 3 ? clean : clean.padEnd(3, '-');
    if (echoed !== sentTrid && echoed !== expected) {
      this._connection.close();
      throw new ConnectionError(
        `Response does not belong to this command (sent clTRID ${sentTrid}, received ${echoed})`
        + ' — the connection was desynchronised and has been closed.',
      );
    }
  }

  _logDebug(msg, frame) {
    if (this._logger && this._logger.debug) this._logger.debug(`${msg} ${frame}`);
  }

  // Mask passwords / authInfo (any namespace) before a frame is logged.
  _redact(xml) {
    return xml.replace(PW_RE, '$1***$3');
  }

  _nextClTrid() {
    this._tridCounter += 1;
    // A client transaction id that is easy to correlate in logs: prefix, a UTC timestamp,
    // the per-process token and a monotonic counter.
    const counter = String(this._tridCounter).padStart(4, '0');
    return `${this._config.clTRIDPrefix}-${utcStamp()}-${this._processToken}-${counter}`;
  }
}

module.exports = { Client };


