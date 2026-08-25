# Domains

Domain objects follow **RFC 5731**. Four extensions apply to them: **RFC 5910** (DNSSEC),
**RFC 3915** (RGP restore), **RFC 8748** (fees) and the registry's own extension where it has one.

`client.domain` carries one method per EPP command. Each returns a `Promise<Response>`.

| Method | What goes on the wire |
|---|---|
| `check(names, fee = null, currency = null)` | `<check><domain:check>` (+ `<fee:check>`) |
| `info(name, authInfo = null, hosts = 'all')` | `<info><domain:info>` |
| `create(name, opts = {})` | `<create><domain:create>` |
| `createBuilder(name)` | the same `<create>`, assembled step by step |
| `update(name, opts = {})` | `<update><domain:update>` |
| `updateBuilder(name)` | the same `<update>`, assembled step by step |
| `delete(name)` | `<delete><domain:delete>` |
| `renew(name, curExpDate, years = 1, fee = null)` | `<renew><domain:renew>` |
| `transfer(op, name, authInfo = null, years = null, fee = null)` | `<transfer op="…"><domain:transfer>` |
| `restore(name, fee = null)` | `<update>` carrying `<rgp:restore op="request"/>` |

Every example below assumes a connected, logged-in `client` — see [Quickstart](quickstart.md).
A result code of 2000 or higher rejects the promise with a typed error by default, so the
examples read the success path; see [Errors](errors.md) for the taxonomy and
[Responses](responses.md) for every accessor used here.

---

## check

```js
check(names, fee = null, currency = null)   // => Promise<Response>
```

Sends one `<domain:name>` per entry inside `<domain:check>`. `fee` and `currency` add an
RFC 8748 price query to the same frame; that half is documented in
[Balance & prices](balance.md#asking-a-price).

A name that cannot be registered is **not** an error. It comes back with `avail="0"` and a
reason, inside a `1000` response — so read the answer rather than relying on the absence of
an exception.

```js
const r = await client.domain.check(['example.com.ua', 'taken.com.ua']);

r.availability();
// { 'example.com.ua': true, 'taken.com.ua': false }

r.isAvailable('example.com.ua');        // true
r.unavailableReason('taken.com.ua');    // 'in use'

// null means the answer said nothing about that name — a typo in the argument, or a name
// the registry did not report on. It is NOT the same as "taken", and treating it as false
// skips a registration you meant to make.
r.isAvailable('never-asked.com.ua');    // null
```

`isAvailable()` and `unavailableReason()` match the name case-insensitively, so a name you
uppercased on the way in still finds its answer.

**Result codes:** `1000`. A malformed name draws `2005`, and a zone the registry does not
serve `2307`. A fee query with more than 20 entries is refused with `2306` — the library
stops it first with a `ValidationError`, see [the per-frame cap](balance.md#the-20-entry-cap).

---

## info

```js
info(name, authInfo = null, hosts = 'all')   // => Promise<Response>
```

Sends `<domain:info>` with `<domain:name hosts="…">`. As the sponsoring registrar you get
the full record; for a domain you do not sponsor, pass the domain's `authInfo` as the second
argument to see the full record instead of the public subset.

`hosts` selects which hosts the answer lists:

| Value | The answer lists |
|---|---|
| `'all'` (default) | delegated nameservers and subordinate hosts |
| `'del'` | delegated nameservers only |
| `'sub'` | subordinate hosts only |
| `'none'` | neither |

```js
const d = await client.domain.info('example.com.ua');

d.objectName();        // 'example.com.ua'
d.roid();              // 'D1-EXAMPLE'
d.sponsor();           // 'EXAMPLE' — the account it belongs to now
d.registrarOfRecord(); // the handle the registry's WHOIS/RDAP publishes, or null
d.createdBy();         // crID          d.createdDate();   // crDate
d.updatedBy();         // upID, null when never changed
d.expiryDate();        // '2027-08-16T09:15:00Z' — the server's own string
d.transferDate();      // when it last changed hands, or null

d.statuses();          // ['ok'] or ['clientHold', 'clientTransferProhibited', ...]
d.registrant();        // 'C1'
d.contacts();          // { admin: ['C1'], tech: ['EXAMPLE-C2', 'EXAMPLE-C3'] }
d.techContacts();      // ['EXAMPLE-C2', 'EXAMPLE-C3']
d.contactsFor('billing');   // [] when nobody holds the role — a legitimate answer
d.allContacts();       // every handle including the registrant, de-duplicated

d.nameservers();            // ['ns1.example.com.ua', 'ns2.example.com.ua']
d.nameserverAddresses();    // inline glue keyed by name; {} on a host-object registry
d.subordinateHosts();       // hosts living UNDER this domain

d.isSigned();          // true when any DNSSEC data came back
d.dsRecords();         // [{ keyTag, alg, digestType, digest }, ...]
d.keyRecords();        // [{ flags, protocol, alg, pubKey }, ...]
d.license();           // a trademark or licence number, or null
d.authInfo();          // the transfer secret — never log it
```

Three things about this answer are worth building on deliberately.

**A domain in redemption still reports `ok`.** The redemption states are not
`<domain:status>` values; they arrive in the `<extension>` and come back through
`rgpStatus()`. A client that reads `statuses()` alone sees a plain `ok` on a domain days
from being purged.

```js
if (d.rgpStatus().includes('redemptionPeriod')) {
  // Deleted, still recoverable — see restore() below.
}
```

**`inactive` is not an error.** The registry computes it for a domain with too few
nameservers to be delegated, so a name you have just created without `nameservers` reports
it.

**Dates come back as the registry's own string**, never a `Date`. The registry decides which
calendar day a renewal lands on; re-formatting through a local timezone is how a client ends
up displaying — and renewing against — the day before.

For a domain you sponsor, the answer may also carry your effective renewal and restore
prices; read them with `prices()` and `priceChannel()`, described in
[Balance & prices](balance.md#price-hints-on-domaininfo).

**Result codes:** `1000`; `2202` (wrong `authInfo` as a non-sponsor), `2303` (no such
domain).

---

## create

```js
create(name, opts = {})   // => Promise<Response>
```

Builds `<domain:create>`. Every option key is listed below; **a key this library does not
know is refused before the frame is built**, with the closest known key named. That trade is
deliberate: a misspelling that were merely dropped would still answer `1000`, with the part
you asked for missing and nothing in the response to say so — `secdns` for `secDNS`
registers the domain unsigned, and you find out in the zone.

| Key | Type | On the wire |
|---|---|---|
| `years` | number | `<domain:period unit="y">`; omit it and the registry applies its own default |
| `registrant` | string | `<domain:registrant>` |
| `contacts` | `{ role: handle }` or `{ role: [handles] }` | one `<domain:contact type="role">` per handle |
| `nameservers` | `string[]` or `{ name, addresses }[]` | `<domain:ns>` — see the two models below |
| `nameServers` | same | accepted spelling of `nameservers` |
| `authInfo` | string | `<domain:authInfo><domain:pw>` |
| `license` | string | `<registry:create><registry:license>` — where your registry requires one |
| `secDNS` | `{ dsData, keyData, maxSigLife }` | `<secDNS:create>` (RFC 5910) |
| `fee` | `'100.00'` or `{ amount, currency }` | `<fee:create>` — a cap, see [Balance & prices](balance.md#capping-what-you-agree-to-pay) |

### Contacts: one handle per role, or several

`contacts` takes either form, per role. RFC 5731 allows a repeated
`<domain:contact type="…">`, so each handle gets its own element:

```js
contacts: { admin: 'C1', tech: ['EXAMPLE-C2', 'EXAMPLE-C3'] }
```

Handles are trimmed, and an empty one is dropped rather than sent as a blank element.

### Nameservers: two models, never mixed

A nameserver is either a **name** — a reference to a [host object](hosts.md) that already
exists at the registry — or a name **with its glue addresses inlined**. Ask your registry
which model it takes.

```js
// Host objects, created beforehand with client.host.create():
nameservers: ['ns1.example.com.ua', 'ns2.example.com.ua']

// Or the glue inlined with the name:
nameservers: [
  { name: 'ns1.example.com.ua', addresses: ['203.0.113.1', '2001:db8::1'] },
  { name: 'ns2.example.com.ua', addresses: ['203.0.113.2'] },
]
```

IPv4 and IPv6 are told apart automatically, so you never write the `ip` attribute yourself.

RFC 5731 makes `<domain:ns>` a choice between the two, so one command uses one model. A
mixed list is a `ValidationError` here rather than a bare `2001` from the registry naming no
field.

### authInfo

`<domain:authInfo>` is mandatory on a create, so the library always emits it. Give your own
transfer secret, or omit the key and an empty `<domain:pw/>` goes out, which asks the
registry to apply its own per-zone policy and mint one. Anyone holding this value can move
the domain to another registrar: treat it as a credential, keep it out of logs and tickets,
and roll it after handing it to a customer.

### A complete create, with the reply read

```js
const created = await client.domain.create('example.com.ua', {
  years: 1,
  registrant: 'C1',
  contacts: { admin: 'C1', tech: ['EXAMPLE-C2', 'EXAMPLE-C3'] },
  nameservers: ['ns1.example.com.ua', 'ns2.example.com.ua'],
  authInfo: 'D0main-Pw',
});

created.code();          // 1000, or 1001 when the registry took it offline
created.objectName();    // 'example.com.ua'
created.createdDate();   // '2026-08-16T09:15:00Z'
created.expiryDate();    // '2027-08-16T09:15:00Z' — the registry's own string
created.feeAmount();     // '100.00' when the registry echoed a fee, else null
created.feeCurrency();   // 'UAH'
created.svTRID();        // keep this: it is how support finds the transaction

if (created.isPending()) {
  // 1001 means accepted, not finished. The outcome arrives later as a poll notice whose
  // paTRID carries THIS svTRID — store it, or you cannot tell which pending operation the
  // notice is about. See Poll.
  await recordPending(created.svTRID(), 'example.com.ua');
}
```

### DNSSEC on create

```js
await client.domain.create('example.com.ua', {
  years: 1,
  registrant: 'C1',
  secDNS: {
    maxSigLife: 1209600,
    dsData: [{ keyTag: 12345, alg: 13, digestType: 2, digest: '49FD46E6C4B45C55D4AC' }],
  },
});
```

`secDNS` accepts `dsData`, `keyData` and `maxSigLife`. A DS record may carry the DNSKEY it
was computed from, as `keyData` inside the record — a registry that accepts it verifies the
digest against the key for you, and one that does not answers `2306` rather than ignoring
the extra element:

```js
secDNS: {
  dsData: [{
    keyTag: 12345, alg: 13, digestType: 2, digest: '49FD46E6C4B45C55D4AC',
    keyData: { flags: 257, protocol: 3, alg: 13, pubKey: 'AwEAAb...' },
  }],
}
```

RFC 5910 requires at least one record in a `<secDNS:create>`, so a `secDNS` object holding
neither `dsData` nor `keyData` emits no extension block at all rather than an invalid empty
one.

### Licence on create

Some registries will not register certain names without a trademark or licence number — commonly the
short, valuable ones directly under the TLD:

```js
await client.domain.create('example.com.ua', {
  years: 1, registrant: 'C1', license: 'TM-2026-000123',
});
```

It travels in the registry's **own** extension, whose namespace the client reads from the
`<greeting>` — see [Commands](commands.md#your-registrys-own-extensions). Against a registry that
advertises no such extension this throws `ConfigError`, rather than sending a frame the server would
ignore.

Which names need one is the registry's policy, not the protocol's, so ask yours. Two refusals tell
you that you guessed wrong: a name that requires a licence and did not get one is usually `2003`
(a required parameter is missing), and a licence sent where none is wanted is `2306` (parameter
value policy error).

**Result codes:** `1000`; `1001` when queued; `2003` / `2004` / `2005` / `2306`
(validation and policy), `2104` (insufficient balance — see
[Balance](balance.md)), `2302` (already registered), `2103` (DNSSEC not offered on this
zone), `2307` (zone not served), `2004` when a fee cap is below the real price.

---

## createBuilder

```js
createBuilder(name)   // => DomainCreateBuilder
```

The same command, assembled one named step at a time. It builds no XML of its own — `send()`
hands the options straight to `create()`, so the frame is identical and every check that
applies to one applies to the other. What changes is that a misspelling becomes a method that
does not exist, which your editor tells you about.

```js
const response = await client.domain.createBuilder('example.com.ua')
  .years(1)
  .registrant('C1')
  .adminContact('C1')
  .techContact('EXAMPLE-C2').techContact('EXAMPLE-C3')   // accumulates
  .nameserver('ns1.example.com.ua').nameserver('ns2.example.com.ua')
  .authInfo('D0main-Pw')
  .maxFee('180.00', 'UAH')
  .send();
```

Every step is documented in [Builders](builders.md).

---

## update

```js
update(name, opts = {})   // => Promise<Response>
```

An EPP update is a **delta**, not a replacement. Which block a change belongs to is the whole
semantics of the command:

| Block | Keys | Meaning |
|---|---|---|
| `add` | `ns`, `contacts`, `statuses` | attach these, keeping what is there |
| `rem` | `ns`, `contacts`, `statuses` | detach exactly these |
| `chg` | `registrant`, `authInfo`, `clearAuthInfo` | replace the value |

Alongside them, four keys that ride in the `<extension>`:

| Key | Type | On the wire |
|---|---|---|
| `secDNS` | `{ add, rem, remAll, maxSigLife }` | `<secDNS:update>` (RFC 5910) |
| `restore` | `true` | `<rgp:update><rgp:restore op="request"/>` (RFC 3915) |
| `license` | string | `<registry:update><registry:license>` |
| `fee` | `'100.00'` or `{ amount, currency }` | `<fee:update>` — a cap |

`add.ns` and `rem.ns` take the same two nameserver models as `create`, with the same rule
against mixing them in one command.

```js
const r = await client.domain.update('example.com.ua', {
  add: { ns: ['ns3.example.com.ua'], statuses: ['clientTransferProhibited'] },
  rem: { ns: ['ns2.example.com.ua'] },
  chg: { registrant: 'EXAMPLE-C9', authInfo: 'N3w-D0main-Pw' },
});

r.code();        // 1000, or 1001 when the registry took it offline
r.isPending();
```

You can set and clear only the **client** statuses: `clientHold`, `clientDeleteProhibited`,
`clientUpdateProhibited`, `clientTransferProhibited`, `clientRenewProhibited`. The
`server*` ones belong to the registry, and `ok` and `inactive` are computed — nobody sets
them.

An update returns nothing about the object, so re-read it with `info()` when you need to
confirm the result rather than the acceptance.

### Revoking a leaked transfer code

`chg.clearAuthInfo: true` emits `<domain:authInfo><domain:null/></domain:authInfo>`, which
**removes** the transfer secret.

```js
await client.domain.update('example.com.ua', { chg: { clearAuthInfo: true } });
```

This is not the same as setting an empty one. An empty `<domain:pw/>` stores the empty
string, which is a value the holder can still present, so the domain stays exactly as movable
as it was — the leak is not closed. Only the null form clears it. Set a fresh secret with
`chg.authInfo` when the customer needs one again.

The two are mutually exclusive: the schema cannot express both, and passing them together is
a `ValidationError` before anything is sent.

### DNSSEC on update

An update is a delta here too, and it does not reuse the create shape:

| Key | Effect |
|---|---|
| `add` | `{ dsData: [...], keyData: [...] }` — add these keys |
| `rem` | `{ dsData: [...], keyData: [...] }` — remove exactly these; every field must match what the registry holds |
| `remAll: true` | remove every key |
| `maxSigLife` | change the signature lifetime, in seconds; may travel alone |

```js
// Roll the whole key set in one command, with no window in which the domain is unsigned.
await client.domain.update('example.com.ua', {
  secDNS: {
    remAll: true,
    add: { dsData: [{ keyTag: 54321, alg: 13, digestType: 2, digest: 'A1B2C3D4E5F60718293A' }] },
  },
});
```

`remAll` and a named `rem` are mutually exclusive. A `secDNS` object that expresses no change
at all emits no `<secDNS:update>` block, because an empty one is a syntax error at the
registry (`2003`) rather than a no-op — a client that builds the block unconditionally and
fills it only sometimes fails on the sometimes-empty case.

**Result codes:** `1000`; `1001` when queued; `2003` / `2004` / `2005` / `2306`, `2303`,
`2304` (a status prohibits it), `2305`.

---

## updateBuilder

```js
updateBuilder(name)   // => DomainUpdateBuilder
```

The update builder names the block each change lands in, so the delta is visible in the call:

```js
await client.domain.updateBuilder('example.com.ua')
  .addNameserver('ns3.example.com.ua')
  .remNameserver('ns2.example.com.ua')
  .addStatus('clientTransferProhibited')
  .changeRegistrant('EXAMPLE-C9')
  .clearAuthInfo()
  .send();
```

Nothing is sent until `send()`, and a builder sends once — a second `send()` is refused,
because sending twice would be two commands and, on a billable one, two charges. See
[Builders](builders.md).

---

## delete

```js
delete(name)   // => Promise<Response>
```

```js
const r = await client.domain.delete('example.com.ua');
r.code();   // 1000, or 1001 when queued
```

A domain deleted inside its add-grace window goes immediately. Otherwise it enters
`redemptionPeriod` and can be brought back with [`restore()`](#restore) within the redemption
window; after that it moves to `pendingDelete` and is purged.

Subordinate hosts block a delete. Check for them first — the answer is already in the
`info()` you read:

```js
const d = await client.domain.info('example.com.ua');
if (d.subordinateHosts().length) {
  // 2305 otherwise: these live under the domain and must go first.
}
```

**Result codes:** `1000`; `1001` when queued; `2303`, `2304` (for example a
`clientDeleteProhibited` status), `2305` (something is still attached).

---

## renew

```js
renew(name, curExpDate, years = 1, fee = null)   // => Promise<Response>
```

`curExpDate` must equal the domain's **current expiry date**, and the element is a date, not a
timestamp — `info()` gives you the expiry as a full timestamp. **Pass it straight in:** the library
takes the date part for you.

It takes it as the server wrote it, with no parsing and no timezone conversion. That is deliberate:
EPP timestamps are UTC and the registry's expiry date is the UTC one, so a client that reformats
through a local zone — which `new Date(...)` invites — lands a day either side for every domain
expiring near midnight, and then renews against a date the registry does not hold. Convert to local
time where you display it, never before sending it back.

```js
const d = await client.domain.info('example.com.ua');
const currentExpiry = d.expiryDate();            // '2027-08-16T09:15:00Z'

const r = await client.domain.renew('example.com.ua', currentExpiry, 1);   // sends '2027-08-16'

r.objectName();    // 'example.com.ua'
r.expiryDate();    // the NEW expiry, as the registry wrote it
r.feeAmount();     // what it cost, when the registry echoed a fee
```

A mismatched `curExpDate` is `2105`, and it is a guard, not an inconvenience: it stops a
stale record in your system from renewing a domain that has already been renewed. Read the
current expiry immediately before renewing rather than from a cache.

Pass `fee` to cap what you agree to pay — see
[Balance & prices](balance.md#capping-what-you-agree-to-pay).

**Result codes:** `1000`; `2004` (period out of range), `2105` (`curExpDate` mismatch, or the
domain cannot be renewed), `2104` (insufficient balance), `2303`, `2304`, `2306`.

---

## transfer

```js
transfer(op, name, authInfo = null, years = null, fee = null)   // => Promise<Response>
```

`op` is one of `'request'`, `'approve'`, `'reject'`, `'cancel'`, `'query'`, and it becomes
the `op` attribute of `<transfer>`.

| `op` | Who sends it | Effect |
|---|---|---|
| `request` | the gaining registrar | asks for the domain, with its `authInfo` |
| `query` | either party | reports where the request has got to, changing nothing |
| `approve` | the current sponsor | accepts a pending request |
| `reject` | the current sponsor | refuses a pending request |
| `cancel` | the requesting registrar | withdraws its own request |

```js
const r = await client.domain.transfer('request', 'example.com.ua', 'the-code');

r.code();              // 1001 — accepted, not finished
r.transferStatus();    // 'pending'
r.transfer();
// { status: 'pending',
//   requestedBy: 'EXAMPLE',    requestedAt: '2026-08-16T09:15:00Z',
//   actingClient: 'DELTA',   actBy:       '2026-08-21T09:15:00Z',
//   expiryDate: '2028-08-16T09:15:00Z' }
```

`actBy` is the deadline, and it matters to both sides: **silence completes the transfer.**
Past that moment the registry approves it rather than cancelling it, so a losing registrar
that files the notice instead of answering it loses the domain. Both parties learn about
every step through [poll](poll.md), and while `pendingTransfer` is set no other operation on
the domain is accepted.

`years` maps to `<domain:period>`, and whether a transfer takes one at all is registry policy, not
protocol. Ask yours which of these it does:

- **The transfer renews the domain.** It includes a mandatory renewal, is billable, and extends the
  term. Pass the number of years — usually `1` — or leave `years` as `null` to omit the element and
  take the registry's default. A value the registry does not allow is refused with `2004`.
- **The transfer only moves the domain.** It is free and the term is unchanged. Leave `years` as
  `null` so no `<domain:period>` is sent.

A literal `0` is not a way to say "none": the element's schema type starts at 1, so the frame is
rejected as a syntax error (`2001`) before any policy check runs. `null` is how you say "none".

Where a zone uses no auth codes, leave `authInfo` as `null` and no `<domain:authInfo>` is
sent.

Approving, rejecting, cancelling and querying need neither the code nor a period:

```js
await client.domain.transfer('approve', 'example.com.ua');
await client.domain.transfer('reject',  'example.com.ua');
await client.domain.transfer('cancel',  'example.com.ua');

const q = await client.domain.transfer('query', 'example.com.ua');
q.transfer().actBy;    // how long the sponsor still has
```

**Result codes:** `1000` / `1001`; `2201` (not your object), `2202` (wrong `authInfo`),
`2300` (already pending), `2301` (nothing pending to act on), `2304`, `2306`, `2106` (not
transferable), `2104` on a chargeable transfer with no funds.

---

## restore

```js
restore(name, fee = null)   // => Promise<Response>
```

RFC 3915 restore. This is a domain `<update>` whose only content is
`<rgp:restore op="request"/>`, which is exactly what the method builds — it calls `update()`
with `restore: true`, plus the fee agreement when you pass one, and nothing else: no `add`,
`rem` or `chg` may accompany a restore.

```js
const d = await client.domain.info('example.com.ua');

if (d.rgpStatus().includes('redemptionPeriod')) {
  const r = await client.domain.restore('example.com.ua', '1000.00');
  r.code();        // 1000, or 1001 when it completes offline
  r.feeAmount();   // what the restore cost
}
```

The second argument is the most you agree to pay, not a published price. A restore is one of
the most expensive operations in the lifecycle, and the cap is the difference between a
refusal you can show a customer and a charge you have to explain — see
[Balance & prices](balance.md#capping-what-you-agree-to-pay).

Restore works only inside the redemption window. After it, the name is released and the
answer is that the domain does not exist.

**Result codes:** `1000` or `1001`; `2104`, `2303`, `2304` (the domain is not in redemption),
`2306`.

---

## When a transform fails and you do not know whether it happened

A read timeout or a dropped connection in the middle of a `create`, `renew`, `transfer` or
`restore` leaves a genuinely unknown outcome: the registry may have carried the command out
and billed you before the reply was lost.

**Do not simply retry.** A blind retry is how a domain gets registered — and paid for —
twice. Ask the registry what is true instead: `info()` for a create, and compare
`expiryDate()` against what you expected for a renew. Retry only if the object really is in
the state you started from. See [Errors](errors.md) for the full rule.

---

[← Manual index](README.md) · [Contacts](contacts.md) · [Hosts](hosts.md) ·
[Balance & prices](balance.md) · [Poll](poll.md)
