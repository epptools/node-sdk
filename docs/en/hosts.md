# Hosts

Host (nameserver) objects follow **RFC 5732**. Where the registry uses host objects, a
nameserver has to exist as an object before a domain can be delegated to it — the domain then
references it by name. See [Domains → Nameservers](domains.md#nameservers-two-models-never-mixed)
for the alternative model, in which the glue travels inside the domain command instead.

`client.host` carries one method per EPP command. Each returns a `Promise<Response>`.

| Method | What goes on the wire |
|---|---|
| `check(names)` | `<check><host:check>` |
| `info(name)` | `<info><host:info>` |
| `create(name, addresses = [])` | `<create><host:create>` |
| `update(name, opts = {})` | `<update><host:update>` |
| `updateBuilder(name)` | the same `<update>`, assembled step by step |
| `delete(name, force = false)` | `<delete><host:delete>` (+ `<registry:deleteNS>`) |

There is **no rename**, by design and not by omission — see
[A host cannot be renamed](#a-host-cannot-be-renamed).

Every example below assumes a connected, logged-in `client` — see [Quickstart](quickstart.md).
See [Errors](errors.md) for the exception taxonomy and [Responses](responses.md) for the
accessors used here.

---

## Subordinate and external hosts

The one distinction that governs every command on this page:

| | Lives | Glue addresses |
|---|---|---|
| **Subordinate** | under a domain in a zone the registry serves, e.g. `ns1.example.com.ua` | **required** — without one the create is `2003` |
| **External** | under a domain elsewhere, e.g. `ns1.example.net` | **refused** — its addresses live at its own registry, so sending one is `2306` |

A client that always emits an address gets a `2306` on every external nameserver it tries to
create. Decide from the name, then send the addresses or omit them.

---

## check

```js
check(names)   // => Promise<Response>
```

`avail` here means the **name is free to create as a host object**.

```js
const r = await client.host.check(['ns1.example.com.ua', 'ns2.example.com.ua']);

r.availability();                     // { 'ns1.example.com.ua': false, 'ns2.example.com.ua': true }
r.isAvailable('ns2.example.com.ua');  // true
r.unavailableReason('ns1.example.com.ua');   // 'in use', or null
```

**Result codes:** `1000`.

---

## info

```js
info(name)   // => Promise<Response>
```

```js
const h = await client.host.info('ns1.example.com.ua');

h.objectName();      // 'ns1.example.com.ua'
h.roid();
h.statuses();        // ['ok'] or ['linked', 'clientUpdateProhibited', ...]
h.sponsor();         // clID
h.createdBy();       h.createdDate();
h.updatedBy();       h.updatedDate();

h.hostAddresses();
// [{ ip: '203.0.113.10', version: 'v4' }, { ip: '2001:db8::10', version: 'v6' }]
```

`hostAddresses()` returns an empty list for an external host, and that is the correct answer
rather than a missing one: only a host inside a zone the registry serves carries glue.

`version` is taken from the wire's `ip` attribute and falls back to `'v4'` when the registry
omits it, which the host schema allows.

A `linked` status means at least one domain still delegates to this host, which is what makes
a plain delete fail with `2305`.

**Result codes:** `1000`; `2303`.

---

## create

```js
create(name, addresses = [])   // => Promise<Response>
```

Addresses are IPv4 or IPv6 literals in one flat list. **The version is detected for you** and
written into the `ip` attribute, so you never classify them yourself and never mislabel one:

```js
const r = await client.host.create('ns1.example.com.ua', [
  '203.0.113.10',
  '2001:db8::10',
]);

r.code();          // 1000
r.objectName();    // 'ns1.example.com.ua'
r.createdDate();   // '2026-08-16T09:15:00Z' — the registry's own string
```

An external host is created with no addresses at all:

```js
await client.host.create('ns1.example.net');
```

Addresses must be public Internet addresses, and a host takes at most 13 of them.

**Result codes:** `1000`; `2001` (more than 13 addresses), `2003` (a subordinate host with no
address), `2005` (a malformed address or name), `2302` (the host already exists), `2306` (an
address on an external host).

---

## update

```js
update(name, opts = {})   // => Promise<Response>
```

| Key | Type | On the wire |
|---|---|---|
| `addAddresses` | `string[]` | `<host:add>` with one `<host:addr>` per entry |
| `remAddresses` | `string[]` | `<host:rem>`, likewise |
| `addStatuses` | `string[]` | `<host:add>` with one `<host:status s="…">` per entry |
| `remStatuses` | `string[]` | `<host:rem>`, likewise |

Addresses and statuses going the same direction share one block, and a block with nothing in
it is not emitted. IPv4 and IPv6 are told apart automatically here too.

```js
// Renumber a nameserver: add the new address and drop the old one in a single command, so
// the host is never left without one.
await client.host.update('ns1.example.com.ua', {
  addAddresses: ['203.0.113.11'],
  remAddresses: ['203.0.113.10'],
});
```

Send at least one change. A frame that expresses none reaches the registry as a command
asking for nothing and comes back `2003`.

The subordinate/external rule holds here as well: an external host may not gain addresses
(`2306`), and a subordinate one may not be left with none (`2003`) — which is why the
renumbering above adds and removes in the same command rather than in two.

You can set and clear only the **client** statuses; `linked` and `ok` are computed by the
registry and the `server*` ones belong to it.

An update returns nothing about the object, so re-read it with `info()` when you need to
confirm the result rather than the acceptance.

**Result codes:** `1000`; `2001` (more than 13 addresses), `2003`, `2303`, `2304`, `2306`.

### A host cannot be renamed

There is no rename in this library, and passing `newName` raises a `ValidationError` before
anything is sent.

That is not a gap in the client. This registry reads only `<host:add>` and `<host:rem>`; a
`<host:chg>` block is discarded without comment. A frame carrying both an address change and
a rename would apply the address change, drop the rename, and still answer `1000` — so the
caller is told the command succeeded while the name is unchanged. Sending a rename on its own
would carry no change at all and draw an opaque `2003`.

Refusing it here means the answer comes from your own code, where the message names the
problem and the remedy:

```js
// 1. Create the replacement.
await client.host.create('ns9.example.com.ua', ['203.0.113.10']);

// 2. Re-point every domain that uses the old one, one domain:update each.
for (const name of domainsUsingTheOldHost) {
  await client.domain.update(name, {
    add: { ns: ['ns9.example.com.ua'] },
    rem: { ns: ['ns1.example.com.ua'] },
  });
}

// 3. Delete the old host, now that nothing references it.
await client.host.delete('ns1.example.com.ua');
```

Do the re-pointing before the delete. Between step 1 and step 2 both hosts are delegated,
which is a working state; a delete first would take a nameserver out of every zone that used
it.

---

## updateBuilder

```js
updateBuilder(name)   // => HostUpdateBuilder
```

The same command, assembled one named step at a time. `send()` calls `update()`, so the frame
is identical.

```js
await client.host.updateBuilder('ns1.example.com.ua')
  .addAddress('203.0.113.11')
  .remAddress('203.0.113.10')
  .addStatus('clientUpdateProhibited')
  .send();
```

Every list step accumulates, nothing is sent until `send()`, and a builder sends once. See
[Builders](builders.md).

---

## delete

```js
delete(name, force = false)   // => Promise<Response>
```

```js
await client.host.delete('ns1.example.com.ua');
```

**A host that is still a nameserver for one or more domains cannot be deleted** — the registry
answers `2305` (object association prohibits operation), which arrives as an
`ObjectStatusError`. Detach it from those domains first, with one
[`domain.update()`](domains.md#update) per domain.

### Forced delete

`force: true` adds the registry's native `<registry:deleteNS confirm="yes"/>` extension, which
removes the host from the nameserver set of **every** domain that referenced it and then
deletes it, in one command:

```js
const r = await client.host.delete('ns1.example.com.ua', true);
r.code();   // 1000, or 2400 if the detach could not complete
```

Know what you are asking for. This changes the delegation of domains you did not name, and
a domain left below its zone's minimum nameserver count stops resolving. Read the affected
domains first — `nameservers()` on each domain info response tells you who uses the host —
and re-delegate them in the same maintenance window.

**Result codes:** `1000`; `2303`, `2305` (still in use, on a delete without `force`), `2400`
(the forced detach could not complete).

---

[← Manual index](README.md) · [Domains](domains.md) · [Contacts](contacts.md) ·
[Poll](poll.md) · [Responses](responses.md)
