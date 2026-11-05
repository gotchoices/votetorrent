/**
 * Co-located test for RegistrationFieldsSection — pins D-02 (three-row picker +
 * Extra Field badge), D-14 (immediate apply / row states / prior-value integrity)
 * and D-10 (canWrite gate).
 *
 * Uses react-test-renderer ONLY — no external component-testing-library
 * package is a dependency of this app.
 *
 * The identity `t` mock (react-i18next) means every assertion targets the i18n
 * KEY string, so this test does not depend on 46-03's copy landing first.
 */

import React from 'react';
import renderer from 'react-test-renderer';

jest.mock('react-native-vector-icons/FontAwesome6', () => 'FontAwesome6');

jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

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
      accent: '#5856D6',
      warning: '#FF9500',
      success: '#34C759',
      dark: '#000000',
      light: '#FFFFFF',
    },
  }),
}));

jest.mock('../../../../providers/SettingsProvider', () => ({
  useSettings: () => ({ showHelpIcons: false }),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const RegistrationFieldsSectionModule = require('../RegistrationFieldsSection');
const RegistrationFieldsSection =
  RegistrationFieldsSectionModule.RegistrationFieldsSection ?? RegistrationFieldsSectionModule.default;
const { isExtraField } = RegistrationFieldsSectionModule;

type Tier = 'public' | 'selective' | 'private';
type Requirement = 'required' | 'optional';

interface Field {
  electionId: string;
  fieldName: string;
  tier: Tier;
  requirement: Requirement;
}

function makeField(overrides: Partial<Field> = {}): Field {
  return {
    electionId: 'election-1',
    fieldName: 'ZipCode',
    tier: 'public',
    requirement: 'required',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Find the wrapper View by testID, then invoke the first descendant's onPressIn. */
function press(tr: renderer.ReactTestRenderer, testID: string) {
  const wrapper = tr.root.findByProps({ testID });
  const pressable = wrapper.findAll(
    (node) => typeof node.props.onPressIn === 'function',
  )[0];
  renderer.act(() => {
    pressable.props.onPressIn();
  });
}

async function flush(tr: renderer.ReactTestRenderer) {
  await renderer.act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

// ChipButton renders label.toUpperCase(); ThemedText renders copy verbatim.
// Compare case-insensitively so this helper works for both, matching the
// existing BallotConfirmation.test.tsx convention.
function treeContainsText(tr: renderer.ReactTestRenderer, text: string): boolean {
  const json = JSON.stringify(tr.toJSON()).toLowerCase();
  return json.includes(text.toLowerCase());
}

/** Recursively find a node in the tr.toJSON() tree by its testID prop. */
function findJsonNodeByTestID(node: unknown, testID: string): unknown {
  if (!node) return null;
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findJsonNodeByTestID(child, testID);
      if (found) return found;
    }
    return null;
  }
  if (typeof node !== 'object') return null;
  const n = node as { props?: { testID?: string }; children?: unknown };
  if (n.props?.testID === testID) return n;
  if (n.children) return findJsonNodeByTestID(n.children, testID);
  return null;
}

function renderSection(overrides: {
  fields?: Field[];
  canWrite?: boolean;
  onAddField?: jest.Mock;
  onChangeField?: jest.Mock;
  onRemoveField?: jest.Mock;
} = {}) {
  const onAddField = overrides.onAddField ?? jest.fn().mockResolvedValue(undefined);
  const onChangeField = overrides.onChangeField ?? jest.fn().mockResolvedValue(undefined);
  const onRemoveField = overrides.onRemoveField ?? jest.fn().mockResolvedValue(undefined);
  const fields = overrides.fields ?? [];
  const canWrite = overrides.canWrite ?? true;

  let tr!: renderer.ReactTestRenderer;
  renderer.act(() => {
    tr = renderer.create(
      <RegistrationFieldsSection
        fields={fields}
        canWrite={canWrite}
        onAddField={onAddField}
        onChangeField={onChangeField}
        onRemoveField={onRemoveField}
      />,
    );
  });
  return { tr, onAddField, onChangeField, onRemoveField };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('RegistrationFieldsSection — D-02/D-14/D-10', () => {
  it('D-02 known chips: exactly Last Name + First Name, no other known-field key', () => {
    const { tr } = renderSection({ fields: [] });
    expect(treeContainsText(tr, 'registrationPolicyKnownFieldLastName')).toBe(true);
    expect(treeContainsText(tr, 'registrationPolicyKnownFieldFirstName')).toBe(true);
    // Count RENDERED text only: each chip also carries its label as an accessibilityLabel prop,
    // so a raw JSON-string count would see every chip twice.
    const texts: string[] = [];
    const walk = (node: unknown): void => {
      if (typeof node === 'string') texts.push(node);
      else if (Array.isArray(node)) node.forEach(walk);
      else if (node && typeof node === 'object') walk((node as { children?: unknown }).children);
    };
    walk(tr.toJSON());
    const matches = texts.filter((s) => s.toLowerCase().includes('registrationpolicyknownfield'));
    expect(matches.length).toBe(2);
  });

  it('D-02 District separation: divider sits between known chips and district group; hint renders', () => {
    const { tr } = renderSection({ fields: [] });
    const json = JSON.stringify(tr.toJSON());
    const knownIdx = json.indexOf('registration-field-picker-known');
    const dividerIdx = json.indexOf('registration-field-picker-divider');
    const districtIdx = json.indexOf('registration-field-picker-district');
    expect(dividerIdx).toBeGreaterThan(-1);
    expect(dividerIdx).toBeGreaterThan(knownIdx);
    expect(dividerIdx).toBeLessThan(districtIdx);

    const hintNode = findJsonNodeByTestID(tr.toJSON(), 'registration-field-district-hint');
    expect(JSON.stringify(hintNode)).toContain('registrationPolicyDistrictFieldHint');
  });

  it('D-02 Extra Field badge: custom row badged, fixed-column row not', () => {
    const { tr } = renderSection({
      fields: [makeField({ fieldName: 'LastName' }), makeField({ fieldName: 'ZipCode' })],
    });

    expect(() => tr.root.findByProps({ testID: 'registration-field-extra-badge-ZipCode' })).not.toThrow();
    expect(() => tr.root.findByProps({ testID: 'registration-field-extra-hint-ZipCode' })).not.toThrow();
    expect(() => tr.root.findByProps({ testID: 'registration-field-extra-badge-LastName' })).toThrow();

    expect(isExtraField('district')).toBe(false);
    expect(isExtraField('District')).toBe(false);
    expect(isExtraField('ZipCode')).toBe(true);
  });

  it('D-14 immediate apply on add: pressing Last Name fires onAddField once, synchronously, with defaults', async () => {
    const { tr, onAddField } = renderSection({ fields: [] });
    press(tr, 'registration-field-picker-lastname');
    expect(onAddField).toHaveBeenCalledTimes(1);
    expect(onAddField).toHaveBeenCalledWith('LastName', 'public', 'required');
    // Flush the resolved mock's .then(setRowStatus) so it settles inside act().
    await flush(tr);
  });

  it('D-14 immediate apply on tier change: fires onChangeField; already-selected tier is a no-op', async () => {
    const field = makeField({ fieldName: 'ZipCode', tier: 'public', requirement: 'required' });
    const { tr, onChangeField } = renderSection({ fields: [field] });

    press(tr, 'registration-field-tier-ZipCode-selective');
    expect(onChangeField).toHaveBeenCalledTimes(1);
    expect(onChangeField).toHaveBeenCalledWith('ZipCode', 'selective', 'required');

    // Let the row settle back to a non-saving state (controls are replaced by
    // "Saving…" text while the write is in flight) before pressing again.
    await flush(tr);

    // The fixture's `field.tier` prop is still 'public' (props are never
    // mutated by this component — D-14), so re-pressing the already-selected
    // 'public' tier fires nothing.
    press(tr, 'registration-field-tier-ZipCode-public');
    expect(onChangeField).toHaveBeenCalledTimes(1);
  });

  it('D-14 row states + prior-value integrity: rejected write shows error+Retry, retry re-fires identical args', async () => {
    const field = makeField({ fieldName: 'ZipCode', tier: 'public', requirement: 'required' });
    const onChangeField = jest.fn().mockRejectedValueOnce(new Error('write failed')).mockResolvedValue(undefined);
    const { tr } = renderSection({ fields: [field], onChangeField });

    press(tr, 'registration-field-tier-ZipCode-selective');
    await flush(tr);

    expect(treeContainsText(tr, 'registrationPolicyRowError')).toBe(true);
    expect(() => tr.root.findByProps({ testID: 'registration-field-retry-ZipCode' })).not.toThrow();
    // Prior value integrity (D-14 real assertion, not the vacuous 'ZipCode'
    // substring check this replaces): the row still reads from props
    // (field.tier === 'public' in the fixture, never mutated locally), so
    // after a REJECTED write the current-value subtree must still read the
    // ORIGINAL tier and must NOT read the attempted one.
    const currentNode = findJsonNodeByTestID(tr.toJSON(), 'registration-field-current-ZipCode');
    const currentJson = JSON.stringify(currentNode);
    expect(currentJson).toContain('registrationPolicyTierPublic');
    expect(currentJson).not.toContain('registrationPolicyTierSelective');

    press(tr, 'registration-field-retry-ZipCode');
    await flush(tr);

    expect(onChangeField.mock.calls[1]).toEqual(onChangeField.mock.calls[0]);
  });

  it('D-14 pending state: a never-resolving write shows Saving…', async () => {
    const field = makeField({ fieldName: 'ZipCode' });
    const onChangeField = jest.fn().mockReturnValue(new Promise(() => {}));
    const { tr } = renderSection({ fields: [field], onChangeField });

    press(tr, 'registration-field-tier-ZipCode-selective');
    await flush(tr);

    expect(treeContainsText(tr, 'registrationPolicyRowSaving')).toBe(true);
  });

  it('D-10 canWrite gate: no callback fires when canWrite is false; controls stay present but disabled', () => {
    const field = makeField({ fieldName: 'ZipCode', tier: 'public', requirement: 'required' });
    const { tr, onAddField, onChangeField, onRemoveField } = renderSection({
      fields: [field],
      canWrite: false,
    });

    const writeTestIDs = [
      'registration-field-picker-lastname',
      'registration-field-picker-firstname',
      'registration-field-picker-district-chip',
      'registration-field-picker-custom-chip',
      'registration-field-tier-ZipCode-selective',
      'registration-field-requirement-ZipCode-optional',
      'registration-field-remove-ZipCode',
    ];

    for (const testID of writeTestIDs) {
      const wrapper = tr.root.findByProps({ testID });
      expect(wrapper.props.pointerEvents).toBe('none');
      const style = Array.isArray(wrapper.props.style) ? wrapper.props.style.flat(5) : [wrapper.props.style];
      const hasHalfOpacity = style.some(
        (s: unknown) => s !== null && typeof s === 'object' && (s as Record<string, unknown>).opacity === 0.5,
      );
      expect(hasHalfOpacity).toBe(true);
      // Still present in the tree — disabled, not hidden.
      expect(() => tr.root.findByProps({ testID })).not.toThrow();

      const pressable = wrapper.findAll((node) => 'onPressIn' in node.props)[0];
      renderer.act(() => {
        pressable.props.onPressIn?.();
      });
    }

    expect(onAddField).not.toHaveBeenCalled();
    expect(onChangeField).not.toHaveBeenCalled();
    expect(onRemoveField).not.toHaveBeenCalled();
  });

  it('Empty state: renders when fields is empty, not when fields is non-empty', () => {
    const empty = renderSection({ fields: [] });
    expect(() => empty.tr.root.findByProps({ testID: 'registration-fields-empty' })).not.toThrow();
    expect(treeContainsText(empty.tr, 'registrationPolicyNoFieldsHeading')).toBe(true);

    const nonEmpty = renderSection({ fields: [makeField()] });
    expect(() => nonEmpty.tr.root.findByProps({ testID: 'registration-fields-empty' })).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Current-value legibility (D-02/D-10) — 46-11 gap closure
// ---------------------------------------------------------------------------

/**
 * SCOPING RULE — do not widen this back out.
 *
 * All three tier labels (Public/Selective/Private) and both requirement
 * labels (Required/Optional) are ALWAYS present somewhere in the rendered
 * tree, because they are the chip labels themselves. A whole-tree text-search
 * helper applied to any of those label keys therefore passes on ANY render
 * regardless of whether the current value is actually shown — this exact
 * vacuity is what let the original defect ship with a green suite
 * (46-VERIFICATION.md gap-1, 46-REVIEW.md CR-01/WR-10).
 *
 * Every current-value assertion below MUST resolve through
 * `findJsonNodeByTestID(tr.toJSON(), 'registration-field-current-ZipCode')`
 * and assert against `JSON.stringify` of THAT node only — never the whole
 * tree. Do not reach for the whole-tree text helper to check a tier or
 * requirement label; scope it to the current-value subtree instead.
 */

/** Count `FontAwesome6 name="check"` glyphs inside the wrapper at testID. */
function checkGlyphCount(tr: renderer.ReactTestRenderer, testID: string): number {
  const wrapper = tr.root.findByProps({ testID });
  return wrapper.findAll(
    (node) => node.type === ('FontAwesome6' as never) && node.props.name === 'check',
  ).length;
}

describe('RegistrationFieldsSection — current-value legibility (46-11 gap closure)', () => {
  it('current-value subtree shows the selective/optional labels and NEITHER the public/required labels', () => {
    const field = makeField({ fieldName: 'ZipCode', tier: 'selective', requirement: 'optional' });
    const { tr } = renderSection({ fields: [field] });

    const currentNode = findJsonNodeByTestID(tr.toJSON(), 'registration-field-current-ZipCode');
    expect(currentNode).not.toBeNull();
    const currentJson = JSON.stringify(currentNode);

    expect(currentJson).toContain('registrationPolicyTierSelective');
    expect(currentJson).toContain('registrationPolicyRequirementOptional');
    expect(currentJson).not.toContain('registrationPolicyTierPublic');
    expect(currentJson).not.toContain('registrationPolicyRequirementRequired');
  });

  it('exactly one tier chip carries the check glyph — the one matching field.tier', () => {
    const field = makeField({ fieldName: 'ZipCode', tier: 'selective', requirement: 'optional' });
    const { tr } = renderSection({ fields: [field] });

    expect(checkGlyphCount(tr, 'registration-field-tier-ZipCode-selective')).toBe(1);
    expect(checkGlyphCount(tr, 'registration-field-tier-ZipCode-public')).toBe(0);
    expect(checkGlyphCount(tr, 'registration-field-tier-ZipCode-private')).toBe(0);
  });

  it('exactly one requirement chip carries the check glyph — the one matching field.requirement', () => {
    const field = makeField({ fieldName: 'ZipCode', tier: 'selective', requirement: 'optional' });
    const { tr } = renderSection({ fields: [field] });

    expect(checkGlyphCount(tr, 'registration-field-requirement-ZipCode-optional')).toBe(1);
    expect(checkGlyphCount(tr, 'registration-field-requirement-ZipCode-required')).toBe(0);
  });

  it('D-10 read-only officer (canWrite=false) sees the same current-value text and the same selected-chip markers', () => {
    const field = makeField({ fieldName: 'ZipCode', tier: 'selective', requirement: 'optional' });
    const { tr } = renderSection({ fields: [field], canWrite: false });

    const currentNode = findJsonNodeByTestID(tr.toJSON(), 'registration-field-current-ZipCode');
    const currentJson = JSON.stringify(currentNode);
    expect(currentJson).toContain('registrationPolicyTierSelective');
    expect(currentJson).toContain('registrationPolicyRequirementOptional');
    expect(currentJson).not.toContain('registrationPolicyTierPublic');
    expect(currentJson).not.toContain('registrationPolicyRequirementRequired');

    expect(checkGlyphCount(tr, 'registration-field-tier-ZipCode-selective')).toBe(1);
    expect(checkGlyphCount(tr, 'registration-field-tier-ZipCode-public')).toBe(0);
    expect(checkGlyphCount(tr, 'registration-field-requirement-ZipCode-optional')).toBe(1);
    expect(checkGlyphCount(tr, 'registration-field-requirement-ZipCode-required')).toBe(0);
  });

  it('current-value summary stays rendered while a write is in flight (D-10 persistence during saving)', async () => {
    const field = makeField({ fieldName: 'ZipCode', tier: 'public', requirement: 'required' });
    const onChangeField = jest.fn().mockReturnValue(new Promise(() => {}));
    const { tr } = renderSection({ fields: [field], onChangeField });

    press(tr, 'registration-field-tier-ZipCode-selective');
    await flush(tr);

    expect(treeContainsText(tr, 'registrationPolicyRowSaving')).toBe(true);
    expect(() => tr.root.findByProps({ testID: 'registration-field-current-ZipCode' })).not.toThrow();
  });

  it('D-14 prior-value integrity: after a REJECTED tier write from public to selective, current-value still reads public', async () => {
    const field = makeField({ fieldName: 'ZipCode', tier: 'public', requirement: 'required' });
    const onChangeField = jest.fn().mockRejectedValueOnce(new Error('write failed')).mockResolvedValue(undefined);
    const { tr } = renderSection({ fields: [field], onChangeField });

    press(tr, 'registration-field-tier-ZipCode-selective');
    await flush(tr);

    const currentNode = findJsonNodeByTestID(tr.toJSON(), 'registration-field-current-ZipCode');
    const currentJson = JSON.stringify(currentNode);
    expect(currentJson).toContain('registrationPolicyTierPublic');
    expect(currentJson).not.toContain('registrationPolicyTierSelective');
  });
});

// ---------------------------------------------------------------------------
// CR-02 in-flight double-press guard (46-VERIFICATION.md gap 2, 46-16)
// ---------------------------------------------------------------------------

describe('RegistrationFieldsSection — gap 2 (CR-02 in-flight double-press guard, 46-16)', () => {
  it('double-pressing a picker chip while its add is in flight fires onAddField exactly once', async () => {
    // The add never settles, so the write stays genuinely in flight and the
    // `fields` prop never refreshes — exactly the window isDuplicate cannot
    // see into.
    const onAddField = jest.fn().mockReturnValue(new Promise<void>(() => {}));
    const { tr } = renderSection({ fields: [], onAddField });

    press(tr, 'registration-field-picker-lastname');
    press(tr, 'registration-field-picker-lastname');

    expect(onAddField).toHaveBeenCalledTimes(1);
    expect(onAddField).toHaveBeenCalledWith('LastName', 'public', 'required');
  });

  it('key scope control: a different field is still writable while the first add is in flight', async () => {
    // Without this control, an over-broad "any write in flight blocks every
    // picker chip" implementation would pass the exactly-once test above too.
    const onAddField = jest.fn().mockReturnValue(new Promise<void>(() => {}));
    const { tr } = renderSection({ fields: [], onAddField });

    press(tr, 'registration-field-picker-lastname');
    press(tr, 'registration-field-picker-firstname');

    expect(onAddField).toHaveBeenCalledTimes(2);
    expect(onAddField.mock.calls[0]).toEqual(['LastName', 'public', 'required']);
    expect(onAddField.mock.calls[1]).toEqual(['FirstName', 'public', 'required']);
  });

  it('release control: the same field is writable again once its add settles', async () => {
    // Without this control, a guard that latched permanently (never leaving
    // "saving") would pass the two tests above and leave the picker dead for
    // the rest of the session.
    let release!: () => void;
    const onAddField = jest.fn(() => new Promise<void>((r) => { release = r; }));
    const { tr } = renderSection({ fields: [], onAddField });

    press(tr, 'registration-field-picker-lastname');
    press(tr, 'registration-field-picker-lastname');
    expect(onAddField).toHaveBeenCalledTimes(1);

    await renderer.act(async () => {
      release();
      await Promise.resolve();
      await Promise.resolve();
    });

    press(tr, 'registration-field-picker-lastname');
    expect(onAddField).toHaveBeenCalledTimes(2);
  });
});
