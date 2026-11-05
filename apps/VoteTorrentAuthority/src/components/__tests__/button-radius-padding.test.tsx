/**
 * button-radius-padding.test.tsx — cross-primitive radius-vs-padding layout
 * gate for every button primitive in `src/components/`.
 *
 * Purpose: `260805-hfi` fixed this class of defect on `ChipButton` only;
 * `CustomButton` re-broke the identical symptom app-wide (RENEW/SUSPEND/
 * REVOKE on RegistrantDetailScreen) because nothing forced a NEW button
 * primitive to be checked against the same invariant. This suite is a
 * REGISTRY plus a table-driven invariant so registering a future primitive
 * is one line, and a coverage guard (test 3) fails the suite outright if a
 * `*Button.tsx` file exists that is not in the registry.
 *
 * Uses react-test-renderer ONLY. Mock header copied verbatim from
 * ChipButton.test.tsx.
 */

import React from 'react';
import * as fs from 'fs';
import * as path from 'path';
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
const { ChipButton } = require('../ChipButton');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { CustomButton } = require('../CustomButton');

const NOOP = () => {};

function flattenStyle(node: renderer.ReactTestInstance): Record<string, unknown> {
  return StyleSheet.flatten(node.props.style) as Record<string, unknown>;
}

// REGISTRY: one entry per file in src/components matching *Button.tsx. Each
// entry is a list of [variantName, element] pairs covering every visually
// distinct padding/radius variant that primitive renders.
const REGISTRY: Record<string, Array<[string, React.ReactElement]>> = {
  'ChipButton.tsx': [
    ['default', <ChipButton label="Renew Registration" />],
    ['fullWidth', <ChipButton label="Create User" fullWidth />],
  ],
  'CustomButton.tsx': [
    ['tall', <CustomButton title="Suspend Registrant" onPress={NOOP} />],
    ['thin', <CustomButton title="Suspend Registrant" size="thin" onPress={NOOP} />],
  ],
};

describe('button-radius-padding — cross-primitive layout gate', () => {
  const cases: Array<[string, string, React.ReactElement]> = [];
  for (const [file, variants] of Object.entries(REGISTRY)) {
    for (const [variant, element] of variants) {
      cases.push([file, variant, element]);
    }
  }

  test.each(cases)(
    '1. %s (%s): paddingHorizontal clears borderRadius, both are numbers',
    (_file, _variant, element) => {
      let tr!: renderer.ReactTestRenderer;
      renderer.act(() => {
        tr = renderer.create(element);
      });
      const touchable = tr.root.findByType(require('react-native').TouchableOpacity);
      const flat = flattenStyle(touchable);

      // An `undefined >= undefined` comparison must not silently pass.
      expect(typeof flat.paddingHorizontal).toBe('number');
      expect(typeof flat.borderRadius).toBe('number');
      expect(flat.paddingHorizontal as number).toBeGreaterThanOrEqual(flat.borderRadius as number);
    },
  );

  test('2. flatten order really resolved the variant (not the same measurement twice)', () => {
    let tallTr!: renderer.ReactTestRenderer;
    renderer.act(() => {
      tallTr = renderer.create(<CustomButton title="Suspend Registrant" onPress={NOOP} />);
    });
    const tallTouchable = tallTr.root.findByType(require('react-native').TouchableOpacity);
    const tallFlat = flattenStyle(tallTouchable);

    let thinTr!: renderer.ReactTestRenderer;
    renderer.act(() => {
      thinTr = renderer.create(<CustomButton title="Suspend Registrant" size="thin" onPress={NOOP} />);
    });
    const thinTouchable = thinTr.root.findByType(require('react-native').TouchableOpacity);
    const thinFlat = flattenStyle(thinTouchable);

    expect(thinFlat.borderRadius).not.toBe(tallFlat.borderRadius);

    let fullWidthTr!: renderer.ReactTestRenderer;
    renderer.act(() => {
      fullWidthTr = renderer.create(<ChipButton label="Create User" fullWidth />);
    });
    const fullWidthTouchable = fullWidthTr.root.findByType(require('react-native').TouchableOpacity);
    const fullWidthFlat = flattenStyle(fullWidthTouchable);
    expect(fullWidthFlat.borderRadius).toBe(24);
  });

  // COVERAGE GUARD: a third button primitive added to src/components later
  // fails this suite until someone registers it above in REGISTRY and it
  // satisfies test 1's invariant. This is the actual deliverable of this
  // task — not the two fixes, but the guarantee this class of defect cannot
  // be missed a third time.
  test('3. COVERAGE GUARD — every *Button.tsx file in src/components is registered', () => {
    const componentsDir = path.join(__dirname, '..');
    const buttonFiles = fs
      .readdirSync(componentsDir)
      .filter((f) => /Button\.tsx$/.test(f))
      .sort();

    expect(buttonFiles).toEqual(Object.keys(REGISTRY).sort());
  });

  test('4. no tap target shrank: CustomButton paddingVertical unchanged, thin hitSlop reaches >= 44 effective touch height', () => {
    let tallTr!: renderer.ReactTestRenderer;
    renderer.act(() => {
      tallTr = renderer.create(<CustomButton title="Suspend Registrant" onPress={NOOP} />);
    });
    const tallTouchable = tallTr.root.findByType(require('react-native').TouchableOpacity);
    const tallFlat = flattenStyle(tallTouchable);
    expect(tallFlat.paddingVertical).toBe(16);

    let thinTr!: renderer.ReactTestRenderer;
    renderer.act(() => {
      thinTr = renderer.create(<CustomButton title="Suspend Registrant" size="thin" onPress={NOOP} />);
    });
    const thinTouchable = thinTr.root.findByType(require('react-native').TouchableOpacity);
    const thinFlat = flattenStyle(thinTouchable);
    expect(thinFlat.paddingVertical).toBe(6);

    expect(thinTouchable.props.hitSlop).toEqual(
      expect.objectContaining({
        top: expect.any(Number),
        bottom: expect.any(Number),
      }),
    );
    expect(thinTouchable.props.hitSlop.top).toBeGreaterThanOrEqual(6);
    expect(thinTouchable.props.hitSlop.bottom).toBeGreaterThanOrEqual(6);
    // 6 (paddingVertical top) + 6 (paddingVertical bottom) + 24 (minHeight) = 36pt box.
    const boxHeight = (thinFlat.paddingVertical as number) * 2 + 24;
    expect(
      boxHeight + thinTouchable.props.hitSlop.top + thinTouchable.props.hitSlop.bottom,
    ).toBeGreaterThanOrEqual(44);
  });
});
