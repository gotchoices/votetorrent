// `import type` (not a value import) — both `ExtendedTheme` and `Theme` are used only in type
// positions in this file. This lets Babel elide the import entirely at transform time, so Jest
// never has to load @react-navigation/native's real ESM module graph just to run this file's
// tests (its `lib/module` build is plain ESM and isn't in the RN jest preset's
// transformIgnorePatterns allow-list). A plain `import { ExtendedTheme, Theme }` (Authority's
// literal style) is NOT type-only from Babel's single-file elision heuristic's point of view once
// combined with the `declare module` augmentation below, and fails to import under Jest.
import type { ExtendedTheme, Theme } from '@react-navigation/native';

// D-09: family stays `System` — no Inter bundling this phase (Figma specifies Inter;
// documented, accepted divergence). Mirrors Authority's `fonts` block verbatim (shape only).
const fonts = {
	regular: {
		fontFamily: 'System',
		fontWeight: '400' as const,
	},
	medium: {
		fontFamily: 'System',
		fontWeight: '500' as const,
	},
	bold: {
		fontFamily: 'System',
		fontWeight: '700' as const,
	},
	heavy: {
		fontFamily: 'System',
		fontWeight: '900' as const,
	},
};

// D-08: named type scale (font-size + line-height), a deliberate departure from Authority's
// "sizes inline per component" pattern. Sizes are lifted from 38-FIGMA-EXTRACT.md's type table;
// line-heights use a ~1.2-1.375x ratio (≈1.2-1.25x on display/h1/h2/h3/caption, 1.3x on h4,
// 1.375x on body) instead of Figma's flat literal `18px` on every size (Pitfall 3 — copying 18px
// onto 28-40px text visually clips/overlaps in RN rendering).
export const type = {
	display: { fontSize: 40, lineHeight: 48 }, // countdown timer ("06:05:02") — Figma: 40px/18px(DIVERGE, clipped literal)
	h1: { fontSize: 32, lineHeight: 40 }, // network title ("Utah Network") — Figma: 32px/18px(DIVERGE)
	h2: { fontSize: 28, lineHeight: 34 }, // Home election title — Figma: 28px/18px(DIVERGE)
	h3: { fontSize: 24, lineHeight: 30 }, // Ballot screen title (centered) — Figma: 24px/18px(DIVERGE)
	h4: { fontSize: 20, lineHeight: 26 }, // office title / section header / button labels — Figma: 20px/18px(DIVERGE)
	body: { fontSize: 16, lineHeight: 22 }, // body/labels/links/tab labels — Figma: 16px/18px(MATCH, ratio>1 already)
	caption: { fontSize: 16, lineHeight: 20 }, // "N/M questions completed" — Figma: 16px/18px(DIVERGE, slightly tighter)
} as const;

// Component corner radii, promoted from the SC2 parity render (Phase 38 Plan 02 Task 3 review) so
// later screen phases (39-43) style radii from theme/ and never inline a corner radius (SC4/D-07).
// NEW — Authority has no radii scale (its cardSurface radius 16 lives only as an inline style
// value). RN clamps borderRadius to half the shorter side, so `pill` fully-rounds any height
// (8px progress bar → 4px effective; ~44px CTA → ~22px).
export const radii = {
	sm: 8, // small chips / insets
	md: 12, // outline buttons — Figma 2764:1181 "Save & Exit" rounded-rect · NEW
	lg: 16, // cards — matches globalStyles.cardSurface borderRadius (Figma 2761:1125 / 2764:1181)
	pill: 999, // fully-rounded — progress bars + primary CTAs ("Vote now"/"Continue Voting"/"Review & Submit") · Figma 2761:1125 / 2764:1181 · NEW
} as const;

// D-02/D-15: mirror Authority's ExtendedTheme augmentation shape 1:1 (18 shared color keys +
// fonts), extended with the new Voting-only roles (D-06) and a top-level `type` scale key
// (sibling to colors/fonts, per RESEARCH Pattern 2 — NOT nested inside colors/fonts).
declare module '@react-navigation/native' {
	export type ExtendedTheme = Theme & {
		colors: {
			// --- 18 shared Authority keys (D-02) — values are Figma-derived per D-01 ---
			primary: string;
			background: string;
			surface: string;
			card: string;
			text: string;
			textSecondary: string;
			border: string;
			notification: string;
			secondary: string;
			accent: string;
			error: string;
			warning: string;
			contrast: string;
			success: string;
			dark: string;
			light: string;
			important: string;
			muted: string;
			// --- Voting-only new roles visible in Home + Ballot (D-06) ---
			link: string;
			progressFill: string;
			progressTrack: string;
			secondaryButtonSurface: string;
			// --- Registration-tab card brand fills (Figma not-registered / registered cards).
			// Constant across light + dark: these are brand card fills, not surfaces that invert. ---
			registerNegative: string;
			registerPositive: string;
			validBadge: string;
		};
		fonts: typeof fonts;
		type: typeof type;
		radii: typeof radii;
	};
}

export const lightTheme: ExtendedTheme = {
	dark: false,
	colors: {
		// --- 18 shared keys, Figma-derived (D-01) ---
		primary: '#2196f3', // Figma #2196f3 · 2761:1125/2764:1181 (header banner, "Vote now"/"Review & Submit" buttons, active links) · DIVERGE vs Authority primary #007AFF (Material Blue 500)
		background: '#fbfbfb', // Figma #fbfbfb · 2761:1125/2764:1181 (screen background, Home + Ballot) · DIVERGE vs Authority background #FFFFFF (off-white)
		surface: '#fcfcfc', // Figma #fcfcfc · 2761:1125 (Home election card surface) · DIVERGE vs Authority surface #FFFFFF (near-white)
		card: '#ffffff', // Figma #ffffff · 2764:1181 (Ballot office cards, sticky header, footer bg) · MATCH vs Authority card #FFFFFF
		text: '#000000', // Figma #000000 · 2761:1125/2764:1181 (body/title text) · MATCH vs Authority text #000000
		textSecondary: '#7d7d7d', // Figma #7d7d7d · 2761:1125/2764:1181 (tab labels, "2/15 questions completed") · DIVERGE vs Authority textSecondary #3F3F3F
		border: '#e5e5e5', // Figma #e5e5e5 · 2761:1125 (Home progress-bar track border) · DIVERGE vs Authority border #D0D0D0
		notification: '#FF3B30', // no in-frame Figma value in Home/Ballot · MATCH-by-fallback, reused verbatim from Authority notification #FF3B30
		secondary: '#000000', // no in-frame Figma value in Home/Ballot · MATCH-by-fallback, reused verbatim from Authority secondary #000000
		accent: '#d9d9d9', // no in-frame Figma value in Home/Ballot · MATCH-by-fallback, reused verbatim from Authority accent #d9d9d9
		error: '#971d1d', // no in-frame Figma value in Home/Ballot · MATCH-by-fallback, reused verbatim from Authority error #971d1d
		warning: '#bcb600', // no in-frame Figma value in Home/Ballot · MATCH-by-fallback, reused verbatim from Authority warning #bcb600
		contrast: '#262626', // no in-frame Figma value in Home/Ballot · MATCH-by-fallback, reused verbatim from Authority contrast #262626
		success: '#4caf50', // Figma #4caf50 · 2764:1181 (Ballot selected-candidate value, "Voter's selection") · DIVERGE vs Authority success #096904 (Material Green 500); see Open Q1 — distinct from progressFill below
		dark: '#000000', // no in-frame Figma value in Home/Ballot · MATCH-by-fallback, reused verbatim from Authority dark #000000
		light: '#ffffff', // no in-frame Figma value in Home/Ballot · MATCH-by-fallback, reused verbatim from Authority light #ffffff
		important: '#e8e3ad', // no in-frame Figma value in Home/Ballot · MATCH-by-fallback, reused verbatim from Authority important #e8e3ad
		muted: '#9e9e9e', // no in-frame Figma value in Home/Ballot · MATCH-by-fallback, reused verbatim from Authority muted #9e9e9e
		// --- Voting-only new roles (D-06), resolving the 3 flagged Figma inconsistencies (Open Q1) ---
		link: '#2196f3', // Figma #2196f3 · 2764:1181 ("Learn about this…" link) · NEW · Open Q1: canonicalized to Ballot's #2196f3 (= primary) over Home's #0088d8 — same affordance, one role
		progressFill: '#34c759', // Figma #34c759 · 2761:1125/2764:1181 (progress-bar fill) · NEW · Open Q1: kept distinct from `success` (#4caf50) — progress-fill (iOS green) and selected-value green are two separate roles, not one to canonicalize
		progressTrack: '#e5e5e5', // Figma #e5e5e5 · 2761:1125 (Home progress-bar track) · NEW · Open Q1: Home's #e5e5e5 is the track fill; Ballot's #7d7d7d is the track's BORDER (mapped to `textSecondary`/`border` roles), not a second track-fill value
		secondaryButtonSurface: '#f5f5f5', // Figma #f5f5f5 · 2761:1125 ("Save & Exit" outline-button background) · NEW · no equivalent Authority role
		// Registration-tab card brand fills (Figma not-registered/registered cards) — constant across themes.
		registerNegative: '#ef5644', // not-registered card (coral red)
		registerPositive: '#3ebd5d', // registered card (green)
		validBadge: '#e6c200', // "Valid through" badge (yellow)
	},
	fonts,
	type,
	radii,
};

// D-11: dark is derived from Voting's OWN light tokens above via ONE documented transform —
// HSL-lightness-invert (newL = clamp(100 - lightL, 8, 92)) + ~20pt desaturation
// (newS = max(0, lightS - 20)), clamped away from pure black/white. Computed once during
// authoring (see 38-RESEARCH.md §Code Examples `deriveDark`) and pasted here as literal hex —
// NOT computed at runtime (Anti-Pattern) and NOT copied from Authority's dark palette (Pitfall 2:
// Authority's dark theme is a hand-tuned Apple-HIG mix with no reusable formula, and its light
// values differ from Voting's Figma-derived light values anyway). Verified in themes.test.ts:
// contrastRatio(dark.text, dark.background) >= 4.5 AND contrastRatio(dark.text, dark.card) >= 4.5.
export const darkTheme: ExtendedTheme = {
	dark: true,
	colors: {
		primary: '#237ec7', // derived from light.primary #2196f3 via HSL invert(L→8)+desat(-20)
		// D-11-OVERRIDE (2026-07-13 dark-mode-contrast-fixes): the raw mechanical transform floored
		// background/surface/card all to #141414 (all three near-white in light → same L=8 clamp),
		// collapsing card elevation to zero — on-device, cards were invisible against the page.
		// Replaced with a hand-tuned 3-step dark elevation ramp (base < surface < card). text/bg and
		// text/card contrast stay well above AA (≈16:1 / ≈14:1, verified in themes.test.ts).
		background: '#0d0d0d', // base layer (darkest) — was #141414
		surface: '#1c1c1c', // elevated surface — was #141414
		card: '#1e1e1e', // cards read above the page — was #141414
		text: '#ebebeb', // derived from light.text #000000 via HSL invert(L→92)+desat(-20)
		textSecondary: '#828282', // derived from light.textSecondary #7d7d7d via HSL invert+desat (near self-inverse — source L is already mid-range)
		border: '#333333', // D-11-OVERRIDE: was #1a1a1a (invisible against #141414 surfaces) — bumped so dividers/outlines/progress-track border read in dark mode
		notification: '#ba1e15', // derived from light.notification #FF3B30 via HSL invert+desat(-20)
		secondary: '#ebebeb', // derived from light.secondary #000000 via HSL invert(L→92)+desat(-20) (mirrors text; no on-color foreground usage)
		accent: '#262626', // derived from light.accent #d9d9d9 via HSL invert+desat(-20)
		error: '#d07a7a', // derived from light.error #971d1d via HSL invert+desat(-20)
		warning: '#ece756', // derived from light.warning #bcb600 via HSL invert+desat(-20)
		contrast: '#d9d9d9', // derived from light.contrast #262626 via HSL invert+desat(-20)
		success: '#699a6b', // derived from light.success #4caf50 via HSL invert+desat(-20)
		dark: '#000000', // D-11-OVERRIDE: absolute anchor — must NOT invert. `dark`/`light` are fixed on-color foreground/background anchors (used ON saturated fills), not surfaces that flip with the theme. Was wrongly inverted to #ebebeb.
		light: '#ffffff', // D-11-OVERRIDE: absolute anchor — must NOT invert. Consumed at 20 sites as the foreground ON saturated/branded fills (header on primary, "Vote now"/footer CTAs on primary, selected language pill, red/green registration cards, office check icon). Inverting it to #141414 rendered all of them near-black-on-color (failed contrast).
		important: '#474421', // derived from light.important #e8e3ad via HSL invert+desat(-20)
		muted: '#616161', // derived from light.muted #9e9e9e via HSL invert+desat(-20)
		link: '#237ec7', // derived from light.link #2196f3 via HSL invert(L→8)+desat(-20) (= dark.primary, same source hex)
		progressFill: '#51b269', // derived from light.progressFill #34c759 via HSL invert+desat(-20)
		progressTrack: '#2a2a2a', // D-11-OVERRIDE: was #1a1a1a (invisible on #141414) — raised to read as an unfilled track against the new card/bg ramp
		secondaryButtonSurface: '#2a2a2a', // D-11-OVERRIDE: was #141414 (indistinguishable from bg) — raised so outline buttons / the Registration update block / the unselected language pill read as filled interactive surfaces
		// Brand card fills — kept identical to light (a red/green/yellow brand card does not invert).
		registerNegative: '#ef5644',
		registerPositive: '#3ebd5d',
		validBadge: '#e6c200',
	},
	fonts,
	type,
	radii,
};
