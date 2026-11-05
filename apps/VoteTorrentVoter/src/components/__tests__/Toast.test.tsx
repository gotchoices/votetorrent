/**
 * Toast: showToast renders one message bottom-centre, a second call replaces it, it clears itself
 * after the visible window, it never takes touches, and without a provider it is a no-op.
 */
import React from 'react';
import renderer from 'react-test-renderer';
import {Pressable, StyleSheet, Text} from 'react-native';
import {ThemeProvider} from '@react-navigation/native';
import {lightTheme} from '../../theme/themes';
import {TOAST_VISIBLE_MS, ToastProvider, useToast} from '../Toast';

function Trigger({message}: {message: string}) {
	const showToast = useToast();
	return (
		<Pressable testID={`show-${message}`} onPress={() => showToast(message)}>
			<Text>{message}</Text>
		</Pressable>
	);
}

function render(withProvider = true) {
	const buttons = (
		<>
			<Trigger message="Copied" />
			<Trigger message="Copied again" />
		</>
	);
	let tr!: renderer.ReactTestRenderer;
	renderer.act(() => {
		tr = renderer.create(
			<ThemeProvider value={lightTheme}>
				{withProvider ? <ToastProvider>{buttons}</ToastProvider> : buttons}
			</ThemeProvider>,
		);
	});
	return tr;
}

function press(tr: renderer.ReactTestRenderer, id: string) {
	renderer.act(() => {
		tr.root.findByProps({testID: id}).props.onPress();
	});
}

function toastText(tr: renderer.ReactTestRenderer): string | null {
	const found = tr.root.findAll(n => typeof n.type === 'string' && n.props.testID === 'toast-message');
	return found.length > 0 ? String(found[0]!.props.children) : null;
}

beforeEach(() => {
	jest.useFakeTimers();
});

afterEach(() => {
	jest.useRealTimers();
});

describe('Toast', () => {
	it('shows nothing until asked', () => {
		expect(toastText(render())).toBeNull();
	});

	it('shows the message, bottom-centre, without taking touches', () => {
		const tr = render();
		press(tr, 'show-Copied');
		expect(toastText(tr)).toBe('Copied');
		const host = tr.root.findByProps({testID: 'toast'}).parent!.parent!;
		const style = StyleSheet.flatten(host.props.style);
		expect(style.justifyContent).toBe('flex-end');
		expect(style.alignItems).toBe('center');
		expect(style.pointerEvents).toBe('none');
	});

	it('a second toast replaces the first', () => {
		const tr = render();
		press(tr, 'show-Copied');
		press(tr, 'show-Copied again');
		expect(tr.root.findAll(n => typeof n.type === 'string' && n.props.testID === 'toast-message')).toHaveLength(1);
		expect(toastText(tr)).toBe('Copied again');
	});

	it('clears itself after the visible window', () => {
		const tr = render();
		press(tr, 'show-Copied');
		renderer.act(() => {
			jest.advanceTimersByTime(TOAST_VISIBLE_MS - 1);
		});
		expect(toastText(tr)).toBe('Copied');
		renderer.act(() => {
			jest.advanceTimersByTime(1000);
		});
		expect(toastText(tr)).toBeNull();
	});

	it('puts a caller-supplied testID on the message', () => {
		const Probe = () => {
			const showToast = useToast();
			return (
				<Pressable testID="show-tagged" onPress={() => showToast('Copied', {testID: 'receipt-copied-0'})}>
					<Text>tagged</Text>
				</Pressable>
			);
		};
		let tagged!: renderer.ReactTestRenderer;
		renderer.act(() => {
			tagged = renderer.create(
				<ThemeProvider value={lightTheme}>
					<ToastProvider>
						<Probe />
					</ToastProvider>
				</ThemeProvider>,
			);
		});
		press(tagged, 'show-tagged');
		const found = tagged.root.findAll(n => typeof n.type === 'string' && n.props.testID === 'receipt-copied-0');
		expect(found.map(n => n.props.children)).toEqual(['Copied']);
		expect(toastText(tagged)).toBeNull();
	});

	it('is a no-op without a provider', () => {
		const tr = render(false);
		press(tr, 'show-Copied');
		expect(toastText(tr)).toBeNull();
	});
});
