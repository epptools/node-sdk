# Builders

A builder assembles one command a named step at a time and sends it with `send()`.

It builds no XML of its own. `send()` hands the collected options straight to the ordinary method,
so a builder and the equivalent options object produce the **identical frame**, and every check that
applies to one applies to the other. What changes is that an options object accepts any key, while a
builder has no key to misspell: `.yeras(1)` is a method that does not exist, and your editor says so
as you type it.

```js
const response = await client.domain.createBuilder('example.com.ua')
  .years(1)
  .registrant('C1')
  .adminContact('C1')
  .techContact('EXAMPLE-C2').techContact('EXAMPLE-C3')
  .nameserver('ns1.example.com.ua').nameserver('ns2.example.com.ua')
  .authInfo('D0main-Pw')
  .maxFee('180.00', 'UAH')
  .send();
```

## Which commands have a builder

| Builder | Obtained from | `send()` calls | Documented at |
|---|---|---|---|
| `DomainCreateBuilder` | `client.domain.createBuilder(name)` | `domain.create(name, opts)` | [below](#domaincreatebuilder) |
| `DomainUpdateBuilder` | `client.domain.updateBuilder(name)` | `domain.update(name, opts)` | [below](#domainupdatebuilder) |
| `ContactCreateBuilder` | `client.contact.createBuilder(id, email)` | `contact.create(id, opts)` | [below](#contactcreatebuilder) |
| `ContactUpdateBuilder` | `client.contact.updateBuilder(id)` | `contact.update(id, opts)` | [below](#contactupdatebuilder) |
| `HostUpdateBuilder` | `client.host.updateBuilder(name)` | `host.update(name, opts)` | [below](#hostupdatebuilder) |

Those five are exactly the commands that take an options object. Everything else —
`check`, `info`, `delete`, `renew`, `transfer`, `restore`, `host.create`, the poll commands — takes
positional arguments that a builder could not make clearer, so there is none. The classes are
exported (`require('@epptools/sdk').DomainCreateBuilder`) for typing, but you obtain instances from
the handler rather than constructing them.

Every step returns the builder, so steps chain in any order. The order you call them in does not
affect the frame — the library emits every element in the order the schema fixes. Order *within* a
list is kept: nameservers, contacts and addresses go out in the order you added them.

---

## Four rules that hold for every builder

### Every list step accumulates

A step that takes a list adds to what is there. Calling it again, passing several values at once, or
both, are the same thing:

```js
.techContact('EXAMPLE-C2').techContact('EXAMPLE-C3')   // identical
.techContact('EXAMPLE-C2', 'EXAMPLE-C3')               // to this
```

So building in a loop or behind a condition reads the way it behaves:

```js
const b = client.domain.createBuilder('example.com.ua').years(1).registrant('C1');
for (const host of nameserversForThisCustomer) b.nameserver(host);
if (customerWantsPrivacy) b.authInfo(freshSecret());
await b.send();
```

Values are trimmed, and an empty or whitespace-only one is dropped rather than sent as a blank
element — a blank `<domain:hostObj/>` is a syntax error at the registry, not an omission.

Single-value steps — `years`, `registrant`, `authInfo`, `license`, `maxFee`, `maxSigLife`, and the
`change*` steps — **replace**. The last call wins.

### Nothing is sent until `send()`

Until then a builder is an ordinary value. You can keep it, pass it to another function, store it in
a map, or inspect it. No socket is touched and no money is spent.

That is what makes the loop above safe: the frame is written once, at the end, from the finished
option set.

### `toOptions()` returns what the direct call takes

```js
toOptions()   // => the options object, deep-copied
```

The result is exactly the object the equivalent direct call accepts — so you can log it, queue it,
diff it against what you expected, or hand it to the method yourself:

```js
const builder = client.domain.createBuilder('example.com.ua')
  .years(1).registrant('C1').maxFee('100.00', 'UAH');

console.log(builder.toOptions());
// { years: 1, registrant: 'C1', fee: { amount: '100.00', currency: 'UAH' } }

// The same command, sent the other way:
await client.domain.create('example.com.ua', builder.toOptions());
```

**It is a copy, and a deep one.** Handing back the live object would let it change under the caller
every time another step was added, so what you logged and what you sent could differ — which is the
one thing an audit log must never do. The copy also means mutating the returned object changes
nothing about the builder.

`toOptions()` sends nothing and spends nothing. It is the dry run.

### A builder sends once

```js
const b = client.domain.createBuilder('example.com.ua').years(1).registrant('C1');
await b.send();
await b.send();
// ValidationError: DomainCreateBuilder has already been sent. A builder carries one command;
//                  build another rather than re-sending this one.
```

A builder is a command that has not happened yet. Sending it twice would be two registrations and
two charges, and the second is never what the caller meant — least of all inside a retry wrapper
that re-runs a block on failure. Build another; they are free.

If the first `send()` failed and you genuinely want to try again, build a fresh builder — and read
[the unknown-outcome rule](errors.md#when-you-cannot-tell-whether-it-happened) first, because a
transform that failed with a lost reply may already have happened.

---

## When a mistake is caught

| Caught at the step | Caught at `send()` |
|---|---|
| a fee amount that is not a plain decimal | mixing nameserver models in one command |
| a DS record with no digest, a key record with no public key | setting and clearing a domain's `authInfo` together |
| an empty contact role | a contact create with no e-mail |
| an unknown disclosable field | anything the registry itself refuses |
| `removeAllDnssec()` combined with a named removal, in either order | |

Everything in the left column raises a `ValidationError` from the step itself, with the stack
pointing at the line you wrote. Everything in the right column is a property of the finished
command, so it can only be judged once you ask for it — still before a frame is built, and still a
`ValidationError`. See [Errors](errors.md).

---

## DomainCreateBuilder

```js
client.domain.createBuilder(name)   // => DomainCreateBuilder
```

`send()` calls [`domain.create(name, opts)`](domains.md#create), so every option and every result
code on that page applies here unchanged.

| Step | Arguments | What it sets |
|---|---|---|
| `years(years)` | whole number of years | `years` → `<domain:period unit="y">`. Omit it and the registry applies its own default |
| `registrant(handle)` | contact handle | `registrant` → `<domain:registrant>` |
| `contact(role, ...handles)` | role name, one or more handles | appends to `contacts[role]` → one `<domain:contact type="role">` per handle |
| `adminContact(...handles)` | handles | the same with the role fixed to `admin` |
| `techContact(...handles)` | handles | the same for `tech` |
| `billingContact(...handles)` | handles | the same for `billing` |
| `nameserver(host)` | one nameserver name | appends to `nameservers` → `<domain:hostObj>` |
| `nameservers(...hosts)` | nameserver names | the same, several at a time |
| `nameserverWithGlue(host, ...addresses)` | a name and its IPs | appends `{ name, addresses }` → `<domain:hostAttr>` with the glue inlined |
| `authInfo(password)` | the transfer secret | `authInfo` → `<domain:authInfo><domain:pw>` |
| `license(number)` | trademark / licence number | `license` → `<registry:license>`, where your registry requires one |
| `maxFee(amount, currency = null)` | a decimal string, optionally a currency | `fee` → `<fee:create>`, a **cap** on what you agree to pay |
| `dsRecord(keyTag, alg, digestType, digest)` | one DS record | appends to `secDNS.dsData` → `<secDNS:dsData>` |
| `dsRecordWithKey(keyTag, alg, digestType, digest, flags, protocol, keyAlg, pubKey)` | a DS record and the DNSKEY it was computed from | the same, with `<secDNS:keyData>` nested inside the record |
| `keyRecord(flags, protocol, alg, pubKey)` | one public key | appends to `secDNS.keyData` |
| `maxSigLife(seconds)` | signature lifetime in seconds | `secDNS.maxSigLife` |
| `toOptions()` | — | the options, deep-copied |
| `send()` | — | `Promise<Response>` |

### Notes that matter

**The two nameserver models are a choice, never a mixture.** `nameserver()` names a
[host object](hosts.md) the registry already holds; `nameserverWithGlue()` inlines the addresses with
the name. RFC 5731 makes `<domain:ns>` a choice between them, so one command uses one model. Using
both raises a `ValidationError` at `send()` rather than drawing a bare `2001` from the registry that
names no field. Ask your registry which model it takes.

**`maxFee()` is a cap, not a price.** The registry charges its own price; if that price is higher
than your agreement the command is refused with `2004` and nothing is charged. Pass the figure you
quoted to the customer — see [Capping what you agree to pay](balance.md#capping-what-you-agree-to-pay).

**`maxSigLife()` travels only beside a record here.** RFC 5910 requires at least one DS or key record
in a `<secDNS:create>`, so a create carrying a lifetime and no key emits no DNSSEC block at all
rather than an invalid empty one. On an [update](#domainupdatebuilder) it may travel alone.

**`dsRecordWithKey()` is worth trying.** A registry that accepts the DNSKEY beside the DS record
verifies the digest against the key for you, catching a mistyped digest before it reaches the zone.
One that does not accept it answers `2306` rather than ignoring the extra element, so the attempt
costs nothing but a refusal.

### Worked examples

```js
// A signed registration with the glue inlined, contacts in two roles, and a price cap.
const created = await client.domain.createBuilder('example.com.ua')
  .years(2)
  .registrant('C1')
  .adminContact('C1')
  .techContact('EXAMPLE-C2', 'EXAMPLE-C3')
  .nameserverWithGlue('ns1.example.com.ua', '203.0.113.1', '2001:db8::1')
  .nameserverWithGlue('ns2.example.com.ua', '203.0.113.2')
  .authInfo('D0main-Pw')
  .dsRecord(12345, 13, 2, '49FD46E6C4B45C55D4AC')
  .maxSigLife(1209600)
  .maxFee('195.00', 'UAH')
  .send();

created.code();          // 1000, or 1001 when the registry took it offline
created.expiryDate();    // the registry's own string
created.feeAmount();     // what it actually charged
created.svTRID();        // store it against the domain
```

```js
// A registry that requires a trademark or licence number to register the name.
await client.domain.createBuilder('example.com.ua')
  .years(1)
  .registrant('C1')
  .license('TM-2026-000123')
  .send();
```

---

## DomainUpdateBuilder

```js
client.domain.updateBuilder(name)   // => DomainUpdateBuilder
```

`send()` calls [`domain.update(name, opts)`](domains.md#update).

### Which block a step lands in is the whole command

An EPP update is a **delta**, not a replacement. It carries three blocks, and the block a change
sits in *is* the instruction:

| Block | Means | Steps that land there |
|---|---|---|
| `<domain:add>` | attach these, keeping everything already there | `addNameserver`, `addNameservers`, `addContact`, `addStatus` |
| `<domain:rem>` | detach exactly these, leaving the rest | `remNameserver`, `remNameservers`, `remContact`, `remStatus` |
| `<domain:chg>` | replace this value | `changeRegistrant`, `changeAuthInfo`, `clearAuthInfo` |
| `<extension>` | a separate mapping riding along | `restore`, `license`, `maxFee`, every `secDNS` step |

Nothing here is a "set the nameservers to this list" operation, because EPP has none. To replace a
delegation you add the new names and remove the old ones **in the same command**, which is also the
only way to do it without a window in which the domain is under-delegated:

```js
await client.domain.updateBuilder('example.com.ua')
  .addNameserver('ns3.example.com.ua')
  .remNameserver('ns2.example.com.ua')
  .send();
```

Send `add` alone and the old nameserver stays. Send `rem` alone and the domain may drop below its
zone's minimum and stop resolving. The step names make the block visible in the call, which is the
point: reading the chain tells you what the command does to the object.

| Step | Arguments | Block | What it sets |
|---|---|---|---|
| `addNameserver(host)` | one name | `add` | appends to `add.ns` |
| `addNameservers(...hosts)` | names | `add` | the same, several at a time |
| `remNameserver(host)` | one name | `rem` | appends to `rem.ns` |
| `remNameservers(...hosts)` | names | `rem` | the same, several at a time |
| `addContact(role, ...handles)` | role and handles | `add` | appends to `add.contacts[role]` |
| `remContact(role, ...handles)` | role and handles | `rem` | appends to `rem.contacts[role]` |
| `addStatus(...statuses)` | client status values | `add` | appends to `add.statuses` → `<domain:status s="…">` |
| `remStatus(...statuses)` | client status values | `rem` | appends to `rem.statuses` |
| `changeRegistrant(handle)` | contact handle | `chg` | `chg.registrant` |
| `changeAuthInfo(password)` | the new transfer secret | `chg` | `chg.authInfo` |
| `clearAuthInfo()` | — | `chg` | `chg.clearAuthInfo` → `<domain:authInfo><domain:null/>`, which **removes** the secret |
| `restore()` | — | extension | `restore` → `<rgp:restore op="request"/>` (RFC 3915) |
| `license(number)` | trademark / licence number | extension | `license` → `<registry:license>` |
| `maxFee(amount, currency = null)` | decimal, optional currency | extension | `fee` → `<fee:update>`, a cap |
| `addDsRecord(keyTag, alg, digestType, digest)` | one DS record | extension | `secDNS.add.dsData` |
| `remDsRecord(keyTag, alg, digestType, digest)` | one DS record | extension | `secDNS.rem.dsData` — every field must match what the registry holds |
| `addKeyRecord(flags, protocol, alg, pubKey)` | one public key | extension | `secDNS.add.keyData` |
| `remKeyRecord(flags, protocol, alg, pubKey)` | one public key | extension | `secDNS.rem.keyData` |
| `removeAllDnssec()` | — | extension | `secDNS.remAll` → `<secDNS:rem><secDNS:all>true` |
| `maxSigLife(seconds)` | seconds | extension | `secDNS.maxSigLife`; may travel alone here |
| `toOptions()` | — | — | the options, deep-copied |
| `send()` | — | — | `Promise<Response>` |

Only the **client** statuses can be set and cleared: `clientHold`, `clientDeleteProhibited`,
`clientUpdateProhibited`, `clientTransferProhibited`, `clientRenewProhibited`. The `server*` ones
belong to the registry, and `ok` and `inactive` are computed — nobody sets them.

### Notes that matter

**`clearAuthInfo()` is the answer to a leaked transfer code**, and it is not the same as setting an
empty one. An empty password is a value the holder can still present, so the domain stays exactly as
movable as it was and the leak is not closed. Only the null form removes it. Set a fresh secret with
`changeAuthInfo()` when the customer needs one again — and never both in one command: the schema
cannot express both, and the pair is refused with a `ValidationError` at `send()`.

**`removeAllDnssec()` and the named removals are mutually exclusive**, in either order. The protocol
has no way to express both, so the second of the two raises a `ValidationError` at the step, where
the message can say so. To roll a key set with no unsigned window, remove everything and add the new
key in one command:

```js
await client.domain.updateBuilder('example.com.ua')
  .removeAllDnssec()
  .addDsRecord(54321, 13, 2, 'A1B2C3D4E5F60718293A')
  .send();
```

**`restore()` is a command of its own.** A restore may not be accompanied by an `add`, `rem` or
`chg`; the registry refuses the combination. [`client.domain.restore(name, fee)`](domains.md#restore)
is the same command in one call and is what to reach for:

```js
await client.domain.updateBuilder('example.com.ua').restore().maxFee('1000.00').send();
// identical to:
await client.domain.restore('example.com.ua', '1000.00');
```

**An update returns nothing about the object.** Read it back with `info()` when you need to confirm
the result rather than the acceptance.

### Worked example

```js
// Re-delegate, hand the domain to a new holder, lock it against transfers, and roll the
// transfer secret — one command, one round trip, one atomic change at the registry.
const r = await client.domain.updateBuilder('example.com.ua')
  .addNameserver('ns3.example.com.ua')
  .remNameserver('ns2.example.com.ua')
  .addContact('tech', 'EXAMPLE-C4')
  .remContact('tech', 'EXAMPLE-C3')
  .addStatus('clientTransferProhibited')
  .changeRegistrant('EXAMPLE-C9')
  .changeAuthInfo('N3w-D0main-Pw')
  .send();

r.code();        // 1000, or 1001 when the registry took it offline
r.isPending();
```

---

## ContactCreateBuilder

```js
client.contact.createBuilder(id, email)   // => ContactCreateBuilder
```

`send()` calls [`contact.create(id, opts)`](contacts.md#create).

The **id and the e-mail are arguments, not steps**, because RFC 5733 requires both and a step is
something you can forget. Pass `Contact.AUTO_ID` as the id to have the registry mint the handle —
see [createAuto](contacts.md#createauto).

| Step | Arguments | What it sets |
|---|---|---|
| `internationalAddress(parts)` | an address in ASCII | appends a `<contact:postalInfo type="int">` block |
| `localizedAddress(parts)` | the same address in the local script | appends a `<contact:postalInfo type="loc">` block |
| `voice(number)` | `+CC.NNNNNNNNN` | `voice` → `<contact:voice>` |
| `fax(number)` | the same form | `fax` → `<contact:fax>` |
| `authInfo(password)` | the contact's transfer secret | `authInfo` → `<contact:authInfo><contact:pw>` |
| `publish(...fields)` | disclosable field names | `disclose` with the flag set to publish |
| `withhold(...fields)` | disclosable field names | `disclose` with the flag set to withhold |
| `toOptions()` | — | the options, deep-copied |
| `send()` | — | `Promise<Response>` |

### The address parts

Both address steps take one object. The names are spelled out here and mapped to the wire's
abbreviations for you:

| Key | Required | On the wire |
|---|---|---|
| `name` | yes | `<contact:name>` |
| `city` | yes | `<contact:city>` |
| `countryCode` | yes | `<contact:cc>` — the two-letter code |
| `street` | no | one `<contact:street>` per entry, up to 3 |
| `org` | no | `<contact:org>` |
| `stateProvince` | no | `<contact:sp>` |
| `postalCode` | no | `<contact:pc>` |

`int` is the ASCII form, which every registry accepts and which survives being printed, e-mailed and
read by a system that knows no Cyrillic. `loc` is the local script — the address as the registrant
actually wrote it. At least one form is required; send both whenever you have both, since nothing is
discarded and `info` returns everything you sent. Cyrillic in an `int` block is refused with `2005`.

### Disclosure

`publish()` and `withhold()` say the same thing in opposite directions, and each one **replaces** any
previous disclosure setting — they are not additive. Pick one direction and list the fields it
applies to; everything not listed takes the opposite treatment.

The field names are `name`, `org`, `addr`, `voice`, `fax` and `email`. Anything else raises a
`ValidationError` at the step:

```js
.withhold('addres')
// ValidationError: 'addres' is not a disclosable field. Use: name, org, addr, voice, fax, email.
```

`name`, `org` and `addr` exist once per postal form, so both forms are named for you. Withholding
only the ASCII form while the local one stayed public would be a privacy setting that reads as
applied and is not.

### Worked example

```js
const r = await client.contact.createBuilder('C1', 'contact@example.com')
  .internationalAddress({
    name: 'Ivan Petrenko',
    org: 'Pryklad LLC',
    street: ['vul. Khreshchatyk 1'],
    city: 'Kyiv',
    postalCode: '01001',
    countryCode: 'UA',
  })
  .localizedAddress({
    name: 'Іван Петренко',
    org: 'ТОВ «Приклад»',
    street: ['вул. Хрещатик 1'],
    city: 'Київ',
    postalCode: '01001',
    countryCode: 'UA',
  })
  .voice('+380.441234567')
  .authInfo('C0ntact-Pw')
  .withhold('addr', 'voice')
  .send();

r.objectName();    // 'C1' — the handle
r.createdDate();   // the registry's own string
```

```js
// No naming scheme of your own: let the registry mint the handle and read it back.
const { Contact } = require('@epptools/sdk');

const minted = await client.contact.createBuilder(Contact.AUTO_ID, 'contact@example.com')
  .internationalAddress({ name: 'Pryklad LLC', city: 'Kyiv', countryCode: 'UA' })
  .send();

await saveContactHandle(minted.objectName());   // the only place the minted handle appears
```

---

## ContactUpdateBuilder

```js
client.contact.updateBuilder(id)   // => ContactUpdateBuilder
```

`send()` calls [`contact.update(id, opts)`](contacts.md#update).

| Step | Arguments | Block | What it sets |
|---|---|---|---|
| `changeInternationalAddress(parts)` | the parts to change | `chg` | appends a partial `<contact:postalInfo type="int">` |
| `changeLocalizedAddress(parts)` | the parts to change | `chg` | the same for `type="loc"` |
| `changeVoice(number)` | `+CC.NNNNNNNNN` | `chg` | `chg.voice` |
| `changeFax(number)` | the same form | `chg` | `chg.fax` |
| `changeEmail(email)` | e-mail address | `chg` | `chg.email` |
| `changeAuthInfo(password)` | the new transfer secret | `chg` | `chg.authInfo` |
| `publish(...fields)` | disclosable fields | `chg` | `chg.disclose`, flag set to publish |
| `withhold(...fields)` | disclosable fields | `chg` | `chg.disclose`, flag set to withhold |
| `addStatus(...statuses)` | client status values | `add` | `addStatuses` → one `<contact:status s="…">` per entry |
| `remStatus(...statuses)` | client status values | `rem` | `remStatuses` |
| `toOptions()` | — | — | the options, deep-copied |
| `send()` | — | — | `Promise<Response>` |

Everything except the two status steps lands in `<contact:chg>`, which is a **replace** block: what
you name is set, what you do not name is left alone.

### Presence decides, inside an address

Within `changeInternationalAddress()` and `changeLocalizedAddress()`, whether a key is **present** is
the whole instruction:

| You write | What happens |
|---|---|
| the key is absent | the field is not sent, and the registry keeps the value it holds |
| the key holds a value | the field is set to it |
| the key holds `''` | the field is sent empty, which **clears** it |

An empty string is the only way to remove an optional field — `org`, `stateProvince` or
`postalCode`. There is no other spelling for "delete this".

**The address block is a sequence with a required city and country**, so it is emitted whole or not
at all. Touch any part of it — `street`, `city`, `stateProvince`, `postalCode`, `countryCode` — and
give `city` and `countryCode` in the same call. Leaving them out sends them as empty elements, which
clears the city of a contact you meant only to renumber.

Changing one form never disturbs the other.

### There is no `clearAuthInfo()` here

`changeAuthInfo()` **replaces** a contact's transfer secret. RFC 5731 gives a domain a nullable form
for removing one; RFC 5733 defines no equivalent for a contact, so a contact's secret can be replaced
but not removed. Do not reach for an empty password as a substitute: an empty value is still a value
the holder can present.

### Worked example

```js
// The customer has moved and dropped the company name. The local-script form and everything
// else about the contact stay exactly as they are.
await client.contact.updateBuilder('C1')
  .changeInternationalAddress({
    street: ['vul. Svobody 1'],
    city: 'Lviv',
    countryCode: 'UA',
    org: '',                       // '' CLEARS it; leaving the key out would keep it
  })
  .changeEmail('new-contact@example.com')
  .addStatus('clientUpdateProhibited')
  .send();
```

---

## HostUpdateBuilder

```js
client.host.updateBuilder(name)   // => HostUpdateBuilder
```

`send()` calls [`host.update(name, opts)`](hosts.md#update).

| Step | Arguments | Block | What it sets |
|---|---|---|---|
| `addAddress(ip)` | one IPv4 or IPv6 literal | `add` | appends to `addAddresses` → `<host:addr>` |
| `addAddresses(...ips)` | several literals | `add` | the same, several at a time |
| `remAddress(ip)` | one literal | `rem` | appends to `remAddresses` |
| `remAddresses(...ips)` | several literals | `rem` | the same, several at a time |
| `addStatus(...statuses)` | client status values | `add` | `addStatuses` → `<host:status s="…">` |
| `remStatus(...statuses)` | client status values | `rem` | `remStatuses` |
| `toOptions()` | — | — | the options, deep-copied |
| `send()` | — | — | `Promise<Response>` |

IPv4 and IPv6 are told apart for you and written into the `ip` attribute, so you never classify an
address yourself and never mislabel one.

Addresses and statuses going the same direction share one block, and a block with nothing in it is
not emitted. Send at least one change: a frame that expresses none reaches the registry as a command
asking for nothing and comes back `2003`.

**There is no rename step**, by design rather than omission — see
[A host cannot be renamed](hosts.md#a-host-cannot-be-renamed).

### Worked example

```js
// Renumber a nameserver in one command, so it is never left without an address: a subordinate
// host with none is refused (2003), and doing it in two commands passes through that state.
await client.host.updateBuilder('ns1.example.com.ua')
  .addAddress('203.0.113.11')
  .remAddress('203.0.113.10')
  .addStatus('clientUpdateProhibited')
  .send();
```

---

## Builders and TypeScript

Every step is typed, `toOptions()` returns the same interface the direct call takes
(`DomainCreateOptions`, `ContactUpdateOptions`, and so on), and each step returns `this` so a chain
keeps its type. A misspelled step is a compile error rather than a runtime surprise, which is the
whole reason the builders exist.

```ts
import { Client, Config, DomainCreateBuilder } from '@epptools/sdk';

const b: DomainCreateBuilder = client.domain.createBuilder('example.com.ua');
b.years(1).registrant('C1');
const opts = b.toOptions();     // DomainCreateOptions
```

---

[← Manual index](README.md) · [Domains](domains.md) · [Contacts](contacts.md) ·
[Hosts](hosts.md) · [Balance & prices](balance.md) · [Errors](errors.md)
