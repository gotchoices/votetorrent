/**
 * Co-located renderer suite for RejectReasonCard — the D-06 safeguard proof.
 * Every assertion here is proven by EXECUTION, not by inspection: what is
 * being protected is that a doubled reject fires two signed, permanent,
 * attributable rejection records, and that a rejection with no reason
 * reaches the engine at all.
 *
 * Scaffold copied from `LifecycleConfirmCard.test.tsx`: react-test-renderer
 * only (no external component-testing-library package is a dependency of
 * this app), the FontAwesome6 string mock, the react-i18next key-echo mock,
 * the distinct-sentinel PALETTE, and the @react-navigation/native useTheme
 * mock. Because RejectReasonCard interpolates its body copy, the `t` mock
 * here additionally accepts `(key, params)` and returns a deterministic
 * composite of both, so the `{{name}}` binding is independently observable.
 */

import React from 'react';
import { StyleSheet } from 'react-native';
import renderer from 'react-test-renderer';

jest.mock('react-native-vector-icons/FontAwesome6', () => 'FontAwesome6');

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) =>
      params ? `${key}::${JSON.stringify(params)}` : key,
  }),
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
const RejectReasonCardModule = require('../RejectReasonCard');
const RejectReasonCard = RejectReasonCardModule.RejectReasonCard;
const isRejectReasonValid = RejectReasonCardModule.isRejectReasonValid;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function findPressable(tr: renderer.ReactTestRenderer, testID: string) {
  const wrapper = tr.root.findByProps({ testID });
  return [wrapper, ...wrapper.findAll(() => true)].find((node) => typeof node.props.onPress === 'function');
}

function press(tr: renderer.ReactTestRenderer, testID: string) {
  const pressable = findPressable(tr, testID);
  renderer.act(() => {
    pressable!.props.onPress();
  });
}

function isDisabled(tr: renderer.ReactTestRenderer, testID: string): boolean {
  const wrapper = tr.root.findByProps({ testID });
  const disabledNode = [wrapper, ...wrapper.findAll(() => true)].find((node) => 'disabled' in node.props);
  return disabledNode?.props.disabled === true;
}

function type(tr: renderer.ReactTestRenderer, prefix: string, text: string) {
  const input = tr.root.findByProps({ testID: `${prefix}-reason-input` });
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
  const withBg = [wrapper, ...wrapper.findAll(() => true)].find((node) => 'backgroundColor' in node.props);
  return withBg?.props.backgroundColor;
}

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const PREFIX = 'reject-reason';

function renderCard(overrides: Record<string, unknown> = {}) {
  const onConfirm = (overrides.onConfirm as jest.Mock) ?? jest.fn().mockResolvedValue(undefined);
  const onDismiss = (overrides.onDismiss as jest.Mock) ?? jest.fn();

  const props = {
    requesterName: 'Jane Doe',
    onConfirm,
    onDismiss,
    decisionGateMet: true,
    testIDPrefix: PREFIX,
    ...overrides,
  };

  let tr!: renderer.ReactTestRenderer;
  renderer.act(() => {
    tr = renderer.create(<RejectReasonCard {...props} />);
  });
  return { tr, onConfirm, onDismiss };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('isRejectReasonValid (D-06 non-empty-trimmed-reason gate)', () => {
  it.each([
    ['', false],
    ['   ', false],
    ['\t\n ', false],
    ['x', true],
    [' x ', true],
    ['A long, multi-line reason.\nSecond line of detail.', true],
  ])('isRejectReasonValid(%p) -> %p', (reason, expected) => {
    expect(isRejectReasonValid(reason as string)).toBe(expected);
  });

  it('does not perform a name match: a value equal to the requester name is accepted like any other non-empty string', () => {
    expect(isRejectReasonValid('Jane Doe')).toBe(true);
  });
});

describe('RejectReasonCard — D-06', () => {
  it('1. card renders title/body/reason-input/dismiss/confirm; confirm starts disabled and fires nothing when invoked directly', () => {
    const { tr, onConfirm } = renderCard();

    expect(() => tr.root.findByProps({ testID: `${PREFIX}-card` })).not.toThrow();
    expect(() => tr.root.findByProps({ testID: `${PREFIX}-title` })).not.toThrow();
    expect(() => tr.root.findByProps({ testID: `${PREFIX}-body` })).not.toThrow();
    expect(() => tr.root.findByProps({ testID: `${PREFIX}-reason-input` })).not.toThrow();
    expect(() => tr.root.findByProps({ testID: `${PREFIX}-dismiss` })).not.toThrow();

    expect(isDisabled(tr, `${PREFIX}-confirm`)).toBe(true);

    const pressable = findPressable(tr, `${PREFIX}-confirm`);
    renderer.act(() => {
      pressable!.props.onPress();
    });
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('2. body binds registrationRequestRejectBody and interpolates the requester name', () => {
    const { tr } = renderCard({ requesterName: 'Ada Vasquez' });
    const bodyNode = tr.root.findByProps({ testID: `${PREFIX}-body` });
    const text = JSON.stringify(bodyNode.props.children);

    expect(text).toContain('registrationRequestRejectBody');
    expect(text).toContain('Ada Vasquez');
  });

  it('3. gate wiring: whitespace-only reason leaves confirm disabled; a real reason opens it', async () => {
    const { tr, onConfirm } = renderCard();

    type(tr, PREFIX, '   ');
    expect(isDisabled(tr, `${PREFIX}-confirm`)).toBe(true);
    expect(onConfirm).not.toHaveBeenCalled();

    type(tr, PREFIX, 'Address could not be verified');
    expect(isDisabled(tr, `${PREFIX}-confirm`)).toBe(false);

    press(tr, `${PREFIX}-confirm`);
    await flush(tr);
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('4. trimming: onConfirm receives the trimmed reason, not the raw padded value', async () => {
    const { tr, onConfirm } = renderCard();
    type(tr, PREFIX, '  no proof of residence  ');

    press(tr, `${PREFIX}-confirm`);
    await flush(tr);

    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onConfirm).toHaveBeenCalledWith('no proof of residence');
  });

  it('5. double press — same-tick, no await between: exactly one onConfirm call', () => {
    const { promise } = deferred<void>();
    const onConfirm = jest.fn().mockReturnValue(promise);
    const { tr } = renderCard({ onConfirm });
    type(tr, PREFIX, 'Address could not be verified');

    const pressable = findPressable(tr, `${PREFIX}-confirm`);
    renderer.act(() => {
      pressable!.props.onPress();
      pressable!.props.onPress();
    });

    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('6. latch after success: once resolved, a further press fires no additional call', async () => {
    const d = deferred<void>();
    const onConfirm = jest.fn().mockReturnValue(d.promise);
    const { tr } = renderCard({ onConfirm });
    type(tr, PREFIX, 'Address could not be verified');

    press(tr, `${PREFIX}-confirm`);
    expect(onConfirm).toHaveBeenCalledTimes(1);

    d.resolve();
    await flush(tr);

    const pressable = findPressable(tr, `${PREFIX}-confirm`);
    renderer.act(() => {
      pressable!.props.onPress();
    });
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('7. retry after failure: idle is restored, a second press fires a second call, nothing is logged', async () => {
    const logSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const onConfirm = jest.fn().mockRejectedValueOnce(new Error('write failed')).mockResolvedValue(undefined);
    const { tr } = renderCard({ onConfirm });
    type(tr, PREFIX, 'Address could not be verified');

    press(tr, `${PREFIX}-confirm`);
    await flush(tr);

    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(isDisabled(tr, `${PREFIX}-confirm`)).toBe(false);
    expect(logSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();

    press(tr, `${PREFIX}-confirm`);
    await flush(tr);

    expect(onConfirm).toHaveBeenCalledTimes(2);

    logSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it('8. dismiss discipline (empty reason): dismiss fires onDismiss once, onConfirm zero times', () => {
    const { tr, onConfirm, onDismiss } = renderCard();

    press(tr, `${PREFIX}-dismiss`);

    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('9. dismiss discipline (valid reason): dismiss fires onDismiss once, onConfirm zero times', () => {
    const { tr, onConfirm, onDismiss } = renderCard();
    type(tr, PREFIX, 'Address could not be verified');
    expect(isDisabled(tr, `${PREFIX}-confirm`)).toBe(false);

    press(tr, `${PREFIX}-dismiss`);

    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('10. dismiss disabled while a confirm is in flight: programmatic press fires zero onDismiss calls', () => {
    const { promise } = deferred<void>();
    const onConfirm = jest.fn().mockReturnValue(promise);
    const { tr, onDismiss } = renderCard({ onConfirm });
    type(tr, PREFIX, 'Address could not be verified');

    press(tr, `${PREFIX}-confirm`);
    expect(isDisabled(tr, `${PREFIX}-dismiss`)).toBe(true);

    const dismissPressable = findPressable(tr, `${PREFIX}-dismiss`);
    renderer.act(() => {
      dismissPressable!.props.onPress();
    });
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it('11. colors: confirm is colors.error, dismiss is colors.accent, card left border is colors.error/4, warning never appears', () => {
    const { tr } = renderCard();

    expect(buttonBackground(tr, `${PREFIX}-confirm`)).toBe(PALETTE.error);
    expect(buttonBackground(tr, `${PREFIX}-dismiss`)).toBe(PALETTE.accent);
    expect(styleValue(tr, `${PREFIX}-card`, 'borderLeftColor')).toBe(PALETTE.error);
    expect(styleValue(tr, `${PREFIX}-card`, 'borderLeftWidth')).toBe(4);
    expect(treeText(tr)).not.toContain(PALETTE.warning);
  });

  it('12. reset on requester change: typed text and gate state clear when the same instance renders a different requester', () => {
    const { tr } = renderCard({ requesterName: 'Jane Doe' });
    type(tr, PREFIX, 'Address could not be verified');
    expect(isDisabled(tr, `${PREFIX}-confirm`)).toBe(false);

    renderer.act(() => {
      tr.update(
        <RejectReasonCard
          requesterName="Ada Vasquez"
          onConfirm={jest.fn().mockResolvedValue(undefined)}
          onDismiss={jest.fn()}
          decisionGateMet
          testIDPrefix={PREFIX}
        />,
      );
    });

    expect(tr.root.findByProps({ testID: `${PREFIX}-reason-input` }).props.value).toBe('');
    expect(isDisabled(tr, `${PREFIX}-confirm`)).toBe(true);
  });

  // STRUCTURAL pin only: react-test-renderer runs no Yoga pass, so this is NOT a
  // geometry proof. CustomButton's `flex` (flex:1 + alignSelf:stretch) assumes a ROW
  // parent. In a column slot it zeroed the vertical flex-basis (32px on Pixel_8), and
  // dropping it left a one-line thin button at 36dp. So each slot must be a ROW. The
  // real proof is scripts/assert-card-button-geometry.mjs against a device dump.
  it('13. structural: both button slots are row-direction so CustomButton flex stretches (not a geometry proof)', () => {
    const { tr } = renderCard();
    for (const id of ['reject-reason-dismiss', 'reject-reason-confirm']) {
      expect(styleValue(tr, id, 'flexDirection')).toBe('row');
      // The clickable button is the slot minus its own vertical margins (flex stretch), so the
      // slot floor must be 48dp of button PLUS 2 x marginVertical. A bare 48 floor never bound:
      // the 36dp thin button plus 16dp of margin is already 52dp.
      expect(
        (styleValue(tr, id, 'minHeight') as number) - 2 * buttonVerticalMargin(tr, id),
      ).toBeGreaterThanOrEqual(48);
    }
  });

  it('14. decisionGateMet=false disables Confirm even with a valid reason, shows the gate hint, and a direct press fires nothing', () => {
    const { tr, onConfirm } = renderCard({ decisionGateMet: false });
    type(tr, PREFIX, 'dup');
    expect(isDisabled(tr, `${PREFIX}-confirm`)).toBe(true);
    expect(tr.root.findByProps({ testID: `${PREFIX}-gate-hint` })).toBeTruthy();
    expect(treeText(tr)).toContain('registrationRequestRejectChecklistRequired');
    press(tr, `${PREFIX}-confirm`);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('15. decisionGateMet=true: no gate hint, Confirm enabled once a reason is typed', () => {
    const { tr } = renderCard({ decisionGateMet: true });
    type(tr, PREFIX, 'dup');
    expect(tr.root.findAllByProps({ testID: `${PREFIX}-gate-hint` }).length).toBe(0);
    expect(isDisabled(tr, `${PREFIX}-confirm`)).toBe(false);
  });

  it('RC1: errorMessage renders inside the card only when non-empty', () => {
    const empty = renderCard();
    expect(empty.tr.root.findAllByProps({ testID: `${PREFIX}-error` }).length).toBe(0);
    const blank = renderCard({ errorMessage: '' });
    expect(blank.tr.root.findAllByProps({ testID: `${PREFIX}-error` }).length).toBe(0);
    const shown = renderCard({ errorMessage: 'Something failed' });
    const card = shown.tr.root.findByProps({ testID: `${PREFIX}-card` });
    expect(card.findAllByProps({ testID: `${PREFIX}-error` }).length).toBeGreaterThan(0);
    expect(treeText(shown.tr)).toContain('Something failed');
  });
});
