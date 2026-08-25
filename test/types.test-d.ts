// Type-level test: every accessor the README documents must compile against the shipped
// declarations. This file is never executed — `tsc --noEmit` is the assertion.
//
// It exists because the README once documented 38 response accessors that index.d.ts did not
// declare, so code copied verbatim out of our own guide failed to compile in a TypeScript project
// while every runtime test stayed green.

import {
  Client, Config, Contact, Response, Namespaces,
  DomainUpdateBuilder, DomainUpdateOptions,
  CommandError, ConfigError, ValidationError, InsufficientFundsError, AuthorizationError,
  ObjectExistsError, ObjectDoesNotExistError, ObjectStatusError, PolicyError, SessionError,
  HostAddress, PostalAddress, DiscloseInfo, TransferInfo, ExtValue, PendingActionData,
  SecurityEvent, Nameserver,
} from '..';

declare const r: Response;

// --- the README's "Reading an object without touching XML" block, line for line ---
const objectName: string | null = r.objectName();
const roid: string | null = r.roid();
const sponsor: string | null = r.sponsor();
const createdBy: string | null = r.createdBy();
const createdDate: string | null = r.createdDate();
const updatedBy: string | null = r.updatedBy();
const updatedDate: string | null = r.updatedDate();
const authInfo: string | null = r.authInfo();

const expiryDate: string | null = r.expiryDate();
const registrant: string | null = r.registrant();
const contacts: Record<string, string[]> = r.contacts();
const tech: string[] = r.techContacts();
const admin: string[] = r.adminContacts();
const billing: string[] = r.billingContacts();
const forRole: string[] = r.contactsFor('tech');
const all: string[] = r.allContacts();
const nameservers: string[] = r.nameservers();
const glue: Record<string, HostAddress[]> = r.nameserverAddresses();
const subordinate: string[] = r.subordinateHosts();
const transfer: TransferInfo | null = r.transfer();
const transferDate: string | null = r.transferDate();

const hostAddresses: HostAddress[] = r.hostAddresses();

const postal: Partial<Record<'int' | 'loc', PostalAddress>> = r.postalInfo();
const email: string | null = r.email();
const voice: string | null = r.voice();
const fax: string | null = r.fax();
const disclose: DiscloseInfo | null = r.disclose();

const available: boolean | null = r.isAvailable('example.com.ua');
const why: string | null = r.unavailableReason('taken.com.ua');
const premium: boolean = r.isPremium('rare.com.ua');
const feeClass: string | null = r.feeClass('rare.com.ua');
const creditLimit: string | null = r.creditLimit();
const currentBalance: string | null = r.currentBalance();
const availableCredit: string | null = r.availableCredit();
const feeAmount: string | null = r.feeAmount();
const feeCurrency: string | null = r.feeCurrency();
const extValues: ExtValue[] = r.extValues();
const pending: PendingActionData | null = r.pendingActionData();
const priceChannel: string | null = r.priceChannel();
const registrarOfRecord: string | null = r.registrarOfRecord();
const securityEvents: SecurityEvent[] = r.securityEvents();

// --- the README's quickstart, so the session surface is covered too ---
async function quickstart(): Promise<void> {
  const client = new Client(new Config({
    host: 'epp.registry.example',
    clid: 'EXAMPLE',
    password: 'your-secret',
    caFile: '/path/to/ca.pem',
    readTimeout: 30000,
    loginSecurity: true,
  }));
  await client.connect();
  await client.login();
  const check: Response = await client.domain.check(['example.com.ua']);
  const map: Record<string, boolean> = check.availability();
  await client.domain.create('example.com.ua', {
    years: 1,
    registrant: 'C1',
    contacts: { admin: 'C1', tech: ['T1', 'T2'] },
    nameservers: ['ns1.example.net'],
    authInfo: 'pw',
  });
  await client.logout();
  client.disconnect();
  void map;
}

// --- the builders and the error taxonomy, so both compile for a TypeScript consumer ---
async function builders(client: Client): Promise<void> {
  const created: Response = await client.domain.createBuilder('example3.com.ua')
    .years(1).registrant('C1')
    .adminContact('C1').techContact('T1', 'T2')
    .nameserver('ns1.example').nameservers('ns2.example', 'ns3.example')
    .authInfo('pw').license('TM-1')
    .dsRecord(12345, 8, 2, 'AB')
    .maxSigLife(604800)
    .maxFee('180.00', 'UAH')
    .send();

  const pending: DomainUpdateBuilder = client.domain.updateBuilder('example3.com.ua')
    .addNameserver('ns4.example').remStatus('clientHold').changeRegistrant('C2');
  const asOptions: DomainUpdateOptions = pending.toOptions();

  await client.contact.createBuilder('c1', 'contact@example.com')
    .internationalAddress({ name: 'ACME', city: 'Kyiv', countryCode: 'UA', street: ['1 Main St'] })
    .withhold('voice', 'email')
    .send();

  await client.contact.updateBuilder('c1')
    .changeInternationalAddress({ city: 'Lviv', countryCode: 'UA', org: '' })
    .addStatus('clientUpdateProhibited')
    .send();

  await client.host.updateBuilder('ns1.example').addAddress('192.0.2.1').send();

  // Inline glue: the option form and the builder step must both type-check.
  const glueHosts: Nameserver[] = [{ name: 'ns1.example.net', addresses: ['192.0.2.1'] }];
  await client.domain.create('glue.com.ua', { years: 1, nameservers: glueHosts });
  await client.domain.createBuilder('glue2.com.ua')
    .nameserverWithGlue('ns1.glue2.com.ua', '192.0.2.1', '2001:db8::1')
    .send();

  // A registry-minted contact handle, and the reserved id the request is spelled with.
  const minted: string | null = (await client.contact.createAuto({ email: 'contact@example.com' })).objectName();
  const reserved: string = Contact.AUTO_ID;

  void [created, asOptions, minted, reserved];
}

function errors(e: unknown): string {
  // The point of the taxonomy: each of these needs a different response.
  if (e instanceof InsufficientFundsError) return 'stop the batch and top up';
  if (e instanceof ObjectExistsError) return `taken: ${e.subject() ?? 'unknown'}`;
  if (e instanceof ObjectDoesNotExistError) return 'no such object';
  if (e instanceof AuthorizationError) return 'not yours, or the wrong authInfo';
  if (e instanceof ObjectStatusError) return 'clear the blocking status first';
  if (e instanceof PolicyError) return e.reasons().join('; ');
  if (e instanceof SessionError) return 'reconnect';
  if (e instanceof CommandError) return e.isRetryable() ? 'retry' : 'give up';
  if (e instanceof ValidationError) return 'fix the arguments';
  if (e instanceof ConfigError) return 'fix the deployment';
  return 'unknown';
}

// --- namespace discovery, as documented in commands.md ---
async function discovery(client: Client): Promise<void> {
  await client.connect();

  // Nullable on purpose: a registry that advertises no extension of its own is not an error, and a
  // declaration promising `string` would let `.length` through on a value that is null at run time.
  const ext: string | null = client.registryExtUri();
  const bal: string | null = client.registryBalanceUri();

  // The require* form is the one that cannot return null, because it throws instead.
  const required: string = client.requireRegistryExtUri('domain:create with a licence');

  const cfg = new Config({
    host: 'epp.registry.example',
    clid: 'EXAMPLE',
    password: 'secret',
    registryExtUri: 'urn:example:params:xml:ns:myreg-1.0',
    registryBalanceUri: 'urn:example:params:xml:ns:myreg-balance-1.0',
  });
  const configured: string | null = cfg.registryExtUri;

  const found: string | null = Namespaces.registryExtension(['urn:example:params:xml:ns:myreg-1.0']);
  const epp: string = Namespaces.EPP;
  const defaults: readonly string[] = Namespaces.DEFAULT_EXT_URIS;

  void [ext, bal, required, configured, found, epp, defaults];
}

// Reference every binding so noUnusedLocals stays available to callers of this file.
void [
  discovery,
  objectName, roid, sponsor, createdBy, createdDate, updatedBy, updatedDate, authInfo,
  expiryDate, registrant, contacts, tech, admin, billing, forRole, all, nameservers, glue,
  subordinate, transfer, transferDate, hostAddresses, postal, email, voice, fax, disclose,
  available, why, premium, feeClass, creditLimit, currentBalance, availableCredit, feeAmount,
  feeCurrency, extValues, pending, priceChannel, registrarOfRecord, securityEvents,
  quickstart, builders, errors,
];
