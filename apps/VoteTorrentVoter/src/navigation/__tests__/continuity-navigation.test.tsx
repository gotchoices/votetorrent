/**
 * continuity-navigation.test.tsx — Phase 62 Plan 28 (D-40/D-41/D-43/D-45). Mounts the real
 * production `RootNavigator` tree (mirrors `timeline-navigation.test.tsx`'s Gate C recipe):
 *   - Route closure: `ContinueOnAnotherDevice` is reachable from BOTH the Registration and the
 *     Timeline stacks, leaving the originating tab focused.
 *   - D-41: `useDeviceRetired()` replaces the whole tab navigator with `DeviceRetiredNotice` when
 *     `resolveDeviceRetired` resolves true, re-checks on an AppState 'active' transition, and
 *     fails open (renders the normal tab navigator) against the unmodified manual
 *     `VoterAppProvider` mock (`getEngine` throws) using the REAL `resolveDeviceRetired`.
 */
import React from 'react';
import {AppState, Pressable, Text} from 'react-native';
import ReactTestRenderer from 'react-test-renderer';
import {NavigationContainer, ThemeProvider, createNavigationContainerRef} from '@react-navigation/native';
import '../../i18n'; // initializes the global i18next instance useTranslation() reads from
import {lightTheme} from '../../theme/themes';

jest.mock('../../providers/VoterAppProvider');
jest.mock('../../providers/CadreNodeProvider', () => ({
	useCadreNode: () => ({node: null, syncState: 'offline', connectedPeers: () => 0}),
	CadreNodeProvider: ({children}: {children: React.ReactNode}) => children,
}));

jest.mock('../../engines/continuity', () => {
	const actual = jest.requireActual('../../engines/continuity');
	return {
		...actual,
		resolveDeviceRetired: jest.fn(actual.resolveDeviceRetired),
	};
});

import {VoterAppProvider} from '../../providers/VoterAppProvider';
import {resolveDeviceRetired} from '../../engines/continuity';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const actualResolveDeviceRetired = jest.requireActual('../../engines/continuity').resolveDeviceRetired;
import {RootNavigator} from '../index';

const mockResolveDeviceRetired = resolveDeviceRetired as jest.Mock;

const navigationRef = createNavigationContainerRef<Record<string, object | undefined>>();

let activeRenderer: ReactTestRenderer.ReactTestRenderer | null = null;

beforeEach(() => {
	mockResolveDeviceRetired.mockReset();
	mockResolveDeviceRetired.mockImplementation(actualResolveDeviceRetired);
});

afterEach(async () => {
	if (activeRenderer) {
		await ReactTestRenderer.act(async () => {
			activeRenderer!.unmount();
		});
		activeRenderer = null;
	}
	jest.restoreAllMocks();
});

async function mountRootNavigator(
	ref: ReturnType<typeof createNavigationContainerRef<Record<string, object | undefined>>> = navigationRef,
) {
	let tr!: ReactTestRenderer.ReactTestRenderer;
	await ReactTestRenderer.act(async () => {
		tr = ReactTestRenderer.create(
			<VoterAppProvider>
				<NavigationContainer ref={ref}>
					<ThemeProvider value={lightTheme}>
						<RootNavigator />
					</ThemeProvider>
				</NavigationContainer>
			</VoterAppProvider>,
		);
	});
	await ReactTestRenderer.act(async () => {
		await Promise.resolve();
	});
	activeRenderer = tr;
	return tr;
}

function allText(tr: ReactTestRenderer.ReactTestRenderer): string {
	return tr.root
		.findAllByType(Text)
		.map(node => {
			const children = node.props.children;
			return Array.isArray(children) ? children.join('') : String(children ?? '');
		})
		.join(' | ');
}

describe('Navigator: route closure (D-40/D-43/D-45)', () => {
	it('navigating Registration -> ContinueOnAnotherDevice focuses that route inside the Registration tab', async () => {
		await mountRootNavigator();

		await ReactTestRenderer.act(async () => {
			navigationRef.navigate('Registration');
		});
		await ReactTestRenderer.act(async () => {
			navigationRef.navigate('Registration', {screen: 'ContinueOnAnotherDevice'});
			await Promise.resolve();
		});

		const rootState = navigationRef.getRootState();
		expect(rootState).toBeDefined();
		const focusedTabRoute = rootState!.routes[rootState!.index ?? 0];
		expect(focusedTabRoute.name).toBe('Registration');

		const nestedState = focusedTabRoute.state;
		expect(nestedState).toBeDefined();
		const focusedNestedRoute = nestedState!.routes[nestedState!.index ?? 0];
		expect(focusedNestedRoute.name).toBe('ContinueOnAnotherDevice');
	});

	it('navigating Timeline -> ContinueOnAnotherDevice focuses that route inside the Timeline tab', async () => {
		await mountRootNavigator();

		await ReactTestRenderer.act(async () => {
			navigationRef.navigate('Timeline');
		});
		await ReactTestRenderer.act(async () => {
			navigationRef.navigate('Timeline', {screen: 'ContinueOnAnotherDevice'});
			await Promise.resolve();
		});

		const rootState = navigationRef.getRootState();
		expect(rootState).toBeDefined();
		const focusedTabRoute = rootState!.routes[rootState!.index ?? 0];
		expect(focusedTabRoute.name).toBe('Timeline');

		const nestedState = focusedTabRoute.state;
		expect(nestedState).toBeDefined();
		const focusedNestedRoute = nestedState!.routes[nestedState!.index ?? 0];
		expect(focusedNestedRoute.name).toBe('ContinueOnAnotherDevice');
	});
});

describe('Navigator: retired (D-41)', () => {
	// Each test here mounts its OWN NavigationContainer ref (never the shared `navigationRef` the
	// route-closure tests above use): a mid-test retired-notice swap unmounts the Tab.Navigator
	// underneath a container that stays mounted, and reusing one ref across sequential mounts of
	// that shape left a stray effect that surfaced as an unrelated AggregateError in a LATER test
	// — isolating the ref per test removes the cross-test coupling entirely.
	it('resolveDeviceRetired() true replaces the tab navigator with the retired notice, with zero Pressables', async () => {
		mockResolveDeviceRetired.mockResolvedValue(true);
		const tr = await mountRootNavigator(createNavigationContainerRef());
		await ReactTestRenderer.act(async () => {
			await Promise.resolve();
		});

		expect(allText(tr)).toContain('This device has been retired');
		expect(tr.root.findAllByType(Pressable)).toHaveLength(0);
	});

	it('resolveDeviceRetired() false renders the normal tab navigator', async () => {
		mockResolveDeviceRetired.mockResolvedValue(false);
		const tr = await mountRootNavigator(createNavigationContainerRef());
		await ReactTestRenderer.act(async () => {
			await Promise.resolve();
		});

		expect(allText(tr)).not.toContain('This device has been retired');
	});

	it('resolving false at mount, then true after an AppState "active" transition, swaps the tree to the notice', async () => {
		let callCount = 0;
		mockResolveDeviceRetired.mockImplementation(async () => {
			callCount += 1;
			return callCount > 1;
		});
		const appStateListeners: Array<(state: string) => void> = [];
		// Spy installed before mount, restored only via the top-level afterEach's
		// jest.restoreAllMocks() — mirrors the established, working convention in
		// useAccessTrailVisit.test.tsx (a mid-test .mockRestore() here produced a spurious
		// cross-test AggregateError surfacing in the NEXT test, attributable to React Navigation's
		// own effect teardown timing against a spied global, not a product defect).
		jest.spyOn(AppState, 'addEventListener').mockImplementation(((event: string, cb: (state: string) => void) => {
			if (event === 'change') appStateListeners.push(cb);
			return {remove: jest.fn()};
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
		}) as any);

		const tr = await mountRootNavigator(createNavigationContainerRef());
		await ReactTestRenderer.act(async () => {
			await Promise.resolve();
		});
		expect(allText(tr)).not.toContain('This device has been retired');

		await ReactTestRenderer.act(async () => {
			appStateListeners.forEach(cb => cb('active'));
			await Promise.resolve();
		});
		expect(allText(tr)).toContain('This device has been retired');
	});

	it('fail-open: the REAL resolveDeviceRetired against the unmodified getEngine-throws manual mock renders the normal tab navigator', async () => {
		mockResolveDeviceRetired.mockImplementation(actualResolveDeviceRetired);
		const tr = await mountRootNavigator(createNavigationContainerRef());
		await ReactTestRenderer.act(async () => {
			await Promise.resolve();
		});

		expect(allText(tr)).not.toContain('This device has been retired');
	});
});
