'use strict';

const { parseXml } = require('./xml');
const { FEE } = require('./namespaces');
const { ConnectionError } = require('./errors');

// A parsed EPP response (or greeting). Wraps the raw XML with convenience accessors: the
// result code/message, transaction ids, the availability map for *:check, and generic
// value/values getters plus the underlying element tree for anything bespoke.
//
// Element lookups are namespace-agnostic (by local name), so a variation in the response's
// namespace prefixes never breaks a getter.

function* walk(node) {
  yield node;
  for (const child of node.children) yield* walk(child);
}

function nodeText(node) {
  return node ? node.text.trim() : '';
}

function escapeXml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// Re-emits a parsed node as XML. Used only to hand an <extValue> payload back to the caller in the
// form it arrived, for content this client deliberately does not interpret.
function serialize(node) {
  const attrs = Object.entries(node.attrs || {})
    .map(([k, v]) => ` ${k}="${escapeXml(v)}"`).join('');
  const inner = node.children.length
    ? node.children.map(serialize).join('')
    : escapeXml(node.text || '');
  return `<${node.name}${attrs}>${inner}</${node.name}>`;
}

// Absent @ip means v4 per the host schema's default, so an IPv4-only registry that omits the
// attribute must not come back labelled as something else.
function addressesOf(nodes) {
  const out = [];
  for (const node of nodes) {
    const ip = node.text.trim();
    if (ip) out.push({ ip, version: (node.attrs && node.attrs.ip) || 'v4' });
  }
  return out;
}

function directChild(node, local) {
  if (!node) return null;
  for (const child of node.children) {
    if (child.local === local) return child;
  }
  return null;
}

class Response {
  constructor(raw, root) {
    this._raw = raw;
    this._root = root;
  }

  // Rejects anything that is not one well-formed element tree: a TRUNCATED frame must never be
  // read as a successful command (parseXml raises ConnectionError; this covers "no element").
  static fromXml(xml) {
    const root = parseXml(xml);
    if (!root) throw new ConnectionError('Server returned malformed XML: no element');
    return new Response(xml, root);
  }

  _all(local) {
    const out = [];
    for (const node of walk(this._root)) if (node.local === local) out.push(node);
    return out;
  }

  _first(local) {
    for (const node of walk(this._root)) if (node.local === local) return node;
    return null;
  }

  // --- result / trID ---------------------------------------------------------

  code() {
    const result = this._first('result');
    if (!result) return 0;
    const raw = result.attrs.code;
    return raw && /^\d+$/.test(raw) ? parseInt(raw, 10) : 0;
  }

  message() {
    const result = this._first('result');
    const msg = directChild(result, 'msg');
    return msg ? nodeText(msg) : null;
  }

  // The language of the result <msg> ("en", "uk", "ua" or "ru"), or null.
  messageLang() {
    const result = this._first('result');
    const msg = directChild(result, 'msg');
    return msg && msg.attrs.lang !== undefined ? msg.attrs.lang : null;
  }

  isSuccess() {
    const code = this.code();
    return code >= 1000 && code < 2000;
  }

  isPending() {
    return this.code() === 1001;
  }

  isGreeting() {
    return this._first('greeting') !== null;
  }

  clTRID() {
    const node = directChild(this._first('trID'), 'clTRID');
    return node ? nodeText(node) : null;
  }

  svTRID() {
    const node = directChild(this._first('trID'), 'svTRID');
    return node ? nodeText(node) : null;
  }

  // --- check / poll ----------------------------------------------------------

  // Availability map for a *:check response: name/id => is-available.
  availability() {
    // Only the name/id CHILD of a *:cd block. Matching any element carrying an avail attribute
    // would also catch fee:cd, which puts avail="0" on the block ITSELF (fee:objID + fee:reason
    // inside) when a zone is not served or the requested currency is not priced — that is a junk
    // entry sitting beside the real one, and any check carrying a fee query can produce it.
    const out = {};
    for (const node of walk(this._root)) {
      if (node.local !== 'cd') continue;
      for (const child of node.children) {
        if (child.attrs.avail !== undefined) {
          out[child.text.trim()] = child.attrs.avail === '1' || child.attrs.avail === 'true';
        }
      }
    }
    return out;
  }

  // Poll only: the queued message id to pass to poll.ack(), or null.
  messageId() {
    const msgq = this._first('msgQ');
    return msgq && msgq.attrs.id !== undefined ? msgq.attrs.id : null;
  }

  // Poll only: how many messages remain in the queue.
  messageCount() {
    const msgq = this._first('msgQ');
    if (!msgq || msgq.attrs.count === undefined) return 0;
    return /^\d+$/.test(msgq.attrs.count) ? parseInt(msgq.attrs.count, 10) : 0;
  }

  // Poll only: the QUEUED NOTICE text, from <msgQ><msg>.
  //
  // NOT the same as message(), which returns <result><msg> — the command-result banner
  // ("Command completed successfully; ack to dequeue"), identical on every poll reply. Reading a
  // notice with message() hands you that constant string while the real content is discarded, and
  // the ack then dequeues it at the registry permanently.
  queueMessage() {
    const msg = directChild(this._first('msgQ'), 'msg');
    return msg ? nodeText(msg) : null;
  }

  // Poll only: the language of the queued notice ('uk' | 'ru' | 'en'), or null.
  queueMessageLang() {
    const msg = directChild(this._first('msgQ'), 'msg');
    return msg && msg.attrs.lang !== undefined ? msg.attrs.lang : null;
  }

  // Poll only: when the notice was queued (<msgQ><qDate>), or null.
  queueDate() {
    const q = directChild(this._first('msgQ'), 'qDate');
    return q ? nodeText(q) : null;
  }

  // Poll only: the outcome of an operation the registry processed OFFLINE (<domain:panData> /
  // <contact:panData>, RFC 5731 §3.3 / RFC 5733 §3.3). Null when the message carries none.
  //
  // This is how a deferred command reports back: you send domain:create, get 1001 ("queued; the
  // result will arrive via poll") with an svTRID, and the answer arrives later as a poll message.
  //
  //  - success  the paResult attribute, and THE ONLY thing that says whether it worked. The
  //             surrounding <result code="1301"> means "here is a message", not "your operation
  //             succeeded" — reading that instead makes every poll answer look like a success.
  //  - svTRID   from <paTRID>: the id of the ORIGINAL command. Match it against the one you were
  //             given with the 1001 to know WHICH pending operation this is about. Poll is a
  //             queue; do not assume it is the most recent one.
  //  - date     <paDate>, when the action completed — not when you polled.
  //
  // Matched by LOCAL NAME, so it works for every object namespace and dialect.
  pendingActionData() {
    const pan = this._first('panData');
    if (!pan) return null;
    const nameEl = this._firstIn(pan, 'name') || this._firstIn(pan, 'id');
    // xs:boolean: '1' and 'true' both mean success. Anything else — including absent — is not a
    // yes: a missing verdict is not a verdict.
    const flag = nameEl && nameEl.attrs.paResult !== undefined ? String(nameEl.attrs.paResult) : '';
    const trid = this._firstIn(pan, 'paTRID');
    const dateEl = this._firstIn(pan, 'paDate');
    const inTrid = (local) => {
      const n = trid ? this._firstIn(trid, local) : null;
      const t = n ? nodeText(n) : '';
      return t === '' ? null : t;
    };
    return {
      object: nameEl ? nodeText(nameEl) : '',
      success: flag === '1' || flag.toLowerCase() === 'true',
      clTRID: inTrid('clTRID'),
      svTRID: inTrid('svTRID'),
      date: dateEl ? nodeText(dateEl) : null,
    };
  }

  // First DESCENDANT of `node` with this local name, in any namespace — directChild() only looks
  // one level down, and paTRID's clTRID/svTRID are two.
  _firstIn(node, local) {
    if (!node || !node.children) return null;
    for (const child of node.children) {
      if (!child || typeof child !== 'object') continue;
      if (child.local === local) return child;
      const deeper = this._firstIn(child, local);
      if (deeper) return deeper;
    }
    return null;
  }

  // Object status values from the `s` attribute (e.g. ['ok'] or ['clientHold', ...]).
  statuses() {
    return this._all('status').map((n) => n.attrs.s).filter((s) => s !== undefined);
  }

  // --- balance / prices / licence -------------------------------------------

  // Account figures from a balance:info response, or null when not a balance response.
  balance() {
    const limit = this.value('creditLimit');
    const avail = this.value('availableCredit');
    if (limit === null && avail === null) return null;
    return {
      creditLimit: limit || '',
      balance: this.value('balance') || '',
      availableCredit: avail || '',
    };
  }

  // Renewal/restore price hints from a domain:info response, keyed by operation.
  prices() {
    const out = {};
    for (const node of this._all('price')) {
      const op = node.attrs.operation;
      if (!op) continue;
      out[op] = { value: node.text.trim(), currency: node.attrs.currency || '' };
    }
    return out;
  }

  /**
   * The price channel this domain is billed on, as an opaque id — the key that matches these
   * prices to a row of the registry's published price catalogue.
   *
   * null when the response carries no price data. A domain registered long ago may sit on a
   * different channel from the one a new registration in the same zone would use, which is why
   * this is per-domain rather than per-zone.
   */
  priceChannel() {
    const node = this._first('priceData');
    const channel = node && node.attrs.channel ? String(node.attrs.channel).trim() : '';
    return channel || null;
  }

  /**
   * The registrar of record at the registry, when it is not you.
   *
   * sponsor() names the account this object belongs to — yours, in your own reseller hierarchy.
   * This names the handle the registry's own WHOIS and RDAP publish as the registrar, which for a
   * reseller is a different party. null when the response does not carry one.
   */
  registrarOfRecord() {
    const node = this._first('registrar');
    const handle = node ? String(node.text || '').trim() : '';
    return handle || null;
  }

  // Per-name prices from a domain.check(names, fee) response (RFC 8748 fee:chkData),
  // keyed by domain name:
  //
  //   { _currency: 'UAH',
  //     'example.com.ua': {
  //       avail: true,             // false => see reason (unknown zone, currency…)
  //       class: 'premium',        // present only for premium names
  //       reason: null,
  //       commands: { create: { years: 1, fee: '100.00' },
  //                   renew:  { years: 1, fee: '90.00' } } } }
  //
  // Empty object when the response carries no fee data. (The fee chkData is told apart from the
  // domain one by its NAMESPACE, never by looking for a direct <currency> child: fee:currency is
  // optional, so a response that omits it still carries a full set of prices.)
  fees() {
    let chk = null;
    for (const el of this._all('chkData')) {
      if (el.ns === FEE) { chk = el; break; }
    }
    if (!chk) return {};
    const out = { _currency: nodeText(directChild(chk, 'currency')) };
    for (const cd of chk.children) {
      if (cd.local !== 'cd') continue;
      const name = nodeText(directChild(cd, 'objID'));
      const entry = {
        avail: cd.attrs.avail !== '0',
        reason: nodeText(directChild(cd, 'reason')) || null,
        commands: {},
        periods: [],
      };
      const klass = nodeText(directChild(cd, 'class'));
      if (klass) entry.class = klass;
      for (const cmd of cd.children) {
        if (cmd.local !== 'command') continue;
        const feeEl = directChild(cmd, 'fee');
        const c = {
          years: parseInt(nodeText(directChild(cmd, 'period')) || '1', 10),
          fee: feeEl ? nodeText(feeEl) : null,
        };
        const cmdReason = nodeText(directChild(cmd, 'reason'));
        if (cmdReason) c.reason = cmdReason;
        const op = cmd.attrs.name || '';
        entry.periods.push({ op, ...c });
        // Asking one operation at several periods brings back one <fee:command> per period, all
        // with the same name. The map keeps the FIRST — the period you asked for first — so a
        // caller reading commands.create still gets an answer. Read `periods` for the rest.
        if (!(op in entry.commands)) entry.commands[op] = c;
      }
      out[name] = entry;
    }
    return out;
  }

  // The fee actually charged, echoed on a successful transform that carried a fee
  // agreement (fee:creData / renData / trnData / updData), e.g.
  // { currency: 'UAH', fee: '100.00' } — or null when the response has none.
  // (Told apart from the domain block by its NAMESPACE, not by the presence of a currency child:
  // fee:currency is optional, so a transform that WAS charged can arrive without one.)
  chargedFee() {
    for (const local of ['creData', 'renData', 'trnData', 'updData', 'delData']) {
      for (const el of this._all(local)) {
        if (el.ns !== FEE) continue;
        return { currency: nodeText(directChild(el, 'currency')), fee: nodeText(directChild(el, 'fee')) };
      }
    }
    return null;
  }

  // The trademark or licence number from a domain:info response, or null. Carried in the registry's
  // own extension, so it is present only where that registry has one.
  license() {
    return this.value('license');
  }

  // RGP status values from a domain:info response (e.g. ['redemptionPeriod']).
  rgpStatus() {
    return this._all('rgpStatus').map((n) => n.attrs.s).filter((s) => s !== undefined);
  }

  // The transfer status from a transfer response or poll trnData (e.g. "pending"), or null.
  transferStatus() {
    return this.value('trStatus');
  }

  // --- DNSSEC ----------------------------------------------------------------

  // DNSSEC DS records from a domain:info response (secDNS:dsData).
  dsRecords() {
    return this._all('dsData').map((ds) => ({
      keyTag: parseInt(nodeText(directChild(ds, 'keyTag')) || '0', 10),
      alg: parseInt(nodeText(directChild(ds, 'alg')) || '0', 10),
      digestType: parseInt(nodeText(directChild(ds, 'digestType')) || '0', 10),
      digest: nodeText(directChild(ds, 'digest')),
    }));
  }

  // DNSSEC key records from a domain:info response (top-level secDNS:keyData).
  keyRecords() {
    const out = [];
    for (const inf of this._all('infData')) {
      for (const kd of inf.children) {
        if (kd.local !== 'keyData') continue;
        out.push({
          flags: parseInt(nodeText(directChild(kd, 'flags')) || '0', 10),
          protocol: parseInt(nodeText(directChild(kd, 'protocol')) || '0', 10),
          alg: parseInt(nodeText(directChild(kd, 'alg')) || '0', 10),
          pubKey: nodeText(directChild(kd, 'pubKey')),
        });
      }
    }
    return out;
  }

  // True when a domain:info response carries DNSSEC data (any DS or key records).
  isSigned() {
    return this.dsRecords().length > 0 || this.keyRecords().length > 0;
  }

  // --- diagnostics / greeting -----------------------------------------------

  // The object this response is about: a domain name, a host name or a contact id.
  objectName() {
    // Taken from the DIRECT child of the object block. A document-wide search for <name> would
    // find a contact's postalInfo name first, so contact:info would answer with the person's full
    // name where the caller asked for the handle — and feeding that back as an id draws 2303.
    const data = this.resData();
    const obj = data && data.children.length ? data.children[0] : null;
    if (obj) {
      for (const child of obj.children) {
        if ((child.local === 'id' || child.local === 'name') && child.text.trim()) {
          return child.text.trim();
        }
      }
    }
    return this.value('name') || this.value('id');
  }

  // Expiry, as the registry sent it. Kept as the SERVER's string rather than a Date: the registry
  // decides which calendar day a renewal lands on, and re-formatting through a local timezone is how
  // a client ends up displaying — and renewing against — the day before.
  expiryDate() {
    return this.value('exDate');
  }

  // When the object was created, as the registry sent it.
  createdDate() {
    return this.value('crDate');
  }

  // When the object was last changed, as the registry sent it; null if never.
  updatedDate() {
    return this.value('upDate');
  }

  // The registry's own identifier for the object (ROID).
  roid() {
    return this.value('roid');
  }

  // The registrant contact handle of a domain.
  registrant() {
    return this.value('registrant');
  }

  // The registrar currently sponsoring the object.
  sponsor() {
    return this.value('clID');
  }

  // A domain's nameservers, however the registry expressed them: <hostObj> (a reference to a host
  // object) or <hostAttr> (the name inlined with its glue). Reading only one model returns an empty
  // list against a registry using the other, which reads as "this domain has no nameservers".
  nameservers() {
    const out = [];
    for (const node of walk(this._root)) {
      if (node.local === 'hostObj') out.push(node.text.trim().toLowerCase());
      if (node.local === 'hostName') out.push(node.text.trim().toLowerCase());
    }
    return [...new Set(out.filter(Boolean))];
  }

  // A domain's role contacts, keyed by role: { admin: ['c-1'], tech: ['c-1','c-2'] }.
  // The registrant is NOT included — it is a separate element with its own meaning, see registrant().
  contacts() {
    const out = {};
    for (const node of walk(this._root)) {
      if (node.local !== 'contact') continue;
      const role = node.attrs && node.attrs.type;
      const handle = node.text.trim();
      if (!role || !handle) continue;
      (out[role] = out[role] || []).push(handle);
    }
    return out;
  }

  // The handles in ONE role: contactsFor('tech') => ['c-tech1', 'c-tech2'].
  // Empty when the domain carries nobody in that role — a legitimate answer, not an error, since
  // only the registrant is mandatory everywhere. The role is matched case-insensitively: registries
  // are inconsistent about `tech` vs `Tech`, and an exact lookup silently reports "no technical
  // contact" for a domain that has one.
  contactsFor(role) {
    const map = this.contacts();
    for (const key of Object.keys(map)) {
      if (key.toLowerCase() === String(role).toLowerCase()) return map[key];
    }
    return [];
  }

  // The administrative contacts — the people authorised to make decisions about the domain.
  adminContacts() {
    return this.contactsFor('admin');
  }

  // The technical contacts — the people to reach about DNS and delegation.
  techContacts() {
    return this.contactsFor('tech');
  }

  // The billing contacts — the people to reach about invoices for this domain.
  billingContacts() {
    return this.contactsFor('billing');
  }

  // Every handle attached to the domain in any capacity, registrant included, de-duplicated.
  // Use this when you care THAT a contact is referenced rather than in which role — deleting a
  // contact, or working out which of your contact objects are still in use.
  allContacts() {
    const out = [];
    const registrant = this.registrant();
    if (registrant) out.push(registrant);
    for (const handles of Object.values(this.contacts())) out.push(...handles);
    return [...new Set(out)];
  }

  // Subordinate hosts — nameserver objects that live UNDER this domain, listed as
  // <domain:host>ns1.example.com.ua</domain:host> in a domain:info response.
  // The registry refuses to delete a domain while these exist, so check the list before a delete
  // and remove or rename them first.
  subordinateHosts() {
    const out = [];
    for (const node of walk(this._root)) {
      if (node.local === 'host' && node.children.length === 0) {
        const name = node.text.trim().toLowerCase();
        if (name) out.push(name);
      }
    }
    return [...new Set(out)];
  }

  // A host object's glue addresses: [{ ip: '192.0.2.1', version: 'v4' }, ...].
  // Only a host INSIDE the zone it serves carries glue; for an external nameserver the registry
  // returns none, and that is normal rather than a missing answer.
  hostAddresses() {
    // Scoped to the host object itself. A document-wide search would also match the glue inside a
    // domain's hostAttr blocks — flattening the addresses of DIFFERENT nameservers into one list,
    // which reads as a single well-addressed host and loses which IP belongs to which name.
    // Per-name glue is nameserverAddresses(). The contact <addr> is a container, hence the leaf test.
    const data = this.resData();
    const obj = data && data.children.length ? data.children[0] : null;
    if (!obj) return [];
    return addressesOf(obj.children.filter((c) => c.local === 'addr' && c.children.length === 0));
  }

  // A domain's INLINE glue, keyed by nameserver name:
  // { 'ns1.example.com.ua': [{ ip: '192.0.2.1', version: 'v4' }] }.
  // Only populated for registries that answer with <domain:hostAttr>; one answering with
  // <domain:hostObj> returns the names alone and you fetch the addresses with a host:info per name.
  // Either way nameservers() gives you the names, so use that for the list and this for the glue —
  // an empty result here does NOT mean the domain is undelegated.
  nameserverAddresses() {
    const out = {};
    for (const attr of this._all('hostAttr')) {
      const name = nodeText(directChild(attr, 'hostName')).toLowerCase();
      if (!name) continue;
      out[name] = addressesOf(attr.children.filter((c) => c.local === 'hostAddr'));
    }
    return out;
  }

  // The object's authorisation code (<authInfo><pw>), or null when the registry withheld it.
  // Present only for the sponsoring registrar, and only on info commands that asked for it. This is
  // the secret that lets ANY registrar take the domain away from you: never log it, never put it in
  // a support ticket, and roll it after you have passed it to a customer.
  authInfo() {
    for (const node of walk(this._root)) {
      if (node.local !== 'authInfo') continue;
      const pw = nodeText(directChild(node, 'pw'));
      if (pw) return pw;
    }
    return null;
  }

  // A contact's disclosure preference: { flag: true, elements: ['email', 'voice'] }, or null when
  // the contact carries no preference and registry policy alone applies.
  // `flag` true means the listed elements MAY be published; false means they must be withheld. The
  // elements NOT listed take the opposite of the flag, so the list is meaningless without it.
  disclose() {
    const el = this._first('disclose');
    if (!el) return null;
    const elements = [];
    for (const node of walk(el)) {
      if (node === el) continue;
      // postalInfo name/org/addr are distinguished by @type ("int" or "loc").
      const type = node.attrs && node.attrs.type;
      elements.push(type ? `${node.local}:${type}` : node.local);
    }
    const flag = el.attrs && el.attrs.flag;
    return { flag: flag === '1' || flag === 'true', elements };
  }

  // The quoted price for ONE operation at ONE period, or null when the answer carried no such quote.
  //
  //   const r = await client.domain.check(['example1.com.ua'], { create: [1, 2, 5] });
  //   r.feeFor('example1.com.ua', 'create', 5);   // the five-year price
  //
  // Use this rather than indexing fees() whenever you asked one operation at several periods: the
  // map there holds one entry per operation. `transfer` and `restore` are one-year operations
  // however many years you ask for, so read those back at 1.
  feeFor(name, operation, years = 1) {
    const all = this.fees();
    for (const key of Object.keys(all)) {
      if (key === '_currency' || key.toLowerCase() !== String(name).toLowerCase()) continue;
      for (const quote of all[key].periods || []) {
        if (quote.op === operation && quote.years === years) return quote.fee;
      }
    }
    return null;
  }

  // The registry's fee class for a name, e.g. 'premium' or 'standard'; null when the answer carried
  // no class. Take the price from fees() rather than inferring it from the class — the class says
  // which price list applies, not what it costs.
  feeClass(name) {
    const all = this.fees();
    for (const key of Object.keys(all)) {
      if (key === '_currency') continue;
      if (name && key.toLowerCase() !== String(name).toLowerCase()) continue;
      if (all[key] && all[key].class) return all[key].class;
    }
    return null;
  }

  // Whether the registry priced the name outside the standard list.
  // A false here is not a promise of the standard price — it means the answer declared no special
  // class. Always charge from fees(), and re-check the fee on the create itself.
  isPremium(name) {
    const cls = this.feeClass(name);
    return cls !== null && cls.toLowerCase() !== 'standard';
  }

  // Why a name in a check response is unavailable, e.g. "In use" or "Reserved"; null when it is
  // available or the registry gave no reason.
  unavailableReason(name) {
    for (const cd of this._all('cd')) {
      const label = directChild(cd, 'name') || directChild(cd, 'id');
      if (!label || label.text.trim().toLowerCase() !== String(name).toLowerCase()) continue;
      return nodeText(directChild(cd, 'reason')) || null;
    }
    return null;
  }

  // The registrar that created the object.
  createdBy() {
    return this.value('crID');
  }

  // The registrar that last changed the object, or null when it has never been changed.
  // Sent only to the sponsoring registrar. Pair it with updatedDate() when reconciling your own
  // records: a change you did not make means it came from the registry side or from a support
  // action, not from your system.
  updatedBy() {
    return this.value('upID');
  }

  // When the object last changed hands, or null if it never has.
  transferDate() {
    return this.value('trDate');
  }

  // A transfer notice in full — who asked, when, who must answer, and by when:
  // { status, requestedBy, requestedAt, actingClient, actBy, expiryDate }, or null.
  // transferStatus() alone says a transfer is pending without saying whose or how long you have to
  // act, and `actBy` is the deadline after which the registry decides for you.
  transfer() {
    const el = this._first('trnData');
    if (!el) return null;
    return {
      status: nodeText(directChild(el, 'trStatus')),
      requestedBy: nodeText(directChild(el, 'reID')),
      requestedAt: nodeText(directChild(el, 'reDate')),
      actingClient: nodeText(directChild(el, 'acID')),
      actBy: nodeText(directChild(el, 'acDate')),
      expiryDate: nodeText(directChild(el, 'exDate')),
    };
  }

  // What the registry did to one of your objects without you asking — RFC 8590 change poll:
  // { operation, op, state, date, svTRID, who, reason }, or null.
  //
  // A poll notice about a server-initiated change carries a human sentence in <msg>, and that
  // sentence is written in your account's notification language. This is the same event stated so
  // that code can act on it; the object itself is in <resData> as usual.
  //
  // `state` says which way that object reads: 'before' describes it as it last was (a domain that
  // no longer exists cannot be described any other way), 'after' describes it as it now is —
  // treating a 'before' block as current is how a client resurrects a deleted object in its own
  // store. `who` is free text for audit and the server chooses what to put there — a role, a name
  // or an identifier; 'Registry' means the change came from the registry side rather than from your
  // account. `op` qualifies a 'custom' operation with the registry's own verb and is empty for the
  // operations the RFC enumerates. `reason` is the registry's finer name for the event where it
  // has one.
  //
  // Null when the response carries no change block — including when you did not announce
  // urn:ietf:params:xml:ns:changePoll-1.0 at login, since a server sends this only on request.
  change() {
    const el = this._first('changeData');
    if (!el) return null;
    const operation = directChild(el, 'operation');
    return {
      operation: nodeText(operation),
      op: (operation && operation.attrs && operation.attrs.op) || '',
      // 'after' is the schema default, so an omitted attribute means 'after', not "unknown".
      state: (el.attrs && el.attrs.state) || 'after',
      date: nodeText(directChild(el, 'date')),
      svTRID: nodeText(directChild(el, 'svTRID')),
      who: nodeText(directChild(el, 'who')),
      reason: nodeText(directChild(el, 'reason')),
    };
  }

  // A contact's e-mail address.
  email() {
    return this.value('email');
  }

  // A contact's voice number, in the EPP +CC.NNNN form.
  voice() {
    return this.value('voice');
  }

  // A contact's fax number, in the EPP +CC.NNNN form.
  fax() {
    return this.value('fax');
  }

  // A contact's postal addresses, keyed by form: 'int' (ASCII, always accepted by every registry)
  // and 'loc' (the local script, e.g. Cyrillic). A contact may carry either or both.
  // Each entry: { name, org, street: [], city, sp, pc, cc }, missing parts as ''.
  // Read .int when you need something you can safely print anywhere; read .loc when you want the
  // address as the registrant actually wrote it.
  postalInfo() {
    const out = {};
    for (const el of this._all('postalInfo')) {
      const type = (el.attrs && el.attrs.type) || 'int';
      const addr = directChild(el, 'addr');
      out[type] = {
        name: nodeText(directChild(el, 'name')),
        org: nodeText(directChild(el, 'org')),
        street: (addr ? addr.children : []).filter((c) => c.local === 'street').map((c) => c.text.trim()),
        city: nodeText(directChild(addr, 'city')),
        sp: nodeText(directChild(addr, 'sp')),
        pc: nodeText(directChild(addr, 'pc')),
        cc: nodeText(directChild(addr, 'cc')),
      };
    }
    return out;
  }

  // Is this one name available? null when the response says nothing about it — which is NOT the
  // same as "taken", and must not look the same when the next line registers the name.
  isAvailable(name) {
    const map = this.availability();
    for (const key of Object.keys(map)) {
      if (key.toLowerCase() === String(name).toLowerCase()) return map[key];
    }
    return null;
  }

  // Your credit limit, or null when the response carries no balance block.
  creditLimit() {
    const b = this.balance();
    return b ? b.creditLimit : null;
  }

  // Your current balance. Named for what it is, because balance() returns the whole block.
  // Money is a decimal STRING throughout: never convert it to a number before doing arithmetic.
  currentBalance() {
    const b = this.balance();
    return b ? b.balance : null;
  }

  // What you can still spend: balance plus any credit limit.
  availableCredit() {
    const b = this.balance();
    return b ? b.availableCredit : null;
  }

  // The amount charged for the command just executed, or null when it carried no fee.
  feeAmount() {
    const f = this.chargedFee();
    return f ? f.fee : null;
  }

  // The currency of feeAmount().
  feeCurrency() {
    const f = this.chargedFee();
    return f ? f.currency : null;
  }
  errorReasons() {
    const out = [];
    for (const ext of this._all('extValue')) {
      for (const node of walk(ext)) {
        if (node.local === 'reason') out.push(node.text.trim());
      }
    }
    return out;
  }
  // The <extValue> blocks in full: WHICH element the server is complaining about, not just the
  // complaint. This is how EPP identifies the offending part of a request — a check for five
  // domains that fails on one carries that one name here, and a server may relocate data it could
  // not return normally (RFC 9038) into the same place.
  //
  // errorReasons() gives the prose alone, which cannot be acted on: it tells you something was
  // rejected, never which of the five it was.
  //
  // Returns [{ element, namespace, text, values, xml, reason, lang }]. <value> is xs:any
  // processContents="skip", so its child may be in a namespace this client does not know — it is
  // reported as data, never parsed.
  //
  // The offending element is usually a leaf (<domain:name>bad..name</domain:name>), and then `text`
  // is the answer. When it is a CONTAINER — an RFC 9038 payload the server relocated here because
  // the client did not announce its namespace — `text` is empty, because a container has no
  // character data of its own. `values` carries the children by name, so the relocated figures are
  // still readable, and `xml` is the element as it arrived if you would rather re-parse it.
  extValues() {
    const out = [];
    for (const ext of this._all('extValue')) {
      const reason = directChild(ext, 'reason');
      const value = directChild(ext, 'value');
      const node = value && value.children.length ? value.children[0] : null;
      const values = {};
      if (node) for (const child of node.children) values[child.local] = child.text.trim();
      out.push({
        element: node ? node.local : '',
        namespace: node ? (node.ns || '') : '',
        text: node ? node.text.trim() : nodeText(value),
        values,
        xml: node ? serialize(node) : '',
        reason: nodeText(reason),
        lang: (reason && reason.attrs && reason.attrs.lang) || '',
      });
    }
    return out;
  }

  /**
   * Login only: the server's security warnings about THIS session (RFC 8807 loginSec:event).
   *
   * Each entry has `type` (password|certificate|cipher|tlsProtocol|newPW|stat|custom), `level`
   * ('warning' or 'error') and a human `text`, plus whichever of `name`, `exDate`, `value`,
   * `duration` and `lang` the event carries. A certificate about to expire arrives here as
   * type=certificate with the date in `exDate` — weeks before the day it would otherwise be
   * discovered, which is the day logins stop.
   *
   * Empty when the session is healthy, so treat any entry as something to act on. The server sends
   * these only to a client that took part in the extension; keep Config.loginSecurity on.
   */
  securityEvents() {
    const out = [];
    for (const data of this._all('loginSecData')) {
      for (const event of data.children) {
        if (event.local !== 'event') continue;
        const entry = { text: String(event.text || '').trim() };
        for (const attr of ['type', 'name', 'level', 'exDate', 'value', 'duration', 'lang']) {
          if (event.attrs[attr] !== undefined) entry[attr] = event.attrs[attr];
        }
        out.push(entry);
      }
    }
    return out;
  }

  // Greeting only: the object / extension services the server advertises.
  serviceObjUris() {
    return this._all('objURI').map((n) => n.text.trim());
  }

  serviceExtUris() {
    return this._all('extURI').map((n) => n.text.trim());
  }

  // --- generic getters -------------------------------------------------------

  // First element anywhere with this local name (namespace-agnostic), trimmed.
  value(local) {
    const node = this._first(local);
    return node ? nodeText(node) : null;
  }

  // Every element with this local name, trimmed.
  values(local) {
    return this._all(local).map((n) => n.text.trim());
  }

  // The <resData> element of the response, if present (for custom parsing).
  resData() {
    return this._first('resData');
  }

  raw() {
    return this._raw;
  }

  // The parsed element tree root, for anything bespoke.
  root() {
    return this._root;
  }
}

module.exports = { Response };



