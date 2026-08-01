import { OfflineAudioContext } from 'node-web-audio-api';
const SR=48000;
const ctx=new OfflineAudioContext(1,1,SR);
const g=ctx.createGain();
console.log('impl bug: value before a setTargetAtTime event is the curve extrapolated backwards.');
console.log('expected v(3.9) = 1.0 (event is at t=4); got 1.375e17 = (1-0.4)*exp((4-0.003)/0.1)+0.4');
console.log('check:', ((1-0.4)*Math.exp((4-0.003)/0.1)+0.4).toExponential(3));
