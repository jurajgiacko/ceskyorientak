/**
 * The race controller.
 *
 * Ties the pieces together into an actual competition: a course, an athlete
 * whose four stats deplete, a belief about position that drifts, controls that
 * must be punched *in order*, splits, and a finish that can be a
 * disqualification.
 *
 * Everything it needs already existed and was tested in isolation — this is the
 * wiring, and deliberately thin. The interesting behaviour lives in
 * `athlete.ts` (physiology), `navigation.ts` (dead reckoning) and
 * `courseGen.ts` (course setting); putting logic here instead would hide it
 * from the tests that already cover those.
 */

import type {
  AthleteState,
  Control,
  Course,
  RunResult,
  RoutePoint,
  Split,
  World2,
  TerrainSample,
} from '@/core/types';
import { Runnability } from '@/core/types';
import {
  depleteStats,
  speedFactor,
  controlApproachPenalty,
  overfuellingPenalty,
  relativeIntensity,
  SPEED_BY_RUNNABILITY,
  freshStats,
} from './athlete';
import { Cornering, easeSpeed } from './cornering';
import type { RefreshmentPoint, CupKind } from './refreshment';
import { drinkCup, cupContents, type CupEffect } from '@/nutrition/cup';
import {
  Rng,
  initNav,
  stepNav,
  punchRelocate,
  navError,
  type NavState,
} from './navigation';
import { dist2 } from '@/core/geo';

export type RacePhase = 'prestart' | 'running' | 'finished' | 'mispunched';

export interface RaceTerrain {
  sample(x: number, z: number): TerrainSample;
  /** How ambiguous the surroundings are, 0..1 — drives parallel errors. */
  ambiguityAt(x: number, z: number): number;
  /** How hard the ground is to keep map contact with, 0..1. */
  complexityAt(x: number, z: number): number;
}

export interface RaceOptions {
  course: Course;
  terrain: RaceTerrain;
  /** 0 = cool and dry, 1 = hot and humid. */
  heat?: number;
  /** Nutrition taken before the start — see docs/NUTRITION_PROTOCOL.md. */
  preRace?: string[];
  seed?: number;
}

/** What the HUD needs each frame. Deliberately a value, not the live state. */
export interface RaceView {
  phase: RacePhase;
  /** Elapsed race time, seconds. */
  timeS: number;
  /** Index of the control being sought, 0-based. Equals control count at finish. */
  nextControl: number;
  /** The control the athlete is looking for, or null once heading to finish. */
  target: Control | null;
  /** Where the map should draw the athlete — their *belief*, never the truth. */
  believedPosition: World2;
  /** True position. For the 3D camera only; must never reach the map. */
  truePosition: World2;
  heading: number;
  speedMs: number;
  splits: Split[];
  /** 0..1, drives map clarity at the edges. */
  clarity: number;
  glycogen: number;
  hydration: number;
  bloodSugar: number;
  focus: number;
  /** Set for a couple of seconds after a punch, for the beep and the flash. */
  justPunched: { code: number; correctedM: number } | null;
  /**
   * The refreshment point the athlete is standing in, if any, and whether it
   * still has anything for them.
   *
   * Null everywhere on a Sprint, because IOF Rule 19.8 puts no refreshment on a
   * course whose winning time is under 30 minutes — see `sim/refreshment.ts`.
   */
  atRefreshment: {
    point: RefreshmentPoint;
    /** False once this athlete has drunk here; a station is taken once. */
    available: boolean;
  } | null;
}

export class Race {
  readonly course: Course;
  private terrain: RaceTerrain;
  private rng: Rng;
  private heat: number;

  phase: RacePhase = 'prestart';
  athlete: AthleteState;
  nav: NavState;
  /**
   * What the athlete's turning is costing them. Public so the debug overlay
   * and the gates can read the turn rate and the radius without the HUD having
   * to carry a diagnostic. See `src/sim/cornering.ts`.
   */
  readonly cornering = new Cornering();
  splits: Split[] = [];
  nextControl = 0;

  /**
   * Punches on controls that were not the current target.
   *
   * Kept because a real SI card keeps them, and because the results screen
   * should be able to say "you ran past 3 twice" — which is interesting, and is
   * exactly the kind of thing a split analysis shows. They never affect
   * validity.
   */
  private extraPunches: { code: number; atS: number }[] = [];

  /** Recorded for the ghost. Downsampled — see `ROUTE_SAMPLE_S`. */
  private route: RoutePoint[] = [];
  private lastRouteAt = -1;

  /** True while the player is reading the map this frame. */
  readingMap = false;
  /**
   * Whether the next leg was planned before arriving at the current control.
   * This is the measured skill difference between national and club orienteers
   * — see `controlApproachPenalty`.
   */
  private plannedAhead = false;

  private punchFlash: { code: number; correctedM: number; until: number } | null = null;
  private mispunch: RunResult['mispunch'];
  private nutritionDuring: { skuId: string; atS: number }[] = [];
  private preRace: string[];
  private carbsConsumedG = 0;
  private beltItems = 0;

  /**
   * Refreshment points already drunk at, by point id.
   *
   * A station is taken once. Standing at the table drinking cup after cup is
   * not a thing that happens in a race, and allowing it would turn a rule of
   * the sport into a refill button.
   */
  private refreshmentsTaken = new Set<string>();
  /** Cups drunk, for the results screen. */
  private cupsTaken: { kind: CupKind; atS: number; pointId: string }[] = [];

  /** Seconds of route recording granularity. 1 Hz is ample for a ghost. */
  private static readonly ROUTE_SAMPLE_S = 1;

  constructor(o: RaceOptions) {
    this.course = o.course;
    this.terrain = o.terrain;
    this.heat = o.heat ?? 0.3;
    this.rng = new Rng(o.seed ?? o.course.seed);
    this.preRace = o.preRace ?? [];

    this.athlete = {
      stats: freshStats(),
      position: { ...o.course.start },
      heading: 0,
      speed: 0,
      timeS: 0,
      believedPosition: { ...o.course.start },
      navErrorM: 0,
    };
    this.nav = initNav(o.course.start);
  }

  /** Leave the start triangle. Timing begins here. */
  start(): void {
    if (this.phase !== 'prestart') return;
    this.phase = 'running';
    // The athlete has been standing on the triangle turning to face the first
    // control; none of that is a corner they ran.
    this.cornering.reset();
    this.route = [{ t: 0, x: this.athlete.position.x, z: this.athlete.position.z }];
  }

  /**
   * Advance the race by `dtS`.
   *
   * @param intent  desired movement: `forward` 0..1 and `heading` in radians.
   */
  step(dtS: number, intent: { forward: number; heading: number }): void {
    if (this.phase !== 'running') return;

    const a = this.athlete;
    a.timeS += dtS;
    a.heading = intent.heading;

    const here = this.terrain.sample(a.position.x, a.position.z);

    // --- speed ------------------------------------------------------------
    // Base pace for an elite orienteer on good going, before terrain and
    // physiology. Calibrated against real winning times in athlete.ts.
    const BASE_MS = 4.6;
    const terrainMul = SPEED_BY_RUNNABILITY[here.runnability] ?? 0.5;

    // Gradient. Uphill costs sharply, downhill helps only a little and then
    // starts to hurt — you cannot descend a 30% slope faster than flat ground.
    const g = here.slope;
    const gradeMul = g > 0 ? 1 / (1 + g * 4.2) : 1 + Math.min(0.22, -g * 0.9);

    const fuel = speedFactor(a.stats);
    const belt = overfuellingPenalty(this.beltItems, this.carbsConsumedG, a.timeS);

    // Reading the map costs pace. This is the core tension of the sport, so it
    // is a real cost rather than a pause: you keep moving, more slowly.
    const readMul = this.readingMap ? 0.55 : 1;

    const straight =
      here.runnability === Runnability.Impassable
        ? 0
        : BASE_MS * terrainMul * gradeMul * fuel * belt.speedMul * readMul * intent.forward;

    // Cornering. What the athlete could hold in a straight line is not what
    // they can hold through a corner, and a sprint in an old town is corners.
    // The model — and the argument for why the cost lands here rather than on
    // how fast the player may turn — is `src/sim/cornering.ts`.
    this.cornering.step(dtS, a.heading, a.speed);
    const target = this.cornering.limit(straight);

    // Ease toward the target: Furusawa–Hill acceleration, flat braking, and
    // braking is the faster of the two. Most of what a corner costs is the ten
    // metres afterwards, and a symmetric constant hid that.
    a.speed = easeSpeed(a.speed, target, dtS);
    const moved = a.speed * dtS;

    const dx = Math.sin(a.heading) * moved;
    const dz = -Math.cos(a.heading) * moved;
    const blocked = (x: number, z: number) =>
      this.terrain.sample(x, z).runnability === Runnability.Impassable;

    // Impassable ground blocks. In sprint this is a rule, not a suggestion —
    // crossing an olive or a wall is a disqualification offence.
    //
    // But blocking must SLIDE, not pin. Rejecting the whole step leaves the
    // athlete welded to the obstacle for as long as they hold that heading,
    // which is both unplayable and wrong: a runner meeting an uncrossable wall
    // follows it. Resolving each axis separately gives that for free, and it is
    // what makes Krumlov's walls readable as geometry rather than as glue.
    if (!blocked(a.position.x + dx, a.position.z + dz)) {
      a.position.x += dx;
      a.position.z += dz;
    } else {
      let slid = false;
      if (!blocked(a.position.x + dx, a.position.z)) {
        a.position.x += dx;
        slid = true;
      }
      if (!blocked(a.position.x, a.position.z + dz)) {
        a.position.z += dz;
        slid = true;
      }
      // Sliding along an obstacle costs pace; being fully stopped costs more.
      a.speed *= slid ? 0.72 : 0.25;
    }

    // --- physiology -------------------------------------------------------
    // Effort is measured against what THIS ground allows, not against a road
    // pace — see `relativeIntensity()`. Using `a.speed / BASE_MS` scored an
    // athlete racing through Green1 at 0.15 intensity because they were only
    // making 0.7 m/s, which had terrain quietly *reducing* the metabolic cost
    // of the hardest running in the sport.
    depleteStats(a.stats, {
      intensity: relativeIntensity(a.speed, BASE_MS, here.runnability),
      runnability: here.runnability,
      slope: here.slope,
      heat: this.heat,
      dtS,
    });

    // --- belief -----------------------------------------------------------
    stepNav(this.nav, {
      truePos: a.position,
      movedM: moved,
      movedHeading: a.heading,
      speedMs: a.speed,
      stats: a.stats,
      complexity: this.terrain.complexityAt(a.position.x, a.position.z),
      ambiguity: this.terrain.ambiguityAt(a.position.x, a.position.z),
      readingMap: this.readingMap,
      dtS,
      rng: this.rng,
    });
    a.believedPosition = this.nav.believed;
    a.navErrorM = navError(this.nav, a.position);

    this.recordRoute();
    this.checkPunch();
  }

  /**
   * Attempt to punch whatever is under the athlete.
   *
   * Punching out of order is a **mispunch**, and a mispunch is a
   * disqualification — not a penalty, not a detour. That severity is the whole
   * reason control order matters, so it is modelled honestly.
   */
  private checkPunch(): void {
    const a = this.athlete;

    if (this.nextControl < this.course.controls.length) {
      // Extra punches are RECORDED AND IGNORED. This is the real rule and it
      // took a disqualification to get right.
      //
      // A SportIdent card holds every punch in order, and the download checks
      // that the required controls appear **as a subsequence**. Punching a
      // control that is not your current target — one you already visited, or
      // one you will need later — is simply an extra entry between the ones
      // that matter. It is not an offence. You are disqualified for *missing* a
      // control or taking the required ones out of order, which is a property
      // of the whole record and can only be judged at the finish.
      //
      // Treating a stray punch as an instant DSQ was both wrong and brutal in a
      // sprint: at 45 m control separation and a 6 m punch radius, Krumlov's
      // street network forces you past controls you have not reached yet, and
      // the client was disqualified for running down the correct street.
      for (let i = 0; i < this.course.controls.length; i++) {
        const c = this.course.controls[i]!;
        if (dist2(a.position, c.position) > c.punchRadius) continue;

        if (i !== this.nextControl) {
          // Log it the way the card would, and carry on.
          if (this.extraPunches[this.extraPunches.length - 1]?.code !== c.code) {
            this.extraPunches.push({ code: c.code, atS: a.timeS });
          }
          continue;
        }

        this.punch(c);
        return;
      }
      return;
    }

    // All controls done — the finish is a punch too.
    if (dist2(a.position, this.course.finish) < 12) {
      this.phase = 'finished';
      this.recordRoute(true);
    }
  }

  private punch(c: Control): void {
    const a = this.athlete;
    const { correctedM } = punchRelocate(this.nav, c.position);
    a.believedPosition = this.nav.believed;
    a.navErrorM = 0;

    const prev = this.splits.length ? this.splits[this.splits.length - 1]!.elapsedS : 0;
    this.splits.push({
      controlId: c.id,
      elapsedS: a.timeS,
      legS: a.timeS - prev,
    });

    // The cost of arriving without having planned the next leg. Measured:
    // national orienteers show a 5 bpm rise at controls, club runners 17.
    const cost = controlApproachPenalty(this.plannedAhead);
    a.stats.glycogen = Math.max(0, a.stats.glycogen - cost.glycogenCost);
    a.stats.focus = Math.max(0, a.stats.focus - cost.focusCost);
    this.plannedAhead = false;

    this.nextControl++;
    this.punchFlash = { code: c.code, correctedM, until: a.timeS + 2.2 };
  }

  /** Call while the player studies the map for the leg ahead. */
  planAhead(): void {
    this.plannedAhead = true;
  }

  /** Consume an item from the race belt. Costs real seconds of running. */
  takeNutrition(skuId: string, carbsG: number): void {
    if (this.phase !== 'running') return;
    this.nutritionDuring.push({ skuId, atS: this.athlete.timeS });
    this.carbsConsumedG += carbsG;
    this.beltItems = Math.max(0, this.beltItems - 1);
  }

  setBeltItems(n: number): void {
    this.beltItems = n;
  }

  /**
   * The refreshment point the athlete is within reach of, or null.
   *
   * Distance is to the *true* position, not the believed one. A table with
   * people at it is a thing you can see; being lost does not hide it from you,
   * and the whole reason a station stands at a control is that you cannot miss
   * it once you are there.
   */
  refreshmentInReach(): RefreshmentPoint | null {
    if (this.phase !== 'running') return null;
    const p = this.athlete.position;
    for (const r of this.course.refreshments) {
      if (dist2(p, r.position) <= r.reachM) return r;
    }
    return null;
  }

  /**
   * Drink a cup at the station the athlete is standing in.
   *
   * Returns what moved, or null if there was nothing to take — out of reach,
   * already drunk here, or that station does not offer that cup. The caller
   * applies the time cost, exactly as it does for a belt item.
   */
  takeCup(kind: CupKind): CupEffect | null {
    const r = this.refreshmentInReach();
    if (!r) return null;
    if (this.refreshmentsTaken.has(r.id)) return null;
    if (!r.offers.includes(kind)) return null;

    this.refreshmentsTaken.add(r.id);
    const effect = drinkCup(this.athlete.stats, kind);
    this.cupsTaken.push({ kind, atS: this.athlete.timeS, pointId: r.id });

    // A cup of the event's hypotonic mix carries ~5 g of carbohydrate, and it
    // counts toward the gut like any other carbohydrate. It is small enough
    // that it will never on its own trip `overfuellingPenalty`, which is the
    // honest outcome rather than a designed exemption.
    if (kind === 'sportsDrink') {
      this.carbsConsumedG += cupContents(kind).carbsG;
    }
    return effect;
  }

  /** True once this athlete has drunk at this point. */
  hasTakenRefreshment(id: string): boolean {
    return this.refreshmentsTaken.has(id);
  }

  private recordRoute(force = false): void {
    const t = Math.floor(this.athlete.timeS / Race.ROUTE_SAMPLE_S);
    if (!force && t === this.lastRouteAt) return;
    this.lastRouteAt = t;
    this.route.push({
      t: Math.round(this.athlete.timeS * 10) / 10,
      x: Math.round(this.athlete.position.x * 10) / 10,
      z: Math.round(this.athlete.position.z * 10) / 10,
    });
  }

  /** A snapshot for the HUD and the map. */
  view(): RaceView {
    const a = this.athlete;
    const flash =
      this.punchFlash && a.timeS < this.punchFlash.until
        ? { code: this.punchFlash.code, correctedM: this.punchFlash.correctedM }
        : null;

    return {
      phase: this.phase,
      timeS: a.timeS,
      nextControl: this.nextControl,
      target: this.course.controls[this.nextControl] ?? null,
      believedPosition: a.believedPosition,
      truePosition: a.position,
      heading: a.heading,
      speedMs: a.speed,
      splits: this.splits,
      // Focus drives how legible the map is at the edges. Never a bar.
      clarity: a.stats.focus,
      glycogen: a.stats.glycogen,
      hydration: a.stats.hydration,
      bloodSugar: a.stats.bloodSugar,
      focus: a.stats.focus,
      justPunched: flash,
      // Computed here rather than tracked, because "am I standing in it" is a
      // question about right now and the answer has to survive the athlete
      // being moved by anything other than their own legs.
      atRefreshment: ((): RaceView['atRefreshment'] => {
        const point = this.refreshmentInReach();
        if (!point) return null;
        return { point, available: !this.refreshmentsTaken.has(point.id) };
      })(),
    };
  }

  /** The result, once finished or disqualified. */
  result(): RunResult {
    return {
      courseId: this.course.id,
      venue: this.course.venue,
      discipline: this.course.discipline,
      timeS: this.athlete.timeS,
      splits: this.splits,
      valid: this.phase === 'finished',
      ...(this.mispunch ? { mispunch: this.mispunch } : {}),
      at: new Date().toISOString(),
      route: this.route,
      nutrition: {
        before: this.preRace,
        during: this.nutritionDuring,
        after: [],
      },
    };
  }
}
