# Changelog

All notable changes to this library are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0]

First public release.

### The library

- **EPP over TLS with no runtime dependencies at all** — Node's own `tls` and nothing else. Domains,
  contacts and hosts (RFC 5730–5733), DNSSEC (RFC 5910), redemption and restore (RFC 3915), prices
  and fee agreements (RFC 8748) and login security (RFC 8807).
- **A registry's own extensions are discovered from its `<greeting>`**, not compiled in. This library
  ships no registry's URIs, so it works against a registry it has never seen — and keeps working when
  one changes its namespaces. `client.registryExtUri()` / `registryBalanceUri()` report what was
  found; `Config` can override both for a registry whose naming discovery cannot guess.
- **Responses are read by local element name**, never by namespace prefix, so extension data stays
  readable whatever namespace it arrived under and whatever prefix the server chose.
- **Commands that need an extension the server does not offer fail loudly.** `domain.create` with a
  licence, `host.delete` with `force` and `balance()` throw `ConfigError` naming what was wanted and
  listing what the server advertised — because an extension sent under a namespace the server does
  not recognise is ignored rather than rejected, so the alternative is a `1000 OK` with the value
  silently unset.
- **Misspelt option keys are refused, not dropped.** A key this library does not understand throws
  `ValidationError` with the nearest accepted spelling, instead of building a frame that omits what
  you asked for and comes back successful.
- **Passwords never reach a log.** Frame logging redacts `<pw>` and `<newPW>` in any namespace, and
  a password too long for the RFC 5730 `<pw>` element is either carried by RFC 8807 or refused
  before a socket is opened.
- **Builders** for the commands with the most options — `domain.update`, `contact.create`,
  `contact.update` — so a long call site reads as a sequence of decisions.
- **TypeScript declarations for the whole surface**, checked against the implementation on every
  run: `npm run types:check` fails if an export or a method is declared in one and not the other.

### The documentation

- A full reference manual in English, Ukrainian and Russian: `docs/en/`, `docs/uk/`, `docs/ru/`,
  twelve pages each — quickstart, session, domains, contacts, hosts, DNSSEC, transfers, poll, fees,
  balance, responses, errors, plus a commands reference and a builders guide.
- Every example runs against `epp.registry.example` with the login `EXAMPLE`. The examples name no
  real registry, and every hostname is under a TLD RFC 2606 reserves so a copied example cannot
  reach somebody's server.
