/**
 * Co-located renderer suite for LifecycleConfirmCard — the D-10 safeguard
 * proof. Every assertion here is proven by EXECUTION, not by inspection:
 * the typed gate cannot be opened by a prefix, a superstring, an empty
 * name, or a direct programmatic press; a dismissed confirmation invokes
 * `onConfirm` zero times whether or not the gate was satisfied; a submitted
 * confirmation cannot fire twice; a rejected one can be retried; and the
 * three color configurations match the UI-SPEC matrix exactly.
 *
 * Uses react-test-renderer ONLY — no external component-testing-library
 * package is a dependency of this app. Scaffold copied from
 * `AttestationPolicySection.test.tsx`.
 *
 * This suite asserts on i18n KEY-shaped literal strings passed as props
 * (the owning screen resolves copy, not this component), so it is
 * independent of 47-02's copy values.
 */

import React from 'react';
import { StyleSheet } from 'react-native';
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

jest.mock('../../../../providers/SettingsProvider', () => ({
  useSettings: () => ({ showHelpIcons: false }),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const LifecycleConfirmCardModule = require('../LifecycleConfirmCard');
const LifecycleConfirmCard = LifecycleConfirmCardModule.LifecycleConfirmCard;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Find the wrapper/control by testID, then invoke the first descendant onPress. */
function press(tr: renderer.ReactTestRenderer, testID: string) {
  const wrapper = tr.root.findByProps({ testID });
  const pressable = [wrapper, ...wrapper.findAll(() => true)].find(
    (node) => typeof node.props.onPress === 'function',
  );
  renderer.act(() => {
    pressable!.props.onPress();
  });
}

function findPressable(tr: renderer.ReactTestRenderer, testID: string) {
  const wrapper = tr.root.findByProps({ testID });
  return [wrapper, ...wrapper.findAll(() => true)].find((node) => typeof node.props.onPress === 'function');
}

function isDisabled(tr: renderer.ReactTestRenderer, testID: string): boolean {
  const wrapper = tr.root.findByProps({ testID });
  const disabledNode = [wrapper, ...wrapper.findAll(() => true)].find((node) => 'disabled' in node.props);
  return disabledNode?.props.disabled === true;
}

function type(tr: renderer.ReactTestRenderer, prefix: string, text: string) {
  const input = tr.root.findByProps({ testID: `${prefix}-typed-input` });
  renderer.act(() => {
    input.props.onChangeText(text);
  });
}

async function flush(tr: renderer.ReactTestRenderer) {
  await renderer.act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function treeText(tr: renderer.ReactTestRenderer): string {
  return JSON.stringify(tr.toJSON());
}

function styleValue(tr: renderer.ReactTestRenderer, testID: string, key: string): unknown {
  const node = tr.root.findByProps({ testID });
  const style = Array.isArray(node.props.style) ? node.props.style.flat(5) : [node.props.style];
  const withKey = style.find(
    (s: unknown) => s !== null && typeof s === 'object' && key in (s as Record<string, unknown>),
  ) as Record<string, unknown> | undefined;
  return withKey?.[key];
}

/**
 * The CLICKABLE element's margin: read from CustomButton's real styles (via the rendered
 * touchable inside the slot), so changing CustomButton.marginVertical breaks the pin below.
 */
function buttonVerticalMargin(tr: renderer.ReactTestRenderer, slotTestID: string): number {
  const slot = tr.root.findByProps({ testID: slotTestID });
  const touchable = slot.findAll(
    (n) => n.props.accessibilityRole === 'button' && n.props.style !== undefined,
  )[0];
  const flat = StyleSheet.flatten(touchable.props.style) as { marginVertical?: number };
  return flat.marginVertical ?? 0;
}

function buttonBackground(tr: renderer.ReactTestRenderer, wrapperTestID: string): unknown {
  const wrapper = tr.root.findByProps({ testID: wrapperTestID });
  const withBg = [wrapper, ...wrapper.findAll(() => true)].find(
    (node) => 'backgroundColor' in node.props,
  );
  return withBg?.props.backgroundColor;
}

const PREFIX = 'lifecycle-confirm';

function renderCard(overrides: Record<string, unknown> = {}) {
  const onConfirm = (overrides.onConfirm as jest.Mock) ?? jest.fn().mockResolvedValue(undefined);
  const onDismiss = (overrides.onDismiss as jest.Mock) ?? jest.fn();

  const props = {
    variant: 'typed',
    matchText: 'Jane Doe',
    title: 'lifecycleTitleKey',
    body: 'lifecycleBodyKey',
    confirmLabel: 'lifecycleConfirmKey',
    dismissLabel: 'lifecycleKeepKey',
    typedPlaceholder: 'lifecycleTypedPlaceholderKey',
    onConfirm,
    onDismiss,
    testIDPrefix: PREFIX,
    ...overrides,
  };

  let tr!: renderer.ReactTestRenderer;
  renderer.act(() => {
    tr = renderer.create(<LifecycleConfirmCard {...props} />);
  });
  return { tr, onConfirm, onDismiss };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('LifecycleConfirmCard — D-10', () => {
  it('1. typed variant starts locked; card/title/body/dismiss/typed-input all render', () => {
    const { tr } = renderCard();

    expect(isDisabled(tr, `${PREFIX}-confirm`)).toBe(true);
    expect(() => tr.root.findByProps({ testID: `${PREFIX}-card` })).not.toThrow();
    expect(() => tr.root.findByProps({ testID: `${PREFIX}-title` })).not.toThrow();
    expect(() => tr.root.findByProps({ testID: `${PREFIX}-body` })).not.toThrow();
    expect(() => tr.root.findByProps({ testID: `${PREFIX}-dismiss` })).not.toThrow();
    expect(() => tr.root.findByProps({ testID: `${PREFIX}-typed-input` })).not.toThrow();
  });

  it('2. the gate opens only on a full case-insensitive-trim match, and re-closes on a mismatch', () => {
    const { tr } = renderCard();

    type(tr, PREFIX, 'Jane');
    expect(isDisabled(tr, `${PREFIX}-confirm`)).toBe(true);

    type(tr, PREFIX, 'Jane Do');
    expect(isDisabled(tr, `${PREFIX}-confirm`)).toBe(true);

    type(tr, PREFIX, '  jane doe  ');
    expect(isDisabled(tr, `${PREFIX}-confirm`)).toBe(false);

    type(tr, PREFIX, 'Jane Doex');
    expect(isDisabled(tr, `${PREFIX}-confirm`)).toBe(true);
  });

  it('3. a locked confirm fires nothing even when invoked programmatically', () => {
    const { tr, onConfirm } = renderCard();

    expect(isDisabled(tr, `${PREFIX}-confirm`)).toBe(true);
    const pressable = findPressable(tr, `${PREFIX}-confirm`);
    renderer.act(() => {
      pressable!.props.onPress();
    });

    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('4. ZERO engine calls on dismiss (D-10), including when the gate was already satisfied', () => {
    const fresh = renderCard();
    press(fresh.tr, `${PREFIX}-dismiss`);
    expect(fresh.onDismiss).toHaveBeenCalledTimes(1);
    expect(fresh.onConfirm).not.toHaveBeenCalled();

    const satisfied = renderCard();
    type(satisfied.tr, PREFIX, 'Jane Doe');
    expect(isDisabled(satisfied.tr, `${PREFIX}-confirm`)).toBe(false);
    press(satisfied.tr, `${PREFIX}-dismiss`);
    expect(satisfied.onDismiss).toHaveBeenCalledTimes(1);
    expect(satisfied.onConfirm).not.toHaveBeenCalled();
  });

  it('5. matched confirm fires exactly once with no argument', async () => {
    const { tr, onConfirm, onDismiss } = renderCard();
    type(tr, PREFIX, 'Jane Doe');

    press(tr, `${PREFIX}-confirm`);
    await flush(tr);

    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onConfirm).toHaveBeenCalledWith();
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it('6. single-submit latch: a resolved confirm cannot fire a second write, and dismiss disables', async () => {
    const { tr, onConfirm } = renderCard();
    type(tr, PREFIX, 'Jane Doe');
    press(tr, `${PREFIX}-confirm`);
    await flush(tr);

    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(isDisabled(tr, `${PREFIX}-confirm`)).toBe(true);
    expect(isDisabled(tr, `${PREFIX}-dismiss`)).toBe(true);

    const pressable = findPressable(tr, `${PREFIX}-confirm`);
    renderer.act(() => {
      pressable!.props.onPress();
    });
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('7. in-flight guard: three rapid presses (same closure, one render frame) fire exactly one call; dismiss disabled while in flight', () => {
    const onConfirm = jest.fn().mockReturnValue(new Promise(() => {}));
    const { tr } = renderCard({ onConfirm });
    type(tr, PREFIX, 'Jane Doe');

    // Capture ONE pressable reference before any press, then invoke it three
    // times inside a single `act()` — this is the scenario the internal
    // `submitState !== "idle"` re-check protects against: a rapid multi-tap
    // captured by the SAME closure before React has a chance to re-render
    // and hand back a fresh (canConfirm=false) closure.
    const pressable = findPressable(tr, `${PREFIX}-confirm`);
    renderer.act(() => {
      pressable!.props.onPress();
      pressable!.props.onPress();
      pressable!.props.onPress();
    });

    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(isDisabled(tr, `${PREFIX}-dismiss`)).toBe(true);
  });

  it('8. retry after failure: a rejected confirm re-enables both controls and can be retried', async () => {
    const onConfirm = jest.fn().mockRejectedValueOnce(new Error('write failed')).mockResolvedValue(undefined);
    const { tr } = renderCard({ onConfirm });
    type(tr, PREFIX, 'Jane Doe');

    press(tr, `${PREFIX}-confirm`);
    await flush(tr);

    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(isDisabled(tr, `${PREFIX}-confirm`)).toBe(false);
    expect(isDisabled(tr, `${PREFIX}-dismiss`)).toBe(false);

    press(tr, `${PREFIX}-confirm`);
    await flush(tr);

    expect(onConfirm).toHaveBeenCalledTimes(2);
  });

  it('9. ordinary/neutral variant: confirm enabled, no typed input, border colors.border, both buttons colors.accent', () => {
    const { tr } = renderCard({
      variant: 'ordinary',
      matchText: undefined,
      typedPlaceholder: undefined,
    });

    expect(isDisabled(tr, `${PREFIX}-confirm`)).toBe(false);
    expect(() => tr.root.findByProps({ testID: `${PREFIX}-typed-input` })).toThrow();
    expect(styleValue(tr, `${PREFIX}-card`, 'borderLeftColor')).toBe(PALETTE.border);
    expect(styleValue(tr, `${PREFIX}-card`, 'borderLeftWidth')).toBe(4);
    expect(buttonBackground(tr, `${PREFIX}-confirm`)).toBe(PALETTE.accent);
    expect(buttonBackground(tr, `${PREFIX}-dismiss`)).toBe(PALETTE.accent);
  });

  it('10. ordinary/destructive variant: border + confirm background colors.error, dismiss colors.accent, no typed input', () => {
    const { tr } = renderCard({
      variant: 'ordinary',
      tone: 'destructive',
      matchText: undefined,
      typedPlaceholder: undefined,
    });

    expect(() => tr.root.findByProps({ testID: `${PREFIX}-typed-input` })).toThrow();
    expect(styleValue(tr, `${PREFIX}-card`, 'borderLeftColor')).toBe(PALETTE.error);
    expect(buttonBackground(tr, `${PREFIX}-confirm`)).toBe(PALETTE.error);
    expect(buttonBackground(tr, `${PREFIX}-dismiss`)).toBe(PALETTE.accent);
  });

  it('11. typed variant styling: border + confirm background colors.error, dismiss colors.accent, borderLeftWidth 4', () => {
    const { tr } = renderCard();

    expect(styleValue(tr, `${PREFIX}-card`, 'borderLeftColor')).toBe(PALETTE.error);
    expect(styleValue(tr, `${PREFIX}-card`, 'borderLeftWidth')).toBe(4);
    expect(buttonBackground(tr, `${PREFIX}-confirm`)).toBe(PALETTE.error);
    expect(buttonBackground(tr, `${PREFIX}-dismiss`)).toBe(PALETTE.accent);
  });

  it('12. colors.warning never appears in any of the three configurations', () => {
    const typed = renderCard();
    const ordinaryNeutral = renderCard({ variant: 'ordinary', matchText: undefined, typedPlaceholder: undefined });
    const ordinaryDestructive = renderCard({
      variant: 'ordinary',
      tone: 'destructive',
      matchText: undefined,
      typedPlaceholder: undefined,
    });

    expect(treeText(typed.tr)).not.toContain(PALETTE.warning);
    expect(treeText(ordinaryNeutral.tr)).not.toContain(PALETTE.warning);
    expect(treeText(ordinaryDestructive.tr)).not.toContain(PALETTE.warning);
  });

  it('13. empty matchText is fail-closed: no typed value opens the gate, and a direct press fires nothing', () => {
    const { tr, onConfirm } = renderCard({ matchText: '' });

    for (const value of ['', '   ', 'anything']) {
      type(tr, PREFIX, value);
      expect(isDisabled(tr, `${PREFIX}-confirm`)).toBe(true);
    }

    const pressable = findPressable(tr, `${PREFIX}-confirm`);
    renderer.act(() => {
      pressable!.props.onPress();
    });
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('14. button order: dismiss wrapper appears before confirm wrapper within the card', () => {
    const { tr } = renderCard();
    const json = JSON.stringify(tr.toJSON());
    const dismissIndex = json.indexOf(`${PREFIX}-dismiss`);
    const confirmIndex = json.indexOf(`${PREFIX}-confirm`);

    expect(dismissIndex).toBeGreaterThan(-1);
    expect(confirmIndex).toBeGreaterThan(-1);
    expect(dismissIndex).toBeLessThan(confirmIndex);
  });

  it('15. bare-dismiss dev warning: warns once for a bare label, not at all for a real Phase 47 label', () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    renderCard({ dismissLabel: 'Cancel' });
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0].join(' ')).not.toContain('Jane Doe');

    warnSpy.mockClear();

    renderCard({ dismissLabel: 'Keep Current Status' });
    expect(warnSpy).not.toHaveBeenCalled();

    warnSpy.mockRestore();
  });

  it('16. no private-ish value (the registrant display name) is ever logged across a full interaction cycle', async () => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    const { tr } = renderCard();
    type(tr, PREFIX, 'Jane Doe');
    press(tr, `${PREFIX}-confirm`);
    await flush(tr);

    const dismissRender = renderCard();
    press(dismissRender.tr, `${PREFIX}-dismiss`);

    const allCalls = [...logSpy.mock.calls, ...warnSpy.mock.calls, ...errorSpy.mock.calls];
    for (const call of allCalls) {
      expect(JSON.stringify(call)).not.toContain('Jane Doe');
    }

    logSpy.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('17. both slots are width-constrained: flex:1 and minWidth:0 on both dismiss and confirm wrappers', () => {
    const { tr } = renderCard();

    expect(styleValue(tr, `${PREFIX}-dismiss`, 'flex')).toBe(1);
    expect(styleValue(tr, `${PREFIX}-dismiss`, 'minWidth')).toBe(0);
    expect(styleValue(tr, `${PREFIX}-confirm`, 'flex')).toBe(1);
    expect(styleValue(tr, `${PREFIX}-confirm`, 'minWidth')).toBe(0);
  });

  it('18. long ES labels: slots stay constrained and the confirm label chain can shrink/wrap instead of clipping', () => {
    const { tr } = renderCard({
      dismissLabel: 'Mantener Estado Actual',
      confirmLabel: 'Suspender Registrante',
    });

    expect(styleValue(tr, `${PREFIX}-dismiss`, 'flex')).toBe(1);
    expect(styleValue(tr, `${PREFIX}-dismiss`, 'minWidth')).toBe(0);
    expect(styleValue(tr, `${PREFIX}-confirm`, 'flex')).toBe(1);
    expect(styleValue(tr, `${PREFIX}-confirm`, 'minWidth')).toBe(0);

    const confirmWrapper = tr.root.findByProps({ testID: `${PREFIX}-confirm` });
    const textNode = [confirmWrapper, ...confirmWrapper.findAll(() => true)].find((node) => {
      const flat = Array.isArray(node.props.style)
        ? node.props.style.flat(5).find(
            (s: unknown) => s !== null && typeof s === 'object' && 'flexShrink' in (s as Record<string, unknown>),
          )
        : node.props.style && typeof node.props.style === 'object' && 'flexShrink' in node.props.style
          ? node.props.style
          : undefined;
      return flat !== undefined;
    });
    expect(textNode).not.toBeUndefined();
    const flat = Array.isArray(textNode!.props.style)
      ? textNode!.props.style
          .flat(5)
          .find((s: unknown) => s !== null && typeof s === 'object' && 'flexShrink' in (s as Record<string, unknown>))
      : textNode!.props.style;
    expect((flat as Record<string, unknown>).flexShrink).toBe(1);
  });

  it('19. the row itself never opens an unbounded axis: flexDirection row, alignItems stretch', () => {
    const { tr } = renderCard();

    const dismissWrapper = tr.root.findByProps({ testID: `${PREFIX}-dismiss` });
    const row = dismissWrapper.parent!;
    const flat = Array.isArray(row.props.style) ? row.props.style.flat(5) : [row.props.style];
    const withFlexDirection = flat.find(
      (s: unknown) => s !== null && typeof s === 'object' && 'flexDirection' in (s as Record<string, unknown>),
    ) as Record<string, unknown>;

    expect(withFlexDirection.flexDirection).toBe('row');
    expect(withFlexDirection.alignItems).toBe('stretch');
  });

  it('20. safety unchanged under the new styles: typed gate + submittingRef latch survive the restyle (long ES labels)', () => {
    const onConfirm = jest.fn().mockReturnValue(new Promise(() => {}));
    const { tr } = renderCard({
      dismissLabel: 'Mantener Estado Actual',
      confirmLabel: 'Suspender Registrante',
      onConfirm,
    });

    type(tr, PREFIX, 'Jane Doex');
    expect(isDisabled(tr, `${PREFIX}-confirm`)).toBe(true);

    type(tr, PREFIX, 'Jane Doe');
    expect(isDisabled(tr, `${PREFIX}-confirm`)).toBe(false);

    const pressable = findPressable(tr, `${PREFIX}-confirm`);
    renderer.act(() => {
      pressable!.props.onPress();
      pressable!.props.onPress();
      pressable!.props.onPress();
    });

    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  // Locks the defensive half of the fix for the blocker on-device UAT found
  // (47-UAT.md test 12). A caller that renders two different destructive
  // actions through the same element position without a `key` gets ONE
  // instance, and this component's `typedValue` would carry from the action
  // the officer abandoned into the one they just opened — arming a
  // confirmation nobody typed for.
  //
  // RegistrantDetailScreen now passes `key={pendingAction}`, which fixes that
  // call site on its own. This suite exists because that means the component's
  // own reset is NOT exercised by any screen-level test: with the key in
  // place, deleting the reset left the entire app suite green (verified
  // 2026-08-05). Belt-and-braces defence where each layer masks the other's
  // absence is defence nothing verifies. These two tests hold this layer.
  it('21. a change of matched name clears anything already typed', () => {
    const { tr } = renderCard({ matchText: 'Jane Doe' });

    type(tr, PREFIX, 'Jane Doe');
    expect(isDisabled(tr, `${PREFIX}-confirm`)).toBe(false);

    // Same instance, different target — exactly what an unkeyed caller does.
    renderer.act(() => {
      tr.update(
        <LifecycleConfirmCard
          variant="typed"
          matchText="Ada Vasquez"
          title="lifecycleTitleKey"
          body="lifecycleBodyKey"
          confirmLabel="lifecycleConfirmKey"
          dismissLabel="lifecycleKeepKey"
          typedPlaceholder="lifecycleTypedPlaceholderKey"
          onConfirm={jest.fn().mockResolvedValue(undefined)}
          onDismiss={jest.fn()}
          testIDPrefix={PREFIX}
        />,
      );
    });

    expect(tr.root.findByProps({ testID: `${PREFIX}-typed-input` }).props.value).toBe('');
    expect(isDisabled(tr, `${PREFIX}-confirm`)).toBe(true);
  });

  it('22. a change of testIDPrefix (a different action on the same target) clears anything already typed', () => {
    const { tr } = renderCard({ matchText: 'Jane Doe', testIDPrefix: 'confirm-suspend' });

    type(tr, 'confirm-suspend', 'Jane Doe');
    expect(isDisabled(tr, 'confirm-suspend-confirm')).toBe(false);

    renderer.act(() => {
      tr.update(
        <LifecycleConfirmCard
          variant="typed"
          matchText="Jane Doe"
          title="lifecycleTitleKey"
          body="lifecycleBodyKey"
          confirmLabel="lifecycleConfirmKey"
          dismissLabel="lifecycleKeepKey"
          typedPlaceholder="lifecycleTypedPlaceholderKey"
          onConfirm={jest.fn().mockResolvedValue(undefined)}
          onDismiss={jest.fn()}
          testIDPrefix="confirm-revoke"
        />,
      );
    });

    expect(tr.root.findByProps({ testID: 'confirm-revoke-typed-input' }).props.value).toBe('');
    expect(isDisabled(tr, 'confirm-revoke-confirm')).toBe(true);
  });

  // STRUCTURAL pin only: react-test-renderer runs no Yoga pass, so this is NOT a
  // geometry proof. CustomButton's `flex` (flex:1 + alignSelf:stretch) assumes a ROW
  // parent. In a column slot it zeroed the vertical flex-basis (32px on Pixel_8), and
  // dropping it left a one-line thin button at 36dp. So each slot must be a ROW. The
  // real proof is scripts/assert-card-button-geometry.mjs against a device dump.
  it('23. structural: both button slots are row-direction so CustomButton flex stretches (not a geometry proof)', () => {
    const { tr } = renderCard();
    for (const id of ['lifecycle-confirm-dismiss', 'lifecycle-confirm-confirm']) {
      expect(styleValue(tr, id, 'flexDirection')).toBe('row');
      // The clickable button is the slot minus its own vertical margins (flex stretch), so the
      // slot floor must be 48dp of button PLUS 2 x marginVertical. A bare 48 floor never bound:
      // the 36dp thin button plus 16dp of margin is already 52dp.
      expect(
        (styleValue(tr, id, 'minHeight') as number) - 2 * buttonVerticalMargin(tr, id),
      ).toBeGreaterThanOrEqual(48);
    }
  });
});
