#!/usr/bin/env node
/**
 * Repository hygiene gate.
 *
 * Exists because of a real incident: a texture-encoding step shelled out to
 * `basisu -unpack`, which ignores its `-output_path` flag and writes one PNG
 * per transcode target per mip level into the *current working directory*.
 * That produced 209 files in the repo root, and a blanket `git add -A` from a
 * concurrent commit swept 28.7 MB of them into history.
 *
 * The root cause is fixed at both ends (the encoder now runs with `cwd` inside
 * its cache dir, and .gitignore carries a pattern guard), but "be careful with
 * git add" is not a control. This is.
 *
 * Fails the build if generated or junk files are tracked, or if a single
 * tracked file is implausibly large.
 */

import { execSync } from 'node:child_process';
import { statSync } from 'node:fs';

/** Patterns that should never be tracked, with why. */
const FORBIDDEN = [
  [/_unpacked_.*\.png$/, 'basisu -unpack scratch output'],
  [/^tools\/.*\/\.cache\//, 'generation cache'],
  [/^tools\/audio\/renders\//, 'audio verification renders'],
  [/^tools\/audio\/\.build\//, 'audio build intermediate'],
  [/^research\/raw\//, 'raw research downloads'],
  [/\.(DS_Store|log|tmp|swp)$/, 'OS or editor scratch'],
  [/^dist\//, 'build output'],
  [/^node_modules\//, 'dependencies'],
  [/\.env(\.|$)/, 'environment file — may contain secrets'],
];

/**
 * Any single tracked file above this is almost certainly a mistake. Our real
 * assets top out around 11 MB (the forest heightmap), so this leaves headroom
 * without permitting a stray video or dataset.
 */
const MAX_FILE_MB = 16;

const files = execSync('git ls-files', { encoding: 'utf8' }).split('\n').filter(Boolean);

let failed = false;
const offenders = [];

for (const f of files) {
  for (const [pattern, why] of FORBIDDEN) {
    if (pattern.test(f)) {
      offenders.push(`${f}  — ${why}`);
      failed = true;
      break;
    }
  }
}

if (offenders.length) {
  console.error(`✗ ${offenders.length} file(s) that should not be tracked:`);
  // Cap the output: 209 lines of the same mistake helps nobody.
  for (const o of offenders.slice(0, 15)) console.error(`   ${o}`);
  if (offenders.length > 15) console.error(`   … and ${offenders.length - 15} more`);
  console.error('\n  Fix: add the pattern to .gitignore, then `git rm --cached` the files.');
} else {
  console.log(`✓ no junk tracked (${files.length} files)`);
}

const oversized = [];
for (const f of files) {
  try {
    const mb = statSync(f).size / 1048576;
    if (mb > MAX_FILE_MB) oversized.push(`${mb.toFixed(1)} MB  ${f}`);
  } catch {
    /* deleted in the working tree but still in the index — not our concern here */
  }
}

if (oversized.length) {
  console.error(`\n✗ file(s) over ${MAX_FILE_MB} MB:`);
  for (const o of oversized) console.error(`   ${o}`);
  console.error('\n  Large generated assets belong in the build, not the tree.');
  failed = true;
} else {
  console.log(`✓ no tracked file over ${MAX_FILE_MB} MB`);
}

process.exit(failed ? 1 : 0);
