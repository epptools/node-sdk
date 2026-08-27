# Poll — the message queue

Everything that happens to your objects outside your own command flow reaches you through a
per-registrar message queue: a transfer someone requested, the outcome of a deferred
(`1001`) operation, an expiry warning, a deletion notice, a low-balance event. EPP's `<poll>`
command (RFC 5730) is how you read it.

`client.poll` has three methods.

| Method | What goes on the wire |
|---|---|
| `request()` | `<poll op="req"/>` |
| `ack(messageId)` | `<poll op="ack" msgID="…"/>` |
| `drain(handler, limit = 0)` | a `req` / process / `ack` loop over both |

Each returns a `Promise<Response>`, except `drain()`, which resolves to the number of notices
processed.

**Drain your queue regularly.** The registry retains a message for about a month; nothing is
pushed to you, and a queue nobody reads is a transfer request nobody answered. Every example
below assumes a connected, logged-in `client` — see [Quickstart](quickstart.md).

---

## request

```js
request()   // => Promise<Response>
```

Asks for the message at the head of the queue. Reading it does not remove it: the same
notice comes back on the next `request()` until you acknowledge it, so an interrupted client
never loses an event.

Two success codes matter here:

| Code | Meaning |
|---|---|
| `1301` | a notice is waiting, and it is in this response |
| `1300` | the queue is empty; the response carries no notice |

```js
const notice = await client.poll.request();

if (notice.code() === 1300) {
  // Nothing waiting.
} else {
  notice.messageId();        // '10021' — the id to pass to ack()
  notice.messageCount();     // 3 — how many remain, this one included
  notice.queueMessage();     // 'Transfer requested.' — the NOTICE text
  notice.queueMessageLang(); // 'uk' | 'ru' | 'en'
  notice.queueDate();        // '2026-08-16T09:15:00Z' — when it was queued
}
```

**Read the notice with `queueMessage()`, not `message()`.** They are different elements.
`message()` returns the command-result banner — "Command completed successfully; ack to
dequeue" — which is identical on every poll reply and says nothing about the event. A loop
that reads `message()` hands you that constant string while the real content goes unread, and
the ack that follows destroys it at the registry.

`messageCount()` is `0` on an empty queue, so it is not a way to tell "empty" from "one left":
use the code.

**Result codes:** `1300`, `1301`.

---

## ack

```js
ack(messageId)   // => Promise<Response>
```

Acknowledges one notice by its id, which **deletes it at the registry permanently**. There is
no way to get it back and it is never redelivered.

```js
const notice = await client.poll.request();

if (notice.messageId() !== null) {
  await store(notice.queueMessage(), notice.pendingActionData());   // process FIRST
  const after = await client.poll.ack(notice.messageId());          // then acknowledge
  after.messageCount();   // how many are left
}
```

The reply to an ack is `1301` while messages remain — carrying the updated count, and on this
registry the id of the next one — or `1300` once the queue is empty. It never carries a
notice body; only a `req` does that.

**An old notice can still be acknowledged.** Retention applies to delivery, not to your
acknowledgement: once a message has been handed to you it stays acknowledgeable even if the
month elapses while you hold it. Read, store, acknowledge later is a supported order.

**Result codes:** `1300`, `1301`.

---

## drain

```js
drain(handler, limit = 0)   // => Promise<number>
```

Reads the queue to the end, handing each notice to your callback and acknowledging it
**after** the callback resolves.

```js
const processed = await client.poll.drain(async (notice) => {
  await store(notice.queueMessage(), notice.pendingActionData());
});
```

`limit` of `0` means "until the queue is empty". Pass a number to stop after that many —
a queue that fills faster than you drain it would otherwise keep the call running
indefinitely, which is a poor fit for anything on a timer.

### The order is the point

The ack comes last, and that ordering is the whole reason this helper exists.

An ack deletes the notice at the registry permanently. A loop that acks first and processes
second **loses every notice whose processing fails** — a transfer request you now cannot
answer, the outcome of a pending create you now cannot reconcile — with nothing left to retry
from and no record that anything was lost. The registry cannot resend it, and there is no
audit trail of what disappeared.

So: **if your callback rejects, the notice is not acked.** It stays at the head of the queue
and the rejection reaches you. Fix the cause, drain again, and nothing was lost. The
corollary is deliberate: a callback that always fails sees the same notice on every drain,
because the alternative is discarding it.

```js
try {
  await client.poll.drain(async (notice) => {
    await store(notice);           // if this throws, the notice stays in the queue
  });
} catch (err) {
  // The queue is intact. Alert, fix, drain again.
}
```

### Delivery is at least once

If the acknowledgement itself fails — the connection drops between your callback resolving
and the ack landing — the notice is still in the queue, and the next drain hands it to you
again. Make the callback idempotent and de-duplicate on `messageId()`, which is the
registry's own identifier for that notice:

```js
await client.poll.drain(async (notice) => {
  const id = notice.messageId();
  if (await alreadyProcessed(id)) return;    // a redelivery, not a new event
  await store(id, notice.queueMessage(), notice.pendingActionData());
});
```

### What stops the loop

Only `1300` ends the drain. Emptiness is never inferred from "the reply carried no notice",
because a refusal — the session closed, the account suspended — looks exactly like a drained
queue from that angle, and the loop would report success while nothing had been read. Any
other reply carrying no notice is thrown as a `CommandError` built from its own result code,
so a session that has gone away reaches you as a session error rather than as a count of
zero.

---

## What the notices carry

Beyond the text, most notices carry a structured payload in `<resData>`, and the accessors
that read an `info` response read it here too.

| Notice | Payload | Read it with |
|---|---|---|
| Transfer requested / approved / rejected / cancelled | `trnData` | `transfer()`, `transferStatus()`, `objectName()` |
| Domain registered, renewed, deleted, restored | `infData` | `objectName()`, `expiryDate()`, `statuses()`, `rgpStatus()` |
| Outcome of a deferred (`1001`) operation | `panData` | `pendingActionData()` |
| Low balance | `balance:infData` | `balance()`, `currentBalance()` |

### A transfer notice

The one to answer rather than file. Both parties get it; what differs is which of you may
act.

```js
await client.poll.drain(async (notice) => {
  const t = notice.transfer();
  if (!t) return;

  // { status: 'pending', requestedBy: 'DELTA', requestedAt: '...',
  //   actingClient: 'EXAMPLE', actBy: '2026-08-21T09:15:00Z', expiryDate: '...' }
  if (t.status === 'pending' && t.actingClient === myClid) {
    // actBy is a deadline, and silence completes the transfer: past it the registry
    // APPROVES the request rather than cancelling it.
    await queueForOperatorDecision(notice.objectName(), t.actBy);
  }
});
```

### A pending-action notice

This is how a deferred command reports back. You send a create, get `1001` ("accepted; the
result will follow") with an `svTRID`, and the answer arrives here later.

```js
const p = notice.pendingActionData();
// { object: 'example.com.ua', success: true,
//   clTRID: 'EXAMPLE-20260816091500-1234-0007',
//   svTRID: 'SRV-20260816091500-24191-00042',
//   date: '2026-08-16T09:20:00Z' }
```

Two fields decide everything you do with it:

- **`success`** is the only thing that says whether the operation worked. The surrounding
  `1301` means "here is a message", not "your operation succeeded"; reading the result code
  instead makes every poll answer look like a success. A missing verdict is not a verdict —
  anything other than an explicit yes comes back as `false`.
- **`svTRID`** is the id of the **original** command, not of this poll. Match it against the
  one you stored when you got the `1001` to know which pending operation the notice is about.
  A queue is not a stack: do not assume it concerns the most recent one.

### A low-balance notice

The same element the [balance query](balance.md) returns, so one parser serves both:

```js
const b = notice.balance();
if (b) {
  // { creditLimit: '0.00', balance: '120.00', availableCredit: '120.00' }
  // Money is an exact decimal STRING. Never parse it into a float before comparing.
}
```

Act on it. Once the balance runs out, chargeable commands are refused with `2104` and a
registration you were about to make fails for want of funds rather than for anything wrong
with the request.

### A change the registry made to your object (RFC 8590)

Some notices describe something that happened to one of your objects without you asking: it stopped
existing at the registry, or it left on a transfer. These are the ones you have to act on
automatically — stop billing it, tell your customer, drop it from your own store — and the `<msg>`
they carry is written in your account's notification language, so nothing in it is safe to parse.

```js
const chg = notice.change();
if (chg) {
  chg.operation;      // 'delete' | 'transfer' | 'renew' | 'update' | 'restore' | 'autoRenew' | …
  chg.state;          // 'before' | 'after' — see below, this one matters
  chg.who;            // who did it. 'Registry' = the registry side, not your account
  chg.date;           // when it happened (the same instant for every poll of this message)
  chg.svTRID;         // the registry's transaction id for the operation, for a support ticket
  chg.reason;         // the registry's finer name for the event, where it has one
  notice.objectName(); // …and the object it happened to
}
```

**`state` says which way the object beside it reads.** `after` describes the object as it now is.
`before` describes it as it last was — which is the only way a domain that no longer exists *can*
be described. Writing a `before` block into your own store as the object's current state is how a
deleted domain comes back to life in your records, so branch on it before you save anything.

`change()` returns `null` when the notice carries no change block, which includes every notice if
you did not announce the extension:

```js
// The library mirrors the server's greeting into <svcs>, so a registry that offers changePoll is
// announced for you. Pin your own list only if you have a reason to:
new Config({ /* … */ extUris: [Namespaces.SECDNS, Namespaces.RGP, Namespaces.CHANGEPOLL] });
```

Unlike the relocation rule below, announcing **nothing** does not get you `changeData`: a registry
sends it only to a client that named the namespace, because a client that has never seen it may
refuse the whole frame. The `<msg>` sentence is unchanged either way, so opting in never removes
anything you already read.

---

## When a payload arrives relocated (RFC 9038)

A notice is written into your queue before the registry knows which session will collect it,
so it can contain an element from an extension namespace. If your login announced a list of
extensions and that namespace was not among them, the registry does not put the element in
`<resData>` — it moves it into an `<extValue>` inside `<result>` instead, with a reason
naming the namespace you would have to announce.

By default this library logs in announcing exactly the extensions the server's greeting
offered, so the typed form is what you get. You meet the relocated form only if you narrow
`extUris` in the [config](session.md).

Either way, the frame is still valid, the data is still in it, and the notice is still
acknowledgeable — nothing is silently discarded:

```js
for (const ext of notice.extValues()) {
  ext.element;     // 'infData'
  ext.namespace;   // the URI that was not announced
  ext.values;      // the children by name: { balance: '120.00' }
  ext.xml;         // the element as it arrived, to re-parse yourself
  ext.reason;      // why it was relocated
}
```

Always `ack` such a notice as you would any other. Leaving it because it looked unfamiliar
wedges the queue behind it.

---

## A complete drain, end to end

```js
const { Client, Config, EppError } = require('@epptools/sdk');

const client = new Client(new Config({
  host: 'epp.registry.example',
  clid: 'EXAMPLE',
  password: 'your-secret',
  caFile: '/path/to/registry-ca.pem',
}));

try {
  await client.connect();
  await client.login();

  const processed = await client.poll.drain(async (notice) => {
    const id = notice.messageId();
    if (await alreadyProcessed(id)) return;

    await store({
      id,
      queuedAt: notice.queueDate(),          // the registry's own string
      text: notice.queueMessage(),
      lang: notice.queueMessageLang(),
      object: notice.objectName(),
      transfer: notice.transfer(),
      pending: notice.pendingActionData(),
    });
  });

  console.log(`${processed} notices processed`);
  await client.logout();
} catch (err) {
  if (err instanceof EppError) console.error(err.message);
} finally {
  client.disconnect();
}
```

---

[← Manual index](README.md) · [Domains](domains.md) · [Contacts](contacts.md) ·
[Balance & prices](balance.md) · [Responses](responses.md)
