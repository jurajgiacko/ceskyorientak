/**
 * Offline render + measurement pass for the audio system.
 *
 *   node tools/audio/render.mjs
 *
 * Builds the *real* audio graph from `src/audio/` inside an
 * `OfflineAudioContext`, renders every sound the game makes to
 * `tools/audio/renders/*.wav`, and measures each one. Nothing is mocked: the
 * same `AudioGraph`, the same buses, the same compressors, the same limiter.
 *
 * Node has no Web Audio API, so `node-web-audio-api` supplies one — a
 * devDependency for this script only. Nothing it provides reaches the bundle;
 * the shipped code imports nothing but the platform.
 *
 * Continuous systems (breath, ambience, music) are driven by pumping their
 * `update(now, dt)` at 60 Hz across the whole render window *before*
 * `startRendering()`. That works because every scheduling method in this system
 * takes an explicit `now` and writes to the `AudioParam` timeline rather than
 * relying on wall-clock — which was a design constraint precisely so that this
 * script could exist.
 */

import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { OfflineAudioContext } from 'node-web-audio-api';
import { installSetTargetShim } from './shim.mjs';
import {
  activeDuration,
  averageSpectrum,
  centroid,
  countEvents,
  cycleRate,
  decayTime,
  dominantFrequency,
  encodeWav,
  highpass,
  loopDetect,
  mono,
  spectralPeaks,
  octaveBands,
  rmsTrace,
  stats,
} from './dsp.mjs';

// node-web-audio-api 2.1.0 mis-implements setTargetAtTime; see shim.mjs.
{
  const probe = new OfflineAudioContext(1, 128, 48000);
  installSetTargetShim(Object.getPrototypeOf(probe.createGain().gain));
}

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../..');
const OUT = resolve(HERE, 'renders');
const SR = 48000;

// ---------------------------------------------------------------------------
// Bundle src/audio so Node can import the TypeScript
// ---------------------------------------------------------------------------

const bundlePath = resolve(HERE, '.build/audio.mjs');
mkdirSync(dirname(bundlePath), { recursive: true });
await build({
  entryPoints: [resolve(ROOT, 'src/audio/index.ts')],
  bundle: true,
  format: 'esm',
  target: 'es2022',
  platform: 'neutral',
  outfile: bundlePath,
  alias: { '@': resolve(ROOT, 'src') },
  logLevel: 'warning',
});
const audio = await import(pathToFileURL(bundlePath).href);
const { AudioGraph, AudioSystem } = audio;

// Also measure what this costs to ship.
const minified = await build({
  entryPoints: [resolve(ROOT, 'src/audio/index.ts')],
  bundle: true,
  format: 'esm',
  target: 'es2022',
  platform: 'neutral',
  minify: true,
  write: false,
  alias: { '@': resolve(ROOT, 'src') },
  logLevel: 'silent',
});
const minBytes = minified.outputFiles[0].contents.length;
const gzipBytes = (await import('node:zlib')).gzipSync(minified.outputFiles[0].contents).length;

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const Runnability = { Road: 0, Path: 1, OpenFast: 2, OpenRough: 3, ForestOpen: 4, Green1: 5, Green2: 6, Green3: 7, Marsh: 8, Rock: 9, Impassable: 10 };

function athlete({ glycogen = 1, hydration = 1, focus = 1, speed = 3.4 } = {}) {
  return {
    stats: { glycogen, hydration, bloodSugar: 0.7, focus },
    position: { x: 0, z: 0 },
    heading: 0,
    speed,
    timeS: 0,
    believedPosition: { x: 0, z: 0 },
    navErrorM: 0,
  };
}

/**
 * Render one case. `setup(sys, ctx)` schedules; `pump` optionally drives the
 * per-frame update loop across the window.
 */
async function render(name, seconds, setup, { pump = null, seed = 20260805 } = {}) {
  const ctx = new OfflineAudioContext(2, Math.round(seconds * SR), SR);
  const graph = new AudioGraph(ctx, ctx.destination);
  graph.buildReverbs();
  const sys = new AudioSystem(graph, { seed });
  setup(sys, ctx, graph);
  if (pump) {
    const dt = 1 / 60;
    for (let t = 0; t < seconds; t += dt) pump(sys, t, dt);
  }
  const rendered = await ctx.startRendering();
  const chans = [];
  for (let c = 0; c < rendered.numberOfChannels; c++) chans.push(rendered.getChannelData(c));
  writeFileSync(resolve(OUT, `${name}.wav`), encodeWav(chans, SR));
  return { name, chans, sampleRate: SR, seconds };
}

function measure(r, extra = {}) {
  const m = mono(r.chans);
  const spec = averageSpectrum(m, r.sampleRate);
  const base = {
    ...stats(r.chans),
    centroidHz: Math.round(centroid(spec.mag, spec.binHz)),
    bands: octaveBands(spec.mag, spec.binHz),
  };
  return { ...base, ...extra(m, spec, r) };
}

const report = { sampleRate: SR, bundle: { minBytes, gzipBytes }, cases: {} };
const log = (k, v) => {
  report.cases[k] = v;
  console.log(`\n── ${k}`);
  console.log(JSON.stringify(v, null, 2));
};

// ---------------------------------------------------------------------------
// 1. Footsteps — one file per ground type, eight strikes each
// ---------------------------------------------------------------------------

const GROUNDS = ['needles', 'leaf', 'grass', 'rock', 'marsh', 'gravel', 'cobble', 'asphalt', 'water'];
const footstepRows = [];

for (const ground of GROUNDS) {
  const r = await render(`footstep-${ground}`, 4.0, (sys) => {
    for (let i = 0; i < 8; i++) {
      sys.footsteps.trigger(0.15 + i * 0.45, {
        ground,
        speed: 3.6,
        runnability: Runnability.ForestOpen,
        glycogen: 1,
      });
    }
  });
  const m = measure(r, (mo, spec, rr) => ({
    strikeDecayMs: Math.round((decayTime(mo.slice(0, Math.round(0.42 * rr.sampleRate)), rr.sampleRate, 20) ?? 0) * 1000),
    strikeLenMs: Math.round(activeDuration(mo.slice(0, Math.round(0.42 * rr.sampleRate)), rr.sampleRate, -40) * 1000),
  }));
  footstepRows.push({ ground, ...m });
  log(`footstep/${ground}`, m);
}

// Spectral separation check.
const sorted = [...footstepRows].sort((a, b) => a.centroidHz - b.centroidHz);
const separation = sorted.map((r, i) => ({
  ground: r.ground,
  centroidHz: r.centroidHz,
  ratioToPrev: i === 0 ? null : +(r.centroidHz / sorted[i - 1].centroidHz).toFixed(3),
}));
report.footstepSeparation = separation;
console.log('\n── footstep spectral separation (ascending centroid)');
console.table(separation);

// ---------------------------------------------------------------------------
// 2. Punch
// ---------------------------------------------------------------------------

for (const kind of ['contact', 'touchfree']) {
  const r = await render(`punch-${kind}`, 0.6, (sys) => {
    sys.punch.fire(0.08, kind);
  });
  const m = measure(r, (mo, _spec, rr) => {
    // Analyse the beep alone, from 80 ms — after the plastic click.
    const from = Math.round(0.078 * rr.sampleRate);
    const seg = mo.slice(from, from + Math.round(0.25 * rr.sampleRate));
    const s = averageSpectrum(seg, rr.sampleRate, 8192, 4096, 1e-6);
    return {
      fundamentalHz: +dominantFrequency(s.mag, s.binHz, 800, 8000).toFixed(1),
      decay20dbMs: Math.round((decayTime(seg, rr.sampleRate, 20) ?? 0) * 1000),
      decay40dbMs: Math.round((decayTime(seg, rr.sampleRate, 40) ?? 0) * 1000),
      totalLenMs: Math.round(activeDuration(mo, rr.sampleRate, -50) * 1000),
    };
  });
  log(`punch/${kind}`, m);
}

// ---------------------------------------------------------------------------
// 3. Breathing — glycogen 1.0 vs 0.2, same speed
// ---------------------------------------------------------------------------

for (const [tag, glycogen, hydration] of [
  ['glycogen-100', 1.0, 1.0],
  ['glycogen-060', 0.6, 0.8],
  ['glycogen-020', 0.2, 0.55],
]) {
  const seconds = 40;
  const r = await render(
    `breath-${tag}`,
    seconds,
    (sys) => {
      sys.breathing.start(0.02);
    },
    {
      pump: (sys, t, dt) => {
        sys.breathing.update(t, dt, { glycogen, speed: 3.4, hydration });
      },
    },
  );
  const m = measure(r, (mo, _spec, rr) => {
    const rate = cycleRate(mo, rr.sampleRate, 0.6, 4.5);
    return {
      breathsPerMinute: rate.perMinute,
      cyclePeriodS: rate.periodS,
      autocorrR: rate.r,
      envelopeEventCount: countEvents(mo, rr.sampleRate, 0.3, 0.35),
      eventsPerMinute: +((countEvents(mo, rr.sampleRate, 0.3, 0.35) / rr.seconds) * 60).toFixed(1),
    };
  });
  log(`breath/${tag}`, m);
}

// ---------------------------------------------------------------------------
// 4. Ambience — 60 s forest for the loop test, 30 s each for arena and town
// ---------------------------------------------------------------------------

for (const [env, seconds] of [
  ['forest', 60],
  ['arena', 30],
  ['town', 45],
]) {
  const r = await render(
    `ambience-${env}`,
    seconds,
    (sys) => {
      sys.ambience.setEnvironment(env, 0, 0.01);
      sys.graph.setReverb(sys.ambience.reverb, 0.01, 0);
      sys.ambience.setWind(0.55, 0, 0.01);
      sys.ambience.start(0.02);
    },
    { pump: (sys, t, dt) => sys.ambience.update(t, dt) },
  );
  const m = measure(r, (mo, _spec, rr) => {
    // Lags below 1 s only measure how smooth an envelope is; a loop shows up
    // as a spike at the buffer period, so the interesting window starts there.
    const loop = loopDetect(mo, rr.sampleRate, 1.0, Math.min(30, rr.seconds / 2));
    const far = loopDetect(mo, rr.sampleRate, 2.0, Math.min(30, rr.seconds / 2));
    return {
      loopPeakCorrelation: loop.peak,
      loopPeakLagS: loop.lagS,
      loopPeakAbove2s: far.peak,
      loopPeakAbove2sLagS: far.lagS,
      topCorrelations: loop.top,
    };
  });
  log(`ambience/${env}`, m);
}

// A control: the same detector on a deliberately looped 2.5 s noise buffer, so
// the "no loop" number above means something.
{
  const ctx = new OfflineAudioContext(2, 60 * SR, SR);
  const graph = new AudioGraph(ctx, ctx.destination);
  const sys = new AudioSystem(graph, { seed: 1 });
  const src = ctx.createBufferSource();
  src.buffer = sys.bank.pink;
  src.loop = true;
  src.connect(ctx.destination);
  src.start(0);
  const rendered = await ctx.startRendering();
  const chans = [rendered.getChannelData(0), rendered.getChannelData(1)];
  writeFileSync(resolve(OUT, 'control-looped-noise.wav'), encodeWav(chans, SR));
  const loop = loopDetect(mono(chans), SR, 1.0, 30);
  log('control/looped-noise', {
    note: 'Positive control: a fixed 3.0 s loop, to show the detector works.',
    loopPeakCorrelation: loop.peak,
    loopPeakLagS: loop.lagS,
    topCorrelations: loop.top,
  });
}

// ---------------------------------------------------------------------------
// 5. Music
// ---------------------------------------------------------------------------

for (const [tag, tension] of [
  ['tension-low', 0.05],
  ['tension-high', 0.9],
]) {
  const seconds = 60;
  const r = await render(
    `music-${tag}`,
    seconds,
    (sys) => {
      sys.music.start(0.02);
    },
    {
      pump: (sys, t, dt) => {
        sys.music.setTension(tension);
        sys.music.update(t, dt);
      },
    },
  );
  const m = measure(r, (mo, _spec, rr) => {
    // The drone sits under 400 Hz and never stops; counting events on the raw
    // signal counts the drone. Lift the plucks off it first.
    const hp = highpass(mo, rr.sampleRate, 900);
    return {
      pluckEvents: countEvents(hp, rr.sampleRate, 0.18, 0.35),
      pluckEventsPerMinute: +((countEvents(hp, rr.sampleRate, 0.18, 0.35) / rr.seconds) * 60).toFixed(1),
      loopPeakCorrelation: loopDetect(mo, rr.sampleRate, 1, 25).peak,
    };
  });
  log(`music/${tag}`, m);
}

// ---------------------------------------------------------------------------
// 6. Reverb spaces — impulse through the real convolver path
// ---------------------------------------------------------------------------

for (const id of ['openForest', 'denseSpruce', 'stoneCourtyard', 'openArena']) {
  const seconds = 4;
  const r = await render(`reverb-${id}`, seconds, (sys, ctx, graph) => {
    graph.setReverb(id, 0.001, 0);
    // Dirac into the send, so what we measure is exactly the space.
    const buf = ctx.createBuffer(1, 4, SR);
    buf.getChannelData(0)[1] = 1;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(graph.reverbSend);
    src.start(0.05);
    // Take the send path only; keep bus dry paths silent.
    graph.reverbReturn.gain.value = 1;
  });
  const m = measure(r, (mo, _spec, rr) => ({
    rt20Ms: Math.round((decayTime(mo, rr.sampleRate, 20) ?? 0) * 1000),
    rt40Ms: Math.round((decayTime(mo, rr.sampleRate, 40) ?? 0) * 1000),
    tailLenMs: Math.round(activeDuration(mo, rr.sampleRate, -55) * 1000),
  }));
  log(`reverb/${id}`, m);
}

// ---------------------------------------------------------------------------
// 7. Full mix, and the map duck
// ---------------------------------------------------------------------------

{
  const seconds = 12;
  const r = await render(
    'mix-map-duck',
    seconds,
    (sys) => {
      sys.setEnvironment('forest', 0, 0.01);
      sys.ambience.setWind(0.6, 0, 0.01);
      sys.start(0.02);
      sys.mixer.duckForMap(true, 4.0);
      sys.mixer.duckForMap(false, 8.0);
    },
    {
      pump: (sys, t, dt) =>
        sys.update(t, dt, athlete({ glycogen: 0.55, speed: 3.4 }), {
          ground: 'needles',
          runnability: Runnability.ForestOpen,
        }),
    },
  );
  const m = measure(r, (mo, _spec, rr) => {
    const trace = rmsTrace(mo, rr.sampleRate, 0.25);
    const win = (a, b) => {
      const seg = trace.filter((p) => p.t >= a && p.t < b);
      return +(seg.reduce((s, p) => s + p.db, 0) / Math.max(1, seg.length)).toFixed(2);
    };
    const segSpec = (a, b) => {
      const s = averageSpectrum(
        mo.slice(Math.round(a * rr.sampleRate), Math.round(b * rr.sampleRate)),
        rr.sampleRate,
      );
      return Math.round(centroid(s.mag, s.binHz));
    };
    return {
      rmsBeforeDb: win(1.5, 3.8),
      rmsDuckedDb: win(4.8, 7.8),
      rmsAfterDb: win(9.5, 11.8),
      duckDepthDb: +(win(4.8, 7.8) - win(1.5, 3.8)).toFixed(2),
      recoveryDb: +(win(9.5, 11.8) - win(1.5, 3.8)).toFixed(2),
      centroidBeforeHz: segSpec(1.5, 3.8),
      centroidDuckedHz: segSpec(4.8, 7.8),
      centroidAfterHz: segSpec(9.5, 11.8),
    };
  });
  log('mix/map-duck', m);
}

// A full-mix worst case: everything at once, at the arena, punching.
{
  const seconds = 20;
  const r = await render(
    'mix-arena-full',
    seconds,
    (sys) => {
      sys.setEnvironment('arena', 0, 0.01);
      sys.ambience.setWind(0.8, 0, 0.01);
      sys.start(0.02);
      for (let i = 0; i < 6; i++) sys.punch.fire(2 + i * 3, i % 2 ? 'touchfree' : 'contact');
      sys.ambience.ringBells(6, 6);
    },
    {
      pump: (sys, t, dt) =>
        sys.update(t, dt, athlete({ glycogen: 0.25, focus: 0.4, speed: 4.4 }), {
          ground: 'gravel',
          runnability: Runnability.OpenFast,
        }),
    },
  );
  log('mix/arena-full', measure(r, () => ({})));
}

// Town: cobbles, river, monastery.
{
  const seconds = 25;
  const r = await render(
    'mix-town-krumlov',
    seconds,
    (sys) => {
      sys.setEnvironment('town', 0, 0.01);
      sys.ambience.setWind(0.3, 0, 0.01);
      sys.start(0.02);
      sys.ambience.ringBells(3, 8);
      sys.punch.fire(12, 'touchfree');
    },
    {
      pump: (sys, t, dt) =>
        sys.update(t, dt, athlete({ glycogen: 0.8, speed: 4.8 }), {
          ground: 'cobble',
          runnability: Runnability.Road,
        }),
    },
  );
  log('mix/town-krumlov', measure(r, () => ({})));
}

// Deep green, low glycogen: the wall, in the fight.
{
  const seconds = 25;
  const r = await render(
    'mix-forest-wall',
    seconds,
    (sys) => {
      sys.setEnvironment('forest', 0, 0.01);
      sys.ambience.setWind(0.4, 0, 0.01);
      sys.start(0.02);
    },
    {
      pump: (sys, t, dt) =>
        sys.update(t, dt, athlete({ glycogen: 0.12, hydration: 0.45, focus: 0.3, speed: 1.7 }), {
          ground: 'marsh',
          runnability: Runnability.Green3,
        }),
    },
  );
  log('mix/forest-wall', measure(r, () => ({})));
}

// ---------------------------------------------------------------------------
// 8. Struck metal, in isolation
// ---------------------------------------------------------------------------

{
  // One strike, dry, so the decay and the partial structure are measurable.
  const r = await render('bells-single', 8, (sys, _ctx, graph) => {
    sys.ambience.setEnvironment('town', 0, 0.001);
    graph.setReverb('denseSpruce', 0.001, 0);
    graph.reverbSend.gain.value = 0.05;
    sys.ambience.ringBells(0.1, 1);
  });
  log(
    'bells/single-strike',
    measure(r, (mo, _spec, rr) => {
      // Past the hammer transient: the ring is what makes it a bell.
      const ring = mo.slice(Math.round(0.2 * rr.sampleRate));
      const s2 = averageSpectrum(ring, rr.sampleRate, 16384, 8192, 1e-6);
      const peaks = spectralPeaks(s2.mag, s2.binHz, 8, 150, 4000);
      const prime = 392;
      return {
        ringDecay20dbMs: Math.round((decayTime(ring, rr.sampleRate, 20) ?? 0) * 1000),
        ringDecay40dbMs: Math.round((decayTime(ring, rr.sampleRate, 40) ?? 0) * 1000),
        totalLenMs: Math.round(activeDuration(mo, rr.sampleRate, -55) * 1000),
        partialsHz: peaks.map((p) => p.hz),
        partialRatiosToPrime: peaks.map((p) => +(p.hz / prime).toFixed(3)),
      };
    }),
  );

  const rp = await render('bells-peal', 14, (sys) => {
    sys.ambience.setEnvironment('town', 0, 0.001);
    sys.graph.setReverb('stoneCourtyard', 0.001, 0);
    sys.ambience.ringBells(0.2, 8);
  });
  log('bells/peal', measure(rp, () => ({})));
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

const failures = [];
for (const [name, c] of Object.entries(report.cases)) {
  if (typeof c.peak === 'number' && c.peak >= 0.99) failures.push(`${name}: peak ${c.peak} ≥ 0.99`);
  if (typeof c.dc === 'number' && Math.abs(c.dc) > 0.001) failures.push(`${name}: DC ${c.dc}`);
}

console.log('\n════════════════════════════════════════════════════════');
console.log(`bundle: ${(minBytes / 1024).toFixed(1)} kB minified, ${(gzipBytes / 1024).toFixed(1)} kB gzipped`);
console.log(failures.length ? `FAIL:\n  ${failures.join('\n  ')}` : 'PASS: no clipping, no DC offset');
console.log('════════════════════════════════════════════════════════');

report.failures = failures;
writeFileSync(resolve(OUT, 'report.json'), JSON.stringify(report, null, 2));
console.log(`\n${Object.keys(report.cases).length} cases → ${OUT}`);
