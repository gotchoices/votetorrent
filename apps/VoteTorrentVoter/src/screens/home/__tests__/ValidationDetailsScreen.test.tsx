/**
 * Unit test for ValidationDetailsScreen (HOME-03/D-11) — trust-story drill-in faithful to Figma
 * frame `276:868`. Mounts inside VoterAppProvider + ThemeProvider (this screen calls
 * useVoterApp()/getElection() and useTheme(), unlike the pure presentational components) and
 * drives lifecycleOverride to 'ValidationDetails' (the only DEV_LIFECYCLE_CONTENT entry carrying an
 * `evidence` array — providers/devLifecycleFixtures.ts) before asserting the rendered evidence.
 */
import React from 'react';
import renderer from 'react-test-renderer';
import {Text} from 'react-native';
import {ThemeProvider} from '@react-navigation/native';
import '../../../i18n'; // initializes the global i18next instance useTranslation() reads from
// Phase 44-07 (D-02/D-04): VoterAppProvider is now a real composition root requiring a
// CadreNodeProvider ancestor — this screen-level test has no need to exercise that boot, so it
// uses the manual Jest mock at providers/__mocks__/VoterAppProvider.tsx (its lifecycleOverride/
// setLifecycleOverride are real, stateful mock context — this Harness's setLifecycleOverride call
// still drives the rendered evidence).
jest.mock('../../../providers/VoterAppProvider');
import {VoterAppProvider, useVoterApp} from '../../../providers/VoterAppProvider';
import {lightTheme} from '../../../theme/themes';
import ValidationDetailsScreen from '../ValidationDetailsScreen';

/** Drives lifecycleOverride to 'ValidationDetails' on mount, then renders the screen under test. */
function Harness() {
	const {setLifecycleOverride} = useVoterApp();
	React.useEffect(() => {
		setLifecycleOverride('ValidationDetails');
	}, [setLifecycleOverride]);
	return <ValidationDetailsScreen />;
}

function renderScreen() {
	let tr!: renderer.ReactTestRenderer;
	renderer.act(() => {
		tr = renderer.create(
			<ThemeProvider value={lightTheme}>
				<VoterAppProvider>
					<Harness />
				</VoterAppProvider>
			</ThemeProvider>,
		);
	});
	return tr;
}

/** Flush the provider's isInitialized boot effect, the Harness's setLifecycleOverride effect, and
 * the screen's getElection() fetch-on-mount — several microtask ticks deep, so flush repeatedly. */
async function flush(tr: renderer.ReactTestRenderer, ticks = 4) {
	for (let i = 0; i < ticks; i++) {
		await renderer.act(async () => {
			await Promise.resolve();
		});
	}
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

/**
 * 57-17/57-18 scroll-container gap closure (mirrors
 * apps/VoteTorrentAuthority/src/screens/settings/SettingsScreen.scrollContainer.test.tsx — the
 * canonical model). Walks the RENDERED react-test-renderer JSON tree for a host node whose
 * `type` is `RCTScrollView`, rather than a source-level grep. This screen's pre-fetch/no-evidence
 * early return is a plain (non-scrolling) `View` by design (57-17-SUMMARY.md: no children, nothing
 * can overflow it) — only the LOADED-content branch (asserted below, reached once `getElection()`
 * resolves with evidence) is the reachable path this gap concerns.
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

describe('ValidationDetailsScreen (HOME-03/D-11, frame 276:868)', () => {
	it('renders 3 per-check rows, the N/3 verified count, the fingerprint, and the blockchain line', async () => {
		const tr = renderScreen();
		await flush(tr);

		const text = allText(tr);

		// Overall count (VALIDATION_EVIDENCE: 2 of 3 checks verified — providers/devLifecycleFixtures.ts).
		expect(text).toContain('2/3 checks verified');

		// 3 per-check rows (name + result), verbatim frame 276:868 / 52:290 copy.
		expect(text).toContain('Search for voter record');
		expect(text).toContain('Voter record found');
		expect(text).toContain('Verify voter record');
		expect(text).toContain('IDs match');
		expect(text).toContain('Check election integrity');
		expect(text).toContain('Adjacent blocks and tree path verified');

		// Verified/pending flags (2 verified, 1 pending per VALIDATION_EVIDENCE).
		expect(text).toContain('Verified');
		expect(text).toContain('Pending');

		// Fingerprint block.
		expect(text).toContain('Fingerprint');
		expect(text).toContain('Birddog133');

		// Blockchain-record line.
		expect(text).toContain('Validation report recorded in blockchain');
	});

	it('has no action button (terminal drill-in, D-05)', async () => {
		const tr = renderScreen();
		await flush(tr);

		const text = allText(tr);
		expect(text).not.toMatch(/vote now/i);
		expect(text).not.toMatch(/view validation details/i);
	});

	describe('scroll container regression guard (57-17/57-18)', () => {
		it('Test 1: the loaded-content branch renders a real RCTScrollView host node', async () => {
			const tr = renderScreen();
			await flush(tr);

			// Precondition — confirm the loaded (not pre-fetch) branch actually rendered.
			expect(allText(tr)).toContain('2/3 checks verified');

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
});
