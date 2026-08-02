/**
 * Race input: keyboard and mouse on a desktop, thumbs on a phone.
 *
 * The phone is not the fallback here — the target player is standing in the
 * arena at Vyšší Brod holding one. So the touch layer is a first-class
 * left-thumb stick with a generous dead zone and a right-half look area, and
 * the keyboard path exists so the thing can be developed and QA'd.
 *
 * Controls follow **standard first-person convention**, because that is what
 * every player's hands already know: W/S move, **A/D strafe**, the mouse turns.
 *
 * An earlier version made A/D *turn* instead, reasoning that an orienteer runs
 * forwards and turns rather than sidestepping. That is true of the sport and
 * wrong for the game: it is tank control, and it made the whole thing feel
 * clumsy and unlearnable to anyone who has played anything since 1998. Realism
 * about the athlete is not worth spending the player's first thirty seconds on
 * fighting the keys.
 *
 * Movement direction and facing are therefore decoupled: the WASD vector is
 * rotated into world space by the camera yaw, and the resulting *movement*
 * heading is what goes to the physics. `Race` still takes a single heading, so
 * the simulation is untouched by this.
 */

export interface MoveIntent {
  /** 0..1 throttle along `heading`. */
  forward: number;
  /**
   * World-space direction of travel, radians, 0 = north.
   *
   * Not the same as where the camera looks: strafing left while facing north
   * gives a heading of west. Decoupling the two is the whole point of
   * conventional FPS movement.
   */
  heading: number;
}

/**
 * How fast the intended direction swings toward the keys, per second.
 *
 * Instant direction changes read as twitchy and make the runner feel weightless;
 * a person carrying momentum takes a moment to redirect. This is a *feel*
 * constant and is deliberately not derived from anything physical.
 */
const HEADING_RESPONSE = 9.5;
/** How fast the throttle ramps. Slower to start than to stop, as legs are. */
const ACCEL_UP = 4.2;
const ACCEL_DOWN = 7.0;
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
      return { forward: this.lastForward, heading: this.moveHeading ?? -this.yaw };
    }

    // Local movement vector: +ax is right (strafe), +az is forward.
    let ax = 0;
    let az = 0;

    if (this.keys.has('KeyW') || this.keys.has('ArrowUp')) az += 1;
    if (this.keys.has('KeyS') || this.keys.has('ArrowDown')) az -= 1;
    if (this.keys.has('KeyA') || this.keys.has('ArrowLeft')) ax -= 1;
    if (this.keys.has('KeyD') || this.keys.has('ArrowRight')) ax += 1;

    if (this.stickId !== null) {
      const { x, y } = this.stickVec;
      if (Math.hypot(x, y) > STICK_DEAD) {
        ax += x;
        az += -y;
      }
    }

    const mag = Math.hypot(ax, az);
    if (mag > 0.001) {
      // Normalise so diagonals are not faster than the cardinals — the oldest
      // bug in first-person movement, and instantly felt even when unnoticed.
      const nx = ax / mag;
      const nz = az / mag;

      // Rotate the local vector into the world.
      //
      // `yaw` drives the camera as Euler(pitch, yaw, 0, 'YXZ'), and three's Y
      // rotation is counter-clockwise, so the camera's forward vector is
      // (-sin yaw, -cos yaw) in (x, z). Our bearings are clockwise from north
      // (core/geo.ts), which makes the look bearing exactly **-yaw**.
      //
      // This was measured, not derived: assuming yaw was already a bearing put
      // movement 65 degrees off from where the camera pointed. Two opposite
      // angle conventions meeting in one file is worth stating plainly rather
      // than leaving to whoever reads it next.
      const look = -this.yaw;
      const wx = nz * Math.sin(look) + nx * Math.cos(look);
      const wz = -nz * Math.cos(look) + nx * Math.sin(look);
      const want = Math.atan2(wx, -wz);

      // Ease the heading rather than snapping, so a direction change carries a
      // little momentum instead of pivoting on the spot.
      if (this.moveHeading === null) this.moveHeading = want;
      const delta = wrap(want - this.moveHeading);
      this.moveHeading = wrap(
        this.moveHeading + delta * Math.min(1, HEADING_RESPONSE * dtS),
      );

      // Backwards and sideways are slower than forwards, as they are in life.
      const throttle = Math.min(1, mag) * (az < -0.3 ? 0.55 : ax !== 0 && az === 0 ? 0.78 : 1);
      const rate = throttle > this.lastForward ? ACCEL_UP : ACCEL_DOWN;
      this.lastForward += (throttle - this.lastForward) * Math.min(1, rate * dtS);
    } else {
      this.lastForward += (0 - this.lastForward) * Math.min(1, ACCEL_DOWN * dtS);
    }

    if (this.lastForward < 0.002) this.lastForward = 0;
    return { forward: this.lastForward, heading: this.moveHeading ?? -this.yaw };
  }

  private lastForward = 0;
  /**
   * Smoothed world-space direction of travel.
   *
   * `null` until the first input, so the first step snaps to where the player
   * is looking instead of easing there from due north.
   */
  private moveHeading: number | null = null;

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

/** Normalise an angle to (-PI, PI], so easing takes the short way round. */
function wrap(rad: number): number {
  let r = rad % (Math.PI * 2);
  if (r > Math.PI) r -= Math.PI * 2;
  if (r <= -Math.PI) r += Math.PI * 2;
  return r;
}
