/**
 * The race controller — the wiring the whole brief is about.
 *
 * `Race` (src/sim/race.ts) is the engine and is not touched here: it owns the
 * course, the punching order, the splits, the mispunch-is-a-DSQ rule and the
 * belief that drifts. This class does four things around it:
 *
 *   1. turns input into `{ forward, heading }` and steps the race,
 *   2. drives the 3D scene as a puppet of the athlete's *true* position,
 *   3. drives the HUD and the 2D map from `race.view()`,
 *   4. runs the prestart → running → finished/DSQ state machine.
 *
 * The separation that matters: the scene is given the true position because a
 * camera is a pair of eyes, and the map is given the believed position because
 * a map is a piece of paper. `RaceView` hands out both and it is this file's
 * job never to confuse them — `RaceMap` is constructed with a subject that
 * closes over `believedPosition` only.
 */

import { Race } from '@/sim/race';
import type { RaceView } from '@/sim/race';
import { setCourse } from './courseSetup';
import type { CourseSetupResult } from './courseSetup';
import type { Course, Discipline, VenueAnchor, World2 } from '@/core/types';
import { Runnability } from '@/core/types';
import { dist2 } from '@/core/geo';
import { GROUND_FOR_RUNNABILITY } from '@/world/terrain';
import type { TerrainField } from '@/world/terrain';
import type { BearingAim } from '@/world/bearingBand';
import type { ControlMarker, ControlMarkerState } from '@/world/controlMarkers';
import { getSettings } from '@/core/settings';
import { FieldTerrain } from './terrainAdapter';
import { buildUrbanFeatures } from './urbanFeatures';
import type { TownscapeData } from '@/world/buildings';
import { buildMapData } from './mapData';
import { RaceMap } from './raceMap';
import { RaceHud } from './hud';
import { readEnergy } from './energy';
import { RaceControls } from './controls';
import { punch as playPunch, updateAudio, setEnvironment, duckForMap } from '@/audio';
import type { EnvironmentId } from '@/audio';
import type { Sku } from '@/data/enervit';
import { takeCostS } from '@/nutrition/protocol';
import { applyIntake } from '@/nutrition/intake';
import { formatRaceTime, formatDistance, t } from '@/i18n';
import type { RunResult } from '@/core/types';

/**
 * What a scene must offer to host a race.
 *
 * Deliberately tiny. Neither scene knows what a control is, and neither should:
 * everything below this line is a camera on a heightfield.
 */
export interface RaceSceneHost {
  readonly field: TerrainField;
  /** Where the arena is. Start and finish get placed near it. */
  readonly arena: World2;
  /** Drive the camera from outside. Called once per frame while racing. */
  setExternalPose(x: number, z: number, yaw: number, pitch: number): void;
  /**
   * Aim the beginner's bearing band, or `null` to put it away.
   *
   * Optional because a scene without one is a scene without a beginner aid,
   * not a broken scene. See `src/world/bearingBand.ts` for what it may and may
   * not show.
   */
  setBearingAid?(aim: BearingAim | null): void;
  /**
   * Place the course's flags, start kite and finish gantry, or clear them with
   * an empty list. Optional for the same reason as `setBearingAid`.
   */
  setCourseMarkers?(markers: readonly ControlMarker[]): void;
  /** Which of those markers are drawn this frame, and which was just punched. */
  setMarkerState?(state: ControlMarkerState): void;
  /** Hook called at the top of the scene's own frame, so ordering is defined. */
  beforeFrame: ((dtS: number) => void) | null;
  /** Extra out-of-bounds geometry the raster does not carry (Krumlov's walls). */
  blockedAt?(x: number, z: number): boolean;
  /**
   * Which of that is uncrossable *water* — ISSprOM 301, the Vltava — with no
   * bridge deck over it.
   *
   * Always a subset of `blockedAt`; a scene with no drawn water does not
   * implement it. The course setter needs the distinction and the athlete does
   * not: see `CourseTerrain.inWaterAt` and D-037.
   */
  inWaterAt?(x: number, z: number): boolean;
  resize(width: number, height: number): void;
}

export interface RaceSetup {
  anchor: VenueAnchor;
  discipline: Discipline;
  seed: number;
  /** 0 = cool and dry, 1 = hot and humid. */
  heat: number;
  /** Chosen on the BEFORE screen. Ids only — the log records what was taken. */
  preRace: string[];
  /** Items carried on the belt, in slot order. */
  belt: Sku[];
  /** Starting stats after the BEFORE phase. See src/nutrition/protocol.ts. */
  startStats: { glycogen: number; hydration: number; bloodSugar: number; focus: number };
  environment: EnvironmentId;
  touch: boolean;
  /**
   * The town, when there is one.
   *
   * Handed in rather than read off the scene so that `src/world` keeps knowing
   * nothing about what a control is. What the course setter does with it is in
   * `src/race/urbanFeatures.ts`: a sprint control belongs on a building corner
   * or a stairway, and this is where those live.
   */
  townscape?: TownscapeData;
  onFinish: (result: RunResult, course: Course) => void;
  onQuit: () => void;
}

/**
 * How long the athlete has to be asking to move before it is worth measuring
 * whether they can, seconds.
 *
 * Long enough that running into a wall for a moment — which is a normal thing
 * to do in a sprint — never triggers it.
 */
const STUCK_WINDOW_S = 1.5;

/**
 * Ground covered in that window, below which the athlete is going nowhere.
 *
 * 1.5 m, not 4. The flood that follows costs a couple of milliseconds, which is
 * a tenth of a frame — fine when the player is genuinely stuck and standing
 * still, a visible hitch if it fires while they are merely slow. Reading the
 * map costs 45% of pace and running through scrub costs more, and 4 m in 1.5 s
 * is inside what those produce; 1 m/s is not something any ground in this game
 * does to a runner asking to move.
 */
const STUCK_MOVED_M = 1.5;

/**
 * Ground the athlete must be able to reach from where they stand, m².
 *
 * Smaller than `courseSetup.MIN_ESCAPE_M2`, and it should be: that one governs
 * where a course may be *set*, where there is no reason to be near the line.
 * This one fires on a player who has run somewhere unexpected, so it has to be
 * unambiguous — a walled Krumlov courtyard you can legitimately be in and run
 * out of is bigger than this, and 600 m² is 25 m square.
 */
const TRAP_M2 = 600;

export class RaceController {
  readonly root: HTMLElement;
  readonly course: Course;
  /** How the course was arrived at. Read by the debug overlay and QA. */
  private readonly setup_: CourseSetupResult;

  private readonly race: Race;
  private readonly terrain: FieldTerrain;
  private readonly host: RaceSceneHost;
  private readonly setup: RaceSetup;

  private readonly map: RaceMap;
  private readonly hud: RaceHud;
  private readonly controls: RaceControls;
  private readonly panel: HTMLElement;
  /** "Really quit?" — see `askQuit`. Its own layer, above `panel`. */
  private readonly quitAsk: HTMLElement;
  /** Whether the controls were already suspended when the question went up. */
  private quitAskWasSuspended = false;

  private beltLeft: boolean[];
  /**
   * Read-only mirrors of two numbers `Race` owns privately, kept so the HUD can
   * be shown the over-fuelling state without `RaceView` having to grow fields
   * or `src/sim` having to change. They are written in exactly one place — the
   * same call that hands them to `Race.takeNutrition()` — so they cannot drift.
   */
  private consumedG = 0;
  private itemsOnBelt: number;
  /** Cumulative caffeine this race, mg. Drives the dose–response turnover. */
  private caffeineMg = 0;
  /** Seconds still owed for taking an item — paid as a forced slow. */
  private takePenaltyS = 0;
  private started = false;
  private ended = false;
  private lastPunchCode = -1;
  /**
   * Which flags the world is allowed to draw, in course order: the start, then
   * controls 1..n, then the finish.
   *
   * Rebuilt in place each frame from `nextControl`, so it is one allocation for
   * the whole race. The rule it encodes is the important part — see `frame`.
   */
  private readonly markerVisible: boolean[];
  /**
   * Which flags are behind the athlete, same indexing as `markerVisible`.
   *
   * The world's counterpart to the map's purple 50%: a punched control keeps
   * standing there looking exactly like the one being hunted unless something
   * says otherwise, and the beep and the flash are gone in half a second.
   */
  private readonly markerDone: boolean[];
  /** Marker index punched this frame. Non-null for exactly one frame. */
  private punchedMarker: number | null = null;
  /**
   * Whether the beginner's bearing band is on, read once at construction so
   * that toggling it in the menu cannot change a race that is already running.
   * Defaults on — most players have never orienteered.
   */
  private readonly beginnerAid: boolean;
  private readonly disposers: (() => void)[] = [];

  constructor(host: RaceSceneHost, setup: RaceSetup, canvas: HTMLElement) {
    this.host = host;
    this.setup = setup;
    this.beginnerAid = getSettings().beginnerAid;
    // ISSprOM territory: 1:4000 or closer means a town, and a town's controls
    // are corners rather than landforms.
    const urban = setup.anchor.mapScale <= 5000;
    this.terrain = new FieldTerrain(host.field, {
      ...(host.blockedAt ? { blocked: (x: number, z: number) => host.blockedAt!(x, z) } : {}),
      // The water clause of `blockedAt`, on its own, so `generateCourse` can
      // refuse a leg across the river without also refusing one round a
      // building — which is the best leg a sprint has. See D-037.
      ...(host.inWaterAt ? { water: (x: number, z: number) => host.inWaterAt!(x, z) } : {}),
      urban,
      ...(urban && setup.townscape
        ? { features: buildUrbanFeatures(setup.townscape) }
        : {}),
    });

    const set = setCourse(this.terrain, {
      venue: setup.anchor,
      discipline: setup.discipline,
      seed: setup.seed,
      arena: host.arena,
    });
    this.course = set.course;
    this.setup_ = set;
    // The detour probe's scratch is a few megabytes over the venue mask and is
    // only ever wanted while the course is being set. See `routeWithinM`.
    this.terrain.releaseProbe();

    this.race = new Race({
      course: this.course,
      terrain: this.terrain,
      heat: setup.heat,
      preRace: setup.preRace,
      seed: setup.seed,
    });
    // The BEFORE phase decides what state the athlete arrives in. `Race` logs
    // the choice but does not model it — that lives in src/nutrition, where the
    // compliance boundary is documented.
    Object.assign(this.race.athlete.stats, setup.startStats);
    this.race.setBeltItems(setup.belt.length);
    this.beltLeft = setup.belt.map(() => true);
    this.itemsOnBelt = setup.belt.length;

    this.root = document.createElement('div');
    this.root.className = 'race';
    this.root.dataset.touch = setup.touch ? '1' : '0';

    this.controls = new RaceControls(setup.touch);
    this.map = new RaceMap({
      anchor: setup.anchor,
      data: buildMapData(host.field, setup.anchor, this.terrain.bakedRaster()),
      course: this.course,
      // The map sees the belief and the heading. It is never given
      // `truePosition`, and this closure is the reason it cannot be.
      subject: () => {
        const v = this.race.view();
        return {
          believedPosition: v.believedPosition,
          heading: v.heading,
          clarity: v.clarity,
          // The count off the SI card. `nextControl` is the index being sought,
          // so it is also how many are behind you.
          punched: v.nextControl,
        };
      },
      onReadingChange: (reading) => this.setReading(reading),
    });
    this.hud = new RaceHud({
      course: this.course,
      discipline: setup.discipline,
      belt: setup.belt,
      touch: setup.touch,
      onToggleMap: () => this.map.toggle(),
      onQuit: () => this.askQuit(),
      onTakeBelt: (i) => this.takeBelt(i),
    });

    this.panel = document.createElement('div');
    this.panel.className = 'racepanel';
    // Its own layer rather than a second state of `panel`: the prestart card
    // lives there, and quitting from the prestart must not destroy it.
    this.quitAsk = document.createElement('div');
    this.quitAsk.className = 'racepanel racepanel--ask';
    this.quitAsk.hidden = true;
    this.root.append(
      this.controls.root,
      this.hud.root,
      this.map.root,
      this.panel,
      this.quitAsk,
    );

    this.controls.attachKeyboard();
    this.controls.attachMouse(canvas);
    // Face the first control. Negated because a camera yaw is not a bearing:
    // `RaceControls.step` documents the identity — three's Y rotation is
    // counter-clockwise, so the look bearing is exactly `-yaw`. Without the
    // sign the race opened with the athlete facing the mirror image of the
    // first leg, which is a poor first impression of a navigation game.
    this.controls.yaw = -bearingTo(
      this.course.start,
      this.course.controls[0]?.position ?? this.course.finish,
    );

    const onKey = (e: KeyboardEvent) => {
      if (e.repeat) return;
      // While the question is up it is the only thing on screen that listens.
      // Enter answers it, Escape dismisses it (below); the map, the belt and
      // the start key are all deaf until it is gone.
      if (!this.quitAsk.hidden && e.code !== 'Escape') {
        if (e.code === 'Enter' || e.code === 'NumpadEnter') {
          e.preventDefault();
          setup.onQuit();
        }
        return;
      }
      // `code` is the right thing to test — it is layout-independent, so M is
      // the same physical key on QWERTZ, which this game's audience mostly
      // uses. `key` is the fallback for synthetic events that carry only it.
      if (e.code === 'KeyM' || (!e.code && e.key.toLowerCase() === 'm')) {
        e.preventDefault();
        this.map.toggle();
      } else if (e.code === 'Escape') {
        // Escape unwinds one layer at a time, innermost first: the question,
        // then the map, then the race. It never *answers* the question — an
        // Escape that quits is the same accident the question exists to stop.
        e.preventDefault();
        if (!this.quitAsk.hidden) this.closeQuitAsk();
        else if (this.map.isOpen) this.map.setOpen(false);
        else this.askQuit();
      } else if (e.code === 'Space' && !this.started) {
        e.preventDefault();
        this.begin();
      } else if (/^Digit[1-9]$/.test(e.code)) {
        this.takeBelt(Number(e.code.slice(5)) - 1);
      }
    };
    window.addEventListener('keydown', onKey);
    const onResize = () => this.map.resize();
    window.addEventListener('resize', onResize);
    this.disposers.push(() => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onResize);
    });

    // The flags. Placed once, from the same `Course` the map draws, so the kite
    // in the forest and the circle on the paper cannot end up in two places.
    const markers = courseMarkers(this.course);
    this.markerVisible = markers.map(() => false);
    this.markerDone = markers.map(() => false);
    host.setCourseMarkers?.(markers);

    host.beforeFrame = (dt) => this.frame(dt);
    host.setExternalPose(
      this.course.start.x,
      this.course.start.z,
      this.controls.yaw,
      this.controls.pitch,
    );
    setEnvironment(setup.environment, 0.2);

    this.showPrestart();
    // The canvas is sized by the screen; the map canvases need their own pass
    // once they are in the document.
    requestAnimationFrame(() => this.map.resize());

    // Development hook. The perf harness and manual QA need a way to drive a
    // race without running 4 km in real time.
    (window as unknown as Record<string, unknown>).__race = this;
  }

  // -------------------------------------------------------------------------
  // Phases
  // -------------------------------------------------------------------------

  private showPrestart(): void {
    const c = this.course;
    this.panel.hidden = false;
    /*
     * The briefing, and the one guarantee it has to make: START is reachable.
     *
     * Everything above the button lives in `racepanel__body`, which is the only
     * part allowed to scroll; the button is the card's second grid row and
     * never moves. Previously the whole card was one flow inside a
     * `place-items: center` grid with no scroll container, so once the content
     * outgrew the viewport it overflowed *both* ends and START simply left the
     * screen — measured at 800 × 434 (a phone in landscape, the device class
     * the brief targets) as a 64 px button spanning y 474–538 in a 434 px
     * viewport. Not clipped-but-scrollable: unreachable. The coaching block is
     * open by default, so this was the first thing a new player met.
     */
    this.panel.innerHTML = `
      <div class="racepanel__card racepanel__card--prestart">
        <div class="racepanel__body">
          <p class="racepanel__kicker">${esc(t('race.startOfNav'))}</p>
          <h2 class="racepanel__title">${esc(t(`discipline.${c.discipline}`))} · ${esc(
            t(`venue.${c.venue}`),
          )}</h2>
          <dl class="racepanel__facts">
            <div><dt>${esc(t('race.length'))}</dt><dd>${esc(formatDistance(c.lengthM))}</dd></div>
            <div><dt>${esc(t('race.climb'))}</dt><dd>${c.climbM} m</dd></div>
            <div><dt>${esc(t('race.controls'))}</dt><dd>${c.controls.length}</dd></div>
            <div><dt>${esc(t('race.scale'))}</dt><dd>1:${this.setup.anchor.mapScale}</dd></div>
          </dl>
          <p class="racepanel__note">${esc(t('race.prestartHint'))}</p>
          <!--
            Says out loud what the meter measures, before the meter is on screen.
            The causes named here — pace, climb, heat — are the only causes there
            are (see depleteStats), and stating them is what stops an emptying bar
            being read as a consequence of not taking a product. Art. 12(a).
          -->
          <p class="racepanel__note">${esc(t('hud.energyCause'))}</p>
          ${this.beginnerAid ? this.coachBlock() : ''}
        </div>
        <button class="racepanel__go" data-act="begin">${esc(t('race.goStart'))}</button>
      </div>`;
    const go = this.panel.querySelector('[data-act="begin"]');
    go?.addEventListener('click', () => this.begin());
  }

  /**
   * The four sentences that answer "how do I actually approach a control?".
   *
   * Four, and one line each, because this is a hint and not a tutorial: the
   * brief's test is that a non-orienteer understands the game in sixty seconds,
   * and a wall of coaching fails that as surely as no coaching at all. They are
   * the four techniques docs/RESEARCH-SPORT.md §6 identifies as the ones that
   * decide a beginner's leg — rough bearing (§6.1), handrail (§6.3), attack
   * point (§6.4) and the control description — in the federation's own Czech,
   * where a leg is *úsek*, a route is *postup*, and an attack point is
   * *odrazový bod*.
   *
   * `<details>` rather than a paragraph so it is skippable in one click, and
   * open first time because a player who has never seen it cannot know to open
   * it. It disappears entirely with the beginner aid switched off.
   *
   * It no longer carries a `max-height` of its own. The list used to be its own
   * scroller, on the reasoning that capping it stopped it "pushing START off the
   * screen" — but a nested scroller inside a card that could not scroll did not
   * stop that, it only hid how far the card had overflowed. The card now scrolls
   * as one region with START pinned outside it, which is the actual guarantee,
   * and one scroller is easier to use than two.
   */
  private coachBlock(): string {
    const lines = ['race.coachBearing', 'race.coachHandrail', 'race.coachAttack', 'race.coachDescription'];
    return `
      <details class="racepanel__coach" open>
        <summary class="racepanel__coachTitle">${esc(t('race.coachTitle'))}</summary>
        <ul class="racepanel__coachList">
          ${lines.map((k) => `<li>${esc(t(k))}</li>`).join('')}
        </ul>
        <p class="racepanel__coachAid">${esc(t('race.aidHint'))}</p>
      </details>`;
  }

  /**
   * "Really quit?" — the one question this game asks before throwing work away.
   *
   * Quitting mid-race discards the run: the time, the punches, the splits, and
   * whatever navigation the player has done since the start triangle. Both ways
   * out — the ✕ in the corner of the HUD and the Escape key — used to do that
   * on a single press, and Escape is a key people hit reflexively to get their
   * mouse cursor back out of pointer lock.
   *
   * It is deliberately *not* asked once the race is over. After the finish or a
   * mispunch there is nothing left to lose, `onFinish` has already carried the
   * result to the results screen, and a confirmation there would only be a
   * second click between the player and the door.
   */
  private askQuit(): void {
    if (this.ended) {
      this.setup.onQuit();
      return;
    }
    if (!this.quitAsk.hidden) return;

    // Hand the mouse back. The question is a pointer target, and a race that
    // has swallowed the cursor cannot be answered with one. The previous state
    // is remembered rather than assumed: reading the map suspends the controls
    // too, and answering "keep running" must not cancel that.
    this.quitAskWasSuspended = this.controls.suspended;
    this.controls.releasePointer();
    this.controls.suspended = true;

    this.quitAsk.innerHTML = `
      <div class="racepanel__card racepanel__card--ask" role="alertdialog" aria-modal="true"
           aria-labelledby="quitask-title" aria-describedby="quitask-body">
        <h2 class="racepanel__title" id="quitask-title">${esc(t('race.quitTitle'))}</h2>
        <p class="racepanel__note" id="quitask-body">${esc(t('race.quitBody'))}</p>
        <div class="racepanel__asks">
          <button class="racepanel__go racepanel__go--stay" data-act="stay">${esc(
            t('race.quitStay'),
          )}</button>
          <button class="racepanel__go racepanel__go--quit" data-act="quit">${esc(
            t('race.quitConfirm'),
          )}</button>
        </div>
      </div>`;
    this.quitAsk.hidden = false;
    // Carrying on is the safe answer, so it is the one that already has focus:
    // Enter is bound to quitting on purpose (a player who opened this meant to
    // leave), and Space — which is also "start" — must not be able to reach a
    // focused destructive button.
    this.quitAsk.querySelector<HTMLElement>('[data-act="stay"]')?.focus();
    this.quitAsk.querySelector('[data-act="stay"]')?.addEventListener('click', () => {
      this.closeQuitAsk();
    });
    this.quitAsk.querySelector('[data-act="quit"]')?.addEventListener('click', () => {
      this.setup.onQuit();
    });
  }

  private closeQuitAsk(): void {
    if (this.quitAsk.hidden) return;
    this.quitAsk.hidden = true;
    this.quitAsk.innerHTML = '';
    this.controls.suspended = this.quitAskWasSuspended;
  }

  begin(): void {
    if (this.started) return;
    this.started = true;
    this.panel.hidden = true;
    this.panel.innerHTML = '';
    this.race.start();
    // The start is a punch too — the double beep every orienteer knows.
    playPunch('touchfree', { double: true });
  }

  private finish(): void {
    if (this.ended) return;
    this.ended = true;
    this.controls.suspended = true;
    this.controls.releasePointer();
    this.map.setOpen(false);
    this.host.beforeFrame = null;
    this.host.setBearingAid?.(null);
    this.setup.onFinish(this.race.result(), this.course);
  }

  // -------------------------------------------------------------------------
  // The escape guarantee
  // -------------------------------------------------------------------------

  /**
   * Catch a player who is walled in, and get them out honestly.
   *
   * `setCourse` guarantees that no point the athlete is *placed* on can strand
   * them, measured against the collider that actually stops them rather than
   * against a mask. This is the other half: a player can run somewhere the
   * course never sent them, and this venue has now produced four distinct
   * "we're stuck" reports with four different real causes. Each one was fixed;
   * the reports kept coming. So rather than wait for a fifth, detect the
   * *condition* — the athlete cannot get out of where they are — and act.
   *
   * Three properties this deliberately has:
   *
   *  - **Cheap until it matters.** Flooding the neighbourhood costs a few
   *    milliseconds, which is a visible hitch at 60 fps if it runs on a timer.
   *    It does not: the trigger is the symptom the player would report — asking
   *    to move, and not moving — so the flood runs approximately never, and
   *    when it does run the player is already standing still.
   *  - **Loud.** It logs the position, the ground and the escape area, and
   *    records the event on `window.__trapEvents` where the gates can read it.
   *    A silent teleport would hide the bug that produced it, and the next
   *    report has to be actionable without a bisect.
   *  - **Honest.** It does not pretend nothing happened. The player is moved to
   *    the nearest ground connected to the arena and told, in one line, that
   *    the game did it. A player stuck with no recourse is the worst outcome
   *    available; a player nudged out with an explanation is survivable.
   */
  private stuckForS = 0;
  private lastStuckCheck: World2 | null = null;
  private trapNudges = 0;

  private watchForEnclosure(dtS: number, forward: number): void {
    const p = this.race.athlete.position;

    // Asking to move and not moving. Sampled against where we were a second
    // ago rather than against speed, because sliding along a wall keeps a
    // non-zero speed while going nowhere.
    if (forward < 0.5) {
      this.stuckForS = 0;
      this.lastStuckCheck = null;
      return;
    }
    if (!this.lastStuckCheck) {
      this.lastStuckCheck = { x: p.x, z: p.z };
      this.stuckForS = 0;
      return;
    }
    this.stuckForS += dtS;
    if (this.stuckForS < STUCK_WINDOW_S) return;

    const movedM = dist2(this.lastStuckCheck, p);
    this.stuckForS = 0;
    this.lastStuckCheck = { x: p.x, z: p.z };
    if (movedM > STUCK_MOVED_M) return;

    // Going nowhere. Now it is worth paying for the answer: is this a wall the
    // player should run along, or a pocket they cannot leave?
    const { m2, sealed } = this.terrain.escapeAreaM2(p, TRAP_M2);
    if (!sealed) return;

    this.trapNudges++;
    // The eight octants at 3 m, as a string: `#` is out of bounds, otherwise
    // the runnability class. "########" says walled in on every side; a single
    // gap says the way out is there and something else is wrong.
    let ring = '';
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      const q = this.terrain.runnabilityAt(p.x + Math.sin(a) * 3, p.z - Math.cos(a) * 3);
      ring += q === Runnability.Impassable ? '#' : String(q);
    }
    const detail = {
      x: Math.round(p.x * 10) / 10,
      z: Math.round(p.z * 10) / 10,
      escapeM2: Math.round(m2),
      ground: this.terrain.runnabilityAt(p.x, p.z),
      ring,
      control: this.race.view().nextControl,
      seed: this.setup.seed,
    };
    console.error(
      `[race] the athlete is enclosed in ${detail.escapeM2} m² at (${detail.x}, ${detail.z}) — ` +
        `this should be impossible; see courseSetup.MIN_ESCAPE_M2`,
      detail,
    );
    const w = window as unknown as { __trapEvents?: unknown[] };
    (w.__trapEvents ??= []).push(detail);

    const out = this.terrain.nearestReachable(p);
    if (dist2(out, p) < 0.5) return;
    p.x = out.x;
    p.z = out.z;
    this.showNudgeNote();
  }

  /**
   * One line, for a few seconds, saying the game moved you.
   *
   * Styled inline rather than through `src/styles/race.css` on purpose: this is
   * a rare diagnostic surface, and putting it in the stylesheet would mean
   * touching a file the flag work is editing at the same time.
   */
  private showNudgeNote(): void {
    let note = this.root.querySelector<HTMLElement>('[data-role="trapnote"]');
    if (!note) {
      note = document.createElement('p');
      note.dataset.role = 'trapnote';
      note.setAttribute('role', 'status');
      note.style.cssText =
        'position:absolute;left:50%;top:18%;transform:translateX(-50%);z-index:40;' +
        'margin:0;padding:0.6rem 1rem;border-radius:0.4rem;max-width:22rem;text-align:center;' +
        'background:rgba(12,18,14,0.88);color:#f2efe6;font-size:0.9rem;line-height:1.35;' +
        'pointer-events:none;transition:opacity 0.4s;';
      this.root.appendChild(note);
    }
    note.textContent = t('race.freedFromTrap');
    note.style.opacity = '1';
    window.clearTimeout(this.nudgeNoteTimer);
    this.nudgeNoteTimer = window.setTimeout(() => {
      if (note) note.style.opacity = '0';
    }, 5000);
  }

  private nudgeNoteTimer = 0;

  // -------------------------------------------------------------------------
  // Frame
  // -------------------------------------------------------------------------

  private frame(dtS: number): void {
    const now = performance.now();
    const intent = this.controls.step(dtS);

    if (this.started && !this.ended) {
      // Taking something off the belt costs real running time. Modelled as a
      // forced slow rather than a pause, because that is what it is: you jog,
      // you fumble with a sachet, you swallow, you get going again.
      let forward = intent.forward;
      if (this.takePenaltyS > 0) {
        this.takePenaltyS = Math.max(0, this.takePenaltyS - dtS);
        forward *= 0.35;
      }
      // The athlete travels along the movement heading, which strafing
      // decouples from where the camera looks.
      this.terrain.heading = intent.heading;
      this.race.step(dtS, { forward, heading: intent.heading });
      this.watchForEnclosure(dtS, forward);
    }

    const v = this.race.view();
    const p = v.truePosition;
    this.host.setExternalPose(p.x, p.z, this.controls.yaw, this.controls.pitch);

    // The beginner's bearing band.
    //
    // `believed` is the athlete's own estimate of where they are and it drifts;
    // the bearing is measured from it, so a player who is lost gets a hint that
    // is lost with them, and punching — which corrects the belief — corrects
    // the hint. That is what keeps this an aid rather than a GPS dot. The band
    // is *drawn* from `truePosition` because it has to start at the player's
    // feet; nothing about the direction comes from there.
    if (this.host.setBearingAid) {
      const target = v.target?.position ?? this.course.finish;
      this.host.setBearingAid(
        this.beginnerAid && !this.ended
          ? { from: p, believed: v.believedPosition, to: target }
          : null,
      );
    }

    if (v.justPunched && v.justPunched.code !== this.lastPunchCode) {
      this.lastPunchCode = v.justPunched.code;
      // The beep and the light, from one branch on one frame. That is what
      // sells a touch-free punch: there is nothing to press, so the world and
      // the sound arriving together is the *only* thing that says it happened.
      // `Race` has already advanced `nextControl` past the control it punched,
      // and marker 0 is the start, so the marker just punched is `nextControl`.
      playPunch('touchfree');
      this.punchedMarker = v.nextControl;
    }

    // Which flags may be seen.
    //
    // The current target and everything already punched, and nothing else. This
    // is not primarily anti-cheat: a player who can see control 7 from control 1
    // has no navigation problem left to solve, and navigation is the game. The
    // start and the finish are always up — they are the arena, you can hear it
    // from half the map.
    if (this.host.setMarkerState) {
      const n = this.course.controls.length;
      this.markerVisible[0] = true;
      // "Behind you" means one thing everywhere: you have punched past it. A
      // control is spent at `i < nextControl`, and the start goes with the leg
      // that leaves it, so it is spent once control 1 is in — which is exactly
      // when the map's start triangle goes to purple 50%. The finish is never
      // spent: you are not past it until there is no race left.
      this.markerDone[0] = v.nextControl > 0;
      for (let i = 0; i < n; i++) {
        this.markerVisible[i + 1] = i <= v.nextControl;
        this.markerDone[i + 1] = i < v.nextControl;
      }
      this.markerVisible[n + 1] = true;
      this.host.setMarkerState({
        visible: this.markerVisible,
        punched: this.punchedMarker,
        done: this.markerDone,
      });
      this.punchedMarker = null;
    }

    this.hud.update(
      v,
      now,
      readEnergy({ view: v, beltItems: this.itemsOnBelt, consumedG: this.consumedG }),
    );
    this.map.update(now);

    const cls = this.terrain.runnabilityAt(p.x, p.z);
    updateAudio(this.race.athlete, dtS, {
      ground: GROUND_FOR_RUNNABILITY[cls] ?? 'needles',
      runnability: cls,
      environment: this.setup.environment,
    });

    if (v.phase === 'finished' || v.phase === 'mispunched') this.finish();
  }

  // -------------------------------------------------------------------------
  // Map and belt
  // -------------------------------------------------------------------------

  private setReading(reading: boolean): void {
    this.race.readingMap = reading;
    this.controls.suspended = reading;
    if (reading) {
      this.controls.releasePointer();
      // Reading the sheet *is* planning the next leg. `controlApproachPenalty`
      // measures exactly this: national orienteers show a 5 bpm rise at
      // controls, club runners 17, and the difference is planning ahead.
      this.race.planAhead();
    }
    duckForMap(reading);
  }

  /**
   * Take an item off the belt.
   *
   * Three real consequences, in this order:
   *
   *  1. **It costs seconds.** `takePenaltyS` is paid in `frame()` as a forced
   *     slow rather than a pause, because that is what it is — you jog, you
   *     fumble with a sachet, you swallow, you get going again.
   *  2. **The athlete responds.** `applyIntake()` is the one place in the
   *     codebase that moves a stat in response to a product, and what it moves
   *     depends on `CLAIMS_SAFE` — see `src/core/compliance.ts`. It writes into
   *     the same `stats` object the simulation steps, so the next frame's
   *     `speedFactor()` and `navigationQuality()` see it immediately. `Race`
   *     still owns the intake log and the carbohydrate total.
   *  3. **The belt gets lighter**, which really does relieve the carry term in
   *     `overfuellingPenalty()`.
   *
   * Note what is *not* here: any path by which taking more is reliably better.
   * The intake ceiling makes a second identical item nearly worthless, the
   * carbohydrate is counted toward the gut limit for the elapsed duration, and
   * the caffeine dose–response turns over. Loading the belt is a decision, not
   * a shopping list.
   */
  private takeBelt(index: number): void {
    if (!this.started || this.ended) return;
    const sku = this.setup.belt[index];
    if (!sku || !this.beltLeft[index]) return;
    this.beltLeft[index] = false;

    this.race.takeNutrition(sku.id, sku.carbsG ?? 0);
    const effect = applyIntake(this.race.athlete.stats, sku, {
      caffeineBeforeMg: this.caffeineMg,
    });

    this.consumedG += sku.carbsG ?? 0;
    this.caffeineMg += sku.caffeineMg ?? 0;
    this.itemsOnBelt = Math.max(0, this.itemsOnBelt - 1);

    const cost = takeCostS(this.setup.discipline);
    this.takePenaltyS = cost;
    this.hud.renderBelt(this.beltLeft);
    this.hud.showTake(sku, cost, performance.now(), effect);
  }

  // -------------------------------------------------------------------------

  /**
   * Test hook: run the race forward with a pilot that heads straight for the
   * next control. Used by manual QA and by the smoke check — a 4 km middle is
   * twenty minutes of real running otherwise.
   */
  autopilot(steps = 20000, dtS = 0.1): RaceView {
    if (!this.started) this.begin();
    for (let i = 0; i < steps && this.race.phase === 'running'; i++) {
      const view = this.race.view();
      const target = view.target?.position ?? this.course.finish;
      const pos = this.race.athlete.position;

      // Re-plan whenever the leg changes. A distance field over the reachable
      // component beats any local avoidance rule: a "head for the control and
      // sidestep" pilot cannot leave a concave corner, and Krumlov is made of
      // concave corners.
      if (this.pilotLeg !== view.nextControl) {
        this.pilotLeg = view.nextControl;
        // Route around every control still to come. Clipping one is a mispunch
        // and a mispunch is a DSQ, which is exactly why a real orienteer gives
        // other people's controls a wide berth.
        const avoid = this.course.controls
          .slice(view.nextControl + 1)
          .map((c) => ({ x: c.position.x, z: c.position.z, r: c.punchRadius + 4 }));
        let f = this.terrain.routeField(target, avoid);
        // In an alley a future control's exclusion disc can close the only
        // corridor, leaving the field unable to reach the athlete at all. Then
        // the leg has to be run past it, carefully — which is also what a real
        // runner does when the alternative is a 300 m detour.
        if (!f || this.terrain.routeDistance(pos, f) < 0) {
          f = this.terrain.routeField(target);
        }
        this.pilotField = f;
      }

      // Descend the field, but only along headings that are actually open at
      // the athlete's own resolution. The field is a 1 m grid and the walls are
      // continuous collision volumes narrower than that, so a pure field
      // descent walks into railings the grid cannot see.
      const field = this.pilotField;
      const fallback = bearingTo(pos, target);

      /** Metres of clear running along a heading, capped. */
      const clearance = (h: number): number => {
        for (let s = 0.5; s <= 12; s += 0.5) {
          if (
            this.terrain.sample(pos.x + Math.sin(h) * s, pos.z - Math.cos(h) * s)
              .runnability === 10
          ) {
            return s - 0.5;
          }
        }
        return 12;
      };

      let heading = fallback;
      if (this.pilotEscape > 0) {
        // Wall-following — the classic "bug" escape.
        //
        // Sweep from the heading we were last committed to, always the same way
        // round, and take the first heading with real room. That traces the
        // obstacle's outline instead of pressing into it. Everything looser
        // failed: the roomiest direction re-chosen each frame flips as the
        // athlete inches along the wall, and a single sticky heading walks off
        // into open ground and gets dragged straight back.
        this.pilotEscape--;
        for (let k = 0; k < 24; k++) {
          const h = this.pilotEscapeHeading + this.pilotSide * ((k * Math.PI) / 12);
          if (clearance(h) >= 2.5) {
            this.pilotEscapeHeading = h;
            break;
          }
        }
        heading = this.pilotEscapeHeading;
        // Leave the moment the route is both open ahead and materially shorter
        // than it was when we jammed. Released any earlier, the pilot turns
        // round and re-enters the same corner.
        if (field && clearance(fallback) >= 2.5) {
          const d = this.terrain.routeDistance(pos, field);
          const walked = Math.hypot(
            pos.x - this.pilotEscapeOrigin.x,
            pos.z - this.pilotEscapeOrigin.z,
          );
          // Either the route got materially shorter, or we have walked far
          // enough round the obstacle that the corner we jammed in is behind
          // us. Requiring only the first deadlocks against a wall the athlete
          // simply cannot get closer than.
          if ((d >= 0 && d < this.pilotEscapeFrom - 10) || walked > 20) {
            this.pilotEscape = 0;
          }
        }
      } else if (field) {
        // Follow the route cell by cell along edges that were validated with
        // the scene's own continuous collision test. Anything looser — a
        // lowest-distance cell in a window, a probe 2.5 m ahead — picks points
        // on the far side of walls, because the field knows what a cell costs
        // without knowing whether you can get to it from here.
        const wp = this.terrain.routeWaypoint(pos, field, 6);
        // A waypoint on top of the athlete carries no direction — that happens
        // at the goal cell, and when the descent has nowhere edge-valid to go.
        const usable = wp && Math.hypot(wp.x - pos.x, wp.z - pos.z) > 1;
        if (usable) heading = bearingTo(pos, wp);
        if (!usable || clearance(heading) < 0.5) {
          // Fall back to scoring headings on how much the route shortens and
          // how much room they have. Rougher than the waypoint, but it copes
          // where the grid and the collision disagree, which in a town built in
          // the fourteenth century is most places.
          let best = -Infinity;
          for (let k = 0; k < 32; k++) {
            const h = fallback + (k * Math.PI) / 16;
            const c = clearance(h);
            if (c < 0.5) continue;
            const reach = Math.min(2.5, c);
            const d = this.terrain.routeDistance(
              { x: pos.x + Math.sin(h) * reach, z: pos.z - Math.cos(h) * reach },
              field,
            );
            if (d < 0) continue;
            const score = -d + c * 0.5;
            if (score > best) {
              best = score;
              heading = h;
            }
          }
        }
      }

      this.controls.yaw = heading;
      this.terrain.heading = heading;
      this.race.step(dtS, { forward: 1, heading });

      // Progress is measured over a window, not per frame. Pressed against a
      // wall the athlete slides a few centimetres each way and comes back —
      // every single frame "moved", so a per-frame test never fired while the
      // pilot stood in one place for four simulated hours.
      if (++this.pilotStuck >= 20) {
        this.pilotStuck = 0;
        const progressed = Math.hypot(pos.x - this.pilotAnchor.x, pos.z - this.pilotAnchor.z);
        this.pilotAnchor = { x: pos.x, z: pos.z };
        // 20 frames is two seconds, so even a flat-out sprinter covers only
        // about nine metres. A reset threshold above that can never be met, and
        // the escape window ratchets to its maximum and stays there.
        if (progressed > 4) this.pilotEscapeLen = 40;
        if (progressed < 1) {
          // Escalating escapes. One short burst gets the athlete off the wall
          // and the field pulls them straight back into it; the way round a
          // 200 m building is to follow the wall for 200 m, so each failed
          // escape commits to twice as much of it.
          this.pilotEscapeLen = Math.min(300, this.pilotEscapeLen * 2);
          this.pilotEscape = this.pilotEscapeLen;
          // Alternate which way round the obstacle we go, so two escapes in a
          // row do not both trace the same dead end.
          this.pilotSide = -this.pilotSide;
          this.pilotEscapeHeading = heading;
          this.pilotEscapeOrigin = { x: pos.x, z: pos.z };
          this.pilotEscapeFrom = field ? this.terrain.routeDistance(pos, field) : 0;
        }
      }
    }
    const v = this.race.view();
    if (v.phase === 'finished' || v.phase === 'mispunched') this.finish();
    return v;
  }

  private pilotLeg = -1;
  private pilotField: Int32Array | null = null;
  private pilotStuck = 0;
  private pilotEscape = 0;
  private pilotEscapeHeading = 0;
  private pilotSide = 1;
  private pilotAnchor: World2 = { x: 0, z: 0 };
  private pilotEscapeLen = 40;
  private pilotEscapeFrom = 0;
  private pilotEscapeOrigin: World2 = { x: 0, z: 0 };

  /** Elapsed time as the HUD shows it. Convenience for the smoke check. */
  get clock(): string {
    return formatRaceTime(this.race.view().timeS);
  }

  /**
   * Route length in metres for every leg, start → 1 → … → finish, measured
   * over ground the athlete can actually cross. `-1` means the leg has no
   * route at all, which would make the course impossible to complete.
   *
   * This is the property the end-to-end gate asserts. It is deterministic,
   * unlike "did a bot get round", and it is the thing that actually decides
   * whether a player can finish.
   */
  legRoutes(): number[] {
    const points: World2[] = [
      this.course.start,
      ...this.course.controls.map((c) => c.position),
      this.course.finish,
    ];
    const out: number[] = [];
    for (let i = 0; i < points.length - 1; i++) {
      const field = this.terrain.routeField(points[i + 1]!);
      out.push(field ? this.terrain.routeDistance(points[i]!, field) : -1);
    }
    return out;
  }

  /** Course-setting diagnostics, for the debug overlay and the smoke check. */
  get courseInfo(): CourseSetupResult & { lengthM: number; controls: number } {
    return { ...this.setup_, lengthM: this.course.lengthM, controls: this.course.controls.length };
  }

  dispose(): void {
    this.host.beforeFrame = null;
    this.host.setBearingAid?.(null);
    this.host.setCourseMarkers?.([]);
    for (const d of this.disposers) d();
    this.disposers.length = 0;
    this.controls.dispose();
    this.hud.dispose();
    this.map.dispose();
    this.root.remove();
    if ((window as unknown as Record<string, unknown>).__race === this) {
      delete (window as unknown as Record<string, unknown>).__race;
    }
  }
}

function bearingTo(a: World2, b: World2): number {
  return Math.atan2(b.x - a.x, -(b.z - a.z));
}

/**
 * The course as scene furniture.
 *
 * A thin adapter and nothing else. It reads `Course` — the same object
 * `RaceMap` draws its circles from — and emits points, facings and kinds, so
 * the kite in the forest and the circle on the paper are two renderings of one
 * number. Nothing in `src/sim` is touched, and the scene still has no idea what
 * a control is.
 *
 * `from` orients each marker: it is the point the athlete arrives from, so the
 * kite hangs on the side of the mast that faces the incoming leg and the finish
 * banner is squared across it. The start is the exception and looks the other
 * way — you stand on the triangle facing control 1 — so it is given the leg
 * ahead instead of the leg behind.
 */
function courseMarkers(course: Course): ControlMarker[] {
  const points: World2[] = [
    course.start,
    ...course.controls.map((c) => c.position),
    course.finish,
  ];
  const out: ControlMarker[] = [
    {
      kind: 'start',
      x: course.start.x,
      z: course.start.z,
      from: points[1] ?? course.finish,
    },
  ];
  for (let i = 0; i < course.controls.length; i++) {
    const c = course.controls[i]!;
    out.push({ kind: 'control', x: c.position.x, z: c.position.z, from: points[i]! });
  }
  out.push({
    kind: 'finish',
    x: course.finish.x,
    z: course.finish.z,
    from: points[points.length - 2]!,
  });
  return out;
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&quot;',
  );
}
