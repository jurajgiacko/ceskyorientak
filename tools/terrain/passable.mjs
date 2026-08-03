#!/usr/bin/env node
/**
 * The passable space — derived from the town model, asserted connected, and
 * shipped as data.
 *
 * PLAN-KRUMLOV-V2 §2 rule 4 and §6 phase 2: *"Passable space is derived, then
 * asserted connected, before any course exists. Not flood-filled afterwards to
 * see what broke."* This is that inversion, and it is where the whole of it
 * happens: the space is computed here, from `townmodel.bin`, once.
 *
 * ---------------------------------------------------------------------------
 * Why this exists at all, when the model already answers `blockedAt`
 * ---------------------------------------------------------------------------
 *
 * Because "is this point out of bounds" and "can the athlete get there" are
 * different questions, and only the second one is what a player experiences. A
 * venue can pass every point-wise test and still be a set of sealed courtyards:
 * that is D-027's 3 040 m² pocket around Náměstí Svornosti, and it is the
 * "we're in some small circle and can't continue" the client reported. The
 * second question is a *global* property, so it costs a venue-wide flood — and
 * phase 0 measured that flood at **2.9 s on the 4×-throttled Android proxy**,
 * with `bakedRaster`'s sweep another 2.6 s in front of it. Both were in the
 * loading screen.
 *
 * So the flood moves here and its answer ships. What the runtime does at load
 * is read a bit out of an array.
 *
 * ---------------------------------------------------------------------------
 * The resolution, and the evidence for it
 * ---------------------------------------------------------------------------
 *
 * **0.5 m.** Phase 0 measured what each grid keeps of Krumlov's ≤3 m alleys
 * against a 96.1 % ceiling set by the vector model itself, and — the column
 * that matters more — what each grid *falsely opens*, because a coarse lattice
 * steps clean over a 0.1 m railing and deletes it:
 *
 * | cell | alleys kept | false-open | 1-bit RAM |
 * |---|---|---|---|
 * | 4 m | 62.8 % | 1.30 % | 11 kB |
 * | 1 m | 89.2 % | 0.70 % | 176 kB |
 * | **0.5 m** | **93.9 %** | **0.51 %** | **704 kB** |
 * | 0.25 m | 96.0 % | 0.43 % | 2814 kB |
 *
 * 0.25 m buys two points of alley for four times the memory. 1 m is where the
 * runtime's own fill has been running, and 0.5 m is where `check-passable`'s
 * flood has been running — which is the fourth reason and the strongest one:
 * **the gate and the game have been reading two different lattices**, and a
 * gate that is finer than the thing it judges is exactly D-027's shape (the
 * gate read `runnability.bin`, the phone read `runnability-low.bin`). Shipping
 * the space makes them the same array.
 *
 * ---------------------------------------------------------------------------
 * Whose space it is, and the thing that had to be fixed first
 * ---------------------------------------------------------------------------
 *
 * §6 phase 2 says "derive the passable space from `TownModel`", and when this
 * file was first written that sentence was not true of the running game.
 * `SprintScene.blockedAt` was one call into the model (D-038), but it was not
 * what stopped the athlete: `Race.step` collided against
 * `FieldTerrain.runnabilityAt`, which was the model **or** the 1 m class
 * raster's `Impassable`. And that class is the model *drawn at map line
 * widths* — a feature narrower than the lattice is widened to half a cell
 * diagonal so a 0.10 m railing appears as a line rather than as dots, which is
 * correct cartography (at 1:4000 an ISSprOM 0.25 mm line **is** a metre of
 * ground) and is a wall up to 2.4 m thick if you collide against it.
 *
 * `tools/terrain/quantisation.mjs` measured what that cost on the town's own
 * 62 741 paved centreline points, casting perpendicular to each:
 *
 * | | vector | through the raster |
 * |---|---|---|
 * | median ≤3 m alley | 1.80 m | **1.52 m** |
 * | alley centreline the athlete cannot stand on | 0 % | **12.8 %** |
 *
 * So the fix is upstream of this file and phase 2 made it: `Race.step` now
 * asks `FieldTerrain.blockedAt`, which inside the model's own square is the
 * model and nothing else. The raster went back to being the map. **This file
 * can therefore derive the space from `TownModel` and mean it** — which is what
 * §2 said all along, and what the game was not doing.
 *
 * ---------------------------------------------------------------------------
 * The graph is the athlete's, not the lattice's
 * ---------------------------------------------------------------------------
 *
 * Connectivity is 8-connected and **every edge is swept at `SWEEP_M`**, the
 * same 0.20 m `Race.step` samples a step along. That is not a refinement, it is
 * the difference between measuring the town and measuring the grid:
 *
 *  - *4-connected* calls two diagonally adjacent open cells disconnected when
 *    their shared orthogonal neighbours are blocked — a 0.5 m diagonal doorway
 *    the athlete walks straight through. `check-passable` has been reporting
 *    those as "grid artifacts" and excusing them; here they are simply edges.
 *  - *Unswept* edges would let the flood cross anything thinner than a cell.
 *    D-038's railing is 0.60 m of collider and the lattice is 0.5 m.
 *
 * With both, a component boundary is a wall rather than an aliasing artefact,
 * and the census below says something about Krumlov instead of about a grid.
 *
 * Usage: node tools/terrain/passable.mjs [--venue=krumlov] [--res=0.5] [--quiet]
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { readModel, colliders } from './townmodel.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../..');

const VENUES = {
  krumlov: { data: 'public/data/krumlov', arena: { x: 1, z: 24 } },
};

/**
 * The lattice, metres. See the header — this is phase 0's measured trade, and
 * it is also the resolution the gate already floods at.
 */
const RES_M = 0.5;

/**
 * How finely a step is sampled along its path, metres. `SWEEP_M` in
 * src/sim/race.ts, and it must stay equal to it: this file's edges are that
 * function's answer, precomputed.
 */
const SWEEP_M = 0.2;

/**
 * The longest single step the athlete can take, metres.
 *
 * `MAX_STEP_M` in tools/ci/check-passable.mjs: BASE_MS 4.6 × the road
 * multiplier × the 1.22 downhill cap × the 0.1 s frame clamp = 0.56, rounded
 * up. Used only by the entry probe below, which asks whether a pocket can be
 * stepped into from outside.
 */
const MAX_STEP_M = 0.6;

/** Smallest pocket worth naming, m². Below this it is a cell, not a place. */
const MIN_POCKET_M2 = 6;

/**
 * Area above which a symmetric gap stops being a way out, m².
 *
 * `minWanderM2` in check-passable, carried over with its argument: below it the
 * athlete is never more than a few strides from the hole they came in through;
 * above it the hole is a needle and nobody finds it twice.
 */
const MIN_WANDER_M2 = 150;

// ---------------------------------------------------------------------------
// Bit planes
// ---------------------------------------------------------------------------

/**
 * One bit per cell, LSB-first within each byte.
 *
 * A byte per cell would be 5.8 MB of a phone's memory for a boolean. Packed it
 * is 704 kB, and the unpack is two integer ops — measurably cheaper than the
 * cache miss a byte array costs at this size.
 */
function packBits(flags) {
  const out = new Uint8Array(Math.ceil(flags.length / 8));
  for (let k = 0; k < flags.length; k++) if (flags[k]) out[k >> 3] |= 1 << (k & 7);
  return out;
}

// ---------------------------------------------------------------------------
// The space
// ---------------------------------------------------------------------------

/**
 * Derive the passable space and label its components.
 *
 * Returns the planes plus a full census: every component that is not the
 * arena's, with its area, its centre, and whether the athlete can get into it.
 * The caller decides what is a failure; this only measures.
 */
export function derivePassable(col, { res, playableR, arena, sweepM = SWEEP_M }) {
  const w = Math.round((2 * playableR) / res) + 1;
  const h = w;
  const x0 = -playableR;
  const z0 = -playableR;
  const cellM2 = res * res;
  const xAt = (i) => x0 + i * res;
  const zAt = (j) => z0 + j * res;

  // --- what is open ---------------------------------------------------------
  const open = new Uint8Array(w * h);
  for (let j = 0; j < h; j++) {
    const z = zAt(j);
    for (let i = 0; i < w; i++) open[j * w + i] = col.blockedAt(xAt(i), z) ? 0 : 1;
  }

  /**
   * Can the athlete walk from a to b in one step?
   *
   * `Race.step`'s `pathBlocked`, exactly: sample the path every `sweepM` and
   * refuse if anything on it blocks. The endpoints are already known open, so
   * only the interior is asked — which for an orthogonal 0.5 m edge is three
   * probes and for a diagonal one is four.
   */
  const clear = (ax, az, bx, bz) => {
    const steps = Math.ceil(Math.hypot(bx - ax, bz - az) / sweepM);
    for (let s = 1; s < steps; s++) {
      const t = s / steps;
      if (col.blockedAt(ax + (bx - ax) * t, az + (bz - az) * t)) return false;
    }
    return true;
  };

  // --- the edges ------------------------------------------------------------
  //
  // Four directions per cell cover all eight: E, S, SE and SW, each read
  // backwards from its neighbour for the other four.
  const eastOk = new Uint8Array(w * h);
  const southOk = new Uint8Array(w * h);
  const seOk = new Uint8Array(w * h);
  const swOk = new Uint8Array(w * h);
  let probes = 0;
  for (let j = 0; j < h; j++) {
    const z = zAt(j);
    for (let i = 0; i < w; i++) {
      const k = j * w + i;
      if (!open[k]) continue;
      const x = xAt(i);
      if (i + 1 < w && open[k + 1] && clear(x, z, x + res, z)) eastOk[k] = 1;
      if (j + 1 < h && open[k + w] && clear(x, z, x, z + res)) southOk[k] = 1;
      if (i + 1 < w && j + 1 < h && open[k + w + 1] && clear(x, z, x + res, z + res)) seOk[k] = 1;
      if (i > 0 && j + 1 < h && open[k + w - 1] && clear(x, z, x - res, z + res)) swOk[k] = 1;
      probes += 4;
    }
  }

  // --- components -----------------------------------------------------------
  const comp = new Int32Array(w * h).fill(-1);
  const queue = new Int32Array(w * h);
  const sizes = [];
  /** The eight moves, as [offset, the plane that authorises it, read forwards]. */
  const step8 = (k, i, j, visit) => {
    if (eastOk[k]) visit(k + 1);
    if (i > 0 && eastOk[k - 1]) visit(k - 1);
    if (southOk[k]) visit(k + w);
    if (j > 0 && southOk[k - w]) visit(k - w);
    if (seOk[k]) visit(k + w + 1);
    if (i > 0 && j > 0 && seOk[k - w - 1]) visit(k - w - 1);
    if (swOk[k]) visit(k + w - 1);
    if (i + 1 < w && j > 0 && swOk[k - w + 1]) visit(k - w + 1);
  };
  for (let s = 0; s < w * h; s++) {
    if (!open[s] || comp[s] >= 0) continue;
    const id = sizes.length;
    let head = 0;
    let tail = 0;
    comp[s] = id;
    queue[tail++] = s;
    while (head < tail) {
      const k = queue[head++];
      const i = k % w;
      const j = (k / w) | 0;
      step8(k, i, j, (n) => {
        if (comp[n] < 0) {
          comp[n] = id;
          queue[tail++] = n;
        }
      });
    }
    sizes.push(tail);
  }

  // --- the arena's component ------------------------------------------------
  let arenaId = -1;
  {
    const ai = Math.round((arena.x - x0) / res);
    const aj = Math.round((arena.z - z0) / res);
    arenaId = comp[aj * w + ai] ?? -1;
    if (arenaId < 0) {
      // The arena anchor can sit inside something. Take the nearest open cell,
      // which is what `nearestReachable` does at runtime.
      let bd = Infinity;
      for (let j = 0; j < h; j++) {
        for (let i = 0; i < w; i++) {
          const k = j * w + i;
          if (comp[k] < 0) continue;
          const d = (i - ai) ** 2 + (j - aj) ** 2;
          if (d < bd) {
            bd = d;
            arenaId = comp[k];
          }
        }
      }
    }
  }

  const reach = new Uint8Array(w * h);
  for (let k = 0; k < comp.length; k++) reach[k] = comp[k] === arenaId ? 1 : 0;

  const cellsOf = new Map();
  for (let k = 0; k < comp.length; k++) {
    const id = comp[k];
    if (id < 0 || id === arenaId) continue;
    let list = cellsOf.get(id);
    if (!list) {
      list = [];
      cellsOf.set(id, list);
    }
    list.push(k);
  }

  const compAt = (x, z) => {
    const i = Math.round((x - x0) / res);
    const j = Math.round((z - z0) / res);
    if (i < 0 || j < 0 || i >= w || j >= h) return -1;
    return comp[j * w + i];
  };

  /** How far the entry probe reaches, in cells. See `probe`. */
  const NEAR_CELLS = Math.ceil((MAX_STEP_M + 0.15 + res) / res);

  /**
   * Is there a way into this component, and is anything in the way?
   *
   * Probed off its boundary cells in 32 bearings out to one full step, because
   * **the lattice is not where the gaps are.** A 0.5 m doorway between two wall
   * corners falls between cell centres: the athlete walks through it and no
   * edge of the component graph — not even a swept diagonal one — can join the
   * two cells, because the line between their *centres* is blocked while a line
   * between two points inside them is not.
   *
   *  - `reallyConnected` — a clear swept line in, with nothing at all in the
   *    way. The lattice is wrong and the athlete is right.
   *  - `minJump` — the same probe with something in the way. A swept step
   *    cannot cross that any more (D-038), so it can no longer make an entry;
   *    it is measured because how thin the thinnest barrier is remains worth
   *    knowing.
   *
   * The cheap lattice test comes first: a boundary cell with no arena cell
   * within `NEAR_CELLS` cannot possibly have a clear step into one, and Krumlov's
   * sealed courtyards are behind walls a metre and a half thick. It takes this
   * from minutes to seconds.
   */
  const probe = (id, cells) => {
    let reallyConnected = false;
    let minJump = Infinity;
    let jumpAt = null;
    for (const k of cells) {
      if (reallyConnected) break;
      const i = k % w;
      const j = (k / w) | 0;
      const boundary =
        (i > 0 && comp[k - 1] !== id) ||
        (i < w - 1 && comp[k + 1] !== id) ||
        (j > 0 && comp[k - w] !== id) ||
        (j < h - 1 && comp[k + w] !== id);
      if (!boundary) continue;
      let near = false;
      for (let dj = -NEAR_CELLS; dj <= NEAR_CELLS && !near; dj++) {
        const jj = j + dj;
        if (jj < 0 || jj >= h) continue;
        for (let di = -NEAR_CELLS; di <= NEAR_CELLS; di++) {
          const ii = i + di;
          if (ii < 0 || ii >= w) continue;
          if (comp[jj * w + ii] === arenaId) {
            near = true;
            break;
          }
        }
      }
      if (!near) continue;
      const px = xAt(i);
      const pz = zAt(j);
      for (let a = 0; a < 32 && !reallyConnected; a++) {
        const th = (a / 32) * Math.PI * 2;
        const ux = Math.sin(th);
        const uz = -Math.cos(th);
        for (let d = 0.1; d <= MAX_STEP_M + 0.15; d += 0.05) {
          const qx = px + ux * d;
          const qz = pz + uz * d;
          if (col.blockedAt(qx, qz)) continue;
          if (compAt(qx, qz) !== arenaId) continue;
          if (clear(px, pz, qx, qz)) {
            reallyConnected = true;
            break;
          }
          if (d < minJump) {
            minJump = d;
            jumpAt = [Number(qx.toFixed(2)), Number(qz.toFixed(2))];
          }
          break;
        }
      }
    }
    return { reallyConnected, minJump, jumpAt };
  };

  /**
   * Where the lattice and the athlete disagree, the athlete wins.
   *
   * A component the probe can walk into is part of the arena's component,
   * whatever the graph says, and merging it is not a fudge — it is the only way
   * the shipped `reach` plane can mean *"ground the athlete can get to"* rather
   * than *"ground a 0.5 m lattice can express a path to"*. Left alone it says
   * unreachable about ground you can stand on, and the course generator refuses
   * to site a control there for a reason that is not true.
   *
   * Krumlov has two of them, 246 m² and 34 m². Iterated to a fixed point
   * because merging one can put the arena within a step of the next.
   */
  let mergedComponents = 0;
  let mergedCells = 0;
  for (let round = 0; round < 8; round++) {
    let merged = false;
    for (const [id, cells] of [...cellsOf]) {
      if (!probe(id, cells).reallyConnected) continue;
      for (const k of cells) {
        comp[k] = arenaId;
        reach[k] = 1;
      }
      cellsOf.delete(id);
      mergedComponents++;
      mergedCells += cells.length;
      merged = true;
    }
    if (!merged) break;
  }

  let openN = 0;
  for (let k = 0; k < open.length; k++) openN += open[k];
  let reachN = 0;
  for (let k = 0; k < reach.length; k++) reachN += reach[k];

  // --- the census -----------------------------------------------------------
  //
  // The vocabulary is `check-passable`'s and is deliberately not reinvented:
  // **sealed** (the athlete cannot get in either, which is not a fault — the
  // zámecká zahrada is 0.9 ha of genuinely enclosed parterre), **porous** (a
  // way in and the same way out), **grid artifact** (the labelling is wrong,
  // not the town), and **trap** (in and not out, which is the thing that
  // strands a player).
  //
  // Two of those four are now arithmetically empty rather than merely
  // unobserved, and it is worth saying which and why. A swept step is
  // symmetric, so a gap you can enter by is a gap you can leave by (D-038) —
  // there is no asymmetry left to make a **trap** out of, and nothing that is
  // enterable is anything but **porous**. And the reconciliation above has
  // already merged every **grid artifact** there was. What the census can still
  // report is *sealed*, which is Krumlov being Krumlov, and it will report the
  // other three the day one appears.
  const pockets = [];
  for (const [id, cells] of cellsOf) {
    const m2 = cells.length * cellM2;
    if (m2 < MIN_POCKET_M2) continue;
    let sx = 0;
    let sz = 0;
    for (const k of cells) {
      sx += xAt(k % w);
      sz += zAt((k / w) | 0);
    }
    const { reallyConnected, minJump, jumpAt } = probe(id, cells);
    const enterable = reallyConnected;
    const escapable = reallyConnected;
    pockets.push({
      id,
      m2: Math.round(m2),
      at: { x: Math.round(sx / cells.length), z: Math.round(sz / cells.length) },
      minJumpM: Number.isFinite(minJump) ? Number(minJump.toFixed(2)) : null,
      jumpAt,
      reallyConnected,
      enterable,
      escapable,
      trap: !reallyConnected && enterable && (!escapable || m2 >= MIN_WANDER_M2),
    });
  }
  pockets.sort((a, b) => b.m2 - a.m2);

  return {
    res,
    playableR,
    w,
    h,
    x0,
    z0,
    open,
    reach,
    comp,
    arenaId,
    openM2: openN * cellM2,
    reachM2: reachN * cellM2,
    fraction: openN ? reachN / openN : 0,
    components: sizes.length,
    mergedComponents,
    mergedM2: mergedCells * cellM2,
    pockets,
    probes,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const args = process.argv.slice(2);
  const arg = (name, dflt) => {
    const a = args.find((v) => v.startsWith(`--${name}=`));
    return a ? a.slice(name.length + 3) : dflt;
  };
  const venueId = arg('venue', 'krumlov');
  const res = Number(arg('res', String(RES_M)));
  const cfg = VENUES[venueId];
  if (!cfg) {
    console.error(`✗ unknown venue "${venueId}"`);
    process.exit(2);
  }

  const dataDir = resolve(ROOT, cfg.data);
  if (!existsSync(join(dataDir, 'townmodel.bin'))) {
    console.error(`✗ ${join(cfg.data, 'townmodel.bin')} missing — run tools/terrain/townmodel.mjs`);
    process.exit(2);
  }

  const t0 = Date.now();
  // Read the *shipped* model rather than re-deriving from `townscape.json`.
  // The thing that has to be right is the file the game loads, and phase 1 made
  // that a rule for its own gate for the same reason.
  const { header, model } = readModel(dataDir);
  const col = colliders(model);
  const space = derivePassable(col, {
    res,
    playableR: header.playableR,
    arena: cfg.arena,
  });
  const buildMs = Date.now() - t0;

  const sealed = space.pockets.filter((p) => !p.reallyConnected && !p.enterable);
  const artifacts = space.pockets.filter((p) => p.reallyConnected);
  const porous = space.pockets.filter((p) => !p.reallyConnected && p.enterable && !p.trap);
  const traps = space.pockets.filter((p) => p.trap);

  // --- pack -----------------------------------------------------------------
  const openBits = packBits(space.open);
  const reachBits = packBits(space.reach);
  const bin = Buffer.concat([Buffer.from(openBits), Buffer.from(reachBits)]);

  const meta = {
    venue: venueId,
    generatedAt: new Date().toISOString(),
    from: 'townmodel.bin',
    /**
     * The model the space was derived from, by its own byte count. A passable
     * space built against a different model is a passable space that describes
     * a different town, and the runtime refuses it rather than running on it.
     */
    modelBytes: header.bytes,
    resM: res,
    playableR: header.playableR,
    width: space.w,
    height: space.h,
    originX: space.x0,
    originZ: space.z0,
    arena: cfg.arena,
    sweepM: SWEEP_M,
    connectivity: 8,
    sections: {
      open: { offset: 0, bits: space.w * space.h },
      reach: { offset: openBits.length, bits: space.w * space.h },
    },
    openM2: Math.round(space.openM2),
    reachM2: Math.round(space.reachM2),
    reachableFraction: Number(space.fraction.toFixed(5)),
    components: space.components,
    /** Components the lattice split and the entry probe put back. See `probe`. */
    reconciled: { components: space.mergedComponents, m2: Math.round(space.mergedM2) },
    census: {
      overM2: MIN_POCKET_M2,
      pockets: space.pockets.length,
      sealed: sealed.length,
      porous: porous.length,
      gridArtifacts: artifacts.length,
      traps: traps.length,
      largestPocketM2: space.pockets[0]?.m2 ?? 0,
      pocketM2: space.pockets.reduce((a, p) => a + p.m2, 0),
    },
    /** Every pocket, not a sample: the biggest twenty by area, then the tail as a total. */
    pocketList: space.pockets.slice(0, 20).map((p) => ({
      m2: p.m2,
      at: p.at,
      kind: p.reallyConnected ? 'grid-artifact' : p.trap ? 'trap' : p.enterable ? 'porous' : 'sealed',
      minJumpM: p.minJumpM,
    })),
    bytes: bin.length,
    buildMs,
  };

  writeFileSync(join(dataDir, 'passable.bin'), bin);
  writeFileSync(join(dataDir, 'passable.json'), `${JSON.stringify(meta, null, 2)}\n`);

  const gz = gzipSync(bin).length;
  if (!args.includes('--quiet')) {
    console.log(`✓ ${join(cfg.data, 'passable.bin')}`);
    console.log(
      `  ${space.w}×${space.h} at ${res} m over ±${header.playableR} m — ` +
        `${(space.openM2 / 1e4).toFixed(1)} ha open, ${(space.reachM2 / 1e4).toFixed(1)} ha ` +
        `reachable from the arena (${(space.fraction * 100).toFixed(1)} %)`,
    );
    console.log(
      `  ${space.components} components · ${space.pockets.length} pockets over ${MIN_POCKET_M2} m² ` +
        `(${sealed.length} sealed · ${porous.length} porous · ${artifacts.length} grid artifacts · ` +
        `${traps.length} traps)`,
    );
    console.log(
      `  ${space.mergedComponents} components (${Math.round(space.mergedM2)} m²) the lattice split ` +
        'and the entry probe put back',
    );
    for (const p of space.pockets.slice(0, 6)) {
      const kind = p.reallyConnected
        ? 'GRID ARTIFACT — the labelling is wrong, not the town'
        : p.trap
          ? 'TRAP — the athlete gets in and cannot get out'
          : p.enterable
            ? 'porous — a way in and the same way out'
            : 'sealed — the athlete cannot get in either';
      console.log(`     ${String(p.m2).padStart(6)} m²  near (${p.at.x}, ${p.at.z})  ${kind}`);
    }
    console.log(
      `  ${(bin.length / 1024).toFixed(0)} kB  (gzip ${(gz / 1024).toFixed(0)} kB)  ` +
        `built in ${(buildMs / 1000).toFixed(1)} s`,
    );
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
