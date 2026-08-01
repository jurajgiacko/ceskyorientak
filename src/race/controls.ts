/**
 * Race input: keyboard and mouse on a desktop, thumbs on a phone.
 *
 * The phone is not the fallback here — the target player is standing in the
 * arena at Vyšší Brod holding one. So the touch layer is a first-class
 * left-thumb stick with a generous dead zone and a right-half look area, and
 * the keyboard path exists so the thing can be developed and QA'd.
 *
 * One deliberate omission: there is no strafe. An orienteer runs forwards and
 * turns; A/D turn rather than sidestep, which also frees the left thumb from
 * having to do two jobs at once.
 */

export interface MoveIntent {
  /** 0..1 throttle along the current heading. */
  forward: number;
  /** Turn rate in radians per second, from keys or the stick. */
  turn: number;
}

const KEY_TURN_RATE = 1.9;
const STICK_TURN_RATE = 2.4;
/** Radius of the stick well in CSS pixels, and the dead zone inside it. */
const STICK_R = 62;
const STICK_DEAD = 0.16;

export class RaceControls {
  /** The touch layer. Empty and inert when the device has no touch. */
  readonly root: HTMLElement;

  yaw = 0;
  pitch = -0.05;

  private readonly keys = new Set<string>();
  private readonly disposers: (() => void)[] = [];
  private pointerLocked = false;

  private stickId: number | null = null;
  private stickBase = { x: 0, y: 0 };
  private stickVec = { x: 0, y: 0 };
  private readonly knob: HTMLElement;

  private lookId: number | null = null;
  private lookLast = { x: 0, y: 0 };

  /** Suspended while the map overlay is up, so a pan is not also a turn. */
  suspended = false;

  constructor(touch: boolean) {
    this.root = document.createElement('div');
    this.root.className = 'rcontrols';
    this.root.dataset.touch = touch ? '1' : '0';
    this.root.innerHTML = `
      <div class="rcontrols__look" data-role="look"></div>
      <div class="rcontrols__stick" data-role="stick">
        <i class="rcontrols__knob" data-role="knob"></i>
      </div>`;
    const knob = this.root.querySelector<HTMLElement>('[data-role="knob"]');
    if (!knob) throw new Error('controls: knob missing');
    this.knob = knob;
    if (touch) this.bindTouch();
  }

  // -------------------------------------------------------------------------

  attachKeyboard(): void {
    const down = (e: KeyboardEvent) => {
      this.keys.add(e.code);
      if (e.code === 'KeyW' || e.code === 'KeyS' || e.code === 'Space') e.preventDefault();
    };
    const up = (e: KeyboardEvent) => this.keys.delete(e.code);
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    // A tab-out with a key held would otherwise leave the athlete running into
    // the fog until the player came back.
    const blur = () => this.keys.clear();
    window.addEventListener('blur', blur);
    this.disposers.push(() => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', blur);
    });
  }

  /** Pointer-lock mouse look on the 3D canvas. */
  attachMouse(target: HTMLElement): void {
    const click = () => {
      if (!this.pointerLocked && !this.suspended) void target.requestPointerLock();
    };
    const change = () => {
      this.pointerLocked = document.pointerLockElement === target;
    };
    const move = (e: MouseEvent) => {
      if (!this.pointerLocked || this.suspended) return;
      this.yaw -= e.movementX * 0.0022;
      this.pitch = clamp(this.pitch - e.movementY * 0.0022, -0.9, 0.9);
    };
    target.addEventListener('click', click);
    document.addEventListener('pointerlockchange', change);
    target.addEventListener('mousemove', move);
    this.disposers.push(() => {
      target.removeEventListener('click', click);
      document.removeEventListener('pointerlockchange', change);
      target.removeEventListener('mousemove', move);
    });
  }

  releasePointer(): void {
    if (this.pointerLocked) document.exitPointerLock();
  }

  // -------------------------------------------------------------------------

  private bindTouch(): void {
    const stick = this.root.querySelector<HTMLElement>('[data-role="stick"]');
    const look = this.root.querySelector<HTMLElement>('[data-role="look"]');
    if (!stick || !look) return;

    const sDown = (e: PointerEvent) => {
      if (this.suspended) return;
      e.preventDefault();
      stick.setPointerCapture(e.pointerId);
      this.stickId = e.pointerId;
      const r = stick.getBoundingClientRect();
      this.stickBase = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      this.sMove(e);
    };
    const sMove = (e: PointerEvent) => {
      if (e.pointerId !== this.stickId) return;
      e.preventDefault();
      this.sMove(e);
    };
    const sUp = (e: PointerEvent) => {
      if (e.pointerId !== this.stickId) return;
      this.stickId = null;
      this.stickVec = { x: 0, y: 0 };
      this.knob.style.transform = 'translate(-50%, -50%)';
    };
    stick.addEventListener('pointerdown', sDown);
    stick.addEventListener('pointermove', sMove);
    stick.addEventListener('pointerup', sUp);
    stick.addEventListener('pointercancel', sUp);

    const lDown = (e: PointerEvent) => {
      if (this.suspended) return;
      look.setPointerCapture(e.pointerId);
      this.lookId = e.pointerId;
      this.lookLast = { x: e.clientX, y: e.clientY };
    };
    const lMove = (e: PointerEvent) => {
      if (e.pointerId !== this.lookId || this.suspended) return;
      this.yaw -= (e.clientX - this.lookLast.x) * 0.006;
      this.pitch = clamp(this.pitch - (e.clientY - this.lookLast.y) * 0.005, -0.9, 0.9);
      this.lookLast = { x: e.clientX, y: e.clientY };
    };
    const lUp = (e: PointerEvent) => {
      if (e.pointerId === this.lookId) this.lookId = null;
    };
    look.addEventListener('pointerdown', lDown);
    look.addEventListener('pointermove', lMove);
    look.addEventListener('pointerup', lUp);
    look.addEventListener('pointercancel', lUp);

    this.disposers.push(() => {
      stick.removeEventListener('pointerdown', sDown);
      stick.removeEventListener('pointermove', sMove);
      stick.removeEventListener('pointerup', sUp);
      stick.removeEventListener('pointercancel', sUp);
      look.removeEventListener('pointerdown', lDown);
      look.removeEventListener('pointermove', lMove);
      look.removeEventListener('pointerup', lUp);
      look.removeEventListener('pointercancel', lUp);
    });
  }

  private sMove(e: PointerEvent): void {
    let dx = (e.clientX - this.stickBase.x) / STICK_R;
    let dy = (e.clientY - this.stickBase.y) / STICK_R;
    const len = Math.hypot(dx, dy);
    if (len > 1) {
      dx /= len;
      dy /= len;
    }
    this.stickVec = { x: dx, y: dy };
    this.knob.style.transform = `translate(calc(-50% + ${dx * STICK_R}px), calc(-50% + ${
      dy * STICK_R
    }px))`;
  }

  // -------------------------------------------------------------------------

  /** Read the current intent and integrate turning into the heading. */
  step(dtS: number): MoveIntent {
    if (this.suspended) {
      // Reading the map does not stop the athlete — `Race` keeps them moving at
      // 55%. It stops them *steering*, which is exactly what happens when your
      // eyes are on the sheet.
      return { forward: this.lastForward, turn: 0 };
    }

    let forward = 0;
    let turn = 0;

    if (this.keys.has('KeyW') || this.keys.has('ArrowUp')) forward += 1;
    if (this.keys.has('KeyS') || this.keys.has('ArrowDown')) forward -= 0.55;
    if (this.keys.has('KeyA') || this.keys.has('ArrowLeft') || this.keys.has('KeyQ')) {
      turn -= KEY_TURN_RATE;
    }
    if (this.keys.has('KeyD') || this.keys.has('ArrowRight') || this.keys.has('KeyE')) {
      turn += KEY_TURN_RATE;
    }

    if (this.stickId !== null) {
      const { x, y } = this.stickVec;
      const mag = Math.hypot(x, y);
      if (mag > STICK_DEAD) {
        forward += clamp(-y / (1 - STICK_DEAD), -0.55, 1);
        turn += x * STICK_TURN_RATE;
      }
    }

    this.yaw += turn * dtS;
    this.lastForward = clamp(forward, -0.55, 1);
    return { forward: this.lastForward, turn };
  }

  private lastForward = 0;

  dispose(): void {
    this.releasePointer();
    for (const d of this.disposers) d();
    this.disposers.length = 0;
    this.root.remove();
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
