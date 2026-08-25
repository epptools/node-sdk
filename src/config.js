'use strict';

// Immutable connection settings for an EPP session.
//
// EPP is strict RFC EPP over TLS, conventionally on port 700. Many registries need NO client
// certificate; the optional clientCert / clientKey / clientKeyPassphrase are for the ones that
// require mutual TLS. When objUris / extUris are left null the client logs in advertising exactly
// the services the server greeting offers, so it is never rejected for an unsupported service.

const { ConfigError } = require('./errors');

const MIN_TIMEOUT_MS = 1000;

function checkTimeout(value, name, fallback) {
  if (value == null) return fallback;
  const ms = Number(value);
  if (!Number.isFinite(ms) || ms <= 0) {
    throw new ConfigError(`${name} must be a positive number of MILLISECONDS, got ${JSON.stringify(value)}`);
  }
  if (ms < MIN_TIMEOUT_MS) {
    throw new ConfigError(
      `${name} is in milliseconds and must be at least ${MIN_TIMEOUT_MS} (got ${ms}). `
      + `If you meant ${ms} seconds, pass ${ms * 1000}.`,
    );
  }
  return ms;
}

class Config {
  constructor(opts = {}) {
    this.host = opts.host || '';
    this.clid = opts.clid || '';
    this.password = opts.password || '';
    this.port = opts.port != null ? opts.port : 700;
    this.lang = opts.lang || 'en';
    // Timeouts in MILLISECONDS. A seconds-shaped value is rejected rather than quietly raised to
    // the floor: read as milliseconds, `readTimeout: 30` is a thirtieth of a second, and a deadline
    // that short on a create or a renew gives up while the registry is still working — the command
    // may well have been carried out and billed, and a read timeout is terminal, so the client
    // would report a failure for an operation that in fact succeeded.
    this.connectTimeout = checkTimeout(opts.connectTimeout, 'connectTimeout', 10000);
    this.readTimeout = checkTimeout(opts.readTimeout, 'readTimeout', 30000);
    this.verifyPeer = opts.verifyPeer != null ? opts.verifyPeer : true;
    this.verifyPeerName = opts.verifyPeerName != null ? opts.verifyPeerName : true;
    // CA bundle that signs the SERVER certificate (PEM path, for a private-CA endpoint).
    this.caFile = opts.caFile != null ? opts.caFile : null;
    // Your (registrar) client certificate — only when mutual TLS is required. PEM path.
    this.clientCert = opts.clientCert != null ? opts.clientCert : null;
    // Your client private key. PEM path. May be omitted when bundled in clientCert.
    this.clientKey = opts.clientKey != null ? opts.clientKey : null;
    // Passphrase for an encrypted client private key, if any.
    this.clientKeyPassphrase = opts.clientKeyPassphrase != null ? opts.clientKeyPassphrase : null;
    // Override the login objURIs / extURIs; null = use the greeting's.
    this.objUris = opts.objUris != null ? opts.objUris : null;
    this.extUris = opts.extUris != null ? opts.extUris : null;
    // Prefix for auto-generated client transaction ids (clTRID).
    this.clTRIDPrefix = opts.clTRIDPrefix || 'NODEJS-SDK';
    // Override the registry's own extension namespaces. Null — the normal case — discovers them
    // from the <greeting>.
    //
    // WHEN YOU NEED THESE. Discovery matches the last segment of an advertised URI
    // (`.../registry-1.0`, `.../balance-1.0`), which is the convention registries follow but not a
    // rule anybody enforces. A registry that names its extension something else is served by setting
    // the URI here — the library then sends exactly this and asks the greeting nothing.
    //
    // A wrong value is not a validation error, it is silence: an extension sent under a namespace
    // the server does not recognise is not rejected, it is IGNORED, so the licence or the price is
    // simply absent from what comes back and nothing anywhere says why.
    this.registryExtUri = opts.registryExtUri != null ? opts.registryExtUri : null;
    this.registryBalanceUri = opts.registryBalanceUri != null ? opts.registryBalanceUri : null;
    // Take part in the Login Security extension (RFC 8807) when the server offers it.
    //
    // A server returns its security events — a client certificate about to expire, an obsolete TLS
    // version, a weak cipher suite — only to a client that SENT the extension block, because
    // announcing a URI is not evidence of supporting it. So a client that never sends the block
    // never hears the warning, and the first sign of trouble is the day the certificate stops
    // working. Read what came back with Response.securityEvents().
    //
    // Set false to stay off the extension. It is then used only where it is unavoidable — a
    // password longer than the 16 characters the base <pw> element can carry.
    this.loginSecurity = opts.loginSecurity !== false;
  }
}

module.exports = { Config };


