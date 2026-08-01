import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { OfflineAudioContext } from 'node-web-audio-api';
const ROOT='/Users/jurajgiacko/Projects/ceskyorientak';
const audio = await import(pathToFileURL(resolve(ROOT,'tools/audio/.build/audio.mjs')).href);
const { AudioGraph, AudioSystem } = audio;
const SR=48000;
const athlete=(o={})=>({stats:{glycogen:o.g??0.55,hydration:1,bloodSugar:.7,focus:1},position:{x:0,z:0},heading:0,speed:o.s??3.4,timeS:0,believedPosition:{x:0,z:0},navErrorM:0});

async function run(label, {duck, sub}) {
  const seconds=12;
  const ctx=new OfflineAudioContext(2, seconds*SR, SR);
  const graph=new AudioGraph(ctx,ctx.destination);
  graph.buildReverbs();
  const sys=new AudioSystem(graph,{seed:20260805});
  sys.setEnvironment('forest',0,0.01);
  sys.ambience.setWind(0.6,0,0.01);
  sys.start(0.02);
  if (duck){ sys.mixer.duckForMap(true,4.0); sys.mixer.duckForMap(false,8.0);}
  const dt=1/60;
  for(let t=0;t<seconds;t+=dt){
    if(sub==='all') sys.update(t,dt,athlete(),{ground:'needles',runnability:4});
    else if(sub==='amb') sys.ambience.update(t,dt);
    else if(sub==='music'){sys.music.setTension(0.5);sys.music.update(t,dt);}
    else if(sub==='breath') sys.breathing.update(t,dt,{glycogen:0.55,speed:3.4,hydration:1});
    else if(sub==='feet') sys.footsteps.update(t,dt,{ground:'needles',speed:3.4,runnability:4,glycogen:0.55});
  }
  const b=await ctx.startRendering();
  let peak=0,nan=0, firstNan=-1;
  for(let c=0;c<2;c++){const d=b.getChannelData(c);
    for(let i=0;i<d.length;i++){const v=d[i]; if(!Number.isFinite(v)){nan++; if(firstNan<0)firstNan=i;} else if(Math.abs(v)>peak)peak=Math.abs(v);}}
  console.log(label.padEnd(28), 'peak', peak.toFixed(4), 'nonfinite', nan, 'firstAt', firstNan>=0?(firstNan/SR).toFixed(3)+'s':'-');
}
for (const sub of ['none','amb','music','breath','feet','all'])
  for (const duck of [false,true])
    await run(`${sub} duck=${duck}`, {duck, sub});
