/**
 * The passable space, as shipped.
 *
 * PLAN-KRUMLOV-V2 §2 rule 4, phase 2: *"Passable space is derived, then
 * asserted connected, before any course exists. Not flood-filled afterwards to
 * see what broke."* `tools/terrain/passable.mjs` derives it from the town model
 * and labels its components; this reads the answer.
 *
 * ---------------------------------------------------------------------------
 * What moved, and why it had to
 * ---------------------------------------------------------------------------
 *
 * Connectivity is a *global* property of the venue, so establishing it costs a
 * venue-wide flood however cleverly it is written — and phase 0 measured that
 * flood at **2.9 s on the 4×-throttled mid-range-Android proxy**, with
 * `bakedRaster`'s 2.56 M-cell collision sweep another 2.6 s in front of it.
 * Both ran in the loading screen, every time the venue opened, to recompute an
 * answer that cannot change between one load and the next. §2 says the model is
 * *"built offline, once"*; phase 0 required phase 2 to honour that literally.
 *
 * So `FieldTerrain.buildReachability` no longer floods when this file is
 * present: it reads a bit.
 *
 * ---------------------------------------------------------------------------
 * Tier independence, by construction
 * ---------------------------------------------------------------------------
 *
 * D-027 and D-029 both exist because a quality tier changed the rules surface —
 * a 4 m class raster that sealed the town, then a 4 m heightfield that re-rolled
 * the course. Both were fixed by argument and then held in place by a gate.
 *
 * This one cannot drift, because there is nothing to pick from: `loadPassable`
 * **takes no tier**, there is no `passable-low.bin` to generate, and the
 * runtime has no code path that could build a cheaper one — the derivation
 * lives in `tools/`. A tier that wanted a cheaper *drawing* of the town would
 * be changing `Townscape`, which is a rendering budget and cannot reach this.
 *
 * ---------------------------------------------------------------------------
 * The one thing the file cannot know
 * ---------------------------------------------------------------------------
 *
 * `TownModel.addStructure` lets the scene register a footprint it draws by hand
 * — the Marian column's plinth, the fountain's jet pillar, the cloak bridge's
 * piers — and those are built by `landmarks.ts` at scene-build time, so the
 * offline derivation has never seen them. 94 m² of the venue, measured by
 * `check-townmodel`. `punch` folds them in once the model is sealed: a bounded
 * sweep of their own bounding boxes, not of the venue. That they only ever
 * remove ground, and never disconnect any of it, is asserted offline in
 * `tools/ci/check-passable.mjs` rather than assumed here.
 */

import type { TownModel } from './townModel';

interface PassableSection {
  offset: number;
  bits: number;
}

interface PassableMeta {
  venue: string;
  /** Byte count of the `townmodel.bin` this space was derived from. */
  modelBytes: number;
  resM: number;
  playableR: number;
  width: number;
  height: number;
  originX: number;
  originZ: number;
  sweepM: number;
  connectivity: number;
  sections: { open: PassableSection; reach: PassableSection };
  openM2: number;
  reachM2: number;
  reachableFraction: number;
  components: number;
  census: {
    pockets: number;
    sealed: number;
    porous: number;
    gridArtifacts: number;
    traps: number;
    largestPocketM2: number;
  };
}

export interface PassableData {
  meta: PassableMeta;
  buffer: ArrayBuffer;
}

/**
 * Fetch the venue's passable space.
 *
 * **No tier parameter, deliberately** — see the header. Every tier loads this
 * file and there is no other file to load.
 */
export async function loadPassable(venue: string): Promise<PassableData> {
  const base = `/data/${venue}/passable`;
  const [metaRes, binRes] = await Promise.all([fetch(`${base}.json`), fetch(`${base}.bin`)]);
  if (!metaRes.ok) throw new Error(`${base}.json: HTTP ${metaRes.status}`);
  if (!binRes.ok) throw new Error(`${base}.bin: HTTP ${binRes.status}`);
  const meta = (await metaRes.json()) as PassableMeta;
  const buffer = await binRes.arrayBuffer();
  if (!meta.sections?.reach) {
    throw new Error(`${base}.json: no passable space — run tools/terrain/passable.mjs`);
  }
  return { meta, buffer };
}

export class PassableSpace {
  readonly resM: number;
  readonly width: number;
  readonly height: number;
  readonly originX: number;
  readonly originZ: number;
  readonly playableR: number;
  /** Ground the arena can reach, as a fraction of open ground. Measured offline. */
  readonly reachableFraction: number;
  readonly meta: PassableMeta;
  readonly warnings: string[] = [];

  /**
   * Cells removed by `punch`, as flat world [x, z] pairs.
   *
   * Kept because `FieldTerrain.bakedRaster` needs exactly this and nothing
   * else: the class raster's `Impassable` is already the model's solid set
   * (D-038), so the only ground the map does not know about is what the scene
   * registered by hand after the file was written.
   */
  readonly punchedPoints: number[] = [];

  private readonly open: Uint8Array;
  private readonly reach: Uint8Array;

  constructor(data: PassableData) {
    const m = data.meta;
    this.meta = m;
    this.resM = m.resM;
    this.width = m.width;
    this.height = m.height;
    this.originX = m.originX;
    this.originZ = m.originZ;
    this.playableR = m.playableR;
    this.reachableFraction = m.reachableFraction;
    const bytes = Math.ceil((m.width * m.height) / 8);
    this.open = new Uint8Array(data.buffer, m.sections.open.offset, bytes);
    this.reach = new Uint8Array(data.buffer, m.sections.reach.offset, bytes);
  }

  /**
   * Does this space describe the model the game loaded?
   *
   * The two files are built one from the other and ship together, so a
   * mismatch means a partial deploy or a hand-edited artefact. It is surfaced
   * rather than resolved: a passable space derived from a different town is
   * wrong in exactly the way nobody notices until a player is standing in it.
   */
  checkAgainst(model: TownModel, modelBytes: number): void {
    if (this.meta.modelBytes !== modelBytes) {
      this.warnings.push(
        `passable.bin was derived from a ${this.meta.modelBytes}-byte townmodel.bin and this ` +
          `build loaded a ${modelBytes}-byte one — run tools/terrain/passable.mjs`,
      );
    }
    if (this.playableR !== model.playableR) {
      this.warnings.push(
        `passable.bin covers ±${this.playableR} m and the model claims ±${model.playableR} m`,
      );
    }
  }

  private index(x: number, z: number): number {
    const i = Math.round((x - this.originX) / this.resM);
    const j = Math.round((z - this.originZ) / this.resM);
    if (i < 0 || j < 0 || i >= this.width || j >= this.height) return -1;
    return j * this.width + i;
  }

  /** Is there open ground at this point? False outside the playable square. */
  openAt(x: number, z: number): boolean {
    const k = this.index(x, z);
    if (k < 0) return false;
    return ((this.open[k >> 3] as number) >> (k & 7) & 1) === 1;
  }

  /** Is this point in the arena's connected component? */
  reachableAt(x: number, z: number): boolean {
    const k = this.index(x, z);
    if (k < 0) return false;
    return ((this.reach[k >> 3] as number) >> (k & 7) & 1) === 1;
  }

  /**
   * Fold in the footprints the scene registered by hand.
   *
   * Bounded by the structures themselves — their bounding boxes, at this
   * lattice — rather than by the venue, which is the whole point: this runs at
   * load and a venue-wide sweep may not. Call it once, after `TownModel.seal`.
   */
  punch(model: TownModel): number {
    let n = 0;
    for (const f of model.footprints) {
      if (f.source !== 'structure') continue;
      let minX = Infinity;
      let maxX = -Infinity;
      let minZ = Infinity;
      let maxZ = -Infinity;
      for (let i = 0; i < f.ring.length; i += 2) {
        const x = f.ring[i] as number;
        const z = f.ring[i + 1] as number;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (z < minZ) minZ = z;
        if (z > maxZ) maxZ = z;
      }
      const r = this.resM;
      for (let z = Math.floor(minZ / r) * r; z <= maxZ + r; z += r) {
        for (let x = Math.floor(minX / r) * r; x <= maxX + r; x += r) {
          const k = this.index(x, z);
          if (k < 0) continue;
          if ((((this.open[k >> 3] as number) >> (k & 7)) & 1) === 0) continue;
          if (!model.blockedAt(x, z)) continue;
          this.open[k >> 3] = (this.open[k >> 3] as number) & ~(1 << (k & 7));
          this.reach[k >> 3] = (this.reach[k >> 3] as number) & ~(1 << (k & 7));
          this.punchedPoints.push(x, z);
          n++;
        }
      }
    }
    return n;
  }

  /** For the gates: the census the derivation recorded, unmodified. */
  get census(): PassableMeta['census'] {
    return this.meta.census;
  }
}
