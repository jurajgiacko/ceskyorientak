/* Numeric sanity check of the dead-reckoning model.
   Simulates legs and reports error growth. The model is only useful if the
   numbers land where a real orienteer's would. */
const { build } = await import('vite');
const out = await build({
  configFile:false, logLevel:'error',
  resolve:{ alias:{ '@': new URL('../../src', import.meta.url).pathname } },
  build:{ write:false, lib:{ entry:new URL('../../src/sim/navigation.ts',import.meta.url).pathname, formats:['es'], fileName:'n' } },
});
const { writeFileSync } = await import('node:fs');
writeFileSync('/tmp/nav.mjs', out[0].output[0].code);
const N = await import('/tmp/nav.mjs');

function runLeg({legM, speed, focus, glycogen, complexity, ambiguity, readEvery, seed}) {
  const rng = new N.Rng(seed);
  const nav = N.initNav({x:0,z:0});
  const stats = {glycogen, hydration:1, bloodSugar:0.8, focus};
  const dt = 0.1;
  let travelled = 0, t = 0;
  const truth = {x:0,z:0};
  while (travelled < legM) {
    const step = speed*dt;
    truth.z -= step;                       // running due north
    travelled += step; t += dt;
    const reading = readEvery>0 && (Math.floor(t/readEvery) !== Math.floor((t-dt)/readEvery));
    N.stepNav(nav, {truePos:truth, movedM:step, movedHeading:0, speedMs:speed,
      stats, complexity, ambiguity, readingMap:reading, dtS:dt, rng});
  }
  return { err: N.navError(nav, truth), parallel: !!nav.parallelError, timeS: t };
}

function stats(runs){ const s=runs.slice().sort((a,b)=>a-b);
  return {med:s[Math.floor(s.length/2)], p90:s[Math.floor(s.length*0.9)]}; }

const scenarios = [
  ['fresh, reads often   (500m)', {legM:500, speed:3.2, focus:1.0, glycogen:1.0, complexity:0.4, ambiguity:0.2, readEvery:8}],
  ['fresh, head down     (500m)', {legM:500, speed:4.2, focus:1.0, glycogen:1.0, complexity:0.4, ambiguity:0.2, readEvery:0}],
  ['tired, reads often   (500m)', {legM:500, speed:3.0, focus:0.35,glycogen:0.25,complexity:0.6, ambiguity:0.3, readEvery:8}],
  ['tired, head down     (500m)', {legM:500, speed:4.0, focus:0.35,glycogen:0.25,complexity:0.6, ambiguity:0.3, readEvery:0}],
  ['fresh, long leg     (1200m)', {legM:1200,speed:3.5, focus:1.0, glycogen:0.9, complexity:0.5, ambiguity:0.3, readEvery:10}],
  ['tired, vague terrain(1200m)', {legM:1200,speed:3.8, focus:0.3, glycogen:0.2, complexity:0.8, ambiguity:0.7, readEvery:0}],
];

console.log('dead-reckoning error at the end of a leg (200 runs each)\n');
console.log('scenario                        median   p90    parallel-error rate');
console.log('-'.repeat(70));
for (const [name, cfg] of scenarios) {
  const errs=[]; let par=0;
  for (let s=0;s<200;s++){ const r=runLeg({...cfg, seed:s+1}); errs.push(r.err); if(r.parallel)par++; }
  const {med,p90}=stats(errs);
  console.log(name.padEnd(30), (med.toFixed(1)+'m').padStart(7), (p90.toFixed(1)+'m').padStart(7),
    ('  '+(100*par/200).toFixed(0)+'%').padStart(12));
}
