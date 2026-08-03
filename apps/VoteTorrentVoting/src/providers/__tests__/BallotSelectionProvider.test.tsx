/**
 * Unit tests for BallotSelectionProvider / useBallotSelection (Phase 42, VOTE-02, D-01).
 *
 * Mirrors __tests__/voting-app-provider.test.ts's Probe-capture convention. Written as .tsx
 * (JSX is fine here, unlike voting-app-provider.test.ts which is .ts).
 */

import React from 'react';
import renderer from 'react-test-renderer';
import { BallotSelectionProvider, useBallotSelection } from '../BallotSelectionProvider';
import type { BallotSelectionContextType } from '../BallotSelectionProvider';
import type { Office } from '../types';

const OFFICES: Office[] = [
	{
		id: 'office-1',
		titleKey: 'ballot.office1',
		jurisdiction: 'Federal',
		voteFor: 3,
		candidates: [
			{ id: 'cand-a', nameKey: 'a', partyKey: 'democratic' },
			{ id: 'cand-b', nameKey: 'b', partyKey: 'republican' },
			{ id: 'cand-c', nameKey: 'c', partyKey: 'independent' },
			{ id: 'cand-d', nameKey: 'd', partyKey: 'nonpartisan' },
		],
	},
	{
		id: 'office-2',
		titleKey: 'ballot.office2',
		jurisdiction: 'State',
		voteFor: 1,
		candidates: [
			{ id: 'cand-x', nameKey: 'x', partyKey: 'democratic' },
			{ id: 'cand-y', nameKey: 'y', partyKey: 'republican' },
		],
	},
];

/**
 * Renders BallotSelectionProvider with a probe child that captures the current context value
 * on every render, so the test can read selectionMap/currentQuestionIndex as they update.
 */
function renderProvider() {
	const captured: { value: BallotSelectionContextType | null } = { value: null };

	function Probe() {
		captured.value = useBallotSelection();
		return null;
	}

	let tr!: renderer.ReactTestRenderer;
	renderer.act(() => {
		tr = renderer.create(
			<BallotSelectionProvider>
				<Probe />
			</BallotSelectionProvider>,
		);
	});
	return { tr, captured };
}

describe('BallotSelectionProvider / useBallotSelection (VOTE-02, D-01)', () => {
	it('useBallotSelection() throws the exact message when called outside a BallotSelectionProvider', () => {
		function Orphan() {
			useBallotSelection();
			return null;
		}
		expect(() => {
			renderer.act(() => {
				renderer.create(<Orphan />);
			});
		}).toThrow('useBallotSelection must be used within a BallotSelectionProvider');
	});

	it('defaults to an empty selectionMap and currentQuestionIndex 0', () => {
		const { captured } = renderProvider();
		expect(captured.value!.selectionMap).toEqual({});
		expect(captured.value!.currentQuestionIndex).toBe(0);
	});

	it('does not evict an existing selection when tapping a 4th candidate on a voteFor=3 office (Pitfall 4)', () => {
		const { captured } = renderProvider();

		renderer.act(() => {
			captured.value!.toggleCandidate('office-1', 'cand-a', 3);
			captured.value!.toggleCandidate('office-1', 'cand-b', 3);
			captured.value!.toggleCandidate('office-1', 'cand-c', 3);
		});
		expect(captured.value!.selectionMap['office-1']).toEqual(['cand-a', 'cand-b', 'cand-c']);

		renderer.act(() => {
			captured.value!.toggleCandidate('office-1', 'cand-d', 3); // 4th tap, at cap
		});
		// Must be BYTE-IDENTICAL to before — a replace-oldest bug would show ['cand-b','cand-c','cand-d']
		expect(captured.value!.selectionMap['office-1']).toEqual(['cand-a', 'cand-b', 'cand-c']);
	});

	it('removes a candidate from a capped selection when it is tapped again (voteFor>1 toggle-off)', () => {
		const { captured } = renderProvider();

		renderer.act(() => {
			captured.value!.toggleCandidate('office-1', 'cand-a', 3);
			captured.value!.toggleCandidate('office-1', 'cand-b', 3);
		});
		expect(captured.value!.selectionMap['office-1']).toEqual(['cand-a', 'cand-b']);

		renderer.act(() => {
			captured.value!.toggleCandidate('office-1', 'cand-a', 3); // toggle cand-a off
		});
		expect(captured.value!.selectionMap['office-1']).toEqual(['cand-b']);
	});

	it('radio deselect: re-tapping the selected voteFor=1 candidate clears the selection (Pitfall 3)', () => {
		const { captured } = renderProvider();

		renderer.act(() => {
			captured.value!.toggleCandidate('office-2', 'cand-x', 1);
		});
		expect(captured.value!.selectionMap['office-2']).toEqual(['cand-x']);

		renderer.act(() => {
			captured.value!.toggleCandidate('office-2', 'cand-x', 1); // re-tap same candidate
		});
		expect(captured.value!.selectionMap['office-2']).toEqual([]);
	});

	it('radio replaces the selection when a different voteFor=1 candidate is tapped', () => {
		const { captured } = renderProvider();

		renderer.act(() => {
			captured.value!.toggleCandidate('office-2', 'cand-x', 1);
		});
		expect(captured.value!.selectionMap['office-2']).toEqual(['cand-x']);

		renderer.act(() => {
			captured.value!.toggleCandidate('office-2', 'cand-y', 1);
		});
		expect(captured.value!.selectionMap['office-2']).toEqual(['cand-y']);
	});

	it('goToNextQuestion advances currentQuestionIndex, clamped at offices.length - 1', () => {
		const { captured } = renderProvider();

		renderer.act(() => {
			captured.value!.goToNextQuestion(OFFICES);
		});
		expect(captured.value!.currentQuestionIndex).toBe(1);

		renderer.act(() => {
			captured.value!.goToNextQuestion(OFFICES); // already at last index (1 of 2 offices)
		});
		expect(captured.value!.currentQuestionIndex).toBe(1); // clamped, no overrun
	});

	it('goToPreviousQuestion() at index 0 leaves index 0 (clamp, no wrap-around, D-06)', () => {
		const { captured } = renderProvider();
		expect(captured.value!.currentQuestionIndex).toBe(0);

		renderer.act(() => {
			captured.value!.goToPreviousQuestion();
		});
		expect(captured.value!.currentQuestionIndex).toBe(0); // unchanged, not -1
	});

	it('setCurrentQuestionIndex sets the index directly (Ballot Page opening a specific office)', () => {
		const { captured } = renderProvider();

		renderer.act(() => {
			captured.value!.setCurrentQuestionIndex(1);
		});
		expect(captured.value!.currentQuestionIndex).toBe(1);
	});
});
