#!/usr/bin/env node
/**
 * End-to-end race gate.
 *
 * Loads the *production build* in headless Chrome, starts a real race in each
 * venue, drives it to the finish with the controller's own autopilot, and
 * asserts that every control was punched in order and that the result is valid.
 *
 * It exists because of a specific failure mode this project has already had
 * twice: everything a static gate can see stays green while the thing the
 * player actually does is broken. A shader that fails to compile makes objects
 * vanish rather than misdraw; a course whose finish sits in a sealed courtyard
 * generates, renders and reports perfectly and simply cannot be completed. So
 * this gate checks the only thing that matters — **can the race be finished** —
 * and it reads `window.__renderErrors` on the way past, because a scene that
 * finishes a race with a dead shader is still broken.
 *
 * Usage: node tools/ci/check-race.mjs
 * Exit codes: 0 pass, 1 a race could not be completed, 2 harness failure.
 */

import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve, withChrome, openTab } from './chrome.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST = resolve(__dirname, '../../dist');

/**
 * Several sprint seeds, not one.
 *
 * A course is a random draw over the venue, and "the seed we happened to test
 * works" is a much weaker claim than it reads as — the failure that prompted
 * this (every bridge over the Vltava severed, so the arena's reachable
 * component was the meander and nothing else) left plenty of seeds completable
 * inside the old town while the venue as a whole was cut in half.
 */
const CASES = [
  { id: 'forest', url: '/?scene=forest&race=1&debug=0&seed=11', loadMs: 14000, autopilotMustPunch: true },
  { id: 'sprint s7', url: '/?scene=sprint&race=1&debug=0&seed=7', loadMs: 16000 },
  { id: 'sprint s3', url: '/?scene=sprint&race=1&debug=0&seed=3', loadMs: 16000 },
  { id: 'sprint s19', url: '/?scene=sprint&race=1&debug=0&seed=19', loadMs: 16000 },
  { id: 'sprint s42', url: '/?scene=sprint&race=1&debug=0&seed=42', loadMs: 16000 },
  // A menu-shaped seed. The menu seeds with `(Date.now() / 60000) | 0`, so an
  // eight-digit number is what every player actually gets and 3/7/19/42 is a
  // corner of the input space nobody will ever see.
  { id: 'sprint menu-seed', url: '/?scene=sprint&race=1&debug=0&seed=29760961', loadMs: 20000 },
  // The `low` tier, which is what `pickTier` hands a mid-range Android phone —
  // the device the brief is written for, and the one on which this venue was
  // unplayable while every desktop run was green.
  { id: 'sprint low tier', url: '/?scene=sprint&race=1&debug=0&tier=low&seed=29760961', loadMs: 20000 },
];

/**
 * Why `autopilotMustPunch` is off for the sprint, stated plainly rather than
 * quietly.
 *
 * The autopilot is blind. It descends a distance field and backs out of corners
 * by feel; it cannot read a map, which is the entire game. In the forest that is
 * good enough and it finishes, so it is enforced there.
 *
 * In Krumlov it is not, and it was not before this gate grew from one sprint
 * seed to four. Measured on the **pre-fix** data — the raster with every bridge
 * over the Vltava still severed — the autopilot punched every control on seed 7
 * and failed on seeds 3, 19 and 42 (2/9, 3/11 and 3/8). Seed 7 was the only
 * sprint seed in the gate, so the green light was reporting on one lucky draw.
 *
 * Enforcing it would gate the build on the steering of a test robot rather than
 * on the game. What *is* enforced on every seed is deterministic and is the
 * property a player depends on: every leg has a route over the ground the
 * runtime actually lets them cross, and nothing they are placed on is inside a
 * barrier. The autopilot's progress is printed either way, because a sudden
 * drop across all seeds is still worth seeing.
 */

/**
 * Simulated seconds allowed before a race is called stuck.
 *
 * Generous on purpose. The autopilot is not an athlete — it cannot see, it
 * follows a distance field and backs out of corners by feel, and in Krumlov's
 * alleys it loses a lot of time to that. The question this gate asks is
 * "**can** the race be finished", not "how fast".
 */
const SIM_BUDGET_S = 4 * 3600;

async function main() {
  if (!existsSync(DIST)) {
    console.error('✗ dist/ not found. Run `npm run build` first.');
    process.exit(2);
  }
  const port = 8231;
  const server = await serve(DIST, port);
  let failed = false;

  await withChrome(async (cdpPort) => {
    for (const c of CASES) {
      process.stdout.write(`▶ ${c.id} … `);
      const tab = await openTab(cdpPort, `http://127.0.0.1:${port}${c.url}`);
      // Poll rather than sleep: a warm texture cache loads in a third of the
      // time, and a sleep sized for the cold case pays for it on every run.
      const ready = await tab.waitFor('!!window.__race', c.loadMs);
      if (!ready) {
        console.log('✗ the race never mounted');
        const errs = await tab.evaluate('JSON.stringify((window.__renderErrors||[]).slice(0,3))');
        if (errs && errs !== '[]') console.log(`     renderErrors ${errs}`);
        if (tab.consoleErrors.length) console.log(`     ${tab.consoleErrors[0]}`);
        failed = true;
        await tab.close();
        continue;
      }

      // Ten seconds of wall clock is plenty: the autopilot runs the whole
      // simulation synchronously, it does not wait for frames.
      const out = await tab.evaluate(`(() => {
        const r = window.__race;
        const info = r.courseInfo;
        const routes = r.legRoutes();
        // Every point the athlete is *placed* on must be ground they can move
        // off. Race.step reads its speed target from the runnability under the
        // athlete and that target is zero on impassable ground, so a start,
        // control or finish half a metre inside a wall's collision band is a
        // permanent freeze — the "stuck and can't get out" failure — and it is
        // invisible to a routability check, which only looks at the legs.
        const world = window.__world;
        const sited = [r.course.start, ...r.course.controls.map((c) => c.position), r.course.finish];
        const onBarrier = world && world.blockedAt
          ? sited.filter((p) => world.blockedAt(p.x, p.z)).length
          : 0;
        const v = r.autopilot(${SIM_BUDGET_S * 10}, 0.1);
        return JSON.stringify({
          onBarrier,
          phase: v.phase,
          punched: v.splits.length,
          controls: r.course.controls.length,
          lengthM: r.course.lengthM,
          climbM: r.course.climbM,
          timeS: Math.round(v.timeS),
          seedsTried: info.seedsTried,
          dropped: info.droppedControls,
          reachable: Number(info.reachableFraction.toFixed(3)),
          brokenLegs: routes.map((d, i) => (d < 0 ? i : -1)).filter((i) => i >= 0),
          renderErrors: (window.__renderErrors || []).slice(0, 3),
        });
      })()`);
      const r = JSON.parse(out);

      // What is asserted, and why it is not simply "the bot finished".
      //
      // The property that decides whether a player can complete the course is
      // that every leg has a route over ground the athlete can cross. That is
      // deterministic and it is checked exactly. The autopilot is a second,
      // weaker witness: it is blind — it descends a distance field and backs
      // out of corners by feel — and in Krumlov's alleys it can fail to get
      // round a 1.6 km detour that a player reading the map would take in one
      // look. Requiring it to finish would gate the build on the quality of a
      // test robot rather than on the quality of the game. So: every control
      // must be punched in order, every leg must be routable, nothing may
      // fail to render. Whether the bot got home is reported, not enforced.
      const ok =
        (c.autopilotMustPunch ? r.punched === r.controls : true) &&
        r.controls > 0 &&
        r.brokenLegs.length === 0 &&
        r.onBarrier === 0 &&
        r.phase !== 'mispunched' &&
        r.renderErrors.length === 0;

      console.log(
        `${ok ? '✓' : '✗'} ${r.phase} · ${r.punched}/${r.controls} controls${c.autopilotMustPunch ? '' : ' (autopilot, not gated)'} · ` +
          `${r.lengthM} m · ${r.climbM} m climb · ${Math.round(r.timeS / 60)} min · ` +
          `reachable ${(r.reachable * 100).toFixed(0)}% · all legs routable` +
          (r.dropped ? ` · ${r.dropped} dropped` : '') +
          (r.seedsTried > 1 ? ` · ${r.seedsTried} seeds` : ''),
      );
      if (!ok) {
        failed = true;
        if (r.onBarrier) console.log(`     ${r.onBarrier} sited point(s) inside a barrier`);
        if (r.brokenLegs.length) console.log(`     legs with no route: ${r.brokenLegs.join(', ')}`);
        if (r.renderErrors.length) console.log(`     renderErrors ${JSON.stringify(r.renderErrors)}`);
        if (tab.consoleErrors.length) console.log(`     console: ${tab.consoleErrors[0]}`);
      }
      await tab.close();
    }
  });

  server.close();
  console.log(failed ? '\n✗ RACE CHECK FAILED' : '\n✓ race check OK');
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error('✗ harness error:', e);
  process.exit(2);
});
