/**
 * Unit tests for computeCompletedCount (Phase 42, VOTE-01, D-04).
 */

import { computeCompletedCount } from '../BallotSelectionProvider';
import type { Office } from '../types';

// Mixed-voteFor fixture: one voteFor=1 office, one voteFor=3 office (Pitfall 5 regression).
const MIXED_OFFICES: Office[] = [
	{
		id: 'office-1',
		ballotId: 'b-1',
		questionCode: 'office-1',
		required: true,
		hasDependsOn: false,
		title: 'Office 1',
		group: 'Federal',
		voteFor: 1,
		candidates: [
			{ id: 'cand-a', optionCode: 'a', name: 'a', party: 'democratic' },
			{ id: 'cand-b', optionCode: 'b', name: 'b', party: 'republican' },
		],
	},
	{
		id: 'office-2',
		ballotId: 'b-1',
		questionCode: 'office-2',
		required: true,
		hasDependsOn: false,
		title: 'Office 2',
		group: 'State',
		voteFor: 3,
		candidates: [
			{ id: 'cand-x', optionCode: 'x', name: 'x', party: 'democratic' },
			{ id: 'cand-y', optionCode: 'y', name: 'y', party: 'republican' },
			{ id: 'cand-z', optionCode: 'z', name: 'z', party: 'independent' },
		],
	},
];

describe('computeCompletedCount (VOTE-01, D-04)', () => {
	it('returns completed=0, total=offices.length on an empty selectionMap', () => {
		const result = computeCompletedCount(MIXED_OFFICES, {});
		expect(result).toEqual({ completed: 0, total: 2 });
	});

	it('total is offices.length (2) on a mixed-voteFor fixture (voteFor=1 and voteFor=3), never voteFor-weighted (Pitfall 5)', () => {
		const result = computeCompletedCount(MIXED_OFFICES, {
			'office-1': ['cand-a'],
			'office-2': ['cand-x'],
		});
		expect(result.total).toBe(2);
	});

	it('an office with any selection counts as complete, regardless of its voteFor (D-04 — full N not required)', () => {
		const result = computeCompletedCount(MIXED_OFFICES, {
			'office-2': ['cand-x'], // voteFor=3, but only 1 of 3 selected
		});
		expect(result.completed).toBe(1);
		expect(result.total).toBe(2);
	});

	it('total does NOT change when the voteFor=3 office gains more selections (completeness is binary per office, Pitfall 5)', () => {
		const oneSelected = computeCompletedCount(MIXED_OFFICES, { 'office-2': ['cand-x'] });
		const allSelected = computeCompletedCount(MIXED_OFFICES, {
			'office-2': ['cand-x', 'cand-y', 'cand-z'],
		});
		expect(oneSelected.total).toBe(2);
		expect(allSelected.total).toBe(2);
		// Both read as "1 completed" — going from 1/3 to 3/3 selections on the same office does
		// not change its completed status (already complete at >=1).
		expect(oneSelected.completed).toBe(1);
		expect(allSelected.completed).toBe(1);
	});

	it('both offices complete yields completed=2, total=2', () => {
		const result = computeCompletedCount(MIXED_OFFICES, {
			'office-1': ['cand-a'],
			'office-2': ['cand-x', 'cand-y'],
		});
		expect(result).toEqual({ completed: 2, total: 2 });
	});
});
