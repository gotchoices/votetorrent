/**
 * Unit tests for CandidateSelector (VOTE-01/02, 42-RESEARCH Pattern 6) — a presentational
 * radio (voteFor=1) / capped-checkbox (voteFor>1) candidate list. Selected-state color must be
 * `colors.success` (#4caf50, "Voter's selection"), NOT `colors.primary` — that would silently
 * regress against PartyChipSelector's (correct, but different) selected-chip token.
 *
 * Presentational-only: `candidates`/`selectedIds`/`voteFor`/`onToggle` props in, no internal
 * selection state and no `useVoterApp()`/`useNavigation()` — constructs fixture candidates
 * directly, mirroring PartyChipSelector.test.tsx / ElectionCard.test.tsx's approach.
 */
import React from 'react';
import renderer from 'react-test-renderer';
import {Pressable} from 'react-native';
import {ThemeProvider} from '@react-navigation/native';
import FontAwesome6 from 'react-native-vector-icons/FontAwesome6';
import {CandidateSelector} from '../CandidateSelector';
import {lightTheme} from '../../theme/themes';

function withTheme(children: React.ReactNode) {
	return <ThemeProvider value={lightTheme}>{children}</ThemeProvider>;
}

const CANDIDATES = [
	{id: 'cand-1', name: 'Alice Adams', party: 'Democratic'},
	{id: 'cand-2', name: 'Bob Brown', party: 'Republican'},
	{id: 'cand-3', name: 'Carol Clark', party: 'Independent'},
];

const activeRenderers: renderer.ReactTestRenderer[] = [];

function renderSelector(
	selectedIds: string[],
	voteFor: number,
	onToggle: (candidateId: string) => void = jest.fn(),
) {
	let tr!: renderer.ReactTestRenderer;
	renderer.act(() => {
		tr = renderer.create(
			withTheme(
				<CandidateSelector candidates={CANDIDATES} selectedIds={selectedIds} voteFor={voteFor} onToggle={onToggle} />,
			),
		);
	});
	activeRenderers.push(tr);
	return tr;
}

afterEach(() => {
	while (activeRenderers.length) {
		const tr = activeRenderers.pop()!;
		renderer.act(() => {
			tr.unmount();
		});
	}
});

describe('CandidateSelector (VOTE-01/02)', () => {
	it('voteFor=1: rows use accessibilityRole "radio"; unselected shows "circle", selected shows "circle-check"', () => {
		const tr = renderSelector(['cand-2'], 1);

		const rows = CANDIDATES.map(c => tr.root.findByProps({testID: `candidate-row-${c.id}`}));
		rows.forEach(row => expect(row.props.accessibilityRole).toBe('radio'));

		const icons = tr.root.findAllByType(FontAwesome6);
		expect(icons[0].props.name).toBe('circle'); // cand-1 unselected
		expect(icons[1].props.name).toBe('circle-check'); // cand-2 selected
		expect(icons[2].props.name).toBe('circle'); // cand-3 unselected
	});

	it('voteFor>1: rows use accessibilityRole "checkbox"; unselected shows "square", selected shows "square-check"', () => {
		const tr = renderSelector(['cand-1'], 2);

		const rows = CANDIDATES.map(c => tr.root.findByProps({testID: `candidate-row-${c.id}`}));
		rows.forEach(row => expect(row.props.accessibilityRole).toBe('checkbox'));

		const icons = tr.root.findAllByType(FontAwesome6);
		expect(icons[0].props.name).toBe('square-check'); // cand-1 selected
		expect(icons[1].props.name).toBe('square'); // cand-2 unselected
		expect(icons[2].props.name).toBe('square'); // cand-3 unselected
	});

	it('a selected row uses colors.success for its icon color, NOT colors.primary', () => {
		const tr = renderSelector(['cand-2'], 1);

		const icons = tr.root.findAllByType(FontAwesome6);
		expect(icons[1].props.color).toBe(lightTheme.colors.success);
		expect(icons[1].props.color).not.toBe(lightTheme.colors.primary);
	});

	it('onToggle(candidateId) fires with the row id on press', () => {
		const onToggle = jest.fn();
		const tr = renderSelector([], 1, onToggle);

		const row = tr.root.findByProps({testID: 'candidate-row-cand-3'});
		renderer.act(() => {
			row.props.onPress();
		});

		expect(onToggle).toHaveBeenCalledTimes(1);
		expect(onToggle).toHaveBeenCalledWith('cand-3');
	});

	it('voteFor>1 at cap: unselected rows get a disabled-look (accessibilityState.disabled) but onToggle still fires on press', () => {
		const onToggle = jest.fn();
		// voteFor=2, 2 already selected -> at cap; cand-3 is unselected and should show disabledLook
		const tr = renderSelector(['cand-1', 'cand-2'], 2, onToggle);

		const unselectedRow = tr.root.findByProps({testID: 'candidate-row-cand-3'});
		expect(unselectedRow.props.accessibilityState).toEqual(expect.objectContaining({selected: false, disabled: true}));

		renderer.act(() => {
			unselectedRow.props.onPress();
		});
		expect(onToggle).toHaveBeenCalledTimes(1);
		expect(onToggle).toHaveBeenCalledWith('cand-3');
	});

	it('voteFor>1 below cap: unselected rows are NOT disabled-look', () => {
		const tr = renderSelector(['cand-1'], 2);

		const unselectedRow = tr.root.findByProps({testID: 'candidate-row-cand-2'});
		expect(unselectedRow.props.accessibilityState).toEqual(expect.objectContaining({selected: false, disabled: false}));
	});

	it('renders each candidate row as a Pressable', () => {
		const tr = renderSelector([], 1);
		const pressables = tr.root.findAllByType(Pressable, {deep: false});
		expect(pressables.length).toBe(CANDIDATES.length);
	});
});
