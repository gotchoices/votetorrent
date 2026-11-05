/**
 * timeline-layout (61-01, D-08) — the single hoisted source of truth for the Timeline card's
 * vertical margin.
 *
 * What this is: the vertical gap between stacked Timeline cards, raised from `8` to `16` per this
 * phase's UI-SPEC so the inter-card gap matches the card's own internal padding
 * (`globalStyles.cardSurface.paddingVertical`).
 *
 * Who consumes it: `TimelineRow`'s `styles.card.marginVertical` and `TimelineRail`'s
 * `dotCenterY` alignment formula. These two values MUST NOT desync — if the card's margin
 * changes and the rail's dot-centre math does not, the dots stop lining up with their card
 * titles.
 *
 * The literal `16` for this value lives in exactly ONE place in the repo: this constant.
 * Re-typing it anywhere else (a second hand-copied literal) is the specific defect this module
 * exists to prevent.
 *
 * Wired as of 61-06 (wave 4): `TimelineRow` reads it as `styles.card.marginVertical` and
 * `TimelineRail` reads it in its `dotCenterY` formula — the two consumers named above. The
 * earlier text here described 61-01's deliberately-unwired state ("still reads 8") and stayed
 * unchanged after 61-06 wired both, making all three of its claims false in the one module whose
 * entire job is preventing exactly that kind of desync.
 *
 * IN-08: that same paragraph then cited both consumers by LINE NUMBER, in the one module that
 * exists because a claim here went stale. Line numbers are the fastest-drifting form of
 * reference there is — within this very phase, `run-timeline-geometry-proof.sh` located
 * `ROW_DISPLAY` by a line range that had already slipped nine lines off it (IN-02), pointing at
 * the tail of an unrelated interface instead. Cite the symbol:
 * `grep -rn TIMELINE_CARD_MARGIN_V apps/VoteTorrentVoter/src` finds every consumer no matter
 * where it has moved to, and cannot be silently wrong.
 */
export const TIMELINE_CARD_MARGIN_V = 16;
