'use strict';

// EPP namespace URIs. These are protocol constants: the exact strings that go on the wire.
//
// WHAT IS HERE AND WHAT IS NOT. Everything in this file is defined by an RFC and is the same string
// at every registry on earth. A REGISTRY'S OWN extensions are not, and they are deliberately absent:
// a client library that ships one registry's namespace as a constant is that registry's client with
// the label filed off, and pointing it at a second registry sends the first one's URIs to a server
// that has never heard of them.
//
// So the registry extensions are discovered instead - see registryExtension() below. The server
// already tells every client what it supports, in the <greeting> it sends before anything else; a
// client that reads that needs no configuration to work against a registry it has never seen, and
// needs no release when a registry changes its URIs.

const EPP = 'urn:ietf:params:xml:ns:epp-1.0';
const XSI = 'http://www.w3.org/2001/XMLSchema-instance';

// Standard RFC object mappings (RFC 5731/5732/5733).
const DOMAIN = 'urn:ietf:params:xml:ns:domain-1.0';
const CONTACT = 'urn:ietf:params:xml:ns:contact-1.0';
const HOST = 'urn:ietf:params:xml:ns:host-1.0';

// Standard extensions.
const SECDNS = 'urn:ietf:params:xml:ns:secDNS-1.1'; // RFC 5910
const RGP = 'urn:ietf:params:xml:ns:rgp-1.0';       // RFC 3915
const FEE = 'urn:ietf:params:xml:ns:epp:fee-1.0';   // RFC 8748 (prices)
const LOGINSEC = 'urn:ietf:params:xml:ns:epp:loginSec-1.0'; // RFC 8807 (login security)

// Value placed in <pw> / <newPW> to indicate that the real password is carried in
// <loginSec:pw> / <loginSec:newPW> instead (RFC 8807, section 4.1). Reserved: it cannot be
// used as a password.
const LOGINSEC_SENTINEL = '[LOGIN-SECURITY]';

// The first advertised URI whose last segment is `name`, or `name-<version>`.
//
// SEGMENTS ARE SPLIT ON `/` AND `:` ALIKE, because an extension namespace is a URI and not
// necessarily a URL. Plenty of registries publish an http:// one - `http://.../epp/registry-1.0` -
// but a URN is equally valid and equally used, and there the separator is a colon all the way down:
// `urn:example:params:xml:ns:registry-1.0`. Splitting on `/` alone leaves a URN as one single
// segment that matches nothing, so those registries would silently look like registries that
// advertise no extension at all.
function byLastSegment(advertised, name) {
  for (const uri of advertised) {
    if (typeof uri !== 'string' || uri.startsWith('urn:ietf:')) continue;
    const segments = uri.split(/[/:]/);
    const last = segments[segments.length - 1];
    // `balance-1.0` and a bare `balance` both count; `balances` does not.
    if (last === name || new RegExp('^' + name + '-[0-9.]+$').test(last)) return uri;
  }
  return null;
}

// The registry's own extension for object data - a trademark licence, a price, a sponsoring
// registrar - picked out of what the server advertised in its <greeting>.
//
// MATCHED ON THE URI'S LAST SEGMENT, because that is the only part registries agree on. There is no
// register of extension namespaces and no rule about their shape, but the convention every one of
// them follows is `<something>/<name>-<major>.<minor>`, so the name is what identifies the extension
// and the rest identifies whose it is. Anything under `urn:ietf:` is skipped: those are the RFC
// extensions above, and one of them is called `fee-1.0`, which would otherwise match a search for a
// name.
//
// Returns null when the server advertises no such extension - which is a fact about that server, not
// an error. The caller decides whether the operation it was about to attempt is still possible;
// sending our guess at a URI would produce a protocol error from the far end and a confusing one.
function registryExtension(advertised) {
  return byLastSegment(advertised || [], 'registry');
}

// The registry's account-balance extension, discovered the same way.
function registryBalance(advertised) {
  return byLastSegment(advertised || [], 'balance');
}

// Object services a client logs in with by default (standard RFC mappings).
const DEFAULT_OBJ_URIS = [CONTACT, DOMAIN, HOST];

// Extension services to announce at login when the server sent no greeting to mirror.
//
// RFC-DEFINED ONLY, and that is the point: a login must announce a subset of what the server
// advertises (RFC 5730 section 2.9.1.1), and a server answers 2307 and REFUSES THE LOGIN for a URI
// it does not serve. Naming a particular registry's extension here would make this library fail to
// log in anywhere else. Client.login() mirrors the greeting when there is one, which is every real
// connection; this list is the fallback for the case where there is not.
const DEFAULT_EXT_URIS = [SECDNS, RGP, FEE];

module.exports = {
  EPP, XSI, DOMAIN, CONTACT, HOST, SECDNS, RGP, FEE, LOGINSEC, LOGINSEC_SENTINEL,
  registryExtension, registryBalance,
  DEFAULT_OBJ_URIS, DEFAULT_EXT_URIS,
};
