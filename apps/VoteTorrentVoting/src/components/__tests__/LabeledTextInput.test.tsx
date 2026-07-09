/**
 * Unit tests for LabeledTextInput (REG-03, D-02 mock-permissive) — a pure presentational
 * label + write-through TextInput wrapper. No internal state buffer: the rendered TextInput's
 * `value` prop mirrors the caller's `value` prop directly, and `onChangeText` fires straight
 * through to the caller with no local echo.
 */
import React from 'react';
import renderer from 'react-test-renderer';
import {TextInput} from 'react-native';
import {ThemeProvider} from '@react-navigation/native';
import {LabeledTextInput} from '../LabeledTextInput';
import {lightTheme} from '../../theme/themes';

/** useTheme() requires a ThemeProvider ancestor (@react-navigation/native) — wrap every render. */
function withTheme(children: React.ReactNode) {
	return <ThemeProvider value={lightTheme}>{children}</ThemeProvider>;
}

const activeRenderers: renderer.ReactTestRenderer[] = [];

function renderInput(children: React.ReactNode) {
	let tr!: renderer.ReactTestRenderer;
	renderer.act(() => {
		tr = renderer.create(withTheme(children));
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

describe('LabeledTextInput (REG-03)', () => {
	it('renders the label text and the TextInput bound to the given value', () => {
		const tr = renderInput(<LabeledTextInput label="First Name" value="Jane" onChangeText={jest.fn()} />);

		expect(tr.root.findByProps({children: 'First Name'})).toBeTruthy();
		const input = tr.root.findByType(TextInput);
		expect(input.props.value).toBe('Jane');
	});

	it('firing onChangeText calls the passed callback once with the typed value, write-through with no internal buffer', () => {
		const onChangeText = jest.fn();
		const tr = renderInput(<LabeledTextInput label="First Name" value="Jane" onChangeText={onChangeText} />);

		const input = tr.root.findByType(TextInput);
		renderer.act(() => {
			input.props.onChangeText('Janet');
		});

		expect(onChangeText).toHaveBeenCalledTimes(1);
		expect(onChangeText).toHaveBeenCalledWith('Janet');
	});

	it('carries testID through to the TextInput so screens can target fields', () => {
		const tr = renderInput(
			<LabeledTextInput label="First Name" value="" onChangeText={jest.fn()} testID="register-first-name" />,
		);

		const input = tr.root.findByType(TextInput);
		expect(input.props.testID).toBe('register-first-name');
	});
});
