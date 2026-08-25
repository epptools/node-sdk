'use strict';

const { EPP } = require('./namespaces');
const { escapeText, escapeAttr } = require('./xml');

// EPP command frame builder.
//
// Guarantees the RFC 5730 child order (command content, then an optional <extension>, then
// <clTRID>) and proper XML escaping. Public so you can assemble bespoke frames for anything
// the high-level client does not cover and send them via Client.request().
//
// Elements are built as a small tree and serialized with a namespace scope, so each xmlns is
// declared once where first introduced: the base epp-1.0 is the default (unprefixed)
// namespace and object namespaces carry the conventional domain: / contact: / host: prefixes.

function element(ns, name, text = null, attrs = {}) {
  return { ns, name, text, attrs, children: [] };
}

function serialize(node, scope) {
  const colon = node.name.indexOf(':');
  const prefix = colon >= 0 ? node.name.slice(0, colon) : '';

  let decl = '';
  let childScope = scope;
  if (node.ns && scope[prefix] !== node.ns) {
    childScope = Object.assign({}, scope, { [prefix]: node.ns });
    decl = prefix === '' ? ` xmlns="${node.ns}"` : ` xmlns:${prefix}="${node.ns}"`;
  }

  let attrs = '';
  for (const key of Object.keys(node.attrs)) {
    attrs += ` ${key}="${escapeAttr(node.attrs[key])}"`;
  }

  const open = `<${node.name}${decl}${attrs}`;
  const hasText = node.text !== null && node.text !== undefined;
  if (node.children.length === 0 && !hasText) {
    return `${open}/>`;
  }
  let inner = hasText ? escapeText(node.text) : '';
  for (const child of node.children) inner += serialize(child, childScope);
  return `${open}>${inner}</${node.name}>`;
}

class Frame {
  constructor() {
    this._root = element(EPP, 'epp');
    this._command = element(EPP, 'command');
    this._root.children.push(this._command);
    this._extension = null;
    this._clTRID = '';
  }

  // Start a <command> frame.
  static command(clTRID) {
    const frame = new Frame();
    frame._clTRID = clTRID;
    return frame;
  }

  // Add the command verb element (<check>, <create>, <login>, <poll>, ...).
  verb(name) {
    const el = element(EPP, name);
    this._command.children.push(el);
    return el;
  }

  // Lazily add (once) and return the <extension> element.
  extension() {
    if (this._extension === null) {
      this._extension = element(EPP, 'extension');
      this._command.children.push(this._extension);
    }
    return this._extension;
  }

  // Append an element in the base epp-1.0 namespace (no prefix).
  epp(parent, name, text = null, attrs = {}) {
    const el = element(EPP, name, text, attrs);
    parent.children.push(el);
    return el;
  }

  // Append a namespaced element (e.g. domain:name) carrying its xmlns prefix.
  ns(parent, nsUri, qname, text = null, attrs = {}) {
    const el = element(nsUri, qname, text, attrs);
    parent.children.push(el);
    return el;
  }

  toXml() {
    // clTRID is always the FINAL child of <command> (RFC 5730 ordering) — and there is exactly
    // one. toXml() is public, so a caller may serialize the same Frame twice (log it, then send
    // it); any clTRID from an earlier pass is dropped first, because a frame carrying two of them
    // is schema-invalid and draws a bare 2001.
    this._command.children = this._command.children.filter((el) => el.name !== 'clTRID');
    this.epp(this._command, 'clTRID', this._clTRID);
    return '<?xml version="1.0" encoding="UTF-8"?>' + serialize(this._root, {});
  }
}

module.exports = { Frame };
