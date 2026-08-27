# Session

An EPP session is a TLS socket to the registry on port 700, a `<greeting>` the server sends first, a
`<login>`, some commands, and a `<logout>`. This page covers all of it: the settings that open the
socket, the certificate checks, the four session commands, rotating your password, the RFC 8807
security block, and how to log frames without logging credentials.

## Config

`Config` holds the connection settings. Construct it once and hand it to the `Client`; it is not
meant to be mutated afterwards.

```js
const { Client, Config } = require('@epptools/sdk');

const client = new Client(new Config({
  host: 'epp.registry.example',
  port: 700,
  clid: 'EXAMPLE',
  password: process.env.EPP_PASSWORD,
  caFile: '/etc/epp/registry-ca.pem',
  lang: 'uk',
  connectTimeout: 10000,
  readTimeout: 30000,
}));
```

| Field | Default | What it is |
|---|---|---|
| `host` | `''` | the registry hostname |
| `port` | `700` | the EPP port |
| `clid` | `''` | your registrar identifier |
| `password` | `''` | your EPP password |
| `lang` | `'en'` | the language of the registry's result messages |
| `connectTimeout` | `10000` | TLS handshake deadline, **in milliseconds** |
| `readTimeout` | `30000` | per-reply deadline, **in milliseconds** |
| `verifyPeer` | `true` | verify the server certificate against `caFile` or the system store |
| `verifyPeerName` | `true` | require the certificate to match `host` |
| `caFile` | `null` | PEM path of the CA bundle that signs the **server** certificate |
| `clientCert` | `null` | PEM path of your client certificate, for a mutual-TLS endpoint |
| `clientKey` | `null` | PEM path of the matching private key |
| `clientKeyPassphrase` | `null` | passphrase, if that key is encrypted |
| `objUris` | `null` | object services to announce at login; `null` means "whatever the greeting offered" |
| `extUris` | `null` | extension services to announce at login; `null` means the same |
| `clTRIDPrefix` | `'NODEJS-SDK'` | prefix of the generated client transaction ids |
| `registryExtUri` | `null` | the namespace of this registry's OWN object extension; `null` reads it from the greeting. Set it only for a registry whose extension is not named `…/registry-<version>`. A wrong value is ignored by the server rather than refused, so the data goes missing in silence. See [Commands](commands.md#your-registrys-own-extensions). |
| `registryBalanceUri` | `null` | the same, for the account-balance extension |
| `loginSecurity` | `true` | take part in the RFC 8807 Login Security extension where the server offers it |

### What happens when a field is wrong

**`host`** — an empty host is caught by `connect()`, which throws `ConfigError: Config: host must
not be empty` before any socket is opened. A host that does not resolve, or refuses the connection,
surfaces from `connect()` as a `ConnectionError` naming the address.

**`port`** — anything other than the EPP port on that host will either refuse the connection or fail
the TLS handshake. The library speaks only EPP over TLS; there is no plaintext mode and no fallback.

**`clid`, `password`** — both are checked by `login()` before a frame is built. Either empty is a
`ConfigError` naming which one. Wrong credentials are a server-side refusal instead: result code
2200, raised as `AuthError`.

**`password` length** — the RFC 5730 `<pw>` schema type allows 6 to 16 characters. A password
outside 6–128 is a `ConfigError` before connecting. Between 17 and 128 characters it can only travel
inside the RFC 8807 block, so if the server's greeting does not advertise that extension you get a
`ConfigError` saying exactly that — rather than the bare 2001 the server would answer, which names
no field.

**`lang`** — must be one the server advertises (`en`, `uk`, `ua`, `ru`; `ua` and `uk` are both
Ukrainian). Anything else is refused at login with 2102 and raised as a `CommandError`. The language
affects the registry's `<msg>` text, nothing else — result codes are the same in every language.

**`connectTimeout`, `readTimeout`** — milliseconds, minimum 1000, validated when the `Config` is
constructed. A value that is not a positive number, or is below 1000, throws `ConfigError`
immediately with a message suggesting the millisecond equivalent. It is rejected rather than quietly
raised to the floor because `readTimeout: 30` read as milliseconds is a thirtieth of a second: a
deadline that short on a create or a renew gives up while the registry is still working, the command
may well have been carried out and billed, and a read timeout is terminal — so the client would
report a failure for an operation that in fact succeeded.

**`caFile`, `clientCert`, `clientKey`** — these are read from disk when `connect()` runs. A path
that does not exist fails the connect with the filesystem error (`ENOENT`), before any socket is
opened. That is a deployment problem, not a protocol one, and it is deliberately not disguised as a
`ConnectionError`.

**`objUris`, `extUris`** — leave both `null`. The client then announces exactly what the greeting
offered, so a session is never refused with 2307 for asking after a service the server does not
have. Set them only to *narrow* what you announce. An empty array announces nothing in that
category, which turns the corresponding extensions off for the session; the base `epp-1.0` URI is
never sent as an object service, because it is not one. If the greeting listed no services at all,
the client falls back to the standard RFC object mappings and the extensions this registry
publishes.

**`clTRIDPrefix`** — appears at the front of every generated client transaction id, so your commands
are findable in a shared log. See [Commands](commands.md#client-transaction-ids).

**`loginSecurity`** — set it to exactly `false` to stay off the extension. See
[Login security](#login-security-rfc-8807) for what you give up by doing so.

## TLS

| Scenario | Config |
|---|---|
| `epp.registry.example:700` (private-CA certificate) | set `caFile` to the registry CA `.pem` — **required** |
| A public, browser-trusted certificate | the defaults (`verifyPeer: true`, `verifyPeerName: true`) |
| Hostname mismatch in development | `verifyPeerName: false` |
| A mutual-TLS endpoint | `clientCert` + `clientKey` (+ `clientKeyPassphrase` if the key is encrypted) |

The public endpoint on `epp.registry.example:700` presents a certificate issued by the registry's **own
private CA**, so `caFile` must point at that CA bundle: the system trust store does not contain it
and the handshake fails without it. The endpoint is strict RFC EPP and needs **no client
certificate** — authentication is clID plus password over TLS, with an IP allowlist on your account.

The connection negotiates TLS 1.2 at the lowest, sends the configured `host` as the SNI server name,
and verifies the certificate chain unless you have turned that off.

### When the handshake fails

The commonest first-run failure is certificate verification, and it looks like this:

```
ConnectionError: TLS/socket error on epp.registry.example:700 — certificate verify failed
```

That almost always means `caFile` is unset or points at the wrong bundle. Check it before anything
else:

```bash
openssl s_client -connect epp.registry.example:700 -CAfile /path/to/registry-ca.pem </dev/null
# "Verify return code: 0 (ok)" means the bundle is right; anything else means it is not.
```

Other handshake failures and what they mean:

| Message | Cause |
|---|---|
| `certificate verify failed` | wrong or missing `caFile` |
| `Hostname/IP does not match certificate's altnames` | the certificate is right but was issued for another name — check `host` before reaching for `verifyPeerName: false` |
| `Connect to epp.registry.example:700 timed out after 10000 ms` | nothing answered: firewall, wrong port, or your IP is not allowed to reach the endpoint |
| `ECONNREFUSED` | something answered the address but nothing is listening on that port |
| `ENOENT` on connect | `caFile` / `clientCert` / `clientKey` names a file that does not exist |

**Do not reach for `verifyPeer: false`.** It makes the message go away and leaves you sending your
clID, your password and every transfer secret to whatever answers on that address, with no way to
tell. If the handshake will not verify, the bundle is wrong — ask the registry for the current one.
`verifyPeerName: false` is a narrower loosening (right certificate, wrong hostname) and is
occasionally reasonable in development; `verifyPeer: false` is not reasonable anywhere.

A login refused with 2200 or 2501 can also be a TLS-adjacent problem rather than a wrong password:
the registry checks the source IP against your allowlist, and if your account has certificate
pinning, the presented client certificate has to match.

## Opening and closing a session

```js
await client.connect();     // TLS + read the <greeting>
await client.login();       // <login>
// … commands …
await client.logout();      // <logout>, answered 1500; the server then closes the link
client.disconnect();        // close the socket locally
```

### `connect()`

```js
const greeting = await client.connect();
```

Opens the TLS socket and reads the `<greeting>` the server sends unprompted, resolving to it as a
[`Response`](responses.md). Call it once per session — it reads exactly one frame, so calling it
again on an open connection would consume the reply to something else.

The greeting is what the client logs in with. It is kept on the client and readable afterwards:

```js
client.greeting.value('svID');        // the server's name
client.greeting.value('svDate');      // its clock, as its own string
client.greeting.serviceObjUris();     // ['urn:ietf:params:xml:ns:contact-1.0', …]
client.greeting.serviceExtUris();     // ['urn:ietf:params:xml:ns:secDNS-1.1', …]
client.greeting.isGreeting();         // true
```

`client.greeting` is `null` before the first `connect()` or `hello()`.

### `hello()`

```js
const greeting = await client.hello();
```

Sends `<hello/>` and reads the fresh `<greeting>` the server answers with, replacing the stored one.
Two uses: re-reading the service menu without reconnecting, and keeping an otherwise idle session
from being closed for inactivity. It carries no transaction id, because `<hello>` is not a command.

### `login(newPassword = null)`

```js
const response = await client.login();
```

Sends `<login>` with your clID and password, the protocol version `1.0`, your `lang`, and the
services from the greeting. It resolves to the response on 1000 and rejects on anything else:

| Code | Raised as | Meaning |
|---|---|---|
| 2200 | `AuthError` | wrong clID or password, an IP that is not on your allowlist, or a closed contract |
| 2002 | `CommandError` | this connection is already logged in |
| 2100 | `CommandError` | the protocol version was refused |
| 2102 | `CommandError` | the `lang` you asked for is not supported |
| 2307 | `CommandError` | a service you announced is not offered |
| 2501 | `SessionError` | authentication was refused and the server is closing the connection |
| 2502 | `SessionError` | too many concurrent sessions — the server closes the connection |

Each of those has its own remedy, which is why they are not all called an authentication failure:
being told to rotate a password that was never the problem costs an afternoon. Note that `login()`
rejects on a non-1000 result **regardless of** [`throwOnFailure`](commands.md#throwonfailure) — a
session that is not open cannot usefully be inspected.

There is a shortcut for the two-step:

```js
const client = await Client.connectAndLogin(config);   // static
```

It builds the client, connects and logs in, resolving to the ready client.

### `logout()` and `disconnect()`

```js
await client.logout();     // resolves with result code 1500
client.disconnect();
```

`logout()` ends the session politely; the server answers 1500 and then closes the connection.
`disconnect()` closes the socket from your side and marks the session logged out. It is synchronous,
takes no arguments and is safe to call at any point, including when nothing was ever connected —
which is why it belongs in a `finally` block. After `disconnect()` the same `Client` can `connect()`
again; the transport reopens cleanly.

### Where you are

```js
client.isConnected();   // is the socket open and healthy
client.isLoggedIn();    // did login() succeed and has logout()/disconnect() not run since
```

Both are local state, not a round trip. `isConnected()` becomes false the moment the transport hits
a terminal error — a read timeout, a closed socket — so it is a fair test before reusing a
long-lived client. A session dropped by the server between commands is discovered on the next
command as a `ConnectionError`.

## Rotating the password

```js
await client.login('new-secret-value');
```

The new password travels in `<newPW>` alongside the old one. **The change takes effect only if the
login succeeds**, and from the next session on you must use the new value — so write it to wherever
your deployment keeps secrets *before* you consider the rotation done. Both the old and the new
value are length-checked before anything is sent.

Two consequences worth planning for:

- If the new password is longer than 16 characters it can only be carried by the RFC 8807 block, so
  the account will then be able to authenticate only where that extension is available. If other
  software of yours logs in with the same account somewhere that does not offer it, that software
  starts failing. The registry sends a warning event on the very login that sets such a password —
  read `securityEvents()` on the response.
- Rotation across the 16-character boundary is handled per element: only the value that actually
  needs relocating is moved into the extension block, so changing a short password to a long one
  sends the old one in `<pw>` and the new one in `<loginSec:newPW>`.

## Login security (RFC 8807)

Where the server offers the Login Security extension, the login carries a small block identifying
this client, and the server answers with anything it wants you to fix about the session.

```js
for (const event of (await client.login()).securityEvents()) {
  console.warn(`[${event.level}] ${event.type}: ${event.text}`, event.exDate || '');
}
```

Each event is a plain object with `text` plus whichever of these attributes it carried:

| Field | Values |
|---|---|
| `type` | `password`, `certificate`, `cipher`, `tlsProtocol`, `newPW`, `stat`, `custom` |
| `level` | `warning` or `error` |
| `name` | which cipher suite, which TLS version, or the name of a `custom` event |
| `exDate` | for `certificate`: the exact moment it expires |
| `value`, `duration`, `lang` | as the event carries them |

The list is empty on a healthy session, so treat any entry as something to act on. The commonest is
a client certificate approaching expiry — the alternative to hearing about it here is finding out on
the morning it stops working.

A server returns these **only to a client that sent the extension block**, because announcing a URI
is not evidence of being able to read the extension: many clients build their `<svcExtension>` by
echoing the greeting back. That is why the block goes out even when nothing needs to travel in it.
It identifies the client, and nothing else is taken from it:

```xml
<loginSec:userAgent>
  <loginSec:app>EppTools Node SDK 1.1.1</loginSec:app>
  <loginSec:tech>Node v20.11.0</loginSec:tech>
  <loginSec:os>linux</loginSec:os>
</loginSec:userAgent>
```

Set `loginSecurity: false` in the config to stay off it. The extension is then used only where there
is no alternative — a password longer than the 16 characters the base `<pw>` element can carry,
which has nowhere else to go. With it off, the server's security events stop reaching you.

## Logging, with the secrets masked

```js
client.setLogger(console);            // or any object with debug / info / warn
```

`setLogger()` returns the client, so it chains. What gets logged:

| Level | What |
|---|---|
| `debug` | every frame in both directions: `EPP >> request …`, `EPP << response …`, `EPP << greeting …` |
| `info` | one line per successful command: `EPP result 1000 (svTRID=… clTRID=…)` |
| `warn` | the same line for a command the registry refused |

If the logger has no `info` or `warn`, the library falls back to `log`. If it has no `debug`, frames
are not logged at all — which is the right default for production, where you want the result lines
and not the payloads.

**Frames are masked before they reach the logger.** The content of any `<pw>` or `<newPW>` element,
in any namespace prefix, is replaced with `***`. That covers the login password, a `<newPW>` during
rotation, the RFC 8807 `<loginSec:pw>`, and the `<pw>` inside every `<authInfo>` block — which is
the transfer secret, the credential that lets any registrar take a domain away from you.

Masking is the library's behaviour on its own logging path. If you serialise a `Frame` yourself with
`toXml()` and log the string, nothing has masked it — do that redaction yourself before it reaches
disk or a support ticket.

## The transport, if you need it

`Client` takes an optional connection and logger, which is how you substitute a transport in tests:

```js
const { Client, Connection } = require('@epptools/sdk');

const client = new Client(config, new Connection(config), console);
```

`Connection` is the RFC 5734 framing layer and nothing else — it knows no EPP semantics:

| Method | What it does |
|---|---|
| `open()` | opens the TLS socket; resolves when the handshake completes |
| `isOpen()` | whether the socket is alive and no terminal error has been recorded |
| `writeFrame(xml)` | writes one frame with its 4-byte big-endian length prefix |
| `readFrame()` | resolves with the body of the next complete frame, as a string |
| `close()` | destroys the socket |

Framing counts **bytes**, not characters, so Cyrillic and IDN payloads are framed correctly. Three
limits protect the process: a frame declaring more than 1 MiB is rejected, unread data beyond 4 MiB
closes the connection, and each `readFrame()` carries its own `readTimeout` deadline.

That last deadline is per read rather than a socket inactivity timer on purpose: an idle EPP session
with no command in flight has nothing to receive, and an inactivity timer would destroy a perfectly
healthy one. **A read timeout is terminal.** A reply that arrives after the deadline would
desynchronise the stream — the next read would return the previous command's response — so the
connection is closed instead. What that means for a create or a renew is in
[Errors](errors.md#when-you-cannot-tell-whether-it-happened).

## See also

- [Commands](commands.md) — transaction ids, what a command returns, custom frames
- [Responses](responses.md) — `securityEvents()`, `serviceObjUris()` and the rest
- [Errors](errors.md) — `ConfigError` vs `ValidationError`, and the retry rules

---

[← Manual index](README.md)
