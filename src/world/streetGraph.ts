/**
 * The street graph, as shipped.
 *
 * PLAN-KRUMLOV-V2 §3: *"A sprint is run on a network. Build it explicitly."*
 * `tools/terrain/streetgraph.mjs` derives it from the town model and asserts
 * every edge walkable against the model's own collision; this reads the answer
 * and routes on it.
 *
 * ---------------------------------------------------------------------------
 * What it is for, in one sentence each
 * ---------------------------------------------------------------------------
 *
 *  - **Siting.** `nearestSitable` says how far a point is from a way a control
 *    may hang on. Not a raster distance and not a proxy: the edge is a line the
 *    athlete can run along, checked continuously.
 *  - **Routing at generation time.** `fieldFrom` is one Dijkstra over ~1 900
 *    junctions — a quarter of a millisecond — and the closure it returns
 *    answers *metres along the network* for any point. That is what lets
 *    `pickNextControl` weigh ninety candidates a leg against a detour ratio it
 *    can actually see, instead of a straight line that cannot see a river
 *    (D-037).
 *  - **The run-out.** Fault 8 is a start with a wall in front of it. On a graph
 *    the start's own junction has a degree and its edges have bearings.
 *
 * ---------------------------------------------------------------------------
 * The one property that makes the detour limit structural
 * ---------------------------------------------------------------------------
 *
 * **A route on this graph is never shorter than the way the athlete would
 * actually run** — it is confined to a network drawn inside the open space,
 * while the athlete may cut any line the model allows. So a leg the generator
 * accepts at ≤ 3.0× on the graph is a leg that is ≤ 3.0× on the ground, and
 * D-037's limit stops being something a later audit discovers and becomes
 * something the setter could not have violated.
 *
 * The converse is where it costs: the graph can call a leg worse than it is,
 * and the generator will pass over a candidate that was fine. `addChords` in
 * the build is what keeps that loss small — the straight lines across open
 * ground the street network omits, without which Náměstí Svornosti is a square
 * you may only run round.
 */

import type { TownModel } from './townModel';

interface Section {
  type: 'i32' | 'f32';
  offset: number;
  count: number;
}

export interface StreetGraphMeta {
  venue: string;
  modelBytes: number;
  playableR: number;
  arena: { x: number; z: number };
  nodes: number;
  edges: number;
  lengthM: number;
  sitableLengthM: number;
  mainComp: number;
  mainFraction: number;
  arenaNode: number;
  sections: Record<string, Section>;
}

export interface StreetGraphData {
  meta: StreetGraphMeta;
  buffer: ArrayBuffer;
}

/** Edge kinds. 3 — open ground — is routable and never sitable. */
export const STREET_ROAD = 0;
export const STREET_PATH = 1;
export const STREET_STEPS = 2;
export const STREET_OPEN = 3;

/**
 * Fetch the venue's street graph.
 *
 * No tier parameter, for `loadPassable`'s reason: a tier decides how the venue
 * is drawn, never what the rules are (D-027).
 */
export async function loadStreets(venue: string): Promise<StreetGraphData> {
  const base = `/data/${venue}/streets`;
  const [metaRes, binRes] = await Promise.all([fetch(`${base}.json`), fetch(`${base}.bin`)]);
  if (!metaRes.ok) throw new Error(`${base}.json: HTTP ${metaRes.status}`);
  if (!binRes.ok) throw new Error(`${base}.bin: HTTP ${binRes.status}`);
  const meta = (await metaRes.json()) as StreetGraphMeta;
  const buffer = await binRes.arrayBuffer();
  if (!meta.sections?.edgePts) {
    throw new Error(`${base}.json: no street graph — run tools/terrain/streetgraph.mjs`);
  }
  return { meta, buffer };
}

/** Where a world point sits on the network. */
export interface StreetSnap {
  /** Metres from the queried point to the network. */
  d: number;
  x: number;
  z: number;
  edge: number;
  kind: number;
  a: number;
  b: number;
  /** Metres along the edge to node `a` and node `b`. */
  toA: number;
  toB: number;
}

/**
 * Distances from one point over the network.
 *
 * `to(q)` is metres from the origin to `q` along the network, including the
 * walk off the network at both ends. `Infinity` when either end cannot be
 * snapped or the two are in different components.
 */
export interface StreetField {
  to(q: { x: number; z: number }): number;
  readonly origin: StreetSnap;
}

/** How far off the network a point may be and still be snapped, metres. */
const MAX_SNAP_M = 30;

export class StreetGraph {
  readonly meta: StreetGraphMeta;
  readonly warnings: string[] = [];
  readonly nodeX: Float32Array;
  readonly nodeZ: Float32Array;
  readonly nodeComp: Int32Array;
  readonly edgeA: Int32Array;
  readonly edgeB: Int32Array;
  readonly edgeKind: Int32Array;
  readonly edgeLength: Float32Array;
  readonly edgeOffset: Int32Array;
  readonly edgePts: Float32Array;

  /** CSR adjacency: `adjStart[n] .. adjStart[n + 1]` index into `adjEdge`. */
  private readonly adjStart: Int32Array;
  private readonly adjEdge: Int32Array;

  /** Segment broadphase. `segEdge`/`segAt` describe one polyline segment each. */
  private readonly segEdge: Int32Array;
  private readonly segFrom: Float32Array;
  private readonly segPt: Float32Array;
  private readonly cellM = 16;
  private readonly buckets = new Map<number, number[]>();

  /** Scratch for `fieldFrom`, so a per-leg field is not a per-leg allocation. */
  private readonly dist: Float64Array;
  private readonly heapC: Float64Array;
  private readonly heapK: Int32Array;
  private heapN = 0;

  constructor(data: StreetGraphData) {
    const m = data.meta;
    this.meta = m;
    const arr = (name: string): Float32Array | Int32Array => {
      const s = m.sections[name];
      if (!s) return new Int32Array(0);
      return s.type === 'i32'
        ? new Int32Array(data.buffer, s.offset, s.count)
        : new Float32Array(data.buffer, s.offset, s.count);
    };
    this.nodeX = arr('nodeX') as Float32Array;
    this.nodeZ = arr('nodeZ') as Float32Array;
    this.nodeComp = arr('nodeComp') as Int32Array;
    this.edgeA = arr('edgeA') as Int32Array;
    this.edgeB = arr('edgeB') as Int32Array;
    this.edgeKind = arr('edgeKind') as Int32Array;
    this.edgeLength = arr('edgeLength') as Float32Array;
    this.edgeOffset = arr('edgeOffset') as Int32Array;
    this.edgePts = arr('edgePts') as Float32Array;

    const n = this.nodeX.length;
    const e = this.edgeA.length;
    const deg = new Int32Array(n + 1);
    for (let i = 0; i < e; i++) {
      const a = (this.edgeA[i] as number) + 1;
      const b = (this.edgeB[i] as number) + 1;
      deg[a] = (deg[a] as number) + 1;
      deg[b] = (deg[b] as number) + 1;
    }
    for (let i = 0; i < n; i++) deg[i + 1] = (deg[i + 1] as number) + (deg[i] as number);
    this.adjStart = deg;
    this.adjEdge = new Int32Array(e * 2);
    const cursor = Int32Array.from(deg.subarray(0, n));
    for (let i = 0; i < e; i++) {
      const a = this.edgeA[i] as number;
      const b = this.edgeB[i] as number;
      this.adjEdge[cursor[a] as number] = i;
      cursor[a] = (cursor[a] as number) + 1;
      this.adjEdge[cursor[b] as number] = i;
      cursor[b] = (cursor[b] as number) + 1;
    }

    // Segments, and the bucket grid over them.
    let segs = 0;
    for (let i = 0; i < e; i++) {
      segs += (this.edgeOffset[i + 1] as number) - (this.edgeOffset[i] as number) - 1;
    }
    this.segEdge = new Int32Array(segs);
    this.segFrom = new Float32Array(segs);
    this.segPt = new Float32Array(segs * 4);
    let s = 0;
    for (let i = 0; i < e; i++) {
      const o0 = this.edgeOffset[i] as number;
      const o1 = this.edgeOffset[i + 1] as number;
      let acc = 0;
      for (let k = o0; k + 1 < o1; k++) {
        const ax = this.edgePts[k * 2] as number;
        const az = this.edgePts[k * 2 + 1] as number;
        const bx = this.edgePts[k * 2 + 2] as number;
        const bz = this.edgePts[k * 2 + 3] as number;
        this.segEdge[s] = i;
        this.segFrom[s] = acc;
        this.segPt[s * 4] = ax;
        this.segPt[s * 4 + 1] = az;
        this.segPt[s * 4 + 2] = bx;
        this.segPt[s * 4 + 3] = bz;
        this.bucket(s, ax, az, bx, bz);
        acc += Math.hypot(bx - ax, bz - az);
        s++;
      }
    }

    this.dist = new Float64Array(n);
    this.heapC = new Float64Array(Math.max(64, n * 2));
    this.heapK = new Int32Array(Math.max(64, n * 2));
  }

  private bucket(idx: number, ax: number, az: number, bx: number, bz: number): void {
    const c = this.cellM;
    for (let cz = Math.floor(Math.min(az, bz) / c); cz <= Math.floor(Math.max(az, bz) / c); cz++) {
      for (let cx = Math.floor(Math.min(ax, bx) / c); cx <= Math.floor(Math.max(ax, bx) / c); cx++) {
        const key = cx * 100003 + cz;
        let list = this.buckets.get(key);
        if (!list) {
          list = [];
          this.buckets.set(key, list);
        }
        list.push(idx);
      }
    }
  }

  /**
   * Does this graph describe the model the game loaded?
   *
   * Surfaced rather than resolved, exactly as `PassableSpace.checkAgainst` does
   * it: a network derived from a different town is wrong in the way nobody
   * notices until a course is set on it.
   */
  checkAgainst(model: TownModel, modelBytes: number): void {
    if (this.meta.modelBytes !== modelBytes) {
      this.warnings.push(
        `streets.bin was derived from a ${this.meta.modelBytes}-byte townmodel.bin and this ` +
          `build loaded a ${modelBytes}-byte one — run tools/terrain/streetgraph.mjs`,
      );
    }
    if (this.meta.playableR !== model.playableR) {
      this.warnings.push(
        `streets.bin covers ±${this.meta.playableR} m and the model claims ±${model.playableR} m`,
      );
    }
  }

  /**
   * The nearest point of the network, or null beyond `maxM`.
   *
   * `sitableOnly` restricts the answer to Road, Path and Steps — the ways a
   * control may hang on. Open-ground chords are network for *routing* and never
   * for siting; see `STREET_OPEN`.
   */
  snap(p: { x: number; z: number }, maxM = MAX_SNAP_M, sitableOnly = false): StreetSnap | null {
    let best: StreetSnap | null = null;
    let bestD = maxM;
    const c = this.cellM;
    const r = Math.max(1, Math.ceil(maxM / c));
    const cx = Math.floor(p.x / c);
    const cz = Math.floor(p.z / c);
    // Rings outward, so a hit close in stops the search before the far cells.
    for (let ring = 0; ring <= r; ring++) {
      if (best && bestD <= (ring - 1) * c) break;
      for (let dz = -ring; dz <= ring; dz++) {
        for (let dx = -ring; dx <= ring; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== ring) continue;
          const list = this.buckets.get((cx + dx) * 100003 + (cz + dz));
          if (!list) continue;
          for (const si of list) {
            const ei = this.segEdge[si] as number;
            if (sitableOnly && this.edgeKind[ei] === STREET_OPEN) continue;
            const ax = this.segPt[si * 4] as number;
            const az = this.segPt[si * 4 + 1] as number;
            const bx = this.segPt[si * 4 + 2] as number;
            const bz = this.segPt[si * 4 + 3] as number;
            const ux = bx - ax;
            const uz = bz - az;
            const len2 = ux * ux + uz * uz;
            let t = len2 > 1e-9 ? ((p.x - ax) * ux + (p.z - az) * uz) / len2 : 0;
            t = t < 0 ? 0 : t > 1 ? 1 : t;
            const qx = ax + ux * t;
            const qz = az + uz * t;
            const d = Math.hypot(qx - p.x, qz - p.z);
            if (d >= bestD) continue;
            const along = (this.segFrom[si] as number) + Math.sqrt(len2) * t;
            const total = this.edgeLength[ei] as number;
            bestD = d;
            best = {
              d,
              x: qx,
              z: qz,
              edge: ei,
              kind: this.edgeKind[ei] as number,
              a: this.edgeA[ei] as number,
              b: this.edgeB[ei] as number,
              toA: along,
              toB: Math.max(0, total - along),
            };
          }
        }
      }
    }
    return best;
  }

  /** Metres to the nearest way a control may be sited on. `Infinity` beyond `maxM`. */
  nearestSitable(x: number, z: number, maxM = MAX_SNAP_M): number {
    return this.snap({ x, z }, maxM, true)?.d ?? Infinity;
  }

  /** Metres to the network at all, chords included. `Infinity` beyond `maxM`. */
  nearestM(x: number, z: number, maxM = MAX_SNAP_M): number {
    return this.snap({ x, z }, maxM)?.d ?? Infinity;
  }

  /**
   * Distances from `p` over the whole network. One Dijkstra.
   *
   * The scratch arrays are the instance's, so the returned closure is only
   * valid until the next call — the same discipline `makeCourseAudit` had to
   * learn the hard way when it returned a view over shared scratch and read it
   * back after sixteen searches had overwritten it (D-037). Here the node
   * distances are **copied** into the closure rather than viewed, so a stale
   * read is impossible rather than merely avoided.
   */
  fieldFrom(p: { x: number; z: number }, maxSnapM = MAX_SNAP_M): StreetField | null {
    const s = this.snap(p, maxSnapM);
    if (!s) return null;
    const n = this.nodeX.length;
    const dist = this.dist;
    dist.fill(Infinity);
    this.heapN = 0;
    dist[s.a] = s.toA;
    dist[s.b] = s.toB;
    this.push(s.toA, s.a);
    this.push(s.toB, s.b);
    while (this.heapN > 0) {
      const k = this.pop();
      const c = this.popped;
      if (c > (dist[k] as number)) continue;
      for (let i = this.adjStart[k] as number; i < (this.adjStart[k + 1] as number); i++) {
        const ei = this.adjEdge[i] as number;
        const o = (this.edgeA[ei] as number) === k ? (this.edgeB[ei] as number) : (this.edgeA[ei] as number);
        const nc = c + (this.edgeLength[ei] as number);
        if (nc < (dist[o] as number)) {
          dist[o] = nc;
          this.push(nc, o);
        }
      }
    }
    const from = new Float64Array(n);
    from.set(dist);
    const self = this;
    const field: StreetField = {
      origin: s,
      to(q: { x: number; z: number }): number {
        const t = self.snap(q, maxSnapM);
        if (!t) return Infinity;
        let best = Math.min((from[t.a] as number) + t.toA, (from[t.b] as number) + t.toB);
        // Same edge as the origin: the route may never have to leave it.
        if (t.edge === s.edge) best = Math.min(best, Math.abs(t.toA - s.toA));
        return best + t.d + s.d;
      },
    };
    return field;
  }

  private popped = 0;

  private push(c: number, k: number): void {
    let i = this.heapN++;
    this.heapC[i] = c;
    this.heapK[i] = k;
    while (i > 0) {
      const par = (i - 1) >> 1;
      if ((this.heapC[par] as number) <= (this.heapC[i] as number)) break;
      const tc = this.heapC[par] as number;
      const tk = this.heapK[par] as number;
      this.heapC[par] = this.heapC[i] as number;
      this.heapK[par] = this.heapK[i] as number;
      this.heapC[i] = tc;
      this.heapK[i] = tk;
      i = par;
    }
  }

  private pop(): number {
    this.popped = this.heapC[0] as number;
    const k = this.heapK[0] as number;
    this.heapN--;
    this.heapC[0] = this.heapC[this.heapN] as number;
    this.heapK[0] = this.heapK[this.heapN] as number;
    let i = 0;
    for (;;) {
      const l = i * 2 + 1;
      const r = l + 1;
      let m = i;
      if (l < this.heapN && (this.heapC[l] as number) < (this.heapC[m] as number)) m = l;
      if (r < this.heapN && (this.heapC[r] as number) < (this.heapC[m] as number)) m = r;
      if (m === i) break;
      const tc = this.heapC[m] as number;
      const tk = this.heapK[m] as number;
      this.heapC[m] = this.heapC[i] as number;
      this.heapK[m] = this.heapK[i] as number;
      this.heapC[i] = tc;
      this.heapK[i] = tk;
      i = m;
    }
    return k;
  }

  /**
   * The bearings you can leave a point on, along the network.
   *
   * Fault 8's own question. The start is snapped, and every edge at the two
   * junctions its edge runs between contributes the bearing of its first few
   * metres. A start with one bearing is a cul-de-sac; a start whose only
   * bearings point back at the finish is the "run out and there's a wall"
   * report with the wall drawn as a dead end instead.
   */
  exitsAt(p: { x: number; z: number }, maxSnapM = MAX_SNAP_M): number[] {
    const s = this.snap(p, maxSnapM);
    if (!s) return [];
    const out: number[] = [];
    const addFrom = (node: number) => {
      for (let i = this.adjStart[node] as number; i < (this.adjStart[node + 1] as number); i++) {
        const ei = this.adjEdge[i] as number;
        const o0 = this.edgeOffset[ei] as number;
        const o1 = this.edgeOffset[ei + 1] as number;
        const first = (this.edgeA[ei] as number) === node;
        const px = this.edgePts[(first ? o0 : o1 - 1) * 2] as number;
        const pz = this.edgePts[(first ? o0 : o1 - 1) * 2 + 1] as number;
        const qx = this.edgePts[(first ? o0 + 1 : o1 - 2) * 2] as number;
        const qz = this.edgePts[(first ? o0 + 1 : o1 - 2) * 2 + 1] as number;
        void px;
        void pz;
        out.push(Math.atan2(qx - p.x, -(qz - p.z)));
      }
    };
    addFrom(s.a);
    if (s.b !== s.a) addFrom(s.b);
    return out;
  }
}
