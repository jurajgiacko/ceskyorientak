/**
 * One switch, governing how much of the nutrition model the game is allowed to
 * *show* and attribute to a product.
 *
 * ## Why this is a flag and not a decision
 *
 * `docs/CLAIMS_TO_REVIEW.md` sets out the EU position: under Reg. (EC) No
 * 1924/2006 Art. 2(2)(1) a stat bar that responds to a named food is a
 * pictorial claim, and several of the effects this game would naturally model
 * have no authorised claim behind them — caffeine most of all, which has none
 * at all anywhere in the EU register.
 *
 * The client — the Enervit CZ/SK distributor, whose product and whose exposure
 * this is — has decided to run the full mechanic. That decision is his to make
 * and it is recorded in `docs/DECISIONS.md` D-020. What is *not* sensible is
 * for that decision to be spread across twenty files, because the build that
 * ships to a private audience and the build that might ship alongside a World
 * Cup are not necessarily the same build, and the second one should be a
 * one-line change rather than an archaeology exercise.
 *
 * So: everything the constrained build needs still exists and still works. It
 * is reached by setting one environment variable.
 *
 * ## What the flag does and does not govern
 *
 * | | `CLAIMS_SAFE` off (default) | `CLAIMS_SAFE` on |
 * |---|---|---|
 * | Carbohydrate → `glycogen`, `bloodSugar` during a race | applied, shown | applied, not attributed |
 * | Isotonic drink → `hydration` | applied, shown | applied, not attributed |
 * | Caffeine → `focus` | applied, shown | **not applied at all** |
 * | Take confirmation | names what moved | composition and time cost only |
 * | Focus indicator in the HUD | shown | absent |
 *
 * Caffeine is the one effect the flag *suppresses* rather than merely hides.
 * A hidden mechanic that still decides the race would make the constrained
 * build a different game wearing the same UI, and the whole point of that build
 * is that no product touches `focus` (D-013). The dose–response model itself
 * lives unconditionally in `src/sim/athlete.ts`, so there is one honest
 * physiology and only its *application* is gated — which is what keeps this
 * from forking into two divergent games.
 *
 * ## What the flag never governs
 *
 * Two rules hold in both builds, because they are game design before they are
 * anything else:
 *
 *  - **Nothing is ever framed as a penalty for not consuming.** Depletion is
 *    caused by pace, terrain, climb and heat. A player who takes nothing on a
 *    Sprint has fuelled correctly and the UI stays quiet.
 *  - **More is never monotonically better.** `overfuellingPenalty` costs time
 *    for carrying and consuming past what the race can use, and the caffeine
 *    dose–response turns over and comes back down. A mechanic whose optimum is
 *    "take everything" contains no decision at all.
 */

/**
 * True when the build must stay inside the authorised-claims boundary.
 *
 * Set `VITE_CLAIMS_SAFE=1` at build time. Anything else — including the var
 * being absent, which is the default — runs the full mechanic.
 */
export const CLAIMS_SAFE: boolean = readFlag();

function readFlag(): boolean {
  // `import.meta.env` is Vite's, and is statically replaced at build time. The
  // optional chain is for the non-Vite contexts (node tooling) that import
  // types from here.
  const raw = (import.meta.env as Record<string, string | undefined> | undefined)?.[
    'VITE_CLAIMS_SAFE'
  ];
  return raw === '1' || raw === 'true';
}
