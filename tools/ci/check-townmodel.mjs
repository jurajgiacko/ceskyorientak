#!/usr/bin/env node
/**
 * The drawn ≡ solid gate.
 *
 * PLAN-KRUMLOV-V2 §2 rule 2: *"Anything drawn that blocks, and anything that
 * blocks, is the same object. One list. Drawn-but-not-solid and
 * solid-but-not-drawn both become unrepresentable."* `TownModel` is what makes
 * that true of the data. This is what makes it true of the **scene the player
 * is actually looking at**, which is a different claim and the one that keeps
 * failing:
 *
 *  - D-029 — 13 849 m of barrier drawn as a solid slab with no collider. The
 *    data said `u = 0` and the renderer drew 1.5 m; both were self-consistent.
 *  - D-033 — bridges opened by one raster stamp and closed by the next.
 *  - The Zámecká věž — fifty-four metres of masonry drawn by `landmarks.ts`,
 *    skipped by the extruder that owned the collision index, and therefore run
 *    straight through. Found by this gate, not by a player, which is the whole
 *    point of writing it.
 *
 * So the gate does not ask the model whether it agrees with itself. It reads
 * the **scene graph** — every mesh under the town's groups — rasterises what
 * those triangles occupy at running height, and compares that with what the
 * running game's own `blockedAt` says. Neither side is reconstructed here.
 *
 * Five phases:
 *
 *   1. **structure** — the packed model carries no solidity field to disagree
 *      with, and the raster's `Impassable` class is derived from the model.
 *   2. **offline sweep** — drawn ≡ solid over the venue at 0.5 m, from the
 *      model's own dimensions.
 *   3. **roles** — every mesh the town draws says what it is. An unclassified
 *      mesh is a mesh nobody has decided about.
 *   4. **drawn → solid** — nothing that stands in the athlete's way is
 *      passable.
 *   5. **solid → drawn** — nothing stops the athlete where nothing is drawn,
 *      tested on the *boundary* of the solid set, which is where a player meets
 *      it. Plus offline-vs-runtime agreement on the predicate itself.
 *
 * Usage: node tools/ci/check-townmodel.mjs [--venue krumlov] [--step 0.5] [--offline]
 * Exit codes: 0 pass, 1 a disagreement, 2 harness failure.
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve, withChrome, openTab } from './chrome.mjs';
import { readModel, colliders, drawnVsSolid } from '../terrain/townmodel.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../..');
const DIST = resolve(ROOT, 'dist');
const IMPASSABLE = 10;

/**
 * The largest single *run* of drawn-and-not-solid ground the gate will pass, m².
 *
 * Stated as a run rather than as a total, and that distinction is the whole
 * argument. A total allowance is what every fault in this venue's history hid
 * inside: 13.8 km of collider-less barrier is a small percentage of a 144 ha
 * venue. A *run* is what a player meets — you cannot run through half a square
 * metre of wall, you run through a wall.
 *
 * One square metre is four cells of the 0.5 m lattice this is measured on, and
 * it is the resolution of the instrument rather than a judgement about what is
 * acceptable: a roof's eave grazing the corner of one cell on a bank is the
 * lattice, not a fault. Every fault this gate exists for is orders larger —
 * D-029's barriers, the Zámecká věž's 110 m², D-033's bridges.
 */
const MAX_DRAWN_NOT_SOLID_RUN_M2 = 1;

/**
 * And a ceiling on the *total*, so that a scattering cannot pass by being
 * finely divided. Measured on the venue as it stands: 1 m².
 */
const MAX_DRAWN_NOT_SOLID_TOTAL_M2 = 25;

/**
 * How much of the solid *boundary* may have nothing drawn at it, m².
 *
 * Also zero, and it is a boundary rather than an area test for a reason: the
 * inside of a building is solid and undrawn — there is no geometry in the
 * middle of a house — and only the edge of the solid set is somewhere a player
 * can stand and be stopped. The tolerance is spatial rather than numeric: a
 * boundary cell counts as drawn if drawn geometry is within the collider skin
 * plus one cell, which is exactly the distance the collider is allowed to stand
 * proud of the face it belongs to.
 */
const MAX_SOLID_NOT_DRAWN_M2 = 0;

const args = process.argv.slice(2);
const venue = (args.find((a) => a.startsWith('--venue=')) ?? '--venue=krumlov').split('=')[1];
const step = Number((args.find((a) => a.startsWith('--step=')) ?? '--step=0.5').split('=')[1]);
const offlineOnly = args.includes('--offline');

const dataDir = resolve(ROOT, 'public/data', venue);

let bad = false;
const fail = (msg) => {
  bad = true;
  console.error(`✗ ${msg}`);
};

// ---------------------------------------------------------------------------
// 1 · structure
// ---------------------------------------------------------------------------

console.log(`\n· ${venue} — the model as shipped\n`);

if (!existsSync(join(dataDir, 'townmodel.bin'))) {
  console.error('✗ townmodel.bin missing — run node tools/terrain/townmodel.mjs');
  process.exit(2);
}

const { header, model } = readModel(dataDir);
const col = colliders(model);

console.log(
  `  ${header.counts.buildings} buildings · ${header.counts.barriers} barriers ` +
    `(${header.counts.barriersSolid} solid) · ${header.counts.waterAreas} water areas · ` +
    `${header.counts.waterCourses} watercourses · ${header.counts.decks} carriageways`,
);
console.log(`  ${header.counts.primitives} collision primitives, ${header.bytes} bytes packed`);

/**
 * The fields that would let the file say "drawn tall, not solid".
 *
 * v1 had exactly one of these — `u` on a wall record — and it is what 13.8 km
 * of run-through barrier was written in. The assertion is that no such field
 * exists: solidity has no representation, so it cannot be got wrong.
 */
const FORBIDDEN = ['barrierSolid', 'barrierU', 'barrierBlocks', 'colliders', 'impassable'];
for (const name of Object.keys(header.sections)) {
  if (FORBIDDEN.includes(name)) {
    fail(`townmodel.bin carries a "${name}" section — solidity must be derived, not stored`);
  }
}
if (header.sections.barrierHeight?.count !== header.counts.barriers) {
  fail('every barrier must carry exactly one height, and solidity is derived from it');
}

const rMeta = JSON.parse(readFileSync(join(dataDir, 'runnability.json'), 'utf8'));
if (rMeta.impassableFrom !== 'townmodel') {
  fail(
    "runnability.json is not marked impassableFrom: 'townmodel' — the speed surface " +
      'still holds its own opinion about what is out of bounds',
  );
}

// The raster's Impassable class against the model, on the raster's own lattice.
{
  const bin = readFileSync(join(dataDir, 'runnability.bin'));
  const r = new Uint8Array(bin.buffer, bin.byteOffset, bin.length);
  const R = header.playableR;
  let missing = 0;
  let spurious = 0;
  for (let j = 0; j < rMeta.height; j++) {
    const z = rMeta.originZ + j * rMeta.resM;
    if (Math.abs(z) > R) continue;
    for (let i = 0; i < rMeta.width; i++) {
      const x = rMeta.originX + i * rMeta.resM;
      if (Math.abs(x) > R) continue;
      const imp = r[j * rMeta.width + i] === IMPASSABLE;
      // Two claims, in the two directions they can fail.
      //
      // Nothing the model stops you at may be missing from the raster the map
      // draws (ISSprOM 515/518, D-002), and nothing the raster calls impassable
      // may be further than half a cell from something the model stops you at —
      // which is the width a 1 m lattice has to give a 0.6 m railing to draw it
      // as a line rather than as a dotted one.
      if (col.blockedAt(x, z) && !imp) missing++;
      if (imp && !col.drawnInCell(x, z, rMeta.resM * Math.SQRT1_2)) spurious++;
    }
  }
  console.log(
    `  raster Impassable vs model solid inside ±${R} m: ${missing} m² solid and not on the ` +
      `map, ${spurious} m² impassable further than half a cell from anything solid`,
  );
  if (missing > 0) fail(`${missing} m² is out of bounds and the map does not draw it`);
  if (spurious > 0) fail(`${spurious} m² of the raster is impassable with nothing solid near it`);
}

// ---------------------------------------------------------------------------
// 2 · offline sweep
// ---------------------------------------------------------------------------

{
  const c = drawnVsSolid(model, col, step, header.playableR);
  console.log(
    `  offline drawn ≡ solid at ${step} m: drawn-not-solid ${c.drawnNotSolidM2} m², ` +
      `solid-not-drawn ${c.solidNotDrawnM2} m² at a worst gap of ${c.worstGapM} m ` +
      `(skin ${c.skinM} m)`,
  );
  if (c.drawnNotSolidM2 > 0) {
    // Offline the two sides come from the same dimensions, so this is exact
    // and there is nothing for a tolerance to absorb.
    fail(`${c.drawnNotSolidM2} m² drawn as blocking that does not block`);
  }
  if (c.worstGapM > c.skinM + 1e-6) {
    fail(`the collider stands ${c.worstGapM} m outside the drawn face, against a ${c.skinM} m skin`);
  }
}

if (offlineOnly) {
  console.log(bad ? '\n✗ TOWN MODEL GATE FAILED' : '\n✓ town model OK (offline only)');
  process.exit(bad ? 1 : 0);
}

// ---------------------------------------------------------------------------
// 3–5 · the scene the player is looking at
// ---------------------------------------------------------------------------

if (!existsSync(DIST)) {
  console.error('\n✗ dist/ not found — the scene phases need it. Run `npm run build`,');
  console.error('  or pass --offline to run the model phases alone.');
  process.exit(2);
}

/**
 * Rasterise the drawn town, in the page, from the scene graph.
 *
 * The band test is what separates a wall from an arcade. A triangle counts as
 * standing in the athlete's way if its vertical extent covers the ground plus
 * `crossableMaxH` — so a wall face does, a roof does not, the cloak bridge's
 * arches twenty metres up do not, and the fountain basin at 0.85 m does not,
 * which is the same line `TownModel` draws between a barrier you are stopped by
 * and one you step over.
 *
 * Water is the exception and is marked wherever it is drawn at all: it is out
 * of bounds by ISSprOM 301 rather than by standing in the way.
 */
const PROBE = (stepM, crossableMaxH) => `(async () => {
  const w = window.__world;
  if (!w) return { error: 'no scene' };
  const R = w.model.playableR;
  const step = ${stepM};
  // The lattice runs a little wider than the square being judged, because both
  // comparisons look at a neighbourhood and a cell on the boundary row cannot
  // see whether the wall it belongs to continues outside.
  const MARGIN = 4;
  const N = Math.floor((2 * (R + MARGIN)) / step) + 1;
  const O = R + MARGIN;
  const idx = (i, j) => j * N + i;

  // --- 3 · every mesh says what it is --------------------------------------
  const groups = ['buildings', 'townscape', 'landmarks'];
  const untagged = [];
  const byRole = {};
  const meshes = [];
  for (const name of groups) {
    const g = w.scene.getObjectByName(name);
    if (!g) return { error: 'missing group ' + name };
    g.traverse((o) => {
      if (!o.isMesh) return;
      const role = o.userData.role;
      if (!role) {
        untagged.push(name + '/' + (o.name || o.type));
        return;
      }
      byRole[role] = (byRole[role] || 0) + 1;
      meshes.push({ o, role });
    });
  }

  // --- 4 · what is drawn, at running height --------------------------------
  const drawn = new Uint8Array(N * N);
  // Which role drew each cell, so a disagreement names the thing that caused it
  // rather than a coordinate. 1 building · 2 barrier · 3 structure · 4 water.
  const drawnBy = new Uint8Array(N * N);
  // Ground under each cell, filled as cells are touched. Zero means "not yet",
  // which is safe: no ground in this venue is at 0 m ASL.
  const ground = new Float32Array(N * N);
  const ROLE_CODE = { building: 1, barrier: 2, structure: 3, water: 4 };
  const BLOCKING = { building: 1, barrier: 1, structure: 1 };
  let triangles = 0;
  const v = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  for (const { o, role } of meshes) {
    if (!BLOCKING[role] && role !== 'water') continue;
    const geo = o.geometry;
    const pos = geo.getAttribute('position');
    if (!pos) continue;
    const index = geo.getIndex();
    const count = index ? index.count : pos.count;
    o.updateMatrixWorld(true);
    const m = o.matrixWorld.elements;
    const tx = (x, y, z) => m[0] * x + m[4] * y + m[8] * z + m[12];
    const ty = (x, y, z) => m[1] * x + m[5] * y + m[9] * z + m[13];
    const tz = (x, y, z) => m[2] * x + m[6] * y + m[10] * z + m[14];
    for (let t = 0; t < count; t += 3) {
      let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
      let minY = Infinity, maxY = -Infinity;
      for (let k = 0; k < 3; k++) {
        const a = index ? index.getX(t + k) : t + k;
        const px = pos.getX(a), py = pos.getY(a), pz = pos.getZ(a);
        const X = tx(px, py, pz), Y = ty(px, py, pz), Z = tz(px, py, pz);
        v[k * 3] = X; v[k * 3 + 1] = Y; v[k * 3 + 2] = Z;
        if (X < minX) minX = X; if (X > maxX) maxX = X;
        if (Z < minZ) minZ = Z; if (Z > maxZ) maxZ = Z;
        if (Y < minY) minY = Y; if (Y > maxY) maxY = Y;
      }
      if (maxX < -O || minX > O || maxZ < -O || minZ > O) continue;
      triangles++;
      const wet = role === 'water';
      if (!wet) {
        // Only a *steep* face obstructs. A roof plane, a step tread, a deck and
        // a pier's top are surfaces you are above or below, and none of them is
        // a wall. This is not a nicety: on the castle rock the ground rises
        // through the eaves, so a roof plane genuinely crosses running height
        // outside its own footprint — drawn, at knee level, and correctly not
        // solid. Anything you can walk into presents a steep face, so nothing
        // that blocks is lost.
        const ux = v[3] - v[0], uy = v[4] - v[1], uz = v[5] - v[2];
        const wx = v[6] - v[0], wy = v[7] - v[1], wz = v[8] - v[2];
        const nx = uy * wz - uz * wy;
        const ny = uz * wx - ux * wz;
        const nz = ux * wy - uy * wx;
        const nlen = Math.hypot(nx, ny, nz);
        if (nlen > 1e-9 && Math.abs(ny) / nlen > 0.7) continue;
        // Does the face stand above the plane a runner steps over?
        //
        // Measured per vertex against the ground *under that vertex*: the top
        // of a wall is its own ground plus its height, by construction, so
        // this is exact where it matters and needs no tolerance. A centroid
        // sample is not — a wall on the castle ramp climbs with the slope, and
        // sampling the middle calls a crossable railing a wall.
        let maxAbove = -Infinity;
        let minAbove = Infinity;
        for (let k = 0; k < 3; k++) {
          const above = v[k * 3 + 1] - w.field.heightAt(v[k * 3], v[k * 3 + 2]);
          if (above > maxAbove) maxAbove = above;
          if (above < minAbove) minAbove = above;
        }
        // Strictly above, because blocks is height > crossableMaxH: a fence
        // drawn at exactly the threshold is one you step over.
        if (maxAbove <= ${crossableMaxH} + 1e-3) continue;
        // And it must come down to the runner: the cloak bridge's arcades are
        // twenty metres up and you run underneath them.
        if (minAbove > ${crossableMaxH}) continue;
      }
      // Scan-convert the triangle over the lattice.
      //
      // Almost every triangle that matters here is a *vertical* face — a wall,
      // a parapet, the side of a pier — whose projection onto the ground is a
      // line and not an area. Barycentric coverage answers "no cell" for those,
      // and the first cut of this gate answered "the whole bounding box"
      // instead, which reported 21 ha of phantom disagreement along the
      // diagonal walls. A vertical face occupies the cells its ground line
      // passes through, so it is rasterised as a segment.
      const i0 = Math.max(0, Math.ceil((minX - step + O) / step));
      const i1 = Math.min(N - 1, Math.floor((maxX + step + O) / step));
      const j0 = Math.max(0, Math.ceil((minZ - step + O) / step));
      const j1 = Math.min(N - 1, Math.floor((maxZ + step + O) / step));
      const ax = v[0], az = v[2], bx = v[3], bz = v[5], cx2 = v[6], cz2 = v[8];
      const d = (bz - cz2) * (ax - cx2) + (cx2 - bx) * (az - cz2);
      const flat = Math.abs(d) < 1e-6;
      const halfCell = step * 0.5;
      const nearSeg = (px, pz, sx, sz, ex, ez) => {
        const dx = ex - sx, dz = ez - sz;
        const l2 = dx * dx + dz * dz;
        let t = l2 > 1e-12 ? ((px - sx) * dx + (pz - sz) * dz) / l2 : 0;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const qx = sx + dx * t - px, qz = sz + dz * t - pz;
        return qx * qx + qz * qz <= halfCell * halfCell;
      };
      for (let j = j0; j <= j1; j++) {
        const z = -O + j * step;
        for (let i = i0; i <= i1; i++) {
          const x = -O + i * step;
          // Edges first, then the interior. A wall face projects to a line and
          // has no interior at all; a *tapered* face — the Marian column's
          // plinth, which is 8 cm wider at the foot than at the top — projects
          // to a sliver 8 cm across that a 0.5 m lattice steps straight over.
          // Testing the edges as segments catches both, and the barycentric
          // fill below catches the large horizontal faces the edges miss.
          let hit =
            nearSeg(x, z, ax, az, bx, bz) ||
            nearSeg(x, z, bx, bz, cx2, cz2) ||
            nearSeg(x, z, cx2, cz2, ax, az);
          if (!hit && !flat) {
            const l1 = ((bz - cz2) * (x - cx2) + (cx2 - bx) * (z - cz2)) / d;
            const l2b = ((cz2 - az) * (x - cx2) + (ax - cx2) * (z - cz2)) / d;
            const l3 = 1 - l1 - l2b;
            hit = l1 >= -1e-6 && l2b >= -1e-6 && l3 >= -1e-6;
          }
          if (!hit) continue;

          drawn[idx(i, j)] = 1;
          drawnBy[idx(i, j)] = ROLE_CODE[role];
        }
      }
    }
  }

  // --- the collider, on the same lattice -----------------------------------
  const t0 = performance.now();
  const solid = new Uint8Array(N * N);
  for (let j = 0; j < N; j++) {
    const z = -O + j * step;
    for (let i = 0; i < N; i++) {
      if (w.blockedAt(-O + i * step, z)) solid[idx(i, j)] = 1;
    }
  }
  const sweepMs = performance.now() - t0;

  // The one tolerance in this gate, and it is a *distance* rather than an
  // allowance: the collider may stand skinM proud of the face it belongs to,
  // and a 0.5 m lattice quantises both masks by half a cell. So the two masks
  // are compared through a neighbourhood of that radius, in both directions,
  // and the area thresholds stay at zero. A metre of collider-less wall shows
  // up whole; a cell straddling a wall face does not.
  const reach = Math.ceil((w.model.skinM + step) / step);
  const nearIn = (mask, i, j) => {
    for (let dj = -reach; dj <= reach; dj++) {
      const jj = j + dj;
      if (jj < 0 || jj >= N) continue;
      for (let di = -reach; di <= reach; di++) {
        const ii = i + di;
        if (ii < 0 || ii >= N) continue;
        if (mask[idx(ii, jj)]) return true;
      }
    }
    return false;
  };

  // --- 4 · drawn → solid ----------------------------------------------------
  // Where a crossing carries you, this comparison does not apply.
  //
  // A bridge is a second surface, and drawn ≡ solid is a statement about *one*.
  // Over a carriageway the two levels are drawn on top of each other — the
  // Plášťový most's covered corridor twenty metres up, its piers in the ravine
  // below, the river under both — and asking a flat mask which of them the
  // athlete is standing on has no answer. TownModel does have one, and it is
  // what blockedAt uses; this is the one place the gate defers to it. The
  // excluded area is reported, because an exclusion nobody measures is a
  // blind spot.
  const onDeck = new Uint8Array(N * N);
  let deckCells = 0;
  for (let j = 0; j < N; j++) {
    const z = -O + j * step;
    for (let i = 0; i < N; i++) {
      if (w.model.onCarriageway(-O + i * step, z)) {
        onDeck[idx(i, j)] = 1;
        deckCells++;
      }
    }
  }

  const drawnNotSolid = [];
  const drawnNotSolidByRole = {};
  const notSolid = new Uint8Array(N * N);
  let drawnNotSolidCells = 0;
  // Both comparisons need a neighbourhood, so both are defined on the interior
  // of the lattice: a cell on the boundary row cannot see whether the thing it
  // belongs to continues outside the playable square, and the venue's own edge
  // is not what this gate is about.
  const lo = Math.ceil(MARGIN / step);
  const hi = N - lo;
  for (let j = lo; j < hi; j++) {
    for (let i = lo; i < hi; i++) {
      if (!drawn[idx(i, j)] || solid[idx(i, j)]) continue;
      if (onDeck[idx(i, j)]) continue;
      if (nearIn(solid, i, j)) continue;
      // Ask the collider itself before calling it a fault. The solid mask is a
      // 0.5 m sample of a continuous predicate, and Krumlov has footprints
      // narrower than a cell — a 0.6 m boiler house is drawn, is solid, and can
      // contain no sample point at all. The collider is continuous, so the last
      // word belongs to it rather than to the lattice.
      const px = -O + i * step;
      const pz = -O + j * step;
      let reallyOpen = !w.blockedAt(px, pz);
      for (let a = 0; a < 8 && reallyOpen; a++) {
        const th = (a / 8) * Math.PI * 2;
        const rr = w.model.skinM + step;
        if (w.blockedAt(px + Math.cos(th) * rr, pz + Math.sin(th) * rr)) reallyOpen = false;
      }
      if (!reallyOpen) continue;
      drawnNotSolidCells++;
      notSolid[idx(i, j)] = 1;
      const code = drawnBy[idx(i, j)];
      drawnNotSolidByRole[code] = (drawnNotSolidByRole[code] || 0) + 1;
      if (drawnNotSolid.length < 12) {
        drawnNotSolid.push([
          Number((-O + i * step).toFixed(1)),
          Number((-O + j * step).toFixed(1)),
          code,
        ]);
      }
    }
  }

  // The biggest *run* of it, which is what a player would meet. A gable corner
  // grazing one cell of a 0.5 m lattice is the instrument; a metre of wall with
  // no collider is the fault.
  let worstRun = 0;
  {
    const seen = new Uint8Array(N * N);
    for (let k0 = 0; k0 < N * N; k0++) {
      if (!notSolid[k0] || seen[k0]) continue;
      let n = 0;
      const stack = [k0];
      seen[k0] = 1;
      while (stack.length) {
        const k = stack.pop();
        n++;
        const i = k % N;
        const j = (k / N) | 0;
        const push2 = (ii, jj) => {
          if (ii < 0 || jj < 0 || ii >= N || jj >= N) return;
          const nk = jj * N + ii;
          if (notSolid[nk] && !seen[nk]) {
            seen[nk] = 1;
            stack.push(nk);
          }
        };
        push2(i + 1, j); push2(i - 1, j); push2(i, j + 1); push2(i, j - 1);
        push2(i + 1, j + 1); push2(i - 1, j - 1); push2(i + 1, j - 1); push2(i - 1, j + 1);
      }
      if (n > worstRun) worstRun = n;
    }
  }

  // --- 5 · solid → drawn, on the boundary ----------------------------------
  const near = (i, j) => nearIn(drawn, i, j);
  const solidNotDrawn = [];
  const solidNotDrawnByCause = {};
  let solidNotDrawnCells = 0;
  for (let j = lo; j < hi; j++) {
    for (let i = lo; i < hi; i++) {
      if (!solid[idx(i, j)] || onDeck[idx(i, j)]) continue;
      // Boundary only: a cell with an open neighbour is one a player can reach.
      if (solid[idx(i - 1, j)] && solid[idx(i + 1, j)] && solid[idx(i, j - 1)] && solid[idx(i, j + 1)]) {
        continue;
      }
      if (near(i, j)) continue;
      solidNotDrawnCells++;
      const x = -O + i * step;
      const z = -O + j * step;
      const why = w.model.waterCovers(x, z) ? 'water' : 'barrier or building';
      solidNotDrawnByCause[why] = (solidNotDrawnByCause[why] || 0) + 1;
      if (solidNotDrawn.length < 12) {
        solidNotDrawn.push([Number(x.toFixed(1)), Number(z.toFixed(1)), why]);
      }
    }
  }

  // --- the predicate itself, cell for cell ---------------------------------
  //
  // The whole solid mask goes back as a bitmap so the gate can compare the
  // game's collision with the shipped model's over all 144 hectares rather
  // than at a scatter of sample points. A scatter is how a fault this venue
  // has shipped four times goes unnoticed: every one of them was small in
  // area and total in consequence.
  const bits = new Uint8Array(Math.ceil((N * N) / 8));
  for (let k = 0; k < N * N; k++) if (solid[k]) bits[k >> 3] |= 1 << (k & 7);
  let binary = '';
  for (let k = 0; k < bits.length; k += 8192) {
    binary += String.fromCharCode.apply(null, bits.subarray(k, k + 8192));
  }
  const solidB64 = btoa(binary);

  // What the scene registered by hand, so the gate can account for the
  // difference exactly instead of allowing for it.
  const structures = w.model.footprints
    .filter((f) => f.source === 'structure')
    .map((f) => Array.from(f.ring));

  let solidCells = 0;
  for (let k = 0; k < solid.length; k++) solidCells += solid[k];
  let drawnCells = 0;
  for (let k = 0; k < drawn.length; k++) drawnCells += drawn[k];

  return {
    N, step, R, O, triangles, byRole, untagged,
    modelStats: w.model.stats,
    warnings: w.warnings,
    sweepMs: Number(sweepMs.toFixed(0)),
    solidM2: Math.round(solidCells * step * step),
    drawnM2: Math.round(drawnCells * step * step),
    drawnNotSolidM2: Math.round(drawnNotSolidCells * step * step),
    solidNotDrawnM2: Math.round(solidNotDrawnCells * step * step),
    drawnNotSolid, drawnNotSolidByRole, worstRunM2: Math.round(worstRun * step * step * 100) / 100,
    solidNotDrawn, solidNotDrawnByCause,
    solidB64, structures,
    deckM2: Math.round(deckCells * step * step),
  };
})()`;

const PORT = 4411 + Math.floor(Math.random() * 200);
const server = await serve(DIST, PORT);

await withChrome(async (cdp) => {
  const url = `http://127.0.0.1:${PORT}/?scene=sprint&race=1&debug=0&tier=high`;
  const tab = await openTab(cdp, url);
  const ready = await tab.waitFor('!!window.__world && !!window.__world.model', 180_000);
  if (!ready) {
    console.error('✗ the sprint scene never came up');
    console.error(tab.consoleErrors.slice(0, 5).join('\n'));
    bad = true;
    await tab.close();
    return;
  }

  const r = await tab.evaluate(PROBE(step, header.crossableMaxH));
  await tab.close();
  if (!r || r.error) {
    console.error(`✗ probe failed: ${r?.error ?? 'no result'}`);
    bad = true;
    return;
  }

  console.log(`\n· the scene, at ${r.step} m over ±${r.R} m\n`);
  console.log(
    `  ${r.triangles} triangles classified: ` +
      Object.entries(r.byRole).map(([k, n]) => `${k} ${n}`).join(' · '),
  );
  console.log(
    `  drawn as blocking ${r.drawnM2} m² · solid ${r.solidM2} m² · ` +
      `${r.deckM2} m² of bridge carriageway not judged (two surfaces, one mask)`,
  );
  console.log(`  runtime blockedAt swept ${r.N * r.N} points in ${r.sweepMs} ms`);
  for (const w of r.warnings ?? []) console.log(`  ! ${w}`);

  if (r.untagged.length) {
    fail(`${r.untagged.length} meshes carry no role: ${r.untagged.slice(0, 6).join(', ')}`);
  }

  const ROLE_NAME = { 1: 'building', 2: 'barrier', 3: 'structure', 4: 'water' };
  const byCause = Object.entries(r.drawnNotSolidByRole)
    .map(([k, n]) => `${ROLE_NAME[k] ?? k} ${Math.round(n * r.step * r.step)} m²`)
    .join(' · ');
  console.log(
    `  drawn and not solid: ${r.drawnNotSolidM2} m²${byCause ? ` — ${byCause}` : ''}` +
      ` · worst single run ${r.worstRunM2} m²`,
  );
  if (r.worstRunM2 >= MAX_DRAWN_NOT_SOLID_RUN_M2) {
    fail(
      `${r.worstRunM2} m² of one thing is drawn standing in the athlete's way and does not` +
        ` stop them — at ${r.drawnNotSolid.slice(0, 6).map((p) => p.join(',')).join('  ')}`,
    );
  }
  if (r.drawnNotSolidM2 > MAX_DRAWN_NOT_SOLID_TOTAL_M2) {
    fail(
      `${r.drawnNotSolidM2} m² of the venue is drawn as blocking and does not block, in ` +
        'pieces too small to name individually — which is a scattering, not an instrument',
    );
  }

  const solidCause = Object.entries(r.solidNotDrawnByCause)
    .map(([k, n]) => `${k} ${Math.round(n * r.step * r.step)} m²`)
    .join(' · ');
  console.log(
    `  solid with nothing drawn at it: ${r.solidNotDrawnM2} m²${solidCause ? ` — ${solidCause}` : ''}`,
  );
  if (r.solidNotDrawnM2 > MAX_SOLID_NOT_DRAWN_M2) {
    fail(
      `${r.solidNotDrawnM2} m² of the solid boundary has nothing drawn at it` +
        ` — at ${r.solidNotDrawn.slice(0, 6).map((p) => p.join(',')).join('  ')}`,
    );
  }

  // --- the game's collision against the shipped model's, cell for cell ------
  //
  // Two implementations of one model — the build's and the game's — swept over
  // the same 5.8 M points. They must agree everywhere except where the scene
  // registered a footprint by hand, and *that* difference is accounted for
  // object by object rather than allowed for by a threshold.
  {
    const bits = Buffer.from(r.solidB64, 'base64');
    const N = r.N;
    const structures = r.structures.map((ring) => Float64Array.from(ring));
    const inStructure = (x, z) => {
      for (const ring of structures) {
        let inside = false;
        const n = ring.length / 2;
        for (let i = 0, j = n - 1; i < n; j = i++) {
          const xi = ring[i * 2];
          const zi = ring[i * 2 + 1];
          const xj = ring[j * 2];
          const zj = ring[j * 2 + 1];
          if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
        }
        if (inside) return true;
      }
      return false;
    };

    let explained = 0;
    let unexplained = 0;
    const examples = [];
    for (let j = 0; j < N; j++) {
      const z = -r.O + j * r.step;
      for (let i = 0; i < N; i++) {
        const x = -r.O + i * r.step;
        const k = j * N + i;
        const runtime = (bits[k >> 3] >> (k & 7)) & 1;
        const shipped = col.blockedAt(x, z) ? 1 : 0;
        if (runtime === shipped) continue;
        if (runtime === 1 && inStructure(x, z)) explained++;
        else {
          unexplained++;
          if (examples.length < 6) examples.push(`${x.toFixed(1)},${z.toFixed(1)}`);
        }
      }
    }
    const m2 = (n) => Math.round(n * r.step * r.step);
    console.log(
      `  game vs shipped model over ${N * N} cells: ${m2(explained)} m² is the ` +
        `${structures.length} hand-modelled structures, ${m2(unexplained)} m² is unexplained`,
    );
    if (unexplained > 0) {
      fail(
        `the game's collision and the build's differ over ${m2(unexplained)} m² that no ` +
          `registered structure accounts for — ${examples.join('  ')}`,
      );
    }
  }
});

server.close();
console.log(bad ? '\n✗ TOWN MODEL GATE FAILED' : '\n✓ drawn ≡ solid, over the whole venue');
process.exit(bad ? 1 : 0);
