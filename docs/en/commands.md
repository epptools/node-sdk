# Commands

Everything you send after `<login>` is a command, and every command in this library behaves the same
way: it builds one EPP frame, writes it, reads exactly one reply, and resolves to a
[`Response`](responses.md). This page is about that shape — what comes back, how transactions are
identified, how to turn the throwing off, and how to send a frame the library has no method for.

The individual commands are documented per object: [Domains](domains.md),
[Contacts](contacts.md), [Hosts](hosts.md), [Poll](poll.md), [Balance](balance.md).

## What a command returns

Every command returns a `Promise<Response>`.

```js
const response = await client.domain.info('example.com.ua');
response.code();        // 1000
response.isSuccess();   // true for any 1xxx
response.svTRID();      // 'SRV-19700101103512-24191-00007'
```

The promise **resolves** when the registry answered with a success code (1000–1999) and **rejects**
with a [`CommandError`](errors.md) when it answered 2000 or above. Nothing else rejects a command
except a transport failure, which arrives as a `ConnectionError`, and a bad argument, which arrives
as a `ValidationError` before anything is sent.

The success codes you will actually meet:

| Code | Means | What to do |
|---|---|---|
| `1000` | done | continue; the object is in the state you asked for |
| `1001` | accepted, being carried out offline | **do not resend.** Watch the [poll queue](poll.md) for the outcome, matching by `svTRID` |
| `1300` | poll: the queue is empty | stop draining |
| `1301` | poll: a notice is waiting | read it, then ack it |
| `1500` | logout accepted | the server is closing the connection |

`1001` is the one that catches people out. `response.isPending()` is true for it. The command was
accepted and is being processed; it is neither a failure nor a completed operation, and sending it
again "to make sure" is how a domain gets registered — and paid for — twice.

A response never carries a partially parsed frame. A truncated or malformed reply is a
`ConnectionError`, not a `Response` that happens to read as a success.

## The command surface

| Method | EPP command |
|---|---|
| **Session** — see [Session](session.md) | |
| `Client.connectAndLogin(config)` | connect + `<login>`, resolving to a ready client |
| `client.connect()` | opens TLS and reads the `<greeting>` |
| `client.hello()` | `<hello>` |
| `client.login(newPassword = null)` | `<login>`, optionally rotating the password |
| `client.logout()` | `<logout>` |
| `client.disconnect()` | closes the socket (no frame) |
| `client.isConnected()` / `client.isLoggedIn()` | local state (no frame) |
| `client.throwOnFailure(value = true)` | switch, see below (no frame) |
| `client.setLogger(logger)` | switch, see [Session](session.md#logging-with-the-secrets-masked) |
| `client.frame()` / `client.request(frame)` | raw frames, see below |
| `client.balance()` | native balance query — [Balance](balance.md) |
| **Domains** — see [Domains](domains.md) | |
| `client.domain.check(names, fee = null, currency = null)` | `<domain:check>` (RFC 5731), with an optional RFC 8748 price query |
| `client.domain.info(name, authInfo = null, hosts = 'all')` | `<domain:info>` |
| `client.domain.create(name, opts = {})` | `<domain:create>` |
| `client.domain.createBuilder(name)` | the same, [step by step](builders.md) |
| `client.domain.update(name, opts = {})` | `<domain:update>` |
| `client.domain.updateBuilder(name)` | the same, [step by step](builders.md) |
| `client.domain.renew(name, curExpDate, years = 1, fee = null)` | `<domain:renew>` |
| `client.domain.restore(name, fee = null)` | `<domain:update>` with `<rgp:restore op="request">` (RFC 3915) |
| `client.domain.transfer(op, name, authInfo = null, years = null, fee = null)` | `<domain:transfer>` |
| `client.domain.delete(name)` | `<domain:delete>` |
| **Contacts** — see [Contacts](contacts.md) | |
| `client.contact.check(ids)` | `<contact:check>` (RFC 5733) |
| `client.contact.info(id, authInfo = null)` | `<contact:info>` |
| `client.contact.create(id, opts = {})` | `<contact:create>` |
| `client.contact.createAuto(opts = {})` | `<contact:create>` with `Contact.AUTO_ID`, letting the registry mint the handle |
| `client.contact.createBuilder(id, email)` | the same, [step by step](builders.md) |
| `client.contact.update(id, opts = {})` | `<contact:update>` |
| `client.contact.updateBuilder(id)` | the same, [step by step](builders.md) |
| `client.contact.delete(id)` | `<contact:delete>` |
| `client.contact.transfer(op, id, authInfo = null)` | `<contact:transfer>` |
| **Hosts** — see [Hosts](hosts.md) | |
| `client.host.check(names)` | `<host:check>` (RFC 5732) |
| `client.host.info(name)` | `<host:info>` |
| `client.host.create(name, addresses = [])` | `<host:create>` |
| `client.host.update(name, opts = {})` | `<host:update>` |
| `client.host.updateBuilder(name)` | the same, [step by step](builders.md) |
| `client.host.delete(name, force = false)` | `<host:delete>`, optionally detaching it first |
| **Poll** — see [Poll](poll.md) | |
| `client.poll.request()` | `<poll op="req">` |
| `client.poll.ack(messageId)` | `<poll op="ack">` — **destroys the notice at the registry** |
| `client.poll.drain(handler, limit = 0)` | request/handle/ack in the order that cannot lose a notice |

The four resource handlers — `client.domain`, `client.contact`, `client.host`, `client.poll` — are
created on first use and reused, so holding a reference to one is the same as reaching through the
client each time.

## Client transaction ids

Every command carries a `clTRID` that **you** own and every response carries a `svTRID` that the
**registry** owns.

```js
const r = await client.domain.info('example.com.ua');
r.clTRID();   // 'NODEJS-SDK-20260816103012-24191-0003'  — echoed back from your command
r.svTRID();   // 'SRV-19700101103512-24191-00007'     — the registry's own record
```

The library generates the `clTRID` for you and guarantees it is unique per command. Its shape is

```
<clTRIDPrefix>-<UTC timestamp>-<process id>-<counter>
```

so ids from one process share a stable middle segment, ids from concurrent processes cannot collide,
and the whole thing sorts chronologically in a log. Set `clTRIDPrefix` in the [Config](session.md#config)
to something that identifies your integration; the default is `NODEJS-SDK`.

**Store the `svTRID` against the object the command was about.** It is the value support looks an
operation up by; a `clTRID` means nothing to anyone but you. Log both, on every command, including
the ones that succeeded — the successes are what you compare against when a later one does not.

### The reply is checked against the command

Before a response is handed back, the `clTRID` it echoes is compared with the one that went out. If
they disagree, the connection is **closed** and a `ConnectionError` is raised:

```
ConnectionError: Response does not belong to this command (sent clTRID …, received …)
  — the connection was desynchronised and has been closed.
```

This is worth understanding rather than working around. Without the check, a reply belonging to the
previous command is indistinguishable from this one's: `renew('example2.com.ua')` returns 1000 carrying
`example1.com.ua`'s expiry date, both get billed, and your records say the wrong thing about both. Once the
offsets disagree, every later frame on that stream is suspect too, which is why the connection goes
rather than just the command.

The practical rule that follows: **send one command at a time.** Await each reply before writing the
next frame. If you need throughput, open more sessions rather than overlapping commands inside one —
and check the registry's session limit before you do.

## `throwOnFailure`

By default a result code of 2000 or above rejects the promise with the most specific
[error class](errors.md) for that code. Turn it off to read the codes yourself:

```js
client.throwOnFailure(false);

const r = await client.domain.create('example.com.ua', { years: 1, registrant: 'C1' });
if (!r.isSuccess()) {
  console.error(r.code(), r.message(), r.errorReasons());
}
```

It returns the client, so it chains, and `throwOnFailure(true)` puts it back. Three things to know
before you use it:

- It is a **client-wide** switch, not per command. Code elsewhere in your process that shares the
  client will stop throwing too.
- `login()` still rejects on a non-1000 result. A session that did not open cannot usefully be
  inspected.
- `poll.drain()` still rejects on a reply that carries neither a notice nor an empty queue, because
  inferring "the queue is drained" from a refusal would report success while nothing had been read.

With throwing off, nothing forces you to look at the code. That is the trade: `response.code()`
ignored is a failure your program never notices, where an unhandled rejection is one it cannot miss.

## Options are checked before anything is sent

The commands that take an options object accept only the keys they document. An unknown key is
refused with a `ValidationError` that names the closest known one:

```js
await client.domain.create('example.com.ua', { years: 1, secdns: { … } });
// ValidationError: domain:create does not accept 'secdns' (did you mean 'secDNS'?).
//                  Accepted: authInfo, contacts, fee, license, nameServers, nameservers,
//                  registrant, secDNS, years.
```

The alternative would be to ignore it, and an ignored key is silent in the worst way: the command
still goes out, the registry still answers 1000, and the part you asked for is missing.
`secdns` for `secDNS` would register the domain **unsigned**; a misspelled `nameservers` would
register it with **no delegation**. Nothing in the response says so, because as far as the registry
is concerned you never asked. The [builders](builders.md) remove the possibility entirely — a
misspelled step is a method that does not exist.

## Raw frames

Anything the high-level API does not cover can be assembled with `Frame` and sent with
`client.request()`.

```js
const { Namespaces } = require('@epptools/sdk');

const frame = client.frame();                       // a <command> with a generated clTRID
const check = frame.ns(frame.verb('check'), Namespaces.DOMAIN, 'domain:check');
frame.ns(check, Namespaces.DOMAIN, 'domain:name', 'example.com.ua');

const response = await client.request(frame);       // or client.request(rawXmlString)
console.log(response.availability());
```

Use `client.frame()` rather than `Frame.command(...)` unless you have a reason not to: it stamps a
generated `clTRID`, which is what lets the reply be matched to the command. If you do supply your
own, the protocol allows 3 to 64 characters, and the registry may return it normalised to that
range.

### The `Frame` API

| Method | What it does |
|---|---|
| `Frame.command(clTRID)` | starts a `<command>` frame with that transaction id |
| `frame.verb(name)` | appends the command verb — `check`, `info`, `create`, `update`, `renew`, `transfer`, `delete`, `poll`, `login`, `logout` — and returns it |
| `frame.extension()` | returns the `<extension>` element, creating it once on first use |
| `frame.epp(parent, name, text = null, attrs = {})` | appends a child in the base `epp-1.0` namespace |
| `frame.ns(parent, nsUri, qname, text = null, attrs = {})` | appends a namespaced child, e.g. `('domain:name', …)` in the domain namespace |
| `frame.toXml()` | serialises the frame |

Both `epp()` and `ns()` return the element they appended, so you nest by passing it back in as the
next parent. Attributes on a verb are set directly:

```js
const transfer = frame.verb('transfer');
transfer.attrs.op = 'request';
```

The frame guarantees the RFC 5730 child order — command content, then the optional `<extension>`,
then `<clTRID>` last — and escapes every value it serialises, so nothing you pass in can break the
XML. `toXml()` is safe to call more than once: serialising a frame to log it and then sending it
does not leave two `<clTRID>` elements behind, which would be schema-invalid and draw a bare 2001.

Note that a frame you serialise yourself is **not** masked. If you log `toXml()` output, redact
`<pw>`, `<newPW>` and `<authInfo>` before it reaches disk.

### Namespaces

`Namespaces` exports the protocol constants, so you never type a URI:

| Constant | URI | Used for |
|---|---|---|
| `Namespaces.EPP` | `urn:ietf:params:xml:ns:epp-1.0` | the base protocol (RFC 5730) |
| `Namespaces.DOMAIN` | `urn:ietf:params:xml:ns:domain-1.0` | domains (RFC 5731) |
| `Namespaces.HOST` | `urn:ietf:params:xml:ns:host-1.0` | hosts (RFC 5732) |
| `Namespaces.CONTACT` | `urn:ietf:params:xml:ns:contact-1.0` | contacts (RFC 5733) |
| `Namespaces.SECDNS` | `urn:ietf:params:xml:ns:secDNS-1.1` | DNSSEC (RFC 5910) |
| `Namespaces.RGP` | `urn:ietf:params:xml:ns:rgp-1.0` | redemption / restore (RFC 3915) |
| `Namespaces.FEE` | `urn:ietf:params:xml:ns:epp:fee-1.0` | prices and fee agreements (RFC 8748) |
| `Namespaces.LOGINSEC` | `urn:ietf:params:xml:ns:epp:loginSec-1.0` | login security (RFC 8807) |
| `Namespaces.XSI` | `http://www.w3.org/2001/XMLSchema-instance` | schema-instance attributes |
| `Namespaces.LOGINSEC_SENTINEL` | `[LOGIN-SECURITY]` | the reserved `<pw>` value meaning "the real password is in `<loginSec:pw>`" |
| `Namespaces.DEFAULT_OBJ_URIS` | | the object services announced when a greeting lists none |
| `Namespaces.DEFAULT_EXT_URIS` | | the extension services announced when a greeting lists none |

A response is read by **local element name and namespace URI**, never by prefix, so a raw frame you
build with different prefixes still comes back readable through the ordinary
[`Response`](responses.md) accessors — including `value()`, `values()` and `resData()` for whatever
the library has no named accessor for.

### Your registry's own extensions

Every URI above is defined by an RFC and is the same string at every registry on earth. A registry's
OWN extensions — a trademark licence, a price, an account balance — are not, and there is no constant
for them here, because there is no value that would be right for more than one registry.

They are **discovered from the `<greeting>`**. Every server lists what it supports before you send
anything, so after `connect()` the client already knows:

```js
await client.connect();

client.registryExtUri();      // e.g. 'http://registry.example/epp/registry-1.0', or null
client.registryBalanceUri();  // e.g. 'http://registry.example/epp/balance-1.0', or null
```

`null` means that server advertises no such extension — a fact about the server, not an error. The
commands that need one say so instead of guessing: `domain.create` with a `license`, `host.delete`
with `force` and `balance()` all throw `ConfigError` naming what was wanted and listing what the
server did offer. That refusal is the point. An extension sent under a namespace a server does not
recognise is **ignored, not rejected**, so a guess would come back `1000 OK` with the licence
silently unset.

Discovery matches the last segment of an advertised URI — `.../registry-1.0`, `urn:…:balance` —
which is the convention registries follow, not a rule anyone enforces. For a registry that names its
extensions something else, set them yourself and the greeting is not consulted:

```js
const config = new Config({
  host: 'epp.registry.example', clid: 'EXAMPLE', password: '...',
  registryExtUri: 'urn:example:params:xml:ns:myreg-1.0',
  registryBalanceUri: 'urn:example:params:xml:ns:myreg-balance-1.0',
});
```

### Result codes by name

`ResultCode` has a named constant for every code in RFC 5730, so you can branch without bare
numbers:

```js
const { ResultCode } = require('@epptools/sdk');

if (response.code() === ResultCode.SUCCESS_PENDING) { /* 1001 */ }
if (err.eppCode === ResultCode.OBJECT_EXISTS) { /* 2302 */ }
```

The full list, and what each one means for your next step, is in [Errors](errors.md#result-codes).

---

[← Manual index](README.md)
