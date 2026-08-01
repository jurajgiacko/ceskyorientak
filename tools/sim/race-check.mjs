/* Simulate complete races on real terrain with a naive "perfect navigator"
   pilot, and check the winning times land where real ones do. */
import { readFileSync, writeFileSync } from 'node:fs';
const { build } = await import('vite');
async function load(entry){
  const out=await build({configFile:false,logLevel:'error',
    resolve:{alias:{'@':new URL('../../src',import.meta.url).pathname}},
    build:{write:false,lib:{entry:new URL(entry,import.meta.url).pathname,formats:['es'],fileName:'m'}}});
  const p=`/tmp/rc_${Math.abs(entry.split('').reduce((a,c)=>a*31+c.charCodeAt(0)|0,7))}.mjs`;
  writeFileSync(p,out[0].output[0].code); return import(p);
}
const CG=await load('../../src/sim/courseGen.ts');
const RC=await load('../../src/sim/race.ts');

const V='martinkov';
const rM=JSON.parse(readFileSync(`public/data/${V}/runnability.json`,'utf8'));
const rB=readFileSync(`public/data/${V}/runnability.bin`);
const hM=JSON.parse(readFileSync(`public/data/${V}/height.json`,'utf8'));
const hR=readFileSync(`public/data/${V}/height.bin`);
const hB=new Uint16Array(hR.buffer,hR.byteOffset,hR.length/2);
const idx=(x,z,m)=>{const cx=Math.round((x-m.originX)/m.resM),cz=Math.round((z-m.originZ)/m.resM);
  return (cx<0||cz<0||cx>=m.width||cz>=m.height)?-1:cz*m.width+cx;};
const runnabilityAt=(x,z)=>{const i=idx(x,z,rM);return i<0?10:rB[i];};
const heightAt=(x,z)=>{const i=idx(x,z,hM);return i<0?hM.minH:hM.minH+(hB[i]/65535)*(hM.maxH-hM.minH);};
const featureScoreAt=(x,z)=>{const h=heightAt(x,z);
  const ns=[[0,-14],[0,14],[-14,0],[14,0]];let mean=0,maxd=0;
  for(const[dx,dz]of ns){const v=heightAt(x+dx,z+dz);mean+=v;maxd=Math.max(maxd,Math.abs(v-h));}
  mean/=4;return Math.min(1,Math.min(1,Math.abs(h-mean)/2.2)*0.6+Math.min(1,maxd/4.5)*0.3+(runnabilityAt(x,z)===9?0.35:0));};

const terrain={
  sample(x,z){
    const h=heightAt(x,z), e=heightAt(x+3,z), n=heightAt(x,z-3);
    return {height:h, slope:(Math.max(e,n)-h)/3, runnability:runnabilityAt(x,z), ground:'needles'};
  },
  ambiguityAt:()=>0.35, complexityAt:()=>0.45,
};

console.log('discipline  seed  length  climb   time     pace(min/km)  splits  result');
console.log('-'.repeat(78));
for(const disc of ['long','middle']){
 for(const seed of [1,7,42]){
  const course=CG.generateCourse({venue:{id:V,origin:{lon:0,lat:0},sizeX:2000,sizeZ:2000,mapScale:10000,contourInterval:5},
    discipline:disc,seed,terrain:{runnabilityAt,heightAt,featureScoreAt}});
  const race=new RC.Race({course,terrain,heat:0.35,seed});
  race.setBeltItems(2); race.start();

  const dt=0.1; let guard=0;
  while(race.phase==='running'&&guard++<120000){
    const v=race.view();
    const tgt=v.target?v.target.position:course.finish;
    const p=race.athlete.position;
    // Perfect navigator: head straight at the true target.
    let heading=Math.atan2(tgt.x-p.x,-(tgt.z-p.z));
    // Minimal avoidance: if the way ahead is impassable, fan out for a clear
    // bearing. Without this the pilot walks into olive and stays there - which
    // says nothing about the game, only about the pilot.
    const clear=(hh,d)=>runnabilityAt(p.x+Math.sin(hh)*d,p.z-Math.cos(hh)*d)!==10;
    if(!clear(heading,6)){
      for(const off of [0.4,-0.4,0.8,-0.8,1.2,-1.2,1.7,-1.7,2.4,-2.4]){
        if(clear(heading+off,10)){heading+=off;break;}
      }
    }
    // Read the map ~8% of the time, as a real orienteer does.
    race.readingMap=(guard%13===0);
    if(guard%67===0) race.planAhead();
    race.step(dt,{forward:1,heading});
  }
  const r=race.result();
  const min=r.timeS/60;
  const pace=(r.timeS/60)/(course.lengthM/1000);
  console.log(
   disc.padEnd(11),String(seed).padEnd(5),
   ((course.lengthM/1000).toFixed(1)+'km').padStart(6),
   (course.climbM+'m').padStart(6),
   (Math.floor(min)+':'+String(Math.round((min%1)*60)).padStart(2,'0')).padStart(8),
   pace.toFixed(2).padStart(12),
   String(r.splits.length).padStart(7),
   '  '+(r.valid?'OK':'DSQ '+(r.mispunch?`(${r.mispunch.expected}->${r.mispunch.got})`:'')));
 }
}
