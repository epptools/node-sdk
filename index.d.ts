// Type definitions for EppTools — EPP SDK for Node.js.

export interface ConfigOptions {
  host: string;
  clid: string;
  password: string;
  port?: number;
  lang?: string;
  /** Handshake deadline in MILLISECONDS (default 10000). Minimum 1000. */
  connectTimeout?: number;
  /** Per-reply deadline in MILLISECONDS (default 30000). Minimum 1000. */
  readTimeout?: number;
  verifyPeer?: boolean;
  verifyPeerName?: boolean;
  caFile?: string | null;
  clientCert?: string | null;
  clientKey?: string | null;
  clientKeyPassphrase?: string | null;
  objUris?: string[] | null;
  extUris?: string[] | null;
  clTRIDPrefix?: string;
  /**
   * Override the registry's own extension namespaces. Null — the normal case — discovers them from
   * the <greeting>.
   *
   * Discovery matches the last segment of an advertised URI (`.../registry-1.0`, `.../balance-1.0`),
   * which is the convention registries follow but not a rule anybody enforces. A registry that names
   * its extension something else is served by setting the URI here; the greeting is then not
   * consulted.
   *
   * A wrong value is not a validation error, it is silence: an extension sent under a namespace the
   * server does not recognise is IGNORED, not rejected, so the licence or the price is simply absent
   * from what comes back and nothing says why.
   */
  registryExtUri?: string | null;
  registryBalanceUri?: string | null;
  /**
   * Take part in the Login Security extension (RFC 8807) when the server offers it (default true).
   * A server returns its security events — a certificate about to expire, an obsolete TLS version,
   * a weak cipher — only to a client that SENT the block, so turning this off means never hearing
   * the warning. Read what came back with Response.securityEvents().
   */
  loginSecurity?: boolean;
}

export class Config {
  constructor(opts: ConfigOptions);
  host: string;
  clid: string;
  password: string;
  port: number;
  lang: string;
  /** Milliseconds. */
  connectTimeout: number;
  /** Milliseconds. */
  readTimeout: number;
  verifyPeer: boolean;
  verifyPeerName: boolean;
  caFile: string | null;
  clientCert: string | null;
  clientKey: string | null;
  clientKeyPassphrase: string | null;
  objUris: string[] | null;
  extUris: string[] | null;
  clTRIDPrefix: string;
  registryExtUri: string | null;
  registryBalanceUri: string | null;
  loginSecurity: boolean;
}

/** One RFC 8807 login security event: what the server wants you to fix about this session. */
export interface SecurityEvent {
  type?: string;
  name?: string;
  level?: string;
  exDate?: string;
  value?: string;
  duration?: string;
  lang?: string;
  text: string;
}

export interface DsRecord { keyTag: number; alg: number; digestType: number; digest: string; }
export interface KeyRecord { flags: number; protocol: number; alg: number; pubKey: string; }
export interface BalanceInfo { creditLimit: string; balance: string; availableCredit: string; }
export interface PriceInfo { value: string; currency: string; }

export interface SecDnsCreate { dsData?: Partial<DsRecord>[]; keyData?: Partial<KeyRecord>[]; maxSigLife?: number; }
export interface SecDnsUpdate {
  add?: { dsData?: Partial<DsRecord>[]; keyData?: Partial<KeyRecord>[] };
  rem?: { dsData?: Partial<DsRecord>[]; keyData?: Partial<KeyRecord>[] };
  remAll?: boolean;
  maxSigLife?: number;
}

export interface PostalInfo {
  type?: 'int' | 'loc';
  name?: string;
  org?: string;
  street?: string[];
  city?: string;
  sp?: string;
  pc?: string;
  cc?: string;
}

export interface Disclose {
  flag?: boolean;
  name?: Array<'int' | 'loc'>;
  org?: Array<'int' | 'loc'>;
  addr?: Array<'int' | 'loc'>;
  voice?: boolean;
  fax?: boolean;
  email?: boolean;
}

/** The RFC 8748 fee you agree to pay on a transform: '100.00' or { amount, currency }.
 *  The server refuses (2004) when the real price is higher — never overcharged. */
export type FeeAgreement = string | { amount: string; currency?: string };

/** fee:check query riding a domain check: operation => years, e.g. { create: 1, renew: 1 }. */
/** A list asks the same operation at several periods: { create: [1, 2, 5] }. At most 20 entries. */
export type FeeQuery = Partial<Record<'create' | 'renew' | 'transfer' | 'restore' | 'update' | 'delete', number | number[]>>;

export interface FeeCommandResult {
  years: number;
  fee: string | null;
  reason?: string;
}

/** One quote from a fee:check, in the order the registry returned it. */
export interface FeeQuote { op: string; years: number; fee: string | null; reason?: string; }

export interface FeeNameResult {
  avail: boolean;
  class?: string;
  reason: string | null;
  /** First result per operation. Ambiguous for a multi-period ask — read periods instead. */
  commands: Record<string, FeeCommandResult>;
  /** Every quote in wire order; the place to read a multi-period ask. */
  periods: FeeQuote[];
}

/** fees() result: '_currency' plus one FeeNameResult per checked name. */
export type FeesResult = { _currency?: string } & Record<string, FeeNameResult | string | undefined>;

/**
 * A nameserver is either a name — a host object the registry already holds — or that name together
 * with its glue addresses, inlined in the command. One command uses one model, never both.
 */
export type Nameserver = string | { name: string; addresses?: string[] };

export interface DomainCreateOptions {
  years?: number;
  registrant?: string;
  /** One handle per role, or several: { admin: 'A1', tech: ['T1', 'T2'] }. */
  contacts?: Record<string, string | string[]>;
  nameservers?: Nameserver[];
  authInfo?: string;
  license?: string;
  secDNS?: SecDnsCreate;
  fee?: FeeAgreement;
}

export interface DomainUpdateOptions {
  add?: { ns?: Nameserver[]; contacts?: Record<string, string | string[]>; statuses?: string[] };
  rem?: { ns?: Nameserver[]; contacts?: Record<string, string | string[]>; statuses?: string[] };
  chg?: { registrant?: string; authInfo?: string; clearAuthInfo?: boolean };
  restore?: boolean;
  license?: string;
  secDNS?: SecDnsUpdate;
  fee?: FeeAgreement;
}

export interface ContactCreateOptions extends PostalInfo {
  postalInfos?: PostalInfo[];
  voice?: string;
  fax?: string;
  email: string;
  authInfo?: string;
  disclose?: Disclose;
}

export interface ContactUpdateOptions {
  addStatuses?: string[];
  remStatuses?: string[];
  chg?: {
    postalInfo?: PostalInfo;
    postalInfos?: PostalInfo[];
    voice?: string;
    fax?: string;
    email?: string;
    authInfo?: string;
    disclose?: Disclose;
  };
}

export interface HostUpdateOptions {
  addAddresses?: string[];
  remAddresses?: string[];
  addStatuses?: string[];
  remStatuses?: string[];
  /**
   * @deprecated NOT SUPPORTED — this registry ignores `host:chg`, so passing it throws
   * ValidationError rather than sending a frame whose rename half is discarded without comment.
   * Create the new host, re-point the domains with domain:update, then delete the old one.
   */
  newName?: never;
}

export type TransferOp = 'request' | 'approve' | 'reject' | 'cancel' | 'query';

/** One glue address of a host, or of a nameserver inlined in a domain. */
export interface HostAddress {
  ip: string;
  /** Taken from the wire's @ip; 'v4' when the registry omitted the attribute, as the schema allows. */
  version: 'v4' | 'v6' | (string & {});
}

/**
 * One postal form as the registry RETURNED it. Distinct from `PostalInfo`, which describes what you
 * SEND: every field here is present (empty string when the registry sent nothing) and there is no
 * `type` member, because the form is the key of the map.
 */
export interface PostalAddress {
  name: string;
  org: string;
  street: string[];
  city: string;
  sp: string;
  pc: string;
  cc: string;
}

/**
 * A contact's disclosure preference as RETURNED. `elements` holds local names, suffixed `:int` or
 * `:loc` where the form matters. Distinct from `Disclose`, which is the shape you send.
 */
export interface DiscloseInfo {
  flag: boolean;
  elements: string[];
}

/** A transfer in progress: who asked, when, who must answer, and by when it auto-resolves. */
export interface TransferInfo {
  status: string;
  requestedBy: string;
  requestedAt: string;
  actingClient: string;
  actBy: string;
  expiryDate: string;
}

/**
 * What a registry did to one of your objects without you asking (RFC 8590 change poll).
 *
 * `state` says which way the accompanying object reads: `'before'` describes it as it last was — a
 * domain that no longer exists cannot be described any other way — and `'after'` as it now is.
 * `who` is free text for audit and the server chooses what to put there; `'Registry'` means the
 * change came from the registry side rather than from your account.
 * `op` qualifies a `'custom'` operation with the registry's own verb and is `''` otherwise.
 */
export interface ChangeInfo {
  operation: string;
  op: string;
  state: 'before' | 'after' | string;
  date: string;
  svTRID: string;
  who: string;
  reason: string;
}

/** One `<extValue>` from a failed command: which element the registry objected to, and why. */
export interface ExtValue {
  element: string;
  namespace: string;
  /** The element's own character data — empty for a container; read `values` in that case. */
  text: string;
  values: Record<string, string>;
  /** The element as it arrived, if you would rather re-parse it yourself. */
  xml: string;
  reason: string;
  lang: string;
}

/** The outcome of an offline operation, delivered later through the poll queue. */
export interface PendingActionData {
  object: string;
  success: boolean;
  clTRID: string | null;
  svTRID: string | null;
  date: string | null;
}

export class Response {
  static fromXml(xml: string): Response;
  code(): number;
  message(): string | null;
  messageLang(): string | null;
  isSuccess(): boolean;
  isPending(): boolean;
  isGreeting(): boolean;
  clTRID(): string | null;
  svTRID(): string | null;
  availability(): Record<string, boolean>;
  messageId(): string | null;
  messageCount(): number;
  /** Poll: the QUEUED NOTICE text (<msgQ><msg>) — NOT message(), which is the result banner. */
  queueMessage(): string | null;
  queueMessageLang(): string | null;
  queueDate(): string | null;
  statuses(): string[];
  balance(): BalanceInfo | null;
  prices(): Record<string, PriceInfo>;
  fees(): FeesResult;
  chargedFee(): { currency: string; fee: string } | null;
  license(): string | null;
  rgpStatus(): string[];
  transferStatus(): string | null;
  dsRecords(): DsRecord[];
  keyRecords(): KeyRecord[];
  isSigned(): boolean;
  errorReasons(): string[];
  /**
   * Login only: the server's security warnings about this session (RFC 8807). Empty when the
   * session is healthy, so treat any entry as something to act on.
   */
  securityEvents(): SecurityEvent[];
  /** The opaque price-channel id this domain is billed on; matches the published catalogue. */
  priceChannel(): string | null;
  /** The registrar of record at the registry, when it is not you. Compare with sponsor(). */
  registrarOfRecord(): string | null;
  serviceObjUris(): string[];
  serviceExtUris(): string[];
  value(local: string): string | null;
  values(local: string): string[];
  resData(): unknown;
  raw(): string;
  root(): unknown;

  // --- reading an object without touching XML --------------------------------
  /** The outcome of an offline operation; null when this is not a pending-action notice. */
  pendingActionData(): PendingActionData | null;
  /** The domain name, the host name or the contact HANDLE. */
  objectName(): string | null;
  /** Dates come back as the registry's own string, never a Date — see the README. */
  expiryDate(): string | null;
  createdDate(): string | null;
  updatedDate(): string | null;
  roid(): string | null;
  registrant(): string | null;
  /** clID — the registrar the object belongs to now. */
  sponsor(): string | null;
  createdBy(): string | null;
  updatedBy(): string | null;
  transferDate(): string | null;
  transfer(): TransferInfo | null;
  /** RFC 8590: what the registry did to this object, or null when the notice carries no change block. */
  change(): ChangeInfo | null;
  /** Names, whether the registry answered with hostObj or hostAttr. */
  nameservers(): string[];
  /** hostAttr glue keyed by nameserver name; empty for a hostObj registry. */
  nameserverAddresses(): Record<string, HostAddress[]>;
  /** Hosts living UNDER this domain — they block a delete. */
  subordinateHosts(): string[];
  hostAddresses(): HostAddress[];
  contacts(): Record<string, string[]>;
  /** Matched case-insensitively; empty when nobody holds the role. */
  contactsFor(role: string): string[];
  adminContacts(): string[];
  techContacts(): string[];
  billingContacts(): string[];
  allContacts(): string[];
  /** The transfer secret. Never log it. */
  authInfo(): string | null;
  disclose(): DiscloseInfo | null;
  email(): string | null;
  voice(): string | null;
  fax(): string | null;
  /** Only the forms the registry actually sent; a contact commonly carries just one. */
  postalInfo(): Partial<Record<'int' | 'loc', PostalAddress>>;
  /** null means the answer said nothing about that name — which is not "taken". */
  isAvailable(name: string): boolean | null;
  unavailableReason(name: string): string | null;
  /** The quoted price for one operation at one period; null when no such quote came back. */
  feeFor(name: string, operation: string, years?: number): string | null;
  feeClass(name?: string): string | null;
  isPremium(name?: string): boolean;
  /** Money comes back as an exact decimal string, never a number — see the README. */
  creditLimit(): string | null;
  currentBalance(): string | null;
  availableCredit(): string | null;
  feeAmount(): string | null;
  feeCurrency(): string | null;
  extValues(): ExtValue[];
}

/** A postal form as SENT on a builder. `int` is ASCII; `loc` is the local script. */
export interface AddressParts {
  name: string;
  city: string;
  countryCode: string;
  street?: string[];
  org?: string | null;
  stateProvince?: string | null;
  postalCode?: string | null;
}

/**
 * A postal form as CHANGED on an update builder. Every field is optional, because presence is what
 * the registry reads: a field you leave out keeps its value, and a field given as '' is cleared.
 * The block still needs its city and country whenever you touch it — the schema makes them
 * required there — which the server enforces, not this type.
 */
export type AddressChanges = Partial<AddressParts>;

/** A field a contact can publish or withhold. */
export type DisclosableField = 'name' | 'org' | 'addr' | 'voice' | 'fax' | 'email';

/**
 * Assembles a command one named step at a time and sends it with send(). Nothing reaches the
 * registry until then; toOptions() shows what would be sent. Every list method ACCUMULATES.
 */
export class DomainCreateBuilder {
  years(years: number): this;
  registrant(handle: string): this;
  contact(role: string, ...handles: string[]): this;
  adminContact(...handles: string[]): this;
  techContact(...handles: string[]): this;
  billingContact(...handles: string[]): this;
  nameserver(host: string): this;
  nameservers(...hosts: string[]): this;
  /** A nameserver with its glue addresses inlined (hostAttr). Do not mix with nameserver(). */
  nameserverWithGlue(host: string, ...addresses: string[]): this;
  authInfo(password: string): this;
  license(number: string): this;
  /** The most you agree to pay (RFC 8748) — a cap, not a price you set. */
  maxFee(amount: string, currency?: string | null): this;
  dsRecord(keyTag: number, alg: number, digestType: number, digest: string): this;
  /** A DS record carrying the DNSKEY it was computed from, so the registry can verify the digest. */
  dsRecordWithKey(
    keyTag: number, alg: number, digestType: number, digest: string,
    flags: number, protocol: number, keyAlg: number, pubKey: string,
  ): this;
  keyRecord(flags: number, protocol: number, alg: number, pubKey: string): this;
  maxSigLife(seconds: number): this;
  toOptions(): DomainCreateOptions;
  send(): Promise<Response>;
}

export class DomainUpdateBuilder {
  addNameserver(host: string): this;
  addNameservers(...hosts: string[]): this;
  remNameserver(host: string): this;
  remNameservers(...hosts: string[]): this;
  addContact(role: string, ...handles: string[]): this;
  remContact(role: string, ...handles: string[]): this;
  addStatus(...statuses: string[]): this;
  remStatus(...statuses: string[]): this;
  changeRegistrant(handle: string): this;
  changeAuthInfo(password: string): this;
  /** REMOVE the transfer secret (<authInfo><null/>). Not the same as setting an empty one. */
  clearAuthInfo(): this;
  restore(): this;
  license(number: string): this;
  maxFee(amount: string, currency?: string | null): this;
  addDsRecord(keyTag: number, alg: number, digestType: number, digest: string): this;
  remDsRecord(keyTag: number, alg: number, digestType: number, digest: string): this;
  addKeyRecord(flags: number, protocol: number, alg: number, pubKey: string): this;
  remKeyRecord(flags: number, protocol: number, alg: number, pubKey: string): this;
  /** Unsign entirely. Cannot be combined with removing named records. */
  removeAllDnssec(): this;
  maxSigLife(seconds: number): this;
  toOptions(): DomainUpdateOptions;
  send(): Promise<Response>;
}

export class ContactCreateBuilder {
  internationalAddress(parts: AddressParts): this;
  localizedAddress(parts: AddressParts): this;
  voice(number: string): this;
  fax(number: string): this;
  authInfo(password: string): this;
  publish(...fields: DisclosableField[]): this;
  withhold(...fields: DisclosableField[]): this;
  toOptions(): ContactCreateOptions;
  send(): Promise<Response>;
}

export class ContactUpdateBuilder {
  /**
   * Change part of the international form. PRESENCE decides: a field you leave out keeps its
   * value, a field you give is set, and a field given as '' is CLEARED (the only way to remove
   * org, sp or pc). The other form is untouched. The address block is a sequence with a required
   * city and country, so send city and countryCode whenever you touch street, sp or pc.
   */
  changeInternationalAddress(parts: AddressChanges): this;
  /** As changeInternationalAddress(), for the localized form. */
  changeLocalizedAddress(parts: AddressChanges): this;
  changeVoice(number: string): this;
  changeFax(number: string): this;
  changeEmail(email: string): this;
  changeAuthInfo(password: string): this;
  publish(...fields: DisclosableField[]): this;
  withhold(...fields: DisclosableField[]): this;
  addStatus(...statuses: string[]): this;
  remStatus(...statuses: string[]): this;
  toOptions(): ContactUpdateOptions;
  send(): Promise<Response>;
}

export class HostUpdateBuilder {
  addAddress(ip: string): this;
  addAddresses(...ips: string[]): this;
  remAddress(ip: string): this;
  remAddresses(...ips: string[]): this;
  addStatus(...statuses: string[]): this;
  remStatus(...statuses: string[]): this;
  toOptions(): HostUpdateOptions;
  send(): Promise<Response>;
}

export class Domain {
  check(names: string[], fee?: FeeQuery | null, currency?: string | null): Promise<Response>;
  /** `hosts` picks which hosts the answer lists: all (default), del, sub or none. */
  info(name: string, authInfo?: string | null, hosts?: 'all' | 'del' | 'sub' | 'none'): Promise<Response>;
  createBuilder(name: string): DomainCreateBuilder;
  updateBuilder(name: string): DomainUpdateBuilder;
  create(name: string, opts?: DomainCreateOptions): Promise<Response>;
  update(name: string, opts?: DomainUpdateOptions): Promise<Response>;
  renew(name: string, curExpDate: string, years?: number, fee?: FeeAgreement | null): Promise<Response>;
  delete(name: string): Promise<Response>;
  restore(name: string, fee?: FeeAgreement | null): Promise<Response>;
  transfer(op: TransferOp, name: string, authInfo?: string | null, years?: number | null, fee?: FeeAgreement | null): Promise<Response>;
}

export class Contact {
  /**
   * The reserved id that asks the registry to CHOOSE the handle instead of you naming it. The
   * minted handle comes back in the response and nowhere else, so store objectName().
   */
  static readonly AUTO_ID: string;
  check(ids: string[]): Promise<Response>;
  info(id: string, authInfo?: string | null): Promise<Response>;
  /** Pass Contact.AUTO_ID as the id to have the registry mint the handle. */
  createBuilder(id: string, email: string): ContactCreateBuilder;
  updateBuilder(id: string): ContactUpdateBuilder;
  create(id: string, opts: ContactCreateOptions): Promise<Response>;
  /** Create a contact under a registry-minted handle; read it back with objectName(). */
  createAuto(opts?: ContactCreateOptions): Promise<Response>;
  update(id: string, opts?: ContactUpdateOptions): Promise<Response>;
  delete(id: string): Promise<Response>;
  transfer(op: TransferOp, id: string, authInfo?: string | null): Promise<Response>;
}

export class Host {
  check(names: string[]): Promise<Response>;
  info(name: string): Promise<Response>;
  updateBuilder(name: string): HostUpdateBuilder;
  create(name: string, addresses?: string[]): Promise<Response>;
  update(name: string, opts?: HostUpdateOptions): Promise<Response>;
  delete(name: string, force?: boolean): Promise<Response>;
}

export class Poll {
  request(): Promise<Response>;
  /** Acknowledging DELETES the notice at the registry. There is no way to get it back. */
  ack(messageId: string): Promise<Response>;
  /**
   * Read the queue to the end, acknowledging each notice only AFTER the handler resolves.
   * If the handler rejects, the notice is left in the queue and the rejection reaches you.
   * `limit` of 0 means "until the queue is empty".
   */
  drain(handler: (notice: Response) => void | Promise<void>, limit?: number): Promise<number>;
}

export interface Logger {
  debug?(message: string): void;
  info?(message: string): void;
  warn?(message: string): void;
  log?(message: string): void;
}

export interface Transport {
  open(): Promise<void>;
  isOpen(): boolean;
  writeFrame(xml: string): Promise<void>;
  readFrame(): Promise<string>;
  close(): void;
}

export class Frame {
  static command(clTRID: string): Frame;
  verb(name: string): unknown;
  extension(): unknown;
  epp(parent: unknown, name: string, text?: string | null, attrs?: Record<string, unknown>): unknown;
  ns(parent: unknown, nsUri: string, qname: string, text?: string | null, attrs?: Record<string, unknown>): unknown;
  toXml(): string;
}

export class Connection implements Transport {
  constructor(config: Config);
  open(): Promise<void>;
  isOpen(): boolean;
  writeFrame(xml: string): Promise<void>;
  readFrame(): Promise<string>;
  close(): void;
}

export class Client {
  constructor(config: Config, connection?: Transport | null, logger?: Logger | null);
  static connectAndLogin(config: Config): Promise<Client>;
  throwOnFailure(value?: boolean): this;
  setLogger(logger: Logger | null): this;
  connect(): Promise<Response>;
  readonly greeting: Response | null;
  hello(): Promise<Response>;
  login(newPassword?: string | null): Promise<Response>;
  logout(): Promise<Response>;
  disconnect(): void;
  isConnected(): boolean;
  isLoggedIn(): boolean;
  readonly domain: Domain;
  readonly contact: Contact;
  readonly host: Host;
  readonly poll: Poll;
  /**
   * The namespace this registry uses for its own object extensions, or null if it advertises none.
   * Configured value first, otherwise read out of the greeting — so it is null until connect().
   */
  registryExtUri(): string | null;
  /** The namespace this registry uses for account balance, or null if it advertises none. */
  registryBalanceUri(): string | null;
  /**
   * The registry extension namespace, or a ConfigError explaining why there isn't one. Used by the
   * commands that cannot work without it, because the alternative to failing here is failing
   * invisibly: an extension the server does not recognise is ignored, not rejected.
   */
  requireRegistryExtUri(what: string): string;
  /** Throws ConfigError when the server advertises no balance extension. */
  balance(): Promise<Response>;
  frame(): Frame;
  request(frame: Frame | string): Promise<Response>;
}

export class EppError extends Error {}
export class ConnectionError extends EppError {}

/** This client is set up wrong — no host, no credentials. Every call fails until it is fixed. */
export class ConfigError extends EppError {}

/** A value passed to THIS call cannot be used; nothing was sent. The next call can be fine. */
export class ValidationError extends EppError {}

export class CommandError extends EppError {
  eppCode: number;
  response: Response | null;
  /** True only for failures about the moment rather than the request (2400, 2500–2502). */
  isRetryable(): boolean;
  /** The object the registry objected to, when it named one. */
  subject(): string | null;
  /** Extra diagnostic text beyond the one-line message. */
  reasons(): string[];
}

/** The LOGIN failed (2200). */
export class AuthError extends CommandError {}
/** The account cannot pay (2104): stop the batch, top up, resume. */
export class InsufficientFundsError extends CommandError {}
/** Not yours, or the wrong authInfo (2201 / 2202). */
export class AuthorizationError extends CommandError {}
/** Already registered (2302). */
export class ObjectExistsError extends CommandError {}
/** No such name, handle or nameserver (2303). */
export class ObjectDoesNotExistError extends CommandError {}
/** A status or association is in the way (2304 / 2305). */
export class ObjectStatusError extends CommandError {}
/** The registry's own rules refuse this value (2306 / 2308). */
export class PolicyError extends CommandError {}
/** The server is ending the session (2500–2502): reconnect and log in again. */
export class SessionError extends CommandError {}

export const ResultCode: Readonly<Record<string, number>>;

/**
 * The EPP namespace URIs, and the two functions that find a registry's own.
 *
 * Every constant here is defined by an RFC and is the same string at every registry on earth. A
 * registry's OWN extensions are not, so there is no constant for them — they are discovered from the
 * <greeting>, which is what `Client.registryExtUri()` does for you.
 */
export const Namespaces: Readonly<{
  EPP: string;
  XSI: string;
  DOMAIN: string;
  CONTACT: string;
  HOST: string;
  SECDNS: string;
  RGP: string;
  FEE: string;
  LOGINSEC: string;
  /** The reserved <pw> value meaning "the real password is in <loginSec:pw>" (RFC 8807). */
  LOGINSEC_SENTINEL: string;
  /** The object services announced at login when the greeting listed none. */
  DEFAULT_OBJ_URIS: readonly string[];
  /** The extension services announced at login when the greeting listed none. RFC-defined only. */
  DEFAULT_EXT_URIS: readonly string[];
  /** The registry's own object extension among the URIs it advertised, or null. */
  registryExtension(advertised: readonly string[]): string | null;
  /** The registry's account-balance extension among the URIs it advertised, or null. */
  registryBalance(advertised: readonly string[]): string | null;
}>;
