/**
 * Co-located renderer suite for ChipButton — the radius-vs-padding layout
 * gate plus the tap-target floor.
 *
 * Purpose: `paddingHorizontal` must clear `borderRadius` on both variants so
 * label glyphs never sit inside the corner curve, and the 32pt default chip
 * height must reach a >= 44 effective touch height via `hitSlop` without
 * changing the layout height itself (a deliberate app-wide visual constant
 * used at 40+ call sites).
 *
 * Uses react-test-renderer ONLY — no external component-testing-library
 * package is a dependency of this app. Mocks copied from
 * LifecycleConfirmCard.test.tsx.
 */

import React from 'react';
import { StyleSheet } from 'react-native';
import renderer from 'react-test-renderer';

jest.mock('react-native-vector-icons/FontAwesome6', () => 'FontAwesome6');

// Distinct sentinel values for every color token so a color assertion cannot
// pass by accidental equality.
const PALETTE = {
  text: '#T',
  textSecondary: '#TS',
  success: '#SU',
  warning: '#WA',
  error: '#ER',
  accent: '#AC',
  card: '#CA',
  background: '#BG',
  border: '#BO',
  dark: '#DA',
  light: '#LI',
  primary: '#PR',
  notification: '#NO',
};

jest.mock('@react-navigation/native', () => ({
  useTheme: () => ({
    dark: false,
    colors: PALETTE,
  }),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const ChipButtonModule = require('../ChipButton');
const ChipButton = ChipButtonModule.ChipButton;

function flattenStyle(node: renderer.ReactTestInstance): Record<string, unknown> {
  return StyleSheet.flatten(node.props.style) as Record<string, unknown>;
}

describe('ChipButton — radius-vs-padding layout gate', () => {
  it('1. default chip: paddingHorizontal clears borderRadius', () => {
    let tr!: renderer.ReactTestRenderer;
    renderer.act(() => {
      tr = renderer.create(<ChipButton label="Renew Registration" />);
    });

    const touchable = tr.root.findByType(require('react-native').TouchableOpacity);
    const flat = flattenStyle(touchable);

    expect(flat.paddingHorizontal as number).toBeGreaterThanOrEqual(flat.borderRadius as number);
  });

  it('2. fullWidth CTA: paddingHorizontal clears borderRadius, and the fullWidth override really applied', () => {
    let tr!: renderer.ReactTestRenderer;
    renderer.act(() => {
      tr = renderer.create(<ChipButton label="Create User" fullWidth />);
    });

    const touchable = tr.root.findByType(require('react-native').TouchableOpacity);
    const flat = flattenStyle(touchable);

    expect(flat.borderRadius).toBe(24);
    expect(flat.paddingHorizontal as number).toBeGreaterThanOrEqual(flat.borderRadius as number);
  });

  it('3. tap target does not shrink: heights unchanged, and default chip hitSlop yields >= 44 effective touch height', () => {
    let defaultTr!: renderer.ReactTestRenderer;
    renderer.act(() => {
      defaultTr = renderer.create(<ChipButton label="Renew Registration" />);
    });
    const defaultTouchable = defaultTr.root.findByType(require('react-native').TouchableOpacity);
    const defaultFlat = flattenStyle(defaultTouchable);
    expect(defaultFlat.height as number).toBeGreaterThanOrEqual(32);

    expect(defaultTouchable.props.hitSlop).toEqual(
      expect.objectContaining({
        top: expect.any(Number),
        bottom: expect.any(Number),
      }),
    );
    expect(defaultTouchable.props.hitSlop.top).toBeGreaterThanOrEqual(6);
    expect(defaultTouchable.props.hitSlop.bottom).toBeGreaterThanOrEqual(6);
    expect((defaultFlat.height as number) + defaultTouchable.props.hitSlop.top + defaultTouchable.props.hitSlop.bottom).toBeGreaterThanOrEqual(44);

    let fullWidthTr!: renderer.ReactTestRenderer;
    renderer.act(() => {
      fullWidthTr = renderer.create(<ChipButton label="Create User" fullWidth />);
    });
    const fullWidthTouchable = fullWidthTr.root.findByType(require('react-native').TouchableOpacity);
    const fullWidthFlat = flattenStyle(fullWidthTouchable);
    expect(fullWidthFlat.height as number).toBeGreaterThanOrEqual(48);
  });

  it('4. icon variant unaffected: the icon circle still declares borderRadius 12 with width/height 24', () => {
    let tr!: renderer.ReactTestRenderer;
    renderer.act(() => {
      tr = renderer.create(<ChipButton label="Suspend Registrant" icon="rotate" />);
    });

    const iconCircle = tr.root.findAll((node) => {
      if (node.type !== require('react-native').View) return false;
      const flat = StyleSheet.flatten(node.props.style) as Record<string, unknown> | undefined;
      return !!flat && flat.borderRadius === 12;
    });

    expect(iconCircle.length).toBeGreaterThan(0);
    const flat = StyleSheet.flatten(iconCircle[0].props.style) as Record<string, unknown>;
    expect(flat.width).toBe(24);
    expect(flat.height).toBe(24);
    expect(flat.borderRadius).toBe(12);
  });
});
