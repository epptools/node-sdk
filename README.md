# EppTools — EPP SDK for Node.js

A small, **dependency-free** Node.js client for **any** EPP domain registry — standard
**RFC 5730–5734** EPP over TLS, conventionally on port 700. It speaks the wire protocol directly
(no framework, no server-side code), so you can drop it into any Node.js 16+ project.
Every command frame is standard, schema-valid EPP. Ships with TypeScript types.

**Manual:** [English](docs/en/README.md) · [Українською](docs/uk/README.md) · [Русский](docs/ru/README.md) — every command, every builder step and every response accessor, with examples.

- TLS transport with correct RFC 5734 framing (4-byte length prefix, UTF-8 byte-safe).
- Session: `connect` / `login` / `logout`, with the login services taken from the server
  greeting automatically (never rejected for an unsupported service).
- Full object commands: **domain**, **contact**, **host** (check / info / create / update /
  delete / transfer / renew), plus **poll**.
- Extensions: **secDNS** (RFC 5910), **RGP restore** (RFC 3915), **fees** (RFC 8748:
  prices in `check`, fee agreement on transforms) and **login security** (RFC 8807).
- **Your registry's own extensions, without configuring anything.** No registry's namespaces are
  compiled in: they are read from the `<greeting>` the server sends before you say a word, so this
  works against a registry it has never seen — and keeps working when one changes its URIs. Override
  them in `Config` for a registry whose naming discovery cannot guess.
- Clean `Response` objects (result code, message, availability map, value getters) and typed
  errors. Every command returns a `Promise`.

## Install

```bash
npm install @epptools/sdk
```

Or straight from GitHub, pinned to a release tag, if you would rather not depend on the npm registry:

```bash
npm install github:epptools/node-sdk#v1.0.2
```

Either way it installs as `@epptools/sdk`, so `require('@epptools/sdk')` works as usual.
Requires only Node.js ≥ 16 (uses the built-in `tls` / `net` modules — no dependencies).

## Quick start

```js
const { Client, Config, EppError } = require('@epptools/sdk');

const client = new Client(new Config({
  host: 'epp.registry.example',
  clid: 'YOUR-CLID',
  password: 'your-secret',
  port: 700,          // the EPP convention; some registries differ
  lang: 'uk',         // result-message language, from the greeting's <lang> list
  // caFile: '/path/to/ca.pem',  // only for a private-CA or self-signed certificate
  readTimeout: 30000, // MILLISECONDS (default 30000; minimum 1000)
}));

try {
  await client.connect();   // TLS + read <greeting>
  await client.login();

  const avail = (await client.domain.check(['example.com.ua'])).availability();
  //  => { 'example.com.ua': true }

  const info = await client.domain.info('example.com.ua');
  console.log(info.value('exDate'));

  await client.logout();
} catch (err) {
  if (err instanceof EppError) console.error('EPP error:', err.message);
} finally {
  client.disconnect();
}
```

ESM is supported too: `import { Client, Config } from '@epptools/sdk';`.

## TLS notes

| Scenario | Config |
|---|---|
| Public, browser-trusted certificate | nothing — the defaults (`verifyPeer: true`, `verifyPeerName: true`) are correct |
| Private-CA or self-signed certificate | `caFile` → the PEM bundle of the CA that signed the **server** certificate |
| Mutual TLS (the registry requires a client certificate) | `clientCert` + `clientKey` (+ `clientKeyPassphrase` if the key is encrypted) |
| Hostname mismatch (development only) | `verifyPeerName: false` |

**Which of these applies is your registry's choice, so ask them.** Many present an ordinary
browser-trusted certificate, and then there is nothing to configure. Others run their own CA, whose
certificate is in no system trust store: `caFile` must point at that bundle or the handshake fails
with verification errors.

Authentication is clID + password inside TLS. A client certificate is needed only where the registry
requires mutual TLS, and many additionally restrict access to registered source addresses — that
part is policy, not protocol.

`connectTimeout` and `readTimeout` are in **milliseconds**, with a minimum of 1000. A value below
that is rejected rather than quietly raised, because a one-second deadline on a create or a renew
gives up while the registry is still working.

### When the handshake fails

The commonest first-run failure is certificate verification, and it looks like this:

```
ConnectionError: TLS connect failed: certificate verify failed
```

That almost always means `caFile` is unset or points at the wrong bundle. Check it before anything
else:

```bash
openssl s_client -connect epp.registry.example:700 -CAfile /path/to/registry-ca.pem </dev/null
# "Verify return code: 0 (ok)" means the bundle is right; anything else means it is not.
```

**Do not reach for `verifyPeer: false`.** It makes the message go away and leaves you sending your
clID, your password and every transfer secret to whatever answers on that address, with no way to
tell. If the handshake will not verify, the bundle is wrong — ask the registry for the current one.
`verifyPeerName: false` is a narrower loosening (right certificate, wrong hostname) and is
occasionally reasonable in development; `verifyPeer: false` is not reasonable anywhere.

## Commands

```js
// Session
await client.connect(); await client.login(); await client.logout(); client.disconnect();
await client.login('new-password');          // rotate the EPP password during login
await client.hello();                        // re-read the greeting / keep-alive

// Domain
await client.domain.check(['example1.com.ua', 'example2.com.ua']);
await client.domain.info('example1.com.ua', 'pw');
await client.domain.create('example1.com.ua', {
  years: 1, registrant: 'C1', contacts: { admin: 'C1', tech: 'C2' },
  nameservers: ['ns1.example.net', 'ns2.example.net'], authInfo: 'pw',
  // Or with the glue inlined, where the registry wants the addresses with the name rather
  // than a reference to a host object you created first. A command uses one model or the
  // other — a mixture is a ValidationError here rather than a 2001 from the registry:
  // nameservers: [{ name: 'ns1.example.net', addresses: ['203.0.113.1', '2001:db8::1'] }],
  license: 'TM-123',                                        // where your registry requires one
  secDNS: { dsData: [{ keyTag: 12345, alg: 8, digestType: 2, digest: 'ABCD...' }] },
});
await client.domain.update('example1.com.ua', {
  add: { ns: ['ns3.example.net'], statuses: ['clientHold'] },
  rem: { statuses: ['clientHold'] },
  chg: { registrant: 'C9', authInfo: 'newpw' },
  // DNSSEC (RFC 5910): secDNS: { add: { dsData: [...] }, remAll: true, maxSigLife: 1209600 }
});
await client.domain.renew('example1.com.ua', '2027-01-15', 1);
await client.domain.restore('example1.com.ua');     // RGP restore (op="request")

// Prices (RFC 8748 fee extension) — every `fee` below is OPTIONAL. Omit it and the command
// goes out plainly, charged at the registry's own price. Two independent uses:
//   1) ASK the price before buying: pass a fee query to check().
//   2) CAP what you agree to pay: pass the price you showed your customer on the
//      transform — if the registry's actual price is HIGHER (tariff change, premium
//      name, stale cache), the command is refused (2004) and NOTHING is charged,
//      instead of silently billing you more.
const r = await client.domain.check(['example1.com.ua'], { create: 1, renew: 1 });
r.fees();  // { _currency: 'UAH', 'example1.com.ua': { commands: { create: { fee: '100.00', ... } } } }
// A whole price table in ONE round trip: a LIST of years asks the same operation at each period.
// Up to 20 entries per frame; transfer and restore are one-year operations however many you ask.
const table = await client.domain.check(['example1.com.ua'], { create: [1, 2, 3, 5, 10] }, 'UAH');
table.feeFor('example1.com.ua', 'create', 5);       // '480.00' — or null with a reason in fees()
await client.domain.create('example1.com.ua', { years: 1, registrant: 'C1',
  fee: '100.00' });                          // "I agree to pay up to 100.00" — not a price you set
await client.domain.renew('example1.com.ua', '2027-01-15', 1, { amount: '90.00', currency: 'UAH' });
await client.domain.restore('example1.com.ua', '1000.00');  // your cap, not a published price
await client.domain.delete('example1.com.ua');
await client.domain.transfer('request', 'example1.com.ua', 'pw', 1);

// Contact
await client.contact.check(['c1']);
await client.contact.info('c1', 'pw');
await client.contact.create('c1', {
  name: 'ACME', city: 'Kyiv', cc: 'UA', email: 'contact@example.com', authInfo: 'pw',
  // postalInfos: [{ type: 'int', ... }, { type: 'loc', ... }],   // int + localized
  // disclose: { flag: false, addr: ['int'], voice: true },       // RFC 5733 privacy
});
// No naming scheme of your own? Let the registry choose the handle and read it back. Every call
// mints a fresh one, so a repeat is a second contact rather than a 2302 collision.
const handle = (await client.contact.createAuto({
  name: 'ACME', city: 'Kyiv', cc: 'UA', email: 'contact@example.com',
})).objectName();                             // the minted id appears HERE and nowhere else
await client.contact.update('c1', {
  // Inside an address, PRESENCE decides: a field you leave out keeps its value, and a field given
  // as '' is CLEARED — the only way to remove org, sp or pc. The block needs its city and country
  // whenever you touch it, because the schema makes them required.
  chg: { email: 'new-contact@example.com', postalInfo: { name: 'New Name', city: 'Lviv', cc: 'UA', org: '' } },
  addStatuses: ['clientUpdateProhibited'],
});
await client.contact.delete('c1');
await client.contact.transfer('request', 'c1', 'pw');

// Host
await client.host.check(['ns1.example.net']);
await client.host.info('ns1.example.net');
await client.host.create('ns1.example.net', ['203.0.113.10', '2001:db8::1']);  // v4/v6 auto-detected
await client.host.update('ns1.example.net', { addAddresses: ['203.0.113.11'] });
await client.host.delete('ns1.example.net');

// Poll & balance
const msg = await client.poll.request();     // 1301 with a message, 1300 when empty
if (msg.messageId() !== null) {               // messageCount() = how many remain
  msg.queueMessage();                         // the NOTICE text (<msgQ><msg>) — read this
  msg.queueMessageLang();                     // its language: 'uk' | 'ru' | 'en'
  msg.queueDate();                            // when it was queued
  await client.poll.ack(msg.messageId());     // ack DESTROYS it at the registry
}
const b = (await client.balance()).balance(); // { creditLimit, balance, availableCredit }
```

## Responses

Every command resolves to a `Response`:

```js
r.code();            // int EPP result code (1000, 1001, 2303, ...)
r.isSuccess();       // true for 1xxx
r.isPending();       // true for 1001 (registry resolves via a poll message)
r.message();         // human-readable <msg>
r.messageLang();     // "en" | "uk" | "ua" | "ru"
r.availability();    // { name: boolean } for *:check
r.statuses();        // ['ok'] or ['clientHold', ...]
r.value('exDate');   // first element with that local name
r.values('hostObj'); // all elements with that local name (nameservers live in <domain:hostObj>)
r.balance();         // { creditLimit, balance, availableCredit } or null
r.prices();          // { renewal: { value, currency: 'UAH' }, ... }
r.fees();            // check+fee: per-name RFC 8748 prices (see above), {} when absent
r.chargedFee();      // transform echo: { currency: 'UAH', fee: '100.00' } or null
r.priceChannel();    // domain:info: which price channel those prices belong to, or null
r.license();         // a trademark or licence number, or null
r.rgpStatus();       // ['redemptionPeriod'], ...
r.transferStatus();  // "pending" | "serverApproved" | ... or null
r.dsRecords();       // [{ keyTag, alg, digestType, digest }, ...]
r.keyRecords();      // [{ flags, protocol, alg, pubKey }, ...]
r.isSigned();        // boolean: any DNSSEC data present
r.messageId();       // poll: id to pass to poll.ack(); messageCount() = queue size
r.queueMessage();    // poll: the NOTICE text (<msgQ><msg>), NOT the result banner
r.queueMessageLang();// poll: the notice's language ('uk' | 'ru' | 'en')
r.queueDate();       // poll: when the notice was queued
r.errorReasons();    // extra <extValue><reason> text on a failed command
r.svTRID();          // server transaction id
r.raw();             // the raw XML
```

### Reading an object without touching XML

The getters above return the frame's shape; these return the answer. Everything an `info`, `check`
or `transfer` response carries has a named accessor, so you never index into an object by a string
you had to guess.

```js
// Any object
r.objectName();     // the domain name, the host name or the contact HANDLE
r.roid();           // the registry's own identifier
r.sponsor();        // clID — the registrar it belongs to now
r.createdBy();      // crID          r.createdDate();  // crDate
r.updatedBy();      // upID, or null when never changed   r.updatedDate();
r.authInfo();       // <authInfo><pw> — the transfer secret; never log it

// Domain
r.expiryDate();          // exDate, exactly as the registry wrote it (see the note below)
r.registrant();          // the registrant handle
r.contacts();            // { admin: ['c-1'], tech: ['c-1', 'c-2'] }
r.techContacts();        // just that role — also adminContacts() / billingContacts()
r.contactsFor('tech');   // any role, matched case-insensitively; [] when nobody holds it
r.allContacts();         // every handle including the registrant, de-duplicated
r.nameservers();         // names, whether the registry sent hostObj or hostAttr
r.nameserverAddresses(); // hostAttr glue, keyed by nameserver name
r.subordinateHosts();    // hosts living UNDER this domain — they block a delete
r.transfer();            // { status, requestedBy, requestedAt, actingClient, actBy, expiryDate }
r.transferDate();        // when it last changed hands, or null
r.registrarOfRecord();   // the handle the registry's own WHOIS/RDAP publishes as the registrar
                         // — which for a reseller is not the same party as sponsor()

// Host
r.hostAddresses();  // [{ ip: '192.0.2.1', version: 'v4' }, ...]

// Contact
r.postalInfo();     // { int: {...}, loc: {...} } — name, org, street[], city, sp, pc, cc
r.email();  r.voice();  r.fax();
r.disclose();       // { flag: false, elements: ['email', 'voice'] } or null

// Check + money
r.isAvailable('example.com.ua');       // true | false | null ("the answer said nothing")
r.unavailableReason('taken.com.ua');   // "In use", or null when it is available
r.isPremium('rare.com.ua');            // priced outside the standard list
r.feeClass('rare.com.ua');             // "premium" | "standard" | null
r.creditLimit();  r.currentBalance();  r.availableCredit();
r.feeAmount();    r.feeCurrency();     // what this transform actually charged
r.extValues();    // per-<extValue>: which ELEMENT the registry rejected, plus the reason
```

Two things worth knowing before you build on these:

- **Dates come back as the registry's own string** (`2027-04-01T09:15:00Z`), never a `Date`. The
  registry decides which calendar day a renewal lands on; re-formatting through a local timezone is
  how a client ends up displaying — and renewing against — the day before.
- **Money comes back as an exact decimal string**, never a number. `0.1 + 0.2` is not `0.3` in
  binary floating point, and a balance summed that way drifts. Use a decimal library or integer
  minor units.


## Building a command step by step

The commands that take an options object can also be assembled one named step at a time. Same
command, same frame, same result — the builder calls the ordinary method. What changes is that a
misspelling is a method that does not exist, which your editor tells you about, instead of a key
nobody reads.

```js
const response = await client.domain.createBuilder('your-brand.com.ua')
  .years(1)
  .registrant('acme-01')
  .adminContact('acme-01')
  .techContact('acme-ns1').techContact('acme-ns2')   // accumulates
  .nameserver('ns1.acme.example').nameserver('ns2.acme.example')
  // or, where the registry wants the glue inlined instead of a host object:
  // .nameserverWithGlue('ns1.acme.example', '203.0.113.1', '2001:db8::1')
  .authInfo('D0main-Pw')
  .maxFee('180.00', 'UAH')      // a cap you consent to, not a price you set
  .send();
```

Available on `domain.createBuilder()` / `updateBuilder()`, `contact.createBuilder(id, email)` /
`updateBuilder()`, and `host.updateBuilder()`. Three things worth knowing:

- **Every list step accumulates.** `.techContact('a').techContact('b')` and `.techContact('a','b')`
  are the same thing, so building in a loop or behind an `if` reads the way it behaves.
- **Nothing is sent until `send()`.** Until then the builder is an ordinary value you can keep,
  pass around, or inspect with `toOptions()` — which returns exactly the object the direct call
  takes, so you can log it or queue it.
- **A builder sends once.** Sending twice would be two registrations and two charges, so the second
  `send()` is refused. Build another; they are cheap.

An update builder names the block each change lands in — `addNameserver`, `remStatus`,
`changeRegistrant` — because an EPP update is a delta, and which block a change belongs to is the
whole semantics of the command.

## Reading the message queue

```js
await client.poll.drain(async (notice) => {
  await store(notice.queueMessage(), notice.pendingActionData());
});
```

The order matters and is the reason this helper exists: each notice is acknowledged only **after**
your callback resolves. An ack deletes the notice at the registry permanently, so a loop that acks
first and processes second loses every notice whose processing fails — a transfer request, the
outcome of a pending create — with nothing left to retry from. If your callback rejects, the notice
stays in the queue and the rejection reaches you.

## Session security warnings (RFC 8807)

Where the server offers the Login Security extension, the login carries a small block identifying
this client, and the server answers with anything it wants you to fix about the session:

```js
for (const event of (await client.login()).securityEvents()) {
  // type: certificate | cipher | tlsProtocol | password | newPW | stat | custom
  // level: 'warning' or 'error';  text: a sentence to show an operator
  alert(event.level, event.type, event.text, event.exDate);
}
```

The list is empty on a healthy session, so treat any entry as something to act on. The commonest
one is a client certificate approaching its expiry date — the alternative to hearing about it here
is finding out on the morning it stops working.

A server sends these only to a client that took part in the extension, because announcing a URI is
not evidence of supporting it. That is why the block goes out even when nothing needs to travel in
it. If you would rather stay off the extension, set `loginSecurity: false` in the config; it is
still used for a password longer than the 16 characters the base `<pw>` element can carry, since
there is nowhere else for that to go.

## Error handling

Every failure extends `EppError`, so one `catch` handles everything. Beyond that, a class exists
where the right next step differs — and nowhere else:

| Catch | When | What to do |
|---|---|---|
| `ValidationError` | a value in THIS call is unusable; nothing was sent | fix the arguments |
| `ConfigError` | the client is set up wrong: no host, no credentials | fix the deployment; every call fails until then |
| `ConnectionError` | TLS, timeout, framing | see the TLS notes above; the connection is closed |
| `InsufficientFundsError` | 2104 | **stop the batch**, top up, resume — every later billable command fails the same way |
| `AuthorizationError` | 2201 / 2202 | not yours, or the wrong authInfo |
| `ObjectExistsError` | 2302 | already registered |
| `ObjectDoesNotExistError` | 2303 | stale handle or typo |
| `ObjectStatusError` | 2304 / 2305 | clear the status or association, then repeat |
| `PolicyError` | 2306 / 2308 | the registry's rules refuse this value |
| `SessionError` | 2500–2502 | reconnect and log in again |
| `AuthError` | 2200 | the login itself failed |
| `CommandError` | any other ≥ 2000 | branch on `.eppCode` |

```js
const { CommandError, InsufficientFundsError, ObjectExistsError } = require('@epptools/sdk');

for (const name of namesToRegister) {
  try {
    await client.domain.createBuilder(name).years(1).registrant('acme-01').send();
  } catch (err) {
    if (err instanceof InsufficientFundsError) {
      // Not this name's problem — the account's. Carrying on would produce the same failure
      // for every remaining name.
      alertBilling(err.message);
      break;
    }
    if (err instanceof ObjectExistsError) { taken.push(err.subject() || name); continue; }
    if (err instanceof CommandError && !err.isRetryable()) throw err;  // retrying cannot help
    retryLater.push(name);
  }
}
```

`isRetryable()` is true only for failures about the moment rather than the request (2400, and the
2500-family after you reconnect). It is deliberately false for everything else: retrying a 2302
cannot make the name free, and a loop that treats every failure as transient turns one refusal into
a rate-limit ban.

`ResultCode` has named constants for every code, and `throwOnFailure(false)` turns throwing off
entirely if you would rather read `response.code()` yourself.

### When a transform fails and you do not know whether it happened

A read timeout, a dropped connection or a `ConnectionError` in the middle of a `create`, `renew` or
`transfer` leaves a genuinely unknown outcome: the registry may have carried the command out and
billed you before the reply was lost. This library cannot tell the difference, and neither can you
from the error.

**Do not simply retry.** A blind retry is how a domain gets registered — and paid for — twice.
Instead, ask the registry what is true: `domain.info()` for a create, and compare `expiryDate()`
against what you expected for a renew. Reconcile from that, then retry only if the object really is
in the state you started from. A failure whose outcome you cannot determine deserves an operator's
attention, not an automatic second attempt.

## Custom frames

Anything the high-level API doesn't cover can be built with `Frame` and sent raw:

```js
const { Frame, Namespaces } = require('@epptools/sdk');

const frame = Frame.command('my-trid-1');
const check = frame.ns(frame.verb('check'), Namespaces.DOMAIN, 'domain:check');
frame.ns(check, Namespaces.DOMAIN, 'domain:name', 'example3.com.ua');
const resp = await client.request(frame);     // or client.request(rawXmlString)
```

## Testing

A no-dependency offline self-test (frame building + response parsing, no server):

```bash
npm test
```

## Support

Questions about the library, a frame the registry rejected, or a bug: **https://github.com/epptools/node-sdk/issues**.

When reporting a problem, include the **svTRID** from the response (`svTRID()`) and the clTRID your
client sent — together they identify the exact transaction in the registry's logs, which is what
makes a report answerable without a round trip. Send the frames too if you can, but **redact
`<pw>`, `<newPW>` and `<authInfo>` first**: those are live credentials, and the library masks them
in its own logs for the same reason.

Account, billing and registration questions go to your registry account manager, not here — this
address is for the client libraries.
## License

MIT — see [LICENSE](LICENSE).
