/**
 * Workaround for a bug in `node-web-audio-api` (v2.1.0), used only by the
 * offline verification harness.
 *
 * ### The bug
 *
 * `AudioParam.setTargetAtTime(target, startTime, tc)` must leave the param
 * alone for `t < startTime` — the value there is whatever earlier events say.
 * This implementation applies the exponential curve to *all* time, including
 * backwards from `startTime`, so the param explodes before the event ever
 * happens. Demonstrated:
 *
 *   gain.value = 1
 *   gain.setTargetAtTime(0.4, 4, 0.1)
 *   → v(3.9) = 1.375e17,   which is exactly (1 − 0.4)·e^((4 − 0.003)/0.1) + 0.4
 *
 * Browsers do not do this; verified in Chrome via `tools/audio/preview.html`,
 * where the same graph produces the ducking trajectory the mixer intends.
 *
 * ### The workaround
 *
 * Replace `setTargetAtTime` with a piecewise-linear approximation of the same
 * exponential, built from `setValueAtTime` + `linearRampToValueAtTime`, which
 * this implementation gets right. 24 segments over 8 time constants keeps the
 * error under 1% of full scale and reaches within 0.03% of the target.
 *
 * To know the value the curve should start from, the shim also wraps the other
 * automation methods and keeps a small model of the last scheduled value per
 * param. That model is an approximation — it does not attempt to resolve
 * overlapping automation exactly — which is acceptable because everything this
 * harness measures schedules in increasing time order.
 *
 * Nothing here touches `src/audio/`. The shipped code calls the real
 * `setTargetAtTime` and always has.
 */

const SEGMENTS = 24;
const SPAN_TC = 8;

export function installSetTargetShim(AudioParamCtor) {
  const proto = AudioParamCtor.prototype ?? AudioParamCtor;
  if (proto.__setTargetShimmed) return false;
  proto.__setTargetShimmed = true;

  const last = new WeakMap(); // param → { t, v }
  const record = (p, t, v) => {
    const prev = last.get(p);
    if (!prev || t >= prev.t) last.set(p, { t, v });
  };
  const valueAt = (p, t) => {
    const prev = last.get(p);
    if (prev && prev.t <= t) return prev.v;
    return p.value;
  };

  const origSetValue = proto.setValueAtTime;
  const origLinear = proto.linearRampToValueAtTime;
  const origExp = proto.exponentialRampToValueAtTime;
  const origTarget = proto.setTargetAtTime;

  proto.setValueAtTime = function (v, t) {
    record(this, t, v);
    return origSetValue.call(this, v, t);
  };
  proto.linearRampToValueAtTime = function (v, t) {
    record(this, t, v);
    return origLinear.call(this, v, t);
  };
  proto.exponentialRampToValueAtTime = function (v, t) {
    record(this, t, v);
    return origExp.call(this, v, t);
  };
  proto.setTargetAtTime = function (target, startTime, tc) {
    if (!(tc > 0)) {
      record(this, startTime, target);
      return origSetValue.call(this, target, startTime);
    }
    const v0 = valueAt(this, startTime);
    origSetValue.call(this, v0, startTime);
    const span = SPAN_TC * tc;
    for (let i = 1; i <= SEGMENTS; i++) {
      const dt = (span * i) / SEGMENTS;
      const v = target + (v0 - target) * Math.exp(-dt / tc);
      origLinear.call(this, v, startTime + dt);
    }
    record(this, startTime + span, target);
    return this;
  };

  // Keep the originals reachable for anyone who wants to prove the bug again.
  proto.__origSetTargetAtTime = origTarget;
  return true;
}
