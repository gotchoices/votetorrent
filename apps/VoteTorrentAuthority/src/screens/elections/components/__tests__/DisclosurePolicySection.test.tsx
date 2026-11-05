/**
 * Co-located test for DisclosurePolicySection — pins D-03 (the compound-AND
 * district-audience gate, proven by chip ABSENCE across all four leg
 * combinations, never disabledness), D-14 (immediate apply / row states /
 * prior-value integrity) and D-10 (canWrite gate).
 *
 * Uses react-test-renderer ONLY — no external component-testing-library
 * package is a dependency of this app.
 *
 * The identity `t` mock (react-i18next) means every assertion targets the
 * i18n KEY string, so this test does not depend on 46-03's copy landing
 * first.
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

// eslint-disable-next-line @typescript-eslint/no-var-requires
const DisclosurePolicySectionModule = require('../DisclosurePolicySection');
const DisclosurePolicySection =
  DisclosurePolicySectionModule.DisclosurePolicySection ?? DisclosurePolicySectionModule.default;
const { hasDistrictFieldDeclared, isDistrictAudienceAvailable } = DisclosurePolicySectionModule;

type Tier = 'public' | 'selective' | 'private';
type Requirement = 'required' | 'optional';
type Audience = 'district' | 'everyone';

interface Field {
  electionId: string;
  fieldName: string;
  tier: Tier;
  requirement: Requirement;
}

interface Disclosure {
  electionId: string;
  fieldName: string;
  audience: Audience;
}

const SELECTIVE_FIELD: Field = {
  electionId: 'e1',
  fieldName: 'Address',
  tier: 'selective',
  requirement: 'optional',
};

const DISTRICT_FIELD: Field = {
  electionId: 'e1',
  fieldName: 'District',
  tier: 'public',
  requirement: 'required',
};

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
// existing BallotConfirmation.test.tsx / RegistrationFieldsSection.test.tsx
// convention.
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

/** Count `FontAwesome6 name="check"` glyphs inside the wrapper at testID. */
function checkGlyphCount(tr: renderer.ReactTestRenderer, testID: string): number {
  const wrapper = tr.root.findByProps({ testID });
  return wrapper.findAll(
    (node) => node.type === ('FontAwesome6' as never) && node.props.name === 'check',
  ).length;
}

function renderSection(overrides: {
  fields?: Field[];
  disclosures?: Disclosure[];
  hasDistrictedBallot?: boolean;
  canWrite?: boolean;
  onSetAudience?: jest.Mock;
  onRemoveDisclosure?: jest.Mock;
} = {}) {
  const onSetAudience = overrides.onSetAudience ?? jest.fn().mockResolvedValue(undefined);
  const onRemoveDisclosure = overrides.onRemoveDisclosure ?? jest.fn().mockResolvedValue(undefined);
  const fields = overrides.fields ?? [];
  const disclosures = overrides.disclosures ?? [];
  const hasDistrictedBallot = overrides.hasDistrictedBallot ?? false;
  const canWrite = overrides.canWrite ?? true;

  let tr!: renderer.ReactTestRenderer;
  renderer.act(() => {
    tr = renderer.create(
      <DisclosurePolicySection
        fields={fields}
        disclosures={disclosures}
        hasDistrictedBallot={hasDistrictedBallot}
        canWrite={canWrite}
        onSetAudience={onSetAudience}
        onRemoveDisclosure={onRemoveDisclosure}
      />,
    );
  });
  return { tr, onSetAudience, onRemoveDisclosure };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('DisclosurePolicySection — D-03/D-14/D-10', () => {
  it('D-03 truth table: district chip appears ONLY when both legs hold (A AND B), absent otherwise', () => {
    // A∧B: districted ballot AND District field declared -> chip present, hint absent.
    const both = renderSection({
      fields: [SELECTIVE_FIELD, DISTRICT_FIELD],
      hasDistrictedBallot: true,
    });
    expect(() => both.tr.root.findByProps({ testID: 'disclosure-audience-Address-district' })).not.toThrow();
    expect(() => both.tr.root.findByProps({ testID: 'disclosure-district-unavailable-hint' })).toThrow();
    expect(() => both.tr.root.findByProps({ testID: 'disclosure-audience-Address-everyone' })).not.toThrow();

    // A∧¬B: districted ballot, no District field -> chip absent, hint present.
    const legAOnly = renderSection({
      fields: [SELECTIVE_FIELD],
      hasDistrictedBallot: true,
    });
    expect(() => legAOnly.tr.root.findByProps({ testID: 'disclosure-audience-Address-district' })).toThrow();
    expect(() => legAOnly.tr.root.findByProps({ testID: 'disclosure-district-unavailable-hint' })).not.toThrow();
    expect(() => legAOnly.tr.root.findByProps({ testID: 'disclosure-audience-Address-everyone' })).not.toThrow();

    // ¬A∧B: District field declared, no districted ballot -> chip absent, hint present.
    const legBOnly = renderSection({
      fields: [SELECTIVE_FIELD, DISTRICT_FIELD],
      hasDistrictedBallot: false,
    });
    expect(() => legBOnly.tr.root.findByProps({ testID: 'disclosure-audience-Address-district' })).toThrow();
    expect(() => legBOnly.tr.root.findByProps({ testID: 'disclosure-district-unavailable-hint' })).not.toThrow();
    expect(() => legBOnly.tr.root.findByProps({ testID: 'disclosure-audience-Address-everyone' })).not.toThrow();

    // ¬A∧¬B: neither leg -> chip absent, hint present.
    const neither = renderSection({
      fields: [SELECTIVE_FIELD],
      hasDistrictedBallot: false,
    });
    expect(() => neither.tr.root.findByProps({ testID: 'disclosure-audience-Address-district' })).toThrow();
    expect(() => neither.tr.root.findByProps({ testID: 'disclosure-district-unavailable-hint' })).not.toThrow();
    expect(() => neither.tr.root.findByProps({ testID: 'disclosure-audience-Address-everyone' })).not.toThrow();
  });

  it('Unavailable hint is singular and section-level, not per-row', () => {
    const secondField: Field = { ...SELECTIVE_FIELD, fieldName: 'PhoneNumber' };
    const { tr } = renderSection({
      fields: [SELECTIVE_FIELD, secondField],
      hasDistrictedBallot: false,
    });

    // { deep: false } stops recursion at the first match — without it, a
    // single <View testID=.../> in the tree yields TWO matches (the
    // forwardRef composite `View` and its underlying host `View`), which
    // would falsely read as two hints rendered.
    const hints = tr.root.findAllByProps({ testID: 'disclosure-district-unavailable-hint' }, { deep: false });
    expect(hints).toHaveLength(1);
    const hintNode = findJsonNodeByTestID(tr.toJSON(), 'disclosure-district-unavailable-hint');
    expect(JSON.stringify(hintNode)).toContain('registrationPolicyAudienceDistrictUnavailableHint');
  });

  it('Pure-helper unit assertions (no render)', () => {
    expect(hasDistrictFieldDeclared([{ ...DISTRICT_FIELD, fieldName: 'district' }])).toBe(true);
    expect(hasDistrictFieldDeclared([{ ...DISTRICT_FIELD, fieldName: 'DISTRICT' }])).toBe(true);
    expect(hasDistrictFieldDeclared([{ ...SELECTIVE_FIELD, fieldName: 'Address' }])).toBe(false);

    expect(isDistrictAudienceAvailable([SELECTIVE_FIELD, DISTRICT_FIELD], true)).toBe(true);
    expect(isDistrictAudienceAvailable([SELECTIVE_FIELD], true)).toBe(false);
    expect(isDistrictAudienceAvailable([SELECTIVE_FIELD, DISTRICT_FIELD], false)).toBe(false);
    expect(isDistrictAudienceAvailable([SELECTIVE_FIELD], false)).toBe(false);
  });

  it('D-14 immediate apply: pressing Everyone fires onSetAudience once; already-selected audience is a no-op', async () => {
    const { tr, onSetAudience } = renderSection({ fields: [SELECTIVE_FIELD], disclosures: [] });
    press(tr, 'disclosure-audience-Address-everyone');
    expect(onSetAudience).toHaveBeenCalledTimes(1);
    expect(onSetAudience).toHaveBeenCalledWith('Address', 'everyone');
    await flush(tr);

    const already = renderSection({
      fields: [SELECTIVE_FIELD],
      disclosures: [{ electionId: 'e1', fieldName: 'Address', audience: 'everyone' }],
    });
    press(already.tr, 'disclosure-audience-Address-everyone');
    expect(already.onSetAudience).toHaveBeenCalledTimes(0);
  });

  it('D-14 row states + prior-value integrity: rejected write shows error+Retry, retry re-fires identical args, prior audience stays displayed', async () => {
    const onSetAudience = jest.fn().mockRejectedValueOnce(new Error('write failed')).mockResolvedValue(undefined);
    const { tr } = renderSection({
      fields: [SELECTIVE_FIELD],
      disclosures: [],
      onSetAudience,
    });

    press(tr, 'disclosure-audience-Address-everyone');
    await flush(tr);

    expect(treeContainsText(tr, 'registrationPolicyRowError')).toBe(true);
    expect(() => tr.root.findByProps({ testID: 'disclosure-retry-Address' })).not.toThrow();
    // D-14 prior-value integrity (the real assertion the deleted vacuous
    // whole-tree check claimed to make): no disclosure row was ever created
    // (the write rejected), so the current-audience subtree must still read
    // the ORIGINAL not-set value and must NOT read the attempted 'everyone'
    // value. No disclosure row also means no remove control.
    const currentNode = findJsonNodeByTestID(tr.toJSON(), 'disclosure-current-audience-Address');
    const currentJson = JSON.stringify(currentNode);
    expect(currentJson).toContain('registrationPolicyAudienceNotSet');
    expect(currentJson).not.toContain('registrationPolicyAudienceEveryone');
    expect(() => tr.root.findByProps({ testID: 'disclosure-remove-Address' })).toThrow();

    press(tr, 'disclosure-retry-Address');
    await flush(tr);

    expect(onSetAudience.mock.calls[1]).toEqual(onSetAudience.mock.calls[0]);
  });

  it('D-14 pending state: a never-resolving write shows Saving…', async () => {
    const onSetAudience = jest.fn().mockReturnValue(new Promise(() => {}));
    const { tr } = renderSection({ fields: [SELECTIVE_FIELD], disclosures: [], onSetAudience });

    press(tr, 'disclosure-audience-Address-everyone');
    await flush(tr);

    expect(treeContainsText(tr, 'registrationPolicyRowSaving')).toBe(true);
  });

  it('D-14 remove path: remove control fires onRemoveDisclosure once; absent when no disclosure row exists', async () => {
    const withDisclosure = renderSection({
      fields: [SELECTIVE_FIELD],
      disclosures: [{ electionId: 'e1', fieldName: 'Address', audience: 'everyone' }],
    });
    expect(() => withDisclosure.tr.root.findByProps({ testID: 'disclosure-remove-Address' })).not.toThrow();
    press(withDisclosure.tr, 'disclosure-remove-Address');
    expect(withDisclosure.onRemoveDisclosure).toHaveBeenCalledTimes(1);
    expect(withDisclosure.onRemoveDisclosure).toHaveBeenCalledWith('Address');
    await flush(withDisclosure.tr);

    const withoutDisclosure = renderSection({ fields: [SELECTIVE_FIELD], disclosures: [] });
    expect(() => withoutDisclosure.tr.root.findByProps({ testID: 'disclosure-remove-Address' })).toThrow();
  });

  it('D-10 canWrite gate: no callback fires when canWrite is false; controls stay present but disabled', () => {
    const { tr, onSetAudience, onRemoveDisclosure } = renderSection({
      fields: [SELECTIVE_FIELD, DISTRICT_FIELD],
      disclosures: [{ electionId: 'e1', fieldName: 'Address', audience: 'everyone' }],
      hasDistrictedBallot: true,
      canWrite: false,
    });

    const writeTestIDs = [
      'disclosure-audience-Address-everyone',
      'disclosure-audience-Address-district',
      'disclosure-remove-Address',
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

    expect(onSetAudience).not.toHaveBeenCalled();
    expect(onRemoveDisclosure).not.toHaveBeenCalled();
  });

  it('Non-selective fields excluded + empty state', () => {
    const nonSelectiveOnly = renderSection({ fields: [DISTRICT_FIELD] });
    expect(() => nonSelectiveOnly.tr.root.findByProps({ testID: 'disclosure-row-District' })).toThrow();
    expect(() => nonSelectiveOnly.tr.root.findByProps({ testID: 'disclosure-empty' })).not.toThrow();
    expect(treeContainsText(nonSelectiveOnly.tr, 'registrationPolicyNoDisclosureHeading')).toBe(true);

    const withSelective = renderSection({ fields: [SELECTIVE_FIELD] });
    expect(() => withSelective.tr.root.findByProps({ testID: 'disclosure-empty' })).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Current-audience legibility (D-03/D-10) — 46-12 gap closure
// ---------------------------------------------------------------------------

/**
 * SCOPING RULE — do not widen this back out.
 *
 * Both audience chip labels (Everyone / Same district) are ALWAYS present
 * somewhere in the rendered tree, because they are the chip labels
 * themselves. A whole-tree text-search assertion applied to either label
 * therefore passes on ANY render regardless of whether the field's actual
 * current audience is shown — this exact vacuity is what let the original
 * defect ship with a green suite (46-VERIFICATION.md gap-2, 46-REVIEW.md
 * CR-02).
 *
 * Every current-audience assertion below MUST resolve through
 * `findJsonNodeByTestID(tr.toJSON(), 'disclosure-current-audience-Address')`
 * and assert against `JSON.stringify` of THAT node only — never the whole
 * tree. Do not reach for the whole-tree text helper to check an audience
 * value; scope it to the current-audience subtree instead.
 */

describe('DisclosurePolicySection — current-audience legibility (46-12 gap closure)', () => {
  it('current-audience subtree shows Everyone and NEITHER District NOR Not-set, when audience is everyone', () => {
    const { tr } = renderSection({
      fields: [SELECTIVE_FIELD],
      disclosures: [{ electionId: 'e1', fieldName: 'Address', audience: 'everyone' }],
    });

    const currentNode = findJsonNodeByTestID(tr.toJSON(), 'disclosure-current-audience-Address');
    expect(currentNode).not.toBeNull();
    const currentJson = JSON.stringify(currentNode);

    expect(currentJson).toContain('registrationPolicyAudienceEveryone');
    expect(currentJson).not.toContain('registrationPolicyAudienceDistrict');
    expect(currentJson).not.toContain('registrationPolicyAudienceNotSet');
  });

  it('current-audience subtree shows District and NOT Everyone, when both D-03 legs are open and audience is district', () => {
    const { tr } = renderSection({
      fields: [SELECTIVE_FIELD, DISTRICT_FIELD],
      hasDistrictedBallot: true,
      disclosures: [{ electionId: 'e1', fieldName: 'Address', audience: 'district' }],
    });

    const currentNode = findJsonNodeByTestID(tr.toJSON(), 'disclosure-current-audience-Address');
    const currentJson = JSON.stringify(currentNode);

    expect(currentJson).toContain('registrationPolicyAudienceDistrict');
    expect(currentJson).not.toContain('registrationPolicyAudienceEveryone');
  });

  it('current-audience subtree shows Not-set when no disclosure row exists for the field', () => {
    const { tr } = renderSection({ fields: [SELECTIVE_FIELD], disclosures: [] });

    const currentNode = findJsonNodeByTestID(tr.toJSON(), 'disclosure-current-audience-Address');
    const currentJson = JSON.stringify(currentNode);

    expect(currentJson).toContain('registrationPolicyAudienceNotSet');
  });

  it('exactly one chip carries the check glyph — the one matching the current audience (or neither, when unset)', () => {
    const everyoneSelected = renderSection({
      fields: [SELECTIVE_FIELD, DISTRICT_FIELD],
      hasDistrictedBallot: true,
      disclosures: [{ electionId: 'e1', fieldName: 'Address', audience: 'everyone' }],
    });
    expect(checkGlyphCount(everyoneSelected.tr, 'disclosure-audience-Address-everyone')).toBe(1);
    expect(checkGlyphCount(everyoneSelected.tr, 'disclosure-audience-Address-district')).toBe(0);

    const districtSelected = renderSection({
      fields: [SELECTIVE_FIELD, DISTRICT_FIELD],
      hasDistrictedBallot: true,
      disclosures: [{ electionId: 'e1', fieldName: 'Address', audience: 'district' }],
    });
    expect(checkGlyphCount(districtSelected.tr, 'disclosure-audience-Address-everyone')).toBe(0);
    expect(checkGlyphCount(districtSelected.tr, 'disclosure-audience-Address-district')).toBe(1);

    const unset = renderSection({
      fields: [SELECTIVE_FIELD, DISTRICT_FIELD],
      hasDistrictedBallot: true,
      disclosures: [],
    });
    expect(checkGlyphCount(unset.tr, 'disclosure-audience-Address-everyone')).toBe(0);
    expect(checkGlyphCount(unset.tr, 'disclosure-audience-Address-district')).toBe(0);
  });

  it('D-10 read-only officer (canWrite=false) sees the same current-audience text and the same selected-chip marker', () => {
    const { tr } = renderSection({
      fields: [SELECTIVE_FIELD],
      disclosures: [{ electionId: 'e1', fieldName: 'Address', audience: 'everyone' }],
      canWrite: false,
    });

    const currentNode = findJsonNodeByTestID(tr.toJSON(), 'disclosure-current-audience-Address');
    const currentJson = JSON.stringify(currentNode);
    expect(currentJson).toContain('registrationPolicyAudienceEveryone');
    expect(currentJson).not.toContain('registrationPolicyAudienceNotSet');

    expect(checkGlyphCount(tr, 'disclosure-audience-Address-everyone')).toBe(1);
  });

  it('WR-01 case-skew: a disclosure row stored lower-cased resolves to the real audience, not Not-set, and Remove is present', async () => {
    const { tr, onRemoveDisclosure } = renderSection({
      fields: [SELECTIVE_FIELD],
      disclosures: [{ electionId: 'e1', fieldName: 'address', audience: 'everyone' }],
    });

    const currentNode = findJsonNodeByTestID(tr.toJSON(), 'disclosure-current-audience-Address');
    const currentJson = JSON.stringify(currentNode);
    expect(currentJson).toContain('registrationPolicyAudienceEveryone');
    expect(currentJson).not.toContain('registrationPolicyAudienceNotSet');

    expect(() => tr.root.findByProps({ testID: 'disclosure-remove-Address' })).not.toThrow();

    // 46-15 (CR-01) — upgraded from a presence-only assertion to a press.
    // This is literally the defective artifact CR-01 named: 46-12's version
    // of this test asserted the Remove control was PRESENT and never
    // pressed it, so a control that could never succeed against the real
    // engine shipped green. Pressing here proves only the CONTRACT AT THIS
    // BOUNDARY: the section supplies the field-row name it was given
    // ('Address', unchanged by the disclosure row's stored lower-casing) —
    // it is purely presentational and makes no engine call, so it cannot
    // itself resolve a stored PK casing. The screen owns that resolution
    // (RegistrationPolicyScreen.resolveStoredDisclosureName), pinned
    // separately by screen tests A/B/C in RegistrationPolicyScreen.test.tsx
    // ("gap 1 (CR-01 stored-casing disclosure delete, 46-15)").
    press(tr, 'disclosure-remove-Address');
    expect(onRemoveDisclosure).toHaveBeenCalledTimes(1);
    expect(onRemoveDisclosure).toHaveBeenCalledWith('Address');
    await flush(tr);
  });
});
