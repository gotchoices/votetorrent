/**
 * Unit test for ScanScreen (SCAN-01/I18N-01, 43-01) — locks in the branded `scan.*`
 * "not available yet" placeholder (icon + title + body) and guards against regressing to the
 * generic `common.placeholderBody` copy. Mounts inside VoterAppProvider + ThemeProvider (this
 * screen calls useVoterApp()/useTheme()). No lifecycle-state dependency and no fetch-on-mount,
 * so a single synchronous renderer.act() suffices — no flush() ticks needed.
 *
 * Phase 44-07 (D-02/D-04): `VoterAppProvider` is now a real composition root requiring a
 * `CadreNodeProvider` ancestor — this screen-level test has no need to exercise that boot, so it
 * uses the manual Jest mock at `providers/__mocks__/VoterAppProvider.tsx` (mirrors the authority
 * app's App.test.tsx inert-mock convention).
 */
import React from 'react';
import renderer from 'react-test-renderer';
import {Text} from 'react-native';
import {ThemeProvider} from '@react-navigation/native';
import '../../../i18n'; // initializes the global i18next instance useTranslation() reads from

jest.mock('../../../providers/VoterAppProvider');
import {VoterAppProvider} from '../../../providers/VoterAppProvider';
import {lightTheme} from '../../../theme/themes';
import ScanScreen from '../ScanScreen';

function renderScreen() {
	let tr!: renderer.ReactTestRenderer;
	renderer.act(() => {
		tr = renderer.create(
			<ThemeProvider value={lightTheme}>
				<VoterAppProvider>
					<ScanScreen />
				</VoterAppProvider>
			</ThemeProvider>,
		);
	});
	return tr;
}

/** Collects every rendered <Text> node's string content into one searchable string. */
function allText(tr: renderer.ReactTestRenderer): string {
	return tr.root
		.findAllByType(Text)
		.map(node => {
			const children = node.props.children;
			return Array.isArray(children) ? children.join('') : String(children ?? '');
		})
		.join(' | ');
}

describe('ScanScreen (SCAN-01/I18N-01, branded placeholder)', () => {
	it('renders the branded scan.* title and body copy', () => {
		const tr = renderScreen();
		const text = allText(tr);

		expect(text).toContain('QR scanning coming soon');
		expect(text).toContain("isn't available yet");
	});

	it('does not render the generic common.placeholderBody copy (D-01: own identity)', () => {
		const tr = renderScreen();
		const text = allText(tr);

		expect(text).not.toContain("This screen isn't built yet");
	});
});
