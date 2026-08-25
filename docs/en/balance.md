# Balance & prices

Two separate things live on this page, and they answer two different questions.

**How much money is in the account** is the registry's own `balance` command — one query, three
figures, no object involved.

**What an operation costs** is the **RFC 8748** fee extension. It rides along with commands you
already send: a price query on `domain.check()`, and a fee agreement on `create`, `renew`,
`transfer` and `restore` that caps what you consent to pay.

Both give you money as an **exact decimal string** — `'250.50'`, never a number. That rule is not
decoration; the reason is in [Money is a string, not a number](#money-is-a-string-not-a-number).

Every example below assumes a connected, logged-in `client` — see [Quickstart](quickstart.md).
See [Errors](errors.md) for the exception taxonomy and [Responses](responses.md) for every accessor
used here. Amounts shown are illustrative, not the registry's tariff.

---

## The balance command

```js
client.balance()   // => Promise<Response>
```

Sends `<info><balance:info/>` in the registry's own balance namespace, which is read from the
`<greeting>` — see [`client.registryBalanceUri()`](commands.md#your-registrys-own-extensions). It is
a query on your **account**, not on an object, so it takes no arguments and needs no name.

A balance query is not part of any RFC, so a registry may not offer one. If yours advertises no
balance extension, `balance()` throws `ConfigError` listing what it did advertise, rather than
sending a frame the server would ignore.

```js
const account = await client.balance();

account.balance();
// { creditLimit: '1000.00', balance: '250.50', availableCredit: '1250.50' }
```

### Reading the answer

| Accessor | Returns | When the answer carries nothing |
|---|---|---|
| `balance()` | the whole block: `{ creditLimit, balance, availableCredit }` | `null` — this response is not a balance answer |
| `creditLimit()` | how far below zero the account may go | `null` |
| `currentBalance()` | the money actually in the account now | `null` |
| `availableCredit()` | what you can still spend: the balance plus the credit limit | `null` |

```js
const account = await client.balance();

account.creditLimit();      // '1000.00'
account.currentBalance();   // '250.50'
account.availableCredit();  // '1250.50'
```

The three are not interchangeable. **`availableCredit()` is the one to compare a price against** —
it is what the registry will let you spend. An account with `'0.00'` in `currentBalance()` and a
credit limit still registers domains; an account with money in it and a limit already consumed does
not.

`balance()` returns `null` on any response that carries no balance block, which is every ordinary
command. A field the registry left out of a block it did send comes back as `''` rather than
missing, so the shape is safe to destructure.

The same three elements arrive unprompted as a **low-balance poll notice**, and the same accessors
read it — one parser serves both. See [Poll](poll.md#a-low-balance-notice).

### Money is a string, not a number

`0.1 + 0.2` is `0.30000000000000004` in binary floating point. A balance summed that way drifts, a
comparison against a price fails at the edge, and the direction of the error is not predictable.

```js
// Wrong: the moment it becomes a number, the exactness is gone.
if (parseFloat(account.availableCredit()) >= 100.0) { … }

// Right: a decimal library, or integer minor units converted once — sign included, because a
// balance goes below zero against a credit limit.
const minorUnits = (s) => {
  const negative = s.startsWith('-');
  const [whole, fraction = ''] = (negative ? s.slice(1) : s).split('.');
  const units = BigInt(whole) * 100n + BigInt((fraction + '00').slice(0, 2));
  return negative ? -units : units;
};

if (minorUnits(account.availableCredit()) >= minorUnits(price)) { … }
```

Keep the registry's string as the value of record. Convert for display, never for arithmetic that
decides whether to spend.

### Before a batch

A balance query costs nothing and takes one round trip. Ask once before a run of registrations and
you turn a mid-batch failure into a decision you make up front:

```js
const account = await client.balance();
console.log(`available ${account.availableCredit()} — ${namesToRegister.length} names to register`);
```

It is a snapshot, not a reservation. Other sessions on the same account spend from the same pot,
and the balance can be exhausted between the check and the create — which is why the run still has
to handle `2104` ([`InsufficientFundsError`](errors.md#insufficientfundserror)) rather than trusting
the number. What the query buys you is the common case: finding out before the batch instead of
forty names into it.

---

## Prices: the fee extension (RFC 8748)

The fee extension does two independent jobs, and you can use either without the other.

| | What it does | Where it goes |
|---|---|---|
| **Ask** | quote an operation before you buy | a fee query on `domain.check()` |
| **Cap** | state the most you agree to pay | a fee agreement on `create` / `renew` / `transfer` / `restore` / `update` |

Every `fee` argument in this library is optional. Omit it and the command goes out plainly, charged
at the registry's own price.

### Asking a price

```js
check(names, fee = null, currency = null)   // => Promise<Response>
```

The `fee` argument is a map of **operation to period in years**. It rides in the same frame as the
availability check, so a quote costs no extra round trip:

```js
const r = await client.domain.check(['example.com.ua'], { create: 1, renew: 1 });

r.isAvailable('example.com.ua');                  // true
r.feeFor('example.com.ua', 'create', 1);          // '100.00'
r.feeFor('example.com.ua', 'renew', 1);           // '90.00'
```

The operations the registry prices are `create`, `renew`, `transfer`, `restore`, `update` and
`delete`.

A period is a whole number of years and at least 1. A value below that, or one that is not a
number, is sent as `1` rather than as a period the schema cannot express.

The fee query is asked **once and answered per name**. Five names with `{ create: 1 }` is one query
entry and five answers, not five entries:

```js
const r = await client.domain.check(['example1.com.ua', 'example2.com.ua', 'c.com.ua'], { create: 1 });
r.feeFor('example2.com.ua', 'create', 1);   // b's own price
```

### Several periods in one command

Give a **list** of years and the same operation is quoted at each of them, in one frame. A whole
price table costs one round trip instead of five:

```js
const table = await client.domain.check(['example.com.ua'], { create: [1, 2, 3, 5, 10] }, 'UAH');

table.feeFor('example.com.ua', 'create', 1);    // '100.00'
table.feeFor('example.com.ua', 'create', 5);    // '480.00'
table.feeFor('example.com.ua', 'create', 10);   // '940.00'
```

**`transfer` and `restore` are one-year operations however many years you ask for.** Asking
`{ transfer: [1, 2, 5] }` does not buy three quotes for three different terms; the reply echoes the
period that would actually be priced, which is one year. Read those back at 1:

```js
const t = await client.domain.check(['example.com.ua'], { transfer: 1, restore: 1 });
t.feeFor('example.com.ua', 'transfer', 1);   // the transfer price
t.feeFor('example.com.ua', 'restore', 1);    // the restore price
```

That is also why `feeFor()` takes the period: it matches the **echoed** period, so a figure you read
back at 1 is the figure the registry priced. Reading `fees()['example.com.ua'].commands.create`
after a multi-period ask gives you the first quote of several with no way to tell which — the map
holds one entry per operation. `feeFor()` and `periods` are where a multi-period answer lives.

### The 20-entry cap

A fee query carries **at most 20 entries per frame**, counted as operation-and-period pairs across
the whole query. `{ create: [1, 2, 5], renew: [1, 2, 5] }` is six.

Over twenty, the library refuses before anything is sent:

```js
await client.domain.check(['example.com.ua'], {
  create: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
  renew: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
});
// ValidationError: a fee query carries at most 20 entries; this one has 21
```

The registry answers a longer one with `2306`, having done nothing. Catching it here costs you an
exception instead of a round trip, and the message says which limit you crossed. Split the query
into two checks if you genuinely need a longer table.

The number of **names** in the check is a separate limit and is not counted here.

### Naming a currency

The third argument asks for the quote in a particular currency. It is upper-cased for you, so
`'uah'` and `'UAH'` are the same request.

```js
await client.domain.check(['example.com.ua'], { create: 1 }, 'UAH');
```

Omit it — leave it `null` — and the registry quotes in its own currency, which is what you want
unless you have a reason to force one.

A currency the registry does not price in comes back as **unavailable with a reason**, never as a
converted guess:

```js
const r = await client.domain.check(['example.com.ua'], { create: 1 }, 'JPY');
r.fees()['example.com.ua'];
// { avail: false, reason: 'Currency not supported', commands: {}, periods: [] }
```

That `avail: false` is about the **price**, not about the name. The name itself may be perfectly
free, and `isAvailable()` still says so — the two answers come from different blocks of the reply
and the availability map deliberately ignores the fee one. Read them separately.

Passing a currency with no `fee` map still sends the query block, asking the registry which currency
it would quote you in. Passing neither sends no fee extension at all.

### Reading the price table

`fees()` returns the whole answer, keyed by name:

```js
const r = await client.domain.check(['example.com.ua'], { create: [1, 2, 5] }, 'UAH');

r.fees();
// { _currency: 'UAH',
//   'example.com.ua': {
//     avail: true,
//     reason: null,
//     class: 'premium',                       // present only when the registry gave one
//     commands: { create: { years: 1, fee: '100.00' } },
//     periods: [ { op: 'create', years: 1, fee: '100.00' },
//                { op: 'create', years: 2, fee: '195.00' },
//                { op: 'create', years: 5, fee: '480.00' } ] } }
```

| Field | Meaning |
|---|---|
| `_currency` | the currency the whole table is quoted in; `''` when the registry named none |
| `avail` | whether this name could be priced at all; `true` when the registry said nothing |
| `reason` | why it could not, e.g. an unserved zone or an unsupported currency; `null` otherwise |
| `class` | the registry's fee class, e.g. `'premium'`; absent when it declared none |
| `commands` | the **first** quote per operation — the convenient case, one operation at one period |
| `periods` | every quote in the order the registry returned it: `{ op, years, fee, reason? }` |

A `fee` of `null` inside a quote means the registry answered that operation without a price, and
the `reason` beside it says why. Treat it as "no quote", not as "free".

The four accessors that read this table:

| Accessor | Returns | When there is nothing |
|---|---|---|
| `fees()` | the whole table above | `{}` |
| `feeFor(name, operation, years = 1)` | one quote as an exact decimal string; name matched case-insensitively, period matched exactly | `null` |
| `feeClass(name)` | the fee class the registry declared | `null` |
| `isPremium(name)` | `true` when the class is anything other than `standard` | `false` |

**`isPremium()` returning `false` is not a promise of the standard price.** It means the answer
declared no special class. Charge from `fees()`, and restate the figure as a cap on the transform
itself so the registry can refuse rather than overcharge.

### Capping what you agree to pay

Every billable transform takes an optional fee agreement. It is **the most you consent to pay**,
not a price you set — the registry charges its own price, and if that price is higher than your
agreement the command is **refused and nothing is charged**.

| Method | Where the fee goes | On the wire |
|---|---|---|
| `domain.create(name, { fee })` | the `fee` option | `<fee:create>` |
| `domain.renew(name, curExpDate, years, fee)` | the fourth argument | `<fee:renew>` |
| `domain.transfer('request', name, authInfo, years, fee)` | the fifth argument | `<fee:transfer>` |
| `domain.restore(name, fee)` | the second argument | `<fee:update>` — a restore is an `<update>` on the wire |
| `domain.update(name, { fee })` | the `fee` option | `<fee:update>` |
| any builder | `.maxFee(amount, currency)` | the same, see [Builders](builders.md) |

Two shapes are accepted:

```js
fee: '100.00'                              // amount only; the registry's own currency
fee: { amount: '100.00', currency: 'UAH' } // amount and currency
```

The amount is a plain decimal string: digits, optionally a point and one or two more digits.
`'100,00'`, `'$100'` and `'100.000'` are refused with a `ValidationError` **before the frame is
built**, because a malformed agreement on the wire draws a bare `2001` that names no field — and it
arrives after the command has been attempted. A numeric `0` is a legitimate agreement, meaning "this
operation is free"; it is tested for emptiness rather than truthiness so it survives.

```js
const quoted = (await client.domain.check(['example.com.ua'], { create: 1 }))
  .feeFor('example.com.ua', 'create', 1);          // '100.00' — what you showed the customer

const created = await client.domain.create('example.com.ua', {
  years: 1,
  registrant: 'C1',
  fee: quoted,                                     // "I agree to pay up to this, and no more"
});
```

Pass the figure you **quoted to the customer**, not a number you invented and not one padded "to be
safe". A padded cap consents to the padding: a tariff change or a premium name inside that margin
is charged in silence, which is the exact outcome the cap exists to prevent.

Use it on every chargeable command in an automated flow. The interesting failures are the ones you
did not predict — a name reclassified as premium, a price list updated overnight, a cached quote
from last week — and each of them ends in a bill you have to explain to somebody.

### What a refusal at 2004 means

When the real price exceeds your agreement, the registry answers **`2004`** (parameter value range
error). It arrives as a plain `CommandError` — there is no dedicated class for it — and it means:

- **nothing was charged**, and
- **nothing happened**: the domain was not registered, the term was not extended, the transfer was
  not started.

It is not retryable. Sending the same command again produces the same refusal, because neither the
registry's price nor your cap has changed. The next step is to find out the real price and decide:

```js
const { CommandError, ResultCode } = require('@epptools/sdk');

try {
  await client.domain.create('example.com.ua', { years: 1, registrant: 'C1', fee: quoted });
} catch (err) {
  if (err instanceof CommandError && err.eppCode === ResultCode.PARAMETER_VALUE_RANGE_ERROR) {
    // The price moved under us. Re-quote and let a human — or a policy — decide.
    const now = (await client.domain.check(['example.com.ua'], { create: 1 }))
      .feeFor('example.com.ua', 'create', 1);
    await reQuoteToCustomer('example.com.ua', quoted, now);
    return;
  }
  throw err;
}
```

`2004` also covers a period the zone does not allow — ten years where the maximum is five, or a
`years` on a transfer in a zone that takes none. The message and `err.reasons()` say which.

### Reading what a transform actually charged

A successful transform that carried a fee agreement echoes back what it really cost. That echo,
not your quote, is the number to reconcile against.

| Accessor | Returns | When there is nothing |
|---|---|---|
| `chargedFee()` | `{ currency: 'UAH', fee: '100.00' }` | `null` |
| `feeAmount()` | the amount alone, as an exact decimal string | `null` |
| `feeCurrency()` | its currency alone | `null` |

```js
const renewed = await client.domain.renew('example.com.ua', '2027-08-16', 1, '90.00');

renewed.expiryDate();    // the new expiry, as the registry wrote it
renewed.feeAmount();     // '90.00' — what you were actually billed
renewed.feeCurrency();   // 'UAH'
renewed.svTRID();        // store it with the charge; it is what support looks the charge up by
```

It reads the fee block of a create, renew, transfer, update or delete response. `null` means the
reply carried no fee block — which is not the same as "free". A command sent without a fee agreement
is charged at the registry's price and may well come back with nothing to echo. Reconcile those from
the balance and from your registry statement, not from `feeAmount()`.

### Price hints on `domain.info()`

A domain you sponsor may carry your effective prices in its `info` answer:

```js
const d = await client.domain.info('example.com.ua');

d.prices();
// { renewal: { value: '90.00', currency: 'UAH' },
//   restore: { value: '1000.00', currency: 'UAH' } }

d.priceChannel();   // 'ch-standard-2026' — the catalogue row this domain is billed on
```

These are **hints**, keyed by operation: what the registry currently expects this domain to cost.
They are useful for showing a customer a renewal price on a dashboard. They are not a commitment,
and they are not what you cap a transform with — for a figure you can act on, ask with a fee query
on `check()` and cap the transform with what came back.

`priceChannel()` is an opaque id, and it is **per domain, not per zone**: a name registered years
ago may sit on a different row of the catalogue from the one a new registration in the same zone
would use. That is why two domains in one zone can quote differently, and why a per-zone price
cached in your own system eventually disagrees with the registry.

---

## A complete quote-and-buy

The whole flow in one program: check the funds, quote, register against the quote, read what was
charged, confirm the account.

```js
'use strict';

const {
  Client, Config, CommandError, InsufficientFundsError, ResultCode,
} = require('@epptools/sdk');

const NAME = 'example.com.ua';

const client = new Client(new Config({
  host: 'epp.registry.example',
  clid: 'EXAMPLE',
  password: process.env.EPP_PASSWORD,
  caFile: '/etc/epp/registry-ca.pem',
}));

async function main() {
  await client.connect();
  await client.login();

  // 1. What can this account still spend?
  const account = await client.balance();
  console.log('available', account.availableCredit(), 'limit', account.creditLimit());

  // 2. Availability and price in one frame.
  const quote = await client.domain.check([NAME], { create: [1, 2] }, 'UAH');
  if (quote.isAvailable(NAME) !== true) {           // false AND null — null means "no verdict"
    console.log('not available:', quote.unavailableReason(NAME) || 'no reason given');
    return;
  }
  const oneYear = quote.feeFor(NAME, 'create', 1);  // '100.00'
  if (oneYear === null) {
    console.log('available, but the registry quoted no price; stopping.');
    return;
  }
  console.log(`${NAME}: ${oneYear} ${quote.fees()._currency}`,
    quote.isPremium(NAME) ? '(premium)' : '');

  // 3. Register, agreeing to exactly the price we quoted and no more.
  const created = await client.domain.create(NAME, {
    years: 1,
    registrant: 'C1',
    contacts: { admin: 'C1', tech: 'EXAMPLE-C2' },
    nameservers: ['ns1.example.com.ua', 'ns2.example.com.ua'],
    authInfo: 'D0main-Pw',
    fee: oneYear,
  });

  // 4. What it actually cost, and when it now expires.
  console.log('charged', created.feeAmount() || 'nothing', created.feeCurrency() || '');
  console.log('expires', created.expiryDate());     // the registry's own string
  console.log('svTRID', created.svTRID());          // store it against the domain

  // 5. The account after the charge.
  console.log('available now', (await client.balance()).availableCredit());

  await client.logout();
}

main()
  .catch((err) => {
    process.exitCode = 1;
    if (err instanceof InsufficientFundsError) {
      // Nothing is wrong with the request; the account cannot pay. Stop, do not iterate.
      console.error('top up the account:', err.message);
    } else if (err instanceof CommandError && err.eppCode === ResultCode.PARAMETER_VALUE_RANGE_ERROR) {
      console.error('the price moved above our cap; nothing was charged');
    } else {
      console.error(err);
    }
  })
  .finally(() => client.disconnect());
```

---

## Result codes on this page

| Code | Where it comes from | What it means |
|---|---|---|
| `1000` | balance, check | done; read the answer |
| `2004` | any transform carrying a fee agreement | the real price is above your cap, **or** the period is out of range — nothing was charged |
| `2104` | any billable transform | insufficient funds: [`InsufficientFundsError`](errors.md#insufficientfundserror). Stop the batch, top up, resume |
| `2306` | a fee query the registry refuses | too many entries, or an operation it does not price |

---

[← Manual index](README.md) · [Domains](domains.md) · [Poll](poll.md) ·
[Responses](responses.md) · [Errors](errors.md)
