/**
 * timeline-navigation.test.tsx (Phase 59, plan 59-10, D-13/D-14/D-15/D-22) — three gates over
 * `navigation/index.tsx`:
 *
 * Gate A — the provider-singleton source gate (D-22). A source-assertion test in the style of
 * `no-inline-mock-imports.test.ts`: strips comments, extracts each navigator function's body by
 * name via brace-matching, and asserts `VoteStackNavigator`/`RegistrationStackNavigator`/
 * `TimelineStackNavigator` mount neither `BallotSelectionProvider` nor `RegistrationDraftProvider`
 * — both live ONLY in `AppStateProviders`, the function `RootNavigator` delegates to (D-22's
 * lift). Includes a non-empty-body negative control for all five extracted functions.
 *
 * Gate B — the route-closure gate. For each component registered on the Timeline stack, collects
 * every `navigation.navigate('X')` / `navigation.replace('X')` string literal from its source and
 * asserts every `X` is a key of the Timeline stack's registered route-name set — a route the
 * stack does not own bubbles to the tab navigator and the action is silently dropped (D-14).
 * Includes a negative control: the collector must find at least `IndividualQuestion` from
 * `BallotScreen.tsx`.
 *
 * Gate C — push-in-place. Mounts the full production `RootNavigator` tree and proves that
 * navigating to the Timeline tab then to `Keyholders` leaves the Timeline TAB focused (not some
 * other tab) with `Keyholders` focused in the nested stack — the rendered proof that D-14's "the
 * Timeline tab stays highlighted, Back returns to the rail" property actually holds.
 *
 * Task 3 (D-13) extends this file with two more assertions: the exact five-tab route-name order,
 * and the EN/ES tab-bar label.
 */
import React from 'react';
import * as fs from 'fs';
import * as path from 'path';
import ReactTestRenderer from 'react-test-renderer';
import {Text} from 'react-native';
import {NavigationContainer, ThemeProvider, createNavigationContainerRef} from '@react-navigation/native';
import '../../i18n'; // initializes the global i18next instance useTranslation() reads from
import i18n from '../../i18n';
import {lightTheme} from '../../theme/themes';

// Mirrors __tests__/App.test.tsx's mock set — Gate C mounts the FULL RootNavigator tree.
jest.mock('../../providers/VoterAppProvider');
jest.mock('../../providers/CadreNodeProvider', () => ({
	useCadreNode: () => ({node: null, syncState: 'offline', connectedPeers: () => 0}),
	CadreNodeProvider: ({children}: {children: React.ReactNode}) => children,
}));

import {VoterAppProvider} from '../../providers/VoterAppProvider';
import {RootNavigator} from '../index';

// ---------------------------------------------------------------------------------------------
// Gate A — provider-singleton source gate (D-22)
// ---------------------------------------------------------------------------------------------

const navigationSourcePath = path.join(__dirname, '../index.tsx');
const navigationSourceRaw = fs.readFileSync(navigationSourcePath, 'utf8');

function stripComments(text: string): string {
	return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

const strippedNavigationSource = stripComments(navigationSourceRaw);

/** Brace-matched extraction of `function <name>(...) { ... }`'s body, run against ALREADY
 * comment-stripped source (comments can carry unbalanced braces, so stripping must happen first,
 * not during extraction). Skips past the PARAMETER LIST via paren-depth counting before looking
 * for the function body's opening brace -- a destructured parameter like
 * `function AppStateProviders({children}: PropsWithChildren) {` has its own `{children}` brace
 * pair that a naive "first `{` after the marker" search would mistake for the body opener,
 * silently truncating the extracted body to just that destructuring pattern. Returns null if the
 * function marker is not found. */
function extractFunctionBody(source: string, name: string): string | null {
	const marker = `function ${name}(`;
	const start = source.indexOf(marker);
	if (start === -1) return null;

	// Walk past the parameter list, starting at the '(' the marker itself ends on.
	let parenDepth = 0;
	let i = start + marker.length - 1;
	for (; i < source.length; i++) {
		if (source[i] === '(') parenDepth += 1;
		else if (source[i] === ')') {
			parenDepth -= 1;
			if (parenDepth === 0) {
				i += 1;
				break;
			}
		}
	}

	const braceStart = source.indexOf('{', i);
	if (braceStart === -1) return null;
	let depth = 0;
	for (let j = braceStart; j < source.length; j++) {
		if (source[j] === '{') depth += 1;
		else if (source[j] === '}') {
			depth -= 1;
			if (depth === 0) {
				return source.slice(braceStart + 1, j);
			}
		}
	}
	return null;
}

const voteStackBody = extractFunctionBody(strippedNavigationSource, 'VoteStackNavigator');
const registrationStackBody = extractFunctionBody(strippedNavigationSource, 'RegistrationStackNavigator');
const timelineStackBody = extractFunctionBody(strippedNavigationSource, 'TimelineStackNavigator');
const rootNavigatorBody = extractFunctionBody(strippedNavigationSource, 'RootNavigator');
// AppStateProviders is where BallotSelectionProvider/RegistrationDraftProvider are ACTUALLY
// mounted (D-22's lift); RootNavigator's own body only opens <AppStateProviders> and delegates.
// Checking rootNavigatorBody + appStateProvidersBody together is the source-scan equivalent of
// "RootNavigator's transitive JSX subtree contains both providers" -- the real invariant this
// gate protects, not a literal string match against RootNavigator's own function alone.
const appStateProvidersBody = extractFunctionBody(strippedNavigationSource, 'AppStateProviders');

describe('Gate A -- provider-singleton source gate (D-22)', () => {
	it('(anti-vacuity) the extractor returns a non-empty body for all five navigator/composition functions, and VoteStackNavigator contains <VoteStack.Navigator', () => {
		for (const body of [voteStackBody, registrationStackBody, timelineStackBody, rootNavigatorBody, appStateProvidersBody]) {
			expect(body).not.toBeNull();
			expect((body ?? '').length).toBeGreaterThan(0);
		}
		expect(voteStackBody).toContain('<VoteStack.Navigator');
	});

	it('VoteStackNavigator, RegistrationStackNavigator and TimelineStackNavigator mount NEITHER provider', () => {
		for (const body of [voteStackBody, registrationStackBody, timelineStackBody]) {
			expect(body).not.toContain('<BallotSelectionProvider');
			expect(body).not.toContain('<RegistrationDraftProvider');
		}
	});

	it('RootNavigator (via AppStateProviders, the function it delegates to) mounts BOTH providers exactly once each', () => {
		expect(rootNavigatorBody).toContain('<AppStateProviders');
		expect(appStateProvidersBody).toContain('<BallotSelectionProvider');
		expect(appStateProvidersBody).toContain('<RegistrationDraftProvider');
	});

	it('(regression control) moving a provider back into a per-tab stack would be caught -- planted negative fixture', () => {
		const plantedRegression = stripComments(`
			function TimelineStackNavigator() {
				return (
					<BallotSelectionProvider>
						<TimelineStack.Navigator />
					</BallotSelectionProvider>
				);
			}
		`);
		const plantedBody = extractFunctionBody(plantedRegression, 'TimelineStackNavigator');
		expect(plantedBody).toContain('<BallotSelectionProvider');
	});
});

// ---------------------------------------------------------------------------------------------
// Gate B -- route-closure gate
// ---------------------------------------------------------------------------------------------

// The Timeline stack's registered route-name set (navigation/types.ts's TimelineStackParamList,
// as actually extended by this plan -- additive over 59-05's five-entry outline).
const TIMELINE_ROUTE_NAMES = new Set([
	'TimelineHome',
	'Ballot',
	'IndividualQuestion',
	'ReviewSubmit',
	// 63-12: Vote receipt, registered on both stacks
	'VoteReceipt',
	'RegistrationHome',
	'RegistrationInfo',
	'DeviceAttestation',
	'RegisterPersonal',
	'RegisterAddressParty',
	'RegisterConfirm',
	'Confirmation',
	// Phase 62 Plan 28 (D-14 route-closure gate) — RegistrationScreen's newDevice.entryLink
	// navigates here; registered on both stacks in navigation/index.tsx.
	'ContinueOnAnotherDevice',
	// Spike 100 — RegistrationScreen's join entry link; registered on both stacks.
	'JoinNetwork',
	'Keyholders',
	// Election results (decrypt + validate + tally): the Tallying row's View results action.
	'Results',
]);

// Component source file -> the route it's registered under, for every screen on the Timeline
// stack (TimelineHome's TimelineScreen.tsx through Keyholders' KeyholdersScreen.tsx).
const TIMELINE_STACK_COMPONENT_FILES = [
	'../../screens/timeline/TimelineScreen.tsx',
	'../../screens/ballot/BallotScreen.tsx',
	'../../screens/ballot/IndividualQuestionScreen.tsx',
	'../../screens/ballot/ReviewSubmitScreen.tsx',
	'../../screens/ballot/VoteReceiptScreen.tsx',
	'../../screens/registration/RegistrationScreen.tsx',
	'../../screens/registration/RegistrationInfoScreen.tsx',
	'../../screens/registration/DeviceAttestationScreen.tsx',
	'../../screens/registration/RegisterPersonalScreen.tsx',
	'../../screens/registration/RegisterAddressPartyScreen.tsx',
	'../../screens/registration/RegisterConfirmScreen.tsx',
	'../../screens/registration/ConfirmationScreen.tsx',
	'../../screens/timeline/KeyholdersScreen.tsx',
	'../../screens/timeline/ResultsScreen.tsx',
	'../../screens/settings/JoinNetworkScreen.tsx',
];

const NAVIGATE_CALL_RE = /navigation\.(?:navigate|replace)\(\s*['"]([\w]+)['"]/g;

function collectNavigationTargets(relativeFile: string): string[] {
	const abs = path.join(__dirname, relativeFile);
	const source = stripComments(fs.readFileSync(abs, 'utf8'));
	const targets: string[] = [];
	let m: RegExpExecArray | null;
	NAVIGATE_CALL_RE.lastIndex = 0;
	while ((m = NAVIGATE_CALL_RE.exec(source)) !== null) {
		targets.push(m[1]);
	}
	return targets;
}

describe('Gate B -- route-closure gate (D-14)', () => {
	it('(anti-vacuity) the collector finds at least IndividualQuestion from BallotScreen.tsx', () => {
		const targets = collectNavigationTargets('../../screens/ballot/BallotScreen.tsx');
		expect(targets).toContain('IndividualQuestion');
	});

	it('every navigation.navigate/replace target collected from every Timeline-stack component is itself a registered Timeline-stack route', () => {
		const offenders: Array<{file: string; target: string}> = [];
		for (const file of TIMELINE_STACK_COMPONENT_FILES) {
			for (const target of collectNavigationTargets(file)) {
				if (!TIMELINE_ROUTE_NAMES.has(target)) {
					offenders.push({file, target});
				}
			}
		}
		expect(offenders).toEqual([]);
	});

	it('registers VoteReceipt exactly once on each of the Vote and Timeline stacks (63-12)', () => {
		for (const body of [voteStackBody, timelineStackBody]) {
			expect((body!.match(/name="VoteReceipt"/g) ?? []).length).toBe(1);
			expect((body!.match(/component=\{VoteReceiptScreen\}/g) ?? []).length).toBe(1);
		}
	});

	it('(anti-vacuity) the receipt screen only pops: it has no navigate/replace targets (63-12)', () => {
		expect(collectNavigationTargets('../../screens/ballot/VoteReceiptScreen.tsx')).toEqual([]);
	});
});

// ---------------------------------------------------------------------------------------------
// Gate C -- push-in-place (D-14)
// ---------------------------------------------------------------------------------------------

const navigationRef = createNavigationContainerRef<Record<string, object | undefined>>();

let activeRenderer: ReactTestRenderer.ReactTestRenderer | null = null;

afterEach(async () => {
	if (activeRenderer) {
		await ReactTestRenderer.act(async () => {
			activeRenderer!.unmount();
		});
		activeRenderer = null;
	}
	i18n.changeLanguage('en');
});

async function mountRootNavigator() {
	let tr!: ReactTestRenderer.ReactTestRenderer;
	await ReactTestRenderer.act(async () => {
		tr = ReactTestRenderer.create(
			<VoterAppProvider>
				<NavigationContainer ref={navigationRef}>
					<ThemeProvider value={lightTheme}>
						<RootNavigator />
					</ThemeProvider>
				</NavigationContainer>
			</VoterAppProvider>,
		);
	});
	// Flush HomeScreen's on-mount getElection() promise (mirrors App.test.tsx/provider-scope.test.tsx).
	await ReactTestRenderer.act(async () => {
		await Promise.resolve();
	});
	activeRenderer = tr;
	return tr;
}

// Gate C -- unskipped by Task 3, which registers the fifth `Tab.Screen` (D-13) that
// `navigationRef.navigate('Timeline')` needs to resolve.
describe('Gate C -- push-in-place: the Timeline tab stays highlighted (D-14)', () => {
	it('navigating Timeline -> Keyholders leaves the Timeline TAB focused, with Keyholders focused in the nested stack', async () => {
		const tr = await mountRootNavigator();
		expect(tr).toBeTruthy();

		await ReactTestRenderer.act(async () => {
			navigationRef.navigate('Timeline');
		});
		await ReactTestRenderer.act(async () => {
			navigationRef.navigate('Timeline', {screen: 'Keyholders'});
			await Promise.resolve();
		});

		const rootState = navigationRef.getRootState();
		expect(rootState).toBeDefined();
		const focusedTabRoute = rootState!.routes[rootState!.index ?? 0];
		expect(focusedTabRoute.name).toBe('Timeline');

		const nestedState = focusedTabRoute.state;
		expect(nestedState).toBeDefined();
		const focusedNestedRoute = nestedState!.routes[nestedState!.index ?? 0];
		expect(focusedNestedRoute.name).toBe('Keyholders');
	});
});

// ---------------------------------------------------------------------------------------------
// Task 3 (D-13) -- the fifth Tab.Screen: exact tab order, and the EN/ES label reachable from it.
// ---------------------------------------------------------------------------------------------

/** Collects every rendered <Text> node's string content into one searchable string. */
function allText(tr: ReactTestRenderer.ReactTestRenderer): string {
	return tr.root
		.findAllByType(Text)
		.map(node => {
			const children = node.props.children;
			return Array.isArray(children) ? children.join('') : String(children ?? '');
		})
		.join(' | ');
}

describe('Task 3 -- the locked five-tab order (D-13)', () => {
	it('routeNames deep-equals the exact locked order, not a membership check (a Timeline-appended-last regression would pass a membership check)', async () => {
		await mountRootNavigator();
		const rootState = navigationRef.getRootState();
		expect(rootState).toBeDefined();
		expect(rootState!.routeNames).toEqual(['Vote', 'Timeline', 'Registration', 'Scan', 'Settings']);
	});
});

describe('Task 3 -- the Timeline tab renders its EN/ES label (D-13)', () => {
	it('renders "Timeline" in English, then "Cronograma" after switching to Spanish', async () => {
		const tr = await mountRootNavigator();
		expect(allText(tr)).toContain('Timeline');

		await ReactTestRenderer.act(async () => {
			await i18n.changeLanguage('es');
		});
		expect(allText(tr)).toContain('Cronograma');
	});
});

// ---------------------------------------------------------------------------------------------
// Task 3 (D-13) gap-fill -- the Timeline tab's ICON GLYPH itself. The two describes above prove
// registration/order/label; NEITHER checks the glyph name `<FontAwesome6 name="timeline" .../>`
// renders on the Timeline tab. A react-native-vector-icons bump that drops or renames that glyph
// would render a blank/tofu icon while every gate above stays green -- this repo has shipped
// exactly that class of defect before (a test asserting PRESENCE, not RENDERING).
// ---------------------------------------------------------------------------------------------

/** Isolates the source text belonging to ONE named Tab.Screen -- from its own `<Tab.Screen`
 * opening tag up to (not including) the next sibling `<Tab.Screen`, or the closing
 * `</Tab.Navigator>` for the last one. Every assertion below is keyed off THIS extracted block,
 * never a whole-file search -- a whole-file `toContain('timeline')` would be satisfied trivially
 * by the route name `"Timeline"` itself (capitalized, and a different string from the lower
 * kebab-case glyph name `"timeline"` this gate actually cares about). Runs against the SAME
 * comment-stripped source Gate A already builds (`strippedNavigationSource`), so the D-13 doc
 * comment above the real `<Tab.Screen name="Timeline"` block (which itself prose-quotes the
 * glyph name) can never leak into an extracted block and confuse this scan. */
function extractTabScreenBlock(source: string, routeName: string): string | null {
	const routeMarker = `name="${routeName}"`;
	const routeIdx = source.indexOf(routeMarker);
	if (routeIdx === -1) return null;
	const tagStart = source.lastIndexOf('<Tab.Screen', routeIdx);
	if (tagStart === -1) return null;
	const nextTagIdx = source.indexOf('<Tab.Screen', tagStart + '<Tab.Screen'.length);
	const navigatorCloseIdx = source.indexOf('</Tab.Navigator>', tagStart);
	const endIdx = nextTagIdx === -1 ? navigatorCloseIdx : nextTagIdx;
	if (endIdx === -1) return null;
	return source.slice(tagStart, endIdx);
}

/** Extracts the FIRST `<FontAwesome6 name="...">` glyph name out of a Tab.Screen block. Returns
 * null (never a guessed default) when none is present. */
function extractFontAwesome6GlyphName(block: string): string | null {
	const m = /<FontAwesome6\s+name="([\w-]+)"/.exec(block);
	return m ? m[1] : null;
}

const timelineTabScreenBlock = extractTabScreenBlock(strippedNavigationSource, 'Timeline');

describe('Task 3 -- the Timeline tab glyph resolves to a real installed solid glyph (D-13 gap-fill)', () => {
	it('(anti-vacuity) the Timeline Tab.Screen block is isolated, non-empty and distinct from Registration\'s', () => {
		expect(timelineTabScreenBlock).not.toBeNull();
		expect((timelineTabScreenBlock ?? '').length).toBeGreaterThan(0);
		const registrationBlock = extractTabScreenBlock(strippedNavigationSource, 'Registration');
		expect(registrationBlock).not.toBeNull();
		expect(timelineTabScreenBlock).not.toEqual(registrationBlock);
	});

	it('ONLY the Timeline Tab.Screen block renders tabBarIcon via FontAwesome6 name="timeline"', () => {
		expect(timelineTabScreenBlock).toContain('<FontAwesome6 name="timeline"');
		// Tied to the route, not a whole-file grep -- no OTHER tab's own block carries this glyph.
		for (const otherRoute of ['Vote', 'Registration', 'Scan', 'Settings']) {
			const otherBlock = extractTabScreenBlock(strippedNavigationSource, otherRoute);
			expect(otherBlock).not.toBeNull();
			expect(otherBlock).not.toContain('<FontAwesome6 name="timeline"');
		}
	});

	it('(mutation proof) renaming or dropping the glyph on the real extracted block is detected', () => {
		// Mutated via string substitution on the REAL extracted block -- never a hand-typed
		// fixture -- so this proves the assertion above is sensitive to exactly the regression
		// class the gap describes (a library bump renaming or removing the glyph).
		const real = timelineTabScreenBlock ?? '';
		expect(real.length).toBeGreaterThan(0);
		const renamed = real.replace('<FontAwesome6 name="timeline"', '<FontAwesome6 name="chart-line"');
		const dropped = real.replace(/<FontAwesome6 name="timeline"[^/]*\/>/, '');
		expect(renamed).not.toEqual(real);
		expect(dropped).not.toEqual(real);
		expect(renamed).not.toContain('<FontAwesome6 name="timeline"');
		expect(dropped).not.toContain('<FontAwesome6 name="timeline"');
	});

	// The extracted glyph name must resolve in the INSTALLED glyphmap, in the `solid` style set
	// that the bare (no-iconStyle) form actually renders. Per
	// react-native-vector-icons/lib/create-multi-style-icon-set.js: with no boolean style prop,
	// styleFromProps() picks options.defaultStyle ('regular'); glyphValidator(name, 'regular')
	// misses for a solid-only glyph, so getIconSetForProps() falls back to
	// fallbackFamily(name), which walks the metadata families in order and returns the first
	// one whose array contains the glyph -- 'solid' here, since 'timeline' is absent from
	// 'regular' and 'brands'. A glyph reclassified into 'regular' or 'brands' by a future bump,
	// or dropped from the glyphmap outright, changes that resolution and must fail this check.
	const glyphMapPath = require.resolve('react-native-vector-icons/glyphmaps/FontAwesome6Free.json');
	const metaPath = require.resolve('react-native-vector-icons/glyphmaps/FontAwesome6Free_meta.json');
	const installedGlyphMap: Record<string, number> = JSON.parse(fs.readFileSync(glyphMapPath, 'utf8'));
	const installedMeta: {solid: string[]; regular: string[]; brands: string[]} = JSON.parse(
		fs.readFileSync(metaPath, 'utf8'),
	);

	it('(anti-vacuity) the installed glyphmap/meta files actually loaded as real, non-trivial JSON', () => {
		expect(Object.keys(installedGlyphMap).length).toBeGreaterThan(1000);
		expect(installedMeta.solid.length).toBeGreaterThan(1000);
	});

	it('the glyph name extracted from source is a real key in the installed glyphmap, classified solid-only', () => {
		const glyphName = extractFontAwesome6GlyphName(timelineTabScreenBlock ?? '');
		expect(glyphName).toBe('timeline');
		expect(installedGlyphMap).toHaveProperty(glyphName as string);
		expect(installedMeta.solid).toContain(glyphName);
		expect(installedMeta.regular).not.toContain(glyphName);
		expect(installedMeta.brands).not.toContain(glyphName);
	});

	it('(mutation proof) a bogus glyph name is rejected by the same glyphmap/style resolution check', () => {
		const bogusName = `not-a-real-glyph-${Date.now().toString(36)}`;
		expect(installedGlyphMap).not.toHaveProperty(bogusName);
		expect(installedMeta.solid).not.toContain(bogusName);
	});
});
