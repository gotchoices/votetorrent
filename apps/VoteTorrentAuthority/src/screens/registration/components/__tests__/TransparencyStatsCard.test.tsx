/**
 * Co-located renderer suite for TransparencyStatsCard — the D-09 counts
 * display. Every assertion is proven by EXECUTION: the four tiles always
 * render (loading or not), the median formatter collapses every hostile
 * input to one safe branch, and neither a raw millisecond count nor
 * `"NaN"`/`"Invalid Date"` ever reaches rendered text.
 *
 * Scaffold copied from `RejectReasonCard.test.tsx` / `LifecycleConfirmCard.test.tsx`:
 * react-test-renderer only, the FontAwesome6 string mock (transitively
 * unused here but kept for scaffold parity), the react-i18next key-echo
 * mock, and the @react-navigation/native useTheme mock.
 */

import React from 'react';
import renderer from 'react-test-renderer';

jest.mock('react-native-vector-icons/FontAwesome6', () => 'FontAwesome6');

jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

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
const TransparencyStatsCardModule = require('../TransparencyStatsCard');
const TransparencyStatsCard = TransparencyStatsCardModule.TransparencyStatsCard;
const formatDecisionDuration = TransparencyStatsCardModule.formatDecisionDuration;

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;

describe('formatDecisionDuration (D-09 safe median formatter)', () => {
  it.each([
    [undefined, { kind: 'unknown' }],
    [NaN, { kind: 'unknown' }],
    [Infinity, { kind: 'unknown' }],
    [-1, { kind: 'unknown' }],
    [0, { kind: 'duration', text: '<1m' }],
    [30_000, { kind: 'duration', text: '<1m' }],
    [5 * MINUTE_MS, { kind: 'duration', text: '5m' }],
    [2 * HOUR_MS, { kind: 'duration', text: '2h' }],
    [2 * HOUR_MS + 15 * MINUTE_MS, { kind: 'duration', text: '2h 15m' }],
    [2 * DAY_MS + 4 * HOUR_MS, { kind: 'duration', text: '2d 4h' }],
    [2 * DAY_MS, { kind: 'duration', text: '2d' }],
  ])('formatDecisionDuration(%p) -> %p', (input, expected) => {
    expect(formatDecisionDuration(input as number | undefined)).toEqual(expected);
  });
});

const PREFIX = 'transparency-stats';

function renderCard(overrides: Record<string, unknown> = {}) {
  const props = {
    stats: { pending: 3, approved: 5, rejected: 1, medianTimeToDecisionMs: 2 * DAY_MS + 4 * HOUR_MS },
    testIDPrefix: PREFIX,
    ...overrides,
  };

  let tr!: renderer.ReactTestRenderer;
  renderer.act(() => {
    tr = renderer.create(<TransparencyStatsCard {...props} />);
  });
  return { tr };
}

// `findAll` matches BOTH the composite (component) fiber and the host
// (platform-primitive) fiber for the same element — a `View` with a given
// `testID` therefore counts twice unless filtered to host nodes only
// (`typeof node.type === 'string'`). Counting composite nodes here would
// silently double the tile count and mask a missing/extra tile.
function tileCount(tr: renderer.ReactTestRenderer): number {
  return tr.root.findAll(
    (node) =>
      typeof node.type === 'string' && typeof node.props.testID === 'string' && node.props.testID.endsWith('-tile'),
  ).length;
}

function nodeText(tr: renderer.ReactTestRenderer, testID: string): string {
  return JSON.stringify(tr.root.findByProps({ testID }).props.children);
}

function treeText(tr: renderer.ReactTestRenderer): string {
  return JSON.stringify(tr.toJSON());
}

describe('TransparencyStatsCard — D-09', () => {
  it('1. exactly four tiles render', () => {
    const { tr } = renderCard();
    expect(tileCount(tr)).toBe(4);
  });

  it('2. each value/caption pair carries the expected text; counts render as their string numbers', () => {
    const { tr } = renderCard({ stats: { pending: 3, approved: 5, rejected: 1, medianTimeToDecisionMs: 5 * MINUTE_MS } });

    expect(nodeText(tr, `${PREFIX}-pending-value`)).toContain('3');
    expect(nodeText(tr, `${PREFIX}-pending-caption`)).toContain('transparencyStatsPendingLabel');
    expect(nodeText(tr, `${PREFIX}-approved-value`)).toContain('5');
    expect(nodeText(tr, `${PREFIX}-approved-caption`)).toContain('transparencyStatsApprovedLabel');
    expect(nodeText(tr, `${PREFIX}-rejected-value`)).toContain('1');
    expect(nodeText(tr, `${PREFIX}-rejected-caption`)).toContain('transparencyStatsRejectedLabel');
    expect(nodeText(tr, `${PREFIX}-median-value`)).toContain('5m');
    expect(nodeText(tr, `${PREFIX}-median-caption`)).toContain('transparencyStatsMedianTimeLabel');
  });

  it('3. median unknown: medianTimeToDecisionMs undefined renders the unknown key, never NaN/Invalid Date/raw ms', () => {
    const { tr } = renderCard({ stats: { pending: 0, approved: 0, rejected: 0, medianTimeToDecisionMs: undefined } });

    expect(nodeText(tr, `${PREFIX}-median-value`)).toContain('transparencyStatsMedianTimeUnknown');

    const full = treeText(tr);
    expect(full).not.toContain('NaN');
    expect(full).not.toContain('Invalid Date');
    expect(full).not.toMatch(/\b\d{5,}\b/);
  });

  it('4. stats undefined: card still renders four tiles, counts read 0, median is the unknown string', () => {
    const { tr } = renderCard({ stats: undefined });

    expect(tileCount(tr)).toBe(4);
    expect(nodeText(tr, `${PREFIX}-pending-value`)).toContain('0');
    expect(nodeText(tr, `${PREFIX}-approved-value`)).toContain('0');
    expect(nodeText(tr, `${PREFIX}-rejected-value`)).toContain('0');
    expect(nodeText(tr, `${PREFIX}-median-value`)).toContain('transparencyStatsMedianTimeUnknown');
  });

  it('5. hostile counts: NaN / negative / missing counts render 0, never "NaN"', () => {
    const { tr } = renderCard({
      stats: { pending: NaN, approved: -4, rejected: undefined, medianTimeToDecisionMs: undefined },
    });

    expect(nodeText(tr, `${PREFIX}-pending-value`)).toContain('0');
    expect(nodeText(tr, `${PREFIX}-approved-value`)).toContain('0');
    expect(nodeText(tr, `${PREFIX}-rejected-value`)).toContain('0');

    const full = treeText(tr);
    expect(full).not.toContain('NaN');
  });
});
