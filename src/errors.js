'use strict';

const { ResultCode } = require('./resultCode');

// Error hierarchy raised by the SDK.
//
// Catch EppError to handle any failure. Catch a subclass when a particular failure needs a
// different response from your code — which is the rule the hierarchy follows: a class exists
// where the right next step differs, and nowhere else.
//
//   ConfigError       this client is set up wrong (no host, no credentials) — every call fails
//   ValidationError   this call's arguments are wrong — the next call can be fine
//   ConnectionError   transport: TLS, timeout, framing
//   CommandError      the registry refused (>= 2000); see its subclasses below

class EppError extends Error {
  constructor(message) {
    super(message);
    this.name = 'EppError';
  }
}

class ConnectionError extends EppError {
  constructor(message) {
    super(message);
    this.name = 'ConnectionError';
  }
}

// The client itself is misconfigured: no host, no credentials, a password this server cannot
// carry. Every call will fail the same way until the deployment changes. Distinct from
// ValidationError because the two need opposite responses — one is answered to whoever made the
// request, the other is an alert for whoever runs the service.
class ConfigError extends EppError {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

// A value passed to this call cannot be used, and nothing was sent: an unknown option, a fee that
// is not a decimal, an operation this registry does not implement.
class ValidationError extends EppError {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
  }
}

// The server answered with an EPP error result code (>= 2000).
class CommandError extends EppError {
  constructor(eppCode, message, response = null) {
    super(message);
    this.name = 'CommandError';
    this.eppCode = eppCode;   // the EPP result code (>= 2000)
    this.response = response; // the full parsed Response, if one was received
  }

  // Whether sending the very same command again could succeed.
  //
  // True only for failures about the moment rather than the request. Retrying a 2302 cannot make
  // the name free and retrying a 2104 cannot pay for it; a loop that treats every failure as
  // transient turns one refusal into a rate-limit ban.
  isRetryable() {
    return [
      ResultCode.COMMAND_FAILED,
      ResultCode.COMMAND_FAILED_SERVER_CLOSING,
      ResultCode.AUTHENTICATION_SERVER_CLOSING,
      ResultCode.SESSION_LIMIT_EXCEEDED_SERVER_CLOSING,
    ].includes(this.eppCode);
  }

  // The object the registry objected to, when it said which — the one name in a batch of five that
  // was rejected. Null when the answer named nothing, which is common.
  subject() {
    for (const ext of (this.response ? this.response.extValues() : [])) {
      if (ext.text) return ext.text;
    }
    return null;
  }

  // Extra diagnostic text the registry attached, beyond the one-line message.
  reasons() {
    return this.response ? this.response.errorReasons() : [];
  }
}

// The LOGIN failed (2200) — bad clID or password. Distinct from AuthorizationError, where the
// session is fine and one object is out of reach.
class AuthError extends CommandError {
  constructor(eppCode, message, response = null) {
    super(eppCode, message, response);
    this.name = 'AuthError';
  }
}

// The account cannot pay for this operation (2104). Worth its own catch: nothing is wrong with the
// request, and every later billable command fails the same way until the balance is topped up. A
// batch that treats this like any other error grinds through its queue producing identical
// failures. Stop, alert whoever funds the account, resume afterwards.
class InsufficientFundsError extends CommandError {
  constructor(eppCode, message, response = null) {
    super(eppCode, message, response);
    this.name = 'InsufficientFundsError';
  }
}

// The object exists, but not for you (2201 / 2202): it belongs to another registrar, or the
// authInfo does not match. Never retry with the same credentials.
class AuthorizationError extends CommandError {
  constructor(eppCode, message, response = null) {
    super(eppCode, message, response);
    this.name = 'AuthorizationError';
  }
}

// Already registered (2302). Not a fault in your request, and retrying cannot help.
class ObjectExistsError extends CommandError {
  constructor(eppCode, message, response = null) {
    super(eppCode, message, response);
    this.name = 'ObjectExistsError';
  }
}

// No such name, handle or nameserver (2303). Usually a stale identifier or a typo.
class ObjectDoesNotExistError extends CommandError {
  constructor(eppCode, message, response = null) {
    super(eppCode, message, response);
    this.name = 'ObjectDoesNotExistError';
  }
}

// The object's current state forbids the operation (2304 / 2305): a clientHold, a pending
// transfer, a nameserver still used by a domain. Clear what blocks you and the same request works.
class ObjectStatusError extends CommandError {
  constructor(eppCode, message, response = null) {
    super(eppCode, message, response);
    this.name = 'ObjectStatusError';
  }
}

// The registry's own rules refuse the value (2306 / 2308). The command is well-formed and you are
// allowed to send it; retrying is pointless until the request itself changes.
class PolicyError extends CommandError {
  constructor(eppCode, message, response = null) {
    super(eppCode, message, response);
    this.name = 'PolicyError';
  }
}

// The server is ending the session (2500 / 2501 / 2502). Reconnect and log in again; the command
// itself may be perfectly good.
class SessionError extends CommandError {
  constructor(eppCode, message, response = null) {
    super(eppCode, message, response);
    this.name = 'SessionError';
  }
}

// Builds the most specific error for a result code. One place decides, so the mapping cannot drift
// between the commands that use it.
function commandErrorFor(code, message, response = null) {
  const byCode = {
    [ResultCode.BILLING_FAILURE]: InsufficientFundsError,
    [ResultCode.AUTHORIZATION_ERROR]: AuthorizationError,
    [ResultCode.INVALID_AUTHORIZATION]: AuthorizationError,
    [ResultCode.OBJECT_EXISTS]: ObjectExistsError,
    [ResultCode.OBJECT_DOES_NOT_EXIST]: ObjectDoesNotExistError,
    [ResultCode.OBJECT_STATUS_PROHIBITS_OPERATION]: ObjectStatusError,
    [ResultCode.OBJECT_ASSOCIATION_PROHIBITS_OPERATION]: ObjectStatusError,
    [ResultCode.PARAMETER_VALUE_POLICY_ERROR]: PolicyError,
    [ResultCode.DATA_MANAGEMENT_POLICY_VIOLATION]: PolicyError,
    [ResultCode.COMMAND_FAILED_SERVER_CLOSING]: SessionError,
    [ResultCode.AUTHENTICATION_SERVER_CLOSING]: SessionError,
    [ResultCode.SESSION_LIMIT_EXCEEDED_SERVER_CLOSING]: SessionError,
  };
  const Cls = byCode[code] || CommandError;
  return new Cls(code, message, response);
}

module.exports = {
  EppError,
  ConnectionError,
  ConfigError,
  ValidationError,
  CommandError,
  AuthError,
  InsufficientFundsError,
  AuthorizationError,
  ObjectExistsError,
  ObjectDoesNotExistError,
  ObjectStatusError,
  PolicyError,
  SessionError,
  commandErrorFor,
};
