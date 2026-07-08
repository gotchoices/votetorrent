import { lightTheme, darkTheme, type, radii } from '../themes';

// WCAG relative-luminance contrast-ratio helper — test-only, plain pure function,
// per 38-RESEARCH.md §Code Examples (not shipped as runtime code).
// Source: W3C WAI "Understanding SC 1.4.3: Contrast (Minimum)" +  "Relative Luminance".
function hexToRgb(hex: string): [number, number, number] {
	const clean = hex.replace('#', '');
	const num = parseInt(clean, 16);
	return [(num >> 16) & 255, (num >> 8) & 255, num & 255];
}

function srgbChannelToLinear(c: number): number {
	const cs = c / 255;
	return cs <= 0.04045 ? cs / 12.92 : Math.pow((cs + 0.055) / 1.055, 2.4);
}

function relativeLuminance(hex: string): number {
	const [r, g, b] = hexToRgb(hex);
	const [R, G, B] = [r, g, b].map(srgbChannelToLinear);
	return 0.2126 * R + 0.7152 * G + 0.0722 * B;
}

function contrastRatio(hexA: string, hexB: string): number {
	const [L1, L2] = [relativeLuminance(hexA), relativeLuminance(hexB)].sort((a, b) => b - a);
	return (L1 + 0.05) / (L2 + 0.05);
}

const SHARED_KEYS = [
	'primary',
	'background',
	'surface',
	'card',
	'text',
	'textSecondary',
	'border',
	'notification',
	'secondary',
	'accent',
	'error',
	'warning',
	'contrast',
	'success',
	'dark',
	'light',
	'important',
	'muted',
] as const;

const NEW_ROLES = ['link', 'progressFill', 'progressTrack', 'secondaryButtonSurface'] as const;

describe('themes (theme/themes.ts)', () => {
	// D-02: key completeness — every shared Authority color role is present in both themes.
	it('lightTheme.colors exposes all 18 shared Authority keys', () => {
		for (const key of SHARED_KEYS) {
			expect(lightTheme.colors[key]).toBeDefined();
			expect(typeof lightTheme.colors[key]).toBe('string');
		}
	});

	it('darkTheme.colors exposes all 18 shared Authority keys', () => {
		for (const key of SHARED_KEYS) {
			expect(darkTheme.colors[key]).toBeDefined();
			expect(typeof darkTheme.colors[key]).toBe('string');
		}
	});

	// D-06: new Voting-only roles visible in Home + Ballot are present and not undefined.
	it('exposes the new Voting-only roles (link, progressFill, progressTrack, secondaryButtonSurface) in both themes', () => {
		for (const role of NEW_ROLES) {
			expect(lightTheme.colors[role]).toBeDefined();
			expect(darkTheme.colors[role]).toBeDefined();
		}
	});

	// D-08 / Pitfall 3: type scale steps have numeric fontSize + lineHeight, and lineHeight is
	// NOT the literal Figma 18px on sizes >= 20px (lineHeight > fontSize for those steps).
	it('type scale exports named steps with fontSize + lineHeight', () => {
		const steps = Object.keys(type) as Array<keyof typeof type>;
		expect(steps.length).toBeGreaterThan(0);
		for (const step of steps) {
			expect(typeof type[step].fontSize).toBe('number');
			expect(typeof type[step].lineHeight).toBe('number');
		}
	});

	it('lineHeight exceeds fontSize for every type step >= 20px (not the literal Figma 18px)', () => {
		const steps = Object.keys(type) as Array<keyof typeof type>;
		for (const step of steps) {
			const { fontSize, lineHeight } = type[step];
			if (fontSize >= 20) {
				expect(lineHeight).toBeGreaterThan(fontSize);
			}
		}
	});

	// D-12: dark contrast gate — since no Figma dark frames exist (D-10 verdict: 0 dark frames),
	// dark is verified by WCAG AA contrast rather than screenshot parity.
	it('darkTheme text/background contrast meets WCAG AA (>= 4.5:1)', () => {
		const ratio = contrastRatio(darkTheme.colors.text, darkTheme.colors.background);
		expect(ratio).toBeGreaterThanOrEqual(4.5);
	});

	it('darkTheme text/card contrast meets WCAG AA (>= 4.5:1)', () => {
		const ratio = contrastRatio(darkTheme.colors.text, darkTheme.colors.card);
		expect(ratio).toBeGreaterThanOrEqual(4.5);
	});

	// dark flag + shared fonts block on both themes.
	it('lightTheme.dark is false and darkTheme.dark is true; both carry the shared fonts block', () => {
		expect(lightTheme.dark).toBe(false);
		expect(darkTheme.dark).toBe(true);
		expect(lightTheme.fonts).toBeDefined();
		expect(darkTheme.fonts).toBeDefined();
		expect(lightTheme.fonts).toBe(darkTheme.fonts);
	});

	// Component radii (promoted from the SC2 parity review) — a monotonic scale exposed on both
	// themes so Phase 39-43 style corner radii from theme/ (SC4/D-07), never inline.
	it('exposes a radii scale (sm/md/lg/pill) of ascending numbers', () => {
		for (const key of ['sm', 'md', 'lg', 'pill'] as const) {
			expect(typeof radii[key]).toBe('number');
		}
		expect(radii.md).toBeGreaterThanOrEqual(radii.sm);
		expect(radii.lg).toBeGreaterThanOrEqual(radii.md);
		expect(radii.pill).toBeGreaterThan(radii.lg); // pill is the fully-rounded sentinel
	});

	it('both themes carry the shared radii scale', () => {
		expect(lightTheme.radii).toBe(radii);
		expect(darkTheme.radii).toBe(radii);
	});
});
