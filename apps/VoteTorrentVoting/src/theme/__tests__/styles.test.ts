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

	// D-16: cardSurface values are byte-identical to Authority's globalStyles.cardSurface.
	it('cardSurface deep-equals the byte-identical Authority values', () => {
		expect(globalStyleDefs.cardSurface).toEqual({
			borderRadius: 16,
			paddingVertical: 16,
			paddingHorizontal: 16,
			marginVertical: 10,
			marginHorizontal: 4,
			shadowColor: '#000',
			shadowOffset: { width: 0, height: 6 },
			shadowOpacity: 0.18,
			shadowRadius: 18,
			elevation: 8,
		});
	});

	it('exposes the shared-shell keys ported from Authority', () => {
		expect(globalStyleDefs).toHaveProperty('content');
		expect(globalStyleDefs).toHaveProperty('container');
		expect(globalStyleDefs).toHaveProperty('section');
		expect(globalStyleDefs).toHaveProperty('sectionTitle');
		expect(globalStyleDefs).toHaveProperty('footerButtonsContainer');
	});
});
