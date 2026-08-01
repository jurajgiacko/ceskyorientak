/* Generate contours from REAL Lachovice terrain and render them to SVG. */
import { writeFileSync } from 'node:fs';
const { build } = await import('vite');
const out = await build({ configFile:false, logLevel:'error',
  resolve:{ alias:{ '@': new URL('../../src', import.meta.url).pathname } },
  build:{ write:false, lib:{ entry:new URL('../../src/map/contours.ts',import.meta.url).pathname, formats:['es'], fileName:'c' } } });
writeFileSync('/tmp/cont.mjs', out[0].output[0].code);
const C = await import('/tmp/cont.mjs');
const cuzk = await import('../terrain/cuzk.mjs');
const gt = await import('../terrain/geotiff.mjs');

const bbox = {west:14.2401,south:48.6139,east:14.2671,north:48.6319};
console.log('fetching real DMR 5G …');
const { buffer } = await cuzk.exportElevation('dmr5g', bbox, 600, 600);
const r = gt.parseFloat32GeoTiff(buffer);

const f = { data:r.data, width:r.width, height:r.height, cellSize:r.pixelScale[0],
  originX:0, originZ:0, minH:r.min, maxH:r.max };
console.log(`heightfield ${f.width}x${f.height} @ ${f.cellSize.toFixed(2)}m, ${f.minH.toFixed(0)}-${f.maxH.toFixed(0)}m`);

const t0=Date.now();
let contours = C.generateContours(f, 5);
const genMs = Date.now()-t0;
const beforePrune = contours.length;
contours = C.pruneContours(contours, 12);
contours = contours.map(c => ({...c, points: C.smoothContour(c.points, 2)}));

const idx = contours.filter(c=>c.index).length;
const pts = contours.reduce((a,c)=>a+c.points.length,0);
console.log(`${beforePrune} contours -> ${contours.length} after prune (${idx} index), ${pts} points, ${genMs}ms`);

// Render to SVG at ISOM brown.
const W = f.width*f.cellSize, H = f.height*f.cellSize;
let svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="900" height="900" style="background:#fff">`;
for (const c of contours) {
  const d = c.points.map((p,i)=>`${i?'L':'M'}${p.x.toFixed(1)} ${p.z.toFixed(1)}`).join('');
  svg += `<path d="${d}" fill="none" stroke="#C65E2A" stroke-width="${c.index?4.2:2.1}" stroke-linejoin="round" stroke-linecap="round"/>`;
}
svg += `</svg>`;
writeFileSync('public/_contours.svg', svg);
console.log('wrote public/_contours.svg');
