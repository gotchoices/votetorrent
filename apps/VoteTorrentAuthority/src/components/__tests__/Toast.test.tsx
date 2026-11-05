/**
 * Toast: showToast renders one message bottom-centre, a second call replaces it, it clears itself
 * after the visible window, it never takes touches, and without a provider it is a no-op.
 */

import React from 'react';
import { Pressable, StyleSheet, Text } from 'react-native';
import renderer, { act } from 'react-test-renderer';
import { TOAST_VISIBLE_MS, ToastProvider, useToast } from '../Toast';

jest.mock('@react-navigation/native', () => ({
  useTheme: () => ({ dark: false, colors: { text: '#T', background: '#BG' } }),
}));

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));


function Trigger({ message }: { message: string }) {
  const showToast = useToast();
  return (
    <Pressable testID={`show-${message}`} onPress={() => showToast(message)}>
      <Text>{message}</Text>
    </Pressable>
  );
}

// Unmounted in afterEach so no provider (and no fade timer) outlives its test.
const mounted: renderer.ReactTestRenderer[] = [];

function render(withProvider = true) {
  const buttons = (
    <>
      <Trigger message="Copied" />
      <Trigger message="Copied again" />
    </>
  );
  let tr!: renderer.ReactTestRenderer;
  act(() => {
    tr = renderer.create(withProvider ? <ToastProvider>{buttons}</ToastProvider> : buttons);
  });
  mounted.push(tr);
  return tr;
}

function press(tr: renderer.ReactTestRenderer, id: string) {
  act(() => {
    tr.root.findByProps({ testID: id }).props.onPress();
  });
}

function toastNodes(tr: renderer.ReactTestRenderer) {
  return tr.root.findAll((n) => typeof n.type === 'string' && n.props.testID === 'toast-message');
}

function toastText(tr: renderer.ReactTestRenderer): string | null {
  const found = toastNodes(tr);
  return found.length > 0 ? String(found[0].props.children) : null;
}

beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  act(() => {
    for (const tr of mounted.splice(0)) tr.unmount();
  });
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
    const host = tr.root.findByProps({ testID: 'toast' }).parent!.parent!;
    const style = StyleSheet.flatten(host.props.style);
    expect(style.justifyContent).toBe('flex-end');
    expect(style.alignItems).toBe('center');
    expect(style.pointerEvents).toBe('none');
  });

  it('a second toast replaces the first', () => {
    const tr = render();
    press(tr, 'show-Copied');
    press(tr, 'show-Copied again');
    expect(toastNodes(tr)).toHaveLength(1);
    expect(toastText(tr)).toBe('Copied again');
  });

  it('clears itself after the visible window', () => {
    const tr = render();
    press(tr, 'show-Copied');
    act(() => {
      jest.advanceTimersByTime(TOAST_VISIBLE_MS - 1);
    });
    expect(toastText(tr)).toBe('Copied');
    act(() => {
      jest.advanceTimersByTime(1000);
    });
    expect(toastText(tr)).toBeNull();
  });

  it('is a no-op without a provider', () => {
    const tr = render(false);
    press(tr, 'show-Copied');
    expect(toastText(tr)).toBeNull();
  });
});
