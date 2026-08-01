/**
 * Browser harness for the audio system.
 *
 *   npm run dev   →   http://localhost:3000/tools/audio/preview.html
 *
 * Buttons for every sound, sliders for every parameter, and a self-test that
 * runs the same measurements as `tools/audio/render.mjs` but inside the real
 * browser implementation — which is the only place the answer actually counts.
 * The self-test also re-runs the `setTargetAtTime` probe that `shim.mjs`
 * documents, so the claim "browsers get this right and the Node polyfill does
 * not" is checkable rather than asserted.
 */

import type { AthleteState, GroundType } from '@/core/types';
import { Runnability } from '@/core/types';
import {
  duckForMap,
  getAudio,
  getBusGain,
  initAudio,
  isAudioReady,
  punch,
  ringBells,
  setBusGain,
  setEnvironment,
  setMuted,
  unlockAudio,
  updateAudio,
  BUS_NAMES,
  type BusName,
  type EnvironmentId,
  type PunchKind,
} from '@/audio';

const GROUNDS: readonly GroundType[] = [
  'needles',
  'leaf',
  'grass',
  'rock',
  'marsh',
  'gravel',
  'cobble',
  'asphalt',
  'water',
];

const params = {
  glycogen: 1,
  hydration: 1,
  focus: 1,
  speed: 3.6,
  wind: 0.5,
  runnability: Runnability.ForestOpen,
  master: 1,
};

const state: AthleteState = {
  stats: { glycogen: 1, hydration: 1, bloodSugar: 0.7, focus: 1 },
  position: { x: 0, z: 0 },
  heading: 0,
  speed: 0,
  timeS: 0,
  believedPosition: { x: 0, z: 0 },
  navErrorM: 0,
};

let running = false;
let ground: GroundType = 'needles';
let env: EnvironmentId = 'forest';

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const statusEl = $('status');

function refreshStatus(): void {
  const sys = getAudio();
  const ctx = sys?.graph.ctx;
  statusEl.textContent = ctx
    ? [
        `context:  ${(ctx as AudioContext).state ?? 'offline'} @ ${ctx.sampleRate} Hz`,
        `running:  ${running ? 'yes' : 'no'}   ground: ${ground}   env: ${env}`,
        `speed:    ${params.speed.toFixed(2)} m/s   glycogen: ${params.glycogen.toFixed(2)}`,
        `buffers:  ${(sys.bank.bytes / 1048576).toFixed(2)} MB of noise`,
      ].join('\n')
    : 'context: not created';
}

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------

function slider(
  host: HTMLElement,
  label: string,
  min: number,
  max: number,
  step: number,
  get: () => number,
  set: (v: number) => void,
): void {
  const wrap = document.createElement('label');
  wrap.className = 'slider';
  const name = document.createElement('span');
  name.textContent = label;
  const input = document.createElement('input');
  input.type = 'range';
  input.min = String(min);
  input.max = String(max);
  input.step = String(step);
  input.value = String(get());
  const read = document.createElement('span');
  read.textContent = get().toFixed(2);
  input.addEventListener('input', () => {
    const v = Number(input.value);
    set(v);
    read.textContent = v.toFixed(2);
    refreshStatus();
  });
  wrap.append(name, input, read);
  host.append(wrap);
}

const groundsHost = $('grounds');
for (const g of GROUNDS) {
  const b = document.createElement('button');
  b.textContent = g;
  b.addEventListener('click', () => {
    ground = g;
    const sys = getAudio();
    if (!sys) return;
    sys.footsteps.trigger(sys.graph.ctx.currentTime + 0.02, {
      ground: g,
      speed: params.speed,
      runnability: params.runnability,
      glycogen: params.glycogen,
    });
    refreshStatus();
  });
  groundsHost.append(b);
}

for (const b of document.querySelectorAll<HTMLButtonElement>('[data-punch]')) {
  b.addEventListener('click', () => {
    punch(b.dataset.punch as PunchKind, b.dataset.double ? { double: true } : undefined);
  });
}

for (const b of document.querySelectorAll<HTMLButtonElement>('[data-env]')) {
  b.addEventListener('click', () => {
    env = b.dataset.env as EnvironmentId;
    setEnvironment(env);
    for (const other of document.querySelectorAll<HTMLButtonElement>('[data-env]')) {
      other.setAttribute('aria-pressed', String(other === b));
    }
    refreshStatus();
  });
}

$('bells').addEventListener('click', () => ringBells(9));

const a = $('sliders-a');
slider(a, 'glycogen', 0, 1, 0.01, () => params.glycogen, (v) => (params.glycogen = v));
slider(a, 'hydration', 0, 1, 0.01, () => params.hydration, (v) => (params.hydration = v));
slider(a, 'focus', 0, 1, 0.01, () => params.focus, (v) => (params.focus = v));
const b2 = $('sliders-b');
slider(b2, 'speed m/s', 0, 6, 0.05, () => params.speed, (v) => (params.speed = v));
slider(b2, 'wind', 0, 1, 0.01, () => params.wind, (v) => (params.wind = v));
slider(
  b2,
  'runnability',
  0,
  10,
  1,
  () => params.runnability as number,
  (v) => (params.runnability = v as Runnability),
);

const busHost = $('buses');
for (const bus of BUS_NAMES) {
  slider(busHost, bus, 0, 1.2, 0.01, () => getBusGain(bus) || 0.7, (v) => setBusGain(bus as BusName, v));
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

$('enable').addEventListener('click', () => {
  void unlockAudio().then(() => {
    refreshStatus();
    // Bus sliders only have real values once the graph exists.
    busHost.replaceChildren();
    for (const bus of BUS_NAMES) {
      slider(busHost, bus, 0, 1.2, 0.01, () => getBusGain(bus), (v) => setBusGain(bus as BusName, v));
    }
  });
});

const muteBtn = $('mute');
muteBtn.addEventListener('click', () => {
  const on = muteBtn.getAttribute('aria-pressed') !== 'true';
  muteBtn.setAttribute('aria-pressed', String(on));
  setMuted(on);
});

const runBtn = $('run');
runBtn.addEventListener('click', () => {
  running = !running;
  runBtn.setAttribute('aria-pressed', String(running));
  refreshStatus();
});

const mapBtn = $('map');
mapBtn.addEventListener('click', () => {
  const on = mapBtn.getAttribute('aria-pressed') !== 'true';
  mapBtn.setAttribute('aria-pressed', String(on));
  duckForMap(on);
});

// ---------------------------------------------------------------------------
// Frame loop
// ---------------------------------------------------------------------------

let last = performance.now();
function frame(now: number): void {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  if (isAudioReady()) {
    state.stats.glycogen = params.glycogen;
    state.stats.hydration = params.hydration;
    state.stats.focus = params.focus;
    state.speed = running ? params.speed : 0;
    state.timeS += dt;
    updateAudio(state, dt, {
      ground,
      runnability: params.runnability,
      environment: env,
      wind: params.wind,
    });
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// ---------------------------------------------------------------------------
// Self-test — the same measurements as the offline harness, in the browser
// ---------------------------------------------------------------------------

interface Measured {
  peak: number;
  rmsDb: number;
  dc: number;
  centroidHz: number;
}

type BreathRow = Measured & { breathsPerMinute: number; regularity: number };

/** Iterative radix-2 FFT, in place. */
function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i] as number;
      const ti = im[i] as number;
      re[i] = re[j] as number;
      im[i] = im[j] as number;
      re[j] = tr;
      im[j] = ti;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const h = i + k + len / 2;
        const ur = re[i + k] as number;
        const ui = im[i + k] as number;
        const vr = (re[h] as number) * cr - (im[h] as number) * ci;
        const vi = (re[h] as number) * ci + (im[h] as number) * cr;
        re[i + k] = ur + vr;
        im[i + k] = ui + vi;
        re[h] = ur - vr;
        im[h] = ui - vi;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
}

/**
 * Energy-weighted spectral centroid.
 *
 * This started life as a decimated brute-force DFT, which was fast, wrong, and
 * wrong in a way that looked plausible: decimating without a lowpass folds
 * everything above a few kHz back down, and every ground type reported a
 * centroid near 2.4 kHz. A real windowed FFT reproduces the offline harness's
 * numbers to within about 7%.
 */
function centroidOf(x: Float64Array, sampleRate: number): number {
  const N = 4096;
  const hop = 2048;
  const acc = new Float64Array(N / 2);
  const w = new Float64Array(N);
  for (let i = 0; i < N; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1));
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  let frames = 0;
  for (let s = 0; s + N <= x.length; s += hop) {
    let e = 0;
    for (let i = 0; i < N; i++) {
      const v = x[s + i] as number;
      e += v * v;
    }
    if (Math.sqrt(e / N) < 1e-5) continue;
    for (let i = 0; i < N; i++) {
      re[i] = (x[s + i] as number) * (w[i] as number);
      im[i] = 0;
    }
    fft(re, im);
    for (let k = 0; k < N / 2; k++) {
      acc[k] = (acc[k] as number) + Math.hypot(re[k] as number, im[k] as number);
    }
    frames++;
  }
  if (frames === 0) return 0;
  const binHz = sampleRate / N;
  let num = 0;
  let den = 0;
  for (let k = 1; k < acc.length - 1; k++) {
    num += k * binHz * (acc[k] as number);
    den += acc[k] as number;
  }
  return den > 0 ? Math.round(num / den) : 0;
}

function toMono(buf: AudioBuffer): Float64Array {
  const n = buf.length;
  const l = buf.getChannelData(0);
  const r = buf.numberOfChannels > 1 ? buf.getChannelData(1) : l;
  const m = new Float64Array(n);
  for (let i = 0; i < n; i++) m[i] = ((l[i] ?? 0) + (r[i] ?? 0)) / 2;
  return m;
}

function analyse(buf: AudioBuffer): Measured {
  const m = toMono(buf);
  let peak = 0;
  let sum = 0;
  let sq = 0;
  for (let i = 0; i < m.length; i++) {
    const v = m[i] as number;
    const a = Math.abs(v);
    if (a > peak) peak = a;
    sum += v;
    sq += v * v;
  }
  return {
    peak: +peak.toFixed(4),
    rmsDb: +(20 * Math.log10(Math.sqrt(sq / m.length) + 1e-12)).toFixed(2),
    dc: +(sum / m.length).toFixed(6),
    centroidHz: centroidOf(m, buf.sampleRate),
  };
}

/** Breath (or any cyclic envelope) rate, by envelope autocorrelation. */
function cyclesPerMinute(x: Float64Array, sampleRate: number): { perMinute: number; r: number } {
  const tc = 0.05;
  const a = Math.exp(-1 / (tc * sampleRate));
  const env = new Float64Array(x.length);
  let y = 0;
  for (let i = 0; i < x.length; i++) {
    const v = Math.abs(x[i] as number);
    y = v > y ? v : v * (1 - a) + y * a;
    env[i] = y;
  }
  const dec = 400;
  const n = Math.floor(env.length / dec);
  const s = new Float64Array(n);
  for (let i = 0; i < n; i++) s[i] = env[i * dec] as number;
  let mu = 0;
  for (let i = 0; i < n; i++) mu += s[i] as number;
  mu /= n;
  for (let i = 0; i < n; i++) s[i] = (s[i] as number) - mu;
  const sr = sampleRate / dec;
  let best = -2;
  let bestLag = 1;
  for (let lag = Math.round(0.6 * sr); lag <= Math.round(4.5 * sr); lag++) {
    let dot = 0;
    let ea = 0;
    let eb = 0;
    for (let i = 0; i + lag < n; i++) {
      dot += (s[i] as number) * (s[i + lag] as number);
      ea += (s[i] as number) ** 2;
      eb += (s[i + lag] as number) ** 2;
    }
    const r = ea > 0 && eb > 0 ? dot / Math.sqrt(ea * eb) : 0;
    if (r > best) {
      best = r;
      bestLag = lag;
    }
  }
  return { perMinute: +(60 / (bestLag / sr)).toFixed(1), r: +best.toFixed(3) };
}

/** L/R correlation. 0 = wide, 1 = mono. The mixer's width collapse shows here. */
function lrCorrelation(buf: AudioBuffer, fromS: number, toS: number): number {
  const l = buf.getChannelData(0);
  const r = buf.numberOfChannels > 1 ? buf.getChannelData(1) : l;
  let sll = 0;
  let srr = 0;
  let slr = 0;
  for (let i = Math.round(fromS * buf.sampleRate); i < Math.round(toS * buf.sampleRate); i++) {
    const a = l[i] ?? 0;
    const b = r[i] ?? 0;
    sll += a * a;
    srr += b * b;
    slr += a * b;
  }
  return sll > 0 && srr > 0 ? +(slr / Math.sqrt(sll * srr)).toFixed(3) : 0;
}

function rmsDbRange(x: Float64Array, sampleRate: number, fromS: number, toS: number): number {
  let s = 0;
  let n = 0;
  for (let i = Math.round(fromS * sampleRate); i < Math.round(toS * sampleRate); i++) {
    s += (x[i] as number) ** 2;
    n++;
  }
  return +(10 * Math.log10(s / Math.max(1, n) + 1e-12)).toFixed(2);
}

async function selfTest(): Promise<void> {
  const mod = await import('@/audio');
  const SR = 48000;

  // 1. setTargetAtTime, the case the Node polyfill gets wrong.
  {
    const ctx = new OfflineAudioContext(1, 12 * SR, SR);
    const src = ctx.createConstantSource();
    src.offset.value = 1;
    const g = ctx.createGain();
    g.gain.value = 1;
    src.connect(g).connect(ctx.destination);
    src.start(0);
    g.gain.setTargetAtTime(0.4, 4, 0.1);
    g.gain.setTargetAtTime(1, 8, 0.185);
    const out = await ctx.startRendering();
    const d = out.getChannelData(0);
    const at = (t: number): number => +(d[Math.round(t * SR)] ?? 0).toFixed(4);
    console.log('[selftest] setTargetAtTime — expect 1, 1, 0.404, 0.4, 0.997');
    console.log('[selftest]  ', at(0), at(3.9), at(4.5), at(7.9), at(9));
  }

  // 2. Footsteps: peak, DC and spectral centroid per ground type.
  const rows: Record<string, Measured> = {};
  for (const g of GROUNDS) {
    const ctx = new OfflineAudioContext(2, Math.round(4 * SR), SR);
    const graph = new mod.AudioGraph(ctx, ctx.destination);
    graph.buildReverbs();
    const sys = new mod.AudioSystem(graph, { seed: 20260805 });
    for (let i = 0; i < 8; i++) {
      sys.footsteps.trigger(0.15 + i * 0.45, {
        ground: g,
        speed: 3.6,
        runnability: Runnability.ForestOpen,
        glycogen: 1,
      });
    }
    rows[g] = analyse(await ctx.startRendering());
  }
  console.log('[selftest] footsteps');
  console.table(rows);

  // 3. Breath at both ends of the glycogen range.
  const breath: Record<string, BreathRow> = {};
  for (const [tag, glycogen] of [
    ['glycogen 1.0', 1],
    ['glycogen 0.2', 0.2],
  ] as const) {
    const seconds = 30;
    const ctx = new OfflineAudioContext(2, seconds * SR, SR);
    const graph = new mod.AudioGraph(ctx, ctx.destination);
    graph.buildReverbs();
    const sys = new mod.AudioSystem(graph, { seed: 20260805 });
    sys.breathing.start(0.02);
    for (let t = 0; t < seconds; t += 1 / 60) {
      sys.breathing.update(t, 1 / 60, { glycogen, speed: 3.4, hydration: glycogen });
    }
    const rendered = await ctx.startRendering();
    const rate = cyclesPerMinute(toMono(rendered), rendered.sampleRate);
    breath[tag] = { ...analyse(rendered), breathsPerMinute: rate.perMinute, regularity: rate.r };
  }
  console.log('[selftest] breath — rate, level and centroid must all rise as glycogen falls');
  console.table(breath);

  // 3b. The map duck, on all three axes it is supposed to move.
  {
    const seconds = 12;
    const ctx = new OfflineAudioContext(2, seconds * SR, SR);
    const graph = new mod.AudioGraph(ctx, ctx.destination);
    graph.buildReverbs();
    const sys = new mod.AudioSystem(graph, { seed: 20260805 });
    sys.setEnvironment('forest', 0, 0.01);
    sys.ambience.setWind(0.6, 0, 0.01);
    sys.start(0.02);
    sys.mixer.duckForMap(true, 4);
    sys.mixer.duckForMap(false, 8);
    const s2: AthleteState = {
      stats: { glycogen: 0.55, hydration: 1, bloodSugar: 0.7, focus: 1 },
      position: { x: 0, z: 0 },
      heading: 0,
      speed: 3.4,
      timeS: 0,
      believedPosition: { x: 0, z: 0 },
      navErrorM: 0,
    };
    for (let t = 0; t < seconds; t += 1 / 60) {
      sys.update(t, 1 / 60, s2, { ground: 'needles', runnability: Runnability.ForestOpen });
    }
    const out = await ctx.startRendering();
    const m = toMono(out);
    const win = (a: number, b: number): Measured & { lrCorr: number; rms: number } => ({
      ...analyse(out),
      rms: rmsDbRange(m, SR, a, b),
      lrCorr: lrCorrelation(out, a, b),
      centroidHz: centroidOf(m.slice(Math.round(a * SR), Math.round(b * SR)), SR),
    });
    console.log('[selftest] map duck — level down, centroid down, L/R correlation up');
    console.table({
      before: win(1.5, 3.8),
      ducked: win(4.8, 7.8),
      after: win(9.5, 11.8),
    });
  }

  // 4. Full mix worst case — the clipping guarantee.
  {
    const seconds = 16;
    const ctx = new OfflineAudioContext(2, seconds * SR, SR);
    const graph = new mod.AudioGraph(ctx, ctx.destination);
    graph.buildReverbs();
    const sys = new mod.AudioSystem(graph, { seed: 20260805 });
    sys.setEnvironment('arena', 0, 0.01);
    sys.ambience.setWind(0.9, 0, 0.01);
    sys.start(0.02);
    for (let i = 0; i < 5; i++) sys.punch.fire(2 + i * 3, i % 2 ? 'touchfree' : 'contact');
    const s: AthleteState = {
      stats: { glycogen: 0.2, hydration: 0.5, bloodSugar: 0.4, focus: 0.35 },
      position: { x: 0, z: 0 },
      heading: 0,
      speed: 4.5,
      timeS: 0,
      believedPosition: { x: 0, z: 0 },
      navErrorM: 0,
    };
    for (let t = 0; t < seconds; t += 1 / 60) {
      sys.update(t, 1 / 60, s, { ground: 'gravel', runnability: Runnability.OpenFast });
    }
    const m = analyse(await ctx.startRendering());
    console.log('[selftest] full arena mix', m, m.peak < 0.99 ? '→ PASS' : '→ FAIL (clipping)');
  }
  console.log('[selftest] done');
}

$('selftest').addEventListener('click', () => {
  console.log('[selftest] starting…');
  void selfTest().catch((e) => console.error('[selftest] failed', e));
});

initAudio({ onReady: () => refreshStatus() });
refreshStatus();
