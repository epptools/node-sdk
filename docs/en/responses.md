# Responses

Every command resolves to a `Response`: the parsed reply, with a named accessor for everything the
registry can send back. You never index into a parsed document by a string you had to guess, and you
never touch XML unless you want to.

Element lookups are by **local name and namespace URI**, never by prefix, so a registry that spells
its prefixes differently does not break a single accessor on this page.

Two rules hold throughout, and they are the ones that cost money when broken:

- **Dates are the registry's own string** — `2027-04-01T09:15:00Z` — never a `Date`. The registry
  decides which calendar day a renewal lands on; re-formatting through a local timezone is how a
  client ends up displaying, and renewing against, the day before.
- **Money is an exact decimal string** — `'100.00'` — never a number. `0.1 + 0.2` is not `0.3` in
  binary floating point, and a balance summed that way drifts. Use a decimal library or integer
  minor units.

## The result

| Accessor | Returns | When the answer carries nothing |
|---|---|---|
| `code()` | the EPP result code as a number: 1000, 1001, 2303 … | `0` — which no EPP reply uses, so it means "this frame carried no result", such as a greeting |
| `isSuccess()` | `true` for any code from 1000 to 1999 | `false` |
| `isPending()` | `true` for exactly 1001 | `false` |
| `isGreeting()` | `true` when the frame is a `<greeting>` rather than a `<response>` | `false` |
| `message()` | the human-readable `<result><msg>` text | `null` |
| `messageLang()` | the language of that text: `'en'`, `'uk'`, `'ua'` or `'ru'` | `null` |
| `statuses()` | the object's status values, e.g. `['ok']` or `['clientHold', 'clientUpdateProhibited']` | `[]` |
| `errorReasons()` | the extra `<reason>` prose the registry attached to a failure | `[]` |
| `extValues()` | the `<extValue>` blocks in full — see below | `[]` |
| `clTRID()` | the transaction id your command sent, echoed back | `null` |
| `svTRID()` | the registry's own transaction id | `null` |

```js
const r = await client.domain.info('example.com.ua');
r.code();        // 1000
r.statuses();    // ['ok']
r.svTRID();      // store this against the domain
```

### `extValues()`

```js
r.extValues();
// [{ element, namespace, text, values, xml, reason, lang }, …]
```

`errorReasons()` gives you the prose alone, which cannot be acted on: it says something was
rejected, never which of the five names you sent. `extValues()` says which. It is how EPP identifies
the offending part of a request, and each entry carries:

| Field | What it holds |
|---|---|
| `element` | the local name of the element the registry objected to, e.g. `name` |
| `namespace` | that element's namespace URI, or `''` |
| `text` | its character data — for the usual case, a leaf like `<domain:name>bad..name</domain:name>`, this is the answer |
| `values` | its children keyed by local name, for when the element is a container rather than a leaf |
| `xml` | the element re-serialised as it arrived, if you would rather re-parse it yourself |
| `reason` | the `<reason>` text beside it |
| `lang` | that reason's language |

A container arrives with an empty `text`, because a container has no character data of its own —
that is what `values` and `xml` are for. A server may also relocate data it could not return
normally into this block (RFC 9038), and the content of `<value>` is reported as data, never
interpreted.

## Object identity

Every object — domain, host or contact — answers these.

| Accessor | Returns | When the answer carries nothing |
|---|---|---|
| `objectName()` | the domain name, the host name, or the contact **handle** | `null` |
| `roid()` | the registry's own identifier for the object | `null` |
| `sponsor()` | the `clID` of the registrar the object belongs to now | `null` |
| `registrarOfRecord()` | the handle the registry's WHOIS and RDAP publish as the registrar | `null` |
| `createdBy()` | the `crID` — who created it | `null` |
| `createdDate()` | the `crDate`, as the registry's own string | `null` |
| `updatedBy()` | the `upID` — who last changed it | `null` when it has never been changed |
| `updatedDate()` | the `upDate` | `null` when it has never been changed |
| `authInfo()` | the object's transfer secret, `<authInfo><pw>` | `null` when the registry withheld it |

`objectName()` reads the direct child of the object block, which matters on a contact: a
document-wide search for a `<name>` element would find the person's full name inside the postal
block first, and feeding that back as a handle draws 2303. On `contact.createAuto()` it is where the
registry's minted handle appears, and the only place it appears — store it.

`sponsor()` and `registrarOfRecord()` are not the same party. `sponsor()` names the account the
object belongs to, which in your own reseller hierarchy is you; `registrarOfRecord()` is what the
registry publishes to the world, which for a reseller is somebody else.

`updatedBy()` paired with `updatedDate()` is what you reconcile against: a change you did not make
came from the registry side or from a support action, not from your system.

**`authInfo()` is a live credential.** It is present only for the sponsoring registrar, and only on
an `info` that asked for it. Anyone holding it can move the domain to another registrar. Never log
it, never put it in a support ticket, and roll it after you have passed it to a customer.

## Domain

| Accessor | Returns | When the answer carries nothing |
|---|---|---|
| `expiryDate()` | the `exDate`, exactly as the registry wrote it | `null` |
| `registrant()` | the registrant contact handle | `null` |
| `contacts()` | role contacts keyed by role: `{ admin: ['c-1'], tech: ['c-1', 'c-2'] }` | `{}` |
| `contactsFor(role)` | the handles in one role, matched case-insensitively | `[]` |
| `adminContacts()` | the administrative contacts | `[]` |
| `techContacts()` | the technical contacts | `[]` |
| `billingContacts()` | the billing contacts | `[]` |
| `allContacts()` | every handle attached in any capacity, registrant included, de-duplicated | `[]` |
| `nameservers()` | the delegation, as lower-cased names | `[]` |
| `nameserverAddresses()` | inline glue keyed by nameserver name | `{}` |
| `subordinateHosts()` | host objects living **under** this domain | `[]` |
| `transfer()` | a transfer in full — see below | `null` |
| `transferStatus()` | the `trStatus`, e.g. `'pending'` or `'serverApproved'` | `null` |
| `transferDate()` | when the object last changed hands | `null` when it never has |
| `rgpStatus()` | redemption statuses, e.g. `['redemptionPeriod']` (RFC 3915) | `[]` |
| `license()` | a trademark or licence number | `null` |
| `dsRecords()` | DNSSEC DS records (RFC 5910) | `[]` |
| `keyRecords()` | DNSSEC key records | `[]` |
| `isSigned()` | `true` when any DS or key record is present | `false` |
| `prices()` | renewal and restore price hints, keyed by operation | `{}` |
| `priceChannel()` | the opaque id of the price catalogue row this domain is billed on | `null` |

`contacts()` deliberately excludes the registrant: it is a separate element with its own meaning, so
read it from `registrant()`. `contactsFor()` matches the role case-insensitively because registries
are inconsistent about `tech` versus `Tech`, and an exact lookup reports "no technical contact" for a
domain that has one. An empty list is a legitimate answer — only the registrant is mandatory
everywhere.

`nameservers()` returns the names however the registry expressed them, whether as `<domain:hostObj>`
(a reference to a host object) or `<domain:hostAttr>` (the name inlined with its glue). Reading only
one of the two models returns an empty list against a registry using the other, which reads as "this
domain has no nameservers". `nameserverAddresses()` is populated only for the inline model:

```js
r.nameservers();
// ['ns1.example.com.ua', 'ns2.example.com.ua']

r.nameserverAddresses();
// { 'ns1.example.com.ua': [{ ip: '203.0.113.1', version: 'v4' },
//                          { ip: '2001:db8::1',  version: 'v6' }] }
```

An empty result from `nameserverAddresses()` does **not** mean the domain is undelegated. Against a
registry answering with host object references, you get the names here and fetch the addresses with
a `host.info()` per name.

`subordinateHosts()` matters before a delete: the registry refuses to delete a domain while
nameserver objects live under it. Check the list first and remove or re-point them.

```js
r.transfer();
// { status: 'pending',
//   requestedBy: 'ACME', requestedAt: '2026-08-10T09:00:00Z',
//   actingClient: 'EXAMPLE', actBy: '2026-08-15T09:00:00Z',
//   expiryDate: '2028-01-15T00:00:00Z' }
```

`transferStatus()` alone says a transfer is pending without saying whose, or how long you have.
`actBy` is the deadline after which the registry decides for you.

```js
r.dsRecords();   // [{ keyTag: 12345, alg: 8, digestType: 2, digest: 'ABCD…' }]
r.keyRecords();  // [{ flags: 257, protocol: 3, alg: 8, pubKey: 'AwEAA…' }]
```

`prices()` returns `{ renewal: { value: '90.00', currency: 'UAH' }, … }` — the registry's price hints
on an `info`, keyed by operation. For a quote you can act on before buying, ask with a fee query on
`domain.check()` and read [`fees()`](#check-and-money). `priceChannel()` is per-domain rather than
per-zone: a domain registered long ago may sit on a different row of the catalogue from the one a
new registration in the same zone would use.

## Host

| Accessor | Returns | When the answer carries nothing |
|---|---|---|
| `hostAddresses()` | the host's glue addresses: `[{ ip: '203.0.113.10', version: 'v4' }, …]` | `[]` |

Only a host **inside** the zone it serves carries glue. For an external nameserver the registry
returns none, and that is normal rather than a missing answer. An absent version attribute is read
as `v4`, which is the host schema's own default.

This accessor is scoped to the host object itself. A domain's inline glue is
`nameserverAddresses()`, which keeps each address with the nameserver it belongs to.

## Contact

| Accessor | Returns | When the answer carries nothing |
|---|---|---|
| `postalInfo()` | the postal addresses keyed by form: `int` and `loc` | `{}` |
| `email()` | the contact's e-mail address | `null` |
| `voice()` | the voice number, in the EPP `+CC.NNNNNNNNN` form | `null` |
| `fax()` | the fax number, same form | `null` |
| `disclose()` | the disclosure preference — see below | `null` when the contact carries none and registry policy alone applies |

```js
r.postalInfo();
// { int: { name: 'ACME LLC', org: '', street: ['1 Example St'],
//          city: 'Kyiv', sp: '', pc: '01001', cc: 'UA' },
//   loc: { name: 'ТОВ АКМЕ',  org: '', street: ['вул. Прикладна, 1'],
//          city: 'Київ', sp: '', pc: '01001', cc: 'UA' } }
```

`int` is the ASCII form, which every registry accepts and which survives being printed, e-mailed and
read by a system that knows no Cyrillic. `loc` is the local script — the address as the registrant
actually wrote it. A contact may carry either or both, and parts the registry did not send come back
as `''` rather than missing, so you can read them without guarding every access.

```js
r.disclose();
// { flag: false, elements: ['email', 'voice', 'name:int'] }
```

`flag` is the whole meaning of the list: `true` means the listed elements **may** be published,
`false` means they must be withheld. The elements not listed take the opposite of the flag, so
reading the list without the flag inverts the privacy setting. Fields that exist once per postal
form are reported as `name:int`, `addr:loc` and so on.

## Check and money

| Accessor | Returns | When the answer carries nothing |
|---|---|---|
| `availability()` | the whole check answer: `{ 'example.com.ua': true, 'taken.com.ua': false }` | `{}` |
| `isAvailable(name)` | `true` or `false` for one name, matched case-insensitively | **`null`** — the answer said nothing about it |
| `unavailableReason(name)` | why it is not available, e.g. `'In use'` or `'Reserved'` | `null` when it is available, or the registry gave no reason |
| `fees()` | the RFC 8748 price table, keyed by name — see below | `{}` |
| `feeFor(name, operation, years = 1)` | one quote, as an exact decimal string | `null` |
| `feeClass(name)` | the registry's fee class, e.g. `'premium'` or `'standard'` | `null` |
| `isPremium(name)` | `true` when the name is priced outside the standard list | `false` |
| `chargedFee()` | what a transform actually charged: `{ currency: 'UAH', fee: '100.00' }` | `null` |
| `feeAmount()` | just the amount of that | `null` |
| `feeCurrency()` | just its currency | `null` |
| `balance()` | the account block: `{ creditLimit, balance, availableCredit }` | `null` when the response is not a balance answer |
| `creditLimit()` | your credit limit | `null` |
| `currentBalance()` | your current balance | `null` |
| `availableCredit()` | what you can still spend: balance plus any credit limit | `null` |

**`isAvailable()` returns three things, not two.** `null` means the reply carried no verdict for that
name at all, which is not the same as "taken" and must not look the same to the line that registers
it. Compare against `true` explicitly:

```js
if (check.isAvailable(name) !== true) return;    // covers false AND null
```

```js
const r = await client.domain.check(['example.com.ua'], { create: [1, 2, 5] }, 'UAH');

r.fees();
// { _currency: 'UAH',
//   'example.com.ua': {
//     avail: true,
//     reason: null,
//     class: 'premium',                      // present only when the registry gave one
//     commands: { create: { years: 1, fee: '100.00' } },
//     periods: [ { op: 'create', years: 1, fee: '100.00' },
//                { op: 'create', years: 2, fee: '195.00' },
//                { op: 'create', years: 5, fee: '480.00' } ] } }

r.feeFor('example.com.ua', 'create', 5);   // '480.00'
```

`_currency` is the currency the whole table is quoted in. Per name, `avail: false` with a `reason`
is how the registry says it cannot price that name — an unserved zone, or a currency it does not
price in — and that is a separate answer from the name being unavailable.

`commands` holds one entry per operation and `periods` holds every quote. Asking one operation at
several periods brings back several quotes with the same operation name, so use `feeFor()` for a
specific figure rather than indexing `commands`. `transfer` and `restore` are one-year operations
however many years you ask for; read those back at 1.

`isPremium()` returning `false` is not a promise of the standard price — it means the answer declared
no special class. Charge from `fees()`, and re-state the fee on the transform itself so the registry
can refuse rather than overcharge. Amounts shown here are illustrative, not the registry's tariff.

`chargedFee()`, `feeAmount()` and `feeCurrency()` read the echo on a successful transform that
carried a fee agreement — the amount you were actually billed, which is the number to reconcile
against, not the one you quoted.

The balance accessors work on the answer to `client.balance()`; all three figures are exact decimal
strings. See [Balance](balance.md).

## Poll

| Accessor | Returns | When the answer carries nothing |
|---|---|---|
| `messageId()` | the id to pass to `poll.ack()` | `null` — there is no notice in this reply |
| `messageCount()` | how many notices remain in the queue | `0` |
| `queueMessage()` | the **notice text**, from `<msgQ><msg>` | `null` |
| `queueMessageLang()` | that notice's language: `'uk'`, `'ru'` or `'en'` | `null` |
| `queueDate()` | when the notice was queued | `null` |
| `pendingActionData()` | the outcome of an operation processed offline — see below | `null` |

`queueMessage()` is **not** `message()`. `message()` returns the command-result banner
("Command completed successfully; ack to dequeue"), which is identical on every poll reply. Reading a
notice with `message()` hands you that constant string while the real content is discarded — and the
ack then destroys it at the registry permanently.

```js
r.pendingActionData();
// { object: 'example.com.ua',
//   success: true,
//   clTRID: 'NODEJS-SDK-20260816103012-24191-0003',
//   svTRID: 'SRV-19700101103512-24191-00007',
//   date:   '2026-08-16T10:31:00Z' }
```

This is how a deferred command reports back (RFC 5731 §3.3, RFC 5733 §3.3). You send a create, get
1001 with an `svTRID`, and the answer arrives later in the queue. Three things about reading it:

- **`success` is the only thing that says whether it worked.** The surrounding result code 1301
  means "here is a message", not "your operation succeeded". Reading the result code instead makes
  every poll answer look like a success.
- **`svTRID` is the id of the original command**, not of this poll reply. Match it against the one
  you stored with the 1001 to know which pending operation this is about. Poll is a queue; the
  notice at the head is not necessarily about the most recent thing you did.
- `date` is when the action completed, not when you polled.

The full loop, including why an ack must come after your processing and not before, is in
[Poll](poll.md).

## Session security and the greeting

| Accessor | Returns | When the answer carries nothing |
|---|---|---|
| `securityEvents()` | the RFC 8807 warnings about this session | `[]` — a healthy session |
| `serviceObjUris()` | the object namespaces a greeting advertises | `[]` |
| `serviceExtUris()` | the extension namespaces a greeting advertises | `[]` |

```js
for (const event of (await client.login()).securityEvents()) {
  // { type, level, text, name?, exDate?, value?, duration?, lang? }
  alert(event.level, event.type, event.text, event.exDate);
}
```

`type` is one of `password`, `certificate`, `cipher`, `tlsProtocol`, `newPW`, `stat` or `custom`;
`level` is `'warning'` or `'error'`. Because the list is empty on a healthy session, any entry is
something to act on — a certificate expiring in three weeks arrives here as `type: 'certificate'`
with the date in `exDate`. See [Session](session.md#login-security-rfc-8807).

The two service accessors read a greeting, which is what `connect()` and `hello()` resolve to.

## Raw access

| Accessor | Returns | When the answer carries nothing |
|---|---|---|
| `value(local)` | the first element anywhere with that local name, trimmed | `null` |
| `values(local)` | every element with that local name, trimmed | `[]` |
| `resData()` | the `<resData>` element of the parsed tree | `null` |
| `root()` | the parsed tree root | the root is always present on a parsed frame |
| `raw()` | the response XML exactly as it arrived | the frame as read |
| `Response.fromXml(xml)` | parses a frame into a `Response` (static) | throws `ConnectionError` on anything that is not one well-formed element tree |

```js
r.value('exDate');     // an element the named accessors do not cover
r.values('hostObj');   // every one of them
```

These are the escape hatch for an extension this library has no accessor for, and the way to read a
[raw frame](commands.md#raw-frames) you assembled yourself. Both match by local name and ignore
namespaces, so `value('name')` finds the first `<name>` in document order whatever its prefix —
prefer the named accessor whenever one exists, since it knows *which* element it wants.

`Response.fromXml()` rejects a truncated frame rather than returning a partial tree, which is what
keeps a half-delivered create from reading back as a finished, billable registration.

---

[← Manual index](README.md)
