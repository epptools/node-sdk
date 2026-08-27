# Quickstart

One complete program, then a walk through every line of it. It connects to the registry, logs in,
prices a name, registers it, reads what it cost, and logs out. Nothing is elided: this is the whole
file.

## Install

```bash
npm install @epptools/sdk
```

Node.js 16 or newer, no dependencies. Or straight from GitHub, pinned to a release tag, if you would
rather not depend on the registry being reachable at install time:

```bash
npm install github:epptools/node-sdk#v1.1.1
```

Either way it installs as `@epptools/sdk`, so `require('@epptools/sdk')` works as usual. ESM is
supported too: `import { Client, Config } from '@epptools/sdk';`.

Before you run anything you need four things from the registry: your **clID**, your **password**,
the **CA bundle** that signs the registry's server certificate, and your source IP address on the
allowlist for that clID. There is no client certificate on the public endpoint and no API key —
authentication is clID plus password over TLS.

## The program

```js
'use strict';

const {
  Client, Config,
  EppError, CommandError, InsufficientFundsError, ObjectExistsError,
} = require('@epptools/sdk');

const NAME = 'example.com.ua';
const REGISTRANT = 'C1';

const client = new Client(new Config({
  host: 'epp.registry.example',
  port: 700,
  clid: 'EXAMPLE',
  password: process.env.EPP_PASSWORD,
  caFile: '/etc/epp/registry-ca.pem',
  lang: 'en',
  connectTimeout: 10000,
  readTimeout: 30000,
}));

async function main() {
  const greeting = await client.connect();
  console.log('connected to', greeting.value('svID'));

  const session = await client.login();
  for (const event of session.securityEvents()) {
    console.warn(`login ${event.level}: [${event.type}] ${event.text} ${event.exDate || ''}`);
  }

  const check = await client.domain.check([NAME], { create: 1 });
  if (check.isAvailable(NAME) !== true) {
    console.log(`${NAME} is not available: ${check.unavailableReason(NAME) || 'no reason given'}`);
    return;
  }

  const price = check.feeFor(NAME, 'create', 1);
  if (price === null) {
    console.log(`${NAME} is available but the registry quoted no price; stopping.`);
    return;
  }
  console.log(`${NAME} is available at ${price} ${check.fees()._currency} for one year`);

  const created = await client.domain.createBuilder(NAME)
    .years(1)
    .registrant(REGISTRANT)
    .adminContact(REGISTRANT)
    .techContact(REGISTRANT)
    .nameserver('ns1.example.com.ua')
    .nameserver('ns2.example.com.ua')
    .authInfo('D0main-Pw')
    .maxFee(price)
    .send();

  console.log('svTRID', created.svTRID());
  if (created.isPending()) {
    console.log('accepted, still being processed — the outcome will arrive as a poll notice');
  } else {
    console.log(`registered until ${created.expiryDate()}`);
    console.log(`charged ${created.feeAmount() || 'nothing'} ${created.feeCurrency() || ''}`);
  }

  const account = await client.balance();
  console.log(`balance ${account.currentBalance()}, available ${account.availableCredit()}`);

  await client.logout();
}

main()
  .catch((err) => {
    process.exitCode = 1;
    if (err instanceof InsufficientFundsError) {
      console.error('account cannot pay for this — top up before retrying:', err.message);
    } else if (err instanceof ObjectExistsError) {
      console.error('already registered:', err.subject() || NAME);
    } else if (err instanceof CommandError) {
      console.error(`registry refused with EPP ${err.eppCode}:`, err.message, err.reasons());
    } else if (err instanceof EppError) {
      console.error('client-side failure:', err.name, err.message);
    } else {
      console.error(err);
    }
  })
  .finally(() => client.disconnect());
```

Run it with the password in the environment, never in the file:

```bash
EPP_PASSWORD='your-secret' node register.js
```

## What each line does

### The imports

```js
const {
  Client, Config,
  EppError, CommandError, InsufficientFundsError, ObjectExistsError,
} = require('@epptools/sdk');
```

`Client` is the session; `Config` is its immutable settings. The four error classes are the ones
this program reacts to differently — every failure the library raises extends `EppError`, so the
last branch is a genuine catch-all for anything from this library. See [Errors](errors.md) for the
full hierarchy.

### Building the client

```js
const client = new Client(new Config({ ... }));
```

`Config` is constructed once and never mutated. Field by field:

| Field here | Why |
|---|---|
| `host`, `port` | the registry endpoint. 700 is the default and you only override it if the endpoint moves |
| `clid`, `password` | your credentials. The password comes from the environment so it is not in your repository |
| `caFile` | **required against this endpoint.** The certificate on `epp.registry.example:700` is issued by the registry's own private CA, which is not in the system trust store, so the handshake fails without this |
| `lang` | the language of the registry's result messages: `en`, `uk`, `ua` or `ru` |
| `connectTimeout`, `readTimeout` | **milliseconds**, minimum 1000. A value below that is rejected rather than quietly raised |

Every field, its default and what happens when it is wrong is in [Session](session.md#config).

### Connecting

```js
const greeting = await client.connect();
console.log('connected to', greeting.value('svID'));
```

`connect()` opens the TLS socket and reads the `<greeting>` the server sends unprompted. It resolves
to that greeting as a [`Response`](responses.md), so `value('svID')` gives you the server's name and
`serviceObjUris()` / `serviceExtUris()` give you the object and extension namespaces it supports.
The client keeps the greeting and logs in advertising exactly those services, so a session is never
refused for asking after something the server does not offer.

If this line fails with `certificate verify failed`, `caFile` is unset or points at the wrong
bundle — [Session](session.md#when-the-handshake-fails) shows how to check.

### Logging in, and reading what the server says about the session

```js
const session = await client.login();
for (const event of session.securityEvents()) { ... }
```

`login()` sends `<login>` with your clID and password and resolves to the response. Anything other
than 1000 rejects: 2200 as `AuthError`, and the other refusals — a service the server does not
offer, a language it does not support, too many concurrent sessions — as the class that matches,
because each has its own remedy and calling them all an authentication failure sends you to rotate a
password that was never the problem.

`securityEvents()` is the RFC 8807 block: the server's warnings about *this* session, such as a
client certificate three weeks from expiry or an obsolete cipher suite. The list is empty on a
healthy session, so treat any entry as something to act on. See
[Session](session.md#login-security-rfc-8807).

### Asking whether the name is free, and what it costs

```js
const check = await client.domain.check([NAME], { create: 1 });
if (check.isAvailable(NAME) !== true) { ... }
```

`domain.check()` maps to `<domain:check>` (RFC 5731). It changes nothing and costs nothing, so it is
the safest command to send first. The second argument is an RFC 8748 fee query — *operation =>
years* — which asks for the price in the same round trip.

The comparison is `!== true` rather than a falsy test on purpose: `isAvailable()` returns `true`,
`false`, or **`null` when the answer said nothing about that name at all**. "The registry did not
answer" is not the same as "taken", and the next line registers a domain.

```js
const price = check.feeFor(NAME, 'create', 1);
```

`feeFor(name, operation, years)` returns the one quote you asked for, as an exact decimal string,
or `null` when the answer carried no such quote. `fees()` returns the whole per-name table if you
want the reasons and the fee class as well; `fees()._currency` is the currency the registry quoted
in. Prices are [Balance](balance.md)'s subject in full.

### Registering it

```js
const created = await client.domain.createBuilder(NAME)
  .years(1)
  .registrant(REGISTRANT)
  ...
  .maxFee(price)
  .send();
```

This is the fluent form of `domain.create(name, opts)` — same command, same frame, same result.
What changes is that a misspelled step is a method that does not exist, which your editor tells you
about, instead of a key nobody reads. Nothing is sent until `send()`, and a builder sends once:
sending twice would be two registrations and two charges. See [Builders](builders.md).

`.maxFee(price)` is the fee agreement, and it is a **cap, not a price you set**. The registry
charges its own price; if that price is higher than what you agreed to — a tariff change, a premium
name, a stale cache — the command is refused with 2004 and **nothing is charged**, instead of
silently billing you more than you showed your customer. It is optional: leave it out and the
command goes out plainly at the registry's price.

### Reading the answer

```js
console.log('svTRID', created.svTRID());
if (created.isPending()) { ... } else { ... }
```

**Store the `svTRID` against the domain.** It is the registry's own identifier for the operation and
the one value support can look it up by; your `clTRID` means nothing to anyone but you.

`isPending()` is true for result code **1001**: the command was accepted and is being carried out
offline. It is not a failure and it is not done. Never resend it to make sure — watch the
[poll queue](poll.md) for the outcome, and match it back by the `svTRID` you just stored.

`expiryDate()` is the registry's own string; do not parse and reformat it. `feeAmount()` and
`feeCurrency()` are what this command actually charged, echoed back by the fee extension, or `null`
when the response carried no fee block.

### The balance

```js
const account = await client.balance();
console.log(`balance ${account.currentBalance()}, available ${account.availableCredit()}`);
```

`client.balance()` is a query on the account rather than on an object. Both figures are exact
decimal strings — never convert them to numbers before doing arithmetic.

### Logging out, and closing the socket

```js
await client.logout();
...
.finally(() => client.disconnect());
```

`logout()` sends `<logout>`, the server answers 1500 and closes the link. `disconnect()` closes the
socket locally and is safe to call whether or not the session was ever established, which is why it
lives in `finally()`: an exception anywhere above must not leave a socket open.

### The error handling

```js
if (err instanceof InsufficientFundsError) { ... }
```

`InsufficientFundsError` (2104) is worth its own branch because nothing is wrong with the request:
the account cannot pay, and every later billable command fails identically until it is topped up. In
a batch, this is the one you stop on rather than skip.

`ObjectExistsError` (2302) means the name was taken between the check and the create — a real race,
not a bug. `err.subject()` is the object the registry named, which matters when the command carried
several.

`CommandError` covers every other refusal; branch on `err.eppCode` and read `err.reasons()` for the
extra diagnostic text the registry attached. `EppError` catches everything else this library can
raise, so nothing escapes untyped. [Errors](errors.md) has the whole table, plus what to do when a
transform fails and you cannot tell whether it happened.

## Where to go next

- [Session](session.md) — every `Config` field, TLS, and login security
- [Commands](commands.md) — what a command returns, transaction ids, custom frames
- [Domains](domains.md) — the rest of the domain surface
- [Errors](errors.md) — the failure taxonomy and the unknown-outcome rule

---

[← Manual index](README.md)
