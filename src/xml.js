'use strict';

const { ConnectionError } = require('./errors');

// Minimal, dependency-free XML helpers for EPP.
//
// escapeText / escapeAttr produce correctly-escaped node/attribute values (never
// string-concatenated raw). parseXml turns a well-formed EPP response into a small element
// tree {name, prefix, local, ns, attrs, children, text} — enough to read result codes, resData
// and extensions by local name or by namespace. It handles the XML prolog, comments, CDATA,
// self-closing tags, quoted attributes and character/entity references, and rejects input that
// is not well-formed instead of returning a partial tree.

function escapeText(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    // A literal CR is folded into LF by every conforming parser, so an authInfo ending in one
    // would reach the registry as a DIFFERENT secret and come back as an unexplained 2202.
    .replace(/\r/g, '&#13;');
}

function escapeAttr(value) {
  return escapeText(value)
    .replace(/"/g, '&quot;')
    // Attribute-value normalization replaces TAB/LF (and the CR escaped above) with a space.
    .replace(/\n/g, '&#10;')
    .replace(/\t/g, '&#9;');
}

const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const MAX_CODE_POINT = 0x10ffff;

function decodeEntities(s) {
  if (s.indexOf('&') === -1) return s;
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, ref) => {
    if (ref[0] === '#') {
      const code = (ref[1] === 'x' || ref[1] === 'X')
        ? parseInt(ref.slice(2), 16)
        : parseInt(ref.slice(1), 10);
      // Out of the Unicode range String.fromCodePoint throws a raw RangeError, which would
      // escape the documented "every SDK failure is an EppError" contract; leave it as text.
      if (Number.isNaN(code) || code < 0 || code > MAX_CODE_POINT) return match;
      return String.fromCodePoint(code);
    }
    return Object.prototype.hasOwnProperty.call(NAMED, ref) ? NAMED[ref] : match;
  });
}

function makeNode(name) {
  const idx = name.indexOf(':');
  return {
    name,
    prefix: idx >= 0 ? name.slice(0, idx) : '',
    local: idx >= 0 ? name.slice(idx + 1) : name,
    ns: '',
    attrs: {},
    children: [],
    text: '',
  };
}

const ATTR_RE = /([^\s=]+)\s*=\s*("([^"]*)"|'([^']*)')/g;

function parseTag(content) {
  content = content.trim();
  let k = 0;
  while (k < content.length && !/\s/.test(content[k])) k++;
  const node = makeNode(content.slice(0, k));
  const attrStr = content.slice(k);
  let m;
  ATTR_RE.lastIndex = 0;
  while ((m = ATTR_RE.exec(attrStr)) !== null) {
    const val = m[3] !== undefined ? m[3] : m[4];
    node.attrs[m[1]] = decodeEntities(val);
  }
  return node;
}

const EMPTY_SCOPE = Object.freeze({});

function malformed(detail) {
  // A transport-level error: the caller's contract is that anything unusable on the wire
  // surfaces as a ConnectionError, never as a half-parsed frame that reads like a success.
  return new ConnectionError(`Server returned malformed XML: ${detail}`);
}

// Index just past `token`. An unterminated construct is fatal: indexOf yields -1 for a missing
// terminator, and `-1 + n` would move the cursor BACK behind the same '<', re-parsing the same
// prefix forever on input like '<epp><!-- oops'.
function endOf(xml, from, token, label) {
  const at = xml.indexOf(token, from);
  if (at === -1) throw malformed(`unterminated ${label}`);
  return at + token.length;
}

// The xmlns bindings a child inherits: the parent's, plus this element's own declarations.
// Elements carry the resolved URI so extension blocks can be told apart by NAMESPACE (the fee
// riders share their local names with the object mappings).
function scopeFor(node, parentScope) {
  let scope = parentScope;
  for (const key of Object.keys(node.attrs)) {
    if (key !== 'xmlns' && key.indexOf('xmlns:') !== 0) continue;
    if (scope === parentScope) scope = Object.assign({}, parentScope);
    scope[key === 'xmlns' ? '' : key.slice(6)] = node.attrs[key];
  }
  return scope;
}

function parseXml(xml) {
  const len = xml.length;
  const stack = [];
  const scopes = []; // xmlns bindings in force, parallel to `stack`
  let root = null;
  let i = 0;

  while (i < len) {
    const lt = xml.indexOf('<', i);
    if (lt === -1) break;
    if (lt > i && stack.length) {
      stack[stack.length - 1].text += decodeEntities(xml.slice(i, lt));
    }

    if (xml.startsWith('<?', lt)) { i = endOf(xml, lt, '?>', 'processing instruction'); continue; }
    if (xml.startsWith('<!--', lt)) { i = endOf(xml, lt, '-->', 'comment'); continue; }
    if (xml.startsWith('<![CDATA[', lt)) {
      const end = endOf(xml, lt, ']]>', 'CDATA section');
      if (stack.length) stack[stack.length - 1].text += xml.slice(lt + 9, end - 3);
      i = end;
      continue;
    }
    if (xml.startsWith('<!', lt)) { i = endOf(xml, lt, '>', 'declaration'); continue; }

    // Find the tag's closing '>' while respecting quoted attribute values.
    let j = lt + 1;
    let quote = null;
    while (j < len) {
      const c = xml[j];
      if (quote) {
        if (c === quote) quote = null;
      } else if (c === '"' || c === "'") {
        quote = c;
      } else if (c === '>') {
        break;
      }
      j++;
    }
    if (j >= len) throw malformed('unterminated tag');

    if (xml[lt + 1] === '/') {
      // The close tag must name the element it closes. Without that check a TRUNCATED response
      // ('…<result code="1000"><msg>ok') would parse as a complete one, and a half-delivered
      // domain:create would read back as a finished, billable registration.
      const name = xml.slice(lt + 2, j).trim();
      const open = stack.pop();
      scopes.pop();
      if (open === undefined || open.name !== name) throw malformed(`unexpected </${name}>`);
      i = j + 1;
      continue;
    }

    let content = xml.slice(lt + 1, j);
    let selfClose = false;
    if (content.endsWith('/')) {
      selfClose = true;
      content = content.slice(0, -1);
    }
    const node = parseTag(content);
    const scope = scopeFor(node, scopes.length ? scopes[scopes.length - 1] : EMPTY_SCOPE);
    node.ns = scope[node.prefix] || '';
    if (stack.length) {
      stack[stack.length - 1].children.push(node);
    } else if (root !== null) {
      // An EPP frame has exactly one root element. Two roots means two frames arrived in a single
      // read; rejecting the buffer keeps the reply to the next command from being returned here.
      throw malformed('more than one root element');
    } else {
      root = node;
    }
    if (!selfClose) {
      stack.push(node);
      scopes.push(scope);
    }
    i = j + 1;
  }

  if (stack.length) throw malformed(`unclosed <${stack[stack.length - 1].name}>`);

  return root;
}

module.exports = { escapeText, escapeAttr, decodeEntities, parseXml };
