/**
 * Player settings that outlive a session.
 *
 * Small on purpose. D-004 keeps the quality tier out of the player's hands, so
 * this is not a graphics menu — it is the two or three switches that change what
 * the game *is* rather than how fast it runs.
 *
 * `showHands` defaults to **off**. The first-person arms in
 * `src/world/viewmodel.ts` were built when the map was held in them; now that
 * the map is a full-screen 2D overlay they have no job, and next to the terrain
 * and the town they read as unfinished. The code stays — the model, the gait
 * blend and the map texture binding are all still there and still work — and
 * this switch brings them back for anyone who wants them.
 */

const KEY = 'orientak.v1.settings';

export interface Settings {
  /** First-person arms and the held map. Off by default. */
  showHands: boolean;
  /** The V key and the third-person chase camera. Follows the hands switch. */
  thirdPerson: boolean;
}

const DEFAULTS: Settings = {
  showHands: false,
  thirdPerson: false,
};

let cache: Settings | null = null;

export function getSettings(): Settings {
  if (cache) return cache;
  let stored: Partial<Settings> = {};
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) stored = JSON.parse(raw) as Partial<Settings>;
  } catch {
    /* private mode, or corrupt — defaults are fine */
  }
  cache = { ...DEFAULTS, ...stored };
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
