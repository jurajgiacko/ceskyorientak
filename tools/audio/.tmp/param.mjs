import { OfflineAudioContext } from 'node-web-audio-api';
const SR=48000;
async function t(label, f){
  const ctx=new OfflineAudioContext(1, 12*SR, SR);
  const s=ctx.createConstantSource(); s.offset.value=1;
  const g=ctx.createGain(); g.gain.value=1;
  s.connect(g).connect(ctx.destination); s.start(0);
  f(g.gain);
  const b=await ctx.startRendering(); const d=b.getChannelData(0);
  const at=x=>d[Math.round(x*SR)].toFixed(4);
  let peak=0,pi=0; for(let i=0;i<d.length;i++){const v=Math.abs(d[i]); if(v>peak){peak=v;pi=i;}}
  console.log(label.padEnd(34),'t=0:',at(0),'t=3.9:',at(3.9),'t=4.5:',at(4.5),'t=7.9:',at(7.9),'t=9:',at(9),'| peak',peak.toFixed(3),'@',(pi/SR).toFixed(3));
}
await t('none', ()=>{});
await t('one setTarget @4', p=>p.setTargetAtTime(0.4,4,0.1));
await t('two setTarget @4,@8', p=>{p.setTargetAtTime(0.4,4,0.1);p.setTargetAtTime(1,8,0.185);});
await t('setValue0 + two setTarget', p=>{p.setValueAtTime(1,0);p.setTargetAtTime(0.4,4,0.1);p.setTargetAtTime(1,8,0.185);});
await t('linearRamp version', p=>{p.setValueAtTime(1,4);p.linearRampToValueAtTime(0.4,4.3);p.setValueAtTime(0.4,8);p.linearRampToValueAtTime(1,8.6);});
