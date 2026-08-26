'use strict';

const net = require('net');
const ns = require('./namespaces');
const { ValidationError, commandErrorFor } = require('./errors');
const { ResultCode } = require('./resultCode');
const options = require('./options');
const builders = require('./builders');

// Object command handlers (domain / contact / host / poll). Reached through the Client
// resource getters: client.domain, client.contact, client.host, client.poll. Every method
// returns a Promise<Response>. Nested options use the RFC field names in camelCase, e.g.
// { authInfo, secDNS: { dsData: [{ keyTag, alg, digestType, digest }] } }.

const D = ns.DOMAIN;
const C = ns.CONTACT;
const H = ns.HOST;

function ipVersion(ip) {
  return net.isIPv6(ip) ? 'v6' : 'v4';
}

// The calendar date at the front of an EPP timestamp, or the string unchanged if it does not begin
// with one.
//
// WHY THIS EXISTS. Two EPP elements carry the same expiry and are DIFFERENT XML types.
// <domain:exDate> is an xs:dateTime — '2027-04-01T09:15:00.0Z' — and <domain:curExpDate> is an
// xs:date — '2027-04-01'. So the obvious code, feeding what info() returned straight back into
// renew(), is refused: the frame fails schema validation, or the registry reads a date it cannot
// match and answers 2105 "expiry is not what you said". The renewal does not happen, and the reason
// names neither element.
//
// WHY NO TIMEZONE CONVERSION. The date is taken as the SERVER WROTE IT, with no parsing and no
// reformatting. EPP timestamps are UTC, and the registry's own expiry date is the UTC one; a client
// that reformats through a local zone — which `new Date(...)` invites — lands a day either side of
// it for every domain expiring near midnight, and then renews against a date the registry does not
// hold.
//
// Anything not starting with a YYYY-MM-DD is passed through untouched, so an unusual value reaches
// the server and earns the server's own error rather than being silently truncated into a date that
// means something else.
function dateOnly(value) {
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(value));
  return m ? m[1] : String(value);
}

// One <secDNS:keyData> block, in the element order the schema fixes.
function appendKeyData(frame, parent, rec) {
  const kd = frame.ns(parent, ns.SECDNS, 'secDNS:keyData');
  frame.ns(kd, ns.SECDNS, 'secDNS:flags', String(parseInt(rec.flags != null ? rec.flags : 257, 10)));
  frame.ns(kd, ns.SECDNS, 'secDNS:protocol', String(parseInt(rec.protocol != null ? rec.protocol : 3, 10)));
  frame.ns(kd, ns.SECDNS, 'secDNS:alg', String(parseInt(rec.alg || 0, 10)));
  frame.ns(kd, ns.SECDNS, 'secDNS:pubKey', String(rec.pubKey || ''));
}

function appendSecDnsRecords(frame, parent, spec) {
  for (const rec of spec.dsData || []) {
    const ds = frame.ns(parent, ns.SECDNS, 'secDNS:dsData');
    frame.ns(ds, ns.SECDNS, 'secDNS:keyTag', String(parseInt(rec.keyTag || 0, 10)));
    frame.ns(ds, ns.SECDNS, 'secDNS:alg', String(parseInt(rec.alg || 0, 10)));
    frame.ns(ds, ns.SECDNS, 'secDNS:digestType', String(parseInt(rec.digestType || 0, 10)));
    frame.ns(ds, ns.SECDNS, 'secDNS:digest', String(rec.digest || ''));
    // RFC 5910 lets a DS record carry the DNSKEY it was computed from. Registries that accept it
    // can verify the digest for you; ones that do not answer 2306 rather than ignoring it.
    if (rec.keyData) appendKeyData(frame, ds, rec.keyData);
  }
  for (const rec of spec.keyData || []) appendKeyData(frame, parent, rec);
}

// Flattens a `contacts` option into [role, handle] pairs, accepting EITHER one handle per role or
// SEVERAL: { admin: 'A1', tech: ['T1', 'T2'] }. RFC 5731 allows repeated <domain:contact type="…">
// and the registry parses them into a list per role, so each handle gets its own element: a list
// stringified into one element would reach the registry as the single handle "T1,T2".
// Append a <domain:ns> block.
//
// A nameserver is either a NAME — a reference to a host object that already exists at the registry
// — or a name WITH its glue addresses, inlined. Registries take one model or the other, so ask
// yours which; a plain string gives the first and { name, addresses } gives the second.
//
// RFC 5731 makes <domain:ns> a choice, so the two cannot be mixed in one command: a frame carrying
// both is refused by the schema, which is a bare 2001 naming no field.
function appendNameservers(frame, parent, nameservers) {
  const inline = nameservers.map((h) => typeof h === 'object' && h !== null && 'name' in h);
  if (inline.includes(true) && inline.includes(false)) {
    throw new ValidationError(
      'nameservers must be all names or all name-with-glue, not a mixture — '
      + 'RFC 5731 makes <domain:ns> a choice between the two models');
  }
  const nsEl = frame.ns(parent, D, 'domain:ns');
  for (const host of nameservers) {
    if (typeof host !== 'object' || host === null) {
      frame.ns(nsEl, D, 'domain:hostObj', String(host));
      continue;
    }
    const attr = frame.ns(nsEl, D, 'domain:hostAttr');
    frame.ns(attr, D, 'domain:hostName', String(host.name));
    for (const ip of host.addresses || []) {
      frame.ns(attr, D, 'domain:hostAddr', String(ip), { ip: ipVersion(ip) });
    }
  }
}

function contactPairs(contacts) {
  const out = [];
  for (const [type, handles] of Object.entries(contacts || {})) {
    for (const handle of Array.isArray(handles) ? handles : [handles]) {
      const h = String(handle == null ? '' : handle).trim();
      if (h !== '') out.push([String(type), h]);
    }
  }
  return out;
}
const FEE_AMOUNT_RE = /^\d{1,10}(\.\d{1,2})?$/;

// The RFC 8748 fee you agree to pay on a transform: '100.00' or { amount: '100.00',
// currency: 'UAH' }. The server refuses (2004) when the real price is higher — you are
// never charged more than you consented to.
function appendFeeAgreement(frame, local, fee) {
  const raw = typeof fee === 'object' && fee !== null ? fee.amount : fee;
  const currency = typeof fee === 'object' && fee !== null ? fee.currency : undefined;
  // Emptiness is tested explicitly rather than by truthiness: a numeric 0 is a legitimate
  // agreement ("this operation is free"), and read as falsy it would become an empty <fee:fee/>
  // that the server rejects with 2005. The shape is checked here too, so '100,00' or '$100' fails
  // with a readable message instead of on the wire, where a malformed agreement can mean the
  // transform is refused after being billed.
  if (raw === null || raw === undefined || String(raw).trim() === '') {
    throw new ValidationError("fee agreement requires an 'amount' (e.g. '100.00')");
  }
  const amount = String(raw).trim();
  if (!FEE_AMOUNT_RE.test(amount)) {
    throw new ValidationError(`fee amount must be a plain decimal like '100.00' (got '${amount}')`);
  }
  const el = frame.ns(frame.extension(), ns.FEE, `fee:${local}`);
  if (currency) frame.ns(el, ns.FEE, 'fee:currency', String(currency));
  frame.ns(el, ns.FEE, 'fee:fee', amount);
}

// Build one <contact:postalInfo>.
//
// On an update (partial=true) PRESENCE decides. A key you leave out is not sent, so the registry
// keeps what it holds; a key present but EMPTY is sent as an empty element, which is how an
// optional field (org, sp, pc) is cleared. On a create every field is sent, because there is
// nothing to merge with.
function appendPostalInfo(frame, parent, pi, partial = false) {
  const has = (k) => Object.prototype.hasOwnProperty.call(pi, k);
  const block = frame.ns(parent, C, 'contact:postalInfo', null, { type: pi.type || 'int' });

  if (!partial || has('name')) {
    // WHICH FIELDS CAN BE EMPTIED IS FIXED BY THE SCHEMA, not by us. `name` is postalLineType,
    // minLength 1, so there is NO WAY to clear a name — an empty element is schema-invalid and the
    // server answers a bare 2001 naming no field. Refused here, where the message can say so.
    requireNotEmpty(pi.name, 'name');
    frame.ns(block, C, 'contact:name', pi.name);
  }
  // org is optPostalLineType, which HAS no minLength — an empty one is legal and is exactly how an
  // organisation is removed.
  if (partial ? has('org') : Boolean(pi.org)) frame.ns(block, C, 'contact:org', pi.org || '');

  // <addr> is a sequence with a required city and cc, so it is emitted whole or not at all.
  const addrKeys = ['street', 'city', 'sp', 'pc', 'cc'];
  if (partial && !addrKeys.some(has)) return;

  // AND "WHOLE" MEANS THE CALLER HAS TO SUPPLY THE REQUIRED PARTS. This used to substitute an empty
  // string for whatever was missing, so clearing one optional field — `{ sp: '' }`, the documented
  // way to remove a state — emitted <city/> and <cc/> alongside it. city is postalLineType
  // (minLength 1) and cc is ccType (exactly 2 characters): the frame was schema-invalid, and what
  // came back was a bare 2001 that names no element. A caller doing precisely what the manual said
  // got an error pointing at nothing.
  for (const required of ['city', 'cc']) {
    if (!pi[required]) {
      throw new ValidationError(
        `postalInfo: changing any part of the address means sending the whole <contact:addr>, and `
        + `RFC 5733 makes "${required}" a required part of it. Read the current address with `
        + `contact.info() and send city and cc back unchanged alongside what you are changing.`,
      );
    }
  }

  const addr = frame.ns(block, C, 'contact:addr');
  for (const line of pi.street || []) frame.ns(addr, C, 'contact:street', line);
  frame.ns(addr, C, 'contact:city', pi.city);
  if (partial ? has('sp') : Boolean(pi.sp)) frame.ns(addr, C, 'contact:sp', pi.sp || '');
  if (partial ? has('pc') : Boolean(pi.pc)) frame.ns(addr, C, 'contact:pc', pi.pc || '');
  frame.ns(addr, C, 'contact:cc', pi.cc);
}

// Refuse an empty value for an element whose schema type forbids one.
//
// The distinction is not a house rule, it is contact-1.0.xsd: optPostalLineType (org, street, sp)
// has no minLength and pcType has none either, so those four clear by being sent empty.
// postalLineType (name, city) has minLength 1 and ccType is exactly two characters, so an empty one
// of those cannot be sent at all. Getting it wrong costs a round trip and returns a bare 2001 with
// no field named — the least useful error in EPP.
function requireNotEmpty(value, field) {
  if (String(value ?? '').trim() === '') {
    throw new ValidationError(
      `postalInfo: "${field}" cannot be empty — RFC 5733 gives it a schema type with a minimum `
      + 'length, so there is no way to clear it. Omit the key to leave it unchanged.',
    );
  }
}

// Truth of a disclosure switch. '0' / 'false' / '' arrive from HTML forms and JSON payloads and
// are all TRUTHY strings in JS, so every switch is resolved through here rather than by plain
// truthiness: `disclose: { flag: '0' }` means WITHHOLD, the way the caller wrote it, and only a
// value that really is true consents to publication.
function isTrue(value) {
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase();
    return v !== '' && v !== '0' && v !== 'false';
  }
  return Boolean(value);
}

function appendDisclose(frame, parent, disclose) {
  const flag = isTrue(disclose.flag) ? '1' : '0';
  const disc = frame.ns(parent, C, 'contact:disclose', null, { flag });
  for (const field of ['name', 'org', 'addr']) {
    if (disclose[field] === undefined) continue;
    for (const type of disclose[field]) frame.ns(disc, C, `contact:${field}`, null, { type });
  }
  for (const field of ['voice', 'fax', 'email']) {
    if (isTrue(disclose[field])) frame.ns(disc, C, `contact:${field}`);
  }
}

// Every option each verb understands. A key outside these lists is refused, not ignored: a
// misspelling that is merely dropped still leaves the command answering 1000, with the part you
// asked for missing and nothing in the response to say so.
// A fee query carries at most this many <fee:command> entries; a longer one is refused (2306).
const MAX_FEE_COMMANDS = 20;

const DOMAIN_CREATE_KEYS = ['years', 'nameservers', 'nameServers', 'registrant', 'contacts', 'authInfo', 'secDNS', 'license', 'fee'];

/**
 * Rewrite the plain-word spelling of an option key to the one frames are built from.
 *
 * WHY TWO SPELLINGS EXIST. `rem`, `chg` and `remAll` are EPP's own abbreviations, and EPP abbreviates
 * because it is XML on a wire budget. An options object has no wire budget, and a reader who has not
 * memorised RFC 5731 cannot tell `chg` from a typo or guess that `rem` is not short for `remark`. So
 * `remove`, `change` and `removeAll` are accepted everywhere the short forms are, and are what the
 * documentation shows.
 *
 * THE SHORT FORMS ARE NOT DEPRECATED AND WILL NOT BE REMOVED. check() refuses an unrecognised key
 * instead of ignoring it, so dropping a spelling would turn working code into an exception rather
 * than into silence. Both stay.
 *
 * THE PLAIN WORD WINS when a caller sends both - the only ordering that lets a codebase migrate one
 * call at a time rather than in a flag day.
 */
function canonicalise(opts, map) {
  if (!opts || typeof opts !== 'object') return opts;
  const out = { ...opts };
  for (const [plain, short] of Object.entries(map)) {
    if (Object.prototype.hasOwnProperty.call(out, plain)) {
      out[short] = out[plain];
      delete out[plain];
    }
  }
  return out;
}

const DOMAIN_UPDATE_KEYS = ['add', 'rem', 'chg', 'restore', 'fee', 'license', 'secDNS'];
const DOMAIN_ADDREM_KEYS = ['ns', 'contacts', 'statuses'];
const DOMAIN_CHG_KEYS = ['registrant', 'authInfo', 'clearAuthInfo'];
const SECDNS_CREATE_KEYS = ['dsData', 'keyData', 'maxSigLife'];
const SECDNS_UPDATE_KEYS = ['add', 'rem', 'remAll', 'maxSigLife'];
const CONTACT_CREATE_KEYS = ['postalInfos', 'type', 'name', 'org', 'street', 'city', 'sp', 'pc', 'cc',
  'voice', 'fax', 'email', 'authInfo', 'disclose'];
const CONTACT_UPDATE_KEYS = ['chg', 'addStatuses', 'remStatuses'];
const CONTACT_CHG_KEYS = ['postalInfo', 'postalInfos', 'voice', 'fax', 'email', 'authInfo', 'disclose'];
const HOST_UPDATE_KEYS = ['addAddresses', 'addStatuses', 'remAddresses', 'remStatuses', 'newName'];

class Domain {
  constructor(client) { this._client = client; }

  // fee (optional): also ask for prices (RFC 8748) — operation => years, e.g.
  // { create: 1, renew: 1 }. Read the reply with response.fees().
  // Operations: create|renew|transfer|restore|update|delete.
  // Check availability, optionally asking for prices at the same time (RFC 8748).
  //
  // The fee query is operation => years. A LIST of years asks the SAME operation at SEVERAL periods
  // in the one command, so a whole price table costs one round trip instead of five:
  //
  //   client.domain.check(['example1.com.ua'], { create: [1, 2, 3, 5, 10], renew: 1 });
  //
  // Read the reply with response.feeFor() for a single figure, or response.fees() for the lot.
  // Operations: create|renew|transfer|restore|update|delete.
  //
  // `transfer` and `restore` are one-year operations however many years you ask for, and the reply
  // echoes the period that would actually be charged — so read those back at one year.
  //
  // `currency` asks for the quote in that currency; omit it to take the registry's own. A currency
  // it does not price in comes back as unavailable with a reason, not as a converted guess.
  check(names, fee = null, currency = null) {
    const frame = this._client.frame();
    const check = frame.ns(frame.verb('check'), D, 'domain:check');
    for (const name of names) frame.ns(check, D, 'domain:name', name);
    const wanted = [];
    for (const [op, years] of Object.entries(fee || {})) {
      for (const y of Array.isArray(years) ? years : [years]) {
        wanted.push([String(op), Math.max(1, parseInt(y, 10) || 1)]);
      }
    }
    if (wanted.length > MAX_FEE_COMMANDS) {
      throw new ValidationError(
        `a fee query carries at most ${MAX_FEE_COMMANDS} entries; this one has ${wanted.length}`);
    }
    if (wanted.length || currency !== null) {
      const feeCheck = frame.ns(frame.extension(), ns.FEE, 'fee:check');
      if (currency !== null) frame.ns(feeCheck, ns.FEE, 'fee:currency', String(currency).toUpperCase());
      for (const [op, y] of wanted) {
        const cmd = frame.ns(feeCheck, ns.FEE, 'fee:command', null, { name: op });
        frame.ns(cmd, ns.FEE, 'fee:period', String(y), { unit: 'y' });
      }
    }
    return this._client.request(frame);
  }

  info(name, authInfo = null, hosts = 'all') {
    const frame = this._client.frame();
    const info = frame.ns(frame.verb('info'), D, 'domain:info');
    frame.ns(info, D, 'domain:name', name, { hosts });
    if (authInfo !== null) {
      const ai = frame.ns(info, D, 'domain:authInfo');
      frame.ns(ai, D, 'domain:pw', authInfo);
    }
    return this._client.request(frame);
  }

  // Build a registration step by step instead of assembling an options object.
  //
  //   client.domain.createBuilder('example3.com.ua').years(1).registrant('C1').send()
  //
  // Same command, same frame, same result — create() is what it calls. The difference is that a
  // misspelling here is a method that does not exist, which your editor tells you about, rather
  // than a key nobody reads.
  createBuilder(name) { return new builders.DomainCreateBuilder(this, name); }

  /** Build a change step by step. See createBuilder(); this one calls update(). */
  updateBuilder(name) { return new builders.DomainUpdateBuilder(this, name); }

  create(name, opts = {}) {
    options.check(opts, DOMAIN_CREATE_KEYS, 'domain:create');
    if (opts.secDNS) options.check(opts.secDNS, SECDNS_CREATE_KEYS, "domain:create 'secDNS'");
    const frame = this._client.frame();
    const create = frame.ns(frame.verb('create'), D, 'domain:create');
    frame.ns(create, D, 'domain:name', name);
    if (opts.years != null) frame.ns(create, D, 'domain:period', String(parseInt(opts.years, 10)), { unit: 'y' });
    // Both spellings are accepted. `nameserver` is one word in DNS usage, and `nameServers` is what
    // the rest of this option set's camelCase leads you to type; guessing either should work.
    const nameservers = opts.nameservers || opts.nameServers;
    if (nameservers && nameservers.length) appendNameservers(frame, create, nameservers);
    if (opts.registrant != null) frame.ns(create, D, 'domain:registrant', opts.registrant);
    for (const [type, handle] of contactPairs(opts.contacts)) {
      frame.ns(create, D, 'domain:contact', handle, { type });
    }
    // authInfo is MANDATORY on domain:create (RFC 5731). Always emit it — with the caller's
    // transfer secret, or an empty <pw/> (pwType allows minLength 0) so the registry applies
    // its per-zone authInfo policy.
    const ai = frame.ns(create, D, 'domain:authInfo');
    frame.ns(ai, D, 'domain:pw', opts.authInfo || '');

    const secDNS = opts.secDNS;
    // secDNS:create requires at least one dsData or keyData record (RFC 5910); an empty or
    // keyless object must not emit a childless <secDNS:create/>, which is invalid.
    const hasSecDns = secDNS && ((secDNS.dsData && secDNS.dsData.length) || (secDNS.keyData && secDNS.keyData.length));
    if (hasSecDns || opts.license != null) {
      const ext = frame.extension();
      if (hasSecDns) {
        const secCreate = frame.ns(ext, ns.SECDNS, 'secDNS:create');
        if (secDNS.maxSigLife != null) frame.ns(secCreate, ns.SECDNS, 'secDNS:maxSigLife', String(parseInt(secDNS.maxSigLife, 10)));
        appendSecDnsRecords(frame, secCreate, secDNS);
      }
      if (opts.license != null) {
        const uri = this._client.requireRegistryExtUri('domain:create with a licence');
        const u = frame.ns(ext, uri, 'registry:create');
        frame.ns(u, uri, 'registry:license', opts.license);
      }
    }
    if (opts.fee != null) appendFeeAgreement(frame, 'create', opts.fee);
    return this._client.request(frame);
  }

  update(name, opts = {}) {
    // Plain words first: 'remove'/'change' are the documented spellings, 'rem'/'chg' are EPP's own
    // abbreviations and keep working. See canonicalise().
    opts = canonicalise(opts, { remove: 'rem', change: 'chg' });
    if (opts.secDNS) opts = { ...opts, secDNS: canonicalise(opts.secDNS, { remove: 'rem', removeAll: 'remAll' }) };
    options.check(opts, DOMAIN_UPDATE_KEYS, 'domain:update');
    for (const block of ['add', 'rem']) {
      if (opts[block]) options.check(opts[block], DOMAIN_ADDREM_KEYS, "domain:update '" + block + "'");
    }
    if (opts.chg) options.check(opts.chg, DOMAIN_CHG_KEYS, "domain:update 'chg'");
    if (opts.secDNS) options.check(opts.secDNS, SECDNS_UPDATE_KEYS, "domain:update 'secDNS'");
    const frame = this._client.frame();
    const update = frame.ns(frame.verb('update'), D, 'domain:update');
    frame.ns(update, D, 'domain:name', name);

    for (const op of ['add', 'rem']) {
      const spec = opts[op];
      if (!spec) continue;
      const block = frame.ns(update, D, `domain:${op}`);
      if (spec.ns && spec.ns.length) appendNameservers(frame, block, spec.ns);
      for (const [type, handle] of contactPairs(spec.contacts)) {
        frame.ns(block, D, 'domain:contact', handle, { type });
      }
      for (const status of spec.statuses || []) frame.ns(block, D, 'domain:status', null, { s: status });
    }

    if (opts.chg) {
      const block = frame.ns(update, D, 'domain:chg');
      if (opts.chg.registrant !== undefined) frame.ns(block, D, 'domain:registrant', opts.chg.registrant);
      if (opts.chg.clearAuthInfo) {
        // <authInfo><null/> REMOVES the transfer secret rather than setting it to something. The
        // distinction matters after a leak: an empty <pw/> stores the empty string, which is a
        // value the holder can still present, so the domain stays as movable as it was. Only this
        // clears it. Mutually exclusive with setting one; the schema cannot express both.
        if (opts.chg.authInfo !== undefined) {
          throw new ValidationError(
            "domain:update 'chg' cannot both set 'authInfo' and clear it — "
            + "drop one of 'authInfo' / 'clearAuthInfo'",
          );
        }
        const ai = frame.ns(block, D, 'domain:authInfo');
        frame.ns(ai, D, 'domain:null');
      }
      if (opts.chg.authInfo !== undefined) {
        const ai = frame.ns(block, D, 'domain:authInfo');
        frame.ns(ai, D, 'domain:pw', opts.chg.authInfo);
      }
    }

    if (opts.restore) {
      const rgp = frame.ns(frame.extension(), ns.RGP, 'rgp:update');
      frame.ns(rgp, ns.RGP, 'rgp:restore', null, { op: 'request' });
    }
    if (opts.license != null) {
      const uri = this._client.requireRegistryExtUri('domain:update with a licence');
      const u = frame.ns(frame.extension(), uri, 'registry:update');
      frame.ns(u, uri, 'registry:license', opts.license);
    }

    // DNSSEC delta (RFC 5910): rem (specific or all), add, chg maxSigLife. At least one of them
    // is required, so an empty object emits no <secDNS:update> at all — a childless one is
    // schema-invalid and the server answers 2003 for a frame that expressed no change.
    const secDNS = opts.secDNS;
    if (secDNS && typeof secDNS === 'object'
      && (secDNS.remAll || secDNS.rem || secDNS.add || secDNS.maxSigLife != null)) {
      const secUpdate = frame.ns(frame.extension(), ns.SECDNS, 'secDNS:update');
      if (secDNS.remAll) {
        const rem = frame.ns(secUpdate, ns.SECDNS, 'secDNS:rem');
        frame.ns(rem, ns.SECDNS, 'secDNS:all', 'true');
      } else if (secDNS.rem) {
        const rem = frame.ns(secUpdate, ns.SECDNS, 'secDNS:rem');
        appendSecDnsRecords(frame, rem, secDNS.rem);
      }
      if (secDNS.add) {
        const add = frame.ns(secUpdate, ns.SECDNS, 'secDNS:add');
        appendSecDnsRecords(frame, add, secDNS.add);
      }
      if (secDNS.maxSigLife != null) {
        const chg = frame.ns(secUpdate, ns.SECDNS, 'secDNS:chg');
        frame.ns(chg, ns.SECDNS, 'secDNS:maxSigLife', String(parseInt(secDNS.maxSigLife, 10)));
      }
    }
    if (opts.fee != null) appendFeeAgreement(frame, 'update', opts.fee);
    return this._client.request(frame);
  }

  // fee (optional): the RFC 8748 price you agree to pay ('90.00' or { amount, currency }).
  //
  // curExpDate accepts EITHER form and needs no trimming by the caller: the date the registry wants
  // ('2027-04-01') or the full timestamp its <exDate> carries ('2027-04-01T09:15:00.0Z'), which is
  // what Response.expiryDate() returns. See dateOnly() for why this is the library's job.
  renew(name, curExpDate, years = 1, fee = null) {
    const frame = this._client.frame();
    const renew = frame.ns(frame.verb('renew'), D, 'domain:renew');
    frame.ns(renew, D, 'domain:name', name);
    frame.ns(renew, D, 'domain:curExpDate', dateOnly(curExpDate));
    frame.ns(renew, D, 'domain:period', String(parseInt(years, 10)), { unit: 'y' });
    if (fee != null) appendFeeAgreement(frame, 'renew', fee);
    return this._client.request(frame);
  }

  delete(name) {
    const frame = this._client.frame();
    const del = frame.ns(frame.verb('delete'), D, 'domain:delete');
    frame.ns(del, D, 'domain:name', name);
    return this._client.request(frame);
  }

  // Restore a redemption-period domain (rgp:restore op="request").
  // fee (optional): the RFC 8748 restore price you agree to pay.
  restore(name, fee = null) {
    const opts = { restore: true };
    if (fee != null) opts.fee = fee;
    return this.update(name, opts);
  }

  // op is one of request|approve|reject|cancel|query.
  // fee (optional): the RFC 8748 transfer price you agree to pay (request only).
  transfer(op, name, authInfo = null, years = null, fee = null) {
    const frame = this._client.frame();
    const transfer = frame.verb('transfer');
    transfer.attrs.op = op;
    const d = frame.ns(transfer, D, 'domain:transfer');
    frame.ns(d, D, 'domain:name', name);
    if (years !== null) frame.ns(d, D, 'domain:period', String(parseInt(years, 10)), { unit: 'y' });
    if (authInfo !== null) {
      const ai = frame.ns(d, D, 'domain:authInfo');
      frame.ns(ai, D, 'domain:pw', authInfo);
    }
    if (fee != null) appendFeeAgreement(frame, 'transfer', fee);
    return this._client.request(frame);
  }
}

class Contact {
  constructor(client) { this._client = client; }

  /**
   * Create a contact and let the registry choose the handle. Read it back with objectName():
   *
   *     const handle = (await client.contact.createAuto({ email: 'contact@example.com', … })).objectName();
   *
   * Useful when you have no naming scheme of your own, and when you would otherwise have to retry
   * around 2302 because someone else took the handle first. Every call mints a fresh one, so a
   * repeat is a second contact, never a collision.
   */
  createAuto(opts = {}) { return this.create(Contact.AUTO_ID, opts); }

  // Build a contact step by step. The id and e-mail are required by the registry, so they are
  // arguments here rather than steps you can forget. See Domain.createBuilder().
  //
  // Pass Contact.AUTO_ID as the id to have the registry mint the handle.
  createBuilder(id, email) { return new builders.ContactCreateBuilder(this, id, email); }

  /** Build a contact change step by step. */
  updateBuilder(id) { return new builders.ContactUpdateBuilder(this, id); }


  check(ids) {
    const frame = this._client.frame();
    const check = frame.ns(frame.verb('check'), C, 'contact:check');
    for (const id of ids) frame.ns(check, C, 'contact:id', id);
    return this._client.request(frame);
  }

  info(id, authInfo = null) {
    const frame = this._client.frame();
    const info = frame.ns(frame.verb('info'), C, 'contact:info');
    frame.ns(info, C, 'contact:id', id);
    if (authInfo !== null) {
      const ai = frame.ns(info, C, 'contact:authInfo');
      frame.ns(ai, C, 'contact:pw', authInfo);
    }
    return this._client.request(frame);
  }

  create(id, opts = {}) {
    options.check(opts, CONTACT_CREATE_KEYS, 'contact:create');
    const frame = this._client.frame();
    const c = frame.ns(frame.verb('create'), C, 'contact:create');
    frame.ns(c, C, 'contact:id', id);

    if (opts.postalInfos && opts.postalInfos.length) {
      for (const pi of opts.postalInfos) appendPostalInfo(frame, c, pi);
    } else {
      appendPostalInfo(frame, c, {
        name: opts.name, org: opts.org, street: opts.street, city: opts.city,
        sp: opts.sp, pc: opts.pc, cc: opts.cc, type: opts.type || 'int',
      });
    }
    if (opts.voice) frame.ns(c, C, 'contact:voice', opts.voice);
    if (opts.fax) frame.ns(c, C, 'contact:fax', opts.fax);
    if (!opts.email) {
      // RFC 5733 requires a contact email (emailType minLength 1). Fail fast client-side.
      throw new ValidationError("contact.create() requires a non-empty 'email'");
    }
    frame.ns(c, C, 'contact:email', opts.email);
    const ai = frame.ns(c, C, 'contact:authInfo');
    frame.ns(ai, C, 'contact:pw', opts.authInfo || '');
    if (opts.disclose) appendDisclose(frame, c, opts.disclose);
    return this._client.request(frame);
  }

  update(id, opts = {}) {
    // Plain words first - see canonicalise().
    opts = canonicalise(opts, { change: 'chg', removeStatuses: 'remStatuses' });
    options.check(opts, CONTACT_UPDATE_KEYS, 'contact:update');
    if (opts.chg) options.check(opts.chg, CONTACT_CHG_KEYS, "contact:update 'chg'");
    const frame = this._client.frame();
    const update = frame.ns(frame.verb('update'), C, 'contact:update');
    frame.ns(update, C, 'contact:id', id);
    // contact:updateType allows a SINGLE add/rem block (each holding up to 7 statuses); emit
    // the wrapper once and append every status into it.
    if (opts.addStatuses && opts.addStatuses.length) {
      const add = frame.ns(update, C, 'contact:add');
      for (const status of opts.addStatuses) frame.ns(add, C, 'contact:status', null, { s: status });
    }
    if (opts.remStatuses && opts.remStatuses.length) {
      const rem = frame.ns(update, C, 'contact:rem');
      for (const status of opts.remStatuses) frame.ns(rem, C, 'contact:status', null, { s: status });
    }
    if (opts.chg) {
      const block = frame.ns(update, C, 'contact:chg');
      // RFC 5733 chg order: postalInfo*, voice?, fax?, email?, authInfo?, disclose?
      let pis = opts.chg.postalInfos;
      if (!pis && opts.chg.postalInfo) pis = [opts.chg.postalInfo];
      for (const pi of pis || []) appendPostalInfo(frame, block, pi, true);
      if (opts.chg.voice !== undefined) frame.ns(block, C, 'contact:voice', opts.chg.voice);
      if (opts.chg.fax !== undefined) frame.ns(block, C, 'contact:fax', opts.chg.fax);
      if (opts.chg.email !== undefined) frame.ns(block, C, 'contact:email', opts.chg.email);
      if (opts.chg.authInfo !== undefined) {
        const ai = frame.ns(block, C, 'contact:authInfo');
        frame.ns(ai, C, 'contact:pw', opts.chg.authInfo);
      }
      if (opts.chg.disclose) appendDisclose(frame, block, opts.chg.disclose);
    }
    return this._client.request(frame);
  }

  delete(id) {
    const frame = this._client.frame();
    const del = frame.ns(frame.verb('delete'), C, 'contact:delete');
    frame.ns(del, C, 'contact:id', id);
    return this._client.request(frame);
  }

  transfer(op, id, authInfo = null) {
    const frame = this._client.frame();
    const transfer = frame.verb('transfer');
    transfer.attrs.op = op;
    const c = frame.ns(transfer, C, 'contact:transfer');
    frame.ns(c, C, 'contact:id', id);
    if (authInfo !== null) {
      const ai = frame.ns(c, C, 'contact:authInfo');
      frame.ns(ai, C, 'contact:pw', authInfo);
    }
    return this._client.request(frame);
  }
}

/**
 * The reserved id that asks the registry to CHOOSE the handle instead of you naming it.
 *
 * Send it in place of a contact id on create. It is a request, not a name — the handle the registry
 * mints comes back in the response, and that reply is the only place it appears, so store what
 * objectName() gives you.
 */
Contact.AUTO_ID = 'autonic';

class Host {
  constructor(client) { this._client = client; }
  /** Build a nameserver change step by step. See Domain.createBuilder(). */
  updateBuilder(name) { return new builders.HostUpdateBuilder(this, name); }


  check(names) {
    const frame = this._client.frame();
    const check = frame.ns(frame.verb('check'), H, 'host:check');
    for (const name of names) frame.ns(check, H, 'host:name', name);
    return this._client.request(frame);
  }

  info(name) {
    const frame = this._client.frame();
    const info = frame.ns(frame.verb('info'), H, 'host:info');
    frame.ns(info, H, 'host:name', name);
    return this._client.request(frame);
  }

  // addresses: IPv4 or IPv6 literals; the version is auto-detected.
  create(name, addresses = []) {
    const frame = this._client.frame();
    const create = frame.ns(frame.verb('create'), H, 'host:create');
    frame.ns(create, H, 'host:name', name);
    for (const ip of addresses) frame.ns(create, H, 'host:addr', ip, { ip: ipVersion(ip) });
    return this._client.request(frame);
  }

  update(name, opts = {}) {
    // Plain words first - see canonicalise().
    opts = canonicalise(opts, { removeAddresses: 'remAddresses', removeStatuses: 'remStatuses' });
    options.check(opts, HOST_UPDATE_KEYS, 'host:update');
    const frame = this._client.frame();
    const update = frame.ns(frame.verb('update'), H, 'host:update');
    frame.ns(update, H, 'host:name', name);
    const groups = [
      ['add', opts.addAddresses, opts.addStatuses],
      ['rem', opts.remAddresses, opts.remStatuses],
    ];
    for (const [op, addrs, statuses] of groups) {
      const a = addrs || [];
      const s = statuses || [];
      if (a.length === 0 && s.length === 0) continue;
      const block = frame.ns(update, H, `host:${op}`);
      for (const ip of a) frame.ns(block, H, 'host:addr', ip, { ip: ipVersion(ip) });
      for (const status of s) frame.ns(block, H, 'host:status', null, { s: status });
    }
    // RENAMING IS NOT SUPPORTED by this registry: it reads only <host:add> and <host:rem>, so a
    // <host:chg> is discarded without comment. Sending one would mean an address change in the same
    // frame succeeds, the rename does not, and the caller is told 1000 — or, with newName alone,
    // the frame carries no change at all and draws an opaque 2003. Refused here instead, so the
    // answer comes from your own code, where it names the problem.
    if (opts.newName) {
      throw new ValidationError(
        'host rename is not supported by this registry (host:chg is ignored) — '
        + 'create the new host, re-point the domains with domain:update, then delete the old one',
      );
    }
    return this._client.request(frame);
  }

  delete(name, force = false) {
    const frame = this._client.frame();
    const del = frame.ns(frame.verb('delete'), H, 'host:delete');
    frame.ns(del, H, 'host:name', name);
    if (force) {
      // Registry extension: detach the host from every domain before deleting it. Not every
      // registry offers this, so the URI comes from the greeting and its absence is reported rather
      // than guessed at — a forced delete sent without the extension the server knows is an
      // ORDINARY delete, which fails on a host that is still in use and leaves the caller wondering
      // why `force` did nothing.
      const uri = this._client.requireRegistryExtUri('host:delete with force');
      const u = frame.ns(frame.extension(), uri, 'registry:delete');
      frame.ns(u, uri, 'registry:deleteNS', null, { confirm: 'yes' });
    }
    return this._client.request(frame);
  }
}

class Poll {
  constructor(client) { this._client = client; }

  // Request the next service message (1301 with a message, 1300 when empty).
  request() {
    const frame = this._client.frame();
    frame.verb('poll').attrs.op = 'req';
    return this._client.request(frame);
  }

  // Acknowledge a message, which DELETES it at the registry. There is no way to get it back.
  ack(messageId) {
    const frame = this._client.frame();
    const poll = frame.verb('poll');
    poll.attrs.op = 'ack';
    poll.attrs.msgID = String(messageId);
    return this._client.request(frame);
  }

  // Read the queue to the end, handing each notice to your callback.
  //
  //   await client.poll.drain(async (notice) => {
  //     await store(notice.queueMessage(), notice.pendingActionData());
  //   });
  //
  // The ORDER is the point, and it is the thing this loop exists to get right: the message is
  // acknowledged only AFTER your callback resolves. An ack deletes the notice at the registry
  // permanently, so a loop that acks first and processes second loses every notice whose
  // processing fails — a transfer request, a delete notification, the outcome of a pending create
  // — with nothing left to retry from and no record that anything was lost.
  //
  // So: if your callback rejects, the notice is NOT acked. It stays at the head of the queue and
  // the rejection reaches you. Fix the cause and drain again; nothing was lost. That also means a
  // callback which always fails will see the same notice every time — deliberately, because the
  // alternative is discarding it.
  //
  // Delivery is AT LEAST ONCE. If the acknowledgement itself fails — the connection drops between
  // your callback resolving and the ack landing — the notice is still in the queue and the next
  // drain hands it to you again. Make the callback idempotent and use messageId() as the
  // de-duplication key; it is the registry's own identifier for that notice.
  //
  // Resolves to the number of notices processed successfully. Stops at the first empty queue (1300);
  // any other reply that carries no notice is thrown rather than read as "empty".
  // `limit` of 0 means "until the queue is empty"; a queue that fills faster than you drain it
  // would otherwise keep this call running forever.
  async drain(handler, limit = 0) {
    let processed = 0;
    while (limit === 0 || processed < limit) {
      const notice = await this.request();
      // Only 1300 means the queue is empty. Inferring emptiness from "no <msgQ>" would make a
      // refusal — the session closed, the account suspended — look exactly like a drained queue,
      // and the loop would report success while nothing had been read.
      if (notice.code() === ResultCode.SUCCESS_NO_MESSAGES) break;
      const messageId = notice.messageId();
      if (messageId === null) {
        throw commandErrorFor(
          notice.code(),
          `poll returned neither a message nor an empty queue (EPP ${notice.code()}: ${notice.message() || 'no message'})`,
          notice,
        );
      }
      await handler(notice);
      await this.ack(messageId);
      processed += 1;
    }
    return processed;
  }}

module.exports = { Domain, Contact, Host, Poll };