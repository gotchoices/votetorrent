/**
 * Unit tests for PartyChipSelector (REG-03) — a hand-rolled 4-chip single-select row.
 * Presentational-only: `options`/`value`/`onChange` props in, no internal selection state.
 * Selection state lives entirely in the caller (RegistrationDraftProvider, D-03).
 */
import React from 'react';
import renderer from 'react-test-renderer';
import {Pressable} from 'react-native';
import {ThemeProvider} from '@react-navigation/native';
import {PartyChipSelector} from '../PartyChipSelector';
import {lightTheme} from '../../theme/themes';

function withTheme(children: React.ReactNode) {
	return <ThemeProvider value={lightTheme}>{children}</ThemeProvider>;
}

const OPTIONS = [
	{key: 'democratic', label: 'Democratic Party'},
	{key: 'republican', label: 'Republican Party'},
	{key: 'independent', label: 'Independent'},
	{key: 'other', label: 'Other'},
];

const activeRenderers: renderer.ReactTestRenderer[] = [];

function renderSelector(value: string, onChange: (label: string) => void = jest.fn()) {
	let tr!: renderer.ReactTestRenderer;
	renderer.act(() => {
		tr = renderer.create(withTheme(<PartyChipSelector options={OPTIONS} value={value} onChange={onChange} />));
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

describe('PartyChipSelector (REG-03)', () => {
	it('renders 4 tappable chips showing each option label', () => {
		const tr = renderSelector('');
		OPTIONS.forEach(option => {
			expect(tr.root.findByProps({testID: `party-chip-${option.key}`})).toBeTruthy();
			expect(tr.root.findByProps({children: option.label})).toBeTruthy();
		});
	});

	it('tapping a chip calls onChange with that chip label', () => {
		const onChange = jest.fn();
		const tr = renderSelector('', onChange);

		const republicanChip = tr.root.findByProps({testID: 'party-chip-republican'});
		renderer.act(() => {
			republicanChip.props.onPress();
		});

		expect(onChange).toHaveBeenCalledTimes(1);
		expect(onChange).toHaveBeenCalledWith('Republican Party');
	});

	it('marks exactly one chip selected when value matches a label', () => {
		const tr = renderSelector('Republican Party');

		const chips = tr.root.findAllByType(Pressable, {deep: false});
		const selected = chips.filter(chip => chip.props.testID?.startsWith('party-chip-') && chip.props.accessibilityState?.selected);
		expect(selected.length).toBe(1);
		expect(selected[0].props.testID).toBe('party-chip-republican');
	});

	it('with value \'\' no chip is selected', () => {
		const tr = renderSelector('');

		const chips = tr.root.findAllByType(Pressable, {deep: false});
		const selected = chips.filter(chip => chip.props.testID?.startsWith('party-chip-') && chip.props.accessibilityState?.selected);
		expect(selected.length).toBe(0);
	});
});
