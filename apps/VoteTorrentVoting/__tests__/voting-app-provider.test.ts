/**
 * Unit tests for VotingAppProvider / useVotingApp — SHELL-03 provider basis (D-01/D-03).
 *
 * Written as .ts (per plan, not .tsx) — React elements are built with React.createElement
 * rather than JSX syntax, since TypeScript disallows JSX syntax in .ts files.
 */

import React from 'react';
import renderer from 'react-test-renderer';
import {VotingAppProvider, useVotingApp} from '../src/providers/VotingAppProvider';
import {LIFECYCLE_ORDER} from '../src/providers/types';
import type {VotingAppContextType} from '../src/providers/types';

/** Flush the provider's isInitialized boot effect (setIsInitialized(true) in useEffect). */
async function flushBoot() {
	await renderer.act(async () => {
		await Promise.resolve();
	});
}

/**
 * Renders VotingAppProvider with a probe child that captures the current context value on
 * every render, so the test can read isInitialized/lifecycleState as they update.
 */
function renderProvider() {
	const captured: {value: VotingAppContextType | null} = {value: null};

	function Probe() {
		captured.value = useVotingApp();
		return null;
	}

	let tr!: renderer.ReactTestRenderer;
	renderer.act(() => {
		tr = renderer.create(
			React.createElement(VotingAppProvider, null, React.createElement(Probe)),
		);
	});
	return {tr, captured};
}

describe('VotingAppProvider / useVotingApp (SHELL-03, D-01)', () => {
	it('useVotingApp() throws the exact message when called outside a VotingAppProvider (D-01 mirror of useApp)', () => {
		function Orphan() {
			useVotingApp();
			return null;
		}
		expect(() => {
			renderer.act(() => {
				renderer.create(React.createElement(Orphan));
			});
		}).toThrow('useVotingApp must be used within a VotingAppProvider');
	});

	it('gates children behind isInitialized, which becomes true after boot (D-01 mirror of Authority AppProvider gate)', async () => {
		const {captured} = renderProvider();
		await flushBoot();
		expect(captured.value).not.toBeNull();
		expect(captured.value!.isInitialized).toBe(true);
	});

	it('LIFECYCLE_ORDER has length 7, starts at "Upcoming", ends at "Complete" (D-03)', () => {
		expect(LIFECYCLE_ORDER.length).toBe(7);
		expect(LIFECYCLE_ORDER[0]).toBe('Upcoming');
		expect(LIFECYCLE_ORDER[LIFECYCLE_ORDER.length - 1]).toBe('Complete');
	});

	it('setLifecycleState updates lifecycleState on the context (D-03 __DEV__ cycler driver)', async () => {
		const {captured} = renderProvider();
		await flushBoot();
		expect(captured.value!.lifecycleState).toBe('Upcoming');

		renderer.act(() => {
			captured.value!.setLifecycleState('Open');
		});
		expect(captured.value!.lifecycleState).toBe('Open');
	});

	it('getElection() returns a Promise resolving with the current lifecycleState (D-01 async read shape)', async () => {
		const {captured} = renderProvider();
		await flushBoot();

		const result = captured.value!.getElection();
		expect(result).toBeInstanceOf(Promise);
		const election = await result;
		expect(election.lifecycleState).toBe('Upcoming');
	});

	it('getElection() merges the per-state LIFECYCLE_CONTENT entry after setLifecycleState (HOME-02 regression guard, Phase 40)', async () => {
		const {captured} = renderProvider();
		await flushBoot();

		renderer.act(() => {
			captured.value!.setLifecycleState('ReleasingKeys');
		});
		const releasingKeys = await captured.value!.getElection();
		expect(releasingKeys.keysReleased).toBe(3);
		expect(releasingKeys.keysTotal).toBe(5);

		renderer.act(() => {
			captured.value!.setLifecycleState('ValidationDetails');
		});
		const validationDetails = await captured.value!.getElection();
		expect(validationDetails.evidence).toHaveLength(3);
	});
});
