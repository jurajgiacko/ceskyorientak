/**
 * Entry point. Boots i18n, checks the platform, and hands off to the shell.
 *
 * Deliberately tiny: this file is in the critical path for time-to-first-play,
 * so everything heavy (three.js, terrain, the map renderer) is dynamically
 * imported once the menu is on screen.
 */

import './styles/base.css';
import { initI18n, t } from '@/i18n';
import { detectCapabilities } from '@/core/capabilities';

/**
 * Capture render-time errors somewhere the CI harness can read them.
 *
 * three.js reports shader compilation failures through `console.error` and then
 * carries on, so a broken material produces an object that silently does not
 * draw. Keeping the last few here means `tools/perf/budget.mjs` can say *what*
 * broke rather than only that a scene never published a frame.
 */
function captureRenderErrors(): void {
  const log: string[] = [];
  (window as unknown as Record<string, unknown>).__renderErrors = log;
  const original = console.error;
  console.error = (...args: unknown[]) => {
    const text = args.map((a) => String(a)).join(' ');
    if (/shader|webgl|program/i.test(text) && log.length < 10) {
      log.push(text.slice(0, 400));
    }
    original.apply(console, args as []);
  };
}

async function boot(): Promise<void> {
  captureRenderErrors();
  initI18n();

  const app = document.getElementById('app');
  if (!app) throw new Error('#app missing');

  const caps = detectCapabilities();
  if (!caps.webgl2) {
    app.innerHTML = `<div class="fatal"><h1>${t('app.title')}</h1><p>${t(
      'error.noWebgl',
    )}</p></div>`;
    return;
  }

  document.documentElement.dataset.tier = caps.tier;
  document.documentElement.dataset.input = caps.touch ? 'touch' : 'pointer';

  const { mountShell } = await import('@/ui/shell');
  await mountShell(app, caps);
}

boot().catch((err: unknown) => {
  console.error('[boot]', err);
  const app = document.getElementById('app');
  if (app) {
    app.innerHTML = `<div class="fatal"><h1>ORIENŤÁK</h1><p>${String(err)}</p></div>`;
  }
});
