/**
 * Behavioral tests for InlineError — VER-02 / Phase 24 validation gap.
 *
 * Pins two invariants:
 *   1. Returns null (renders nothing) when message is undefined or empty string.
 *   2. Renders the message text styled with colors.error when message is set.
 *
 * ThemedText uses useThemeColor which calls useTheme() from @react-navigation/native.
 * We mock useTheme here so the component tree resolves without a real navigation
 * provider (following the SyncChip / NetworksScreen test patterns in this codebase).
 */

import React from 'react';
import renderer from 'react-test-renderer';

// ---------------------------------------------------------------------------
// @react-navigation/native — provide a theme with colors.error so InlineError
// and its ThemedText sub-component can resolve the color without a real provider.
// ---------------------------------------------------------------------------
jest.mock('@react-navigation/native', () => ({
  useTheme: () => ({
    dark: false,
    colors: {
      primary: '#007AFF',
      background: '#FFFFFF',
      card: '#F2F2F7',
      text: '#000000',
      border: '#C6C6C8',
      notification: '#FF3B30',
      error: '#FF3B30',
      textSecondary: '#888888',
      important: '#FF9500',
    },
  }),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const InlineErrorModule = require('../../components/InlineError');
const InlineError = InlineErrorModule.InlineError ?? InlineErrorModule.default;

// ---------------------------------------------------------------------------
// Helper: render inside act() so React 19 flushes the tree synchronously.
// ---------------------------------------------------------------------------
function renderInlineError(props: { message?: string }): renderer.ReactTestRenderer {
  let tr!: renderer.ReactTestRenderer;
  renderer.act(() => {
    tr = renderer.create(<InlineError {...props} />);
  });
  return tr;
}

// ---------------------------------------------------------------------------
// InlineError — VER-02 behavioral assertions
// ---------------------------------------------------------------------------
describe('InlineError — VER-02 render contract', () => {
  it('renders nothing (null) when message is undefined', () => {
    const tr = renderInlineError({});
    // toJSON() returns null when the component returns null from render.
    expect(tr.toJSON()).toBeNull();
  });

  it('renders nothing (null) when message is an empty string', () => {
    const tr = renderInlineError({ message: '' });
    expect(tr.toJSON()).toBeNull();
  });

  it('renders the message text when message is a non-empty string', () => {
    const tr = renderInlineError({ message: 'Something went wrong' });
    const json = JSON.stringify(tr.toJSON());
    expect(json).toContain('Something went wrong');
  });

  it('applies colors.error style to the message text', () => {
    const tr = renderInlineError({ message: 'An error occurred' });
    // Walk the tree and verify a Text node carries the error color.
    const allNodes = tr.root.findAll((node) => node.type === 'Text');
    const errorNodes = allNodes.filter((node) => {
      const style = node.props.style;
      // Style may be an array or a single object — flatten and check.
      const styleArray = Array.isArray(style) ? style.flat(5) : [style];
      return styleArray.some(
        (s: unknown) =>
          s !== null &&
          typeof s === 'object' &&
          (s as Record<string, unknown>).color === '#FF3B30',
      );
    });
    expect(errorNodes.length).toBeGreaterThan(0);
  });
});
