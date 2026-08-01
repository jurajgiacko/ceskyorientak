#!/usr/bin/env node
/**
 * Locale completeness gate.
 *
 * Czech is the source of truth. A key present in cs.json but missing from
 * en.json or sk.json falls back to Czech at runtime — which is safe, but it
 * means an untranslated string can ship silently. This makes it loud.
 *
 * Also catches the reverse (orphan keys that exist only in a translation), and
 * placeholder mismatches, which are a real source of broken UI: if cs has
 * "{name}" and en does not, the English string will render a stale value.
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const I18N = resolve(__dirname, '../../src/i18n');
const LOCALES = ['cs', 'en', 'sk'];
const BASE = 'cs';

const dicts = Object.fromEntries(
  LOCALES.map((l) => [l, JSON.parse(readFileSync(resolve(I18N, `${l}.json`), 'utf8'))]),
);

const baseKeys = Object.keys(dicts[BASE]);
const placeholders = (s) => (s.match(/\{(\w+)\}/g) ?? []).sort().join(',');

let failed = false;

for (const l of LOCALES) {
  if (l === BASE) continue;
  const keys = Object.keys(dicts[l]);

  const missing = baseKeys.filter((k) => !(k in dicts[l]));
  const orphan = keys.filter((k) => !(k in dicts[BASE]));
  const mismatched = baseKeys
    .filter((k) => k in dicts[l])
    .filter((k) => placeholders(dicts[BASE][k]) !== placeholders(dicts[l][k]));

  if (missing.length) {
    console.error(`✗ ${l}: ${missing.length} missing key(s):\n   ${missing.join('\n   ')}`);
    failed = true;
  }
  if (orphan.length) {
    console.error(`✗ ${l}: ${orphan.length} key(s) not in ${BASE}:\n   ${orphan.join('\n   ')}`);
    failed = true;
  }
  if (mismatched.length) {
    console.error(
      `✗ ${l}: placeholder mismatch:\n   ${mismatched
        .map((k) => `${k}  ${BASE}="${placeholders(dicts[BASE][k])}" ${l}="${placeholders(dicts[l][k])}"`)
        .join('\n   ')}`,
    );
    failed = true;
  }
  if (!missing.length && !orphan.length && !mismatched.length) {
    console.log(`✓ ${l}: ${keys.length} keys, complete`);
  }
}

const empty = [];
for (const l of LOCALES) {
  for (const [k, v] of Object.entries(dicts[l])) {
    if (typeof v !== 'string' || v.trim() === '') empty.push(`${l}:${k}`);
  }
}
if (empty.length) {
  console.error(`✗ empty value(s): ${empty.join(', ')}`);
  failed = true;
}

console.log(failed ? '\n✗ LOCALE CHECK FAILED' : `\n✓ locales complete (${baseKeys.length} keys × ${LOCALES.length})`);
process.exit(failed ? 1 : 0);
