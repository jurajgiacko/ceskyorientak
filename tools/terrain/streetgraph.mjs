#!/usr/bin/env node
/**
 * The street graph — the network a sprint is actually run on, derived from the
 * town model and shipped as data.
 *
 * PLAN-KRUMLOV-V2 §3: *"A sprint is run on a network. Build it explicitly —
 * nodes at junctions and gateways, edges along runnable ways, with the barrier
 * crossings that are legal."* This is phase 3's artefact, and the three things
 * §3 promises fall out of it by construction rather than by gate:
 *
 *  - **Controls are sited on the graph**, so a control cannot be behind a wall
 *    or in a garden.
 *  - **Legs are routed on the graph while the course is being set**, so the
 *    detour ratio is known at generation time. `src/sim/courseGen.ts` samples
 *    the straight line and literally cannot see a river (D-037), which is how
 *    leg 1→2 came to run 12.3×.
 *  - **The start's run-out is checked**, which is fault 8 — *"you run out and
 *    there's a wall straight away"* — and is trivial on a graph.
 *
 * ---------------------------------------------------------------------------
 * Whose network it is: OSM says where to look, the model says what is there
 * ---------------------------------------------------------------------------
 *
 * The centrelines come from OSM's `highway` ways, carried through
 * `townscape.json` — the same set `deriveRaster` paves and `urbanFeatures`
 * measures distance to. They are a *hypothesis about where a street is*, not an
 * authority: 3.3 % of the network's metres inside the playable square run
 * through something the model calls solid. Some of that is a centreline drawn a
 * metre off the alley it names; some of it is real, and the honest example is
 * `tunnel=building_passage` — OSM maps an arch under a building as a way, the
 * model has the building as one sealed footprint, and D-039 measured the block
 * interiors behind those arches as genuinely sealed pockets.
 *
 * So every metre of this graph is checked against the model's own `blockedAt`
 * and the graph keeps only what survives:
 *
 *  - a sample the model blocks is nudged perpendicular, up to the way's own
 *    half-width — a centreline is nominal and a street has width, so a
 *    correction inside the carriageway is a better centreline rather than a
 *    fudge;
 *  - a span that cannot be rescued **splits the edge**, and both new ends are
 *    dead ends. That is what the athlete meets, and a graph that says otherwise
 *    would be the fourth second opinion this venue has paid for.
 *
 * The result is an assertion the gate can make without a tolerance: **every
 * edge of the shipped graph is walkable, swept at `SWEEP_M`, against the
 * shipped model.** Not sampled — every edge, every 0.2 m.
 *
 * ---------------------------------------------------------------------------
 * Noding, and the one thing that could go silently wrong
 * ---------------------------------------------------------------------------
 *
 * Two OSM ways meet at a shared node, so junctions are found by *coincident
 * vertices* rather than by geometric intersection — which is also why a bridge
 * over a road does not become a junction, correctly, without a `layer` tag
 * being consulted.
 *
 * The risk is upstream: `townscape.mjs` runs `simplifyLine(line, 1.2)` over
 * every way, which drops an interior vertex within 1.2 m of the one before it.
 * A junction vertex can be dropped that way, and a severed junction is invisible
 * — the graph simply routes the long way round and every detour measured on it
 * is wrong in the safe-looking direction. So noding carries `SNAP_M`, and a node
 * that falls within `SNAP_M` of another way's *interior segment* splits that
 * segment. The census below prints what that recovered; on Krumlov it is not a
 * rounding error.
 *
 * Usage: node tools/terrain/streetgraph.mjs [--venue=krumlov] [--quiet]
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
 * How finely a step is swept along its path, metres.
 *
 * `SWEEP_M` in src/sim/race.ts and in tools/terrain/passable.mjs, and it must
 * stay equal to both: an edge of this graph is a claim that the athlete can run
 * along it, and the athlete's own step test is what that claim means.
 */
const SWEEP_M = 0.2;

/**
 * How far apart two things may be and still be the same junction, metres.
 *
 * 1.3 m, which is `simplifyLine`'s own 1.2 m tolerance plus a centimetre of
 * float. Below that the two are the same OSM node with one of them decimated;
 * above it, merging would join two genuinely different corners of a Krumlov
 * courtyard.
 */
const SNAP_M = 1.3;

/**
 * How finely an edge is tested for blockage while it is being corrected, metres.
 *
 * `SWEEP_M`, and it has to be: the correction pass and the assertion pass must
 * ask the model at the same spacing or the second one finds what the first one
 * stepped over. Measured at 0.5 m first, and 147 of 2208 edges came back
 * blocked from a derivation that thought it had corrected them.
 */
const PROBE_M = SWEEP_M;

/**
 * How far a blocked centreline sample may be nudged perpendicular, metres.
 *
 * Half the way's own width, and never more: a correction inside the carriageway
 * is a better estimate of where the street is, and one outside it is an
 * invention. Floored so that a 1.5 m path is still allowed the 0.75 m that its
 * own width implies.
 */
const NUDGE_CAP_M = (widthM) => Math.max(0.6, widthM * 0.5);

/**
 * How far a junction may be walked to find open ground, metres.
 *
 * A junction is an OSM node and OSM's idea of where two alleys meet can be a
 * metre inside the corner house. Wider than `NUDGE_CAP_M` because a node is
 * shared by every way that meets there and has no single width of its own; 2 m
 * is one Krumlov alley's half-width and the point beyond which "the junction is
 * over there" stops being true.
 */
const NODE_RESCUE_M = 2;

/** Shortest edge worth keeping after splitting, metres. */
const MIN_EDGE_M = 1.5;

/**
 * Douglas–Peucker tolerance for the shipped geometry, metres — the *starting*
 * one. See `addEdge`: it is halved until the simplified line still sweeps
 * clear, so this is how much saving is attempted rather than how much error is
 * accepted. 0.25 m against a fixed 0.12 m is 6 968 vertices instead of 12 623,
 * and the same zero blocked edges.
 */
const SIMPLIFY_M = 0.25;

/**
 * Kind codes. 0 Road (ISSprOM 501 paved), 1 Path (505/506), 2 Steps (532).
 *
 * The same `k` `townscape.json` carries, plus steps split out of it: a stairway
 * is a run-out constraint and a control site in its own right (§4), and it is
 * the one part of the network where the graph's length is not the athlete's
 * time.
 */
const KIND_ROAD = 0;
const KIND_PATH = 1;
const KIND_STEPS = 2;
/**
 * 3 — open ground. A straight line between two junctions that the model says is
 * clear and the street network makes you go round. See `addChords`.
 *
 * **A control may not be sited on one and a leg may be routed over one.** That
 * distinction is the whole reason the kind exists: the network you may *site*
 * on is the street, and the ground you may *run* over is anything the model
 * lets you stand on. Conflating them either puts controls in the middle of a
 * meadow or makes every leg across Náměstí Svornosti read as a detour round it.
 */
const KIND_OPEN = 3;

// ---------------------------------------------------------------------------
// Small geometry
// ---------------------------------------------------------------------------

function polylineLength(pts) {
  let l = 0;
  for (let i = 0; i + 3 < pts.length; i += 2) {
    l += Math.hypot(pts[i + 2] - pts[i], pts[i + 3] - pts[i + 1]);
  }
  return l;
}

/** Douglas–Peucker over a flat [x, z, ...] array. */
function simplify(pts, tol) {
  const n = pts.length / 2;
  if (n < 3) return pts.slice();
  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[n - 1] = 1;
  const stack = [[0, n - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    if (b - a < 2) continue;
    const ax = pts[a * 2];
    const az = pts[a * 2 + 1];
    const bx = pts[b * 2];
    const bz = pts[b * 2 + 1];
    const dx = bx - ax;
    const dz = bz - az;
    const len2 = dx * dx + dz * dz;
    let worst = -1;
    let worstI = -1;
    for (let i = a + 1; i < b; i++) {
      const px = pts[i * 2];
      const pz = pts[i * 2 + 1];
      let t = len2 > 1e-9 ? ((px - ax) * dx + (pz - az) * dz) / len2 : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const d = Math.hypot(ax + dx * t - px, az + dz * t - pz);
      if (d > worst) {
        worst = d;
        worstI = i;
      }
    }
    if (worst > tol) {
      keep[worstI] = 1;
      stack.push([a, worstI], [worstI, b]);
    }
  }
  const out = [];
  for (let i = 0; i < n; i++) {
    if (keep[i]) out.push(pts[i * 2], pts[i * 2 + 1]);
  }
  return out;
}

/** Perpendicular distance from p to segment a–b, and the parameter along it. */
function segClosest(ax, az, bx, bz, x, z) {
  const dx = bx - ax;
  const dz = bz - az;
  const len2 = dx * dx + dz * dz;
  let t = len2 > 1e-9 ? ((x - ax) * dx + (z - az) * dz) / len2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const cx = ax + dx * t;
  const cz = az + dz * t;
  return { t, x: cx, z: cz, d: Math.hypot(cx - x, cz - z) };
}

/** Is every point of this polyline open, swept at `SWEEP_M`? */
function clearChain(col, pts, sweepM = SWEEP_M) {
  for (let k = 0; k + 3 < pts.length; k += 2) {
    const ax = pts[k];
    const az = pts[k + 1];
    const bx = pts[k + 2];
    const bz = pts[k + 3];
    const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / sweepM));
    for (let s = 0; s <= n; s++) {
      const t = s / n;
      if (col.blockedAt(ax + (bx - ax) * t, az + (bz - az) * t)) return false;
    }
  }
  return true;
}

/** Centimetres, at the precision the file is packed in. See townmodel.mjs. */
function round2(v) {
  return Math.fround(Math.round(v * 100) / 100);
}

/** A uniform bucket grid for point and segment lookup. */
class Buckets {
  constructor(cellM) {
    this.cellM = cellM;
    this.cells = new Map();
  }

  key(cx, cz) {
    return cx * 100003 + cz;
  }

  add(idx, minX, minZ, maxX, maxZ) {
    const c = this.cellM;
    for (let cz = Math.floor(minZ / c); cz <= Math.floor(maxZ / c); cz++) {
      for (let cx = Math.floor(minX / c); cx <= Math.floor(maxX / c); cx++) {
        const k = this.key(cx, cz);
        let list = this.cells.get(k);
        if (!list) {
          list = [];
          this.cells.set(k, list);
        }
        list.push(idx);
      }
    }
  }

  near(x, z, r) {
    const c = this.cellM;
    const out = [];
    for (let cz = Math.floor((z - r) / c); cz <= Math.floor((z + r) / c); cz++) {
      for (let cx = Math.floor((x - r) / c); cx <= Math.floor((x + r) / c); cx++) {
        const list = this.cells.get(this.key(cx, cz));
        if (list) out.push(...list);
      }
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// Open ground — the chords the street network does not have
// ---------------------------------------------------------------------------

/** How far apart two junctions may be and still be worth a chord, metres. */
const CHORD_MAX_M = 110;

/**
 * How much longer the network's own way round has to be before a chord is
 * added.
 *
 * 1.15. Small deliberately: this is not a shortcut allowance, it is the
 * threshold at which "the street network is not how you would run this" becomes
 * true, and 15 % of eighty metres is twelve — about two seconds, and about the
 * width of the square the chord crosses.
 */
const CHORD_GAIN = 1.1;

/** How many chords one junction may sprout. Bounds the file, not the truth. */
const CHORD_PER_NODE = 8;

/**
 * Add the straight lines across open ground that the street network omits.
 *
 * **Why this is not optional.** OSM maps Náměstí Svornosti as a `pedestrian`
 * *area*, so `townscape.json` carries it as a 7 m way round its perimeter and
 * the graph inherits a square you can only run round. The arena anchor sits
 * 11.6 m from the nearest edge of it. Measured over 95 candidate legs of sprint
 * length, the perimeter-only graph put the median routed distance at **1.21×
 * what the athlete's own 0.5 m space says**, p90 2.36 — and **18 of 95 legs
 * came out over 3.0× on the graph while the athlete runs them under 3.0×**. A
 * course setter refusing one leg in five for a reason that is not true is the
 * fault D-037 recorded when it tried the same thing with a straight-line probe.
 *
 * So: any two junctions with a clear swept line between them, where the network
 * makes you go at least `CHORD_GAIN` further round, are joined. The chord is
 * validated exactly as every other edge is — `clearChain` against the model at
 * `SWEEP_M` — and marked `KIND_OPEN`, which is what keeps a control off it.
 *
 * Greedy and re-measured after every insertion, because the first chord across
 * a square makes most of the others redundant: the same square costs six chords
 * measured against the original graph and two measured against the graph as it
 * is being built.
 */
function addChords(col, nodes, edges, stats) {
  const grid = new Buckets(CHORD_MAX_M / 2);
  const live = [];
  for (let i = 0; i < nodes.length; i++) {
    if (!nodes[i].edges.length) continue;
    grid.add(i, nodes[i].x, nodes[i].z, nodes[i].x, nodes[i].z);
    live.push(i);
  }

  /** Bounded Dijkstra from `src`, cutoff in metres. Node → metres. */
  const near = (src, cutoff) => {
    const out = new Map([[src, 0]]);
    const heap = [[0, src]];
    while (heap.length) {
      heap.sort((a, b) => a[0] - b[0]);
      const [c, k] = heap.shift();
      if (c > (out.get(k) ?? Infinity)) continue;
      if (c > cutoff) break;
      for (const ei of nodes[k].edges) {
        const e = edges[ei];
        const o = e.a === k ? e.b : e.a;
        const nc = c + e.lengthM;
        if (nc <= cutoff && nc < (out.get(o) ?? Infinity)) {
          out.set(o, nc);
          heap.push([nc, o]);
        }
      }
    }
    return out;
  };

  let added = 0;
  for (const a of live) {
    const na = nodes[a];
    const cands = [];
    for (const b of grid.near(na.x, na.z, CHORD_MAX_M)) {
      if (b <= a) continue;
      const d = Math.hypot(nodes[b].x - na.x, nodes[b].z - na.z);
      if (d < 3 || d > CHORD_MAX_M) continue;
      cands.push([d, b]);
    }
    if (!cands.length) continue;
    cands.sort((p, q) => p[0] - q[0]);
    let mine = 0;
    let dist = near(a, CHORD_MAX_M * CHORD_GAIN);
    for (const [d, b] of cands) {
      if (mine >= CHORD_PER_NODE) break;
      const have = dist.get(b) ?? Infinity;
      if (have <= d * CHORD_GAIN) continue;
      const line = [na.x, na.z, nodes[b].x, nodes[b].z];
      if (!clearChain(col, line)) continue;
      const ei = edges.length;
      edges.push({ a, b, pts: line, width: 2, kind: KIND_OPEN, lengthM: d });
      nodes[a].edges.push(ei);
      nodes[b].edges.push(ei);
      added++;
      mine++;
      dist = near(a, CHORD_MAX_M * CHORD_GAIN);
    }
  }
  stats.chords = added;
}

// ---------------------------------------------------------------------------
// The graph
// ---------------------------------------------------------------------------

/**
 * Build the street graph.
 *
 * `col.blockedAt` is the model's own collision — the same function the athlete
 * meets — and it is the only authority here. `ways` is the OSM hypothesis:
 * `{ pts: [x, z, ...], width, kind }`.
 */
export function buildGraph(col, ways, { playableR, arena }) {
  const stats = {
    waysIn: ways.length,
    lengthInM: 0,
    nudged: 0,
    nudgedM: 0,
    blockedSamples: 0,
    splitEdges: 0,
    droppedM: 0,
    recoveredJunctions: 0,
    blockedNodes: 0,
    nodesRescued: 0,
    simplifyReverted: 0,
  };

  // --- 1. clip to the square the model is authoritative over ----------------
  //
  // Outside it the class raster is still what decides bounds (D-038), and a
  // graph whose edges are validated against two different authorities is the
  // second-opinion failure again. The network beyond the playable square is not
  // ground any course is set on.
  const clipped = [];
  for (const way of ways) {
    let run = [];
    const flush = () => {
      if (run.length >= 4) clipped.push({ pts: run, width: way.width, kind: way.kind });
      run = [];
    };
    for (let i = 0; i + 1 < way.pts.length; i += 2) {
      const x = way.pts[i];
      const z = way.pts[i + 1];
      if (Math.abs(x) <= playableR && Math.abs(z) <= playableR) run.push(x, z);
      else flush();
    }
    flush();
  }
  for (const w of clipped) stats.lengthInM += polylineLength(w.pts);

  // --- 2. node candidates ---------------------------------------------------
  //
  // A node is a way's endpoint or a vertex two ways share. Coincidence is
  // decided by the packed coordinate rather than by float equality, then
  // widened to `SNAP_M` below, because `simplifyLine` can have moved one copy
  // of a shared vertex and not the other.
  const useCount = new Map();
  const keyOf = (x, z) => `${round2(x)},${round2(z)}`;
  for (const w of clipped) {
    for (let i = 0; i + 1 < w.pts.length; i += 2) {
      const k = keyOf(w.pts[i], w.pts[i + 1]);
      useCount.set(k, (useCount.get(k) ?? 0) + 1);
    }
  }

  const nodes = [];
  const nodeGrid = new Buckets(8);
  /**
   * Find or make the node at (x, z), merging anything within `SNAP_M`.
   *
   * **Rounded to the precision the file is packed in, here rather than at
   * packing time.** D-038 recorded the same trap one layer down: the tool held
   * 123.45 and the runtime read 123.44999694824219, and 62 cells of the venue
   * disagreed. Here it is worse than a disagreement — validate a junction at
   * full precision, ship it at a centimetre, and the shipped one can be inside
   * the wall the validated one cleared. Measured before this line existed: **49
   * of 5806 edges and 31 of 1938 junctions**, all of them clear in the
   * derivation and blocked in the artefact.
   */
  const nodeAt = (rawX, rawZ) => {
    const x = round2(rawX);
    const z = round2(rawZ);
    let best = -1;
    let bestD = SNAP_M;
    for (const n of nodeGrid.near(x, z, SNAP_M)) {
      const d = Math.hypot(nodes[n].x - x, nodes[n].z - z);
      if (d < bestD) {
        bestD = d;
        best = n;
      }
    }
    if (best >= 0) return best;
    const id = nodes.length;
    nodes.push({ x, z, edges: [] });
    nodeGrid.add(id, x, z, x, z);
    return id;
  };

  // Endpoints first, so a junction's position is an endpoint's rather than a
  // decimated interior vertex's.
  for (const w of clipped) {
    nodeAt(w.pts[0], w.pts[1]);
    nodeAt(w.pts[w.pts.length - 2], w.pts[w.pts.length - 1]);
  }
  for (const w of clipped) {
    for (let i = 2; i + 3 < w.pts.length; i += 2) {
      if ((useCount.get(keyOf(w.pts[i], w.pts[i + 1])) ?? 0) > 1) {
        nodeAt(w.pts[i], w.pts[i + 1]);
      }
    }
  }

  // --- 2b. every node stands on open ground ---------------------------------
  //
  // A junction is an OSM node, and OSM's idea of where two alleys meet can be a
  // metre inside the corner house. A node that is inside something is a node the
  // athlete cannot stand on, so it is walked out to the nearest open ground
  // within `NODE_RESCUE_M` — and if there is none, it is left where it is and
  // marked, and the correction pass below turns its edges into dead ends
  // approaching it. Which is what the ground does.
  for (const n of nodes) {
    if (!col.blockedAt(n.x, n.z)) continue;
    stats.blockedNodes++;
    let moved = false;
    for (let d = 0.1; d <= NODE_RESCUE_M + 1e-9 && !moved; d += 0.1) {
      for (let a = 0; a < 16; a++) {
        const th = (a / 16) * Math.PI * 2;
        const x = round2(n.x + Math.sin(th) * d);
        const z = round2(n.z - Math.cos(th) * d);
        if (col.blockedAt(x, z)) continue;
        n.x = x;
        n.z = z;
        moved = true;
        stats.nodesRescued++;
        break;
      }
    }
    if (!moved) n.blocked = true;
  }

  // --- 3. split each way at every node that lies on it -----------------------
  //
  // Including nodes that are not vertices of this way at all: a T-junction
  // whose stem endpoint survived `simplifyLine` while the vertex on the through
  // street did not is a junction that exists on the ground and not in the data.
  // Counted, because it is the one silent failure mode of the whole derivation.
  const rawEdges = [];
  for (const w of clipped) {
    const pts = w.pts;
    /** Where the way is cut: [vertex index (float, fractional along segment), node id]. */
    const cuts = [];
    for (let i = 0; i + 3 < pts.length; i += 2) {
      const ax = pts[i];
      const az = pts[i + 1];
      const bx = pts[i + 2];
      const bz = pts[i + 3];
      const seg = i / 2;
      const minX = Math.min(ax, bx) - SNAP_M;
      const maxX = Math.max(ax, bx) + SNAP_M;
      const minZ = Math.min(az, bz) - SNAP_M;
      const maxZ = Math.max(az, bz) + SNAP_M;
      const cx = (minX + maxX) / 2;
      const cz = (minZ + maxZ) / 2;
      const r = Math.max(maxX - cx, maxZ - cz);
      for (const n of nodeGrid.near(cx, cz, r)) {
        const c = segClosest(ax, az, bx, bz, nodes[n].x, nodes[n].z);
        if (c.d > SNAP_M) continue;
        const at = seg + c.t;
        if (!cuts.some((q) => q.node === n && Math.abs(q.at - at) < 1e-6)) {
          cuts.push({ at, node: n, interior: c.t > 1e-6 && c.t < 1 - 1e-6 });
        }
      }
    }
    cuts.sort((a, b) => a.at - b.at);
    for (const c of cuts) if (c.interior) stats.recoveredJunctions++;
    if (!cuts.length) continue;

    /** The point at fractional vertex index `at`. */
    const pointAt = (at) => {
      const i = Math.min(pts.length / 2 - 2, Math.max(0, Math.floor(at)));
      const t = at - i;
      return [
        pts[i * 2] + (pts[i * 2 + 2] - pts[i * 2]) * t,
        pts[i * 2 + 1] + (pts[i * 2 + 3] - pts[i * 2 + 1]) * t,
      ];
    };

    for (let c = 0; c + 1 < cuts.length; c++) {
      const a = cuts[c];
      const b = cuts[c + 1];
      if (a.node === b.node) continue;
      const chain = [nodes[a.node].x, nodes[a.node].z];
      for (let v = Math.ceil(a.at + 1e-9); v <= Math.floor(b.at - 1e-9); v++) {
        chain.push(pts[v * 2], pts[v * 2 + 1]);
      }
      const end = pointAt(b.at);
      void end;
      chain.push(nodes[b.node].x, nodes[b.node].z);
      if (polylineLength(chain) < 1e-3) continue;
      rawEdges.push({ a: a.node, b: b.node, pts: chain, width: w.width, kind: w.kind });
    }
  }

  // --- 4. correct the geometry against the model ----------------------------
  //
  // The centreline is a hypothesis; `blockedAt` is the fact. Each edge is walked
  // at `PROBE_M`, a blocked sample is nudged perpendicular inside the way's own
  // half-width, and a sample that cannot be rescued ends the run — the edge
  // splits there and both sides get a dead end, because that is what the
  // athlete finds.
  const edges = [];
  /**
   * Simplification is a *saving*, never a claim.
   *
   * The corrected chain is a 0.2 m point cloud and a Douglas–Peucker chord
   * across a corner is not the same curve, so simplification can put the line
   * back into the wall the correction walked round. Every candidate is
   * therefore swept before it is accepted, and the tolerance halves until one
   * is — an edge that will not take 0.25 m usually takes 0.06, and only the
   * handful that take nothing ship the full chain. All-or-nothing at one
   * tolerance was measured and is strictly worse in both directions: a coarser
   * tolerance reverts more edges to the raw cloud and *grows* the file.
   */
  const addEdge = (aNode, bNode, chain, width, kind) => {
    let geom = null;
    for (let tol = SIMPLIFY_M; tol > 0.004; tol /= 2) {
      const g = simplify(chain, tol);
      if (clearChain(col, g)) {
        geom = g;
        break;
      }
      stats.simplifyReverted++;
    }
    if (!geom) geom = chain.slice();
    const lengthM = polylineLength(geom);
    if (lengthM < MIN_EDGE_M) return;
    edges.push({ a: aNode, b: bNode, pts: geom, width, kind, lengthM });
  };

  for (const e of rawEdges) {
    /**
     * The corrected samples of this edge, in order, split into open runs.
     *
     * A run carries whether it reaches the chain's own ends, which is not the
     * same as being the first or last run: an edge whose *only* break is at its
     * last metre has one run, and pulling that run's far end back onto node b
     * would draw it straight through the wall the break is. That mistake is
     * silent — the graph gains one edge through a building and every route that
     * uses it is short by however far round the athlete would really go.
     */
    const runs = [];
    let run = [];
    let runFromStart = true;

    const pts = e.pts;
    for (let i = 0; i + 3 < pts.length; i += 2) {
      const ax = pts[i];
      const az = pts[i + 1];
      const bx = pts[i + 2];
      const bz = pts[i + 3];
      const segLen = Math.hypot(bx - ax, bz - az);
      const n = Math.max(1, Math.ceil(segLen / PROBE_M));
      const ux = (bx - ax) / (segLen || 1);
      const uz = (bz - az) / (segLen || 1);
      const px = -uz;
      const pz = ux;
      const cap = NUDGE_CAP_M(e.width);
      for (let s = i === 0 ? 0 : 1; s <= n; s++) {
        const t = s / n;
        // Rounded to the shipped precision before it is validated — see
        // `nodeAt`. Every point this loop accepts is a point that will be in
        // the file, bit for bit.
        const x = round2(ax + (bx - ax) * t);
        const z = round2(az + (bz - az) * t);
        /**
         * A sample is accepted only if the athlete can get to it from the last
         * accepted one.
         *
         * Not pedantry: a nudge is up to half a carriageway sideways, so two
         * consecutive samples 0.2 m apart along the way can be a metre apart
         * across it, and the line between them can cross the very wall the
         * nudge was avoiding. Testing the *step* rather than the point is what
         * makes the finished chain walkable by construction instead of by a
         * second pass that finds forty-four edges it is not.
         */
        const reachable = (qx, qz) =>
          !col.blockedAt(qx, qz) &&
          (run.length < 2 || clearChain(col, [run[run.length - 2], run[run.length - 1], qx, qz]));
        if (reachable(x, z)) {
          run.push(x, z);
          continue;
        }
        stats.blockedSamples++;
        let fixed = null;
        for (let d = 0.1; d <= cap + 1e-9; d += 0.1) {
          const ux2 = round2(x + px * d);
          const uz2 = round2(z + pz * d);
          if (reachable(ux2, uz2)) {
            fixed = [ux2, uz2, d];
            break;
          }
          const dx2 = round2(x - px * d);
          const dz2 = round2(z - pz * d);
          if (reachable(dx2, dz2)) {
            fixed = [dx2, dz2, d];
            break;
          }
        }
        if (fixed) {
          stats.nudged++;
          stats.nudgedM += PROBE_M;
          run.push(fixed[0], fixed[1]);
        } else {
          if (run.length >= 4) runs.push({ pts: run, fromStart: runFromStart, toEnd: false });
          else if (run.length) stats.droppedM += PROBE_M;
          run = [];
          runFromStart = false;
          stats.droppedM += PROBE_M;
        }
      }
    }
    if (run.length >= 4) runs.push({ pts: run, fromStart: runFromStart, toEnd: true });

    if (!runs.length) {
      stats.droppedM += polylineLength(e.pts);
      continue;
    }
    if (runs.length > 1 || !runs[0].fromStart || !runs[0].toEnd) stats.splitEdges++;
    for (const r of runs) {
      const p = r.pts;
      // Pull the run back onto its junction where it genuinely reaches it, and
      // only where that junction is ground. A node the rescue above could not
      // move out of a wall keeps its edges as dead ends stopping short of it,
      // because that is what the athlete finds when they run down that alley.
      // …and only where the athlete can get from the junction to where the run
      // starts. A run whose first sample was nudged half a carriageway sideways
      // may not have a clear line back to the node it nominally leaves.
      const atA =
        r.fromStart &&
        !nodes[e.a].blocked &&
        clearChain(col, [nodes[e.a].x, nodes[e.a].z, p[2] ?? p[0], p[3] ?? p[1]]);
      const atB =
        r.toEnd &&
        !nodes[e.b].blocked &&
        clearChain(col, [
          nodes[e.b].x,
          nodes[e.b].z,
          p[p.length - 4] ?? p[p.length - 2],
          p[p.length - 3] ?? p[p.length - 1],
        ]);
      if (atA) {
        p[0] = nodes[e.a].x;
        p[1] = nodes[e.a].z;
      }
      if (atB) {
        p[p.length - 2] = nodes[e.b].x;
        p[p.length - 1] = nodes[e.b].z;
      }
      const aNode = atA ? e.a : nodeAt(p[0], p[1]);
      const bNode = atB ? e.b : nodeAt(p[p.length - 2], p[p.length - 1]);
      if (aNode === bNode) continue;
      addEdge(aNode, bNode, p, e.width, e.kind);
    }
  }

  // --- 5. drop duplicates, wire adjacency -----------------------------------
  const seen = new Map();
  const kept = [];
  for (const e of edges) {
    const k = e.a < e.b ? `${e.a}:${e.b}` : `${e.b}:${e.a}`;
    const prev = seen.get(k);
    if (prev !== undefined) {
      // Two ways between the same pair of junctions: keep the shorter, which is
      // the one the athlete would run. (A genuine loop — same node both ends —
      // is dropped by the a === b test above.)
      if (e.lengthM < kept[prev].lengthM) kept[prev] = e;
      continue;
    }
    seen.set(k, kept.length);
    kept.push(e);
  }
  for (const n of nodes) n.edges = [];
  for (let i = 0; i < kept.length; i++) {
    nodes[kept[i].a].edges.push(i);
    nodes[kept[i].b].edges.push(i);
  }

  // --- 5b. the ground between the streets -----------------------------------
  addChords(col, nodes, kept, stats);

  // --- 6. components --------------------------------------------------------
  const comp = new Int32Array(nodes.length).fill(-1);
  const compLength = [];
  for (let s = 0; s < nodes.length; s++) {
    if (comp[s] >= 0 || !nodes[s].edges.length) continue;
    const id = compLength.length;
    let len = 0;
    const stack = [s];
    comp[s] = id;
    while (stack.length) {
      const k = stack.pop();
      for (const ei of nodes[k].edges) {
        const e = kept[ei];
        if (e.a === k) len += e.lengthM;
        const o = e.a === k ? e.b : e.a;
        if (comp[o] < 0) {
          comp[o] = id;
          stack.push(o);
        }
      }
    }
    compLength.push(len);
  }

  // The arena's component: the one holding the node nearest the arena anchor.
  let arenaNode = -1;
  let bestD = Infinity;
  for (let i = 0; i < nodes.length; i++) {
    if (!nodes[i].edges.length) continue;
    const d = Math.hypot(nodes[i].x - arena.x, nodes[i].z - arena.z);
    if (d < bestD) {
      bestD = d;
      arenaNode = i;
    }
  }
  const mainComp = arenaNode >= 0 ? comp[arenaNode] : -1;

  const totalLength = kept.reduce((a, e) => a + e.lengthM, 0);
  const mainLength = compLength[mainComp] ?? 0;

  return {
    nodes,
    edges: kept,
    comp,
    components: compLength.length,
    compLength,
    mainComp,
    arenaNode,
    totalLengthM: totalLength,
    mainLengthM: mainLength,
    stats,
  };
}

/**
 * Every edge, swept at `SWEEP_M` against the model. **The assertion.**
 *
 * Not a sample: an edge of this graph is a claim that the athlete can run along
 * it, and every fault in PLAN-KRUMLOV-V2 §1 was small in area and total in
 * consequence. Returns the offending edges rather than a boolean.
 */
export function sweepGraph(col, graph, sweepM = SWEEP_M) {
  const bad = [];
  let samples = 0;
  for (let i = 0; i < graph.edges.length; i++) {
    const pts = graph.edges[i].pts;
    for (let k = 0; k + 3 < pts.length; k += 2) {
      const ax = pts[k];
      const az = pts[k + 1];
      const bx = pts[k + 2];
      const bz = pts[k + 3];
      const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / sweepM));
      for (let s = 0; s <= n; s++) {
        const t = s / n;
        const x = ax + (bx - ax) * t;
        const z = az + (bz - az) * t;
        samples++;
        if (col.blockedAt(x, z)) {
          bad.push({ edge: i, at: [Number(x.toFixed(2)), Number(z.toFixed(2))] });
          k = pts.length;
          break;
        }
      }
    }
  }
  return { bad, samples };
}

// ---------------------------------------------------------------------------
// Packing
// ---------------------------------------------------------------------------

class Pack {
  constructor() {
    this.parts = [];
    this.sections = {};
    this.bytes = 0;
  }

  add(name, type, values) {
    const arr = type === 'i32' ? Int32Array.from(values) : Float32Array.from(values);
    this.sections[name] = { type, offset: this.bytes, count: arr.length };
    this.parts.push(Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength));
    this.bytes += arr.byteLength;
    return arr;
  }

  buffer() {
    return Buffer.concat(this.parts);
  }
}

export function packGraph(graph) {
  const pack = new Pack();
  const nx = [];
  const nz = [];
  for (const n of graph.nodes) {
    nx.push(round2(n.x));
    nz.push(round2(n.z));
  }
  pack.add('nodeX', 'f32', nx);
  pack.add('nodeZ', 'f32', nz);
  pack.add('nodeComp', 'i32', Array.from(graph.comp));

  const ea = [];
  const eb = [];
  const ew = [];
  const ek = [];
  const el = [];
  const off = [0];
  const pts = [];
  for (const e of graph.edges) {
    ea.push(e.a);
    eb.push(e.b);
    ew.push(round2(e.width));
    ek.push(e.kind);
    el.push(round2(e.lengthM));
    for (const v of e.pts) pts.push(round2(v));
    off.push(pts.length / 2);
  }
  pack.add('edgeA', 'i32', ea);
  pack.add('edgeB', 'i32', eb);
  pack.add('edgeWidth', 'f32', ew);
  pack.add('edgeKind', 'i32', ek);
  pack.add('edgeLength', 'f32', el);
  pack.add('edgeOffset', 'i32', off);
  pack.add('edgePts', 'f32', pts);
  return { bin: pack.buffer(), sections: pack.sections };
}

/** Read the shipped graph back, in the shape `buildGraph` returns. */
export function readGraph(dataDir) {
  const header = JSON.parse(readFileSync(join(dataDir, 'streets.json'), 'utf8'));
  const buf = readFileSync(join(dataDir, 'streets.bin'));
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length);
  const arr = (name) => {
    const s = header.sections[name];
    if (!s) return [];
    return s.type === 'i32'
      ? new Int32Array(ab, s.offset, s.count)
      : new Float32Array(ab, s.offset, s.count);
  };
  const nx = arr('nodeX');
  const nz = arr('nodeZ');
  const comp = arr('nodeComp');
  const ea = arr('edgeA');
  const eb = arr('edgeB');
  const ew = arr('edgeWidth');
  const ek = arr('edgeKind');
  const el = arr('edgeLength');
  const off = arr('edgeOffset');
  const pts = arr('edgePts');

  const nodes = [];
  for (let i = 0; i < nx.length; i++) nodes.push({ x: nx[i], z: nz[i], edges: [] });
  const edges = [];
  for (let i = 0; i < ea.length; i++) {
    edges.push({
      a: ea[i],
      b: eb[i],
      width: ew[i],
      kind: ek[i],
      lengthM: el[i],
      pts: Array.from(pts.subarray(off[i] * 2, off[i + 1] * 2)),
    });
    nodes[ea[i]].edges.push(i);
    nodes[eb[i]].edges.push(i);
  }
  return { header, graph: { nodes, edges, comp, mainComp: header.mainComp } };
}

// ---------------------------------------------------------------------------
// Routing, offline — the same answer `src/world/streetGraph.ts` gives
// ---------------------------------------------------------------------------

/**
 * A router over a built graph.
 *
 * `snap(p)` puts a world point on the network: the nearest point of the nearest
 * edge, with the distance to it and the walking distances to that edge's two
 * end nodes. `fieldFrom(p)` is one Dijkstra from a snapped point, and the
 * closure it returns answers **metres along the network** to any other point.
 *
 * One field per leg rather than one per candidate is what makes routing
 * affordable inside `pickNextControl`, which weighs ninety candidates a leg.
 */
export function makeRouter(graph, { maxSnapM = 25 } = {}) {
  const grid = new Buckets(16);
  const segs = [];
  for (let ei = 0; ei < graph.edges.length; ei++) {
    const e = graph.edges[ei];
    let acc = 0;
    for (let k = 0; k + 3 < e.pts.length; k += 2) {
      const ax = e.pts[k];
      const az = e.pts[k + 1];
      const bx = e.pts[k + 2];
      const bz = e.pts[k + 3];
      const len = Math.hypot(bx - ax, bz - az);
      grid.add(
        segs.length,
        Math.min(ax, bx),
        Math.min(az, bz),
        Math.max(ax, bx),
        Math.max(az, bz),
      );
      segs.push({ edge: ei, ax, az, bx, bz, len, from: acc });
      acc += len;
    }
  }

  const snap = (p, maxM = maxSnapM) => {
    let best = null;
    for (let r = 8; r <= maxM * 2; r *= 2) {
      for (const si of grid.near(p.x, p.z, Math.min(r, maxM))) {
        const s = segs[si];
        const c = segClosest(s.ax, s.az, s.bx, s.bz, p.x, p.z);
        if (best && c.d >= best.d) continue;
        const along = s.from + s.len * c.t;
        const e = graph.edges[s.edge];
        best = {
          d: c.d,
          x: c.x,
          z: c.z,
          edge: s.edge,
          a: e.a,
          b: e.b,
          toA: along,
          toB: Math.max(0, e.lengthM - along),
        };
      }
      if (best && best.d <= r) break;
    }
    return best && best.d <= maxM ? best : null;
  };

  const n = graph.nodes.length;
  const dist = new Float64Array(n);

  const fieldFrom = (p) => {
    const s = snap(p);
    if (!s) return null;
    dist.fill(Infinity);
    /** Binary heap of [cost, node]. */
    const hc = [];
    const hk = [];
    const push = (c, k) => {
      let i = hc.length;
      hc.push(c);
      hk.push(k);
      while (i > 0) {
        const par = (i - 1) >> 1;
        if (hc[par] <= hc[i]) break;
        [hc[par], hc[i]] = [hc[i], hc[par]];
        [hk[par], hk[i]] = [hk[i], hk[par]];
        i = par;
      }
    };
    const pop = () => {
      const c = hc[0];
      const k = hk[0];
      const lc = hc.pop();
      const lk = hk.pop();
      if (hc.length) {
        hc[0] = lc;
        hk[0] = lk;
        let i = 0;
        for (;;) {
          const l = i * 2 + 1;
          const r = l + 1;
          let m = i;
          if (l < hc.length && hc[l] < hc[m]) m = l;
          if (r < hc.length && hc[r] < hc[m]) m = r;
          if (m === i) break;
          [hc[m], hc[i]] = [hc[i], hc[m]];
          [hk[m], hk[i]] = [hk[i], hk[m]];
          i = m;
        }
      }
      return [c, k];
    };
    dist[s.a] = s.toA;
    dist[s.b] = s.toB;
    push(s.toA, s.a);
    push(s.toB, s.b);
    while (hc.length) {
      const [c, k] = pop();
      if (c > dist[k]) continue;
      for (const ei of graph.nodes[k].edges) {
        const e = graph.edges[ei];
        const o = e.a === k ? e.b : e.a;
        const nc = c + e.lengthM;
        if (nc < dist[o]) {
          dist[o] = nc;
          push(nc, o);
        }
      }
    }
    const from = dist.slice();
    /** Metres along the network from `p` to `q`, or Infinity. */
    const to = (q) => {
      const t = snap(q);
      if (!t) return Infinity;
      // Either end of the target edge, plus the walk along it. Both ends,
      // because the shorter node is not always the shorter route.
      const viaA = from[t.a] + t.toA;
      const viaB = from[t.b] + t.toB;
      let best = Math.min(viaA, viaB);
      // Same edge as the origin: the route may not have to leave it at all.
      if (t.edge === s.edge) best = Math.min(best, Math.abs(t.toA - s.toA));
      return best + t.d + s.d;
    };
    to.origin = s;
    to.nodeDist = from;
    return to;
  };

  return { snap, fieldFrom, segs };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/** The OSM ways `townscape.json` carries, in this file's own vocabulary. */
export function waysOf(town) {
  const out = [];
  for (const w of town.paved ?? []) {
    if (!w.l || w.l.length < 4) continue;
    out.push({ pts: w.l, width: w.w ?? 2.2, kind: w.k === 1 ? KIND_PATH : KIND_ROAD });
  }
  // Steps come through `paved` as well — `townscape.mjs` pushes them to both —
  // so they are matched by geometry rather than added twice.
  const stepKeys = new Set();
  for (const s of town.steps ?? []) {
    if (!s.p || s.p.length < 4) continue;
    stepKeys.add(`${round2(s.p[0])},${round2(s.p[1])}`);
  }
  for (const w of out) {
    if (stepKeys.has(`${round2(w.pts[0])},${round2(w.pts[1])}`)) w.kind = KIND_STEPS;
  }
  return out;
}

function main() {
  const args = process.argv.slice(2);
  const arg = (name, dflt) => {
    const a = args.find((v) => v.startsWith(`--${name}=`));
    return a ? a.slice(name.length + 3) : dflt;
  };
  const venueId = arg('venue', 'krumlov');
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
  const { header: modelHeader, model } = readModel(dataDir);
  const col = colliders(model);
  const town = JSON.parse(readFileSync(join(dataDir, 'townscape.json'), 'utf8'));
  const graph = buildGraph(col, waysOf(town), {
    playableR: modelHeader.playableR,
    arena: cfg.arena,
  });
  const swept = sweepGraph(col, graph);
  const buildMs = Date.now() - t0;

  const { bin, sections } = packGraph(graph);
  const kindLen = [0, 0, 0, 0];
  for (const e of graph.edges) kindLen[e.kind] += e.lengthM;
  const degrees = graph.nodes.map((n) => n.edges.length);
  const junctions = degrees.filter((d) => d >= 3).length;
  const deadEnds = degrees.filter((d) => d === 1).length;

  const meta = {
    venue: venueId,
    generatedAt: new Date().toISOString(),
    from: 'townmodel.bin + townscape.json',
    /** The model this graph was derived from, by its own byte count. See passable.json. */
    modelBytes: modelHeader.bytes,
    playableR: modelHeader.playableR,
    arena: cfg.arena,
    sweepM: SWEEP_M,
    snapM: SNAP_M,
    nodes: graph.nodes.length,
    edges: graph.edges.length,
    vertices: sections.edgePts.count / 2,
    junctions,
    deadEnds,
    lengthM: Math.round(graph.totalLengthM),
    lengthByKind: {
      road: Math.round(kindLen[0]),
      path: Math.round(kindLen[1]),
      steps: Math.round(kindLen[2]),
      open: Math.round(kindLen[3]),
    },
    /** Edges a control may be sited on: the street network, not the open ground. */
    sitableLengthM: Math.round(kindLen[0] + kindLen[1] + kindLen[2]),
    components: graph.components,
    mainComp: graph.mainComp,
    mainLengthM: Math.round(graph.mainLengthM),
    mainFraction: Number((graph.mainLengthM / Math.max(1, graph.totalLengthM)).toFixed(5)),
    arenaNode: graph.arenaNode,
    derivation: {
      osmLengthM: Math.round(graph.stats.lengthInM),
      blockedSamples: graph.stats.blockedSamples,
      nudged: graph.stats.nudged,
      nudgedM: Math.round(graph.stats.nudgedM),
      splitEdges: graph.stats.splitEdges,
      droppedM: Math.round(graph.stats.droppedM),
      /** Junctions `simplifyLine` had decimated and the snap put back. */
      recoveredJunctions: graph.stats.recoveredJunctions,
      blockedNodes: graph.stats.blockedNodes,
      nodesRescued: graph.stats.nodesRescued,
      /** Straight lines across open ground the street network omits. `addChords`. */
      chords: graph.stats.chords,
    },
    /** Every edge, swept at `SWEEP_M` against the model. Must be zero. */
    blockedEdges: swept.bad.length,
    sweptSamples: swept.samples,
    sections,
    bytes: bin.length,
    buildMs,
  };

  writeFileSync(join(dataDir, 'streets.bin'), bin);
  writeFileSync(join(dataDir, 'streets.json'), `${JSON.stringify(meta, null, 2)}\n`);

  if (!args.includes('--quiet')) {
    const gz = gzipSync(bin).length;
    console.log(`✓ ${join(cfg.data, 'streets.bin')}`);
    console.log(
      `  ${meta.nodes} nodes (${junctions} junctions, ${deadEnds} dead ends) · ` +
        `${meta.edges} edges · ${meta.vertices} vertices · ` +
        `${(meta.lengthM / 1000).toFixed(2)} km of network`,
    );
    console.log(
      `  ${(meta.lengthByKind.road / 1000).toFixed(2)} km road · ` +
        `${(meta.lengthByKind.path / 1000).toFixed(2)} km path · ` +
        `${meta.lengthByKind.steps} m steps · ` +
        `${(meta.lengthByKind.open / 1000).toFixed(2)} km open ground ` +
        `(${meta.derivation.chords} chords, routable and not sitable)`,
    );
    console.log(
      `  ${meta.components} components; the arena's holds ` +
        `${(meta.mainFraction * 100).toFixed(1)} % of the length`,
    );
    console.log(
      `  from ${(meta.derivation.osmLengthM / 1000).toFixed(2)} km of OSM centreline: ` +
        `${graph.stats.blockedSamples} blocked samples, ${graph.stats.nudged} nudged inside the ` +
        `carriageway, ${graph.stats.splitEdges} edges split, ` +
        `${meta.derivation.droppedM} m dropped as unwalkable`,
    );
    console.log(
      `  ${meta.derivation.recoveredJunctions} junctions recovered that simplification had decimated`,
    );
    console.log(
      `  swept at ${SWEEP_M} m against the model: ${swept.bad.length} blocked edge(s) of ` +
        `${graph.edges.length} over ${swept.samples} samples`,
    );
    console.log(
      `  ${(bin.length / 1024).toFixed(0)} kB  (gzip ${(gz / 1024).toFixed(0)} kB)  ` +
        `built in ${(buildMs / 1000).toFixed(1)} s`,
    );
  }
  if (swept.bad.length) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
