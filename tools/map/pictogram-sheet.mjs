/* Renders every pictogram to a contact sheet for visual inspection. */
import { writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

// Transpile the TS module to JS on the fly via a tiny esbuild-less approach:
// read the file and strip types is fragile, so instead use vite's node API.
const { build } = await import('vite');
const res = await build({
  configFile: false,
  logLevel: 'error',
  resolve: { alias: { '@': new URL('../../src', import.meta.url).pathname } },
  build: {
    write: false,
    lib: { entry: new URL('../../src/map/pictograms.ts', import.meta.url).pathname, formats: ['es'], fileName: 'p' },
    rollupOptions: { external: [] },
  },
});
const code = res[0].output[0].code;
writeFileSync('/tmp/picto.mjs', code);
const M = await import('/tmp/picto.mjs');

const groups = [
  ['Column C — which of similar', M.COLUMN_C],
  ['Column D — the feature', M.COLUMN_D],
  ['Column G — flag location', M.COLUMN_G],
  ['Column H — other info', M.COLUMN_H],
];

let html = `<style>
body{background:#fff;color:#111;font:13px/1.4 system-ui;margin:0;padding:24px}
h2{font-size:13px;letter-spacing:.1em;text-transform:uppercase;color:#666;margin:26px 0 10px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(104px,1fr));gap:10px}
.cell{border:1px solid #ddd;padding:8px;text-align:center}
.box{width:56px;height:56px;margin:0 auto;border:1px solid #bbb}
.ref{font:11px ui-monospace;color:#999;margin-top:5px}
.nm{font-size:10.5px;margin-top:2px}
.cs{font-size:10px;color:#777}
</style><h1 style="font-size:15px">IOF Control Descriptions 2024 — pictogram check</h1>`;

for (const [title, set] of groups) {
  html += `<h2>${title} (${Object.keys(set).length})</h2><div class="grid">`;
  for (const [key, sym] of Object.entries(set)) {
    const svg = M.renderPictogram({ symbol: sym, direction: sym.rotatable ? 'NE' : undefined }, 54);
    html += `<div class="cell"><div class="box">${svg}</div>
      <div class="ref">${sym.ref}${sym.rotatable ? ' ↻' : ''}</div>
      <div class="nm">${sym.nameEn}</div><div class="cs">${sym.nameCs}</div></div>`;
  }
  html += `</div>`;
}
writeFileSync('tools/map/pictogram-sheet.html', html);
console.log('wrote tools/map/pictogram-sheet.html');
console.log('counts:', groups.map(([t,s])=>`${t.split(' ')[1]}=${Object.keys(s).length}`).join(' '));
