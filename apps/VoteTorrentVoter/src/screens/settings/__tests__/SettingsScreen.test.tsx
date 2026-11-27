/**
 * Unit test for SettingsScreen (57-17/57-18 gap closure — UAT-10 scroll-container regression
 * guard). No rendered-tree test existed for this screen before this file (57-17-SUMMARY.md's own
 * "Not verified this session" note: its ScrollView conversion had been proven only by typecheck
 * and the full-suite green, never by a test that actually mounts the new root).
 *
 * Mounts inside VoterAppProvider + ThemeProvider (this screen calls useVoterApp()/useTheme()),
 * mirroring ScanScreen.test.tsx's / ValidationDetailsScreen.test.tsx's mounting pattern. Phase
 * 44-07 (D-02/D-04): `VoterAppProvider` is now a real composition root requiring a
 * `CadreNodeProvider` ancestor — this screen-level test has no need to exercise that boot, so it
 * uses the manual Jest mock at `providers/__mocks__/VoterAppProvider.tsx`.
 *
 * Asserts the RENDERED `RCTScrollView` host node (walking the react-test-renderer JSON tree) —
 * mirrors apps/VoteTorrentAuthority/src/screens/settings/SettingsScreen.scrollContainer.test.tsx,
 * the canonical model for this gap class — not source text, since a source grep would also pass
 * on an imported-but-unrendered ScrollView.
 */
import React from 'react';
import renderer from 'react-test-renderer';
import {Text} from 'react-native';
import {ThemeProvider} from '@react-navigation/native';
import '../../../i18n'; // initializes the global i18next instance useTranslation() reads from

jest.mock('../../../providers/VoterAppProvider');
// Spike 100: the screen's "Join a network" row navigates; there is no navigator in this mount.
const mockNavigate = jest.fn();
jest.mock('@react-navigation/native', () => ({
	...jest.requireActual('@react-navigation/native'),
	useNavigation: () => ({navigate: mockNavigate}),
}));
import {VoterAppProvider} from '../../../providers/VoterAppProvider';
import {lightTheme} from '../../../theme/themes';
import SettingsScreen from '../SettingsScreen';

function renderScreen() {
	let tr!: renderer.ReactTestRenderer;
	renderer.act(() => {
		tr = renderer.create(
			<ThemeProvider value={lightTheme}>
				<VoterAppProvider>
					<SettingsScreen />
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

describe('SettingsScreen — mounts and exposes the language toggle', () => {
	it('renders the language segment toggle', () => {
		const tr = renderScreen();
		const text = allText(tr);
		expect(text).toContain('English');
		expect(text).toContain('Español');
	});
});

describe('SettingsScreen — scroll container regression guard (57-17/57-18)', () => {
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

describe('SettingsScreen — Join a network row (spike 100)', () => {
	it('shows the row and opens the JoinNetwork route', () => {
		mockNavigate.mockClear();
		const tr = renderScreen();
		expect(allText(tr)).toContain('Join a network');
		const row = tr.root.find(node => node.props.testID === 'settings-join-network-row');
		renderer.act(() => {
			row.props.onPress();
		});
		expect(mockNavigate).toHaveBeenCalledWith('JoinNetwork');
	});
});
