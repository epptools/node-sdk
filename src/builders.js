'use strict';

const { ValidationError } = require('./errors');

// Fluent command builders.
//
// A builder is a typed façade over the options object the command takes. It builds no XML of its
// own: send() hands the options straight to the ordinary method, so a builder and the equivalent
// object produce the identical frame, and every check that applies to one applies to the other.
//
// Why reach for it: an options object accepts any key, so a misspelling is caught only by the
// library's list of known keys. A builder has no key to misspell — `.yeras(1)` does not exist, and
// your editor says so as you type it.

const FEE_AMOUNT_RE = /^\d{1,10}(\.\d{1,2})?$/;

// The RFC 8748 fee AGREEMENT: the most you consent to pay. Not a price you set — the registry
// charges its own. If the real price is HIGHER the command is refused (2004) and nothing is
// charged, which is the point: a tariff change or a premium name cannot bill you more than agreed.
function feeAgreement(amount, currency) {
  const value = String(amount).trim();
  if (!FEE_AMOUNT_RE.test(value)) {
    // Checked here rather than on the wire: a malformed agreement draws a bare 2001 that names no
    // field, and it arrives after the command has been attempted.
    throw new ValidationError(`a fee amount must be a plain decimal like '100.00' (got '${value}')`);
  }
  return currency == null ? value : { amount: value, currency };
}

function dsRecordOf(keyTag, alg, digestType, digest) {
  const value = String(digest || '').trim();
  if (!value) throw new ValidationError('a DS record needs a digest');
  return { keyTag, alg, digestType, digest: value };
}

function keyRecordOf(flags, protocol, alg, pubKey) {
  const value = String(pubKey || '').trim();
  if (!value) throw new ValidationError('a key record needs a public key');
  return { flags, protocol, alg, pubKey: value };
}

function postalInfoOf(type, { name, city, countryCode, street = [], org = null, stateProvince = null, postalCode = null }) {
  const block = { type, name, city, cc: countryCode };
  if (street.length) block.street = street.map(String);
  if (org !== null) block.org = org;
  if (stateProvince !== null) block.sp = stateProvince;
  if (postalCode !== null) block.pc = postalCode;
  return block;
}

// Turns publish()/withhold() arguments into the disclose option.
function disclosureOf(publish, fields) {
  const spec = { flag: publish };
  for (const field of fields) {
    switch (String(field).trim()) {
      // name/org/addr exist once per postal form, so the choice is per form. Both are named:
      // withholding only the ASCII form while the local one stays public is a privacy setting that
      // reads as applied and is not.
      case 'name': case 'org': case 'addr':
        spec[String(field).trim()] = ['int', 'loc'];
        break;
      case 'voice': case 'fax': case 'email':
        spec[String(field).trim()] = true;
        break;
      default:
        throw new ValidationError(
          `'${field}' is not a disclosable field. Use: name, org, addr, voice, fax, email.`,
        );
    }
  }
  return spec;
}

function appendAll(target, key, values) {
  const existing = target[key] || [];
  for (const value of values) {
    const v = String(value).trim();
    if (v) existing.push(v);
  }
  target[key] = existing;
  return target;
}

function appendContacts(target, role, handles) {
  const r = String(role).trim();
  if (!r) throw new ValidationError('a contact role must not be empty (admin, tech, billing, …)');
  return appendAll(target, r, handles);
}

class Builder {
  constructor(handler, id) {
    this._handler = handler;
    this._id = id;
    this._options = {};
    this._sent = false;
  }

  // The options as the equivalent object call would take them. Useful for a dry run, for logging
  // what you are about to do, or for handing the command to a queue. Sends nothing, spends nothing.
  toOptions() {
    // A COPY, and a deep one. The result is a value you can keep, log or queue — handing back the
    // live object would make it change under the caller every time another step is added, so what
    // was logged and what was sent could differ.
    return JSON.parse(JSON.stringify(this._options));
  }

  // A builder is a command that has not happened yet, so sending it twice would be two
  // registrations and two charges — and the second is never what the caller meant.
  _markSent() {
    if (this._sent) {
      throw new ValidationError(
        `${this.constructor.name} has already been sent. A builder carries one command; `
        + 'build another rather than re-sending this one.',
      );
    }
    this._sent = true;
  }
}

class DomainCreateBuilder extends Builder {
  /** Registration period in years. Omit it and the registry applies its own default. */
  years(years) { this._options.years = years; return this; }

  /** The registrant — the holder of the domain. Required by the registry. */
  registrant(handle) { this._options.registrant = handle; return this; }

  // Attach contacts in a role. Every list method ACCUMULATES: pass several at once, or call it
  // again, or both — the effect is the same. RFC 5731 puts no limit on handles per role.
  contact(role, ...handles) {
    this._options.contacts = appendContacts(this._options.contacts || {}, role, handles);
    return this;
  }

  /** The people authorised to make decisions about the domain. Accumulates. */
  adminContact(...handles) { return this.contact('admin', ...handles); }

  /** The people to reach about DNS and delegation. Accumulates. */
  techContact(...handles) { return this.contact('tech', ...handles); }

  /** The people to reach about invoices for this domain. Accumulates. */
  billingContact(...handles) { return this.contact('billing', ...handles); }

  /** One nameserver to delegate to. Accumulates; suits a loop or a conditional. */
  nameserver(host) { return this.nameservers(host); }

  /** The nameservers to delegate to. Accumulates. */
  nameservers(...hosts) { appendAll(this._options, 'nameservers', hosts); return this; }

  /**
   * A nameserver given with its glue addresses, inlined in the command (RFC 5731 hostAttr).
   *
   * Use this where the registry expects the addresses with the name rather than a reference to a
   * host object created beforehand; ask yours which model it takes. A command cannot mix the two,
   * so use either this or nameserver(), not both.
   */
  nameserverWithGlue(host, ...addresses) {
    const name = String(host).trim();
    if (!name) throw new ValidationError('a nameserver name must not be empty');
    // Pushed as an object rather than through appendAll(), which is for plain names and would
    // stringify this one into a hostObj reading "[object Object]".
    const existing = this._options.nameservers || [];
    existing.push({ name, addresses: addresses.map(String) });
    this._options.nameservers = existing;
    return this;
  }

  // The transfer secret. Anyone holding it can move the domain to another registrar, so treat it
  // as a credential: never log it, and roll it after handing it to a customer.
  authInfo(password) { this._options.authInfo = password; return this; }

  /** A trademark or licence number, for registries that require one to register a name. */
  license(number) { this._options.license = number; return this; }

  // The most you agree to pay for this registration (RFC 8748). Optional: without it the registry's
  // own price is charged; with it, a higher real price refuses the command instead of billing you.
  maxFee(amount, currency = null) { this._options.fee = feeAgreement(amount, currency); return this; }

  /** Sign the domain with a DS record (RFC 5910). Call it again for a second key. */
  dsRecord(keyTag, alg, digestType, digest) {
    const sec = this._options.secDNS || {};
    sec.dsData = (sec.dsData || []).concat([dsRecordOf(keyTag, alg, digestType, digest)]);
    this._options.secDNS = sec;
    return this;
  }

  // A DS record that carries the DNSKEY it was computed from (RFC 5910). A registry that accepts
  // this can verify the digest against the key for you, catching a mistyped digest before it
  // reaches the zone. One that does not accept DNSKEY data refuses the command rather than
  // ignoring the extra element, so trying costs you nothing but a 2306.
  dsRecordWithKey(keyTag, alg, digestType, digest, flags, protocol, keyAlg, pubKey) {
    const sec = this._options.secDNS || {};
    const record = dsRecordOf(keyTag, alg, digestType, digest);
    record.keyData = keyRecordOf(flags, protocol, keyAlg, pubKey);
    sec.dsData = (sec.dsData || []).concat([record]);
    this._options.secDNS = sec;
    return this;
  }

  /** Sign with a public key instead, where the registry accepts one. */
  keyRecord(flags, protocol, alg, pubKey) {
    const sec = this._options.secDNS || {};
    sec.keyData = (sec.keyData || []).concat([keyRecordOf(flags, protocol, alg, pubKey)]);
    this._options.secDNS = sec;
    return this;
  }

  /** Maximum signature lifetime in seconds. Only meaningful alongside a DS or key record. */
  maxSigLife(seconds) {
    const sec = this._options.secDNS || {};
    sec.maxSigLife = seconds;
    this._options.secDNS = sec;
    return this;
  }

  send() { this._markSent(); return this._handler.create(this._id, this._options); }
}

class DomainUpdateBuilder extends Builder {
  _block(name) { return (this._options[name] = this._options[name] || {}); }

  /** Delegate to one more nameserver. Accumulates. */
  addNameserver(host) { return this.addNameservers(host); }

  /** Delegate to these nameservers as well as the ones already there. Accumulates. */
  addNameservers(...hosts) { appendAll(this._block('add'), 'ns', hosts); return this; }

  /** Stop delegating to one nameserver. Accumulates. */
  remNameserver(host) { return this.remNameservers(host); }

  /** Stop delegating to these nameservers. Accumulates. */
  remNameservers(...hosts) { appendAll(this._block('rem'), 'ns', hosts); return this; }

  /** Attach contacts in a role, keeping the ones already there. */
  addContact(role, ...handles) {
    const block = this._block('add');
    block.contacts = appendContacts(block.contacts || {}, role, handles);
    return this;
  }

  /** Detach contacts from a role. */
  remContact(role, ...handles) {
    const block = this._block('rem');
    block.contacts = appendContacts(block.contacts || {}, role, handles);
    return this;
  }

  // Set a client-side status, e.g. `clientHold` (takes the domain out of DNS). Server-set statuses
  // cannot be changed from here.
  addStatus(...statuses) { appendAll(this._block('add'), 'statuses', statuses); return this; }

  /** Clear a client-side status. */
  remStatus(...statuses) { appendAll(this._block('rem'), 'statuses', statuses); return this; }

  // Hand the domain to a different holder. Many registries treat this as a change of ownership with
  // its own rules, so a refusal is usually policy rather than a malformed command.
  changeRegistrant(handle) { this._block('chg').registrant = handle; return this; }

  /** Replace the transfer secret. */
  changeAuthInfo(password) { this._block('chg').authInfo = password; return this; }

  // REMOVE the transfer secret entirely, so no code will move this domain.
  //
  // This is the answer to a leak, and it is not the same as setting an empty one: an empty password
  // is a value the holder can still present, so the domain stays exactly as movable as it was. Only
  // this clears it. Set a fresh one with changeAuthInfo() when the customer needs it again.
  clearAuthInfo() { this._block('chg').clearAuthInfo = true; return this; }

  /** Ask to bring a deleted domain back from the redemption period (RFC 3915). */
  restore() { this._options.restore = true; return this; }

  /** A trademark or licence number, for registries that require one. */
  license(number) { this._options.license = number; return this; }

  /** The most you agree to pay, when the change is a billable one (RFC 8748). */
  maxFee(amount, currency = null) { this._options.fee = feeAgreement(amount, currency); return this; }

  /** Add a DS record to an existing domain. */
  addDsRecord(keyTag, alg, digestType, digest) {
    return this._secDns('add', 'dsData', dsRecordOf(keyTag, alg, digestType, digest));
  }

  /** Remove one specific DS record. Everything must match what the registry holds. */
  remDsRecord(keyTag, alg, digestType, digest) {
    return this._secDns('rem', 'dsData', dsRecordOf(keyTag, alg, digestType, digest));
  }

  /** Add a public key to an existing domain. */
  addKeyRecord(flags, protocol, alg, pubKey) {
    return this._secDns('add', 'keyData', keyRecordOf(flags, protocol, alg, pubKey));
  }

  /** Remove one specific public key. */
  remKeyRecord(flags, protocol, alg, pubKey) {
    return this._secDns('rem', 'keyData', keyRecordOf(flags, protocol, alg, pubKey));
  }

  // Unsign the domain entirely. Mutually exclusive with removing specific records — the protocol
  // has no way to express both, and a frame carrying both is refused. Refused here instead, where
  // the message can say so.
  removeAllDnssec() {
    const sec = this._options.secDNS || {};
    if (sec.rem) {
      throw new ValidationError(
        'removeAllDnssec() cannot be combined with remDsRecord()/remKeyRecord() — '
        + 'remove everything, or name what to remove, not both',
      );
    }
    sec.remAll = true;
    this._options.secDNS = sec;
    return this;
  }

  /** Maximum signature lifetime in seconds. */
  maxSigLife(seconds) {
    const sec = this._options.secDNS || {};
    sec.maxSigLife = seconds;
    this._options.secDNS = sec;
    return this;
  }

  send() { this._markSent(); return this._handler.update(this._id, this._options); }

  _secDns(block, kind, record) {
    const sec = this._options.secDNS || {};
    if (block === 'rem' && sec.remAll) {
      throw new ValidationError(
        'remDsRecord()/remKeyRecord() cannot be combined with removeAllDnssec() — '
        + 'remove everything, or name what to remove, not both',
      );
    }
    const spec = sec[block] || {};
    spec[kind] = (spec[kind] || []).concat([record]);
    sec[block] = spec;
    this._options.secDNS = sec;
    return this;
  }
}

class ContactCreateBuilder extends Builder {
  constructor(handler, id, email) {
    super(handler, id);
    this._options.email = email;
  }

  // The address in ASCII, which every registry accepts. At least one form is required; give this
  // one unless you have a reason not to — it survives being printed, e-mailed and read by a system
  // that knows no Cyrillic.
  internationalAddress(parts) { return this._address('int', parts); }

  // The address in the local script — Cyrillic for a Ukrainian registrant. Optional and additional:
  // a contact may carry this form as well as the international one.
  localizedAddress(parts) { return this._address('loc', parts); }

  /** Voice number in the EPP form: `+CC.NNNNNNNNN`. */
  voice(number) { this._options.voice = number; return this; }

  /** Fax number, same form as voice(). */
  fax(number) { this._options.fax = number; return this; }

  /** The transfer secret for this contact. */
  authInfo(password) { this._options.authInfo = password; return this; }

  // Consent to publish these fields: name, org, addr, voice, fax, email. Anything not listed takes
  // the opposite treatment, so publish() and withhold() say the same thing two ways — pick one.
  publish(...fields) { this._options.disclose = disclosureOf(true, fields); return this; }

  /** Withhold these fields from publication. See publish() for the field names. */
  withhold(...fields) { this._options.disclose = disclosureOf(false, fields); return this; }

  send() { this._markSent(); return this._handler.create(this._id, this._options); }

  _address(type, parts) {
    this._options.postalInfos = (this._options.postalInfos || []).concat([postalInfoOf(type, parts)]);
    return this;
  }
}

class ContactUpdateBuilder extends Builder {
  // Change the ASCII address. THE BLOCK YOU PASS REPLACES THE ONE THE REGISTRY HOLDS — it is not
  // merged field by field, so anything you leave out is deleted:
  //
  //   give a value          the field is set to it
  //   give an empty string  the field is CLEARED — the way to remove org, stateProvince or postalCode
  //   leave a key out       the field is not sent, and the registry DELETES what it held
  //
  // RFC 5733 can be read as "leave it out and the registry keeps its value", since every child of
  // chgPostalInfoType is optional, but that reading is not safe: against a registry that replaces,
  // a block sent without its org comes back 1000 with the org gone, and a block carrying only an org
  // leaves the contact with no postal address at all. name, city and countryCode are required here
  // for that reason — but they only keep the frame valid, they cannot restore a field you did not
  // send. Read the current block with contact.info() and pass it back with your change applied.
  //
  // The other form (local or international) IS untouched — the two are addressed separately.
  changeInternationalAddress(parts) { return this._address('int', parts); }

  /** Change the local-script address. Same rules as changeInternationalAddress(). */
  changeLocalizedAddress(parts) { return this._address('loc', parts); }

  changeVoice(number) { return this._chg('voice', number); }

  changeFax(number) { return this._chg('fax', number); }

  changeEmail(email) { return this._chg('email', email); }

  /** Replace the transfer secret. */
  changeAuthInfo(password) { return this._chg('authInfo', password); }

  // There is deliberately no clearAuthInfo() here. RFC 5731 gives a domain a nullable form,
  // <domain:authInfo><domain:null/>, and RFC 5733 defines no equivalent for a contact — so a
  // contact's transfer secret can be REPLACED but not removed. Do not reach for an empty password
  // as a substitute: an empty value is still a value the holder can present.
  /** Consent to publish these fields: name, org, addr, voice, fax, email. */
  publish(...fields) { return this._chg('disclose', disclosureOf(true, fields)); }

  /** Withhold these fields from publication. */
  withhold(...fields) { return this._chg('disclose', disclosureOf(false, fields)); }

  /** Set a client-side status, e.g. `clientUpdateProhibited`. */
  addStatus(...statuses) { appendAll(this._options, 'addStatuses', statuses); return this; }

  /** Clear a client-side status. */
  remStatus(...statuses) { appendAll(this._options, 'remStatuses', statuses); return this; }

  send() { this._markSent(); return this._handler.update(this._id, this._options); }

  _chg(key, value) {
    const chg = this._options.chg || {};
    chg[key] = value;
    this._options.chg = chg;
    return this;
  }

  _address(type, parts) {
    // Only the keys actually given survive. The emitter reads presence, so an absent key is not
    // sent and a key holding '' is sent empty, which is what clears a field.
    const block = { type };
    const map = { name: 'name', org: 'org', city: 'city', stateProvince: 'sp', postalCode: 'pc', countryCode: 'cc' };
    for (const [from, to] of Object.entries(map)) {
      if (parts[from] !== undefined && parts[from] !== null) block[to] = parts[from];
    }
    if (parts.street !== undefined && parts.street !== null) block.street = parts.street.map(String);
    const chg = this._options.chg || {};
    chg.postalInfos = (chg.postalInfos || []).concat([block]);
    this._options.chg = chg;
    return this;
  }
}

class HostUpdateBuilder extends Builder {
  /** Add one glue address. Accumulates. */
  addAddress(ip) { return this.addAddresses(ip); }

  /** Add glue addresses. IPv4 and IPv6 are told apart automatically. Accumulates. */
  addAddresses(...ips) { appendAll(this._options, 'addAddresses', ips); return this; }

  /** Remove one glue address. Accumulates. */
  remAddress(ip) { return this.remAddresses(ip); }

  /** Remove glue addresses. Accumulates. */
  remAddresses(...ips) { appendAll(this._options, 'remAddresses', ips); return this; }

  /** Set a client-side status. */
  addStatus(...statuses) { appendAll(this._options, 'addStatuses', statuses); return this; }

  /** Clear a client-side status. */
  remStatus(...statuses) { appendAll(this._options, 'remStatuses', statuses); return this; }

  send() { this._markSent(); return this._handler.update(this._id, this._options); }
}

module.exports = {
  DomainCreateBuilder,
  DomainUpdateBuilder,
  ContactCreateBuilder,
  ContactUpdateBuilder,
  HostUpdateBuilder,
};
