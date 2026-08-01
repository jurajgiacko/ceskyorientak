/* Generate courses from REAL terrain data and check them against
   course-setting principles. Renders one to SVG for inspection. */
import { readFileSync, writeFileSync } from 'node:fs';
const { build } = await import('vite');
async function load(entry){
  const out = await build({ configFile:false, logLevel:'error',
    resolve:{ alias:{ '@': new URL('../../src', import.meta.url).pathname } },
    build:{ write:false, lib:{ entry:new URL(entry,import.meta.url).pathname, formats:['es'], fileName:'m' } } });
  const p=`/tmp/cc_${Math.abs(entry.split('').reduce((a,c)=>a*31+c.charCodeAt(0)|0,7))}.mjs`;
  writeFileSync(p,out[0].output[0].code); return import(p);
}
const CG = await load('../../src/sim/courseGen.ts');

const V='martinkov';
const rMeta=JSON.parse(readFileSync(`public/data/${V}/runnability.json`,'utf8'));
const rBuf=readFileSync(`public/data/${V}/runnability.bin`);
const hMeta=JSON.parse(readFileSync(`public/data/${V}/height.json`,'utf8'));
const hRaw=readFileSync(`public/data/${V}/height.bin`);
const hBuf=new Uint16Array(hRaw.buffer,hRaw.byteOffset,hRaw.length/2);

const idx=(x,z,m)=>{
  const cx=Math.round((x-m.originX)/m.resM), cz=Math.round((z-m.originZ)/m.resM);
  if(cx<0||cz<0||cx>=m.width||cz>=m.height) return -1;
  return cz*m.width+cx;
};
const runnabilityAt=(x,z)=>{const i=idx(x,z,rMeta); return i<0?10:rBuf[i];};
const heightAt=(x,z)=>{const i=idx(x,z,hMeta); if(i<0)return hMeta.minH;
  return hMeta.minH+(hBuf[i]/65535)*(hMeta.maxH-hMeta.minH);};
const featureScoreAt=(x,z)=>{
  const h=heightAt(x,z);
  const ns=[[0,-14],[0,14],[-14,0],[14,0],[-10,-10],[10,10],[-10,10],[10,-10]];
  let mean=0,maxd=0;
  for(const[dx,dz]of ns){const v=heightAt(x+dx,z+dz);mean+=v;maxd=Math.max(maxd,Math.abs(v-h));}
  mean/=ns.length;
  const relief=Math.min(1,Math.abs(h-mean)/2.2);
  const rough=Math.min(1,maxd/4.5);
  const cls=runnabilityAt(x,z);
  const clsBonus=(cls===9?0.35:cls===8?0.25:0);
  return Math.min(1, relief*0.6+rough*0.3+clsBonus);
};
const terrain={runnabilityAt,heightAt,featureScoreAt};
const venue={id:V,origin:{lon:0,lat:0},sizeX:2000,sizeZ:2000,mapScale:10000,contourInterval:5};

console.log('discipline  seed  controls  length   climb   legs(min/med/max)  turn<40deg  dogleg');
console.log('-'.repeat(88));
let sample=null;
for(const disc of ['long','middle','sprint']){
 for(const seed of [1,7,42]){
  const c=CG.generateCourse({venue,discipline:disc,seed,terrain});
  const pts=[c.start,...c.controls.map(x=>x.position),c.finish];
  const legs=[],turns=[];
  for(let i=0;i<pts.length-1;i++){
    const a=pts[i],b=pts[i+1];
    legs.push(Math.hypot(b.x-a.x,b.z-a.z));
    if(i>0){const p=pts[i-1];
      const b1=Math.atan2(a.x-p.x,-(a.z-p.z)), b2=Math.atan2(b.x-a.x,-(b.z-a.z));
      let d=b2-b1; while(d>Math.PI)d-=2*Math.PI; while(d<=-Math.PI)d+=2*Math.PI;
      turns.push(Math.abs(d)*180/Math.PI);}
  }
  legs.sort((a,b)=>a-b);
  const tight=turns.filter(t=>t<40).length;
  const dogleg=turns.filter(t=>t<25).length;
  console.log(
    disc.padEnd(11), String(seed).padEnd(5),
    String(c.controls.length).padStart(8),
    (c.lengthM+'m').padStart(8), (c.climbM+'m').padStart(7),
    `  ${Math.round(legs[0])}/${Math.round(legs[legs.length>>1])}/${Math.round(legs[legs.length-1])}`.padEnd(20),
    String(tight).padStart(9), String(dogleg).padStart(7));
  if(disc==='long'&&seed===1) sample=c;
 }
}

// Render the sample course over its own contours.
const M = await load('../../src/map/renderer.ts');
void M;
const half=1000;
let svg=`<svg xmlns="http://www.w3.org/2000/svg" viewBox="${-half} ${-half} ${half*2} ${half*2}" width="900" height="900" style="background:#fff">`;
// crude runnability wash
for(let z=-half;z<half;z+=8)for(let x=-half;x<half;x+=8){
  const c=runnabilityAt(x,z);
  const col={0:'#E5B182',1:'#000000',2:'#FAC14C',3:'#FBD179',4:null,5:'#CFE5C4',6:'#9AC983',7:'#43AA3A',8:'#00A9EB',9:'#BABCBF',10:'#B5A722'}[c];
  if(col) svg+=`<rect x="${x}" y="${z}" width="8" height="8" fill="${col}"/>`;
}
const P='#B24996';
const pts=[sample.start,...sample.controls.map(c=>c.position),sample.finish];
for(let i=0;i<pts.length-1;i++){
  const a=pts[i],b=pts[i+1],d=Math.hypot(b.x-a.x,b.z-a.z);
  const ux=(b.x-a.x)/d,uz=(b.z-a.z)/d, cl=25;
  svg+=`<line x1="${a.x+ux*cl}" y1="${a.z+uz*cl}" x2="${b.x-ux*cl}" y2="${b.z-uz*cl}" stroke="${P}" stroke-width="3.5"/>`;
}
for(const c of sample.controls) svg+=`<circle cx="${c.position.x}" cy="${c.position.z}" r="25" fill="none" stroke="${P}" stroke-width="3.5"/>`;
sample.controls.forEach((c,i)=>svg+=`<text x="${c.position.x+34}" y="${c.position.z-30}" fill="${P}" font-size="34" font-family="sans-serif">${i+1}</text>`);
svg+=`<circle cx="${sample.finish.x}" cy="${sample.finish.z}" r="35" fill="none" stroke="${P}" stroke-width="3.5"/><circle cx="${sample.finish.x}" cy="${sample.finish.z}" r="25" fill="none" stroke="${P}" stroke-width="3.5"/>`;
const s=sample.start,b0=sample.controls[0].position;
const ang=Math.atan2(b0.x-s.x,-(b0.z-s.z)),R=30;
svg+=`<polygon points="${[0,1,2].map(k=>{const a=ang+k*2*Math.PI/3;return `${s.x+Math.sin(a)*R},${s.z-Math.cos(a)*R}`}).join(' ')}" fill="none" stroke="${P}" stroke-width="3.5"/>`;
svg+='</svg>';
writeFileSync('public/_course.svg',svg);
console.log('\nwrote public/_course.svg  (long, seed 1)');
