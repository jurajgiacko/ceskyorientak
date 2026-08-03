/**
 * PHASE 0 SPIKE — throwaway. The vector `blockedAt`, and how fast it answers.
 *
 * docs/PLAN-KRUMLOV-V2.md §6 phase 0 says the plan can be cancelled by one
 * number: whether a broadphase grid over Krumlov's *full* segment set can
 * answer `blockedAt` in well under the frame budget on a mid-range Android.
 * This module is the measurement. It is deliberately dependency-free and
 * engine-neutral so the identical source runs under Node on this desk and
 * inside a CPU-throttled headless Chrome, and the two numbers are comparable
 * because they are the same code rather than two ports of it.
 *
 * It is NOT a microbenchmark on a toy set. `buildModel` reads the shipped
 * `public/data/krumlov/townscape.json` and reproduces, primitive for primitive
 * and predicate for predicate, what §2's architecture asks for:
 *
 *   blockedAt(x, z) = insideAnyBuilding                     ISSprOM 521
 *                   | (onUncrossableBarrier & !onDeck)      515 / 518
 *                   | (underDrawnWater      & !onDeck)      301
 *
 * The algorithms are lifted from the shipping runtime — `BlockIndex` in
 * src/world/buildings.ts, `SegmentIndex` in src/world/townscape.ts, `Grid` and
 * `WaterIndex` in src/world/surface.ts — so a verdict here is a verdict about
 * code that exists, not about code I would like to have written. The one thing
 * that is v2 rather than v1 is `barriers: 'all'`: §2 rule 2 says drawn ≡ solid,
 * which means every barrier way carries a collider, not just the 405 tagged
 * uncrossable. That is the larger, honest set, and it is the one the kill
 * criterion should be judged against.
 *
 * The raster clause of v1's `blockedAt` is deliberately absent: the whole point
 * of §2 is that it goes away, and leaving it in would measure the hybrid.
 */

// ---------------------------------------------------------------------------
// Broadphase — a uniform grid, exactly as the runtime builds one
// ---------------------------------------------------------------------------

/**
 * Uniform grid over primitive bounding boxes.
 *
 * Uniform rather than a quadtree for the reason `BlockIndex` already states:
 * the old town is uniformly dense, so a quadtree over it would be a full tree
 * and would buy nothing but pointer chasing. `cellM` is the one tuning knob and
 * the spike sweeps it, because 12 m was chosen for 1739 building footprints and
 * has never been measured against the barrier set as well.
 */
class Grid {
  constructor(cellM) {
    this.cellM = cellM;
    this.cells = new Map();
  }

  add(idx, minX, minZ, maxX, maxZ) {
    const c = this.cellM;
    for (let cz = Math.floor(minZ / c); cz <= Math.floor(maxZ / c); cz++) {
      for (let cx = Math.floor(minX / c); cx <= Math.floor(maxX / c); cx++) {
        const key = cx * 100003 + cz;
        let list = this.cells.get(key);
        if (!list) {
          list = [];
          this.cells.set(key, list);
        }
        list.push(idx);
      }
    }
  }

  at(x, z) {
    const c = this.cellM;
    return this.cells.get(Math.floor(x / c) * 100003 + Math.floor(z / c));
  }

  /** Occupancy, which is what actually decides the query cost. */
  stats() {
    let total = 0;
    let max = 0;
    const counts = [];
    for (const l of this.cells.values()) {
      total += l.length;
      if (l.length > max) max = l.length;
      counts.push(l.length);
    }
    counts.sort((a, b) => a - b);
    const q = (p) => (counts.length ? counts[Math.min(counts.length - 1, Math.floor(counts.length * p))] : 0);
    return {
      cells: this.cells.size,
      entries: total,
      meanPerCell: counts.length ? total / counts.length : 0,
      p50: q(0.5),
      p99: q(0.99),
      max,
    };
  }
}

// ---------------------------------------------------------------------------
// Predicates
// ---------------------------------------------------------------------------

/** `WALL_SPEC` in src/world/townscape.ts, thicknesses only. */
const WALL_THICK_M = { 0: 0.45, 1: 1.15, 2: 0.6, 3: 0.1, 4: 0.95 };

function inRing(r, off, n, x, z) {
  let inside = false;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = r[off + i * 2];
    const zi = r[off + i * 2 + 1];
    const xj = r[off + j * 2];
    const zj = r[off + j * 2 + 1];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

// ---------------------------------------------------------------------------
// The model
// ---------------------------------------------------------------------------

/**
 * Build the whole vector collider set from `townscape.json`.
 *
 * Options:
 *   cellM     — broadphase cell size, metres.
 *   barriers  — 'all' (v2: drawn ≡ solid) or 'uncrossable' (v1's subset).
 *   flat      — pack rings and segments into typed arrays rather than objects.
 */
export function buildModel(town, opts = {}) {
  const cellM = opts.cellM ?? 12;
  const barriers = opts.barriers ?? 'all';

  // --- buildings: 1739 rings, ISSprOM 521 -----------------------------------
  const ringGrid = new Grid(cellM);
  const ringOff = [];
  const ringLen = [];
  const ringBB = [];
  const ringPts = [];
  for (const b of town.buildings) {
    const n = b.p.length / 2;
    if (n < 3) continue;
    const off = ringPts.length;
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (let i = 0; i < b.p.length; i += 2) {
      const x = b.p[i];
      const z = b.p[i + 1];
      ringPts.push(x, z);
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (z < minZ) minZ = z;
      if (z > maxZ) maxZ = z;
    }
    const idx = ringOff.length;
    ringOff.push(off);
    ringLen.push(n);
    ringBB.push(minX, minZ, maxX, maxZ);
    ringGrid.add(idx, minX, minZ, maxX, maxZ);
  }
  const RP = Float64Array.from(ringPts);
  const RO = Int32Array.from(ringOff);
  const RN = Int32Array.from(ringLen);
  const RB = Float64Array.from(ringBB);

  // --- barriers: wall / railing / hedge segments, ISSprOM 515 / 518 ---------
  // v2 registers every barrier way. v1 registers only `u` — the 405 ways the
  // extractor derived as uncrossable — which is exactly the asymmetry §2 rule 2
  // says must become unrepresentable.
  const segGrid = new Grid(cellM);
  const segPts = [];
  const segHalf = [];
  for (const w of town.walls) {
    if (barriers === 'uncrossable' && !w.u) continue;
    const n = w.p.length / 2;
    if (n < 2) continue;
    // `Townscape.buildWall` registers `thick * 0.5 + 0.25`, with `thick` from
    // `WALL_SPEC` keyed on the same `k` code. Copied to the centimetre: the
    // band decides how many cells a barrier lands in, which is the broadphase's
    // cost, so getting it approximately right would be measuring a fiction.
    const thick = WALL_THICK_M[w.k] ?? 0.45;
    const half = thick * 0.5 + 0.25;
    for (let i = 0; i < n - 1; i++) {
      const ax = w.p[i * 2];
      const az = w.p[i * 2 + 1];
      const bx = w.p[i * 2 + 2];
      const bz = w.p[i * 2 + 3];
      const len = Math.hypot(bx - ax, bz - az);
      if (len < 0.15 || len > 120) continue;
      const idx = segHalf.length;
      segPts.push(ax, az, bx, bz);
      segHalf.push(half);
      segGrid.add(
        idx,
        Math.min(ax, bx) - half,
        Math.min(az, bz) - half,
        Math.max(ax, bx) + half,
        Math.max(az, bz) + half,
      );
    }
  }
  const SP = Float64Array.from(segPts);
  const SH = Float64Array.from(segHalf);

  // --- bridge carriageways: the one exemption, from `BridgeDecks` -----------
  const deckGrid = new Grid(cellM);
  const deckPts = [];
  const deckHalf = [];
  for (const way of town.paved ?? []) {
    if (!way.b) continue;
    const n = way.l.length / 2;
    if (n < 2) continue;
    const half = Math.max(1.4, way.w * 0.5);
    for (let i = 0; i < n - 1; i++) {
      const ax = way.l[i * 2];
      const az = way.l[i * 2 + 1];
      const bx = way.l[i * 2 + 2];
      const bz = way.l[i * 2 + 3];
      const idx = deckHalf.length;
      deckPts.push(ax, az, bx, bz);
      deckHalf.push(half);
      deckGrid.add(
        idx,
        Math.min(ax, bx) - half,
        Math.min(az, bz) - half,
        Math.max(ax, bx) + half,
        Math.max(az, bz) + half,
      );
    }
  }
  const DP = Float64Array.from(deckPts);
  const DH = Float64Array.from(deckHalf);

  // --- water: areas and courses, ISSprOM 301 --------------------------------
  const waGrid = new Grid(cellM);
  const waOff = [];
  const waLen = [];
  const waPts = [];
  const wcGrid = new Grid(cellM);
  const wcPts = [];
  const wcHalf = [];
  for (const w of town.water ?? []) {
    if (w.p && w.p.length >= 6 && w.y !== undefined) {
      const off = waPts.length;
      let minX = Infinity;
      let maxX = -Infinity;
      let minZ = Infinity;
      let maxZ = -Infinity;
      for (let i = 0; i < w.p.length; i += 2) {
        const x = w.p[i];
        const z = w.p[i + 1];
        waPts.push(x, z);
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (z < minZ) minZ = z;
        if (z > maxZ) maxZ = z;
      }
      const idx = waOff.length;
      waOff.push(off);
      waLen.push(w.p.length / 2);
      waGrid.add(idx, minX, minZ, maxX, maxZ);
    } else if (w.l && w.w) {
      const half = w.w * 0.5;
      for (let i = 0; i + 3 < w.l.length; i += 2) {
        const ax = w.l[i];
        const az = w.l[i + 1];
        const bx = w.l[i + 2];
        const bz = w.l[i + 3];
        const idx = wcHalf.length;
        wcPts.push(ax, az, bx, bz);
        wcHalf.push(half);
        wcGrid.add(
          idx,
          Math.min(ax, bx) - half,
          Math.min(az, bz) - half,
          Math.max(ax, bx) + half,
          Math.max(az, bz) + half,
        );
      }
    }
  }
  const WAP = Float64Array.from(waPts);
  const WAO = Int32Array.from(waOff);
  const WAN = Int32Array.from(waLen);
  const WCP = Float64Array.from(wcPts);
  const WCH = Float64Array.from(wcHalf);

  // --- the predicate --------------------------------------------------------

  const nearSeg = (P, H, list, x, z) => {
    for (let k = 0; k < list.length; k++) {
      const i = list[k];
      const ax = P[i * 4];
      const az = P[i * 4 + 1];
      const dx = P[i * 4 + 2] - ax;
      const dz = P[i * 4 + 3] - az;
      const len2 = dx * dx + dz * dz;
      let t = len2 > 1e-9 ? ((x - ax) * dx + (z - az) * dz) / len2 : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const px = ax + dx * t - x;
      const pz = az + dz * t - z;
      const h = H[i];
      if (px * px + pz * pz <= h * h) return true;
    }
    return false;
  };

  const onDeck = (x, z) => {
    const list = deckGrid.at(x, z);
    return list === undefined ? false : nearSeg(DP, DH, list, x, z);
  };

  const blockedAt = (x, z) => {
    // 521 — every building, whether or not it has a door.
    const rl = ringGrid.at(x, z);
    if (rl !== undefined) {
      for (let k = 0; k < rl.length; k++) {
        const i = rl[k];
        if (x < RB[i * 4] || x > RB[i * 4 + 2]) continue;
        if (z < RB[i * 4 + 1] || z > RB[i * 4 + 3]) continue;
        if (inRing(RP, RO[i], RN[i], x, z)) return true;
      }
    }
    // 515 / 518, lifted over a carriageway.
    const sl = segGrid.at(x, z);
    if (sl !== undefined && nearSeg(SP, SH, sl, x, z) && !onDeck(x, z)) return true;
    // 301, lifted over a carriageway.
    const al = waGrid.at(x, z);
    if (al !== undefined) {
      for (let k = 0; k < al.length; k++) {
        const i = al[k];
        if (inRing(WAP, WAO[i], WAN[i], x, z)) return !onDeck(x, z);
      }
    }
    const cl = wcGrid.at(x, z);
    if (cl !== undefined && nearSeg(WCP, WCH, cl, x, z)) return !onDeck(x, z);
    return false;
  };

  return {
    blockedAt,
    stats: {
      cellM,
      barriers,
      rings: RO.length,
      ringVerts: RP.length / 2,
      segments: SH.length,
      deckSegments: DH.length,
      waterAreas: WAO.length,
      waterAreaVerts: WAP.length / 2,
      waterCourseSegments: WCH.length,
      primitives: RO.length + SH.length + DH.length + WAO.length + WCH.length,
      grids: {
        rings: ringGrid.stats(),
        segments: segGrid.stats(),
        decks: deckGrid.stats(),
        waterAreas: waGrid.stats(),
        waterCourses: wcGrid.stats(),
      },
      /** Retained bytes of the packed geometry, excluding the grid Maps. */
      geometryBytes:
        RP.byteLength + RO.byteLength + RN.byteLength + RB.byteLength +
        SP.byteLength + SH.byteLength + DP.byteLength + DH.byteLength +
        WAP.byteLength + WAO.byteLength + WAN.byteLength + WCP.byteLength + WCH.byteLength,
    },
  };
}

// ---------------------------------------------------------------------------
// Query patterns
// ---------------------------------------------------------------------------

/** xorshift128, so both engines walk the identical point sequence. */
function rng(seed) {
  let a = seed | 0 || 1;
  let b = 0x9e3779b9;
  let c = 0x243f6a88;
  let d = 0xb7e15162;
  return () => {
    const t = a ^ (a << 11);
    a = b; b = c; c = d;
    d = (d ^ (d >>> 19)) ^ (t ^ (t >>> 8));
    return (d >>> 0) / 4294967296;
  };
}

const HALF = 600; // the playable square is 1200 m; the skirt is not run on.

/**
 * The two patterns the plan names, and they have opposite cache behaviour.
 *
 *  - `athlete` — a body moving at sprint pace, 4 m/s at 60 Hz, so consecutive
 *    queries are ~7 cm apart and stay inside one broadphase cell for ~180
 *    frames. This is the per-frame case and the grid's best case.
 *  - `scatter` — the course generator's probes: control candidates, leg
 *    sampling, reachability seeds, thousands of them at load, landing anywhere.
 *    Every query is a cold Map lookup into a different bucket.
 *  - `scan` — `TerrainAdapter.bakedRaster`'s row-major sweep of the venue. Also
 *    a load-time cost, but perfectly coherent, and it is the largest single
 *    batch of `blockedAt` calls the game ever makes.
 */
export function makePoints(pattern, n, seed = 12345) {
  const r = rng(seed);
  const xs = new Float64Array(n);
  const zs = new Float64Array(n);
  if (pattern === 'scatter') {
    for (let i = 0; i < n; i++) {
      xs[i] = (r() * 2 - 1) * HALF;
      zs[i] = (r() * 2 - 1) * HALF;
    }
  } else if (pattern === 'scan') {
    // A 1 m grid over the venue, row-major, exactly as `bakedRaster` walks it —
    // and over the WHOLE venue. Taking the first n cells of a 1 m sweep samples
    // one corner, which for Krumlov is the wooded skirt rather than the town,
    // and would report the cost of the empty half of the map. The stride is
    // therefore widened to cover 1200 m in `n` points while keeping row-major
    // order, so the locality is the sweep's and the coverage is the venue's.
    const w = Math.ceil(Math.sqrt(n));
    const step = (HALF * 2) / w;
    for (let i = 0; i < n; i++) {
      xs[i] = -HALF + (i % w) * step;
      zs[i] = -HALF + Math.floor(i / w) * step;
    }
  } else {
    // A body at 4 m/s, 60 Hz, turning smoothly, reflected off the AOI edge.
    // Two probes per step (the x and z axes `SprintScene.move` tests) so the
    // sequence has the runtime's own shape.
    let x = 0;
    let z = 0;
    let a = 0;
    const step = 4 / 60;
    for (let i = 0; i < n; i += 2) {
      a += (r() - 0.5) * 0.25;
      const nx = x + Math.cos(a) * step;
      const nz = z + Math.sin(a) * step;
      if (Math.abs(nx) > HALF || Math.abs(nz) > HALF) a += Math.PI;
      else { x = nx; z = nz; }
      xs[i] = x + step;
      zs[i] = z;
      if (i + 1 < n) {
        xs[i + 1] = x;
        zs[i + 1] = z + step;
      }
    }
  }
  return { xs, zs };
}

// ---------------------------------------------------------------------------
// Measurement
// ---------------------------------------------------------------------------

const now =
  typeof process !== 'undefined' && process.hrtime
    ? () => Number(process.hrtime.bigint())          // ns, real resolution
    : () => performance.now() * 1e6;                  // ns, clamped resolution

/**
 * Mean nanoseconds per query, from a batch large enough that the clock's
 * resolution does not matter. This is the number that decides the budget.
 *
 * `sink` is returned and printed so neither engine can prove the calls dead and
 * fold them away — the classic way a collision microbenchmark reports zero.
 */
export function benchMean(blockedAt, pts, reps) {
  const { xs, zs } = pts;
  const n = xs.length;
  let sink = 0;
  // Warm: let the tiering compiler settle before anything is timed.
  for (let i = 0; i < n; i++) if (blockedAt(xs[i], zs[i])) sink++;
  const t0 = now();
  for (let r = 0; r < reps; r++) {
    for (let i = 0; i < n; i++) if (blockedAt(xs[i], zs[i])) sink++;
  }
  const t1 = now();
  return { nsPerQuery: (t1 - t0) / (n * reps), queries: n * reps, sink };
}

/**
 * Per-query distribution, timed in short blocks.
 *
 * Timing one call at a time is the obvious thing and it is wrong here, which
 * this spike found the hard way: with a clock call either side, the measured
 * *median* came out at 420 ns against a batch mean of 139 ns for the same
 * points. The clock is not merely 38 ns of additive overhead — it is an
 * optimisation barrier that stops V8 keeping the grid's hot fields in
 * registers across iterations, so single-shot timing measures a differently
 * compiled function. A number three times too large would have made this spike
 * fail its own kill criterion for an instrument artefact.
 *
 * So the tail is taken over blocks of `k` consecutive queries. The barrier is
 * then paid once per k rather than once per query, and at k=8 the residual
 * inflation is small enough to state. The cost is that a block hides a single
 * unusually expensive query among seven cheap ones — the reported p99 is
 * therefore the p99 of an 8-query *mean*, which is the honest description of
 * it, and it is also closer to what a frame actually pays than a single-query
 * tail would be, since no frame ever issues exactly one query.
 *
 * Only meaningful where the clock has nanosecond resolution — i.e. under Node.
 * A browser's `performance.now()` is clamped, so the browser driver reports the
 * per-frame tail from `benchFrames` instead and says so.
 */
export function benchTail(blockedAt, pts, opts = {}) {
  const { xs, zs } = pts;
  const k = opts.block ?? 8;
  const n = Math.floor(xs.length / k) * k;
  let sink = 0;
  for (let i = 0; i < n; i++) if (blockedAt(xs[i], zs[i])) sink++;

  // Calibrate the instrument against itself, at the same block size.
  let cal = 0;
  const calN = 20000;
  for (let i = 0; i < calN; i++) {
    const a = now();
    const b = now();
    cal += b - a;
  }
  const overhead = cal / calN / k;

  const blocks = n / k;
  const samples = new Float64Array(blocks);
  for (let b = 0; b < blocks; b++) {
    const base = b * k;
    const t0 = now();
    for (let j = 0; j < k; j++) if (blockedAt(xs[base + j], zs[base + j])) sink++;
    samples[b] = (now() - t0) / k;
  }
  const sorted = Array.prototype.slice.call(samples).sort((a, b) => a - b);
  const q = (p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
  return {
    blockSize: k,
    overheadNs: overhead,
    meanNs: sorted.reduce((s, v) => s + v, 0) / sorted.length - overhead,
    p50Ns: q(0.5) - overhead,
    p99Ns: q(0.99) - overhead,
    p999Ns: q(0.999) - overhead,
    maxNs: q(1) - overhead,
    sink,
    label: opts.label ?? '',
  };
}

/**
 * Per-frame cost: `perFrame` queries timed as one block, repeated.
 *
 * This is the tail that the frame budget actually cares about, and unlike a
 * per-query tail it survives a coarse clock, so it is the browser's number.
 */
export function benchFrames(blockedAt, pts, perFrame, frames) {
  const { xs, zs } = pts;
  const n = xs.length;
  let sink = 0;
  let cursor = 0;
  for (let i = 0; i < Math.min(n, 20000); i++) if (blockedAt(xs[i], zs[i])) sink++;

  // Group frames so one timed block clears a clamped clock, then divide back.
  const group = Math.max(1, Math.ceil(2000 / Math.max(1, perFrame)));
  const blocks = Math.max(1, Math.floor(frames / group));
  const out = new Float64Array(blocks);
  for (let b = 0; b < blocks; b++) {
    const t0 = now();
    for (let g = 0; g < group; g++) {
      for (let k = 0; k < perFrame; k++) {
        const i = cursor++ % n;
        if (blockedAt(xs[i], zs[i])) sink++;
      }
    }
    out[b] = (now() - t0) / group / 1e6; // ms per frame
  }
  const sorted = Array.prototype.slice.call(out).sort((a, b) => a - b);
  const q = (p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
  return {
    perFrame,
    framesPerBlock: group,
    blocks,
    meanMs: sorted.reduce((s, v) => s + v, 0) / sorted.length,
    p50Ms: q(0.5),
    p99Ms: q(0.99),
    maxMs: q(1),
    sink,
  };
}
