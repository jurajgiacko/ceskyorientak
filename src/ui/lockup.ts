/**
 * The partner lockup — ČESKÝ ORIENŤÁK × ENERVIT.
 *
 * ## Both marks are real supplied files
 *
 * The brief's hard rule is that brand assets are never generated, and that
 * covers typesetting as much as it covers image synthesis. It would have been
 * easy to read "Český orienťák" as this game's own title and set it in Space
 * Grotesk — but it is not ours. `docs/BRAND.md` §3 is explicit: **"Český
 * orienťák" is the ČSOS wordmark**, and `public/brand/csos-hor.svg` is that
 * wordmark's official horizontal vector (`CO_logo-HOR.svg` in the manual's own
 * naming). Setting it as type would have produced a counterfeit of a real
 * federation mark in the wrong typeface — the federation's face is GT Planar,
 * which we are not licensed for and whose sanctioned fallback is only a
 * fallback for *our* copy, never for *their* logo.
 *
 * So neither side of the "×" is drawn here. Both are `<img>` of a supplied
 * file, unrecoloured and undistorted. The only thing this module authors is the
 * relationship between them: size, spacing and alignment.
 *
 * ## Why the Enervit mark needs a crop wrapper
 *
 * `enervit.png` is a 4001 × 2251 canvas (16:9) containing a 3897 × 947 red
 * rectangle (4.115:1) at offset (45, 666) — measured, not assumed; see the
 * constants below. Roughly **58 % of the file's height is empty alpha.**
 *
 * That padding is a layout trap, and the codebase had already fallen into it:
 * `height: 30px` on the raw `<img>` in the menu band drew a red rectangle only
 * `30 × 947/2251 ≈ 12.6 px` tall, and the BEFORE screen's `26px` drew 10.9 px.
 * A comment in shell.css reasoning that "20px was not enough" was sizing the
 * canvas, not the mark, and so was solving the wrong number.
 *
 * The wrapper below makes the element's box *be* the red rectangle: the image
 * is scaled by the rectangle's height and pulled by the measured offsets, with
 * the transparent margin clipped. Nothing is recoloured, nothing is stretched —
 * the aspect ratio is carried through exactly — and `enervit.png` stays the one
 * and only Enervit asset on disk. It just finally measures what it looks like,
 * which is what makes clear space and optical balance computable at all.
 *
 * ## The sizes are cap-height matched, not box matched
 *
 * Logos rarely balance on their bounding boxes and these two are a bad case:
 * the ČSOS SVG carries ~27 % empty padding top and bottom inside its own
 * viewBox, while Enervit's box is a solid slab drawn edge to edge. Matching
 * `height` would have made Enervit tower over the wordmark it sits beside.
 *
 * Both marks were rasterised and their ink profiled by row (see D-035) to find
 * the real cap heights:
 *
 * | Mark | cap height ÷ box height |
 * |---|---|
 * | `csos-hor.svg` — cap top to baseline of "Český orienťák" | **0.3145** |
 * | `enervit.png` — cap top to baseline of "ENERVIT" | **0.614** |
 *
 * Equal caps therefore need `enervitHeight = 0.3145/0.614 = 0.512 ×
 * csosHeight`, which is `--lockup-e` below. That also satisfies the brief's
 * rule that the partner mark is never larger than ours: at equal cap height the
 * Enervit rectangle is roughly half the ČSOS mark's box height.
 *
 * Vertical alignment needs no nudge, and that was checked rather than hoped
 * for: the ČSOS ink sits dead centre in its viewBox (141 px of padding above
 * and below in a 512 px raster) and Enervit's cap centre falls within 1.6 % of
 * its rectangle's centre. Plain `align-items: center` lands both cap centres
 * within about a pixel at shipping sizes.
 *
 * ## Clear space
 *
 * `docs/BRAND.md` §5.5 rule 4: never place Enervit red directly adjacent to the
 * event orange `#FE5900` — minimum one clear-space unit of beige between them.
 * The ČSOS mark *is* `#FE5900`, so this lockup is exactly the case that rule
 * governs. Enervit's guidelines publish no numeric clear-space figure (flagged
 * in ASSETS_NEEDED.md), so we adopt the usual construction: **one unit = the
 * height of the red rectangle**. The column gap is 0.75 units either side of
 * the "×", so the orange wordmark and the red rectangle are ≥ 1.5 units apart —
 * comfortably clear, with the neutral "×" occupying the middle of that space.
 *
 * The whole lockup sits on the beige `--c-beige` band that §5.5 rule 1 requires
 * of any partner surface. It never floats over terrain or the map.
 */

import { t } from '@/i18n';

/**
 * Measured geometry of `public/brand/enervit.png`.
 *
 * Obtained with `sharp(...).trim()` on the supplied file: the trim reports a
 * 3897 × 947 artwork at offset (45, 666) inside the 4001 × 2251 canvas. The
 * artwork is *not* exactly centred (45 px of padding at the left against 59 at
 * the right), which is why the offsets are carried explicitly instead of being
 * derived as half the difference.
 *
 *     canvas 4001 × 2251   artwork 3897 × 947   offset (45, 666)
 *
 * The numbers themselves live in `.mark-enervit` in src/styles/shell.css, which
 * is the only place that needs them; they are recorded here so the measurement
 * and its provenance sit next to the reasoning that depends on them.
 */

/**
 * The Enervit mark, cropped to its red rectangle.
 *
 * `alt` is empty by design when the caller supplies its own label: the mark is
 * then decorative *within* a labelled group, and a screen reader announcing
 * "Enervit" twice is worse than announcing it once.
 */
export function enervitMark(opts: { labelled?: boolean } = {}): string {
  const alt = opts.labelled ? '' : esc(t('brand.enervit'));
  return `<span class="mark-enervit"><img src="/brand/enervit.png" alt="${alt}" /></span>`;
}

/**
 * The full ČESKÝ ORIENŤÁK × ENERVIT lockup, ready to drop into a beige band.
 *
 * Exposed as a single `role="img"` with the partnership as its accessible name,
 * because that is what it is: one mark, not three unrelated pictures. The "×"
 * is `aria-hidden` so it is not read as the letter x.
 *
 * The "Main partner" caption sits in the grid cell *below the Enervit mark
 * only*, never under the pair — Enervit is the Main Partner; Český orienťák is
 * the federation whose event this is. A caption spanning both would claim a
 * relationship that does not exist.
 */
export function partnerLockup(): string {
  return `
    <div class="lockup" role="img" aria-label="${esc(t('brand.lockup'))}">
      <img class="lockup__csos" src="/brand/csos-hor.svg" alt="" />
      <span class="lockup__x" aria-hidden="true">×</span>
      ${enervitMark({ labelled: true })}
      <span class="lockup__caption">${esc(t('brand.mainPartner'))}</span>
    </div>`;
}

/**
 * The quieter Enervit-only credit used away from the title screen, where the
 * federation mark would be repetition rather than branding.
 */
export function enervitCredit(): string {
  return `
    <div class="partnercredit">
      <span class="partnercredit__label">${esc(t('brand.mainPartner'))}</span>
      ${enervitMark()}
    </div>`;
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&quot;',
  );
}
