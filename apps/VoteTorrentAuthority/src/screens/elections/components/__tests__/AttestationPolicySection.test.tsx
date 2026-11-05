/**
 * Co-located test for AttestationPolicySection — pins D-07 (three distinct
 * tri-state renderings off an explicit undefined/true/false discriminant,
 * per T-46-02), D-14 (immediate apply / row states / prior-state integrity)
 * and D-10 (canWrite gate).
 *
 * Uses react-test-renderer ONLY — no external component-testing-library
 * package is a dependency of this app.
 *
 * The identity `t` mock (react-i18next) means every assertion targets the
 * i18n KEY string, so this test does not depend on 46-03's copy.
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
const AttestationPolicySectionModule = require('../AttestationPolicySection');
const AttestationPolicySection =
  AttestationPolicySectionModule.AttestationPolicySection ?? AttestationPolicySectionModule.default;
const { resolveAttestationState } = AttestationPolicySectionModule;

interface Policy {
  electionId: string;
  attestationRequired: boolean;
}

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

async function flush(tr: renderer.ReactTestRenderer) {
  await renderer.act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function labelColor(tr: renderer.ReactTestRenderer): unknown {
  const node = tr.root.findByProps({ testID: 'attestation-state-label' });
  const style = Array.isArray(node.props.style) ? node.props.style.flat(5) : [node.props.style];
  const withColor = style.find(
    (s: unknown) => s !== null && typeof s === 'object' && 'color' in (s as Record<string, unknown>),
  ) as Record<string, unknown> | undefined;
  return withColor?.color;
}

function glyphs(tr: renderer.ReactTestRenderer): Array<{ name: unknown; color: unknown }> {
  return tr.root
    .findAllByType('FontAwesome6' as never)
    .map((n) => ({ name: n.props.name, color: n.props.color }));
}

function treeText(tr: renderer.ReactTestRenderer): string {
  return JSON.stringify(tr.toJSON());
}

function renderSection(overrides: {
  policy?: Policy;
  canWrite?: boolean;
  onSetAttestation?: jest.Mock;
  onRevertToDefault?: jest.Mock;
} = {}) {
  const onSetAttestation = overrides.onSetAttestation ?? jest.fn().mockResolvedValue(undefined);
  const onRevertToDefault = overrides.onRevertToDefault ?? jest.fn().mockResolvedValue(undefined);
  const canWrite = overrides.canWrite ?? true;

  let tr!: renderer.ReactTestRenderer;
  renderer.act(() => {
    tr = renderer.create(
      <AttestationPolicySection
        policy={overrides.policy}
        canWrite={canWrite}
        onSetAttestation={onSetAttestation}
        onRevertToDefault={onRevertToDefault}
      />,
    );
  });
  return { tr, onSetAttestation, onRevertToDefault };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('AttestationPolicySection — D-07/D-14/D-10', () => {
  it('D-07/T-46-02: not-configured (undefined policy) is its own distinct state', () => {
    const { tr } = renderSection({ policy: undefined });

    expect(() => tr.root.findByProps({ testID: 'attestation-state-not-configured' })).not.toThrow();
    expect(() => tr.root.findByProps({ testID: 'attestation-state-required' })).toThrow();
    expect(() => tr.root.findByProps({ testID: 'attestation-state-not-required' })).toThrow();

    expect(labelColor(tr)).toBe(PALETTE.textSecondary);
    expect(labelColor(tr)).not.toBe(PALETTE.text);

    const g = glyphs(tr);
    expect(g).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'circle-info' })]));
    expect(g.some((x) => x.name === 'shield-halved')).toBe(false);

    expect(treeText(tr)).toContain('registrationPolicyAttestationNotConfiguredBody');
  });

  it('required (set) is distinct from not-configured: full-strength label, success shield', () => {
    const { tr } = renderSection({ policy: { electionId: 'e1', attestationRequired: true } });

    expect(() => tr.root.findByProps({ testID: 'attestation-state-required' })).not.toThrow();
    expect(() => tr.root.findByProps({ testID: 'attestation-state-not-configured' })).toThrow();

    expect(labelColor(tr)).toBe(PALETTE.text);
    expect(labelColor(tr)).not.toBe(PALETTE.textSecondary);

    const g = glyphs(tr);
    expect(g).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'shield-halved', color: PALETTE.success })]),
    );
  });

  it('not-required (set): full-strength label, warning shield', () => {
    const { tr } = renderSection({ policy: { electionId: 'e1', attestationRequired: false } });

    expect(() => tr.root.findByProps({ testID: 'attestation-state-not-required' })).not.toThrow();
    expect(() => tr.root.findByProps({ testID: 'attestation-state-not-configured' })).toThrow();

    expect(labelColor(tr)).toBe(PALETTE.text);

    const g = glyphs(tr);
    expect(g).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'shield-halved', color: PALETTE.warning })]),
    );
  });

  it('Revert presence contract: absent when not-configured, present in both explicit states', () => {
    const notConfigured = renderSection({ policy: undefined });
    expect(() => notConfigured.tr.root.findByProps({ testID: 'attestation-action-revert' })).toThrow();

    const required = renderSection({ policy: { electionId: 'e1', attestationRequired: true } });
    expect(() => required.tr.root.findByProps({ testID: 'attestation-action-revert' })).not.toThrow();

    const notRequired = renderSection({ policy: { electionId: 'e1', attestationRequired: false } });
    expect(() => notRequired.tr.root.findByProps({ testID: 'attestation-action-revert' })).not.toThrow();
  });

  it('resolveAttestationState unit table: undefined/true/false map to the three distinct states', () => {
    // A naive `policy?.attestationRequired ?? false` implementation would map
    // case 1 (undefined) to "not-required" instead of "not-configured" —
    // exactly the T-46-02 inversion this helper exists to prevent.
    expect(resolveAttestationState(undefined)).toBe('not-configured');
    expect(resolveAttestationState({ electionId: 'e1', attestationRequired: true })).toBe('required');
    expect(resolveAttestationState({ electionId: 'e1', attestationRequired: false })).toBe('not-required');
  });

  it('D-14 immediate apply: actions fire their callback exactly once, with no Save control pressed', async () => {
    const notConfigured = renderSection({ policy: undefined });
    press(notConfigured.tr, 'attestation-action-require');
    expect(notConfigured.onSetAttestation).toHaveBeenCalledTimes(1);
    expect(notConfigured.onSetAttestation).toHaveBeenCalledWith(true);
    await flush(notConfigured.tr);

    const notConfigured2 = renderSection({ policy: undefined });
    press(notConfigured2.tr, 'attestation-action-dont-require');
    expect(notConfigured2.onSetAttestation).toHaveBeenCalledTimes(1);
    expect(notConfigured2.onSetAttestation).toHaveBeenCalledWith(false);
    await flush(notConfigured2.tr);

    const required = renderSection({ policy: { electionId: 'e1', attestationRequired: true } });
    press(required.tr, 'attestation-action-revert');
    expect(required.onRevertToDefault).toHaveBeenCalledTimes(1);
    await flush(required.tr);
  });

  it('D-14 row states + prior-state integrity: rejected write shows error+Retry, retry re-fires identical args, prior state unchanged', async () => {
    const onSetAttestation = jest.fn().mockRejectedValueOnce(new Error('write failed')).mockResolvedValue(undefined);
    const { tr } = renderSection({ policy: { electionId: 'e1', attestationRequired: true }, onSetAttestation });

    press(tr, 'attestation-action-dont-require');
    await flush(tr);

    expect(treeText(tr)).toContain('registrationPolicyRowError');
    expect(() => tr.root.findByProps({ testID: 'attestation-retry' })).not.toThrow();
    // Prior-state integrity: the component never mirrors props.policy, so the
    // rejected write leaves the previously displayed "required" block on
    // screen — the not-required block must still be absent.
    expect(() => tr.root.findByProps({ testID: 'attestation-state-not-required' })).toThrow();
    expect(() => tr.root.findByProps({ testID: 'attestation-state-required' })).not.toThrow();

    press(tr, 'attestation-retry');
    await flush(tr);

    expect(onSetAttestation.mock.calls[1]).toEqual(onSetAttestation.mock.calls[0]);
  });

  it('D-14 pending state: a never-resolving write shows Saving…', async () => {
    const onSetAttestation = jest.fn().mockReturnValue(new Promise(() => {}));
    const { tr } = renderSection({ policy: { electionId: 'e1', attestationRequired: true }, onSetAttestation });

    press(tr, 'attestation-action-dont-require');
    await flush(tr);

    expect(treeText(tr)).toContain('registrationPolicyRowSaving');
  });

  it('D-10 canWrite gate: zero calls across every action in every state; controls stay present but disabled', () => {
    const states: Array<Policy | undefined> = [
      undefined,
      { electionId: 'e1', attestationRequired: true },
      { electionId: 'e1', attestationRequired: false },
    ];

    for (const policy of states) {
      const { tr, onSetAttestation, onRevertToDefault } = renderSection({ policy, canWrite: false });

      const testIDsForState = (): string[] => {
        const state = resolveAttestationState(policy);
        if (state === 'not-configured') {
          return ['attestation-action-require', 'attestation-action-dont-require'];
        }
        if (state === 'required') {
          return ['attestation-action-dont-require', 'attestation-action-revert'];
        }
        return ['attestation-action-require', 'attestation-action-revert'];
      };

      for (const testID of testIDsForState()) {
        // Still present in the tree — disabled, not hidden.
        const control = tr.root.findByProps({ testID });
        expect(control).toBeTruthy();

        const disabledNode = [control, ...control.findAll(() => true)].find(
          (node) => 'disabled' in node.props,
        );
        expect(disabledNode?.props.disabled).toBe(true);

        renderer.act(() => {
          control.props.onPress?.();
        });
      }

      expect(onSetAttestation).not.toHaveBeenCalled();
      expect(onRevertToDefault).not.toHaveBeenCalled();
    }
  });
});
