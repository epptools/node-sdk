'use strict';

const { ValidationError } = require('./errors');

// Rejects an option key this library does not understand.
//
// An options object is convenient and, without this, silent: a key that is misspelled, in the wrong
// case, or copied from somewhere that spells it differently is never read. The command still goes
// out, the registry still answers 1000, and the part you asked for is missing — `secdns` for
// `secDNS` registers the domain UNSIGNED, `nameServers` for `nameservers` registers it with no
// delegation. Nothing in the response says so, because as far as the registry is concerned you
// never asked.
//
// So an unrecognised key is refused before the frame is built, with the closest known key named.
// The trade is deliberate: a key this library does not understand costs you an exception you can
// see, rather than an omission you discover in the zone.

const normalise = (s) => String(s).toLowerCase().replace(/[_-]/g, '');
const sorted = (s) => s.split('').sort().join('');

function levenshtein(a, b) {
  const rows = [];
  for (let i = 0; i <= a.length; i += 1) rows.push([i]);
  for (let j = 1; j <= b.length; j += 1) rows[0][j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      rows[i][j] = Math.min(
        rows[i - 1][j] + 1,
        rows[i][j - 1] + 1,
        rows[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
  }
  return rows[a.length][b.length];
}

// The known key a misspelling most likely meant, or null when nothing is close enough.
// Case and separators are ignored first, so `secdns` finds `secDNS` and `auth_info` finds
// `authInfo` — the two mistakes that actually happen when a developer moves between languages.
function closest(key, known) {
  const target = normalise(key);
  for (const candidate of known) if (normalise(candidate) === target) return candidate;

  // Two letters swapped is the commonest typo of all and Levenshtein scores it 2, which the
  // distance threshold below rejects for a short key. Same letters, different order, is a
  // transposition and nothing else.
  const targetSorted = sorted(target);
  for (const candidate of known) if (sorted(normalise(candidate)) === targetSorted) return candidate;

  let best = null;
  let bestDistance = Infinity;
  for (const candidate of known) {
    const d = levenshtein(target, normalise(candidate));
    if (d < bestDistance) { bestDistance = d; best = candidate; }
  }
  // Beyond a third of the key's length the "suggestion" is noise that sends the reader looking in
  // the wrong place, which is worse than offering none.
  return bestDistance <= Math.max(1, Math.floor(target.length / 3)) ? best : null;
}

function check(given, known, context) {
  if (given === null || typeof given !== 'object') return;
  const unknown = Object.keys(given).filter((k) => !known.includes(k));
  if (!unknown.length) return;
  const details = unknown.map((k) => {
    const s = closest(k, known);
    return s === null ? `'${k}'` : `'${k}' (did you mean '${s}'?)`;
  });
  throw new ValidationError(
    `${context} does not accept ${details.join(', ')}. Accepted: ${[...known].sort().join(', ')}.`,
  );
}

module.exports = { check };
