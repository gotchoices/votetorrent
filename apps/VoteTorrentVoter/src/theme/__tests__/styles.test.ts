import { globalStyleDefs } from '../styles';

describe('globalStyles (theme/styles.ts)', () => {
	// D-16: footer values are byte-identical to Authority's globalStyles.footer
	// (copied/diffed from apps/VoteTorrentAuthority/src/theme/styles.ts, NOT
	// re-derived from Figma, because Figma cannot render the Android gesture bar).
	it('footer deep-equals the byte-identical Authority values', () => {
		expect(globalStyleDefs.footer).toEqual({
			paddingVertical: 16,
			paddingHorizontal: 16,
			elevation: 12,
			shadowOffset: { width: 0, height: -1 },
			shadowOpacity: 0.1,
			shadowRadius: 1,
		});
	});

	// cardSurface geometry (border radius + padding + margins) is platform-independent.
	it('cardSurface has rounded-corner card geometry', () => {
		expect(globalStyleDefs.cardSurface).toMatchObject({
			borderRadius: 16,
			paddingVertical: 16,
			paddingHorizontal: 16,
			marginVertical: 10,
			marginHorizontal: 4,
		});
	});

	// The shadow uses the CSS-like `boxShadow` prop (RN 0.78 + New Architecture honors it on BOTH
	// platforms), producing a soft, rounded, blended shadow that follows the corners — unlike Android
	// `elevation`, which reads as a hard rectangular strip (see styles.ts). Assert a non-empty
	// boxShadow exists without coupling the test to its exact offset/blur/alpha values.
	it('cardSurface applies a rounded boxShadow', () => {
		const cs = globalStyleDefs.cardSurface as Record<string, unknown>;
		expect(typeof cs.boxShadow).toBe('string');
		expect(cs.boxShadow as string).not.toHaveLength(0);
	});

	it('exposes the shared-shell keys ported from Authority', () => {
		expect(globalStyleDefs).toHaveProperty('content');
		expect(globalStyleDefs).toHaveProperty('container');
		expect(globalStyleDefs).toHaveProperty('section');
		expect(globalStyleDefs).toHaveProperty('sectionTitle');
		expect(globalStyleDefs).toHaveProperty('footerButtonsContainer');
	});
});
