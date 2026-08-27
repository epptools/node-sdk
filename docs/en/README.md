# EppTools for Node.js — reference manual

**Version 1.1.1**

This is the manual for `@epptools/sdk`, an EPP client for Node.js. It opens a TLS socket to the
registry on port 700, writes RFC 5730–5734 command frames and reads the replies. There is no
framework in it and no server-side code: everything here is the client half of the protocol.

## Who this is for

You are integrating billing or domain provisioning against a domain registry that speaks EPP, you
write JavaScript or TypeScript, and you are new to EPP but not to writing production code. You will be
copying examples out of these pages into software that spends money, so every example is a command
that really exists, taking the arguments it really takes, with the response being read as well as
sent.

The vocabulary throughout is EPP's own — session, greeting, command, response, result code, object,
extension, poll queue. Where a method maps to a specific command or RFC the page says which, so you
can hold this manual and the registry's own registrar manual open side by side.

```bash
npm install @epptools/sdk
```

Requires Node.js 16 or newer. No dependencies. TypeScript types ship with the package.

## The twelve pages

Read them in this order the first time; after that, use it as a reference.

| Page | What it covers |
|---|---|
| [Index](README.md) | this page: what the manual contains, in what order, and who it is for |
| [Quickstart](quickstart.md) | one complete program: install, connect, log in, register a name, log out — then a line-by-line walk through it |
| [Session](session.md) | `Config` field by field, TLS verification and how to diagnose a handshake that fails, `connect` / `hello` / `login` / `logout`, password rotation, RFC 8807 login security, logging with secrets masked |
| [Commands](commands.md) | the command surface as a whole: what every command returns, client transaction ids, the `throwOnFailure` switch, and raw frames for anything not covered |
| [Domains](domains.md) | every domain method — check, info, create, update, renew, restore, transfer, delete — with DNSSEC and the `.ua` licence |
| [Contacts](contacts.md) | every contact method, the two postal forms, disclosure, and letting the registry mint a handle |
| [Hosts](hosts.md) | every host method, glue addresses, and the forced delete |
| [Poll](poll.md) | the message queue: request, ack, drain, and what the notices carry |
| [Balance](balance.md) | the account balance, and prices under RFC 8748: asking for one, capping what you agree to pay, reading what you were charged |
| [Responses](responses.md) | every `Response` accessor, grouped by the question it answers |
| [Builders](builders.md) | the fluent builders: every step of every builder, the accumulate rule, `toOptions()` and the send-once rule |
| [Errors](errors.md) | the exception hierarchy, result codes, which failures are worth retrying, and what to do when an outcome is genuinely unknown |

## Two conventions that run through all of it

**Dates come back as the registry's own string** — `2027-04-01T09:15:00Z`, never a `Date`. The
registry decides which calendar day a renewal lands on. Re-formatting through a local timezone is
how a client ends up displaying, and renewing against, the day before.

**Money comes back as an exact decimal string** — `'100.00'`, never a number. `0.1 + 0.2` is not
`0.3` in binary floating point, and a balance summed that way drifts. Use a decimal library or
integer minor units.

## Support

Questions about the library, a frame the registry rejected, or a bug: **https://github.com/epptools/node-sdk/issues**.

Include the `svTRID` from the response and the `clTRID` your client sent — together they identify
the exact transaction in the registry's logs, which is what makes a report answerable without a
round trip. Send the frames too if you can, but redact `<pw>`, `<newPW>` and `<authInfo>` first:
those are live credentials, and the library masks them in its own logs for the same reason.

Account, billing and registration questions go to your registry account manager, not here — this
address is for the client library.
