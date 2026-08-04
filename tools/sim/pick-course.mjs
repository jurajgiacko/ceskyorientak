#!/usr/bin/env node
/**
 * Choose the course a venue races.
 *
 * A real event does not take the first course its planning software offers. A
 * setter generates, walks, and *picks*. Now that each venue has one fixed seed
 * rather than a new one every minute (`COURSE_SEED` in src/core/venues.ts),
 * picking is possible — and this is what did it, so that the choice is
 * reviewable rather than asserted.
 *
 * It loads the real game headless at several hundred candidate seeds, reads the
 * course the running generator produced, and scores it against the client's own
 * sentence:
 *
 *   *"Always the same course. Starts at the start, finishes at the finish.
 *   Runs through the alleys."*
 *
 *  1. **Always the same** — a property of the fix, not of the seed. Every
 *     candidate satisfies it. Not scored.
 *  2. **Starts at the start** — the start must be on the ground and on the
 *     network: nothing over water, freeboard positive, not perched on a bridge
 *     deck (legal now, but a sprint start is an arena, and an arena is not a
 *     carriageway), opening onto the venue rather than a courtyard.
 *  3. **Finishes at the finish** — `arenaFaults` empty, which is where
 *     `courseGen` already states the property: separation from the start, a
 *     first leg that takes the field away, and no leg threading past the finish
 *     on its way somewhere else.
 *  4. **Runs through the alleys** — the *legs*, not the controls. Each leg is
 *     routed over the game's own collision with the athlete's own class speeds
 *     (`makeLegRouter`, shared with tools/ci/check-passable.mjs so the tool and
 *     the gate cannot drift), and the score is the fraction of that route on
 *     Road or Path.
 *
 * On top of those, the measures the gates already report: control count, length
 * against the discipline's band, climb, and how far the controls sit from the
 * street network.
 *
 * Usage:
 *   node tools/sim/pick-course.mjs [--venue krumlov] [--count 300] [--top 12]
 *
 * Needs `npm run build` first: it drives `dist/`, which is the thing players
 * get, rather than a re-implementation of it.
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve, withChrome, openTab } from '../ci/chrome.mjs';
import {
  makeLegRouter,
  makeCourseAudit,
  auditFaults,
  auditTable,
  detourFaults,
  detourStats,
} from '../ci/check-passable.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../..');
const DIST = resolve(ROOT, 'dist');

/**
 * Candidate seeds.
 *
 * Menu-shaped on purpose: the seed the menu used to compute was
 * `(Date.now() / 60000) | 0`, an eight-digit number around 2.9 × 10⁷, and the
 * one bug in this venue that a gate missed showed up only on a menu-shaped
 * seed. Choosing from 3, 7, 19, 42 would pick a course out of a corner of the
 * generator's input space no player has ever been in.
 */
const SEED_BASE = 29_500_000;

const VENUE_SCENE = { krumlov: 'sprint', martinkov: 'forest' };
const VENUE_DISCIPLINE = { krumlov: 'sprint', martinkov: 'middle' };

/**
 * Half-extent of each venue, metres — the radius the leg router's lattice has
 * to cover. `VENUES` in src/core/venues.ts: Krumlov 1 200 m, Lachovice 2 000 m.
 * A lattice too small for the venue reports a *clipped* leg as unroutable, and
 * an unroutable leg disqualifies the candidate, so getting this wrong throws
 * away good forest courses silently.
 */
const VENUE_R = { krumlov: 600, martinkov: 1000 };

/**
 * What the discipline's course should look like.
 *
 * `min`/`max` mirror `courseLengthBand` in src/sim/courseGen.ts — a course
 * outside them reads wrong on the description sheet before the runner has taken
 * a step. `want` is the middle of the control count a real race of this format
 * carries, and is a preference rather than a gate.
 */
/**
 * The street graph's own three, shared with `tools/ci/check-streets.mjs`.
 *
 * Stated in both places rather than imported, on this project's usual argument:
 * a tool that reads the gate's numbers and a gate that reads the tool's cannot
 * between them catch a wrong number. What they must not do is *disagree*, and
 * the containment that matters — the setter's limit is not looser than the
 * gate's — is asserted in check-streets against the setter's own report.
 */
const STREET = {
  maxEndpointOffNetworkM: 2.5,
  minStartRunOutM: 25,
};

const SHAPE = {
  // `climbPerKm` is the fraction of the course length that is ascent, and it is
  // the measure that separates a course from a hill session. RESEARCH-SPORT
  // §7.3: a sprint is technically easy and nearly flat; a middle in this
  // terrain runs 4–6 %. Krumlov's castle rock and the Vltava valley will both
  // happily produce double that if nothing asks them not to.
  sprint: { wantControls: 16, minControls: 14, maxControls: 20, climbPerKm: 0.035 },
  middle: { wantControls: 14, minControls: 10, maxControls: 18, climbPerKm: 0.05 },
};

const PROBE = `(async () => {
  const w = window.__world, r = window.__race;
  const c = r.course;
  const named = [{ n: 'start', p: c.start }]
    .concat(c.controls.map((k, i) => ({ n: String(i + 1), p: k.position })))
    .concat([{ n: 'finish', p: c.finish }]);

  // Runnability under every sited point. ISOM 403/406: a control belongs on a
  // feature you can reach and read, and thick undergrowth is neither.
  const SPEED = [1.0, 0.97, 0.9, 0.72, 0.8, 0.6, 0.4, 0.18, 0.45, 0.5, 0];
  const siteSpeed = named.map((o) => SPEED[w.field.runnabilityAt(o.p.x, o.p.z)] ?? 0);

  const surf = w.surface || null;
  const wet = [];
  for (const o of named) {
    if (!surf) break;
    const { x, z } = o.p;
    const terrainY = w.field.heightAt(x, z);
    const level = surf.water.levelAt(x, z, terrainY);
    if (level === null) continue;
    wet.push({
      n: o.n,
      onDeck: surf.decks.covers(x, z),
      freeboard: Number((w.groundAt(x, z) - level).toFixed(2)),
    });
  }

  return JSON.stringify({
    id: c.id,
    controls: c.controls.length,
    lengthM: c.lengthM,
    climbM: c.climbM,
    startOnDeck: surf ? surf.decks.covers(c.start.x, c.start.z) : false,
    finishOnDeck: surf ? surf.decks.covers(c.finish.x, c.finish.z) : false,
    wet,
    points: named.map((o) => ({ n: o.n, x: o.p.x, z: o.p.z })),
    legsM: named.slice(1).map((o, i) =>
      Math.hypot(o.p.x - named[i].p.x, o.p.z - named[i].p.z),
    ),
    siteSpeed,
    startFinishM: Math.hypot(c.start.x - c.finish.x, c.start.z - c.finish.z),
    info: {
      seedsTried: r.courseInfo.seedsTried,
      dropped: r.courseInfo.droppedControls,
      reachable: r.courseInfo.reachableFraction,
      tightest: r.courseInfo.tightestEscapeM2,
      paved: r.courseInfo.pavedDistanceM,
      arenaFaults: r.courseInfo.arenaFaults,
      /**
       * What the setter measured **on the street graph while it was setting**.
       * PLAN-KRUMLOV-V2 §3, and null for a venue with no network.
       */
      street: r.courseInfo.street,
    },
    renderErrors: (window.__renderErrors || []).slice(0, 2),
  });
})()`;

/**
 * The 0.5 m audit, told what the street graph found. **Neither is the truth.**
 *
 * Both are upper bounds on the shortest route the athlete could actually run,
 * and neither dominates: the graph is confined to a network drawn inside the
 * open space, so it can call a leg longer than it is; the 0.5 m lattice cannot
 * express a doorway narrower than its own diagonal (D-039), so it can too.
 * Measured over 174 sprint-length legs the graph is the conservative one — a
 * median 1.04× and a p90 1.53× longer than the audit — and each is the tighter
 * of the pair on some legs.
 *
 * D-037's fault is *"the flag is in sight across an uncrossable feature and the
 * way to it is a lap of the venue"*, and a route exhibited by either measure
 * disproves it. So the leg is judged on the shorter, and the audit rows carry
 * the graph's answer where it wins.
 */
function withGraph(a, street) {
  if (!street?.legDetour) return a;
  const rows = a.rows.map((r, i) => {
    const d = street.legDetour[i];
    if (d === null || d === undefined) return r;
    const graphM = d * r.straightM;
    if (r.status === 'ok' && r.walkedM <= graphM) return r;
    return {
      ...r,
      status: 'ok',
      walkedM: graphM,
      detour: r.straightM > 0 ? Math.max(1, graphM / r.straightM) : 1,
      viaGraph: true,
    };
  });
  const walkedTotal = rows.reduce((s, x) => s + Math.max(0, x.walkedM), 0);
  return {
    ...a,
    rows,
    walkedTotal,
    courseDetour: a.straightTotal > 0 ? walkedTotal / a.straightTotal : 1,
  };
}

function median(a) {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  return s[s.length >> 1];
}

function percentile(a, p) {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
}

/**
 * Score one candidate. Higher is better; `null` disqualifies.
 *
 * Disqualification is for the things the client's sentence forbids outright —
 * a sited point in the river, a broken arena, a control the terrain refused, a
 * seed the generator had to shop around for. Everything else is a preference,
 * and the weights say what this venue is *for*: legs in the streets dominates,
 * because that is the sentence's last clause and the thing that makes it a
 * sprint rather than a run past a castle.
 */
function score(res, routed, shape, urban) {
  const reasons = [];
  const info = res.info;

  if (res.renderErrors.length) return { dq: `render error: ${res.renderErrors[0]}` };
  if (info.arenaFaults.length) return { dq: `arena: ${info.arenaFaults.join('; ')}` };
  if (info.dropped > 0) return { dq: `${info.dropped} control(s) dropped as unreachable` };
  if (res.wet.some((x) => !x.onDeck)) return { dq: 'a sited point is in the water' };
  if (res.wet.some((x) => x.freeboard < 0.5)) return { dq: 'a sited point is below the waterline' };
  if (res.startOnDeck) return { dq: 'the start is on a bridge deck' };
  if (res.finishOnDeck) return { dq: 'the finish is on a bridge deck' };
  if (res.controls < shape.minControls || res.controls > shape.maxControls) {
    return { dq: `${res.controls} controls` };
  }
  if (routed && routed.legs.some((l) => !l.routed)) return { dq: 'a leg cannot be run' };
  // **A hard filter, not a score term.** D-037.
  //
  // The course that shipped had control 2 fifty-eight metres from control 1 on
  // the far bank of the Vltava with no bridge between them: 810 m of running
  // for a leg the player can see across the water. It won its round of picking
  // because every term it failed was a *preference* and the seventy points of
  // street fraction, control count and climb outvoted them. So this is a
  // disqualification. A course with a 14× leg must be unable to win, not merely
  // score badly — the same reason a point in the river is a disqualification
  // rather than a deduction.
  //
  // `detourFaults` is imported from tools/ci/check-passable.mjs rather than
  // reimplemented, so a course this tool can choose is by construction a course
  // that gate accepts.
  if (routed) {
    const bad = detourFaults(routed);
    if (bad.length) {
      const worst = routed.legs.reduce((a, l) => (l.detour > a.detour ? l : a), routed.legs[0]);
      return {
        dq:
          `leg ${worst.leg} runs ${worst.detour.toFixed(1)}× its straight line ` +
          `(${worst.lengthM} m for ${Math.round(worst.straightM)} m)` +
          (bad.length > 1 ? ` and ${bad.length - 1} more` : ''),
      };
    }
  }
  /**
   * The network's own three, from the setter's report. **PLAN-KRUMLOV-V2 §3.**
   *
   * Disqualifications rather than score terms, for D-037's reason: a start in
   * the woods facing a wall won its round of picking because every term it
   * failed was a preference, and sixty points of street fraction outvoted them.
   * The class-based `endpointFaults` stays as well and is not redundant — it
   * measures the raster the map is drawn from, this measures the network the
   * course was set on, and the fault they exist for was invisible to the first
   * one for exactly that reason.
   */
  if (info.street) {
    const s = info.street;
    if (s.offNetworkM.start > STREET.maxEndpointOffNetworkM) {
      return { dq: `the start is ${s.offNetworkM.start.toFixed(1)} m off the street network` };
    }
    if (s.offNetworkM.finish > STREET.maxEndpointOffNetworkM) {
      return { dq: `the finish is ${s.offNetworkM.finish.toFixed(1)} m off the street network` };
    }
    if (s.startRunOutM < STREET.minStartRunOutM) {
      return {
        dq:
          `the athlete runs ${s.startRunOutM.toFixed(0)} m out of the start before something ` +
          `stops them`,
      };
    }
    const worstGraph = s.legDetour.reduce((a, d) => Math.max(a, d === null ? Infinity : d), 1);
    if (worstGraph > s.limit) {
      return { dq: `leg runs ${worstGraph.toFixed(1)}× its straight line on the street graph` };
    }
  }

  // A seed the setter had to shop around from is a seed whose own course was
  // rejected; the course that ships should be the one its seed produces.
  if (info.seedsTried > 1) return { dq: `took ${info.seedsTried} seeds to settle` };

  let s = 0;

  // The sentence's last clause, and the heaviest term.
  //
  // Urban only, and it always was: "runs through the alleys" is a statement
  // about a town, and a forest course scored on the fraction of its running
  // spent on Road or Path would be a course set along the forest tracks, which
  // is the opposite of orienteering. The legs are now routed in the forest as
  // well — see the detour term below — so the guard has to be explicit rather
  // than implied by the router being null.
  if (routed) {
    if (urban) {
      s += routed.fraction * 60;
      reasons.push(`legs ${(routed.fraction * 100).toFixed(0)}% street`);
    }

    // How far the worst leg runs against its straight line.
    //
    // Secondary to the filter above and deliberately small. The filter decides
    // whether the course is *allowed*; this decides between two courses that
    // both are, and the difference between a worst leg of 1.4× and one of 2.9×
    // is real — the second is a course the setter would have to defend. Zero at
    // the limit, so it cannot pull a candidate back over it.
    const worst = routed.legs.reduce((a, l) => (l.detour > a.detour ? l : a), routed.legs[0]);
    s += Math.max(0, 8 * (1 - (worst.detour - 1) / 2));
    reasons.push(`worst detour ${worst.detour.toFixed(1)}×`);
  }

  // The ground the controls actually stand on.
  //
  // In the town this is nearly always Road and the measure below carries the
  // weight; in the forest it is the one that separates a course from a
  // bushwhack. Krumlov's best forest candidate on score alone put six of its
  // sixteen points in Green2 — 0.4× running speed, which is fighting through
  // undergrowth to find a flag rather than navigating to it. ISOM 403/406: a
  // control belongs on a feature you can reach and read.
  if (res.siteSpeed && res.siteSpeed.length) {
    const good = res.siteSpeed.filter((v) => v >= 0.6).length / res.siteSpeed.length;
    s += good * 18;
    reasons.push(`${(good * 100).toFixed(0)}% of sites runnable`);
  }

  // Controls near the network — the client's earlier complaint, still measured.
  if (urban && info.paved.length) {
    const p90 = percentile(info.paved, 0.9);
    s += Math.max(0, 20 - p90 * 1.5);
    reasons.push(`paved p90 ${p90.toFixed(1)} m`);
  }

  // A real race's shape. Both are preferences: a 14-control sprint is a sprint.
  s += Math.max(0, 12 - Math.abs(res.controls - shape.wantControls) * 2);
  reasons.push(`${res.controls} controls`);

  // Distance between the start and the finish. More is better up to a point —
  // the two must be visibly different places, and beyond ~450 m in a 1.2 km
  // venue the course is pinned to opposite corners and loses its middle.
  s += Math.min(12, (res.startFinishM - 300) / 15);
  reasons.push(`s/f ${res.startFinishM.toFixed(0)} m`);

  // Climb, as a fraction of the course length rather than as an absolute.
  //
  // Stated this way because it has to work for both venues: 60 m is a good
  // sprint and a derisory middle. A middle at 8 %/km is not a middle, it is a
  // hill session with controls on it, and the Vltava valley produces those
  // freely — the raw best forest candidate before this term existed was 350 m
  // of climb over 4.5 km.
  const perKm = res.lengthM > 0 ? res.climbM / res.lengthM : 0;
  s += Math.max(0, 14 - Math.abs(perKm - shape.climbPerKm) * 400);
  reasons.push(`climb ${res.climbM} m (${(perKm * 100).toFixed(1)} %)`);

  // Leg-length variety.
  //
  // A course of fourteen 300 m legs is fourteen copies of one problem. Real
  // setting alternates short technical legs with long route-choice ones, and
  // the coefficient of variation is the cheapest honest measure of that. 0.5 is
  // about what a well-set middle shows; more than that and the course is one
  // long leg with a cluster on the end.
  if (res.legsM && res.legsM.length > 1) {
    const mean = res.legsM.reduce((a, b) => a + b, 0) / res.legsM.length;
    const sd = Math.sqrt(
      res.legsM.reduce((a, b) => a + (b - mean) ** 2, 0) / res.legsM.length,
    );
    const cv = mean > 0 ? sd / mean : 0;
    s += Math.max(0, 10 - Math.abs(cv - 0.5) * 20);
    reasons.push(`leg spread ${cv.toFixed(2)}`);
  }

  // Every point opens onto the venue rather than a pocket.
  if (!Number.isFinite(info.tightest)) s += 6;
  else reasons.push(`tightest escape ${info.tightest.toFixed(0)} m²`);

  return { s, reasons };
}

async function main() {
  const args = process.argv.slice(2);
  const argOf = (k, d) => {
    const i = args.indexOf(k);
    return i >= 0 && args[i + 1] ? args[i + 1] : d;
  };
  const venue = argOf('--venue', 'krumlov');
  const count = Number(argOf('--count', '240'));
  const top = Number(argOf('--top', '12'));
  const scene = VENUE_SCENE[venue];
  const discipline = VENUE_DISCIPLINE[venue];
  const urban = venue === 'krumlov';
  const shape = SHAPE[discipline];

  if (!scene) {
    console.error(`✗ unknown venue ${venue}`);
    process.exit(2);
  }
  if (!existsSync(DIST)) {
    console.error('✗ dist/ not found — run `npm run build` first');
    process.exit(2);
  }

  // Which raster the leg router should read. `high` is what a desktop gets and
  // — since the raster is now one file for every tier — what everyone gets.
  let bin = 'runnability.bin';
  const manifestPath = join(ROOT, 'public/data', venue, 'manifest.json');
  if (existsSync(manifestPath)) {
    const m = JSON.parse(readFileSync(manifestPath, 'utf8'));
    bin = m.tiers?.high?.runnability ?? bin;
  }
  // Built once: the lattice it walks costs 360 000 collider queries and does
  // not depend on the candidate.
  //
  // Both venues now, not only the town. The street-fraction term is meaningless
  // in a forest and stays urban-only, but the detour ratio is not: a course
  // whose legs cross a lake or a crag band is the same fault wherever it is
  // set, and until this change the forest seed was picked without any leg ever
  // being routed at all. The forest has no `townscape.json`, and `loadVenue`
  // reads that as "the raster is the whole collision", which is what
  // `ForestScene` enforces — it has no `blockedAt`.
  const route = makeLegRouter(venue, bin, { radiusM: VENUE_R[venue] ?? 600 });

  /**
   * The gate's own 1 m audit, run on the shortlist before a winner is declared.
   *
   * `route` above is a 2 m lattice and it is the *pre-filter*: cheap enough for
   * several hundred candidates, and it once called six legs routable that a 1 m
   * probe found unreachable, because Krumlov's alleys are 2–3 m wide. A tool
   * that chooses a course the gate then rejects is worse than no tool, so the
   * candidate that is actually recommended is checked with the identical
   * function `check:passable` will judge it by. See D-037.
   */
  const audit = makeCourseAudit(venue, bin, { radiusM: VENUE_R[venue] ?? 600 });

  // Randomised so two venues can be picked at once without one silently
  // failing to bind and reporting every candidate as "never mounted".
  const port = 8400 + Math.floor(Math.random() * 400);
  const server = await serve(DIST, port);
  const rows = [];
  try {
    await withChrome(async (cdpPort) => {
      for (let i = 0; i < count; i++) {
        const seed = SEED_BASE + i * 7919;
        const url =
          `http://127.0.0.1:${port}/?scene=${scene}&race=1&debug=0&tier=high` +
          `&discipline=${discipline}&seed=${seed}`;
        const tab = await openTab(cdpPort, url);
        const ready = await tab.waitFor('!!(window.__race && window.__world)', 60_000);
        if (!ready) {
          await tab.close();
          continue;
        }
        const res = JSON.parse(await tab.evaluate(PROBE));
        await tab.close();

        const routed = route ? route(res.points) : null;
        const verdict = score(res, routed, shape, urban);
        rows.push({ seed, res, routed, verdict });
        if ((i + 1) % 20 === 0) {
          const kept = rows.filter((r) => r.verdict.s !== undefined).length;
          process.stdout.write(`  ${i + 1}/${count} tried, ${kept} viable\n`);
        }
      }
    });
  } finally {
    server.close();
  }

  const viable = rows.filter((r) => r.verdict.s !== undefined);
  viable.sort((a, b) => b.verdict.s - a.verdict.s);

  console.log(`\n· ${venue} (${discipline}) — ${rows.length} candidates, ${viable.length} viable\n`);

  const why = new Map();
  for (const r of rows) {
    if (r.verdict.dq === undefined) continue;
    const key = r.verdict.dq.replace(/[-\d.,;]+/g, 'N').slice(0, 60);
    why.set(key, (why.get(key) ?? 0) + 1);
  }
  console.log('  why the rest were refused:');
  for (const [k, n] of [...why].sort((a, b) => b[1] - a[1]).slice(0, 8)) {
    console.log(`    ${String(n).padStart(4)}  ${k}`);
  }

  console.log(`\n  best ${Math.min(top, viable.length)}:`);
  for (const r of viable.slice(0, top)) {
    console.log(
      `  ${String(r.seed).padStart(10)}  ${r.verdict.s.toFixed(1).padStart(6)}  ` +
        `${String(r.res.controls).padStart(2)}c ${String(r.res.lengthM).padStart(4)} m  ` +
        `${r.verdict.reasons.join(' · ')}`,
    );
  }

  // The whole population's detour distribution, not only the winner's.
  //
  // Printed because it is the number that says whether the *generator* is
  // healthy or whether this tool is merely filtering its output — see D-037.
  // If a third of all candidates are being disqualified for detour, the answer
  // is upstream in src/sim/courseGen.ts and not here.
  const allRouted = rows.filter((r) => r.routed).map((r) => r.routed);

  // **The worst leg of every candidate, viable or not.**
  //
  // This is the number that answers "can this venue hold a course of this
  // shape at all", and it is a different question from "which seed is best".
  // If the whole distribution sits above the limit then no amount of picking
  // will help and the answer is fewer controls or a different threshold — see
  // D-037. Printed always, so that conclusion is available without a re-run.
  const worsts = rows
    .filter((r) => r.routed && r.routed.legs.length)
    .map((r) => Math.max(...r.routed.legs.filter((l) => l.routed).map((l) => l.detour)))
    .filter((v) => Number.isFinite(v))
    .sort((a, b) => a - b);
  if (worsts.length) {
    const at = (p) => worsts[Math.min(worsts.length - 1, Math.floor(p * worsts.length))];
    const under = (t) => worsts.filter((v) => v <= t).length;
    console.log(
      `\n  worst leg per candidate, all ${worsts.length} of them:` +
        ` best ${worsts[0].toFixed(2)}× · p10 ${at(0.1).toFixed(2)}×` +
        ` · median ${at(0.5).toFixed(2)}× · max ${worsts[worsts.length - 1].toFixed(2)}×` +
        `\n    ${under(2)} candidate(s) keep every leg under 2.0×,` +
        ` ${under(2.5)} under 2.5×, ${under(3)} under 3.0×`,
    );
  }

  const st = detourStats(allRouted);
  if (st) {
    console.log(
      `\n  leg detour across all ${rows.length} candidates (${st.n} legs):` +
        ` median ${st.median.toFixed(2)}× · p90 ${st.p90.toFixed(2)}×` +
        ` · p99 ${st.p99.toFixed(2)}× · max ${st.max.toFixed(2)}×` +
        `\n    ${st.over(2)} leg(s) over 2.0×, ${st.over(3)} over 3.0×`,
    );
  }

  // --- the audit, on the shortlist ----------------------------------------
  //
  // Walked down in score order until one passes, and every rejection is
  // printed. If none passes, that is the answer and it needs saying out loud:
  // it would mean the venue's geometry cannot support a course of this shape,
  // and the response is fewer controls or a different threshold, not a worse
  // course.
  const AUDIT_N = Math.min(25, viable.length);
  let winner = null;
  const rejected = [];
  for (let i = 0; i < AUDIT_N; i++) {
    const a = withGraph(audit(viable[i].res.points), viable[i].res.info.street);
    const f = auditFaults(a);
    viable[i].audit = a;
    if (!f.length) { winner = viable[i]; break; }
    rejected.push({ row: viable[i], faults: f });
  }
  if (rejected.length) {
    console.log(`\n  refused by the 1 m audit, in score order:`);
    for (const { row, faults } of rejected) {
      console.log(`    ${row.seed}  ${faults[0]}${faults.length > 1 ? ` (+${faults.length - 1})` : ''}`);
    }
  }
  if (!winner) {
    console.log(
      `\n  ✗ none of the top ${AUDIT_N} candidates passes the audit.` +
        `\n    That is a statement about the venue, not about the seeds: this town cannot` +
        `\n    hold a course of this shape without a leg over the limit. Fewer controls or` +
        `\n    a different threshold — not a worse course.`,
    );
  }

  if (winner) {
    const b = winner;
    console.log(
      `\n  audit of the recommended seed (1 m, eight-connected, distance):\n` +
        auditTable(b.audit, '    '),
    );
  }

  if (viable.length) {
    const b = winner ?? viable[0];
    console.log(
      `\n  → ${venue}: ${b.seed}` +
        `\n    ${b.res.controls} controls, ${b.res.lengthM} m, ${b.res.climbM} m climb, ` +
        `start ${b.res.startFinishM.toFixed(0)} m from the finish` +
        (b.routed && urban
          ? `, ${(b.routed.fraction * 100).toFixed(0)} % of the running on the street network`
          : '') +
        `\n    course id ${b.res.id}`,
    );
    if (urban) {
      console.log(
        `    control distance to paved: median ${median(b.res.info.paved).toFixed(1)} m, ` +
          `p90 ${percentile(b.res.info.paved, 0.9).toFixed(1)} m, ` +
          `worst ${Math.max(...b.res.info.paved).toFixed(1)} m`,
      );
    }
    if (b.routed) {
      const w = b.routed;
      console.log(
        `    it runs ${w.totalM} m for a printed ${b.res.lengthM} m — ` +
          `whole-course detour D ${w.courseDetour.toFixed(2)} ` +
          `(a real ${discipline} is ${discipline === 'sprint' ? '1.05' : '1.18'}, ` +
          `RESEARCH-SPORT §8.6)`,
      );
      console.log(
        `    per leg: ` +
          w.legs
            .map((l) => `${l.detour.toFixed(1)}×`)
            .join(' '),
      );
    }
  }
}

main().catch((e) => {
  console.error('✗', e);
  process.exit(2);
});
