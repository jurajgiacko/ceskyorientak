#!/usr/bin/env node
/**
 * What the ENERGIE plate actually does over a whole race, per format.
 *
 * This exists because "the bar reads RUNNING STRONG for the whole sprint" is a
 * complaint that can only be answered with numbers, and because the depletion
 * constants in `src/sim/athlete.ts` are the kind of thing that drifts silently.
 * It integrates the real `depleteStats()` over each format's duration on a
 * representative terrain and climb profile, and prints the trajectory.
 *
 * It is a **measurement**, not a gate. It asserts nothing and fails nothing;
 * `check:race` owns the winning times. Read the table and decide whether the
 * model says what you meant it to say.
 *
 * Why not drive the full `Race` loop: the naive pilot in `race-check.mjs`
 * cannot escape a concave obstacle and spends most of a long course pinned
 * against one, which measures the pilot and not the physiology. Integrating the
 * depletion function directly over a stated effort profile is both honest about
 * what is being asserted and reproducible.
 *
 * Usage: node tools/sim/energy-check.mjs
 */

import { writeFileSync } from 'node:fs';
const { build } = await import('vite');

const ROOT = new URL('../..', import.meta.url).pathname;

async function load(entry) {
  const out = await build({
    configFile: false,
    logLevel: 'error',
    resolve: { alias: { '@': ROOT + 'src' } },
    build: { write: false, lib: { entry: ROOT + entry, formats: ['es'], fileName: 'm' } },
  });
  const p = `/tmp/ec_${Math.abs(entry.split('').reduce((a, c) => (a * 31 + c.charCodeAt(0)) | 0, 7))}.mjs`;
  writeFileSync(p, out[0].output[0].code);
  return import(p);
}

const A = await load('src/sim/athlete.ts');

/** Runnability enum values, mirrored from src/core/types.ts. */
const R = {
  Road: 0,
  Path: 1,
  OpenFast: 2,
  OpenRough: 3,
  ForestOpen: 4,
  Green1: 5,
  Green2: 6,
  Green3: 7,
  Marsh: 8,
  Rock: 9,
};

/**
 * Terrain mixes as a fraction of race time. Krumlov is a paved old town;
 * Martínkov is the Šumava forest the course generator actually draws on, whose
 * chosen course runs 88% of its points on runnable ground.
 */
const URBAN = [
  [R.Road, 0.62],
  [R.Path, 0.24],
  [R.OpenFast, 0.14],
];
const FOREST = [
  [R.ForestOpen, 0.44],
  [R.Path, 0.19],
  [R.OpenRough, 0.12],
  [R.Green1, 0.13],
  [R.Green2, 0.06],
  [R.Rock, 0.04],
  [R.Marsh, 0.02],
];

/**
 * The races, with the real course figures. Climb is expressed as the mean
 * absolute gradient the athlete meets — half of it uphill, half down, which is
 * how a closed course works. `climbM / lengthM` gives the one-way gradient, so
 * the mean absolute gradient over the whole course is 2 × that.
 */
const RACES = [
  { name: 'sprint', durS: 14 * 60, lengthM: 1558, climbM: 45, mix: URBAN, heat: 0.45 },
  { name: 'middle', durS: 33 * 60, lengthM: 4367, climbM: 235, mix: FOREST, heat: 0.4 },
  { name: 'long', durS: 90 * 60, lengthM: 9000, climbM: 500, mix: FOREST, heat: 0.4 },
];

/** How hard the athlete is racing, as a fraction of what the ground allows. */
const PACING = [
  { name: 'even, controlled', intensity: 0.82 },
  { name: 'race pace', intensity: 0.9 },
  { name: 'went out too hard', intensity: 0.97 },
];

function run(race, intensity) {
  const s = A.freshStats();
  const dtS = 1;
  const gradient = (race.climbM / race.lengthM) * 2;
  const samples = [];

  for (let t = 0; t < race.durS; t += dtS) {
    // Walk the terrain mix deterministically rather than randomly, so the
    // answer is the same every run and two builds can be compared.
    const phase = (t / race.durS) * race.mix.length;
    let acc = 0;
    let runnability = race.mix[0][0];
    const u = (phase % 1 === 0 ? 0.5 : phase % 1) * 0 + ((t * 0.61803398875) % 1);
    for (const [rr, frac] of race.mix) {
      acc += frac;
      if (u <= acc) {
        runnability = rr;
        break;
      }
    }
    // Alternate up and down so the course closes on itself.
    const slope = Math.sin((t / race.durS) * Math.PI * 8) > 0 ? gradient : -gradient;

    A.depleteStats(s, { intensity, runnability, slope, heat: race.heat, dtS });

    if (t % Math.round(race.durS / 6) === 0) {
      samples.push({ t, ...s });
    }
  }
  return { end: s, samples };
}

const pct = (v) => (v * 100).toFixed(0).padStart(3) + '%';

console.log('');
console.log('ENERGY MODEL — what the bar does over a full race');
console.log('='.repeat(96));

for (const race of RACES) {
  console.log('');
  console.log(
    `${race.name.toUpperCase()}  ${(race.durS / 60).toFixed(0)} min · ` +
      `${(race.lengthM / 1000).toFixed(1)} km · ${race.climbM} m climb · heat ${race.heat}`,
  );
  console.log('-'.repeat(96));
  console.log(
    '  pacing               ' +
      ['start', ...Array.from({ length: 5 }, (_, i) => `${Math.round(((i + 1) / 6) * 100)}%`), 'FINISH']
        .map((h) => h.padStart(7))
        .join('') +
      '   band',
  );

  for (const p of PACING) {
    const { end, samples } = run(race, p.intensity);
    const track = [...samples.map((x) => x.glycogen), end.glycogen];
    const band =
      end.glycogen > 0.6
        ? 'strong'
        : end.glycogen > 0.35
          ? 'steady'
          : end.glycogen > 0.15
            ? 'digging'
            : 'EMPTY';
    console.log(
      `  ${p.name.padEnd(20)} ` +
        track.map((v) => pct(v).padStart(7)).join('') +
        `   ${band}`,
    );
  }

  // Water and head, at race pace only — the pacing spread on those is small
  // and the interesting comparison is between formats.
  const { end } = run(race, 0.9);
  const deficitPct = (1 - end.hydration) * A.HYDRATION_SCALE_DEFICIT_PCT;
  console.log(
    `  at race pace →  water ${pct(end.hydration)} (${deficitPct.toFixed(1)}% body mass down)` +
      ` · head ${pct(end.focus)} · blood sugar ${pct(end.bloodSugar)}`,
  );
  console.log(
    `                  pace ceiling ${pct(A.speedFactor(end))}` +
      ` · nav quality ${pct(A.navigationQuality(end))}`,
  );
}

console.log('');
console.log('Focus above is TIME ONLY. Each control adds controlApproachPenalty():');
console.log('  planned ahead 0.004, not planned 0.019 — so a 15-control sprint spends a');
console.log('  further 0.06 (planning) to 0.29 (not planning) of head. That spread is the');
console.log('  sprint’s actual story, and it is the player’s to win or lose.');
console.log('');
