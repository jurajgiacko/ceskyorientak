/**
 * Player settings that outlive a session.
 *
 * Small on purpose. D-004 keeps the quality tier out of the player's hands, so
 * this is not a graphics menu — it is the one or two switches that change what
 * the game *is* rather than how fast it runs.
 *
 * `beginnerAid` defaults to **off**. It was on, on the reasoning that most
 * players are newcomers — but the map turned out to carry the job on its own
 * once it was legible, and a translucent corridor across the ground competes
 * with the thing the game is actually about. It stays one tap away for anyone
 * who wants it, and what it turns on is deliberately weak: a bearing band that
 * flares, and fades out before the control. See `src/world/bearingBand.ts`.
 *
 * ---------------------------------------------------------------------------
 * Gone: `showHands` and `thirdPerson`
 * ---------------------------------------------------------------------------
 * The first-person arms are removed, not defaulted off — the asset, the
 * viewmodel and the switch. They were built when the map was held in them;
 * once the map became a full-screen 2D overlay they had no job, and next to
 * the terrain and the town they read as unfinished. A switch nobody turns on,
 * guarding code nobody runs, is worse than neither. `thirdPerson` went with
 * them and was already dead: `menuScreen` wrote it and nothing ever read it.
 * The chase camera itself survives on the V key in the free-run sandbox.
 *
 * `read()` therefore takes each key it knows about explicitly rather than
 * spreading whatever is in storage. A settings object saved by an older build
 * still carries `showHands`; spreading it would keep re-persisting a key with
 * no meaning, and the next removal would do the same again. Unknown keys are
 * dropped the first time anything is saved — which is the migration.
 */

const KEY = 'orientak.v1.settings';

export interface Settings {
  /** The bearing band on the ground and the coaching card. Off by default. */
  beginnerAid: boolean;
}

const DEFAULTS: Settings = {
  beginnerAid: false,
};

let cache: Settings | null = null;

export function getSettings(): Settings {
  if (cache) return cache;
  let stored: Record<string, unknown> = {};
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') stored = parsed as Record<string, unknown>;
    }
  } catch {
    /* private mode, or corrupt — defaults are fine */
  }
  cache = {
    beginnerAid: bool(stored.beginnerAid, DEFAULTS.beginnerAid),
  };
  return cache;
}

export function setSetting<K extends keyof Settings>(key: K, value: Settings[K]): Settings {
  const next = { ...getSettings(), [key]: value };
  cache = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* non-fatal */
  }
  return next;
}

/** A stored value that is not a boolean is not a setting we wrote. */
function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback;
}
