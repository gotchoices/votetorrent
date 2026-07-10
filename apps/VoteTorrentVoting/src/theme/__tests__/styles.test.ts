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

	// The shadow is scoped per-platform (Platform.select resolves one branch at module load) so it
	// follows the rounded corners instead of painting a rectangle behind the card (RN 0.78 Android
	// honors iOS shadow* props as a rectangular box — see styles.ts). Assert a shadow exists without
	// coupling the test to which platform branch the jest env resolved.
	it('cardSurface applies a rounded, platform-appropriate shadow', () => {
		const cs = globalStyleDefs.cardSurface as Record<string, unknown>;
		expect('elevation' in cs || 'shadowRadius' in cs).toBe(true);
	});

	it('exposes the shared-shell keys ported from Authority', () => {
		expect(globalStyleDefs).toHaveProperty('content');
		expect(globalStyleDefs).toHaveProperty('container');
		expect(globalStyleDefs).toHaveProperty('section');
		expect(globalStyleDefs).toHaveProperty('sectionTitle');
		expect(globalStyleDefs).toHaveProperty('footerButtonsContainer');
	});
});
