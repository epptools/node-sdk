#!/usr/bin/env node
'use strict';

// Every public method and every exported class must be declared in index.d.ts, and every
// declaration must correspond to something real.
//
// package.json points `types` at index.d.ts and the README says the package ships TypeScript types,
// so a member that exists at runtime but is missing from the declaration is a compile error in the
// user's project for code copied straight out of our own README — and a declaration for something
// that no longer exists is worse, because it type-checks and then throws at runtime.
//
// This drifts silently by nature: adding a method requires no change here, and every test still
// passes. Run: node bin/check-types-parity.js

const fs = require('fs');
const path = require('path');

const pkg = require('..');
const { Response } = require('../src/response');
const { Domain, Contact, Host, Poll } = require('../src/commands');
const builders = require('../src/builders');

const declPath = path.join(__dirname, '..', 'index.d.ts');
const source = fs.readFileSync(declPath, 'utf8');

const failures = [];

/** The member names declared inside `export class <name> { ... }`. */
function declaredMembers(className) {
  // \b after the name, so looking for `Domain` does not match `DomainCreateBuilder`.
  const block = new RegExp(`export class ${className}\\b[^{]*\\{([\\s\\S]*?)\\n\\}`).exec(source);
  if (block === null) return null;
  const names = new Set();
  for (const m of block[1].matchAll(/^\s*(?:static\s+)?([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\(/gm)) {
    names.add(m[1]);
  }
  return names;
}

/** The public method names a class really has, its prototype chain included. */
function realMembers(Cls) {
  const names = new Set();
  for (let proto = Cls.prototype; proto && proto !== Object.prototype; proto = Object.getPrototypeOf(proto)) {
    for (const name of Object.getOwnPropertyNames(proto)) {
      if (name.startsWith('_') || name === 'constructor') continue;
      if (typeof Object.getOwnPropertyDescriptor(proto, name).value === 'function') names.add(name);
    }
  }
  for (const name of Object.getOwnPropertyNames(Cls)) {
    if (['prototype', 'length', 'name'].includes(name)) continue;
    if (typeof Cls[name] === 'function') names.add(name);
  }
  return names;
}

const classes = {
  Response,
  Domain,
  Contact,
  Host,
  Poll,
  DomainCreateBuilder: builders.DomainCreateBuilder,
  DomainUpdateBuilder: builders.DomainUpdateBuilder,
  ContactCreateBuilder: builders.ContactCreateBuilder,
  ContactUpdateBuilder: builders.ContactUpdateBuilder,
  HostUpdateBuilder: builders.HostUpdateBuilder,
};

let checked = 0;
for (const [name, Cls] of Object.entries(classes)) {
  const declared = declaredMembers(name);
  if (declared === null) {
    failures.push(`index.d.ts declares no \`export class ${name}\` at all`);
    continue;
  }
  const real = realMembers(Cls);
  checked += real.size;
  for (const member of [...real].sort()) {
    if (!declared.has(member)) failures.push(`${name}.${member}() exists but is not declared in index.d.ts`);
  }
  for (const member of [...declared].sort()) {
    if (!real.has(member)) failures.push(`index.d.ts declares ${name}.${member}(), which no longer exists`);
  }
}

// Everything the package exports must be reachable from TypeScript too. An error class you cannot
// name is an error class you cannot catch by type.
for (const name of Object.keys(pkg)) {
  if (!new RegExp(`export (class|interface|type|const|function) ${name}\\b`).test(source)) {
    failures.push(`index.js exports ${name}, which index.d.ts does not declare`);
  }
}

// ...and the other direction, which is the one that bites. `export class X` in a .d.ts is a VALUE
// export: `import { X }` type-checks, then hands the caller `undefined`, and `instanceof X` throws
// at runtime. A type-only test cannot catch it either, because TypeScript erases a type annotation.
for (const [, name] of source.matchAll(/^export class (\w+)/gm)) {
  if (!(name in pkg)) {
    failures.push(`index.d.ts exports class ${name}, which index.js does not export`);
  }
}

// A guard that cannot fire reads as coverage. If the parsing ever stops matching, fail loudly.
if (checked < 100) {
  failures.push(`only ${checked} members were found across ${Object.keys(classes).length} classes — the check is blind, not passing`);
}

if (failures.length) {
  console.error('TypeScript declarations are out of step with the code:');
  for (const line of failures) console.error(`  - ${line}`);
  process.exit(1);
}

console.log(`types parity ok: ${checked} members across ${Object.keys(classes).length} classes, and every export is declared`);
