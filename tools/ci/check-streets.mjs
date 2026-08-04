#!/usr/bin/env node
/**
 * The street graph, judged — offline against the model, and then in the running
 * game against the course it set.
 *
 * PLAN-KRUMLOV-V2 §3. Phase 1's gate reads the scene graph and asks what stops
 * you; phase 2's re-derives the passable space cell for cell. This one does the
 * same for the network, and then asks the one question neither of those can:
 * **is the course that ships actually set on it?**
 *
 * ---------------------------------------------------------------------------
 * Why the runtime phase is not optional
 * ---------------------------------------------------------------------------
 *
 * D-039's own lesson, and it cost that phase a re-roll to learn: *"anything
 * that asserts a property of `blockedAt` should say whose `blockedAt` it
 * means."* A graph that is walkable offline says nothing about whether the
 * course generator consulted it — phase 1 made `SprintScene.blockedAt` one call
 * into the model while `Race.step` went on colliding against a raster, and
 * every offline assertion was true throughout. So the properties that matter
 * here are read out of `RaceController.courseInfo.street`, which is the report
 * the setter wrote while it was setting, on the course the player gets.
 *
 * Usage: node tools/ci/check-streets.mjs [--venue krumlov] [--offline]
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readModel, colliders } from '../terrain/townmodel.mjs';
import { buildGraph, sweepGraph, readGraph, waysOf } from '../terrain/streetgraph.mjs';
import { serve, withChrome, openTab } from './chrome.mjs';
import { makeCourseAudit, auditTable } from './check-passable.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../..');
const DIST = resolve(ROOT, 'dist');

const VENUES = {
  krumlov: { data: 'public/data/krumlov', scene: 'sprint', discipline: 'sprint', radiusM: 600 },
};

/**
 * What the graph has to be, stated here rather than read out of the artefact.
 *
 * A gate that reads the build's own numbers cannot catch a wrong number — the
 * argument `COURSE_LENGTH_M` in check-race.mjs is written on, and the one
 * regression this venue has actually had.
 */
const LIMITS = {
  /**
   * Blocked edges. **Zero, with no tolerance.**
   *
   * An edge is a claim that the athlete can run along it, and every fault in
   * PLAN-KRUMLOV-V2 §1 was small in area and total in consequence. A tolerance
   * here is a tolerance on "the network the course is set on is real".
   */
  blockedEdges: 0,
  /**
   * How much of the network the arena's own component must hold.
   *
   * Not one component — D-039 established that for the passable space and it
   * holds here for the same reason: Krumlov has streets inside walled ground
   * and across water whose only link runs outside the playable square. What
   * would be a fault is the network *fragmenting*, which is what a severed
   * bridge looks like on a graph, and 95 % is far below the 98.6 % measured and
   * far above the ~60 % a lost Vltava crossing would give.
   */
  minMainFraction: 0.95,
  /** How far the start and the finish may sit off the network. `courseGen`'s own. */
  maxEndpointOffNetworkM: 2.5,
  /** Metres of clear straight running out of the start toward control 1. */
  minStartRunOutM: 25,
  /** D-037's per-leg detour limit, on the graph the course was set on. */
  maxLegDetour: 3.0,
  /** D-037's measurement allowance: under this much excess, no ratio is judged. */
  minDetourExcessM: 40,
  /** A sprint is not a sprint under this. `check-race.mjs`'s own floor. */
  minControls: 12,
};

function fail(msg) {
  console.error(`✗ ${msg}`);
  process.exitCode = 1;
}

// ---------------------------------------------------------------------------
// Offline — the artefact against the model it claims to describe
// ---------------------------------------------------------------------------

function offlinePhase(venueId) {
  const cfg = VENUES[venueId];
  const dataDir = resolve(ROOT, cfg.data);
  if (!existsSync(join(dataDir, 'streets.bin'))) {
    fail(`${cfg.data}/streets.bin missing — run tools/terrain/streetgraph.mjs`);
    return null;
  }
  const { header, graph } = readGraph(dataDir);
  const { header: modelHeader, model } = readModel(dataDir);
  const col = colliders(model);

  // 1. The file describes the model the game loads.
  if (header.modelBytes !== modelHeader.bytes) {
    fail(
      `streets.bin was derived from a ${header.modelBytes}-byte townmodel.bin and the shipped ` +
        `one is ${modelHeader.bytes} bytes — run tools/terrain/streetgraph.mjs`,
    );
  }

  // 2. Every edge, swept. Not sampled.
  const swept = sweepGraph(col, graph);
  if (swept.bad.length > LIMITS.blockedEdges) {
    fail(
      `${swept.bad.length} edge(s) of the shipped graph run through something the model blocks — ` +
        `first at (${swept.bad[0].at.join(', ')}). The network is not the town.`,
    );
  }

  // 3. Every node an edge actually meets stands on ground.
  //
  // *An edge meets*, and the qualifier is the finding rather than a let-out.
  // The derivation keeps a junction OSM put inside a building — 22 of 1937 —
  // when it cannot walk it out to open ground within `NODE_RESCUE_M`; what it
  // does instead is stop that junction's edges short of it, so the athlete
  // meets a dead end where the arch is. Those nodes carry no edges, nothing can
  // be routed through them, and a control cannot be sited on them. Asserting
  // over all nodes would be asserting that OSM is right about the town, which
  // is the premise this whole file exists to refuse.
  let blockedNodes = 0;
  let orphanNodes = 0;
  for (const n of graph.nodes) {
    if (!n.edges.length) {
      orphanNodes++;
      continue;
    }
    if (col.blockedAt(n.x, n.z)) blockedNodes++;
  }
  if (blockedNodes) {
    fail(`${blockedNodes} junction(s) with edges on them are inside something solid`);
  }

  // 4. The derivation is reproducible: rebuild it and compare.
  //
  // Edge for edge and vertex for vertex, which is what `check-passable` does
  // cell for cell with the passable space. A shipped artefact that the tool no
  // longer produces is an artefact nobody can reason about — it may have been
  // built from a different town, a different tool, or by hand.
  const town = JSON.parse(readFileSync(join(dataDir, 'townscape.json'), 'utf8'));
  const rebuilt = buildGraph(col, waysOf(town), {
    playableR: modelHeader.playableR,
    arena: header.arena,
  });
  let differ = 0;
  if (rebuilt.edges.length !== graph.edges.length || rebuilt.nodes.length !== graph.nodes.length) {
    differ = Math.abs(rebuilt.edges.length - graph.edges.length) + 1;
  } else {
    for (let i = 0; i < rebuilt.edges.length; i++) {
      const a = rebuilt.edges[i];
      const b = graph.edges[i];
      if (a.a !== b.a || a.b !== b.b || a.kind !== b.kind || a.pts.length !== b.pts.length) {
        differ++;
        continue;
      }
      for (let k = 0; k < a.pts.length; k++) {
        if (Math.abs(a.pts[k] - b.pts[k]) > 0.011) {
          differ++;
          break;
        }
      }
    }
  }
  if (differ) {
    fail(
      `re-deriving the graph from the shipped model gives ${differ} edge(s) that differ from ` +
        `streets.bin — the artefact is not what the tool produces`,
    );
  }

  // 5. The network holds together.
  if (header.mainFraction < LIMITS.minMainFraction) {
    fail(
      `the arena's component holds ${(header.mainFraction * 100).toFixed(1)} % of the network, ` +
        `under ${(LIMITS.minMainFraction * 100).toFixed(0)} % — the town has fragmented`,
    );
  }

  console.log(
    `  ${header.nodes} nodes · ${header.edges} edges · ${(header.lengthM / 1000).toFixed(2)} km ` +
      `(${(header.sitableLengthM / 1000).toFixed(2)} km sitable)`,
  );
  console.log(
    `  swept at ${header.sweepM} m against the model: ${swept.bad.length} blocked edge(s) over ` +
      `${swept.samples} samples · ${blockedNodes} junctions with edges inside anything ` +
      `(${orphanNodes} orphans, the ones the model contradicts)`,
  );
  console.log(
    `  re-derived from the shipped model: ${differ} edge(s) differ of ${graph.edges.length}`,
  );
  console.log(
    `  ${header.components} components; the arena's holds ${(header.mainFraction * 100).toFixed(1)} % ` +
      `of the length`,
  );
  return { header, graph, col };
}

// ---------------------------------------------------------------------------
// The running game — the course that ships, on the network that set it
// ---------------------------------------------------------------------------

const PROBE = `JSON.stringify({
  id: window.__race.course.id,
  controls: window.__race.course.controls.length,
  lengthM: window.__race.course.lengthM,
  street: window.__race.courseInfo.street,
  arenaFaults: window.__race.courseInfo.arenaFaults,
  dropped: window.__race.courseInfo.droppedControls,
  graph: window.__world.streets
    ? { nodes: window.__world.streets.meta.nodes, edges: window.__world.streets.meta.edges,
        modelBytes: window.__world.streets.meta.modelBytes,
        warnings: window.__world.streets.warnings }
    : null,
  points: [{ x: window.__race.course.start.x, z: window.__race.course.start.z }]
    .concat(window.__race.course.controls.map((c) => ({ x: c.position.x, z: c.position.z })))
    .concat([{ x: window.__race.course.finish.x, z: window.__race.course.finish.z }]),
})`;

async function runtimePhase(venueId, offline) {
  const cfg = VENUES[venueId];
  if (!existsSync(DIST)) {
    fail('dist/ not found — run `npm run build` first');
    return;
  }
  const port = 8300 + Math.floor(Math.random() * 400);
  const server = await serve(DIST, port);
  let res = null;
  try {
    await withChrome(async (cdpPort) => {
      // No `&seed=`, so this is `COURSE_SEED` — the course the player gets.
      const url = `http://127.0.0.1:${port}/?scene=${cfg.scene}&race=1&debug=0&tier=high&discipline=${cfg.discipline}`;
      const tab = await openTab(cdpPort, url);
      const ready = await tab.waitFor('!!(window.__race && window.__world)', 90_000);
      if (!ready) {
        fail('the venue never mounted');
        await tab.close();
        return;
      }
      res = JSON.parse(await tab.evaluate(PROBE));
      await tab.close();
    });
  } finally {
    server.close();
  }
  if (!res) return;

  console.log(`\n  ${res.id} — ${res.controls} controls, ${res.lengthM} m`);
  if (!res.graph) {
    fail('the running game holds no street graph — SprintScene did not load streets.bin');
    return;
  }
  for (const w of res.graph.warnings ?? []) fail(`the graph the game loaded: ${w}`);
  if (offline && res.graph.modelBytes !== offline.header.modelBytes) {
    fail('the graph the game loaded is not the shipped one');
  }
  if (!res.street) {
    fail('the course was set with no street network — `FieldTerrain.network` was undefined');
    return;
  }
  if (res.dropped > 0) fail(`${res.dropped} control(s) were dropped as unreachable`);
  for (const f of res.arenaFaults) fail(`arena: ${f}`);
  if (res.controls < LIMITS.minControls) {
    fail(`${res.controls} controls, under the ${LIMITS.minControls} a sprint is set at`);
  }

  // --- fault 8, twice -------------------------------------------------------
  const off = res.street.offNetworkM;
  for (const [name, d] of [['start', off.start], ['finish', off.finish]]) {
    if (d > LIMITS.maxEndpointOffNetworkM) {
      fail(
        `the ${name} is ${d.toFixed(1)} m off the street network, over ` +
          `${LIMITS.maxEndpointOffNetworkM} m. A sprint ${name === 'start' ? 'starts' : 'finishes'} ` +
          `on the street.`,
      );
    }
  }
  if (res.street.startRunOutM < LIMITS.minStartRunOutM) {
    fail(
      `the athlete runs ${res.street.startRunOutM.toFixed(1)} m out of the start toward control 1 ` +
        `before something stops them, under ${LIMITS.minStartRunOutM} m. This is the client's ` +
        `"you run out and there's a wall straight away".`,
    );
  }
  console.log(
    `  start ${off.start.toFixed(1)} m off the network, finish ${off.finish.toFixed(1)} m; ` +
      `run-out ${res.street.startRunOutM.toFixed(1)} m`,
  );

  // --- the setter's own limit may not be looser than this gate's -------------
  if (res.street.limit > LIMITS.maxLegDetour) {
    fail(
      `the setter accepts legs up to ${res.street.limit}× and this gate allows ` +
        `${LIMITS.maxLegDetour}× — a setter whose acceptance test is looser than the judge's is ` +
        `shopping for rejects`,
    );
  }

  // --- the legs, on the graph and on the athlete's own space -----------------
  //
  // Both, and the leg is only a fault if **both** say so. Each is an upper
  // bound on the shortest route the athlete could actually run and neither
  // dominates the other: the graph is confined to a network drawn inside the
  // open space, and the 0.5 m lattice cannot express a doorway narrower than
  // its own diagonal (D-039). A route exhibited by either one is a route, and
  // "the flag is in sight and the way to it is a lap of the venue" is only true
  // when there is no short route at all.
  const audit = makeCourseAudit(venueId, 'runnability.bin', { radiusM: cfg.radiusM });
  const a = audit(res.points);
  const graphDetour = res.street.legDetour;
  const rows = a.rows.map((r, i) => {
    const g = graphDetour[i];
    const gm = g === null || g === undefined ? Infinity : g * r.straightM;
    const bestM = Math.min(r.walkedM >= 0 ? r.walkedM : Infinity, gm);
    return {
      ...r,
      graphDetour: g === null ? Infinity : g,
      bestM,
      bestDetour: r.straightM > 0 ? Math.max(1, bestM / r.straightM) : 1,
    };
  });
  console.log('\n' + auditTable(a, '    '));
  console.log(`    on the graph: ${graphDetour.map((d) => (d === null ? '∞' : `${d.toFixed(1)}×`)).join(' ')}`);

  // A control inside a wall is not a routing question and the graph has nothing
  // to say about it, so those faults come straight from the audit.
  for (const p of a.sealed) {
    fail(`control ${p} is sealed — no open ground within 3 m of where it is sited`);
  }
  if (a.unreachableFromStart.length) {
    fail(
      `control(s) ${a.unreachableFromStart.join(', ')} cannot be reached from the start at all`,
    );
  }
  for (const r of rows) {
    if (r.status !== 'ok' && !Number.isFinite(r.graphDetour)) {
      fail(`leg ${r.name} has no route between its ends on either measure`);
      continue;
    }
    if (r.bestM - r.straightM < LIMITS.minDetourExcessM) continue;
    if (r.bestDetour <= LIMITS.maxLegDetour) continue;
    fail(
      `leg ${r.name} runs ${Math.round(r.bestM)} m for a ${Math.round(r.straightM)} m straight ` +
        `line — ${r.bestDetour.toFixed(1)}×, over ${LIMITS.maxLegDetour.toFixed(1)}× on both the ` +
        `graph and the athlete's own space`,
    );
  }
  const worst = rows.reduce((m, r) => Math.max(m, Number.isFinite(r.bestDetour) ? r.bestDetour : 0), 0);
  console.log(
    `    worst leg ${worst.toFixed(1)}× against a ${LIMITS.maxLegDetour.toFixed(1)}× limit, ` +
      `taking the shorter of the two measures`,
  );
}

async function main() {
  const args = process.argv.slice(2);
  const i = args.indexOf('--venue');
  const venueId = i >= 0 && args[i + 1] ? args[i + 1] : 'krumlov';
  if (!VENUES[venueId]) {
    console.error(`✗ unknown venue "${venueId}"`);
    process.exit(2);
  }
  console.log(`The street graph — ${venueId}\n`);
  const offline = offlinePhase(venueId);
  if (!args.includes('--offline')) await runtimePhase(venueId, offline);
  if (process.exitCode) console.error('\n✗ street graph check FAILED');
  else console.log('\n✓ street graph OK');
}

main().catch((e) => {
  console.error('✗', e);
  process.exit(2);
});
