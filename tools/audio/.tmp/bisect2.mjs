import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { OfflineAudioContext } from 'node-web-audio-api';
const ROOT='/Users/jurajgiacko/Projects/ceskyorientak';
const { AudioGraph, AudioSystem } = await import(pathToFileURL(resolve(ROOT,'tools/audio/.build/audio.mjs')).href);
const SR=48000;
async function run(label, apply) {
  const seconds=12;
  const ctx=new OfflineAudioContext(2, seconds*SR, SR);
  const graph=new AudioGraph(ctx,ctx.destination);
  graph.buildReverbs();
  const sys=new AudioSystem(graph,{seed:1});
  sys.setEnvironment('forest',0,0.01);
  sys.ambience.setWind(0.6,0,0.01);
  sys.start(0.02);
  apply(graph);
  const dt=1/60; for(let t=0;t<seconds;t+=dt) sys.ambience.update(t,dt);
  const b=await ctx.startRendering();
  let peak=0,at=0;
  for(let c=0;c<2;c++){const d=b.getChannelData(c); for(let i=0;i<d.length;i++){const v=Math.abs(d[i]); if(v>peak){peak=v;at=i/SR;}}}
  console.log(label.padEnd(22),'peak',peak.toFixed(4),'@',at.toFixed(3)+'s');
}
await run('baseline', ()=>{});
await run('tone only', g=>{const p=g.tone.frequency;
  p.cancelScheduledValues(4);p.setValueAtTime(20000,4);p.exponentialRampToValueAtTime(1700,4.32);
  p.cancelScheduledValues(8);p.setValueAtTime(1700,8);p.exponentialRampToValueAtTime(20000,8.6);});
await run('tone->1700 no return', g=>{const p=g.tone.frequency;
  p.setValueAtTime(20000,4);p.exponentialRampToValueAtTime(1700,4.32);});
await run('width only', g=>{g.width.gain.setTargetAtTime(0.35,4,0.1);g.width.gain.setTargetAtTime(1,8,0.185);});
await run('reverbReturn only', g=>{g.reverbReturn.gain.setTargetAtTime(0.55,4,0.1);g.reverbReturn.gain.setTargetAtTime(1,8,0.185);});
await run('duck gains only', g=>{for(const n of ['footsteps','breath','ambience','ui','music']){
  g.buses[n].duck.gain.setTargetAtTime(0.4,4,0.1);g.buses[n].duck.gain.setTargetAtTime(1,8,0.185);
  g.buses[n].aux.gain.setTargetAtTime(0.4,4,0.1);g.buses[n].aux.gain.setTargetAtTime(1,8,0.185);}});
