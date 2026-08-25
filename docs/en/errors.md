# Errors

Every failure this library raises extends **`EppError`**, so one `catch` handles everything it can
throw. Beyond that, a class exists where the right next step differs — and nowhere else. There is no
class for "a slightly different flavour of the same remedy", because a taxonomy you cannot act on is
only more names to learn.

```js
const { EppError } = require('@epptools/sdk');

try {
  await client.domain.create('example.com.ua', { years: 1, registrant: 'C1' });
} catch (err) {
  if (err instanceof EppError) { /* anything from this library */ }
  throw err;                    // anything else is a bug in your own code
}
```

## The hierarchy

```
EppError
├── ConnectionError        transport: TLS, timeout, framing
├── ConfigError            this client is set up wrong; every call fails the same way
├── ValidationError        this call's arguments are wrong; nothing was sent
└── CommandError           the registry refused (code >= 2000)
    ├── AuthError                  2200
    ├── InsufficientFundsError     2104
    ├── AuthorizationError         2201, 2202
    ├── ObjectExistsError          2302
    ├── ObjectDoesNotExistError    2303
    ├── ObjectStatusError          2304, 2305
    ├── PolicyError                2306, 2308
    └── SessionError               2500, 2501, 2502
```

| Catch | Raised when | Codes | What to do next |
|---|---|---|---|
| `ValidationError` | a value in **this** call cannot be used; **nothing was sent** | — | fix the arguments. The next call can be fine |
| `ConfigError` | the client itself is set up wrong: no host, no credentials, a timeout in the wrong unit | — | fix the deployment. Every call fails until then |
| `ConnectionError` | TLS handshake, connect or read timeout, framing, a desynchronised stream | — | the connection is closed. Reconnect; for a transform, read [the unknown-outcome rule](#when-you-cannot-tell-whether-it-happened) first |
| `AuthError` | `login()` was refused on the credentials | `2200` | check the clID and password. Do not loop: repeated failures get the source address blocked |
| `InsufficientFundsError` | the account cannot pay for this operation | `2104` | **stop the batch**, top up, resume. Every later billable command fails identically |
| `AuthorizationError` | the object exists but is not yours, or the `authInfo` is wrong | `2201`, `2202` | do not retry with the same credentials. Get the right transfer secret, or accept it is not yours |
| `ObjectExistsError` | already registered or already taken | `2302` | the name is gone. `err.subject()` says which one, when the command carried several |
| `ObjectDoesNotExistError` | no such domain, handle or nameserver | `2303` | a stale identifier or a typo. Re-read your own record before retrying |
| `ObjectStatusError` | the object's current state forbids it: a `clientHold`, a pending transfer, a host still linked | `2304`, `2305` | clear the status or the association, then send the same command again |
| `PolicyError` | the registry's own rules refuse this value | `2306`, `2308` | the request itself has to change. Retrying is pointless |
| `SessionError` | the server is ending the session | `2500`, `2501`, `2502` | reconnect and log in again, then repeat the command — it may have been perfectly good |
| `CommandError` | any other result code of 2000 or above | everything else | branch on `err.eppCode`; see [Result codes](#result-codes) |

The mapping from code to class is decided in one place, so it cannot drift between commands.

---

## A bad argument is not a bad configuration

`ValidationError` and `ConfigError` look similar and need opposite responses, which is why they are
separate classes rather than one.

**`ValidationError` is about this call.** Something in the arguments cannot be used, and the library
refused before building a frame. The remedy belongs to whoever made the request; the next call, with
different arguments, works fine.

| Raised by | Example |
|---|---|
| an option key the command does not know | `secdns` for `secDNS`, with the closest known key named |
| a fee amount that is not a plain decimal | `'100,00'`, `'$100'` |
| mixing the two nameserver models in one command | a plain name beside a name-with-glue |
| setting and clearing a domain's `authInfo` together | the schema cannot express both |
| a DS record with no digest, a key record with no public key | |
| `removeAllDnssec()` beside a named DNSSEC removal | in either order |
| a contact create with no e-mail | RFC 5733 requires one |
| a disclosable field that does not exist | `'addres'` |
| a host rename | this registry ignores `<host:chg>`; see [Hosts](hosts.md#a-host-cannot-be-renamed) |
| a fee query over [twenty entries](balance.md#the-20-entry-cap) | |
| a builder sent twice | see [Builders](builders.md#a-builder-sends-once) |

**`ConfigError` is about the deployment.** The client cannot work at all, and every call will fail
the same way until somebody changes a setting. It is an alert for whoever runs the service, not an
answer to a customer.

| Raised by | Example |
|---|---|
| an empty `host` on `connect()` | |
| an empty `clid` or `password` on `login()` | the message says which of the two is missing |
| a password outside 6–128 characters | checked before a socket is opened |
| a password over 16 characters where the server does not offer RFC 8807 | there is nowhere for it to travel; the server would answer a bare `2001` |
| `connectTimeout` or `readTimeout` below 1000 | they are **milliseconds**; a seconds-shaped value is rejected rather than quietly raised |

That last one is worth the exception it raises. Read as milliseconds, `readTimeout: 30` is a
thirtieth of a second: the deadline expires while the registry is still working, the command may
well have been carried out and billed, and a read timeout is terminal — so the client reports a
failure for an operation that in fact succeeded. See [Session](session.md#config).

```js
const { ValidationError, ConfigError } = require('@epptools/sdk');

try {
  await handleCustomerRequest(payload);
} catch (err) {
  if (err instanceof ValidationError) return reply(400, err.message);   // their input
  if (err instanceof ConfigError) { pageTheOncall(err); return reply(503, 'temporarily unavailable'); }
  throw err;
}
```

---

## Transport failures: `ConnectionError`

Everything below EPP arrives as a `ConnectionError`: a TLS handshake that would not verify, a
connect or read timeout, a frame with an impossible length prefix, a malformed or truncated reply, a
reply whose `clTRID` does not match the command that was sent.

The connection is closed in each case, and that is deliberate. A stream whose offsets have slipped
would hand the previous command's answer to the next read — `renew('example2.com.ua')` returning `1000`
carrying `example1.com.ua`'s expiry date, with both billed and your records wrong about both. Closing costs
you a reconnect; not closing costs you the truth.

A truncated frame is never parsed into a partial `Response`, so a half-delivered create cannot read
back as a finished, billable registration.

The commonest one on a first run is certificate verification, and its remedy is in
[Session](session.md#when-the-handshake-fails). The dangerous one is a read timeout **in the middle
of a transform** — see [When you cannot tell whether it
happened](#when-you-cannot-tell-whether-it-happened).

---

## What the registry refused: `CommandError`

Any result code of 2000 or above rejects the promise with the most specific class for that code.
Every one of them carries the same members:

| Member | Type | What it holds |
|---|---|---|
| `err.eppCode` | number | the EPP result code, e.g. `2302` |
| `err.response` | `Response` \| `null` | the full parsed reply — every [accessor](responses.md) works on it |
| `err.message` | string | `EPP 2302: Object exists ('example.com.ua')` — code, the registry's own text, and the subject when it named one |
| `err.isRetryable()` | boolean | whether sending the same command again could succeed; see [Retrying](#retrying) |
| `err.subject()` | string \| `null` | the object the registry objected to, from the first `<extValue>` |
| `err.reasons()` | string[] | the extra diagnostic prose the registry attached |

```js
const { CommandError } = require('@epptools/sdk');

try {
  await client.domain.check(['example1.com.ua', 'b..com.ua', 'c.com.ua']);
} catch (err) {
  if (err instanceof CommandError) {
    err.eppCode;                       // 2005
    err.subject();                     // 'b..com.ua' — WHICH of the three
    err.reasons();                     // ['Invalid domain name syntax']
    err.response.extValues();          // the same, with the element and its namespace
    err.response.svTRID();             // quote this to support
  }
}
```

`subject()` is the difference between "one of these three names was rejected" and knowing which. On
a command carrying several objects the answer is sitting in the reply either way; this reads it.

### `AuthError`

Raised by `login()` when the registry answers `2200`: the clID or the password is wrong. The session
never opened.

It is deliberately narrow. A login can also be refused because the account is at its session limit
(`2502`), because the server is closing (`2501`), because a service you advertised is not offered
(`2307`), because this connection is already logged in (`2002`), or over the protocol version
(`2100`) — each arrives as its own class with its own remedy. Calling them all an authentication
failure sends you off to rotate a password that was never the problem.

Do not retry a `2200` in a loop. Repeated authentication failures from one address are what
intrusion defences are built to notice.

### `InsufficientFundsError`

`2104`. Nothing is wrong with the request: the account cannot pay for it, and every later billable
command fails the same way until the balance is topped up.

This is the one to **stop a batch on**, not skip. A loop that treats it like any other error grinds
through the remaining thousand names producing a thousand identical failures, and buries the one
fact that mattered.

```js
if (err instanceof InsufficientFundsError) { alertBilling(err.message); break; }
```

Check the account before a run with [`client.balance()`](balance.md#before-a-batch), and remember it
is a snapshot: other sessions spend from the same pot.

### `AuthorizationError`

`2201` — the object belongs to another registrar. `2202` — the `authInfo` you presented does not
match. Never retry with the same credentials; nothing about the object will have changed.

For a transfer, `2202` means the code the customer gave you is wrong or has been rolled. Ask for the
current one rather than guessing.

### `ObjectExistsError`

`2302`. The name, handle or nameserver is already registered. Retrying cannot make it free.

Between a `check` that said "available" and a `create` that says `2302` lies a real race, not a bug
in your code — somebody else registered it in between. `err.subject()` names the one that collided
when the command carried several.

### `ObjectDoesNotExistError`

`2303`. Usually a stale identifier or a typo: a contact handle you cached, a domain that has since
been deleted. Re-read your own record before retrying, and treat it as the answer to a question
("does this still exist?") rather than as a fault.

### `ObjectStatusError`

`2304` — the object's own status forbids the operation, such as a `clientDeleteProhibited` on a
delete, or a `pendingTransfer` blocking everything else. `2305` — an association forbids it: a host
still used by a domain, a contact still referenced, a domain with subordinate hosts.

The same command works once you clear what blocks it, which makes this the one family where "fix and
repeat" is exactly right.

### `PolicyError`

`2306` — the registry's rules refuse this value. `2308` — a data-management policy violation. The
command is well-formed and you are allowed to send it; the registry says no to this content:
a licence number on a zone that takes none, a period the zone does not offer, a glue address on an
external host.

Retrying is pointless until the request itself changes. `err.reasons()` usually says what to change.

### `SessionError`

`2500`, `2501`, `2502`. The server is ending the session — an idle timeout, a restart, your account
at its session limit. The command itself may have been perfectly good.

Reconnect, log in again, and send it again. This is one of the few genuinely retryable failures, and
`isRetryable()` returns `true` for all three. On `2502` add a delay: the account already has as many
sessions as it is allowed, and hammering the door does not open it.

---

## Retrying

```js
err.isRetryable()   // => boolean
```

True only for failures about **the moment** rather than **the request**:

| Code | Class | Why retrying can work |
|---|---|---|
| `2400` | `CommandError` | the registry failed to complete the command; the request was fine |
| `2500` | `SessionError` | the session ended; reconnect first |
| `2501` | `SessionError` | the server is closing; reconnect first |
| `2502` | `SessionError` | too many sessions; reconnect after a delay |

It is deliberately `false` for everything else. Retrying a `2302` cannot make the name free,
retrying a `2104` cannot pay for it, and retrying a `2306` cannot change the registry's policy. A
loop that treats every failure as transient turns one refusal into a rate-limit ban — and against a
billable command, a loop that ignores the distinction is how a domain gets paid for twice.

```js
if (err instanceof CommandError && !err.isRetryable()) throw err;   // retrying cannot help
```

Retry with a delay that grows — a few hundred milliseconds, then a second, then two — and with a
ceiling on attempts. For the `2500` family, reconnect and log in before the retry; the old
connection is gone.

**`isRetryable()` says nothing about a transform whose outcome you do not know.** That is a different
question, and it has its own rule below.

---

## Turning throwing off

`client.throwOnFailure(false)` stops result codes of 2000 and above from rejecting, so you read
`response.code()` yourself. It is a client-wide switch, `login()` still rejects on a non-`1000`
result, and `poll.drain()` still rejects on a reply that carries neither a notice nor an empty
queue. The full trade is in [Commands](commands.md#throwonfailure).

With throwing off, nothing forces you to look at the code. That is the cost: an ignored
`response.code()` is a failure your program never notices, where an unhandled rejection is one it
cannot miss.

---

## Result codes

Every code in RFC 5730, with the constant `ResultCode` exports for it, the class it arrives as, and
what to do. Branch on the constant rather than a bare number.

```js
const { ResultCode } = require('@epptools/sdk');
if (err.eppCode === ResultCode.OBJECT_EXISTS) { /* 2302 */ }
```

### Success — 1xxx

| Code | Constant | Means | What to do |
|---|---|---|---|
| `1000` | `SUCCESS` | done | continue; the object is in the state you asked for |
| `1001` | `SUCCESS_PENDING` | accepted, being carried out offline | **do not resend.** Store the `svTRID` and watch the [poll queue](poll.md) for the outcome |
| `1300` | `SUCCESS_NO_MESSAGES` | the poll queue is empty | stop draining |
| `1301` | `SUCCESS_ACK_TO_DEQUEUE` | a poll notice is waiting | read it, process it, then ack it |
| `1500` | `SUCCESS_END_SESSION` | logout accepted | the server is closing the connection |

None of these reject a promise. `1001` is the one that catches people out: it is neither a failure
nor a finished operation, and sending the command again "to make sure" is how a domain gets
registered — and paid for — twice.

### Protocol and syntax — 2000–2099

| Code | Constant | Class | Means | What to do |
|---|---|---|---|---|
| `2000` | `UNKNOWN_COMMAND` | `CommandError` | the server does not know this command | check the verb; a raw frame is the usual cause |
| `2001` | `COMMAND_SYNTAX_ERROR` | `CommandError` | the frame is not schema-valid | it names no field, so compare the frame against the schema; the high-level methods do not produce this |
| `2002` | `COMMAND_USE_ERROR` | `CommandError` | the command is wrong for this state, e.g. a second `login` | fix the sequence |
| `2003` | `REQUIRED_PARAMETER_MISSING` | `CommandError` | something mandatory is absent | the message names it; an update expressing no change lands here too |
| `2004` | `PARAMETER_VALUE_RANGE_ERROR` | `CommandError` | a value is out of range: a period the zone does not offer, or a [fee cap below the real price](balance.md#what-a-refusal-at-2004-means) | nothing was charged. Re-quote and decide |
| `2005` | `PARAMETER_VALUE_SYNTAX_ERROR` | `CommandError` | a value is malformed: a bad domain name, a bad e-mail, Cyrillic in an `int` postal block | fix the value |

### Unimplemented, usage, billing — 2100–2199

| Code | Constant | Class | Means | What to do |
|---|---|---|---|---|
| `2100` | `UNIMPLEMENTED_PROTOCOL_VERSION` | `CommandError` | the `<login>` version must be `1.0` | a configuration problem, not a data one |
| `2101` | `UNIMPLEMENTED_COMMAND` | `CommandError` | the registry does not implement this command | do not build on it |
| `2102` | `UNIMPLEMENTED_OPTION` | `CommandError` | an unsupported login option, typically `lang` | pick a language the greeting offers |
| `2103` | `UNIMPLEMENTED_EXTENSION` | `CommandError` | the extension is not offered here, e.g. DNSSEC on a zone without it | send the command without that extension |
| `2104` | `BILLING_FAILURE` | `InsufficientFundsError` | insufficient funds | stop the batch, top up, resume |
| `2105` | `NOT_ELIGIBLE_FOR_RENEWAL` | `CommandError` | the `curExpDate` does not match, or the domain cannot be renewed now | re-read the expiry with `info()` and use the registry's own string |
| `2106` | `NOT_ELIGIBLE_FOR_TRANSFER` | `CommandError` | the domain cannot be transferred | usually a lock or a recent registration; policy decides |

### Security — 2200–2299

| Code | Constant | Class | Means | What to do |
|---|---|---|---|---|
| `2200` | `AUTHENTICATION_ERROR` | `AuthError` | the login failed | check the clID and password; do not loop |
| `2201` | `AUTHORIZATION_ERROR` | `AuthorizationError` | the object is not yours | stop; it is somebody else's |
| `2202` | `INVALID_AUTHORIZATION` | `AuthorizationError` | the `authInfo` is wrong | get the current transfer secret |

### Object lifecycle — 2300–2399

| Code | Constant | Class | Means | What to do |
|---|---|---|---|---|
| `2300` | `OBJECT_PENDING_TRANSFER` | `CommandError` | a transfer is already pending | answer it with `approve` / `reject`, or wait |
| `2301` | `OBJECT_NOT_PENDING_TRANSFER` | `CommandError` | there is nothing pending to act on | for a lost `request`, this is the answer that it never started |
| `2302` | `OBJECT_EXISTS` | `ObjectExistsError` | already registered | the name is gone |
| `2303` | `OBJECT_DOES_NOT_EXIST` | `ObjectDoesNotExistError` | no such object | stale identifier or typo |
| `2304` | `OBJECT_STATUS_PROHIBITS_OPERATION` | `ObjectStatusError` | a status forbids it | clear the status, repeat |
| `2305` | `OBJECT_ASSOCIATION_PROHIBITS_OPERATION` | `ObjectStatusError` | something is still attached | detach it, repeat |
| `2306` | `PARAMETER_VALUE_POLICY_ERROR` | `PolicyError` | the registry's rules refuse this value | change the request |
| `2307` | `UNIMPLEMENTED_OBJECT_SERVICE` | `CommandError` | the object mapping or zone is not served here | check the zone |
| `2308` | `DATA_MANAGEMENT_POLICY_VIOLATION` | `PolicyError` | a data-management rule refuses it | change the request |

### Server — 2400+

| Code | Constant | Class | Retryable | Means |
|---|---|---|---|---|
| `2400` | `COMMAND_FAILED` | `CommandError` | yes | the registry could not complete a well-formed command |
| `2500` | `COMMAND_FAILED_SERVER_CLOSING` | `SessionError` | yes | the same, and the session is ending |
| `2501` | `AUTHENTICATION_SERVER_CLOSING` | `SessionError` | yes | the server is closing the session |
| `2502` | `SESSION_LIMIT_EXCEEDED_SERVER_CLOSING` | `SessionError` | yes | too many sessions on this account |

A `2400` on a **transform** is the awkward case: the command was well-formed, the registry failed
somewhere, and whether anything was written is not stated. Treat it as an unknown outcome.

---

## When you cannot tell whether it happened

A read timeout, a dropped connection or any `ConnectionError` in the middle of a `create`, `renew`,
`transfer`, `restore` or `delete` leaves a genuinely unknown outcome: **the registry may have carried
the command out and billed you before the reply was lost.** This library cannot tell the difference,
and neither can you from the error — a lost reply and a command that never arrived look identical
from here.

**Do not simply retry.** A blind retry is how a domain gets registered — and paid for — twice: the
first attempt succeeded, its reply died on the way back, and the second attempt either registers a
second year of term or collides with your own first attempt. The charge is real either way.

Ask the registry what is true instead:

| The command that failed | Ask | Retry only if |
|---|---|---|
| `domain.create` | `domain.info(name)` | it answers `2303` — the domain does not exist |
| `domain.renew` | `domain.info(name)` and read `expiryDate()` | the expiry is still the one you started from |
| `domain.transfer('request')` | `domain.transfer('query', name)` | it answers `2301` — nothing is pending |
| `domain.restore` | `domain.info(name)` and read `rgpStatus()` | it is still in `redemptionPeriod` |
| `domain.delete` | `domain.info(name)` | the domain is still there in its old state |
| `contact.create` | `contact.info(id)` | it answers `2303` |
| `host.create` | `host.info(name)` | it answers `2303` |

```js
const { ConnectionError, ObjectDoesNotExistError } = require('@epptools/sdk');

async function createOnce(client, name, opts) {
  try {
    return await client.domain.create(name, opts);
  } catch (err) {
    if (!(err instanceof ConnectionError)) throw err;   // a refusal is an answer; this is not

    // The connection is gone. Reconnect and ask the registry what is true.
    await client.connect();
    await client.login();
    try {
      const info = await client.domain.info(name);
      // It exists. The create landed and we were billed; record it and do NOT send it again.
      await recordRegistration(name, info.expiryDate(), info.createdDate());
      return info;
    } catch (probe) {
      if (probe instanceof ObjectDoesNotExistError) return client.domain.create(name, opts);
      throw probe;   // still unclear — a human decides, not a loop
    }
  }
}
```

Three things to hold on to.

**A `1001` is not an unknown outcome.** It is a definite answer: the command was accepted and is
being carried out offline. Store its `svTRID`, watch the [poll queue](poll.md), and match the
notice back by that id. Resending it is the same double-charge with extra steps.

**`contact.createAuto()` cannot be reconciled by identifier**, because you never chose one and every
call mints a fresh handle. A blind retry after a lost reply leaves you with two contacts rather than
one. Reconcile from your own records — or use an id you chose, precisely so that a repeat collides
with `2302` instead of succeeding twice.

**A failure whose outcome you cannot determine deserves an operator, not an automatic second
attempt.** Queue it for review with the `clTRID` you sent and the object it was about. That is a
handful of manual reconciliations a year against a bill nobody can explain.

---

## A batch that behaves

Everything above, in the shape most integrations actually need:

```js
const {
  CommandError, ConnectionError, InsufficientFundsError, ObjectExistsError,
} = require('@epptools/sdk');

const taken = [];
const retryLater = [];
const needsReview = [];

for (const name of namesToRegister) {
  try {
    await client.domain.createBuilder(name)
      .years(1).registrant('C1').maxFee(quotedFor(name), 'UAH')
      .send();
  } catch (err) {
    if (err instanceof InsufficientFundsError) {
      // Not this name's problem — the account's. Carrying on produces the same failure for
      // every remaining name.
      alertBilling(err.message);
      break;
    }
    if (err instanceof ObjectExistsError) { taken.push(err.subject() || name); continue; }
    if (err instanceof ConnectionError) { needsReview.push(name); break; }   // outcome unknown
    if (err instanceof CommandError && !err.isRetryable()) throw err;        // retrying cannot help
    retryLater.push(name);
  }
}
```

Five branches, five different next steps: stop the run, record the name as gone, hand it to an
operator, give up on it, or try it again later. That is the whole point of the hierarchy — each
class exists because the line under it differs. Anything that falls through is a failure this code
did not anticipate, and it should reach a human rather than be swallowed by a catch-all.

---

## See also

- [Commands](commands.md) — `throwOnFailure`, transaction ids, and why one command travels at a time
- [Responses](responses.md) — `extValues()`, `errorReasons()` and everything else on `err.response`
- [Session](session.md) — TLS diagnosis, timeouts, and RFC 8807 security events
- [Balance & prices](balance.md) — `2104`, and what a `2004` fee refusal means

When you report a problem to **https://github.com/epptools/node-sdk/issues**, include the `svTRID` from the response and
the `clTRID` your client sent: together they identify the exact transaction in the registry's logs,
which is what makes a report answerable without a round trip. Redact `<pw>`, `<newPW>` and
`<authInfo>` from any frame you attach — those are live credentials.

---

[← Manual index](README.md)
