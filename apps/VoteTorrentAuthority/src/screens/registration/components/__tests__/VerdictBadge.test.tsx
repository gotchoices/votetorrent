/**
 * Co-located test for VerdictBadge — pins D-03 (three visually distinct
 * pass/fail/none states off an explicit undefined-first discriminant), the
 * fail-only tap-to-expand reason block, and T-47-03 (no control-shaped
 * affordance in any state — a verdict is a record, not a control).
 *
 * Uses react-test-renderer ONLY — no external component-testing-library
 * package is a dependency of this app. Scaffold copied from
 * `AttestationPolicySection.test.tsx` (the primary test analog).
 *
 * The identity `t` mock (react-i18next) means every assertion targets the
 * i18n KEY string, so this test does not depend on 47-02's copy values.
 */

import React from 'react';
import renderer from 'react-test-renderer';

jest.mock('react-native-vector-icons/FontAwesome6', () => 'FontAwesome6');

jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

// Distinct sentinel values for every color token so a color assertion cannot
// pass by accidental equality (e.g. two tokens sharing the same hex).
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
const VerdictBadgeModule = require('../VerdictBadge');
const VerdictBadge = VerdictBadgeModule.VerdictBadge;
const { resolveVerdictState } = VerdictBadgeModule;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function press(tr: renderer.ReactTestRenderer, testID: string) {
  const wrapper = tr.root.findByProps({ testID });
  // VerdictBadge's pressable (TouchableOpacity) WRAPS the testID'd pill
  // rather than containing it, so the onPress handler may sit on an
  // ancestor rather than a descendant — walk both directions.
  const ancestors: renderer.ReactTestInstance[] = [];
  let up: renderer.ReactTestInstance | null = wrapper.parent;
  while (up) {
    ancestors.push(up);
    up = up.parent;
  }
  const pressable = [wrapper, ...wrapper.findAll(() => true), ...ancestors].find(
    (node) => typeof node.props.onPress === 'function',
  );
  renderer.act(() => {
    pressable!.props.onPress();
  });
}

function treeText(tr: renderer.ReactTestRenderer): string {
  return JSON.stringify(tr.toJSON());
}

function glyphs(tr: renderer.ReactTestRenderer): Array<{ name: unknown; color: unknown }> {
  return tr.root
    .findAllByType('FontAwesome6' as never)
    .map((n) => ({ name: n.props.name, color: n.props.color }));
}

function pillBackground(tr: renderer.ReactTestRenderer, testID: string): unknown {
  const node = tr.root.findByProps({ testID });
  const style = Array.isArray(node.props.style) ? node.props.style.flat(5) : [node.props.style];
  const withBg = style.find(
    (s: unknown) => s !== null && typeof s === 'object' && 'backgroundColor' in (s as Record<string, unknown>),
  ) as Record<string, unknown> | undefined;
  return withBg?.backgroundColor;
}

function renderBadge(overrides: {
  verdict?: 'pass' | 'fail' | undefined;
  reason?: string;
  verifiedAt?: string;
  testIDPrefix?: string;
} = {}) {
  let tr!: renderer.ReactTestRenderer;
  renderer.act(() => {
    tr = renderer.create(
      <VerdictBadge
        verdict={overrides.verdict}
        reason={overrides.reason}
        verifiedAt={overrides.verifiedAt}
        testIDPrefix={overrides.testIDPrefix ?? 'verdict-badge'}
      />,
    );
  });
  return tr;
}

describe('VerdictBadge — D-03/T-47-03', () => {
  it('pass renders the pass state with success glyph/color and correct tint', () => {
    const tr = renderBadge({ verdict: 'pass' });

    expect(() => tr.root.findByProps({ testID: 'verdict-badge-pass' })).not.toThrow();
    expect(() => tr.root.findByProps({ testID: 'verdict-badge-fail' })).toThrow();
    expect(() => tr.root.findByProps({ testID: 'verdict-badge-none' })).toThrow();

    const g = glyphs(tr);
    expect(g).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'circle-check', color: PALETTE.success })]),
    );
    expect(pillBackground(tr, 'verdict-badge-pass')).toBe(PALETTE.success + '22');
    expect(treeText(tr)).toContain('attestationVerdictPass');
  });

  it('fail renders the fail state with error glyph/color and correct tint', () => {
    const tr = renderBadge({ verdict: 'fail' });

    expect(() => tr.root.findByProps({ testID: 'verdict-badge-fail' })).not.toThrow();
    expect(() => tr.root.findByProps({ testID: 'verdict-badge-pass' })).toThrow();
    expect(() => tr.root.findByProps({ testID: 'verdict-badge-none' })).toThrow();

    const g = glyphs(tr);
    expect(g).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'circle-xmark', color: PALETTE.error })]),
    );
    expect(pillBackground(tr, 'verdict-badge-fail')).toBe(PALETTE.error + '22');
    expect(treeText(tr)).toContain('attestationVerdictFail');
  });

  it('undefined verdict renders the none state — the inversion guard', () => {
    const tr = renderBadge({ verdict: undefined });

    expect(() => tr.root.findByProps({ testID: 'verdict-badge-none' })).not.toThrow();
    expect(() => tr.root.findByProps({ testID: 'verdict-badge-fail' })).toThrow();
    expect(() => tr.root.findByProps({ testID: 'verdict-badge-pass' })).toThrow();

    const g = glyphs(tr);
    expect(g).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'circle-question', color: PALETTE.textSecondary })]),
    );
    expect(treeText(tr)).toContain('attestationVerdictNone');
  });

  it('resolveVerdictState unit table: undefined/pass/fail map to none/pass/fail', () => {
    expect(resolveVerdictState(undefined)).toBe('none');
    expect(resolveVerdictState('pass')).toBe('pass');
    expect(resolveVerdictState('fail')).toBe('fail');
  });

  it('fail + reason: reason block absent before press, present after, and shows the reason + label', () => {
    const tr = renderBadge({ verdict: 'fail', reason: 'Play Integrity denied: DEVICE_INTEGRITY' });

    expect(() => tr.root.findByProps({ testID: 'verdict-badge-reason' })).toThrow();

    press(tr, 'verdict-badge-fail');

    expect(() => tr.root.findByProps({ testID: 'verdict-badge-reason' })).not.toThrow();
    expect(treeText(tr)).toContain('Play Integrity denied: DEVICE_INTEGRITY');
    expect(treeText(tr)).toContain('attestationVerdictReasonLabel');
  });

  it('pass and none states with a reason supplied render no onPress anywhere and no reason node', () => {
    for (const verdict of ['pass', undefined] as const) {
      const tr = renderBadge({ verdict, reason: 'irrelevant reason text' });

      const withOnPress = tr.root.findAll((node) => typeof node.props.onPress === 'function');
      expect(withOnPress).toHaveLength(0);

      expect(() => tr.root.findByProps({ testID: 'verdict-badge-reason' })).toThrow();
    }
  });

  it('fail with an undefined or whitespace-only reason renders no onPress and no reason node', () => {
    for (const reason of [undefined, '   '] as const) {
      const tr = renderBadge({ verdict: 'fail', reason });

      const withOnPress = tr.root.findAll((node) => typeof node.props.onPress === 'function');
      expect(withOnPress).toHaveLength(0);

      expect(() => tr.root.findByProps({ testID: 'verdict-badge-reason' })).toThrow();
    }
  });

  it('verifiedAt renders verbatim inside the expanded block and is absent when not supplied', () => {
    const withVerifiedAt = renderBadge({
      verdict: 'fail',
      reason: 'diagnostic text',
      verifiedAt: '2026-08-01T00:00:00Z',
    });
    press(withVerifiedAt, 'verdict-badge-fail');
    expect(treeText(withVerifiedAt)).toContain('2026-08-01T00:00:00Z');
    expect(treeText(withVerifiedAt)).toContain('attestationVerdictVerifiedAtLabel');

    const withoutVerifiedAt = renderBadge({ verdict: 'fail', reason: 'diagnostic text' });
    press(withoutVerifiedAt, 'verdict-badge-fail');
    expect(treeText(withoutVerifiedAt)).not.toContain('2026-08-01T00:00:00Z');
  });

  it('T-47-03 negative space: no control-shaped affordance in any state, even with a reason present', () => {
    for (const verdict of ['pass', 'fail', undefined] as const) {
      const tr = renderBadge({ verdict, reason: 'some diagnostic reason' });

      const customButtons = tr.root.findAll(
        (node) => typeof node.type === 'function' && (node.type as { name?: string }).name === 'CustomButton',
      );
      const chipButtons = tr.root.findAll(
        (node) => typeof node.type === 'function' && (node.type as { name?: string }).name === 'ChipButton',
      );
      expect(customButtons).toHaveLength(0);
      expect(chipButtons).toHaveLength(0);

      const text = treeText(tr);
      expect(text).not.toMatch(/re-?verify/i);
      expect(text).not.toMatch(/retry/i);
      expect(text).not.toMatch(/override/i);
      expect(text).not.toMatch(/clear/i);
    }
  });

  it('tint precondition: every referenced palette token is a 6-hex literal in both light and dark themes', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const themes = require('../../../../theme/themes');
    const HEX6 = /^#[0-9a-fA-F]{6}$/;
    const tokens = ['success', 'error', 'textSecondary', 'accent', 'border', 'card', 'text'] as const;

    for (const token of tokens) {
      expect(themes.lightTheme.colors[token]).toMatch(HEX6);
      expect(themes.darkTheme.colors[token]).toMatch(HEX6);
    }
  });
});
