/**
 * localStorage-backed ScoreStore. The MVP ships this and only this:
 * no backend, no accounts, no network. Everything below works offline.
 *
 * FirebaseStore lands post-MVP behind the same interface — see
 * docs/ROADMAP.md. Nothing outside this file may reach for localStorage
 * directly, or that swap stops being a one-line change.
 */

import type {
  ScoreStore,
  RunResult,
  LeaderboardEntry,
  CareerProgress,
} from '@/core/types';

const NS = 'orientak.v1';
const K_RUNS = `${NS}.runs`;
const K_PROGRESS = `${NS}.progress`;

/** Ghost routes dominate the payload, so cap what we keep per course. */
const MAX_RUNS_PER_COURSE = 20;

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    // Corrupt or unavailable storage (private mode, quota, hand-edited).
    // Losing a personal best is survivable; crashing the game is not.
    return fallback;
  }
}

function writeJson(key: string, value: unknown): boolean {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

export class LocalStore implements ScoreStore {
  /** courseId → runs, best-first. */
  private runs: Record<string, RunResult[]>;

  constructor() {
    this.runs = readJson<Record<string, RunResult[]>>(K_RUNS, {});
  }

  async submitRun(result: RunResult): Promise<void> {
    const list = this.runs[result.courseId] ?? [];
    list.push(result);
    // Valid runs first, then by time. A DSQ never becomes a personal best.
    list.sort((a, b) => {
      if (a.valid !== b.valid) return a.valid ? -1 : 1;
      return a.timeS - b.timeS;
    });
    this.runs[result.courseId] = list.slice(0, MAX_RUNS_PER_COURSE);

    if (!writeJson(K_RUNS, this.runs)) {
      // Quota hit — drop the route data from older runs and retry once.
      // A time without a ghost is still worth keeping.
      for (const [id, rs] of Object.entries(this.runs)) {
        this.runs[id] = rs.map((r, i) => (i === 0 ? r : { ...r, route: [] }));
      }
      writeJson(K_RUNS, this.runs);
    }
  }

  async getLeaderboard(courseId: string, limit = 10): Promise<LeaderboardEntry[]> {
    const list = this.runs[courseId] ?? [];
    return list.slice(0, limit).map((r) => ({
      name: 'You',
      timeS: r.timeS,
      at: r.at,
      valid: r.valid,
    }));
  }

  async getPersonalBests(): Promise<Record<string, RunResult>> {
    const out: Record<string, RunResult> = {};
    for (const [courseId, list] of Object.entries(this.runs)) {
      const best = list.find((r) => r.valid);
      if (best) out[courseId] = best;
    }
    return out;
  }

  async getGhost(courseId: string): Promise<RunResult | null> {
    const list = this.runs[courseId] ?? [];
    return list.find((r) => r.valid && r.route.length > 0) ?? null;
  }

  async saveProgress(p: CareerProgress): Promise<void> {
    writeJson(K_PROGRESS, p);
  }

  async loadProgress(): Promise<CareerProgress | null> {
    return readJson<CareerProgress | null>(K_PROGRESS, null);
  }
}
