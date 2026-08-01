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

async function boot(): Promise<void> {
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
