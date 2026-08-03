#!/usr/bin/env node
/**
 * Run the shipped course with the game's own physics and report what each leg
 * actually cost the athlete.
 *
 * Every other measure of a leg in this project is made *outside* the runtime —
 * `makeLegRouter` walks a lattice with the athlete's class speeds, which is a
 * model of the athlete rather than the athlete. This drives `RaceView` through
 * `RaceController.autopilot`, records the position every step, and measures the
 * distance walked between one punch and the next. It is the only measurement in
 * the repo that a player could disagree with only by disagreeing with the game.
 *
 * Written for D-037, where the fault was a leg the client could see across the
 * water and not reach: the number that closes that report is how far the
 * athlete walks from control 1 to control 2, in the game, on the course that
 * ships.
 *
 * Usage:
 *   node tools/sim/play-leg.mjs [--venue krumlov] [--seed N] [--shot out.png]
 *                               [--shot-at 1]
 *
 * `--shot-at N` puts the camera at control N, facing the next control, and
 * writes a screenshot — the frame that shows what the player sees when they
 * arrive.
 */
import { existsSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve, withChrome, openTab } from '../ci/chrome.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../..');
const DIST = resolve(ROOT, 'dist');

const args = process.argv.slice(2);
const argOf = (k, d) => {
  const i = args.indexOf(k);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};
const venue = argOf('--venue', 'krumlov');
const seed = argOf('--seed', '');
const shot = argOf('--shot', '');
const shotAt = Number(argOf('--shot-at', '1'));
const scene = venue === 'krumlov' ? 'sprint' : 'forest';
const discipline = venue === 'krumlov' ? 'sprint' : 'middle';

if (!existsSync(DIST)) {
  console.error('✗ dist/ not found — run `npm run build` first');
  process.exit(2);
}

/**
 * Run the course a step at a time, logging where the athlete is and which
 * control they are heading for, so a punch splits one leg from the next.
 *
 * `autopilot(1, dtS)` advances a single step, which is what makes this a
 * *measurement* rather than a summary: `RaceView` reports the leg the athlete
 * is on, and the walked distance is the sum of the steps taken while that
 * number held.
 */
const RUN = (maxSteps, dtS) => `(async () => {
  const r = window.__race;
  const c = r.course;
  const straight = [];
  const pts = [c.start].concat(c.controls.map((k) => k.position)).concat([c.finish]);
  for (let i = 0; i + 1 < pts.length; i++) {
    straight.push(Math.hypot(pts[i + 1].x - pts[i].x, pts[i + 1].z - pts[i].z));
  }

  const walked = new Array(straight.length).fill(0);
  const CHUNK = 25;
  let view = r.autopilot(1, ${dtS});
  let leg = view.nextControl;
  let prev = { x: view.truePosition.x, z: view.truePosition.z };
  let steps = 0;
  let stalled = 0;
  while (steps < ${maxSteps} && view.phase !== 'finished') {
    view = r.autopilot(CHUNK, ${dtS});
    steps += CHUNK;
    const p = view.truePosition;
    const d = Math.hypot(p.x - prev.x, p.z - prev.z);
    prev = { x: p.x, z: p.z };
    if (leg < walked.length) walked[leg] += d;
    if (view.nextControl !== leg) { leg = view.nextControl; stalled = 0; }
    else if (d < 0.01) { if (++stalled > 200) break; }
    else stalled = 0;
  }
  return JSON.stringify({
    id: c.id,
    finished: view.phase === 'finished',
    steps,
    elapsedS: view.timeS ?? null,
    straight: straight.map((v) => Math.round(v)),
    walked: walked.map((v) => Math.round(v)),
  });
})()`;

/** Stand at a control, face the next one, and let the scene settle. */
const LOOK = (n) => `(async () => {
  const r = window.__race, w = window.__world, c = r.course;
  // Begin, so the pre-race panel is down and the frame is the one a player
  // sees. Without this the shot is the START OF NAVIGATION card.
  r.autopilot(1, 0.1);
  const pts = [c.start].concat(c.controls.map((k) => k.position)).concat([c.finish]);
  const a = pts[${n}], b = pts[${n} + 1];
  const yaw = Math.atan2(b.x - a.x, -(b.z - a.z));
  w.setExternalPose(a.x, a.z, yaw, 0);
  for (let i = 0; i < 8; i++) await new Promise((k) => requestAnimationFrame(k));
  return JSON.stringify({
    from: { x: Number(a.x.toFixed(1)), z: Number(a.z.toFixed(1)) },
    to: { x: Number(b.x.toFixed(1)), z: Number(b.z.toFixed(1)) },
    straightM: Number(Math.hypot(b.x - a.x, b.z - a.z).toFixed(1)),
  });
})()`;

const port = 8900 + Math.floor(Math.random() * 200);
const server = await serve(DIST, port);
try {
  await withChrome(async (cdpPort) => {
    const url =
      `http://127.0.0.1:${port}/?scene=${scene}&race=1&debug=0&tier=high` +
      `&discipline=${discipline}` + (seed ? `&seed=${seed}` : '');
    const tab = await openTab(cdpPort, url);
    if (!(await tab.waitFor('!!(window.__race && window.__world)', 60_000))) {
      console.error('✗ the race never mounted');
      process.exitCode = 2;
      return;
    }

    if (shot) {
      const at = JSON.parse(await tab.evaluate(LOOK(shotAt)));
      console.log(
        `  standing at control ${shotAt} (${at.from.x}, ${at.from.z}), ` +
          `facing ${shotAt + 1} at (${at.to.x}, ${at.to.z}), ${at.straightM} m away`,
      );
      const png = await tab.screenshot?.();
      if (png) {
        writeFileSync(resolve(ROOT, shot), Buffer.from(png, 'base64'));
        console.log(`  → ${shot}`);
      } else {
        console.log('  (no screenshot support in this chrome harness)');
      }
    }

    const res = JSON.parse(await tab.evaluate(RUN(200_000, 0.1)));
    await tab.close();

    console.log(`\n· ${res.id} — played by the autopilot, ${res.steps} steps` +
      (res.finished ? '' : ' (did not finish)'));
    console.log('  leg   straight     walked    ratio');
    let worst = { i: -1, r: 0 };
    for (let i = 0; i < res.straight.length; i++) {
      const r = res.straight[i] > 0 ? res.walked[i] / res.straight[i] : 1;
      if (res.walked[i] > 0 && r > worst.r) worst = { i, r };
      const name = i === 0 ? 'S→1' : i === res.straight.length - 1 ? `${i}→F` : `${i}→${i + 1}`;
      console.log(
        `  ${name.padEnd(6)}${String(res.straight[i]).padStart(6)} m` +
          `${String(res.walked[i]).padStart(10)} m` +
          `${(res.walked[i] > 0 ? r.toFixed(2) + '×' : '—').padStart(9)}`,
      );
    }
    const st = res.straight.reduce((a, b) => a + b, 0);
    const wk = res.walked.reduce((a, b) => a + b, 0);
    console.log(
      `  total ${String(st).padStart(6)} m${String(wk).padStart(10)} m` +
        `${(wk / st).toFixed(2).padStart(8)}×  ← whole-course D` +
        (worst.i >= 0 ? `\n  worst leg ${worst.i} at ${worst.r.toFixed(2)}×` : ''),
    );
  });
} finally {
  server.close();
}
