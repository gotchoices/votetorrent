# VoteTorrentVoting Design Tokens — Reconciliation Table

**Source of truth:** Figma file `egzbAF1w71hJVPxLQEfZKL`, page `0:1`, Home `2761:1125` /
Ballot `2764:1181` frames, transcribed in `.planning/phases/38-figma-design-tokens-gating/38-FIGMA-EXTRACT.md`.

**Policy (D-01..D-07):** Figma values win for every semantic role. Authority's 18 shared
`ExtendedTheme.colors` key *names* are kept (D-02) so later-phase component code ports 1:1 —
only the *values* change. Every token — including MATCH tokens — gets a flag here and a
matching inline comment in `themes.ts` (D-04/D-05), kept in sync.

**Flags:** `MATCH` = value coincides with Authority's equivalent role · `DIVERGE` = shared role,
different value (Figma wins per D-01) · `NEW` = role Authority doesn't have.

## Light theme (Figma-derived, D-01)

| Token | Value | Figma node | Flag | Notes |
|---|---|---|---|---|
| `primary` | `#2196f3` | 2761:1125 / 2764:1181 | DIVERGE | Header banner, "Vote now"/"Continue Voting"/"Review & Submit" buttons, active links. Authority `primary` = `#007AFF` (iOS system blue) vs Figma's Material Blue 500. |
| `background` | `#fbfbfb` | 2761:1125 / 2764:1181 | DIVERGE | Screen background (Home + Ballot). Authority `background` = `#FFFFFF`; Figma's off-white is a deliberate, distinct near-white. |
| `surface` | `#fcfcfc` | 2761:1125 | DIVERGE | Home election card surface. Authority `surface` = `#FFFFFF`. |
| `card` | `#ffffff` | 2764:1181 | MATCH | Ballot office cards, sticky header, footer bg. Authority `card` = `#FFFFFF`. |
| `text` | `#000000` | 2761:1125 / 2764:1181 | MATCH | Body/title text. Authority `text` = `#000000`. |
| `textSecondary` | `#7d7d7d` | 2761:1125 / 2764:1181 | DIVERGE | Tab labels, "2/15 questions completed". Authority `textSecondary` = `#3F3F3F`. |
| `border` | `#e5e5e5` | 2761:1125 | DIVERGE | Home progress-bar track border. Authority `border` = `#D0D0D0`. (Home footer top border is a distinct `rgba(114,114,126,0.25)` — that's a footer-chrome value, not this general `border` role; footer shadow/elevation is handled byte-identically in `styles.ts` per D-16, not via this token.) |
| `notification` | `#FF3B30` | — (no in-frame value) | MATCH-by-fallback | No notification/badge UI visible in Home/Ballot frames; reused verbatim from Authority per D-02 (keep the key, sensible fallback, no invented hue). |
| `secondary` | `#000000` | — (no in-frame value) | MATCH-by-fallback | Reused verbatim from Authority (mirrors `text`, as Authority's own light theme also does). |
| `accent` | `#d9d9d9` | — (no in-frame value) | MATCH-by-fallback | Reused verbatim from Authority. |
| `error` | `#971d1d` | — (no in-frame value) | MATCH-by-fallback | No error state visible in Home/Ballot frames; reused verbatim from Authority. |
| `warning` | `#bcb600` | — (no in-frame value) | MATCH-by-fallback | Reused verbatim from Authority. |
| `contrast` | `#262626` | — (no in-frame value) | MATCH-by-fallback | Reused verbatim from Authority. |
| `success` | `#4caf50` | 2764:1181 | DIVERGE | Ballot selected-candidate value ("Voter's selection", Inter SemiBold). Authority `success` = `#096904`. See Open Q1 below — kept distinct from `progressFill`. |
| `dark` | `#000000` | — (no in-frame value) | MATCH-by-fallback | Reused verbatim from Authority. |
| `light` | `#ffffff` | — (no in-frame value) | MATCH-by-fallback | Reused verbatim from Authority. |
| `important` | `#e8e3ad` | — (no in-frame value) | MATCH-by-fallback | Reused verbatim from Authority. |
| `muted` | `#9e9e9e` | — (no in-frame value) | MATCH-by-fallback | Reused verbatim from Authority. |
| `link` | `#2196f3` | 2764:1181 | NEW | "Learn about this election" link affordance. See Open Q1 below. |
| `progressFill` | `#34c759` | 2761:1125 / 2764:1181 | NEW | Election/ballot progress-bar fill (iOS green). See Open Q1 below. |
| `progressTrack` | `#e5e5e5` | 2761:1125 | NEW | Election/ballot progress-bar track. See Open Q1 below. |
| `secondaryButtonSurface` | `#f5f5f5` | 2761:1125 | NEW | "Save & Exit" outline-button background (paired with `primary` border). |

## Dark theme (light-derived, D-11 — NO Figma dark frames exist per Plan 01's D-10 verdict: 12 Mode=Light variants, 0 Mode=Dark)

**Transform (one, applied to every token above):** HSL-lightness-invert + partial desaturation —
`newL = clamp(100 - lightL, 8, 92)`, `newS = max(0, lightS - 20)` (Material Design guidance: ~20pt
less saturation in dark mode), clamped away from pure black (`8`) / pure white (`92`). Computed
once during authoring, pasted as literal hex into `themes.ts` (no runtime computation). Does **not**
reuse any Authority dark value (Pitfall 2 — Authority's dark theme is a hand-tuned, non-formulaic
mix and its light values differ from Voting's Figma-derived ones anyway).

| Token | Light source | Dark value | Notes |
|---|---|---|---|
| `primary` | `#2196f3` | `#237ec7` | |
| `background` | `#fbfbfb` | `#141414` | |
| `surface` | `#fcfcfc` | `#141414` | Collapses to the same value as `background`/`card` — `background`/`surface`/`card` are all near-white in light (L 98-100), so the shared floor clamp (`newL=8`) produces near-identical dark values. Expected consequence of applying one mechanical transform uniformly (D-11), not a bug. |
| `card` | `#ffffff` | `#141414` | See `surface` note above. |
| `text` | `#000000` | `#ebebeb` | |
| `textSecondary` | `#7d7d7d` | `#828282` | Near self-inverse — source lightness is already mid-range. |
| `border` | `#e5e5e5` | `#1a1a1a` | |
| `notification` | `#FF3B30` | `#ba1e15` | |
| `secondary` | `#000000` | `#ebebeb` | |
| `accent` | `#d9d9d9` | `#262626` | |
| `error` | `#971d1d` | `#d07a7a` | |
| `warning` | `#bcb600` | `#ece756` | |
| `contrast` | `#262626` | `#d9d9d9` | |
| `success` | `#4caf50` | `#699a6b` | |
| `dark` | `#000000` | `#ebebeb` | |
| `light` | `#ffffff` | `#141414` | |
| `important` | `#e8e3ad` | `#474421` | |
| `muted` | `#9e9e9e` | `#616161` | |
| `link` | `#2196f3` | `#237ec7` | Same source hex as `primary` (Open Q1 canonicalization), so shares its derived dark value. |
| `progressFill` | `#34c759` | `#51b269` | |
| `progressTrack` | `#e5e5e5` | `#1a1a1a` | |
| `secondaryButtonSurface` | `#f5f5f5` | `#141414` | |

**WCAG AA contrast verification (D-12, substitutes for a Figma dark screenshot since none exists):**
measured in `__tests__/themes.test.ts` via a W3C relative-luminance `contrastRatio` helper —
`contrastRatio(dark.text #ebebeb, dark.background #141414)` and
`contrastRatio(dark.text #ebebeb, dark.card #141414)` both measure **≈15.45:1**, well above the
4.5:1 AA threshold for body text. No lightness nudge was required.

## Open Q1 — resolved Figma internal inconsistencies

1. **Link color** — Home uses `#0088d8`, Ballot uses `#2196f3` for the same "Learn about this…"
   affordance. **Resolved:** canonicalize to Ballot's `#2196f3` (= `primary`) — it's the more
   frequently used value across both frames (also the primary-button color) and avoids minting a
   near-duplicate blue. Home's `#0088d8` is treated as an authoring inconsistency, not a second role.
2. **Green ×2** — selected-candidate value `#4caf50` vs progress-bar fill `#34c759`. **Resolved:**
   treated as **two separate roles**, not canonicalized to one — `success` (`#4caf50`, selection
   feedback) and `progressFill` (`#34c759`, iOS-green progress bar) serve visually distinct purposes
   in the same screens and both are legitimately present.
3. **Progress track** — Home's track fill `#e5e5e5` vs Ballot's `#7d7d7d` border. **Resolved:**
   `progressTrack` = `#e5e5e5` (the track *fill* color, consistently used for the progress bar's
   background in Home); Ballot's `#7d7d7d` is the track's *border* stroke, already covered by the
   shared `border`/`textSecondary` roles, not a second fill value.

## Type scale (D-08)

Named steps (`display`/`h1`/`h2`/`h3`/`h4`/`body`/`caption`), sizes lifted from
`38-FIGMA-EXTRACT.md`'s type table. **DIVERGE:** line-heights use a ~1.15-1.25x ratio instead of
Figma's flat literal `18px` on every size (Pitfall 3 — Figma's own extract notes this is visually
clipped at 28-40px in the mock, an authoring shortcut, not a considered value).

| Step | fontSize | lineHeight | Figma fontSize | Figma lineHeight (literal) | Flag | Notes |
|---|---|---|---|---|---|---|
| `display` | 40 | 48 | 40px | 18px | DIVERGE | Countdown timer ("06:05:02"). Figma's 18px is clipped/overlapping at this size — not copied. |
| `h1` | 32 | 40 | 32px | 18px | DIVERGE | Network title ("Utah Network"). |
| `h2` | 28 | 34 | 28px | 18px | DIVERGE | Home election title ("General Election 2025"). |
| `h3` | 24 | 30 | 24px | 18px | DIVERGE | Ballot screen title (centered). |
| `h4` | 20 | 26 | 20px | 18px | DIVERGE | Office title / section header / button labels / "30% complete". |
| `body` | 16 | 22 | 16px | 18px | MATCH-ish | Body/labels/links/tab labels. Figma's literal 18px line-height already exceeds its 16px font-size (ratio 1.125x); our 22px (1.375x) is a slightly looser but non-clipping choice — flagged DIVERGE-in-spirit since the exact number differs, but the *direction* (lineHeight > fontSize) matches Figma here unlike the larger steps. |
| `caption` | 16 | 20 | 16px | 18px | DIVERGE | "N/M questions completed" — slightly tighter than `body` at the same font size. |

## Component radii (promoted from SC2 review — Phase 38 Plan 02 Task 3)

Corner-radius scale added to `themes.ts` as a sibling token to `type` (exposed on
`ExtendedTheme.radii`) so Phase 39-43 style radii from `theme/` and never inline a corner radius
(SC4/D-07). All **NEW** — Authority has no radii scale (its `cardSurface` radius `16` exists only as
an inline style value in `styles.ts`). RN clamps `borderRadius` to half the shorter side, so `pill`
fully-rounds any height.

| Token | Value | Figma node | Flag | Notes |
|---|---|---|---|---|
| `radii.sm` | `8` | — | NEW | Small chips / insets; general small-radius step. |
| `radii.md` | `12` | 2764:1181 | NEW | Outline buttons — "Save & Exit" rounded rectangle. |
| `radii.lg` | `16` | 2761:1125 / 2764:1181 | NEW | Cards — matches `globalStyles.cardSurface` borderRadius (kept consistent, not a second value). |
| `radii.pill` | `999` | 2761:1125 / 2764:1181 | NEW | Fully-rounded — progress bars (Home/Ballot) and primary CTAs ("Vote now" / "Continue Voting" / "Review & Submit Ballot"). RN clamps to half-height: the 8px progress bar renders 4px, CTAs render as pills. |

*Origin:* the SC2 parity render initially drew square progress bars/buttons; the reviewer flagged the
mismatch against Figma's rounded pills (blocking checkpoint). Rather than leave those radii to die
with the discarded scratch render (D-14), they were promoted to these tokens (D-07: add to `theme/`,
never inline in screens).

## Typography family (D-09)

`fonts` block mirrors Authority's shape exactly (`System` family, weights 400/500/700/900).
**DIVERGE (accepted):** Figma specifies **Inter** (Regular/Medium/SemiBold/Bold) — no custom font
bundling/linking is done this phase (D-09); native font-linking work is explicitly out of scope
until a dedicated typography phase, if ever pursued.

## Spacing / shadow reuse (TOKEN-02, handled in `styles.ts` — for reference only)

`globalStyles.footer` and `globalStyles.cardSurface` in `theme/styles.ts` (Plan 01) reuse
Authority's byte-identical elevation/shadow values per D-16 — Figma cannot render the Android
gesture bar, so those two blocks are copied/diffed, not re-derived from Figma. Not repeated here;
see `apps/VoteTorrentVoting/src/theme/styles.ts` and its `__tests__/styles.test.ts`.
