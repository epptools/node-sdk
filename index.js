'use strict';

// EppTools — EPP SDK for Node.js.
//
// A small, dependency-free client for the Registry EPP service — standard RFC 5730-5734
// EPP over TLS on port 700. Speaks the wire protocol directly (no framework, no server code).
//
//   const { Client, Config } = require('@epptools/sdk');
//   const client = new Client(new Config({ host: 'epp.registry.example', clid: 'YOUR-CLID', password: 'secret' }));
//   await client.connect();
//   await client.login();
//   console.log((await client.domain.check(['example.com.ua'])).availability());
//   await client.logout();
//   client.disconnect();

const Namespaces = require('./src/namespaces');
const { Client } = require('./src/client');
const { Config } = require('./src/config');
const { Frame } = require('./src/frame');
const { Response } = require('./src/response');
const { Connection } = require('./src/transport');
const { ResultCode } = require('./src/resultCode');
const { Domain, Contact, Host, Poll } = require('./src/commands');
const {
  DomainCreateBuilder, DomainUpdateBuilder, ContactCreateBuilder, ContactUpdateBuilder,
  HostUpdateBuilder,
} = require('./src/builders');
const {
  EppError, ConnectionError, ConfigError, ValidationError, CommandError, AuthError,
  InsufficientFundsError, AuthorizationError, ObjectExistsError, ObjectDoesNotExistError,
  ObjectStatusError, PolicyError, SessionError,
} = require('./src/errors');

module.exports = {
  Client,
  Config,
  Frame,
  Response,
  Connection,
  ResultCode,
  Namespaces,
  Domain,
  Contact,
  Host,
  Poll,
  DomainCreateBuilder,
  DomainUpdateBuilder,
  ContactCreateBuilder,
  ContactUpdateBuilder,
  HostUpdateBuilder,
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
};


