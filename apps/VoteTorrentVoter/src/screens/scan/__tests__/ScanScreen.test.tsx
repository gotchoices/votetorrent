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

/**
 * 57-17/57-18 scroll-container gap closure (mirrors
 * apps/VoteTorrentAuthority/src/screens/settings/SettingsScreen.scrollContainer.test.tsx — the
 * canonical model). Walks the RENDERED react-test-renderer JSON tree for a host node whose
 * `type` is `RCTScrollView`, rather than a source-level grep.
 */
type TreeNode = {
	type: string;
	props: Record<string, unknown>;
	children: Array<TreeNode | string> | null;
};

function findHostNodeByType(json: unknown, targetType: string): TreeNode | null {
	if (json === null || json === undefined) return null;
	const nodes: unknown[] = Array.isArray(json) ? json : [json];
	for (const node of nodes) {
		if (node === null || typeof node !== 'object') continue;
		const typed = node as TreeNode;
		if (typed.type === targetType) {
			return typed;
		}
		if (typed.children) {
			const found = findHostNodeByType(typed.children, targetType);
			if (found) return found;
		}
	}
	return null;
}

describe('ScanScreen — scroll container regression guard (57-17/57-18)', () => {
	it('Test 1: renders a real RCTScrollView host node as its outermost scrollable', () => {
		const tr = renderScreen();
		const scrollNode = findHostNodeByType(tr.toJSON(), 'RCTScrollView');
		expect(scrollNode).not.toBeNull();
	});

	it('Test 2 (anti-vacuity): the walker returns null against a View-only synthetic tree', () => {
		const syntheticTree = {
			type: 'View',
			props: {},
			children: [
				{type: 'View', props: {}, children: null},
				{type: 'View', props: {}, children: [{type: 'View', props: {}, children: null}]},
			],
		};
		expect(findHostNodeByType(syntheticTree, 'RCTScrollView')).toBeNull();
	});
});
