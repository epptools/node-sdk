# Contacts

Contact objects follow **RFC 5733**. They come first in every provisioning flow: a
[domain](domains.md) references its registrant and role contacts by handle, so the contacts
have to exist before the domain does.

`client.contact` carries one method per EPP command. Each returns a `Promise<Response>`.

| Method | What goes on the wire |
|---|---|
| `check(ids)` | `<check><contact:check>` |
| `info(id, authInfo = null)` | `<info><contact:info>` |
| `create(id, opts = {})` | `<create><contact:create>` |
| `createAuto(opts = {})` | the same `<create>` under the reserved id |
| `createBuilder(id, email)` | the same `<create>`, assembled step by step |
| `update(id, opts = {})` | `<update><contact:update>` |
| `updateBuilder(id)` | the same `<update>`, assembled step by step |
| `delete(id)` | `<delete><contact:delete>` |
| `transfer(op, id, authInfo = null)` | `<transfer op="…"><contact:transfer>` |

Every example below assumes a connected, logged-in `client` — see [Quickstart](quickstart.md).
See [Errors](errors.md) for the exception taxonomy and [Responses](responses.md) for every
accessor used here.

---

## check

```js
check(ids)   // => Promise<Response>
```

Sends one `<contact:id>` per entry. `avail` here means the **identifier is free**, not that a
contact exists: you are testing a name you want to claim.

```js
const r = await client.contact.check(['C1', 'EXAMPLE-C2']);

r.availability();                  // { 'C1': false, 'EXAMPLE-C2': true }
r.isAvailable('EXAMPLE-C2');      // true
r.unavailableReason('C1');// 'in use', or null
```

If you have no naming scheme of your own, skip the check-then-claim race entirely and let the
registry mint the handle — see [createAuto](#createauto).

**Result codes:** `1000`.

---

## info

```js
info(id, authInfo = null)   // => Promise<Response>
```

As the sponsoring registrar you get the full record. For a contact you do not sponsor, pass
its `authInfo` to see the full record instead of the public subset.

```js
const c = await client.contact.info('C1');

c.objectName();     // 'C1' — the HANDLE, not the person's name
c.roid();
c.sponsor();        // clID
c.createdBy();      c.createdDate();
c.updatedBy();      c.updatedDate();
c.statuses();       // ['ok'] or ['linked', 'clientUpdateProhibited', ...]

c.email();          // 'contact@example.com'
c.voice();          // '+380.441234567'
c.fax();            // null when the contact carries none
c.authInfo();       // the transfer secret — never log it

c.postalInfo();
// { int: { name: 'Ivan Petrenko', org: 'Pryklad LLC', street: ['vul. Khreshchatyk 1'],
//          city: 'Kyiv', sp: '', pc: '01001', cc: 'UA' },
//   loc: { name: 'Іван Петренко', ... } }

c.disclose();       // { flag: false, elements: ['email', 'voice'] } or null
```

`postalInfo()` returns only the forms the registry actually sent, keyed by form; a contact
commonly carries just one. Missing parts come back as `''` rather than as absent keys, so a
template can read `.pc` without guarding.

A `linked` status means the contact is referenced by at least one object, which is what makes
a delete fail with `2305`.

**Result codes:** `1000`; `2202` (wrong `authInfo` as a non-sponsor), `2303`.

---

## create

```js
create(id, opts = {})   // => Promise<Response>
```

| Key | Type | On the wire |
|---|---|---|
| `name` | string | `<contact:name>` in the single postal block |
| `org` | string | `<contact:org>`, sent only when non-empty |
| `street` | `string[]` | one `<contact:street>` per line, up to 3 |
| `city` | string | `<contact:city>` |
| `sp` | string | `<contact:sp>` (state / province), sent only when non-empty |
| `pc` | string | `<contact:pc>` (postal code), sent only when non-empty |
| `cc` | string | `<contact:cc>` — the two-letter country code |
| `type` | `'int'` \| `'loc'` | the `type` attribute of that block; defaults to `'int'` |
| `postalInfos` | `PostalInfo[]` | one `<contact:postalInfo>` per entry — use this for both forms |
| `voice` | string | `<contact:voice>`, sent only when non-empty |
| `fax` | string | `<contact:fax>`, sent only when non-empty |
| `email` | string | `<contact:email>` — **required** |
| `authInfo` | string | `<contact:authInfo><contact:pw>` |
| `disclose` | object | `<contact:disclose>` — see [Disclosure](#disclosure) |

A key this library does not know is refused before the frame is built, with the closest known
key named. A misspelled key that were merely dropped would still answer `1000`, with the
field you meant to set missing and nothing in the response to say so.

`email` is required by RFC 5733, so an empty one raises a `ValidationError` here rather than
travelling to the registry to come back as `2003`.

`<contact:authInfo>` is always emitted. Omit the key and an empty `<contact:pw/>` goes out,
which asks the registry to apply its own policy.

### The two postal forms

A contact carries one or two `<contact:postalInfo>` blocks, and the difference is not
cosmetic:

| Form | Script | Purpose |
|---|---|---|
| `int` | **ASCII / Latin only** | the form the registry can present to any party anywhere |
| `loc` | the local script, e.g. Cyrillic | the address as the registrant actually wrote it |

Cyrillic in an `int` block is refused with `2005`. At least one block is required; send both
whenever you have both — nothing is discarded, and `info` returns everything you sent.

The flat keys build a single block. For both forms, use `postalInfos`:

```js
const r = await client.contact.create('C1', {
  postalInfos: [
    { type: 'int',
      name: 'Ivan Petrenko', org: 'Pryklad LLC',
      street: ['vul. Khreshchatyk 1'], city: 'Kyiv', pc: '01001', cc: 'UA' },
    { type: 'loc',
      name: 'Іван Петренко', org: 'ТОВ «Приклад»',
      street: ['вул. Хрещатик 1'], city: 'Київ', pc: '01001', cc: 'UA' },
  ],
  voice: '+380.441234567',
  email: 'contact@example.com',
  authInfo: 'C0ntact-Pw',
});

r.code();          // 1000
r.objectName();    // 'C1'
r.createdDate();   // '2026-08-16T09:15:00Z' — the registry's own string
```

Phone and fax numbers go in the EPP form `+CC.NNNNNNNNN`.

### Disclosure

`disclose` is RFC 5733's privacy switch. `flag` decides the direction and the listed elements
are what it applies to; everything **not** listed takes the opposite treatment, so the list
means nothing without the flag.

```js
// Publish nothing but the e-mail address and the voice number.
disclose: { flag: false, addr: ['int', 'loc'], name: ['int', 'loc'], org: ['int', 'loc'] }

// Or the other direction: these may be published.
disclose: { flag: true, voice: true, email: true }
```

| Field | Value |
|---|---|
| `flag` | `true` = the listed elements may be published; `false` = they must be withheld |
| `name`, `org`, `addr` | an array of forms: `['int']`, `['loc']` or both |
| `voice`, `fax`, `email` | `true` to list the element |

`name`, `org` and `addr` exist once per postal form, so the choice is per form. Naming only
`['int']` leaves the local-script form public — a privacy setting that reads as applied and
is not.

The flag is read for what it means, not for JavaScript truthiness: `'0'`, `'false'` and `''`
all arrive from HTML forms and JSON payloads, and all three are truthy strings in JS. Here
they mean **withhold**, the way the caller wrote it.

Read the preference back with `disclose()`, which returns `{ flag, elements }` with the forms
suffixed — `['name:int', 'name:loc', 'email']`.

**Result codes:** `1000`; `2003` (no postal block, or no e-mail), `2005` (bad syntax — a
malformed e-mail, or Cyrillic in an `int` block), `2302` (the id is taken), `2306`.

---

## createAuto

```js
createAuto(opts = {})   // => Promise<Response>
Contact.AUTO_ID         // 'autonic' — the reserved id
```

Sends the same create under the reserved contact id, which asks the registry to **choose the
handle** instead of you naming it. The minted handle comes back in the response, and that
reply is the only place it appears:

```js
const r = await client.contact.createAuto({
  name: 'Pryklad LLC', city: 'Kyiv', cc: 'UA', email: 'contact@example.com',
});

const handle = r.objectName();   // 'c-9f4b2ad10e' — store this now
await saveContactHandle(handle);
```

Use it when you have no naming scheme of your own, and when you would otherwise write a retry
loop around `2302` because someone else claimed the handle between your `check` and your
`create`. **Every call mints a fresh handle**, so a repeat is a second contact rather than a
collision — which also means a blind retry after a lost reply leaves you with two contacts,
not one. Reconcile before retrying.

The value is a request, never a name: it is not stored as a handle, so it stays usable by
everyone. If you would rather pass it explicitly — through the builder, for instance — it is
exported as a constant:

```js
const { Contact } = require('@epptools/sdk');

await client.contact.createBuilder(Contact.AUTO_ID, 'contact@example.com')
  .internationalAddress({ name: 'Pryklad LLC', city: 'Kyiv', countryCode: 'UA' })
  .send();
```

**Result codes:** as [create](#create), minus `2302` — there is no id to collide with.

---

## createBuilder

```js
createBuilder(id, email)   // => ContactCreateBuilder
```

The same command, assembled one named step at a time. The id and the e-mail are arguments
rather than steps, because the registry requires both and a step is something you can forget.
`send()` calls `create()`, so the frame is identical.

```js
const r = await client.contact.createBuilder('C1', 'contact@example.com')
  .internationalAddress({
    name: 'Ivan Petrenko', org: 'Pryklad LLC',
    street: ['vul. Khreshchatyk 1'], city: 'Kyiv', postalCode: '01001', countryCode: 'UA',
  })
  .localizedAddress({
    name: 'Іван Петренко', city: 'Київ', countryCode: 'UA',
  })
  .voice('+380.441234567')
  .authInfo('C0ntact-Pw')
  .withhold('addr', 'voice')
  .send();
```

Every step is documented in [Builders](builders.md).

---

## update

```js
update(id, opts = {})   // => Promise<Response>
```

| Key | Type | On the wire |
|---|---|---|
| `addStatuses` | `string[]` | a single `<contact:add>` holding one `<contact:status s="…">` per entry |
| `remStatuses` | `string[]` | a single `<contact:rem>`, likewise |
| `chg` | object | `<contact:chg>` — the fields below |

`chg` accepts `postalInfo` (one block), `postalInfos` (an array of them), `voice`, `fax`,
`email`, `authInfo` and `disclose`, and emits them in the order RFC 5733 fixes.

```js
await client.contact.update('C1', {
  chg: { email: 'new-contact@example.com', voice: '+380.441234599' },
  addStatuses: ['clientUpdateProhibited'],
});
```

You can set and clear only the **client** statuses. `linked` and `ok` are computed by the
registry, and the `server*` ones belong to it.

### The partial-update rule: presence decides

Inside a postal block, whether a key is **present** is the whole instruction:

| You write | What happens |
|---|---|
| the key is absent | the field is not sent, and the registry keeps the value it holds |
| the key holds a value | the field is set to it |
| the key holds `''` | the field is sent empty, which **clears** it |

An empty string is the only way to remove an optional field — `org`, `sp` or `pc`. There is
no other spelling for "delete this".

```js
// Move the contact and drop the organisation, leaving the name and the local-script form
// exactly as they are.
await client.contact.update('C1', {
  chg: {
    postalInfo: { type: 'int', city: 'Lviv', cc: 'UA', street: ['vul. Svobody 1'], org: '' },
  },
});
```

**The address block is a sequence with a required city and country**, so it is emitted whole
or not at all. Touch any part of it — `street`, `city`, `sp`, `pc`, `cc` — and the whole
block is sent. Give `city` and `cc` on every such change: leave them out and they go to the
registry as empty elements, which clears the city of a contact you meant only to renumber.

Name and organisation sit outside that block, so changing `name` alone sends `name` alone.

Changing one form leaves the other untouched: `{ type: 'loc', … }` never disturbs the
international block.

### There is no clearAuthInfo for a contact

`chg.authInfo` **replaces** the transfer secret. RFC 5731 gives a domain a nullable form for
removing one; RFC 5733 defines no equivalent for a contact, so a contact's secret can be
replaced but not removed. Do not reach for an empty password as a substitute: an empty value
is still a value the holder can present.

**Result codes:** `1000`; `2303`, `2304`, `2306`.

---

## updateBuilder

```js
updateBuilder(id)   // => ContactUpdateBuilder
```

```js
await client.contact.updateBuilder('C1')
  .changeEmail('new-contact@example.com')
  .changeInternationalAddress({ city: 'Lviv', countryCode: 'UA', org: '' })
  .addStatus('clientUpdateProhibited')
  .send();
```

The same presence rule applies: a field you do not pass is not sent, and `''` clears. Nothing
reaches the registry until `send()`, and a builder sends once. See [Builders](builders.md).

---

## delete

```js
delete(id)   // => Promise<Response>
```

```js
await client.contact.delete('C1');
```

**A contact still referenced by a domain cannot be deleted** — the registry answers `2305`,
which arrives as an `ObjectStatusError`. Detach it first: change the domain's registrant or
role contact with [`domain.update()`](domains.md#update), then delete. `allContacts()` on a
domain info response tells you which handles a domain still holds.

**Result codes:** `1000`; `2303`, `2305` (still linked).

---

## transfer

```js
transfer(op, id, authInfo = null)   // => Promise<Response>
```

`op` is one of `'request'`, `'approve'`, `'reject'`, `'cancel'`, `'query'`. A contact
transfer carries no period and no fee — only the id and, for a request, the contact's
`authInfo`.

| `op` | Who sends it | Effect |
|---|---|---|
| `request` | the gaining registrar | asks for the contact, with its `authInfo` |
| `query` | either party | reports the state of a pending request |
| `approve` | the current sponsor | accepts it |
| `reject` | the current sponsor | refuses it |
| `cancel` | the requester | withdraws its own request |

```js
const r = await client.contact.transfer('request', 'C1', 'the-code');

r.code();             // 1000, or 1001 when it completes offline
r.transferStatus();   // 'pending'
r.transfer();
// { status, requestedBy, requestedAt, actingClient, actBy, expiryDate }
```

The sponsor learns of the request through [poll](poll.md) and answers with `approve` or
`reject`. `op="query"` against a contact with nothing pending is `2301`, and a second
`request` against one already pending is `2300`.

**Result codes:** `1000` / `1001`; `2201` (not yours), `2202` (wrong `authInfo`), `2300`,
`2301`, `2303`, `2304`.

---

[← Manual index](README.md) · [Domains](domains.md) · [Hosts](hosts.md) ·
[Poll](poll.md) · [Responses](responses.md)
