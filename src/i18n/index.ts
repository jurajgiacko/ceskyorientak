/**
 * Localisation. CZ is the primary locale (this is a Czech event), EN is the
 * international fallback, SK is the third.
 *
 * Rules, enforced by review:
 *   - No user-visible string may be written literally in a component.
 *   - Every key must exist in cs.json. Missing keys in en/sk fall back to cs
 *     and are reported by `missingKeys()` so they can't quietly ship.
 *   - Orienteering terminology must match docs/RESEARCH-SPORT.md §9.
 */

import type { Locale } from '@/core/types';
import { LOCALES } from '@/core/types';
import cs from './cs.json';
import en from './en.json';
import sk from './sk.json';

type Dict = Record<string, string>;

const DICTS: Record<Locale, Dict> = {
  cs: cs as Dict,
  en: en as Dict,
  sk: sk as Dict,
};

const STORAGE_KEY = 'orientak.v1.locale';

let current: Locale = 'cs';
const listeners = new Set<(l: Locale) => void>();

/** Pick the best locale from the browser, falling back to Czech. */
export function detectLocale(): Locale {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved && (LOCALES as readonly string[]).includes(saved)) {
      return saved as Locale;
    }
  } catch {
    /* storage unavailable — fall through to navigator */
  }
  for (const tag of navigator.languages ?? [navigator.language]) {
    const base = tag.slice(0, 2).toLowerCase();
    if ((LOCALES as readonly string[]).includes(base)) return base as Locale;
  }
  return 'cs';
}

export function getLocale(): Locale {
  return current;
}

export function setLocale(l: Locale): void {
  if (l === current) return;
  current = l;
  try {
    localStorage.setItem(STORAGE_KEY, l);
  } catch {
    /* non-fatal */
  }
  document.documentElement.lang = l;
  for (const fn of listeners) fn(l);
}

export function onLocaleChange(fn: (l: Locale) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * Translate. `params` interpolates {name} placeholders.
 * An unknown key returns the key itself — loud in the UI, and caught by tests.
 */
export function t(key: string, params?: Record<string, string | number>): string {
  const raw = DICTS[current][key] ?? DICTS.cs[key] ?? key;
  if (!params) return raw;
  return raw.replace(/\{(\w+)\}/g, (m, p) => {
    const v = params[p];
    return v === undefined ? m : String(v);
  });
}

/** Keys present in cs but missing from another locale. Used by the build check. */
export function missingKeys(): Record<Locale, string[]> {
  const base = Object.keys(DICTS.cs);
  const out = {} as Record<Locale, string[]>;
  for (const l of LOCALES) {
    out[l] = base.filter((k) => !(k in DICTS[l]));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Formatting — locale-correct, no hand-rolled string maths
// ---------------------------------------------------------------------------

/** Race time as an orienteer reads it: 12:34 under an hour, 1:02:34 over. */
export function formatRaceTime(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m);
  return h > 0
    ? `${h}:${mm}:${String(sec).padStart(2, '0')}`
    : `${mm}:${String(sec).padStart(2, '0')}`;
}

/** Split difference, always signed: +0:12 / −0:03. */
export function formatDelta(seconds: number): string {
  const sign = seconds < 0 ? '−' : '+';
  return sign + formatRaceTime(Math.abs(seconds));
}

export function formatDistance(metres: number): string {
  return metres >= 1000
    ? new Intl.NumberFormat(current, { maximumFractionDigits: 1 }).format(metres / 1000) + ' km'
    : `${Math.round(metres)} m`;
}

export function initI18n(): void {
  current = detectLocale();
  document.documentElement.lang = current;
}
