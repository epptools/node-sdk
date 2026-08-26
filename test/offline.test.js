'use strict';

// Offline self-test: exercises frame building and response parsing with a fake in-memory
// transport — no server, no network. Run: node test/offline.test.js

const { Client, Config, Response, Namespaces, Frame, Connection, Contact } = require('..');
const {
  CommandError, AuthError, ConfigError, ConnectionError, ValidationError,
  InsufficientFundsError, AuthorizationError, ObjectExistsError, ObjectDoesNotExistError,
  ObjectStatusError, PolicyError, SessionError,
} = require('..');
const { parseXml } = require('../src/xml');

let passed = 0;
let failed = 0;
function check(label, ok) {
  console.log((ok ? '  ok  ' : ' FAIL ') + label);
  if (ok) passed += 1; else failed += 1;
}

class FakeTransport {
  constructor() { this.written = []; this.queue = []; this._open = false; }
  async open() { this._open = true; }
  isOpen() { return this._open; }
  async writeFrame(xml) { this.written.push(xml); }
  async readFrame() {
    if (!this.queue.length) throw new Error('FakeTransport: no queued response');
    const frame = this.queue.shift();
    // A real server echoes back the clTRID it was sent, and the client refuses a reply that does
    // not. A fixture with a fixed clTRID would make every test fail that check for the wrong
    // reason — or, if the check were relaxed to suit the fixture, would stop testing it at all.
    const sent = this.written.length
      ? /<clTRID>([^<]*)<\/clTRID>/.exec(this.written[this.written.length - 1])
      : null;
    return sent ? frame.replace(/<clTRID>[^<]*<\/clTRID>/, `<clTRID>${sent[1]}</clTRID>`) : frame;
  }
  close() { this._open = false; }
}

// The extension namespaces of the fictional registry these fixtures simulate.
//
// They are NOT constants of the library, and there is no equivalent there to compare them against:
// the library knows the RFC namespaces and discovers a registry's own from its <greeting>. So these
// belong to the fixture, the way a hostname or a password in a fixture does.
//
// Deliberately a registry no version of this code has ever named. A fixture written with the URIs
// the library used to hard-code would keep passing if discovery quietly regressed to a constant —
// the strings would still line up — and would prove only that the code agrees with itself. Under a
// URI that appears nowhere in src/, these tests can pass only by actually reading the greeting.
const EXT_REGISTRY = 'http://registry.example/epp/registry-1.0';
const EXT_BALANCE = 'http://registry.example/epp/balance-1.0';

const GREETING = '<?xml version="1.0" encoding="UTF-8"?><epp xmlns="urn:ietf:params:xml:ns:epp-1.0"><greeting>'
  + '<svID>Registry EPP</svID><svDate>2026-07-04T00:00:00Z</svDate><svcMenu><version>1.0</version>'
  + '<lang>en</lang><lang>uk</lang>'
  + '<objURI>urn:ietf:params:xml:ns:contact-1.0</objURI><objURI>urn:ietf:params:xml:ns:domain-1.0</objURI>'
  + '<objURI>urn:ietf:params:xml:ns:host-1.0</objURI>'
  + '<svcExtension><extURI>urn:ietf:params:xml:ns:secDNS-1.1</extURI><extURI>urn:ietf:params:xml:ns:rgp-1.0</extURI>'
  + '<extURI>http://registry.example/epp/registry-1.0</extURI><extURI>http://registry.example/epp/balance-1.0</extURI>'
  + '</svcExtension></svcMenu></greeting></epp>';

function OK(code = 1000, msg = 'ok', lang = 'en') {
  return '<?xml version="1.0"?><epp xmlns="urn:ietf:params:xml:ns:epp-1.0"><response>'
    + `<result code="${code}"><msg lang="${lang}">${msg}</msg></result>`
    + '<trID><clTRID>C1</clTRID><svTRID>SRV-1</svTRID></trID></response></epp>';
}

function makeClient(responses, password = 'secret', opts = {}) {
  const fake = new FakeTransport();
  fake.queue = responses.slice();
  const client = new Client(new Config({ host: 'epp.example', clid: 'EXAMPLE', password, ...opts }), fake);
  return { client, fake };
}

// --- request-frame inspection helpers (namespace-agnostic) ---
function* walk(node) { yield node; for (const c of node.children) yield* walk(c); }
function allLocal(root, name) { return [...walk(root)].filter((n) => n.local === name); }
function firstLocal(root, name) { for (const n of walk(root)) if (n.local === name) return n; return null; }
function textOf(root, name) { const n = firstLocal(root, name); return n ? n.text : null; }
function parse(xml) { return parseXml(xml); }

async function main() {
  // ------------------------------------------------------------------ session
  console.log('session: connect + login (services from greeting)');
  {
    const { client, fake } = makeClient([GREETING, OK()]);
    const greeting = await client.connect();
    check('greeting parsed', greeting.isGreeting());
    check('greeting objURIs', greeting.serviceObjUris().includes('urn:ietf:params:xml:ns:domain-1.0'));
    await client.login();
    const lf = parse(fake.written[0]);
    check('login clID', textOf(lf, 'clID') === 'EXAMPLE');
    check('login pw', textOf(lf, 'pw') === 'secret');
    check('login version 1.0', textOf(lf, 'version') === '1.0');
    check('login advertises domain objURI', allLocal(lf, 'objURI').some((e) => e.text === Namespaces.DOMAIN));
    check('login advertises balance extURI', allLocal(lf, 'extURI').some((e) => e.text === EXT_BALANCE));
    check('login omits the epp base URI', allLocal(lf, 'objURI').every((e) => e.text !== Namespaces.EPP));
  }

  console.log('session: namespace discovery from the greeting');
  {
    const { client } = makeClient([GREETING]);
    await client.connect();
    check('registry extension discovered', client.registryExtUri() === EXT_REGISTRY);
    check('balance extension discovered', client.registryBalanceUri() === EXT_BALANCE);
  }
  {
    // Discovery must key on the last segment and nothing else: a registry's URI can be any string,
    // and the only part of it this library is entitled to assume is the extension's name.
    const odd = GREETING
      .replace(EXT_REGISTRY, 'https://epp.other.example/xml/schemas/registry-1.2')
      .replace(EXT_BALANCE, 'urn:example:other:balance');
    const { client } = makeClient([odd]);
    await client.connect();
    check('a differently-shaped registry URI is found', client.registryExtUri() === 'https://epp.other.example/xml/schemas/registry-1.2');
    check('a non-http registry URI is found too', client.registryBalanceUri() === 'urn:example:other:balance');
  }
  {
    // RFC extensions are skipped by prefix, and this is the case that makes it necessary: fee-1.0 is
    // an IETF extension whose last segment would match a search for an extension named "fee".
    const feeOnly = GREETING.replace(
      `<extURI>${EXT_REGISTRY}</extURI><extURI>${EXT_BALANCE}</extURI>`,
      '<extURI>urn:ietf:params:xml:ns:epp:fee-1.0</extURI>',
    );
    const { client } = makeClient([feeOnly]);
    await client.connect();
    check('a registry advertising no extension of its own reports none', client.registryExtUri() === null);
    check('and no balance extension either', client.registryBalanceUri() === null);

    // Absence must be REPORTED, not guessed around. Sending an invented URI would not be rejected —
    // an extension the server does not recognise is ignored — so the licence would silently not be
    // set.
    let threw = null;
    try { client.requireRegistryExtUri('domain:create with a licence'); } catch (e) { threw = e; }
    check('asking for a missing extension throws ConfigError', threw instanceof ConfigError);
    check('and the message says what was wanted', threw != null && threw.message.includes('domain:create with a licence'));
    check('and lists what the server did advertise', threw != null && threw.message.includes('urn:ietf:params:xml:ns:epp:fee-1.0'));

    let threwBal = null;
    try { client.balance(); } catch (e) { threwBal = e; }
    check('balance() refuses when the server offers no balance extension', threwBal instanceof ConfigError);
  }
  {
    // The config override exists for a registry that names its extension something discovery cannot
    // guess. It must win outright — including over a greeting that advertises a different URI.
    const { client } = makeClient([GREETING], 'secret', {
      registryExtUri: 'urn:example:custom:registry',
      registryBalanceUri: 'urn:example:custom:balance',
    });
    await client.connect();
    check('a configured registry URI overrides the greeting', client.registryExtUri() === 'urn:example:custom:registry');
    check('a configured balance URI overrides the greeting', client.registryBalanceUri() === 'urn:example:custom:balance');
  }
  {
    // Before connect() there is no greeting. Discovery must return null rather than fail, so that a
    // caller who set the URIs in config can work without ever reading one.
    const { client } = makeClient([]);
    check('no greeting read yet discovers nothing', client.registryExtUri() === null);
  }

  console.log('session: password rotation via newPW');
  {
    const { client, fake } = makeClient([GREETING, OK()]);
    await client.connect();
    await client.login('new-secret-1');
    check('login carries newPW', textOf(parse(fake.written[0]), 'newPW') === 'new-secret-1');
  }

  console.log('clTRID format: prefix-timestamp-pid-counter');
  {
    const { client, fake } = makeClient([GREETING, OK(), OK()]);
    await client.connect();
    await client.domain.check(['example1.com.ua']);
    await client.domain.check(['example2.com.ua']);
    const t1 = firstLocal(parse(fake.written[0]), 'clTRID').text;
    const t2 = firstLocal(parse(fake.written[1]), 'clTRID').text;
    check('clTRID shape NODEJS-SDK-<ts>-<pid>-0001', /^NODEJS-SDK-\d{14}-\d+-0001$/.test(t1));
    check('clTRID counter increments', t2.endsWith('-0002'));
    check('clTRID pid stable across a session', t1.split('-').slice(-2)[0] === t2.split('-').slice(-2)[0]);
  }

  // ------------------------------------------------------------------- domain
  console.log('domain: check / info / create');
  {
    const { client, fake } = makeClient([GREETING, OK(), OK(), OK()]);
    await client.connect();
    await client.domain.check(['example3.com.ua', 'y.com.ua']);
    const dc = parse(fake.written[0]);
    check('domain:check has 2 names', allLocal(dc, 'name').length === 2);
    check('domain:check carries the domain prefix + xmlns',
      [...walk(dc)].some((e) => e.name === 'domain:check') && fake.written[0].includes(`xmlns:domain="${Namespaces.DOMAIN}"`));

    await client.domain.info('example3.com.ua', 'authpw', 'all');
    const di = parse(fake.written[1]);
    check('domain:info hosts attr', firstLocal(di, 'name').attrs.hosts === 'all');
    check('domain:info authInfo pw', textOf(di, 'pw') === 'authpw');

    await client.domain.create('example3.com.ua', {
      // 'tech' as an ARRAY: RFC 5731 allows repeated <domain:contact type=…> and the registry
      // parses a list per role. A plain Object.entries() loop stringified it into ONE element.
      years: 1, registrant: 'REG1', contacts: { admin: 'ADM1', tech: ['TEC1', 'TEC2'] },
      nameservers: ['ns1.example.net', 'ns2.example.net'], authInfo: 'secret1', license: 'TM-1',
      secDNS: { dsData: [{ keyTag: 12345, alg: 8, digestType: 2, digest: 'AB'.repeat(32) }] },
    });
    const cr = parse(fake.written[2]);
    check('create period unit=y', firstLocal(cr, 'period').attrs.unit === 'y');
    check('create 2 hostObj', allLocal(cr, 'hostObj').length === 2);
    check('create emits 3 contacts (admin + BOTH tech handles)', allLocal(cr, 'contact').length === 3);
    check('create second tech handle is a real element, not a stringified array',
      allLocal(cr, 'contact').some((e) => e.text === 'TEC2') && !allLocal(cr, 'contact').some((e) => String(e.text).includes(',')));
    check('create authInfo pw', textOf(cr, 'pw') === 'secret1');
    check('create secDNS keyTag', textOf(cr, 'keyTag') === '12345');
    check('create licence in the registry extension', textOf(cr, 'license') === 'TM-1');
  }

  console.log('domain: create/update with inline glue (hostAttr)');
  {
    const { client, fake } = makeClient([GREETING, OK(), OK()]);
    await client.connect();
    await client.domain.create('glue.com.ua', {
      years: 1,
      registrant: 'REG1',
      nameservers: [
        { name: 'ns1.glue.com.ua', addresses: ['192.0.2.1', '2001:db8::1'] },
        { name: 'ns2.glue.com.ua', addresses: ['192.0.2.2'] },
      ],
    });
    const g = parse(fake.written[0]);
    const attrs = allLocal(g, 'hostAttr');
    check('glue hostAttr x2', attrs.length === 2);
    check('glue hostName', allLocal(g, 'hostName')[0].text === 'ns1.glue.com.ua');
    const addrs = allLocal(g, 'hostAddr');
    check('glue v4 addr tagged ip=v4', addrs[0].text === '192.0.2.1' && addrs[0].attrs.ip === 'v4');
    check('glue v6 addr tagged ip=v6', addrs[1].text === '2001:db8::1' && addrs[1].attrs.ip === 'v6');
    check('glue emits no hostObj', allLocal(g, 'hostObj').length === 0);

    // A nameserver may be added to an existing domain with its glue, too.
    await client.domain.update('glue.com.ua', { add: { ns: [{ name: 'ns3.glue.com.ua', addresses: ['192.0.2.3'] }] } });
    check('glue on update add', textOf(parse(fake.written[1]), 'hostName') === 'ns3.glue.com.ua');

    // RFC 5731 makes <domain:ns> a choice, so a mixture is refused here rather than at the registry.
    let mixed = null;
    try {
      await client.domain.create('mix.com.ua', { nameservers: ['ns1.mix.com.ua', { name: 'ns2.mix.com.ua', addresses: ['192.0.2.9'] }] });
    } catch (e) {
      mixed = e;
    }
    check('mixed hostObj + hostAttr refused', mixed instanceof ValidationError
      && mixed.message.includes('all names or all name-with-glue'));
  }

  console.log('domain: create without authInfo still emits an empty <pw/>');
  {
    const { client, fake } = makeClient([GREETING, OK()]);
    await client.connect();
    await client.domain.create('noauth.com.ua', { years: 1, registrant: 'REG1', contacts: { admin: 'A1', tech: 'T1' }, nameservers: ['ns1.example.net'] });
    const pw = firstLocal(parse(fake.written[0]), 'pw');
    check('authInfo-less create has a <pw> element', pw !== null);
    check('authInfo-less create <pw> is empty', (pw.text || '') === '');
  }

  console.log('domain: create with empty secDNS emits no childless secDNS:create');
  {
    const { client, fake } = makeClient([GREETING, OK()]);
    await client.connect();
    await client.domain.create('nosec.com.ua', { years: 1, registrant: 'REG1', contacts: { admin: 'A1', tech: 'T1' }, nameservers: ['ns1.example.net'], secDNS: {} });
    const secCreate = [...walk(parse(fake.written[0]))].filter((e) => e.name === 'secDNS:create');
    check('empty secDNS -> no secDNS:create', secCreate.length === 0);
  }

  console.log('domain: update deltas + secDNS + restore');
  {
    const { client, fake } = makeClient([GREETING, OK(), OK()]);
    await client.connect();
    await client.domain.update('example3.com.ua', {
      add: { ns: ['ns3.example.net'], statuses: ['clientHold'] },
      rem: { statuses: ['clientHold'] },
      chg: { registrant: 'REG9', authInfo: 'newpw12345' },
      secDNS: { add: { dsData: [{ keyTag: 22, alg: 8, digestType: 2, digest: 'bb'.repeat(32) }] }, remAll: true, maxSigLife: 1209600 },
    });
    const up = parse(fake.written[0]);
    check('update add block present', firstLocal(up, 'add') !== null);
    check('update chg registrant', textOf(up, 'registrant') === 'REG9');
    check('update secDNS rem all=true', [...walk(up)].some((e) => e.local === 'all' && e.text === 'true'));
    check('update secDNS add keyTag=22', textOf(up, 'keyTag') === '22');
    check('update secDNS maxSigLife', textOf(up, 'maxSigLife') === '1209600');

    await client.domain.restore('example3.com.ua');
    check('restore rgp op=request', firstLocal(parse(fake.written[1]), 'restore').attrs.op === 'request');
  }

  console.log('domain: renew / delete / transfer');
  {
    const { client, fake } = makeClient([GREETING, OK(), OK(), OK()]);
    await client.connect();
    await client.domain.renew('example3.com.ua', '2027-01-15', 2);
    const rn = parse(fake.written[0]);
    check('renew curExpDate', textOf(rn, 'curExpDate') === '2027-01-15');
    check('renew period 2', textOf(rn, 'period') === '2');
  }
  {
    // The value that reaches a caller's hands is <exDate>, an xs:dateTime; the value the wire wants
    // is <curExpDate>, an xs:date. Passing the first straight to renew() is the obvious thing to
    // write, and before this it produced a 2105 whose message mentions neither element.
    const { client, fake } = makeClient([GREETING, OK(), OK(), OK()]);
    await client.connect();
    await client.domain.renew('example3.com.ua', '2027-01-15T09:15:00.0Z', 1);
    check('renew accepts the exDate timestamp and sends the date',
      textOf(parse(fake.written[0]), 'curExpDate') === '2027-01-15');

    await client.domain.renew('example3.com.ua', '2027-01-15T23:30:00.0Z', 1);
    check('and takes the date the server wrote, never a local-timezone shift of it',
      textOf(parse(fake.written[1]), 'curExpDate') === '2027-01-15');

    // Not a date at all: passed through, so the server answers rather than the library guessing.
    await client.domain.renew('example3.com.ua', 'not-a-date', 1);
    check('an unrecognised value goes to the server unchanged',
      textOf(parse(fake.written[2]), 'curExpDate') === 'not-a-date');
  }
  {
    const { client, fake } = makeClient([GREETING, OK(), OK(), OK()]);
    await client.connect();
    await client.domain.delete('example3.com.ua');
    check('delete has name', textOf(parse(fake.written[0]), 'name') === 'example3.com.ua');
    await client.domain.transfer('request', 'example3.com.ua', 'pw', 1);
    const tr = parse(fake.written[1]);
    check('transfer op=request', firstLocal(tr, 'transfer').attrs.op === 'request');
    check('transfer authInfo pw', textOf(tr, 'pw') === 'pw');
  }

  // --------------------------------------------------------------- fees (RFC 8748)
  console.log('fees: check query, transform agreement, response parsing');
  {
    const { client, fake } = makeClient([GREETING, OK(), OK(), OK()]);
    await client.connect();

    // Price query riding a check: one fee:command per operation, with a year period.
    await client.domain.check(['example3.com.ua'], { create: 2, renew: 1 });
    const fc = parse(fake.written[0]);
    // NB: filter on the qualified name — the bare EPP <command> wrapper shares the local name.
    const feeCommands = [...walk(fc)].filter((e) => e.name === 'fee:command');
    check('fee:check has 2 commands', feeCommands.length === 2);
    check('fee:check command name=create', feeCommands[0].attrs.name === 'create');
    check('fee:check period 2y', textOf(fc, 'period') === '2');
    check('fee:check carries the fee xmlns', fake.written[0].includes(`xmlns:fee="${Namespaces.FEE}"`));

    // Fee agreement on transforms — string and { amount, currency } forms.
    await client.domain.create('example3.com.ua', { years: 1, registrant: 'REG1', fee: '100.00' });
    const cf = parse(fake.written[1]);
    check('create fee amount', allLocal(cf, 'fee').some((e) => e.text === '100.00'));
    await client.domain.renew('example3.com.ua', '2027-01-15', 1, { amount: '90.00', currency: 'UAH' });
    const rf = parse(fake.written[2]);
    check('renew fee amount + currency', allLocal(rf, 'fee').some((e) => e.text === '90.00') && textOf(rf, 'currency') === 'UAH');

    // Response side: fee:chkData -> fees(), fee:creData -> chargedFee().
    const chk = Response.fromXml('<?xml version="1.0"?><epp xmlns="urn:ietf:params:xml:ns:epp-1.0"><response>'
      + '<result code="1000"><msg>ok</msg></result>'
      + '<extension><fee:chkData xmlns:fee="urn:ietf:params:xml:ns:epp:fee-1.0">'
      + '<fee:currency>UAH</fee:currency>'
      + '<fee:cd><fee:objID>example3.com.ua</fee:objID>'
      + '<fee:command name="create" standard="1"><fee:period unit="y">1</fee:period><fee:fee>100.00</fee:fee></fee:command>'
      + '</fee:cd>'
      + '<fee:cd avail="0"><fee:objID>y.zz</fee:objID><fee:reason>Zone is not served</fee:reason></fee:cd>'
      + '</fee:chkData></extension>'
      + '<trID><svTRID>SRV-9</svTRID></trID></response></epp>');
    const fees = chk.fees();
    check('fees() currency', fees._currency === 'UAH');
    check('fees() create price', fees['example3.com.ua'].commands.create.fee === '100.00');
    check('fees() unavailable name + reason', fees['y.zz'].avail === false && fees['y.zz'].reason === 'Zone is not served');

    const cre = Response.fromXml('<?xml version="1.0"?><epp xmlns="urn:ietf:params:xml:ns:epp-1.0"><response>'
      + '<result code="1000"><msg>ok</msg></result>'
      + '<extension><fee:creData xmlns:fee="urn:ietf:params:xml:ns:epp:fee-1.0">'
      + '<fee:currency>UAH</fee:currency><fee:fee>100.00</fee:fee></fee:creData></extension>'
      + '<trID><svTRID>SRV-10</svTRID></trID></response></epp>');
    const charged = cre.chargedFee();
    check('chargedFee() decodes the echo', charged !== null && charged.currency === 'UAH' && charged.fee === '100.00');
  }

  // ------------------------------------------------------------------ contact
  console.log('contact: create (int+loc postalInfo + disclose)');
  {
    const { client, fake } = makeClient([GREETING, OK()]);
    await client.connect();
    await client.contact.create('CID1', {
      postalInfos: [
        { type: 'int', name: 'Test Person', street: ['1 A St'], city: 'Kyiv', cc: 'UA' },
        { type: 'loc', name: 'Тест Особа', city: 'Київ', cc: 'UA' },
      ],
      email: 'contact@example.com', authInfo: 'pw', disclose: { flag: false, addr: ['int'], voice: true, email: true },
    });
    const cc = parse(fake.written[0]);
    check('contact 2 postalInfo blocks', allLocal(cc, 'postalInfo').length === 2);
    check('contact int name', [...walk(cc)].some((e) => e.local === 'name' && e.text === 'Test Person'));
    check('contact loc Cyrillic name preserved', [...walk(cc)].some((e) => e.local === 'name' && e.text === 'Тест Особа'));
    check('contact disclose flag=0', firstLocal(cc, 'disclose').attrs.flag === '0');
  }

  // Removing an organisation is expressed by an EMPTY element, and the difference between "empty"
  // and "absent" is the whole mechanism: <contact:org/> means take it away, no element at all means
  // leave it alone. Get that backwards in either direction and it fails silently — an omitted clear
  // leaves a former organisation in the public WHOIS, a phantom one wipes an untouched org.
  console.log('contact: an EMPTY org removes it, an ABSENT org says nothing');
  {
    const { client, fake } = makeClient([GREETING, OK()]);
    await client.connect();
    await client.contact.update('CID1', { chg: { postalInfo: { type: 'loc', org: '', city: 'Kyiv', cc: 'UA' } } });
    const cc = parse(fake.written[0]);
    const orgs = allLocal(cc, 'org');
    check('org emitted for a clear', orgs.length === 1);
    check('and it is empty', (orgs[0].text || '') === '');
  }
  {
    const { client, fake } = makeClient([GREETING, OK()]);
    await client.connect();
    await client.contact.update('CID1', { chg: { postalInfo: { type: 'loc', city: 'Lviv', cc: 'UA' } } });
    check('no org element when the caller never mentioned it', allLocal(parse(fake.written[0]), 'org').length === 0);
  }
  {
    // On a create there is nothing to remove, so an empty org is simply not an element.
    const { client, fake } = makeClient([GREETING, OK()]);
    await client.connect();
    await client.contact.create('CID1', {
      postalInfos: [{ type: 'int', name: 'Test Person', org: '', city: 'Kyiv', cc: 'UA' }],
      email: 'contact@example.com', authInfo: 'pw',
    });
    check('create never emits an empty org', allLocal(parse(fake.written[0]), 'org').length === 0);
  }

  console.log('contact: the reserved id asks the registry to mint the handle');
  {
    const creData = '<?xml version="1.0"?><epp xmlns="urn:ietf:params:xml:ns:epp-1.0"><response>'
      + '<result code="1000"><msg>Command completed successfully</msg></result>'
      + '<resData><contact:creData xmlns:contact="urn:ietf:params:xml:ns:contact-1.0">'
      + '<contact:id>C0000042-EXAMPLE</contact:id><contact:crDate>2026-08-16T10:00:00.0Z</contact:crDate>'
      + '</contact:creData></resData><trID><svTRID>SRV-1</svTRID></trID></response></epp>';
    const { client, fake } = makeClient([GREETING, creData]);
    await client.connect();
    const minted = await client.contact.createAuto({ name: 'ACME', city: 'Kyiv', cc: 'UA', email: 'contact@example.com' });
    check('reserved id sent verbatim', textOf(parse(fake.written[0]), 'id') === 'autonic');
    check('reserved id constant', Contact.AUTO_ID === 'autonic');
    // The minted handle arrives in creData and nowhere else, so objectName() must read the id —
    // not the person's postal name, which also sits under a <name> element in a contact response.
    check('minted handle read back from creData', minted.objectName() === 'C0000042-EXAMPLE');
  }

  console.log('contact: create without email throws ValidationError');
  {
    const { client } = makeClient([GREETING]);
    await client.connect();
    let threw = false;
    try { await client.contact.create('CID2', { name: 'X', city: 'Kyiv', cc: 'UA' }); } catch (e) { threw = e instanceof ValidationError; }
    check('empty email throws ValidationError, inside the documented error hierarchy', threw);
  }

  console.log('contact: which postal fields can be CLEARED is the schema\'s decision, not ours');
  {
    // contact-1.0.xsd: optPostalLineType (org, street, sp) and pcType have no minLength, so those
    // clear by being sent empty. postalLineType (name, city) has minLength 1 and ccType is exactly
    // two characters, so an empty one of those is schema-invalid — and an invalid frame comes back
    // as a bare 2001 that names no element, the least useful error in EPP.
    const { client, fake } = makeClient([GREETING, OK(), OK()]);
    await client.connect();

    const refuses = async (fn) => {
      try { await fn(); return null; } catch (e) { return e instanceof ValidationError ? e : null; }
    };

    const noAddr = await refuses(() => client.contact.update('C-1', { chg: { postalInfo: { type: 'loc', sp: '' } } }));
    check('clearing sp WITHOUT the required parts of <addr> is refused here, not by the server', noAddr !== null);
    check('and the message names the part that is missing', noAddr !== null && noAddr.message.includes('city'));

    const emptyName = await refuses(() => client.contact.update('C-1', {
      chg: { postalInfo: { type: 'loc', name: '', city: 'Lviv', cc: 'UA' } },
    }));
    check('a name cannot be cleared at all — there is no empty postalLineType', emptyName !== null);

    // The whole point of the guard is that the CORRECT call still works and still clears.
    await client.contact.update('C-1', { chg: { postalInfo: { type: 'loc', sp: '', city: 'Lviv', cc: 'UA' } } });
    const sent = parse(fake.written[0]);
    check('sp goes out as an empty element, which is what clears it',
      allLocal(sent, 'sp').length === 1 && allLocal(sent, 'sp')[0].text === '');
    check('and the required parts travel with it',
      textOf(sent, 'city') === 'Lviv' && textOf(sent, 'cc') === 'UA');

    await client.contact.update('C-1', { chg: { postalInfo: { type: 'loc', org: '' } } });
    const orgOnly = parse(fake.written[1]);
    check('clearing org alone sends no <addr> and needs no city',
      allLocal(orgOnly, 'addr').length === 0 && allLocal(orgOnly, 'org').length === 1);
  }

  console.log('contact: update collapses multiple statuses into one add/rem block');
  {
    const { client, fake } = makeClient([GREETING, OK()]);
    await client.connect();
    await client.contact.update('CID1', {
      addStatuses: ['clientUpdateProhibited', 'clientDeleteProhibited'],
      remStatuses: ['clientTransferProhibited'],
      chg: { email: 'new-contact@example.com' },
    });
    const cu = parse(fake.written[0]);
    check('contact update single add block', allLocal(cu, 'add').length === 1);
    check('contact update 2 statuses in add', allLocal(cu, 'status').filter((e) => ['clientUpdateProhibited', 'clientDeleteProhibited'].includes(e.attrs.s)).length === 2);
    check('contact update chg email', [...walk(cu)].some((e) => e.local === 'email' && e.text === 'new-contact@example.com'));
  }

  console.log('contact: check / info / delete / transfer');
  {
    const { client, fake } = makeClient([GREETING, OK(), OK(), OK(), OK()]);
    await client.connect();
    await client.contact.check(['C1', 'C2']);
    check('contact:check 2 ids', allLocal(parse(fake.written[0]), 'id').length === 2);
    await client.contact.info('C1', 'pw');
    check('contact:info authInfo', textOf(parse(fake.written[1]), 'pw') === 'pw');
    await client.contact.delete('C1');
    check('contact:delete id', textOf(parse(fake.written[2]), 'id') === 'C1');
    await client.contact.transfer('request', 'C1', 'pw');
    check('contact:transfer op', firstLocal(parse(fake.written[3]), 'transfer').attrs.op === 'request');
  }

  // --------------------------------------------------------------------- host
  console.log('host: create v4+v6 auto-detect / update / delete-force');
  {
    const { client, fake } = makeClient([GREETING, OK(), OK(), OK()]);
    await client.connect();
    await client.host.create('ns1.example.net', ['192.0.2.1', '2001:db8::1']);
    const addrs = allLocal(parse(fake.written[0]), 'addr');
    check('host v4 detected', addrs.some((a) => a.text === '192.0.2.1' && a.attrs.ip === 'v4'));
    check('host v6 detected', addrs.some((a) => a.text === '2001:db8::1' && a.attrs.ip === 'v6'));
    await client.host.update('ns1.example.net', { addAddresses: ['192.0.2.9'], remStatuses: ['clientUpdateProhibited'] });
    const hu = parse(fake.written[1]);
    check('host update add block', firstLocal(hu, 'add') !== null);
    // RENAME IS REFUSED, not emitted. The server has no chg field for hosts and reads only add/rem,
    // so a <host:chg> is discarded without comment: an address change in the same frame would
    // succeed, the rename would not, and the caller would be told 1000.
    let renameRefused = false;
    try {
      await client.host.update('ns1.example.net', { newName: 'ns2.example.net' });
    } catch (e) {
      renameRefused = /rename is not supported/.test(e.message);
    }
    check('host rename is refused up front', renameRefused);
    await client.host.delete('ns1.example.net', true);
    check('host delete force registry:deleteNS', firstLocal(parse(fake.written[2]), 'deleteNS') !== null);
  }

  // -------------------------------------------------------------- poll+balance
  console.log('poll: request / ack   +   balance: info');
  {
    const { client, fake } = makeClient([GREETING, OK(), OK(), OK()]);
    await client.connect();
    await client.poll.request();
    check('poll op=req', firstLocal(parse(fake.written[0]), 'poll').attrs.op === 'req');
    await client.poll.ack('42');
    const pa = parse(fake.written[1]);
    check('poll op=ack', firstLocal(pa, 'poll').attrs.op === 'ack');
    check('poll msgID', firstLocal(pa, 'poll').attrs.msgID === '42');
    await client.balance();
    check('balance:info element in balance-1.0 ns', [...walk(parse(fake.written[2]))].some((e) => e.name === 'balance:info'));
  }

  // ------------------------------------------------------------------ escaping
  console.log('frame: XML escaping (special chars + Cyrillic, single-escaped)');
  {
    const { client, fake } = makeClient([GREETING, OK()]);
    await client.connect();
    await client.contact.create('C&<1', { name: 'A & B <Ltd>', city: 'Львів', cc: 'UA', email: 'a"b@example.com' });
    const raw = fake.written[0];
    check('ampersand escaped once', raw.includes('&amp;') && !raw.includes('&amp;amp;'));
    check('angle brackets escaped', raw.includes('&lt;Ltd&gt;'));
    check('Cyrillic preserved', raw.includes('Львів'));
    check('escaped id round-trips', textOf(parse(raw), 'id') === 'C&<1');
  }

  // ------------------------------------------------------------------ response
  console.log('response: code / message / lang / trIDs');
  {
    const r = Response.fromXml(OK(1000, 'Команду виконано успішно', 'uk'));
    check('code 1000', r.code() === 1000);
    check('isSuccess', r.isSuccess());
    check('message text', r.message() === 'Команду виконано успішно');
    check('messageLang uk', r.messageLang() === 'uk');
    check('svTRID', r.svTRID() === 'SRV-1');
    check('clTRID', r.clTRID() === 'C1');
  }

  console.log('response: availability (domain:check)');
  {
    const availXml = '<?xml version="1.0"?><epp xmlns="urn:ietf:params:xml:ns:epp-1.0"><response>'
      + '<result code="1000"><msg>ok</msg></result><resData>'
      + '<domain:chkData xmlns:domain="urn:ietf:params:xml:ns:domain-1.0">'
      + '<domain:cd><domain:name avail="1">free.com.ua</domain:name></domain:cd>'
      + '<domain:cd><domain:name avail="0">taken.com.ua</domain:name></domain:cd>'
      + '</domain:chkData></resData><trID><svTRID>SRV-2</svTRID></trID></response></epp>';
    const av = Response.fromXml(availXml).availability();
    check('avail free=true', av['free.com.ua'] === true);
    check('avail taken=false', av['taken.com.ua'] === false);

    // A fee rider accompanies every check, and an unserved zone comes back as
    // avail="0" on the <fee:cd> BLOCK (children fee:objID + fee:reason). Keying on "any element
    // with @avail" added a junk entry beside the real names.
    const noisyXml = '<?xml version="1.0"?><epp xmlns="urn:ietf:params:xml:ns:epp-1.0"><response>'
      + '<result code="1000"><msg>ok</msg></result><resData>'
      + '<domain:chkData xmlns:domain="urn:ietf:params:xml:ns:domain-1.0">'
      + '<domain:cd><domain:name avail="1">free.com.ua</domain:name></domain:cd>'
      + '</domain:chkData></resData>'
      + '<extension><fee:chkData xmlns:fee="urn:ietf:params:xml:ns:epp:fee-1.0">'
      + '<fee:cd avail="0"><fee:objID>bad.zz</fee:objID><fee:reason>Zone is not served</fee:reason></fee:cd>'
      + '</fee:chkData></extension></response></epp>';
    const noisy = Response.fromXml(noisyXml).availability();
    check('avail ignores fee:cd', Object.keys(noisy).length === 1 && noisy['free.com.ua'] === true);
  }

  console.log('response: balance / prices / licence / statuses');
  {
    const infoXml = '<?xml version="1.0"?><epp xmlns="urn:ietf:params:xml:ns:epp-1.0"><response>'
      + '<result code="1000"><msg>ok</msg></result><resData>'
      + '<domain:infData xmlns:domain="urn:ietf:params:xml:ns:domain-1.0">'
      + '<domain:name>example3.com.ua</domain:name><domain:status s="ok"/>'
      + '<domain:exDate>2027-01-01T00:00:00Z</domain:exDate></domain:infData></resData>'
      + '<extension><registry:infData xmlns:registry="http://registry.example/epp/registry-1.0">'
      + '<registry:license>TM-777</registry:license>'
      + '<registry:priceData channel="7"><registry:price operation="renewal" currency="UAH">180.00</registry:price></registry:priceData>'
      + '<registry:registrar>EXAMPLE</registry:registrar>'
      + '</registry:infData></extension><trID><svTRID>SRV-3</svTRID></trID></response></epp>';
    const ri = Response.fromXml(infoXml);
    check('value exDate', ri.value('exDate') === '2027-01-01T00:00:00Z');
    check('statuses ok', JSON.stringify(ri.statuses()) === JSON.stringify(['ok']));
    check('license', ri.license() === 'TM-777');
    check('prices renewal value', ri.prices().renewal && ri.prices().renewal.value === '180.00');
    check('prices renewal currency', ri.prices().renewal.currency === 'UAH');
    // The prices belong to a channel; without its id they cannot be matched to a catalogue row, and
    // a domain kept on an older channel prices differently from a new registration in the same zone.
    check('priceChannel reads the channel the prices belong to', ri.priceChannel() === '7');
    // sponsor() is the account; this is the handle the registry itself publishes as the registrar.
    check('registrarOfRecord reads the registry-side handle', ri.registrarOfRecord() === 'EXAMPLE');
    const plainInfo = Response.fromXml('<?xml version="1.0"?><epp xmlns="urn:ietf:params:xml:ns:epp-1.0">'
      + '<response><result code="1000"><msg>ok</msg></result><resData>'
      + '<domain:infData xmlns:domain="urn:ietf:params:xml:ns:domain-1.0"><domain:name>plain.com.ua</domain:name>'
      + '</domain:infData></resData><trID><svTRID>SRV-4</svTRID></trID></response></epp>');
    check('priceChannel is null when no price data came back', plainInfo.priceChannel() === null);
    check('registrarOfRecord is null when the registry sent none', plainInfo.registrarOfRecord() === null);

    const balXml = '<?xml version="1.0"?><epp xmlns="urn:ietf:params:xml:ns:epp-1.0"><response>'
      + '<result code="1000"><msg>ok</msg></result><resData>'
      + '<balance:infData xmlns:balance="http://registry.example/epp/balance-1.0">'
      + '<balance:creditLimit>1000.00</balance:creditLimit><balance:balance>250.50</balance:balance>'
      + '<balance:availableCredit>1250.50</balance:availableCredit></balance:infData></resData>'
      + '<trID><svTRID>SRV-4</svTRID></trID></response></epp>';
    const b = Response.fromXml(balXml).balance();
    check('balance creditLimit', b.creditLimit === '1000.00');
    check('balance availableCredit', b.availableCredit === '1250.50');
    check('non-balance response -> balance null', Response.fromXml(OK()).balance() === null);
  }

  console.log('response: secDNS read-back (nested keyData not leaked into keyRecords)');
  {
    const secXml = '<?xml version="1.0"?><epp xmlns="urn:ietf:params:xml:ns:epp-1.0"><response>'
      + '<result code="1000"><msg>ok</msg></result>'
      + '<extension><secDNS:infData xmlns:secDNS="urn:ietf:params:xml:ns:secDNS-1.1">'
      + '<secDNS:dsData><secDNS:keyTag>12345</secDNS:keyTag><secDNS:alg>13</secDNS:alg>'
      + '<secDNS:digestType>2</secDNS:digestType><secDNS:digest>ABCDEF0123</secDNS:digest>'
      + '<secDNS:keyData><secDNS:flags>256</secDNS:flags><secDNS:protocol>3</secDNS:protocol>'
      + '<secDNS:alg>13</secDNS:alg><secDNS:pubKey>nested</secDNS:pubKey></secDNS:keyData></secDNS:dsData>'
      + '<secDNS:keyData><secDNS:flags>257</secDNS:flags><secDNS:protocol>3</secDNS:protocol>'
      + '<secDNS:alg>13</secDNS:alg><secDNS:pubKey>toplevel</secDNS:pubKey></secDNS:keyData>'
      + '</secDNS:infData></extension><trID><svTRID>SRV-5</svTRID></trID></response></epp>';
    const rs = Response.fromXml(secXml);
    check('dsRecords count 1', rs.dsRecords().length === 1);
    check('dsRecords keyTag', rs.dsRecords()[0].keyTag === 12345);
    check('keyRecords only top-level', rs.keyRecords().length === 1 && rs.keyRecords()[0].pubKey === 'toplevel');
    check('isSigned', rs.isSigned() === true);
  }

  console.log('response: poll id/count/text + trStatus + errorReasons');
  {
    const pollXml = '<?xml version="1.0"?><epp xmlns="urn:ietf:params:xml:ns:epp-1.0"><response>'
      + '<result code="1301"><msg>ack to dequeue</msg></result>'
      + '<msgQ count="3" id="42"><qDate>2026-07-04T00:00:00Z</qDate><msg lang="uk">Домен example3.com.ua продовжено</msg></msgQ>'
      + '<resData><domain:trnData xmlns:domain="urn:ietf:params:xml:ns:domain-1.0">'
      + '<domain:name>example3.com.ua</domain:name><domain:trStatus>pending</domain:trStatus></domain:trnData></resData>'
      + '<trID><svTRID>SRV-6</svTRID></trID></response></epp>';
    const rp = Response.fromXml(pollXml);
    check('poll messageId', rp.messageId() === '42');
    check('poll messageCount', rp.messageCount() === 3);
    check('poll message is the result msg, not the queue msg', rp.message() === 'ack to dequeue');
    // …and the QUEUE message is now reachable. Without these a consumer had only message(), the
    // constant result banner, so the real notice text was unreadable while the ack dequeued it
    // permanently.
    check('poll queueMessage is the NOTICE text', rp.queueMessage() === 'Домен example3.com.ua продовжено');
    check('poll queueMessageLang', rp.queueMessageLang() === 'uk');
    check('poll queueDate', rp.queueDate() === '2026-07-04T00:00:00Z');
    check('queueMessage differs from message', rp.queueMessage() !== rp.message());
    check('transferStatus pending', rp.transferStatus() === 'pending');
    // A trnData notice is not a pending-action outcome; null, not a fabricated verdict.
    check('no panData on a trnData notice', rp.pendingActionData() === null);

    // The outcome of an OFFLINE operation. This is how a deferred command reports back: send
    // domain:create, get 1001 + an svTRID, and the answer arrives later as a poll message. The
    // 1301 means "here is a message", NOT "it worked" — paResult is the only thing that says that.
    const panXml = '<?xml version="1.0"?><epp xmlns="urn:ietf:params:xml:ns:epp-1.0"><response>'
      + '<result code="1301"><msg>ack to dequeue</msg></result>'
      + '<msgQ count="1" id="11"><qDate>1970-01-01T00:00:12Z</qDate><msg>Domain registered</msg></msgQ>'
      + '<resData><domain:panData xmlns:domain="urn:ietf:params:xml:ns:domain-1.0">'
      + '<domain:name paResult="1">example.com.ua</domain:name>'
      + '<domain:paTRID><clTRID>my-create-1</clTRID><svTRID>SRV-19700101000000-1-00042</svTRID></domain:paTRID>'
      + '<domain:paDate>1970-01-01T00:00:12Z</domain:paDate>'
      + '</domain:panData></resData>'
      + '<trID><svTRID>SRV-9</svTRID></trID></response></epp>';
    const pan = Response.fromXml(panXml).pendingActionData();
    check('panData object', pan.object === 'example.com.ua');
    check('panData success', pan.success === true);
    // The id of the ORIGINAL command: how a client knows WHICH pending operation this answers.
    // Poll is a queue — it is not necessarily the most recent one.
    check('panData original svTRID', pan.svTRID === 'SRV-19700101000000-1-00042');
    check('panData original clTRID', pan.clTRID === 'my-create-1');
    check('panData paDate', pan.date === '1970-01-01T00:00:12Z');
    check('panData failure', Response.fromXml(panXml.replace('paResult="1"', 'paResult="0"')).pendingActionData().success === false);

    // contact:panData too — matched by local name, so binding to domain-1.0 would have returned
    // null on a contact transfer.
    const cpanXml = panXml
      .replace(/domain:panData/g, 'contact:panData')
      .replace(/domain:name paResult="1"/, 'contact:id paResult="true"')
      .replace(/<\/domain:name>/, '</contact:id>')
      .replace(/xmlns:domain="urn:ietf:params:xml:ns:domain-1.0"/, 'xmlns:contact="urn:ietf:params:xml:ns:contact-1.0"')
      .replace(/domain:paTRID/g, 'contact:paTRID')
      .replace(/domain:paDate/g, 'contact:paDate');
    const cpan = Response.fromXml(cpanXml).pendingActionData();
    check('contact panData id', cpan.object === 'example.com.ua');
    check('paResult="true" is success too', cpan.success === true);

    const errXml = '<?xml version="1.0"?><epp xmlns="urn:ietf:params:xml:ns:epp-1.0"><response>'
      + '<result code="2306"><msg>policy</msg><extValue><value/><reason>bad NS count</reason></extValue></result>'
      + '<trID><svTRID>SRV-7</svTRID></trID></response></epp>';
    const re = Response.fromXml(errXml);
    check('code 2306', re.code() === 2306);
    check('not success', !re.isSuccess());
    check('errorReasons', JSON.stringify(re.errorReasons()) === JSON.stringify(['bad NS count']));
  }

  // ------------------------------------------------------- errors + guards
  console.log('errors: CommandError on >=2000, silenced by throwOnFailure(false)');
  {
    const { client } = makeClient([GREETING, OK(2302, 'exists')]);
    await client.connect();
    let threw = false;
    try {
      await client.domain.create('dup.com.ua', { years: 1, registrant: 'R', contacts: { admin: 'A', tech: 'T' }, nameservers: ['ns1.example.net'] });
    } catch (e) { threw = e instanceof CommandError && e.eppCode === 2302; }
    check('2302 throws CommandError', threw);
  }
  {
    const { client } = makeClient([GREETING, OK(2303, 'nope')]);
    await client.connect();
    client.throwOnFailure(false);
    const resp = await client.domain.info('missing.com.ua');
    check('throwOnFailure(false) returns response', resp.code() === 2303);
  }

  console.log('errors: login failure throws AuthError');
  {
    const { client } = makeClient([GREETING, OK(2200, 'bad login')]);
    await client.connect();
    let threw = false;
    try { await client.login(); } catch (e) { threw = e instanceof AuthError && e.eppCode === 2200; }
    check('login 2200 throws AuthError', threw);
  }

  console.log('config guards: empty host / password fail fast');
  {
    const c = new Client(new Config({ host: '', clid: 'x', password: 'y' }), new FakeTransport());
    let threw = false;
    try { await c.connect(); } catch (e) { threw = e instanceof ConfigError; }
    check('empty host -> ConfigError', threw);

    const { client, fake } = makeClient([GREETING]);
    await client.connect();
    client._config.password = '';
    let threw2 = false;
    try { await client.login(); } catch (e) { threw2 = e instanceof ConfigError; }
    check('empty password -> ConfigError', threw2);
    check('no login frame sent on config failure', fake.written.length === 0);
  }

  // --------------------------------------------------------- xml well-formedness
  console.log('xml: malformed input is refused, never read as a completed command');
  {
    // Each of these moved the parse cursor BACKWARDS (indexOf returning -1) and re-parsed the
    // same prefix forever: `node --max-old-space-size=128` died with a heap OOM.
    for (const bad of ['<epp><!-- oops', '<epp><?pi', '<epp><![CDATA[x', '<epp><!DOCTYPE']) {
      let threw = false;
      try { parseXml(bad); } catch (e) { threw = e instanceof ConnectionError; }
      check(`unterminated construct refused: ${JSON.stringify(bad)}`, threw);
    }

    // A half-delivered domain:create must not be booked as a paid registration.
    const truncated = '<?xml version="1.0"?><epp xmlns="urn:ietf:params:xml:ns:epp-1.0"><response>'
      + '<result code="1000"><msg>ok';
    let truncThrew = false;
    try { Response.fromXml(truncated); } catch (e) { truncThrew = e instanceof ConnectionError; }
    check('truncated 1000 response throws instead of reporting isSuccess()', truncThrew);

    let mismatch = false;
    try { parseXml('<epp><response></epp>'); } catch (e) { mismatch = e instanceof ConnectionError; }
    check('mismatched close tag refused', mismatch);

    // Two frames arriving in one read must be delivered in order: taking the last root would
    // hand this command the NEXT reply.
    let twoRoots = false;
    try { Response.fromXml(OK(1000) + OK(2200)); } catch (e) { twoRoots = e instanceof ConnectionError; }
    check('two concatenated frames refused', twoRoots);

    check('well-formed frame still parses', parseXml(OK()).local === 'epp');
  }

  console.log('xml: namespaces resolved; fee blocks matched by namespace, not by <currency>');
  {
    // fee:currency is OPTIONAL. Keying the fee riders on "has a direct <currency> child" made
    // fees() and chargedFee() silently report nothing whenever the server left it out.
    const chkNoCur = '<?xml version="1.0"?><epp xmlns="urn:ietf:params:xml:ns:epp-1.0"><response>'
      + '<result code="1000"><msg>ok</msg></result>'
      + '<extension><fee:chkData xmlns:fee="urn:ietf:params:xml:ns:epp:fee-1.0">'
      + '<fee:cd><fee:objID>example3.com.ua</fee:objID>'
      + '<fee:command name="create"><fee:period unit="y">1</fee:period><fee:fee>100.00</fee:fee></fee:command>'
      + '</fee:cd></fee:chkData></extension><trID><svTRID>SRV-11</svTRID></trID></response></epp>';
    check('parsed element carries its namespace URI', firstLocal(parse(chkNoCur), 'chkData').ns === Namespaces.FEE);
    const feesNoCur = Response.fromXml(chkNoCur).fees();
    check('fees() still found without fee:currency', feesNoCur['example3.com.ua'].commands.create.fee === '100.00');

    const creNoCur = '<?xml version="1.0"?><epp xmlns="urn:ietf:params:xml:ns:epp-1.0"><response>'
      + '<result code="1000"><msg>ok</msg></result>'
      + '<extension><fee:creData xmlns:fee="urn:ietf:params:xml:ns:epp:fee-1.0">'
      + '<fee:fee>100.00</fee:fee></fee:creData></extension>'
      + '<trID><svTRID>SRV-12</svTRID></trID></response></epp>';
    const chargedNoCur = Response.fromXml(creNoCur).chargedFee();
    check('chargedFee() still found without fee:currency', chargedNoCur !== null && chargedNoCur.fee === '100.00');

    const domainCre = '<?xml version="1.0"?><epp xmlns="urn:ietf:params:xml:ns:epp-1.0"><response>'
      + '<result code="1000"><msg>ok</msg></result><resData>'
      + '<domain:creData xmlns:domain="urn:ietf:params:xml:ns:domain-1.0"><domain:name>example3.com.ua</domain:name>'
      + '</domain:creData></resData><trID><svTRID>SRV-13</svTRID></trID></response></epp>';
    check('a plain domain:creData is not read as a fee echo', Response.fromXml(domainCre).chargedFee() === null);
  }

  console.log('frame: CR/LF/TAB escaped as numeric refs (XML whitespace normalization)');
  {
    const { client, fake } = makeClient([GREETING, OK()]);
    await client.connect();
    await client.domain.info('example3.com.ua', 'pw\rtail');
    const rawInfo = fake.written[0];
    // A literal CR is folded to LF by every parser, so the registry would store a DIFFERENT
    // authInfo and answer a later transfer with an unexplained 2202.
    check('CR in text escaped as &#13;', rawInfo.includes('&#13;'));
    check('CR round-trips through the parser', textOf(parse(rawInfo), 'pw') === 'pw\rtail');

    const frame = Frame.command('T-WS');
    frame.epp(frame.verb('check'), 'x', null, { note: 'l1\nl2\tend' });
    const wsXml = frame.toXml();
    check('attribute LF escaped as &#10;', wsXml.includes('&#10;'));
    check('attribute TAB escaped as &#9;', wsXml.includes('&#9;'));
    check('attribute whitespace round-trips', firstLocal(parse(wsXml), 'x').attrs.note === 'l1\nl2\tend');

    // String.fromCodePoint throws a raw RangeError past U+10FFFF, escaping the EppError contract.
    check('out-of-range numeric reference left as text', parseXml('<a>&#1114112;</a>').text === '&#1114112;');
  }

  console.log('frame: toXml() is idempotent (exactly one clTRID, always last)');
  {
    const frame = Frame.command('T-1');
    frame.ns(frame.verb('check'), Namespaces.DOMAIN, 'domain:check');
    const first = frame.toXml();
    const second = frame.toXml();
    check('a second toXml() returns the same frame', first === second);
    check('exactly one clTRID', allLocal(parse(second), 'clTRID').length === 1);
    const cmd = firstLocal(parse(second), 'command');
    check('clTRID is the last child of <command>', cmd.children[cmd.children.length - 1].local === 'clTRID');
  }

  console.log("contact: disclose flag '0' means HIDE (every string is truthy in JS)");
  {
    const { client, fake } = makeClient([GREETING, OK()]);
    await client.connect();
    await client.contact.create('CID3', {
      name: 'X', city: 'Kyiv', cc: 'UA', email: 'contact@example.com',
      disclose: { flag: '0', voice: '0', email: true },
    });
    const disc = firstLocal(parse(fake.written[0]), 'disclose');
    check("disclose flag='0' emits flag=\"0\"", disc.attrs.flag === '0');
    check("disclose voice='0' discloses nothing", disc.children.every((e) => e.local !== 'voice'));
    check('disclose email true still emitted', disc.children.some((e) => e.local === 'email'));
  }

  console.log('fees: a 0 amount is a real agreement; a malformed one fails fast');
  {
    const { client, fake } = makeClient([GREETING, OK()]);
    await client.connect();
    await client.domain.renew('example3.com.ua', '2027-01-15', 1, { amount: 0, currency: 'UAH' });
    check('fee amount 0 is emitted, not an empty <fee:fee/>',
      allLocal(parse(fake.written[0]), 'fee').some((e) => e.text === '0'));
    let feeThrew = false;
    try { await client.domain.renew('example3.com.ua', '2027-01-15', 1, '100,00'); } catch (e) { feeThrew = e instanceof ValidationError; }
    check('malformed fee amount throws ValidationError before anything is sent', feeThrew && fake.written.length === 1);
  }

  console.log('logging: authInfo masked even when the element carries attributes');
  {
    const { client } = makeClient([]);
    const masked = client._redact('<pw>topsecret</pw><domain:pw roid="D1-EXAMPLE">auth123</domain:pw><domain:name>keep.ua</domain:name>');
    check('bare <pw> masked', !masked.includes('topsecret'));
    check('<domain:pw> with attributes masked', !masked.includes('auth123'));
    check('non-secret kept', masked.includes('keep.ua'));
  }

  // ------------------------------------------------------------------- transport
  console.log('transport: framing queue (pipelined, last frame before a close, runaway length)');
  {
    const framed = (xml) => {
      const body = Buffer.from(xml, 'utf8');
      const head = Buffer.alloc(4);
      head.writeUInt32BE(body.length + 4, 0);
      return Buffer.concat([head, body]);
    };
    const cfg = () => new Config({ host: 'epp.example', clid: 'EXAMPLE', password: 'secret' });

    const conn = new Connection(cfg());
    conn._onData(Buffer.concat([framed(OK(1000, 'first')), framed(OK(1301, 'second'))]));
    check('pipelined frame 1', Response.fromXml(await conn.readFrame()).message() === 'first');
    check('pipelined frame 2', Response.fromXml(await conn.readFrame()).message() === 'second');

    const whole = framed(OK(1000, 'split'));
    conn._onData(whole.slice(0, 2));   // partial length prefix
    conn._onData(whole.slice(2, 9));
    conn._onData(whole.slice(9));
    check('frame split across reads is reassembled', Response.fromXml(await conn.readFrame()).message() === 'split');

    // RFC 5730 lets the server answer 2501/2502 and close immediately; that code must reach the
    // caller instead of a bare "Connection closed".
    const dying = new Connection(cfg());
    dying._onData(framed(OK(2501, 'session ended')));
    dying._fail(new ConnectionError('Connection closed'));
    check('frame buffered before the close is still delivered', Response.fromXml(await dying.readFrame()).code() === 2501);
    let afterClose = false;
    try { await dying.readFrame(); } catch (e) { afterClose = e instanceof ConnectionError; }
    check('the next read then reports the closed connection', afterClose);

    // The 1 MiB guard lived inside the waiters loop, so with no reader pending a bogus prefix
    // (or a chatty peer) grew the buffer without limit.
    const bogus = new Connection(cfg());
    const badHead = Buffer.alloc(4);
    badHead.writeUInt32BE(9999999, 0);
    bogus._onData(badHead);
    check('runaway length prefix fails the connection with no reader waiting', bogus._fatal !== null);
    let lenThrew = false;
    try { await bogus.readFrame(); } catch (e) { lenThrew = /Invalid EPP frame length/.test(e.message); }
    check('and readFrame() reports the length', lenThrew);
  }

  {
    console.log('fee: one operation can be priced at several periods in a single command');
    // A price table is one round trip, not five. The registry prices every <fee:command> separately.
    {
      const { client, fake } = makeClient([GREETING, OK(), OK()]);
      await client.connect();
      await client.domain.check(['example1.com.ua'], { create: [1, 2, 5], renew: 1 }, 'UAH');
      const x = fake.written[0];
      check('every period becomes its own fee:command', (x.match(/<fee:command/g) || []).length === 4);
      check('three of them are the same operation', (x.match(/name="create"/g) || []).length === 3);
      check('and the periods keep the order asked',
        [...x.matchAll(/<fee:period unit="y">(\d+)</g)].map((m) => m[1]).join(',') === '1,2,5,1');
      check('a named currency is carried', x.includes('<fee:currency>UAH</fee:currency>'));
      let capThrew = false;
      try { await client.domain.check(['example1.com.ua'], { create: Array(21).fill(1) }); }
      catch (e) { capThrew = e instanceof ValidationError; }
      // The registry refuses a 21st entry; refusing locally names it instead of spending a call.
      check('a query past the registry cap is refused before it is sent', capThrew);

      const feeReply = '<?xml version="1.0"?><epp xmlns="urn:ietf:params:xml:ns:epp-1.0"><response>'
        + '<result code="1000"><msg>ok</msg></result><resData>'
        + '<domain:chkData xmlns:domain="urn:ietf:params:xml:ns:domain-1.0">'
        + '<domain:cd><domain:name avail="1">example1.com.ua</domain:name></domain:cd></domain:chkData></resData>'
        + '<extension><fee:chkData xmlns:fee="urn:ietf:params:xml:ns:epp:fee-1.0"><fee:currency>UAH</fee:currency>'
        + '<fee:cd avail="1"><fee:objID>example1.com.ua</fee:objID>'
        + '<fee:command name="create"><fee:period unit="y">1</fee:period><fee:fee>100.00</fee:fee></fee:command>'
        + '<fee:command name="create"><fee:period unit="y">2</fee:period><fee:fee>190.00</fee:fee></fee:command>'
        + '<fee:command name="create"><fee:period unit="y">5</fee:period><fee:fee>450.00</fee:fee></fee:command>'
        + '<fee:command name="renew"><fee:period unit="y">1</fee:period><fee:fee>90.00</fee:fee></fee:command>'
        + '</fee:cd></fee:chkData></extension><trID><svTRID>X</svTRID></trID></response></epp>';
      const fr = Response.fromXml(feeReply);
      // Keyed by operation alone, three create quotes would collapse to one.
      check('every quote survives the parse', fr.fees()['example1.com.ua'].periods.length === 4);
      check('feeFor() reads one period exactly', fr.feeFor('example1.com.ua', 'create', 5) === '450.00');
      check('and a period nobody asked for is null', fr.feeFor('example1.com.ua', 'create', 7) === null);
      check('the commands map still answers for the first period',
        fr.fees()['example1.com.ua'].commands.create.fee === '100.00');
    }

    console.log('login: only 2200 means the credentials are wrong');
    // A server refuses <login> for several reasons, and they need opposite responses. Calling them
    // all an authentication failure sends the reader to rotate a password that was never wrong.
    {
      const refuse = (code) => '<?xml version="1.0"?><epp xmlns="urn:ietf:params:xml:ns:epp-1.0">'
        + `<response><result code="${code}"><msg>refused</msg></result>`
        + '<trID><clTRID>C1</clTRID><svTRID>X</svTRID></trID></response></epp>';
      const loginError = async (code) => {
        const { client } = makeClient([GREETING, refuse(code)]);
        await client.connect();
        try { await client.login(); return null; } catch (e) { return e; }
      };
      check('2200 is an AuthError', (await loginError(2200)) instanceof AuthError);
      // The session cap: the answer is to reconnect, not to change the password.
      check('2502 (session limit) is a SessionError', (await loginError(2502)) instanceof SessionError);
      check('2501 (server closing) is a SessionError', (await loginError(2501)) instanceof SessionError);
      check('2307 is not an auth failure', !((await loginError(2307)) instanceof AuthError));
    }

    console.log('poll drain: a refusal is not an empty queue');
    // Inferring emptiness from "no <msgQ>" makes a refused poll look exactly like a drained queue,
    // and the loop reports success while nothing was read.
    {
      const refused = '<?xml version="1.0"?><epp xmlns="urn:ietf:params:xml:ns:epp-1.0"><response>'
        + '<result code="2201"><msg>Authorization error</msg></result>'
        + '<trID><clTRID>C1</clTRID><svTRID>X</svTRID></trID></response></epp>';
      const { client } = makeClient([GREETING, refused]);
      await client.connect();
      client.throwOnFailure(false);
      let handled = 0;
      let threw = null;
      try { await client.poll.drain(async () => { handled += 1; }); } catch (e) { threw = e; }
      check('a refused poll raises rather than reporting an empty queue', threw !== null);
      check('and the handler was never called', handled === 0);
    }

    console.log('authInfo: clearing is not the same as emptying');
    // After a leak this is the only operation that helps. An empty <pw/> stores the empty string,
    // which the holder can still present — the domain stays exactly as movable as it was.
    {
      const { client, fake } = makeClient([GREETING, OK(), OK(), OK()]);
      await client.connect();
      await client.domain.updateBuilder('example3.com.ua').clearAuthInfo().send();
      check('clearAuthInfo() emits <domain:null/>', fake.written[0].includes('<domain:null/>'));
      check('and no <pw> element at all', !fake.written[0].includes('<domain:pw>'));
      await client.domain.update('example3.com.ua', { chg: { authInfo: 'N3w-Pw' } });
      check('an ordinary change still emits <pw>', fake.written[1].includes('<domain:pw>N3w-Pw</domain:pw>'));
      let bothThrew = false;
      try {
        await client.domain.update('example3.com.ua', { chg: { authInfo: 'a', clearAuthInfo: true } });
      } catch (e) { bothThrew = e instanceof ValidationError; }
      // The schema has one choice: a password, or nothing. Half-applying either would be worse.
      check('setting and clearing at once is refused, not half-applied', bothThrew);
      // RFC 5733 has no nullable form for a contact, so the SDK must not offer one.
      const { ContactUpdateBuilder } = require('../src/builders');
      check('contact:update has no clearAuthInfo',
        typeof ContactUpdateBuilder.prototype.clearAuthInfo !== 'function');
    }

    console.log('poll drain: a notice is acknowledged only after it has been handled');
    // An ack DELETES the notice at the registry. A loop that acks first and processes second loses
    // every notice whose processing fails, with nothing left to retry from.
    const notice = (id, text) =>
      '<?xml version="1.0"?><epp xmlns="urn:ietf:params:xml:ns:epp-1.0"><response>'
      + '<result code="1301"><msg>Command completed successfully; ack to dequeue</msg></result>'
      + `<msgQ count="2" id="${id}"><qDate>2026-08-16T09:00:00Z</qDate><msg>${text}</msg></msgQ>`
      + '<trID><clTRID>C1</clTRID><svTRID>SRV-1</svTRID></trID></response></epp>';
    const emptyQueue = '<?xml version="1.0"?><epp xmlns="urn:ietf:params:xml:ns:epp-1.0"><response>'
      + '<result code="1300"><msg>Command completed successfully; no messages</msg></result>'
      + '<trID><clTRID>C1</clTRID><svTRID>SRV-1</svTRID></trID></response></epp>';

    {
      const { client, fake } = makeClient([GREETING, notice('11', 'first'), OK(), notice('12', 'second'), OK(), emptyQueue]);
      await client.connect();
      const seen = [];
      const count = await client.poll.drain(async (n) => { seen.push(n.queueMessage()); });
      check('drain returns how many notices were handled', count === 2);
      check('and hands the NOTICE text to the callback, not the result banner',
        JSON.stringify(seen) === JSON.stringify(['first', 'second']));
      const acked = fake.written.map((s) => /msgID="(\d+)"/.exec(s)).filter(Boolean).map((m) => m[1]);
      check('each notice is acked exactly once, in order', JSON.stringify(acked) === JSON.stringify(['11', '12']));
      check('it stops on the empty queue rather than looping', fake.written.length === 5);
    }

    // The property that matters: a failing handler must NOT destroy the notice.
    {
      const { client, fake } = makeClient([GREETING, notice('21', 'boom'), OK(), emptyQueue]);
      await client.connect();
      let threw = false;
      try {
        await client.poll.drain(async () => { throw new Error('handler failed'); });
      } catch (e) { threw = e.message === 'handler failed'; }
      check('a failing handler surfaces its own error', threw);
      check('and the notice is NOT acked, so nothing is lost',
        !fake.written.some((s) => s.includes('msgID=')));
    }

    // A queue that fills faster than it drains would otherwise never let the call return.
    {
      const { client } = makeClient([GREETING, notice('31', 'a'), OK(), notice('32', 'b'), OK(), notice('33', 'c'), OK()]);
      await client.connect();
      check('a limit stops the drain early', (await client.poll.drain(async () => {}, 2)) === 2);
    }
  }

  {
    console.log('builders: the fluent form and the object form are the same command');
    // The whole design rests on send() being a thin façade over the ordinary method. Proved by
    // comparing the FRAMES, not the option objects: equal options could still be assembled into a
    // different frame, and it is the frame the registry sees. clTRID is stripped — it is unique per
    // command by construction.
    const frameOf = async (call) => {
      const { client, fake } = makeClient([GREETING, OK(), OK(), OK()]);
      await client.connect();
      await call(client);
      return (fake.written[0] || '').replace(/<clTRID>[^<]*<\/clTRID>/, '');
    };
    const sameFrame = async (label, viaBuilder, viaObject) => {
      check(label, (await frameOf(viaBuilder)) === (await frameOf(viaObject)));
    };

    await sameFrame(
      'domain:create built step by step matches the object call exactly',
      (c) => c.domain.createBuilder('example3.com.ua').years(2).registrant('acme-01')
        .adminContact('acme-01').techContact('acme-ns1').techContact('acme-ns2')
        .nameserver('ns1.acme.example').nameserver('ns2.acme.example')
        .authInfo('D0main-Pw').license('TM-1')
        .dsRecord(12345, 8, 2, 'AB'.repeat(32)).maxSigLife(604800)
        .maxFee('180.00', 'UAH').send(),
      (c) => c.domain.create('example3.com.ua', {
        years: 2, registrant: 'acme-01',
        contacts: { admin: ['acme-01'], tech: ['acme-ns1', 'acme-ns2'] },
        nameservers: ['ns1.acme.example', 'ns2.acme.example'],
        authInfo: 'D0main-Pw', license: 'TM-1',
        secDNS: { dsData: [{ keyTag: 12345, alg: 8, digestType: 2, digest: 'AB'.repeat(32) }], maxSigLife: 604800 },
        fee: { amount: '180.00', currency: 'UAH' },
      }),
    );
    await sameFrame(
      'domain:create with inline glue matches the object call exactly',
      (c) => c.domain.createBuilder('glue.com.ua').years(1).registrant('acme-01')
        .nameserverWithGlue('ns1.glue.com.ua', '192.0.2.1', '2001:db8::1')
        .nameserverWithGlue('ns2.glue.com.ua', '192.0.2.2')
        .send(),
      (c) => c.domain.create('glue.com.ua', {
        years: 1,
        registrant: 'acme-01',
        nameservers: [
          { name: 'ns1.glue.com.ua', addresses: ['192.0.2.1', '2001:db8::1'] },
          { name: 'ns2.glue.com.ua', addresses: ['192.0.2.2'] },
        ],
      }),
    );
    await sameFrame(
      'domain:update delta lands in the same add/rem/chg blocks',
      (c) => c.domain.updateBuilder('example3.com.ua')
        .addNameserver('ns3.acme.example').remNameserver('ns1.acme.example')
        .addStatus('clientHold').remStatus('clientTransferProhibited')
        .addContact('tech', 'acme-ns9')
        .changeRegistrant('acme-02').changeAuthInfo('N3w-Pw').send(),
      (c) => c.domain.update('example3.com.ua', {
        add: { ns: ['ns3.acme.example'], statuses: ['clientHold'], contacts: { tech: ['acme-ns9'] } },
        rem: { ns: ['ns1.acme.example'], statuses: ['clientTransferProhibited'] },
        chg: { registrant: 'acme-02', authInfo: 'N3w-Pw' },
      }),
    );
    await sameFrame(
      'contact:create with both postal forms matches the object call',
      (c) => c.contact.createBuilder('acme-01', 'billing@acme.example')
        .internationalAddress({ name: 'ACME LLC', city: 'Kyiv', countryCode: 'UA', street: ['1 Main St'], org: 'ACME LLC', postalCode: '01001' })
        .localizedAddress({ name: 'ТОВ АКМЕ', city: 'Київ', countryCode: 'UA' })
        .voice('+380.441234567').authInfo('C0ntact-Pw').withhold('voice', 'email').send(),
      (c) => c.contact.create('acme-01', {
        email: 'billing@acme.example',
        postalInfos: [
          { type: 'int', name: 'ACME LLC', city: 'Kyiv', cc: 'UA', street: ['1 Main St'], org: 'ACME LLC', pc: '01001' },
          { type: 'loc', name: 'ТОВ АКМЕ', city: 'Київ', cc: 'UA' },
        ],
        voice: '+380.441234567', authInfo: 'C0ntact-Pw',
        disclose: { flag: false, voice: true, email: true },
      }),
    );
    await sameFrame(
      'contact:update assembles the same chg block, statuses and disclosure',
      (c) => c.contact.updateBuilder('acme-01')
        .changeEmail('new@acme.example').changeVoice('+380.441234567').changeFax('')
        .changeInternationalAddress({ name: 'ACME LLC', city: 'Lviv', countryCode: 'UA', org: '', postalCode: '79000' })
        .changeAuthInfo('N3w-C0ntact-Pw').withhold('voice', 'email')
        .addStatus('clientUpdateProhibited').remStatus('clientDeleteProhibited').send(),
      (c) => c.contact.update('acme-01', {
        chg: {
          email: 'new@acme.example', voice: '+380.441234567', fax: '',
          postalInfo: { type: 'int', name: 'ACME LLC', city: 'Lviv', cc: 'UA', org: '', pc: '79000' },
          authInfo: 'N3w-C0ntact-Pw',
          disclose: { flag: false, voice: true, email: true },
        },
        addStatuses: ['clientUpdateProhibited'],
        remStatuses: ['clientDeleteProhibited'],
      }),
    );
    await sameFrame(
      'host:update addresses and statuses match the object call',
      (c) => c.host.updateBuilder('ns1.acme.example')
        .addAddress('192.0.2.10').addAddress('2001:db8::10')
        .remAddress('192.0.2.9').addStatus('clientUpdateProhibited').send(),
      (c) => c.host.update('ns1.acme.example', {
        addAddresses: ['192.0.2.10', '2001:db8::10'],
        remAddresses: ['192.0.2.9'], addStatuses: ['clientUpdateProhibited'],
      }),
    );

    const { client, fake } = makeClient([GREETING, OK(), OK()]);
    await client.connect();
    const pending = client.domain.createBuilder('example3.com.ua').years(1).registrant('C1');
    check('building sends nothing', fake.written.length === 0);
    check('toOptions() shows what would be sent',
      JSON.stringify(pending.toOptions()) === JSON.stringify({ years: 1, registrant: 'C1' }));
    await pending.send();
    let reSent = false;
    try { await pending.send(); } catch (e) { reSent = e instanceof ValidationError; }
    // Sending twice is two registrations and two charges, and the second is never what was meant.
    check('a builder refuses to be sent twice', reSent);
  }

  {
    console.log('errors: a class exists where the right next step differs');
    // Every one of these needs a different response from the caller — top up, pick another name,
    // clear a status, reconnect — which is the only reason they are separate classes.
    const errFor = async (code) => {
      const { client } = makeClient([GREETING,
        `<?xml version="1.0"?><epp xmlns="urn:ietf:params:xml:ns:epp-1.0"><response>`
        + `<result code="${code}"><msg>refused</msg>`
        + '<extValue><value><domain:name xmlns:domain="urn:ietf:params:xml:ns:domain-1.0">taken.com.ua</domain:name></value>'
        + '<reason lang="en">Already registered</reason></extValue></result>'
        + '<trID><svTRID>X</svTRID></trID></response></epp>']);
      await client.connect();
      try { await client.domain.check(['taken.com.ua']); return null; } catch (e) { return e; }
    };
    check('2104 is InsufficientFundsError', (await errFor(2104)) instanceof InsufficientFundsError);
    check('2202 is AuthorizationError', (await errFor(2202)) instanceof AuthorizationError);
    check('2302 is ObjectExistsError', (await errFor(2302)) instanceof ObjectExistsError);
    check('2303 is ObjectDoesNotExistError', (await errFor(2303)) instanceof ObjectDoesNotExistError);
    check('2305 is ObjectStatusError', (await errFor(2305)) instanceof ObjectStatusError);
    check('2308 is PolicyError', (await errFor(2308)) instanceof PolicyError);
    check('2502 is SessionError', (await errFor(2502)) instanceof SessionError);
    check('2005 stays a plain CommandError', (await errFor(2005)).name === 'CommandError');
    check('every one is still a CommandError', (await errFor(2302)) instanceof CommandError);

    // Retrying a 2302 cannot make the name free; retrying a 2104 cannot pay for it. A loop that
    // treats every failure as transient turns one refusal into a rate-limit ban.
    check('only the transient ones are retryable',
      (await errFor(2400)).isRetryable() && (await errFor(2502)).isRetryable()
      && !(await errFor(2302)).isRetryable() && !(await errFor(2104)).isRetryable());
    const exists = await errFor(2302);
    check('the message names WHICH object was refused', / \('taken\.com\.ua'\)$/.test(exists.message));
    check('subject() returns it too', exists.subject() === 'taken.com.ua');
    check('reasons() carries the registry\'s extra detail', exists.reasons().includes('Already registered'));
  }

  {
    console.log('transact: a reply carrying someone else\'s clTRID is refused');
    // The failure this prevents is silent and expensive: with a desynchronised stream, renew('b')
    // returns 1000 carrying a's exDate. The registrar books b as renewed, and both are billed.
    {
      const wrong = '<?xml version="1.0"?><epp xmlns="urn:ietf:params:xml:ns:epp-1.0"><response>'
        + '<result code="1000"><msg>ok</msg></result>'
        + '<trID><clTRID>SOMEONE-ELSES-TRID</clTRID><svTRID>SRV-9</svTRID></trID></response></epp>';
      const fake = new FakeTransport();
      // Bypass the echoing helper above: this fixture must arrive with the WRONG clTRID intact.
      fake.readFrame = async () => fake.queue.shift();
      fake.queue = [GREETING, wrong];
      const client = new Client(new Config({ host: 'h', clid: 'c', password: 'secret' }), fake);
      await client.connect();
      let err = null;
      try { await client.domain.check(['example1.com.ua']); } catch (e) { err = e; }
      check('a mismatched clTRID raises ConnectionError', err instanceof ConnectionError);
      check('and the message names both transaction ids',
        err !== null && /SOMEONE-ELSES-TRID/.test(err.message) && /NODEJS-SDK-/.test(err.message));
      check('and the connection is closed, not left usable', fake.isOpen() === false);
    }

    // A server that clamps a caller-supplied clTRID to the schema's 3..64 characters is answering
    // correctly, and must not be mistaken for a desynchronised stream.
    {
      const fake = new FakeTransport();
      fake.readFrame = async () => {
        const frame = fake.queue.shift();
        const sent = fake.written.length
          ? /<clTRID>([^<]*)<\/clTRID>/.exec(fake.written[fake.written.length - 1]) : null;
        return sent ? frame.replace(/<clTRID>[^<]*<\/clTRID>/, `<clTRID>${sent[1].slice(0, 64)}</clTRID>`) : frame;
      };
      fake.queue = [GREETING, OK()];
      const client = new Client(
        new Config({ host: 'h', clid: 'c', password: 'secret', clTRIDPrefix: 'X'.repeat(70) }), fake,
      );
      await client.connect();
      let ok = true;
      try { await client.domain.check(['example1.com.ua']); } catch (e) { ok = false; }
      check('a clTRID clamped to 64 characters by the server is accepted', ok);
    }

    console.log('config: a seconds-shaped timeout is rejected, not silently floored');
    // Timeouts are milliseconds. Quietly raising `readTimeout: 30` to a one-second floor would
    // leave a one-second deadline on a create or a renew, giving up while the registry is still
    // working — the command may have been carried out and billed, and a read timeout is terminal,
    // so the client reports failure for an operation that succeeded.
    const cfgThrows = (opts) => {
      try { new Config({ host: 'h', clid: 'c', password: 'secret', ...opts }); return null; }
      catch (e) { return e; }
    };
    const secondsByMistake = cfgThrows({ readTimeout: 30 });
    check('a seconds-shaped readTimeout raises ConfigError', secondsByMistake instanceof ConfigError);
    check('and the message names the unit and the value that was meant',
      /milliseconds/i.test(secondsByMistake.message) && /30000/.test(secondsByMistake.message));
    check('a zero timeout raises rather than meaning "give up immediately"',
      cfgThrows({ connectTimeout: 0 }) instanceof ConfigError);
    check('a correct millisecond value is accepted', cfgThrows({ readTimeout: 30000 }) === null);
    const defaults = new Config({ host: 'h', clid: 'c', password: 'secret' });
    check('the defaults are unchanged', defaults.readTimeout === 30000 && defaults.connectTimeout === 10000);

    console.log('extValue: a relocated RFC 9038 payload keeps its content');
    // A container has no character data of its own, so `text` is empty and the children must
    // survive by NAME — otherwise the relocated figures are silently dropped.
    const ev = Response.fromXml(
      '<?xml version="1.0"?><epp xmlns="urn:ietf:params:xml:ns:epp-1.0"><response>'
      + '<result code="2005"><msg>err</msg><extValue><value>'
      + '<balance:infData xmlns:balance="http://registry.example/epp/balance-1.0">'
      + '<balance:balance>120.00</balance:balance><balance:creditLimit>500.00</balance:creditLimit>'
      + '</balance:infData></value><reason lang="en">unhandled namespace</reason></extValue></result>'
      + '<trID><svTRID>X</svTRID></trID></response></epp>'
    ).extValues()[0];
    check('a container carries no text of its own', ev.text === '');
    check('and its children survive by name',
      JSON.stringify(ev.values) === JSON.stringify({ balance: '120.00', creditLimit: '500.00' }));
    check('the element and its namespace are reported',
      ev.element === 'infData' && ev.namespace === 'http://registry.example/epp/balance-1.0');
    check('the payload can be re-parsed from xml', ev.xml.includes('120.00'));

    // The ordinary case must not regress: a leaf still answers with its value.
    const leaf = Response.fromXml(
      '<?xml version="1.0"?><epp xmlns="urn:ietf:params:xml:ns:epp-1.0"><response>'
      + '<result code="2005"><msg>err</msg><extValue><value>'
      + '<domain:name xmlns:domain="urn:ietf:params:xml:ns:domain-1.0">bad..name</domain:name></value>'
      + '<reason lang="en">Invalid label</reason></extValue></result>'
      + '<trID><svTRID>X</svTRID></trID></response></epp>'
    ).extValues()[0];
    check('a leaf still reports which value was rejected', leaf.text === 'bad..name');
    check('and has no children', Object.keys(leaf.values).length === 0);
    check('the reason and its language come through', leaf.reason === 'Invalid label' && leaf.lang === 'en');

    console.log('RFC 8807: the sentinel goes only in the element whose value was relocated');
    // The sentinel means "the real value is in the matching loginSec element". Putting it in an
    // element whose value was NOT relocated points the server at something that is not there —
    // which is what a frame-wide flag did to every rotation across the 16-character boundary.
    const LOGINSEC_GREETING = GREETING.replace(
      '</svcExtension>', `<extURI>${Namespaces.LOGINSEC}</extURI></svcExtension>`,
    );
    const SENTINEL = Namespaces.LOGINSEC_SENTINEL;
    const LONG = 'a'.repeat(40);

    const loginFrame = async (password, newPassword) => {
      const { client, fake } = makeClient([LOGINSEC_GREETING, OK()], password);
      await client.connect();
      await client.login(newPassword);
      return parse(fake.written[0]);
    };
    const loginChild = (root, name) => {
      const login = firstLocal(root, 'login');
      for (const c of login.children) if (c.local === name) return c.text;
      return null;
    };

    // Short -> long: only newPW moves. pw must stay LITERAL, or the server is told to look in an
    // extension element that was never emitted and the login is rejected.
    let f = await loginFrame('short1', LONG);
    check('rotating short -> long keeps <pw> literal', loginChild(f, 'pw') === 'short1');
    check('and marks only <newPW> with the sentinel', loginChild(f, 'newPW') === SENTINEL);
    check('the new password travels in loginSec:newPW', textOf(f, 'newPW') !== null
      && allLocal(f, 'newPW').some((n) => n.text === LONG));
    check('and no loginSec:pw is emitted for a short current password',
      allLocal(f, 'pw').filter((n) => n.text === 'short1').length === 1 && allLocal(f, 'pw').length === 1);

    // Long -> short: the mirror image. newPW must stay literal, or the account's new password
    // becomes the sentinel string itself.
    f = await loginFrame(LONG, 'short2');
    check('rotating long -> short marks <pw> with the sentinel', loginChild(f, 'pw') === SENTINEL);
    check('and keeps <newPW> literal', loginChild(f, 'newPW') === 'short2');
    check('the current password travels in loginSec:pw', allLocal(f, 'pw').some((n) => n.text === LONG));
    check('and no loginSec:newPW is emitted for a short new password', allLocal(f, 'newPW').length === 1);

    // Long -> long: both relocate.
    f = await loginFrame(LONG, 'b'.repeat(40));
    check('long -> long relocates both', loginChild(f, 'pw') === SENTINEL && loginChild(f, 'newPW') === SENTINEL);
    check('and both loginSec values are present',
      allLocal(f, 'pw').length === 2 && allLocal(f, 'newPW').length === 2);

    // Short -> short: neither value is relocated, so neither loginSec password element appears —
    // even though the block itself does, to take part in the extension.
    f = await loginFrame('short1', 'short2');
    check('short -> short relocates neither password',
      allLocal(f, 'pw').length === 1 && allLocal(f, 'newPW').length === 1);
    check('and both passwords stay literal',
      loginChild(f, 'pw') === 'short1' && loginChild(f, 'newPW') === 'short2');

    // Opting out removes the block outright, so a caller who wants the pre-8807 frame can have it —
    // but a password that cannot fit in <pw> still travels in the extension, since there is nowhere
    // else for it to go and dropping it would send the wrong password rather than none.
    const optOut = async (password, newPassword) => {
      const { client, fake } = makeClient([LOGINSEC_GREETING, OK()], password, { loginSecurity: false });
      await client.connect();
      await client.login(newPassword);
      return parse(fake.written[0]);
    };
    f = await optOut('short1', 'short2');
    check('opting out sends no loginSec block for short passwords', allLocal(f, 'loginSec').length === 0);
    f = await optOut(LONG, null);
    check('opting out cannot suppress a password that does not fit <pw>', allLocal(f, 'loginSec').length === 1);
  }

  {
    console.log('login: a short password takes part in the extension without travelling in it');
    // Participation and relocation are separate decisions. The block goes out so the server will
    // return its security events — it sends those only to a client that sent the block — while the
    // password itself stays in <pw>, because it fits there and the sentinel would point at nothing.
    const LOGINSEC_GREETING = GREETING.replace(
      '</svcExtension>', `<extURI>${Namespaces.LOGINSEC}</extURI></svcExtension>`);
    const { client, fake } = makeClient([LOGINSEC_GREETING, OK()]);
    await client.connect();
    await client.login();
    const f = parse(fake.written[0]);
    check('the block is sent so the server will answer with its events', allLocal(f, 'loginSec').length === 1);
    check('but the password is NOT relocated into it', allLocal(f, 'pw').length === 1);
    check('the userAgent names app, tech and os', allLocal(f, 'app').length === 1
      && allLocal(f, 'tech').length === 1 && allLocal(f, 'os').length === 1);

    console.log("login: the server's security events are readable");
    const eventReply = '<?xml version="1.0"?><epp xmlns="urn:ietf:params:xml:ns:epp-1.0"><response>'
      + '<result code="1000"><msg>Command completed successfully</msg></result>'
      + `<extension><loginSec:loginSecData xmlns:loginSec="${Namespaces.LOGINSEC}">`
      + '<loginSec:event type="certificate" level="warning" exDate="2026-09-15T00:00:00Z">'
      + 'Your client certificate expires in 30 day(s).</loginSec:event>'
      + '<loginSec:event type="cipher" name="AES128-SHA" level="warning">Weak cipher suite.</loginSec:event>'
      + '</loginSec:loginSecData></extension>'
      + '<trID><svTRID>SRV-1</svTRID></trID></response></epp>';
    const ev = makeClient([LOGINSEC_GREETING, eventReply]);
    await ev.client.connect();
    const events = (await ev.client.login()).securityEvents();
    check('both events are read', events.length === 2);
    check('the certificate event keeps its expiry date', events[0].exDate === '2026-09-15T00:00:00Z');
    check('the certificate event keeps its level', events[0].level === 'warning');
    check('the event text is the human sentence', events[0].text.includes('expires in 30 day(s)'));
    check('the cipher event keeps the suite name', events[1].name === 'AES128-SHA');
    check('a healthy login reports no events', client.greeting.securityEvents().length === 0);
  }

  {
    console.log('response accessors read every object the registry answers with');
    // One fixture per object type, mirroring the PHP and Python suites element for element. These
    // are what a customer reaches for first, and the failure they produce is silent: an accessor
    // that finds the wrong element returns a plausible-looking string.
    const infData = (inner) =>
      '<?xml version="1.0"?><epp xmlns="urn:ietf:params:xml:ns:epp-1.0"><response>' +
      '<result code="1000"><msg>ok</msg></result><resData>' + inner +
      '</resData><trID><svTRID>X</svTRID></trID></response></epp>';
    const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

    const dom = Response.fromXml(infData(
      '<domain:infData xmlns:domain="urn:ietf:params:xml:ns:domain-1.0">' +
      '<domain:name>example.com.ua</domain:name><domain:registrant>c-reg</domain:registrant>' +
      '<domain:contact type="admin">c-admin</domain:contact>' +
      '<domain:contact type="tech">c-t1</domain:contact><domain:contact type="tech">c-t2</domain:contact>' +
      '<domain:contact type="billing">c-bill</domain:contact>' +
      '<domain:ns><domain:hostAttr><domain:hostName>NS1.Example.NET</domain:hostName>' +
      '<domain:hostAddr ip="v4">192.0.2.1</domain:hostAddr>' +
      '<domain:hostAddr>198.51.100.7</domain:hostAddr></domain:hostAttr></domain:ns>' +
      '<domain:host>ns1.example.com.ua</domain:host>' +
      '<domain:authInfo><domain:pw>auth-1</domain:pw></domain:authInfo></domain:infData>'
    ));
    check('role contacts are addressable one role at a time', eq(dom.techContacts(), ['c-t1', 'c-t2']));
    check('and admin/billing are separate', eq(dom.adminContacts(), ['c-admin']) && eq(dom.billingContacts(), ['c-bill']));
    // Registries disagree on `tech` vs `Tech`; an exact match reports "no technical contact" for a
    // domain that has two.
    check('a role is matched case-insensitively', eq(dom.contactsFor('TECH'), ['c-t1', 'c-t2']));
    check('a role nobody holds is an empty list, not an error', eq(dom.contactsFor('reseller'), []));
    check('allContacts() includes the registrant', dom.allContacts().includes('c-reg'));
    check('subordinate hosts are listed (they block a delete)', eq(dom.subordinateHosts(), ['ns1.example.com.ua']));
    const glue = dom.nameserverAddresses();
    check('inline glue is keyed by nameserver, not flattened', eq(Object.keys(glue), ['ns1.example.net']));
    check('and an addr with no @ip defaults to v4', eq(glue['ns1.example.net'][1], { ip: '198.51.100.7', version: 'v4' }));
    // The bug this pins: a document-wide addr search made a DOMAIN look like a well-addressed host.
    check('hostAddresses() stays empty on a domain', eq(dom.hostAddresses(), []));
    check('authInfo() surfaces the transfer secret', dom.authInfo() === 'auth-1');

    const ct = Response.fromXml(infData(
      '<contact:infData xmlns:contact="urn:ietf:params:xml:ns:contact-1.0">' +
      '<contact:id>c-reg</contact:id>' +
      '<contact:postalInfo type="int"><contact:name>Ivan Petrenko</contact:name>' +
      '<contact:addr><contact:street>1 Main St</contact:street><contact:city>Kyiv</contact:city>' +
      '<contact:cc>UA</contact:cc></contact:addr></contact:postalInfo>' +
      '<contact:postalInfo type="loc"><contact:name>Іван Петренко</contact:name>' +
      '<contact:addr><contact:city>Київ</contact:city><contact:cc>UA</contact:cc></contact:addr></contact:postalInfo>' +
      '<contact:fax>+380.441234568</contact:fax>' +
      '<contact:disclose flag="0"><contact:email/></contact:disclose></contact:infData>'
    ));
    // objectName() searched the whole document for <name> and found the person, so contact:info
    // answered with a full name where the caller asked for the handle — and 2303 on the next command.
    check('objectName() on a contact is the HANDLE, not the postal name', ct.objectName() === 'c-reg');
    check('both postal forms are kept apart', ct.postalInfo().loc.name === 'Іван Петренко');
    check('the international form stays available for printing anywhere', ct.postalInfo().int.city === 'Kyiv');
    check('a missing postal part is empty, never null', ct.postalInfo().loc.pc === '');
    check('fax is read', ct.fax() === '+380.441234568');
    check('disclose keeps the flag with the list', eq(ct.disclose(), { flag: false, elements: ['email'] }));
    check('a contact addr container is not read as glue', eq(ct.hostAddresses(), []));

    const hostRes = Response.fromXml(infData(
      '<host:infData xmlns:host="urn:ietf:params:xml:ns:host-1.0"><host:name>ns1.example.com.ua</host:name>' +
      '<host:addr ip="v6">2001:db8::53</host:addr><host:addr>203.0.113.9</host:addr></host:infData>'
    ));
    check('a host object reports its own glue', eq(hostRes.hostAddresses(), [
      { ip: '2001:db8::53', version: 'v6' },
      { ip: '203.0.113.9', version: 'v4' },
    ]));

    const trnRes = Response.fromXml(infData(
      '<domain:trnData xmlns:domain="urn:ietf:params:xml:ns:domain-1.0">' +
      '<domain:name>example.com.ua</domain:name><domain:trStatus>pending</domain:trStatus>' +
      '<domain:reID>ACME</domain:reID><domain:acID>EXAMPLE</domain:acID>' +
      '<domain:acDate>2026-08-21T09:00:00Z</domain:acDate></domain:trnData>'
    ));
    // transferStatus() says a transfer is pending without saying whose, or by when it auto-approves.
    check('a transfer notice carries the counterparty and the deadline',
      trnRes.transfer().requestedBy === 'ACME' && trnRes.transfer().actBy === '2026-08-21T09:00:00Z');

    const chkRes = Response.fromXml(
      '<?xml version="1.0"?><epp xmlns="urn:ietf:params:xml:ns:epp-1.0"><response>' +
      '<result code="1000"><msg>ok</msg></result><resData>' +
      '<domain:chkData xmlns:domain="urn:ietf:params:xml:ns:domain-1.0">' +
      '<domain:cd><domain:name avail="1">free.com.ua</domain:name></domain:cd>' +
      '<domain:cd><domain:name avail="0">taken.com.ua</domain:name><domain:reason>In use</domain:reason></domain:cd>' +
      '</domain:chkData></resData><extension>' +
      '<fee:chkData xmlns:fee="urn:ietf:params:xml:ns:epp:fee-1.0"><fee:currency>UAH</fee:currency>' +
      '<fee:cd avail="1"><fee:objID>free.com.ua</fee:objID><fee:class>premium</fee:class>' +
      '<fee:command name="create"><fee:period unit="y">1</fee:period><fee:fee>5000.00</fee:fee></fee:command>' +
      '</fee:cd></fee:chkData></extension><trID><svTRID>X</svTRID></trID></response></epp>'
    );
    check('an unavailable name reports why', chkRes.unavailableReason('taken.com.ua') === 'In use');
    check('an available name has no reason', chkRes.unavailableReason('free.com.ua') === null);
    check('a name nobody asked about is null, not a false reason', chkRes.unavailableReason('other.com.ua') === null);
    // Charging a premium at the standard price is a loss taken silently on every such registration.
    check('a premium name is flagged', chkRes.isPremium('free.com.ua') === true && chkRes.feeClass('free.com.ua') === 'premium');
  }

  // ------------------------------------------------------------------ update vocabulary
  console.log('update vocabulary: plain words and EPP abbreviations build the same frame');
  {
    // The value of an alias is that it is not a second code path, so this compares the BYTES rather
    // than checking that the plain word "works" - the only claim that stays true when the frame
    // builder changes. It also pins precedence: a codebase migrating one call at a time passes both
    // spellings for a while, and the plain word has to win, because that is what it is moving to.
    const base = { add: { ns: ['ns1.plain.ua'], statuses: ['clientHold'] }, secDNS: { maxSigLife: 604800 } };

    const short = makeClient([GREETING, OK()]);
    await short.client.connect();
    await short.client.domain.update('plain.ua', { ...base, rem: { ns: ['ns9.plain.ua'] }, chg: { registrant: 'C-1' } });

    const plain = makeClient([GREETING, OK()]);
    await plain.client.connect();
    await plain.client.domain.update('plain.ua', { ...base, remove: { ns: ['ns9.plain.ua'] }, change: { registrant: 'C-1' } });

    check("domain:update 'remove'/'change' build the same frame as 'rem'/'chg'",
      short.fake.written[0] === plain.fake.written[0]);

    const both = makeClient([GREETING, OK()]);
    await both.client.connect();
    await both.client.domain.update('plain.ua', {
      ...base,
      rem: { ns: ['ns-ignored.plain.ua'] }, remove: { ns: ['ns9.plain.ua'] },
      chg: { registrant: 'C-IGNORED' }, change: { registrant: 'C-1' },
    });
    check('when both spellings are sent, the plain word is the one that reaches the wire',
      both.fake.written[0] === plain.fake.written[0]);

    const sec = makeClient([GREETING, OK()]);
    await sec.client.connect();
    await sec.client.domain.update('plain.ua', { secDNS: { removeAll: true } });
    check("domain:update secDNS 'removeAll' reaches the wire",
      sec.fake.written[0].indexOf('secDNS:all') !== -1);

    const c1 = makeClient([GREETING, OK()]);
    await c1.client.connect();
    await c1.client.contact.update('C-1', { remStatuses: ['clientDeleteProhibited'], chg: { email: 'contact@example.com' } });
    const c2 = makeClient([GREETING, OK()]);
    await c2.client.connect();
    await c2.client.contact.update('C-1', { removeStatuses: ['clientDeleteProhibited'], change: { email: 'contact@example.com' } });
    check("contact:update 'removeStatuses'/'change' build the same frame",
      c1.fake.written[0] === c2.fake.written[0]);

    const h1 = makeClient([GREETING, OK()]);
    await h1.client.connect();
    await h1.client.host.update('ns1.plain.ua', { remAddresses: ['192.0.2.9'], remStatuses: ['clientUpdateProhibited'] });
    const h2 = makeClient([GREETING, OK()]);
    await h2.client.connect();
    await h2.client.host.update('ns1.plain.ua', { removeAddresses: ['192.0.2.9'], removeStatuses: ['clientUpdateProhibited'] });
    check("host:update 'removeAddresses'/'removeStatuses' build the same frame",
      h1.fake.written[0] === h2.fake.written[0]);

    // The alias must not become a hole in the check that catches 'secdns' for 'secDNS'.
    let refused = null;
    try {
      const bad = makeClient([GREETING, OK()]);
      await bad.client.connect();
      await bad.client.domain.update('plain.ua', { removes: { ns: ['x.ua'] } });
    } catch (e) { refused = e; }
    check('a near-miss spelling is still refused, not silently dropped', refused !== null);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
