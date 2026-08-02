/**
 * The five things that make a screenshot say "Krumlov".
 *
 * Everything else in this venue is derived — footprints from OSM, heights from
 * ČÚZK LiDAR, roofs from a pitch fit. That process is right for 1734 burgher
 * houses and wrong for the handful of objects the town is actually known by. A
 * generic extrusion of `Zámecká věž` is a 54.5 m cylinder with a hip on it; the
 * real thing is a stone plinth, a painted Renaissance shaft, an open arcaded
 * gallery and a green copper cupola, and *that* is what a person recognises
 * from a single frame.
 *
 * Built procedurally in TypeScript rather than in Blender, deliberately:
 *
 *  - Every one of these sits on a measured footprint and a measured ground
 *    elevation. A `.glb` would have to carry that placement as side metadata
 *    and the two would drift; here the geometry is generated *from* the data
 *    that positions it.
 *  - They are lathes, prisms and arcades — the shapes three.js already makes.
 *    `tools/blender/` earns its keep on organic geometry (a spruce is 18 904
 *    triangles of foliage cards) and buys nothing on a cylinder.
 *  - It leaves the Blender LOD0 budget (60 000, ~47 000 spent) untouched for
 *    the assets that need it.
 *
 * Total cost of this file is about 6 400 triangles, drawn once, never
 * instanced, and visible from most of the town — which is the point.
 */

import * as THREE from 'three';
import type { TerrainField } from './terrain';
import type { BuildingRecord, SurfaceTextures } from './buildings';

// ---------------------------------------------------------------------------
// Placement, measured
// ---------------------------------------------------------------------------

/**
 * Positions are OSM footprint centroids in the venue's world frame, and heights
 * are ČÚZK. Written out rather than looked up so the numbers are auditable.
 */
export const KRUMLOV_LANDMARKS = {
  /** Zámecká věž — OSM way 39231600, `height=54.5` surveyed. */
  castleTower: { x: 67.7, z: -158.3, radius: 5.9, height: 54.5, osmId: 39231600 },
  /**
   * Plášťový most — OSM way 32074958 (the deck) over way 39231535 (the
   * viaduct). Spans the ravine between the upper castle and the theatre.
   */
  cloakBridge: {
    ax: -127.7,
    az: -194.8,
    bx: -159.7,
    bz: -188.6,
    width: 6.4,
    osmId: 39231535,
  },
  /**
   * Kostel svatého Víta — the tower is the tallest CHM cell inside OSM way
   * 60570914, at 50.4 m above a 499.3 m ground.
   */
  stVitus: { x: 59, z: 83, height: 50.4, osmId: 60570914 },
  /** Náměstí Svornosti — the Marian plague column, OSM node 8123587974. */
  marianColumn: { x: -5.4, z: 46.9 },
  /** The square's fountain, at its foot. */
  fountain: { x: -2.6, z: 41.2 },
} as const;

/**
 * Corrections applied to the generic extrusion before it runs.
 *
 * Only two, and both for the same reason: the OSM footprint covers nave *and*
 * tower as one polygon, so the pitch fit sees a 50 m spire inside a 12 m nave
 * and splits the difference. The nave is given its real proportions here and
 * the tower is built separately below.
 */
export const KRUMLOV_OVERRIDES = new Map<number, Partial<BuildingRecord>>([
  // svatý Vít: nave eave and ridge, measured off the CHM excluding the tower.
  [60570914, { e: 512.5, r: 522.0, s: 1, a: -92 }],
]);

/** Footprints the generic builder must not draw, because this file draws them. */
export const KRUMLOV_SKIP: ReadonlySet<number> = new Set([
  KRUMLOV_LANDMARKS.castleTower.osmId,
]);

// ---------------------------------------------------------------------------
// Materials
// ---------------------------------------------------------------------------

interface Palette {
  plaster: THREE.MeshStandardMaterial;
  paint: THREE.MeshStandardMaterial;
  stone: THREE.MeshStandardMaterial;
  copper: THREE.MeshStandardMaterial;
  tile: THREE.MeshStandardMaterial;
  gold: THREE.MeshStandardMaterial;
  timber: THREE.MeshStandardMaterial;
}

/**
 * The tower's painted shaft.
 *
 * The Zámecká věž is not a coloured cylinder — it is covered in illusionistic
 * Renaissance painting: horizontal cornice bands, faux ashlar, and a register
 * of painted pilasters. Modelling that as geometry would cost more than the
 * whole rest of the file; a banded pattern keyed to the world-space height and
 * the angle around the shaft costs one fragment branch and reads correctly from
 * the fifty metres away it is normally seen from.
 */
function makePaintedMaterial(): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({
    color: 0xe3c9b4,
    roughness: 0.88,
    metalness: 0,
  });
  mat.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vPaintPos;')
      .replace(
        '#include <worldpos_vertex>',
        '#include <worldpos_vertex>\nvPaintPos = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;',
      );
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vPaintPos;')
      .replace(
        '#include <map_fragment>',
        /* glsl */ `
        #include <map_fragment>
        {
          float ang = atan( vPaintPos.z, vPaintPos.x );
          float y = vPaintPos.y;

          // Cornice bands every 5.5 m, and they are *drawn*, not suggested.
          //
          // The first pass mixed a 0.6-weight shadow line over a 6 m period and
          // from the square — 190 m away and about eighty pixels of shaft — the
          // whole thing averaged to plain cream. The real Zámecká věž is one of
          // the boldest pieces of Renaissance illusionism in Bohemia: strong
          // dark-red and ochre horizontals, a register of painted pilasters,
          // faux ashlar at the foot. At this distance the only thing that
          // survives is contrast, so the contrast is what is painted.
          float band = abs( fract( y / 5.5 ) - 0.5 ) * 2.0;
          float cornice = 1.0 - smoothstep( 0.72, 0.90, band );
          // A thin white fillet immediately under each dark band, which is what
          // makes the horizontal read as a moulding rather than as a stain.
          float fillet = ( 1.0 - smoothstep( 0.60, 0.70, band ) )
                       - ( 1.0 - smoothstep( 0.70, 0.74, band ) );

          // Painted pilasters: sixteen round the shaft, ochre with a shadowed
          // edge, so the shaft reads as modelled from any angle.
          float bayF = fract( ang * 16.0 / 6.28318 );
          float bay = abs( bayF - 0.5 ) * 2.0;
          float pilaster = smoothstep( 0.50, 0.72, bay );
          float edge = ( 1.0 - smoothstep( 0.40, 0.52, bay ) );

          // Faux ashlar in the lower register only, as on the real tower.
          float ashlar = ( 1.0 - smoothstep( 8.0, 11.5, y ) )
                       * step( 0.86, abs( fract( y * 1.2 ) - 0.5 ) * 2.0 );

          vec3 ochre  = vec3( 0.72, 0.47, 0.24 );
          vec3 oxblood = vec3( 0.40, 0.16, 0.13 );
          vec3 lime   = vec3( 0.93, 0.90, 0.83 );
          diffuseColor.rgb = mix( diffuseColor.rgb, ochre, pilaster * 0.80 );
          diffuseColor.rgb = mix( diffuseColor.rgb, oxblood, max( edge * 0.45, cornice * 0.85 ) );
          diffuseColor.rgb = mix( diffuseColor.rgb, lime, fillet * 0.7 );
          diffuseColor.rgb *= 1.0 - ashlar * 0.26;
        }
        `,
      );
  };
  mat.customProgramCacheKey = () => 'krumlov-painted';
  return mat;
}

/**
 * Re-tile a shared surface map for geometry with unit UVs.
 *
 * `loadSurface` sets `repeat = 1/physicalSize` because everything that uses it
 * authors UVs in world metres. Lathes, cylinders and boxes do not — their UVs
 * run 0..1 across a face — so the shared texture came out magnified by the
 * physical tile size: the Marian column's plinth showed a *third* of a 3 m
 * granite tile stretched over 3 m of stone, which at the foot of the arena, in
 * the middle of the frame the sprint starts on, was a boulder with a column on
 * it. Cloning shares the image and costs only the sampler state.
 */
function retile(t: THREE.Texture | undefined, repeat: number): THREE.Texture | null {
  if (!t) return null;
  const c = t.clone();
  c.wrapS = THREE.RepeatWrapping;
  c.wrapT = THREE.RepeatWrapping;
  c.repeat.set(repeat, repeat);
  c.needsUpdate = true;
  return c;
}

function makePalette(stone?: SurfaceTextures): Palette {
  return {
    plaster: new THREE.MeshStandardMaterial({ color: 0xe9dcc6, roughness: 0.93, metalness: 0 }),
    paint: makePaintedMaterial(),
    // The ashlar map off the shared texture set. Untextured, the cloak bridge's
    // five tiers of arcading read as a grey concrete viaduct, which is the one
    // thing it must not look like.
    stone: new THREE.MeshStandardMaterial({
      color: stone ? 0xb4aa9c : 0x9d968a,
      map: retile(stone?.albedo, 2.5),
      normalMap: retile(stone?.normal, 2.5),
      roughnessMap: retile(stone?.roughness, 2.5),
      roughness: 0.95,
      metalness: 0,
    }),
    // Oxidised copper. OSM carries `roof:colour=#6EBE9F` on the tower, surveyed.
    copper: new THREE.MeshStandardMaterial({ color: 0x6ebe9f, roughness: 0.42, metalness: 0.35 }),
    tile: new THREE.MeshStandardMaterial({ color: 0xa8503a, roughness: 0.88, metalness: 0 }),
    gold: new THREE.MeshStandardMaterial({ color: 0xc9a227, roughness: 0.3, metalness: 0.85 }),
    timber: new THREE.MeshStandardMaterial({ color: 0x6b5238, roughness: 0.9, metalness: 0 }),
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mesh(
  geo: THREE.BufferGeometry,
  mat: THREE.Material,
  x: number,
  y: number,
  z: number,
  rotY = 0,
): THREE.Mesh {
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, y, z);
  m.rotation.y = rotY;
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

/** A drum: cylinder with the given radii, centred on its own mid-height. */
function drum(rTop: number, rBottom: number, h: number, seg: number): THREE.CylinderGeometry {
  return new THREE.CylinderGeometry(rTop, rBottom, h, seg, 1, true);
}

// ---------------------------------------------------------------------------
// The tower
// ---------------------------------------------------------------------------

/**
 * Zámecká věž — the single most recognisable object in the town.
 *
 * Built as a stack, bottom to top, at the real 54.5 m:
 *   0.0 – 11 m   square stone base, tapering — the medieval core
 *  11.0 – 33 m   round painted shaft
 *  33.0 – 36 m   corbel course, stepped out
 *  36.0 – 40 m   open arcaded gallery, 12 columns and arches
 *  40.0 – 43 m   attic drum with the clock stage
 *  43.0 – 50 m   copper onion dome
 *  50.0 – 53 m   lantern, glazed and open-sided
 *  53.0 – 54.5 m finial and cross
 */
function buildCastleTower(group: THREE.Group, field: TerrainField, p: Palette): number {
  const L = KRUMLOV_LANDMARKS.castleTower;
  const base = field.heightAt(L.x, L.z) - 0.6;
  const R = L.radius;
  let tris = 0;

  const add = (g: THREE.BufferGeometry, m: THREE.Material, y: number, rotY = 0): void => {
    group.add(mesh(g, m, L.x, base + y, L.z, rotY));
    const idx = g.getIndex();
    tris += idx ? idx.count / 3 : g.getAttribute('position').count / 3;
  };

  // --- square medieval base ---
  const baseH = 11;
  const sq = new THREE.CylinderGeometry(R * 1.05, R * 1.18, baseH, 4, 1, false);
  add(sq, p.stone, baseH / 2, Math.PI / 4);

  // --- painted round shaft ---
  const shaftH = 22;
  add(drum(R * 0.92, R * 1.02, shaftH, 24), p.paint, baseH + shaftH / 2);

  // --- corbel course ---
  add(drum(R * 1.24, R * 0.94, 1.4, 24), p.stone, 33.7);
  add(drum(R * 1.24, R * 1.24, 1.6, 24), p.paint, 35.2);

  // --- arcaded gallery ---
  const galleryY = 36.0;
  const galleryH = 4.0;
  const columns = 12;
  const colGeo = new THREE.CylinderGeometry(0.24, 0.28, galleryH, 6);
  const archGeo = new THREE.TorusGeometry(0.86, 0.17, 4, 8, Math.PI);
  for (let i = 0; i < columns; i++) {
    const a = (i / columns) * Math.PI * 2;
    const cx = L.x + Math.cos(a) * R * 1.16;
    const cz = L.z + Math.sin(a) * R * 1.16;
    const col = new THREE.Mesh(colGeo, p.plaster);
    col.position.set(cx, base + galleryY + galleryH / 2, cz);
    col.castShadow = true;
    col.receiveShadow = true;
    group.add(col);
    tris += 44;

    // Arch spanning to the next column.
    const mid = a + Math.PI / columns;
    const arch = new THREE.Mesh(archGeo, p.plaster);
    arch.position.set(
      L.x + Math.cos(mid) * R * 1.16,
      base + galleryY + galleryH - 0.3,
      L.z + Math.sin(mid) * R * 1.16,
    );
    arch.rotation.y = -mid + Math.PI / 2;
    arch.castShadow = true;
    group.add(arch);
    tris += 64;
  }
  // Gallery floor and its cornice.
  add(new THREE.CylinderGeometry(R * 1.3, R * 1.3, 0.5, 24), p.stone, galleryY - 0.25);
  add(new THREE.CylinderGeometry(R * 1.28, R * 1.34, 0.9, 24), p.plaster, galleryY + galleryH + 0.45);

  // --- clock stage ---
  add(drum(R * 0.98, R * 1.08, 3.0, 16), p.paint, 42.4);
  add(new THREE.CylinderGeometry(R * 1.02, R * 1.02, 0.4, 16), p.stone, 44.1);

  // --- onion dome ---
  // A lathe, because an onion is exactly a profile of revolution and nothing
  // else gives you the reverse curve at the shoulder.
  const dome: THREE.Vector2[] = [
    new THREE.Vector2(R * 1.0, 0),
    new THREE.Vector2(R * 1.16, 0.9),
    new THREE.Vector2(R * 1.14, 2.2),
    new THREE.Vector2(R * 0.92, 3.6),
    new THREE.Vector2(R * 0.58, 4.9),
    new THREE.Vector2(R * 0.30, 5.9),
    new THREE.Vector2(R * 0.16, 6.6),
    new THREE.Vector2(0.02, 7.0),
  ];
  add(new THREE.LatheGeometry(dome, 20), p.copper, 44.3);

  // --- lantern ---
  const lanternY = 50.6;
  add(drum(1.35, 1.5, 2.2, 8), p.plaster, lanternY + 1.1);
  const lanternRoof: THREE.Vector2[] = [
    new THREE.Vector2(1.7, 0),
    new THREE.Vector2(1.5, 0.5),
    new THREE.Vector2(0.85, 1.15),
    new THREE.Vector2(0.3, 1.7),
    new THREE.Vector2(0.02, 2.0),
  ];
  add(new THREE.LatheGeometry(lanternRoof, 14), p.copper, lanternY + 2.2);

  // --- finial ---
  add(new THREE.CylinderGeometry(0.06, 0.06, 1.4, 6), p.gold, 55.0);
  add(new THREE.SphereGeometry(0.3, 8, 6), p.gold, 54.2);

  return tris;
}

// ---------------------------------------------------------------------------
// The cloak bridge
// ---------------------------------------------------------------------------

/**
 * Plášťový most.
 *
 * The one piece of Krumlov that photographs as a single object: a multi-storey
 * arcaded stone bridge thrown across the ravine between the upper castle and the
 * Baroque theatre, with a covered corridor running along the top of it. The
 * arcade tiers are what read — a plain deck on piers would be any bridge
 * anywhere.
 *
 * Pier feet are sampled off the DMR, so the arcade genuinely stands on the
 * ravine floor rather than on a guessed datum.
 */
function buildCloakBridge(group: THREE.Group, field: TerrainField, p: Palette): number {
  const L = KRUMLOV_LANDMARKS.cloakBridge;
  const dx = L.bx - L.ax;
  const dz = L.bz - L.az;
  const len = Math.hypot(dx, dz);
  const yaw = Math.atan2(dx, dz);
  const cx = (L.ax + L.bx) / 2;
  const cz = (L.az + L.bz) / 2;

  // The deck sits just above the higher abutment; the corridor rides on it.
  const deck = Math.max(field.heightAt(L.ax, L.az), field.heightAt(L.bx, L.bz)) + 1.6;
  const w = L.width;
  let tris = 0;

  const local = (t: number): { x: number; z: number } => ({
    x: L.ax + dx * t,
    z: L.az + dz * t,
  });

  const push = (m: THREE.Mesh, count: number): void => {
    m.castShadow = true;
    m.receiveShadow = true;
    group.add(m);
    tris += count;
  };

  // --- piers, standing on the measured ravine floor ---
  const bays = 5;
  const pierGeo = new THREE.BoxGeometry(1, 1, 1);
  for (let i = 1; i < bays; i++) {
    const t = i / bays;
    const q = local(t);
    const foot = field.heightAt(q.x, q.z) - 1.0;
    const h = deck - foot - 0.9;
    if (h < 1) continue;
    const pier = new THREE.Mesh(pierGeo, p.stone);
    pier.position.set(q.x, foot + h / 2, q.z);
    pier.scale.set(2.4, h, w * 0.9);
    pier.rotation.y = yaw;
    push(pier, 12);
  }

  // --- three tiers of arches between the piers ---
  // Torus half-rings, one per bay per tier. This is the whole silhouette, and
  // it is what the bridge is recognised by, so it is worth resolving properly:
  // at 5 radial by 10 tubular segments a half-ring seen edge-on — which is how
  // it is seen from every street in Latrán — is a five-sided prism bent through
  // ten steps, i.e. a slab with corners. 8 × 20 costs 220 extra triangles per
  // arch over fifteen arches and is the difference between an arcade and a
  // concrete viaduct.
  const span = len / bays;
  const archGeo = new THREE.TorusGeometry(span * 0.42, 0.5, 8, 20, Math.PI);
  for (let tier = 0; tier < 3; tier++) {
    for (let i = 0; i < bays; i++) {
      const q = local((i + 0.5) / bays);
      const foot = field.heightAt(q.x, q.z);
      const y = foot + 4.5 + tier * 6.2;
      if (y > deck - 2.2) continue;
      const arch = new THREE.Mesh(archGeo, p.stone);
      arch.position.set(q.x, y, q.z);
      arch.rotation.set(0, yaw + Math.PI / 2, 0);
      push(arch, 320);
      // Spandrel wall above the arch, so the tier reads as masonry not as a
      // floating ring.
      const wall = new THREE.Mesh(pierGeo, p.stone);
      wall.position.set(q.x, y + span * 0.42 + 1.0, q.z);
      wall.scale.set(span * 0.98, 2.0, w * 0.8);
      wall.rotation.y = yaw;
      push(wall, 12);
    }
  }

  // --- deck ---
  const deckGeo = new THREE.BoxGeometry(len, 1.2, w);
  const deckMesh = new THREE.Mesh(deckGeo, p.stone);
  deckMesh.position.set(cx, deck - 0.6, cz);
  deckMesh.rotation.y = yaw + Math.PI / 2;
  push(deckMesh, 12);

  // --- the cloak: a covered corridor, two storeys, with a tile roof ---
  const corridorH = 3.4;
  for (let storey = 0; storey < 2; storey++) {
    const y = deck + storey * corridorH;
    const body = new THREE.Mesh(new THREE.BoxGeometry(len, corridorH, w * 0.78), p.plaster);
    body.position.set(cx, y + corridorH / 2, cz);
    body.rotation.y = yaw + Math.PI / 2;
    push(body, 12);
  }
  const roofTop = deck + corridorH * 2;
  const roof = new THREE.Mesh(
    new THREE.CylinderGeometry(w * 0.42, w * 0.42, len, 3, 1, false),
    p.tile,
  );
  roof.position.set(cx, roofTop + w * 0.2, cz);
  roof.rotation.set(0, yaw + Math.PI / 2, Math.PI / 2);
  push(roof, 8);

  return tris;
}

// ---------------------------------------------------------------------------
// St Vitus
// ---------------------------------------------------------------------------

/**
 * The tower and spire of kostel svatého Víta.
 *
 * The nave comes from the generic extrusion (with corrected proportions, see
 * `KRUMLOV_OVERRIDES`); this is the west tower, whose neo-Gothic spire is the
 * old town's counterweight to the castle tower on the skyline. 50.4 m is the
 * tallest CHM cell inside the church footprint, so this is a measured height
 * even though the shape is drawn by hand.
 */
function buildStVitus(group: THREE.Group, field: TerrainField, p: Palette): number {
  const L = KRUMLOV_LANDMARKS.stVitus;
  const base = field.heightAt(L.x, L.z) - 0.6;
  const yaw = Math.PI * 0.02;
  let tris = 0;

  const bodyH = L.height * 0.63;
  const body = mesh(
    new THREE.BoxGeometry(8.4, bodyH, 8.4),
    p.plaster,
    L.x,
    base + bodyH / 2,
    L.z,
    yaw,
  );
  group.add(body);
  tris += 12;

  // Belfry stage, slightly set back, with an open sound arcade on each face.
  const belfryY = base + bodyH;
  const belfry = mesh(
    new THREE.BoxGeometry(7.6, 6.0, 7.6),
    p.plaster,
    L.x,
    belfryY + 3.0,
    L.z,
    yaw,
  );
  group.add(belfry);
  tris += 12;

  const louvre = new THREE.BoxGeometry(2.4, 3.6, 0.4);
  for (let i = 0; i < 4; i++) {
    const a = yaw + (i / 4) * Math.PI * 2;
    const m = new THREE.Mesh(louvre, p.timber);
    m.position.set(L.x + Math.sin(a) * 3.85, belfryY + 3.2, L.z + Math.cos(a) * 3.85);
    m.rotation.y = a;
    m.castShadow = true;
    group.add(m);
    tris += 12;
  }

  // Cornice, then the octagonal spire to the measured top.
  const corniceY = belfryY + 6.0;
  group.add(
    mesh(new THREE.BoxGeometry(9.2, 0.8, 9.2), p.stone, L.x, corniceY + 0.4, L.z, yaw),
  );
  tris += 12;

  const spireBase = corniceY + 0.8;
  const spireH = base + L.height - spireBase;
  group.add(
    mesh(
      new THREE.ConeGeometry(4.6, spireH, 8, 1, false),
      p.tile,
      L.x,
      spireBase + spireH / 2,
      L.z,
      yaw + Math.PI / 8,
    ),
  );
  tris += 16;

  // Four corner pinnacles, which is what makes a spire read as neo-Gothic
  // rather than as a cone on a box.
  const pin = new THREE.ConeGeometry(0.75, 4.2, 6);
  for (let i = 0; i < 4; i++) {
    const a = yaw + Math.PI / 4 + (i / 4) * Math.PI * 2;
    const m = new THREE.Mesh(pin, p.stone);
    m.position.set(L.x + Math.sin(a) * 4.6, spireBase + 2.1, L.z + Math.cos(a) * 4.6);
    m.castShadow = true;
    group.add(m);
    tris += 12;
  }

  group.add(
    mesh(new THREE.CylinderGeometry(0.05, 0.05, 2.4, 5), p.gold, L.x, base + L.height + 1.2, L.z),
  );
  tris += 10;
  return tris;
}

// ---------------------------------------------------------------------------
// Náměstí Svornosti
// ---------------------------------------------------------------------------

/**
 * The Marian plague column and the fountain at its foot.
 *
 * The square itself is already there — its paved surface comes off the
 * runnability raster as cobble and its walls are the surrounding burgher
 * houses. What a square needs to *be* a square is a centrepiece, and Krumlov's
 * is the 1716 column with the fountain basin wrapped round its base.
 */
function buildSquare(group: THREE.Group, field: TerrainField, p: Palette): number {
  const C = KRUMLOV_LANDMARKS.marianColumn;
  const F = KRUMLOV_LANDMARKS.fountain;
  let tris = 0;

  const base = field.heightAt(C.x, C.z);

  // Stepped plinth.
  const steps = [
    { r: 3.2, h: 0.28 },
    { r: 2.6, h: 0.28 },
    { r: 2.1, h: 0.9 },
  ];
  let y = base;
  for (const s of steps) {
    group.add(mesh(new THREE.CylinderGeometry(s.r, s.r + 0.08, s.h, 8), p.stone, C.x, y + s.h / 2, C.z));
    tris += 32;
    y += s.h;
  }

  // Shaft and capital.
  group.add(mesh(new THREE.CylinderGeometry(0.42, 0.62, 8.2, 10), p.stone, C.x, y + 4.1, C.z));
  tris += 40;
  y += 8.2;
  group.add(mesh(new THREE.BoxGeometry(1.3, 0.5, 1.3), p.stone, C.x, y + 0.25, C.z, 0.4));
  tris += 12;
  // The gilded figure on top, read at 30 m as a bright vertical accent.
  group.add(mesh(new THREE.CylinderGeometry(0.16, 0.34, 2.1, 6), p.gold, C.x, y + 1.55, C.z));
  tris += 24;

  // Fountain: an octagonal basin, low, with a small central jet pillar. The
  // pillar was a six-sided prism, which at 1.1 m across is a hexagonal post you
  // stand next to at the start of every race in this venue.
  const fBase = field.heightAt(F.x, F.z);
  group.add(mesh(new THREE.CylinderGeometry(3.1, 3.1, 0.85, 8), p.stone, F.x, fBase + 0.4, F.z));
  tris += 32;
  group.add(mesh(new THREE.CylinderGeometry(0.4, 0.55, 1.9, 12), p.stone, F.x, fBase + 1.4, F.z));
  tris += 48;

  return tris;
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

export class Landmarks {
  readonly group = new THREE.Group();
  readonly stats = { triangles: 0, objects: 0 };
  private readonly palette: Palette;

  constructor(field: TerrainField, stone?: SurfaceTextures) {
    this.group.name = 'landmarks';
    this.palette = makePalette(stone);

    let tris = 0;
    tris += buildCastleTower(this.group, field, this.palette);
    tris += buildCloakBridge(this.group, field, this.palette);
    tris += buildStVitus(this.group, field, this.palette);
    tris += buildSquare(this.group, field, this.palette);

    this.stats.triangles = Math.round(tris);
    this.stats.objects = this.group.children.length;
  }

  dispose(): void {
    this.group.traverse((o) => {
      if (o instanceof THREE.Mesh) o.geometry.dispose();
    });
    // The stone material's maps are *clones* of the shared surface pack (see
    // `retile`), so they own GPU sampler state the pack will never release.
    // D-022 is the whole argument for being careful about this.
    for (const t of [
      this.palette.stone.map,
      this.palette.stone.normalMap,
      this.palette.stone.roughnessMap,
    ]) {
      t?.dispose();
    }
    for (const m of Object.values(this.palette)) m.dispose();
    this.group.clear();
  }
}
