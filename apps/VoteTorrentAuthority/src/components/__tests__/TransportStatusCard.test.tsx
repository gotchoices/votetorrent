/**
 * TransportStatusCard — D-01/D-11 proofs.
 *
 * Suites A-E (this file, Task 2) prove the filesystem/REST cards: transportCopy pairs
 * testIDBase/headingKey/bodyKey correctly per (kind, syncState), TRANSPORT_STATE_ICONS resolves
 * the right icon/colorRole, the six rendered (kind, syncState) combinations show the right
 * heading+body+icon+color together, the disabled control renders-not-hides, and the counts line
 * omits undefined segments.
 *
 * 62-21: the retired `Experimental`-prefixed peer card and its baseline/severance suites (formerly F-H) are
 * DELETED from this file — the peer card is now `PeerTransportStatusCard.tsx` (D-31), which has
 * its own test file (`PeerTransportStatusCard.test.tsx`) proving the equivalent structural-severance
 * guarantee for its (now live-count) presentation.
 *
 * testIDBase inventory this file proves (built from `${kind}-${syncState}`, all six pairs are
 * exercised below), e.g. `transport-status-filesystem-never` and `transport-status-rest-success`.
 *
 * WHAT THIS SUITE PROVES, AND WHAT IT DOES NOT (48-24, closing 48-UAT.md gap 1 / DEFECT-2):
 * Suites E2/E3 prove which i18n KEY is selected in each of the six state-by-date-presence cells
 * per kind (twelve cells total), and that the dateless "Last synced" render the UAT photographed
 * is now unreachable in code — `bulkImportSyncLastSyncedLabel` has exactly one call site in the
 * source, guarded on `lastSyncedAt` truthiness. It does NOT prove that the resulting sentence is
 * legible, correctly sized, or unclipped on a real 360dp viewport in either locale, because
 * `react-test-renderer` has no layout engine — it has no notion of pixels, wrapping, clipping, or
 * font metrics at all. That claim is discharged only by 48-28's on-device leg. This is stated here,
 * not only in a planning document, because the UAT's own finding was that "renders in code"
 * standing in for "observable on screen" is exactly what let this defect ship in the first place.
 */

import fs from 'fs';
import path from 'path';
import React from 'react';
import renderer from 'react-test-renderer';

// ---------------------------------------------------------------------------
// Mock preamble — copied from SyncChip.test.tsx.
// ---------------------------------------------------------------------------

// Mock react-i18next: no i18next instance is initialized in this isolated unit test. `t` echoes
// its key plus a serialized interpolation object when one is passed (the
// `RegistrantDetailScreen.accessTrail.test.tsx` pattern) — these assertions are about key
// *selection* (and, for the date line, that the raw value reaches the string), never about copy
// text, which 48-03's own gates own.
jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options && Object.keys(options).length > 0
        ? key +
          '|' +
          Object.entries(options)
            .map(([k, v]) => k + '=' + String(v))
            .join(',')
        : key,
  }),
}));

// Sentinel palette — visually impossible, uniquely greppable color strings so a color assertion
// is an exact string match rather than a judgement call. Every color assertion in this suite is a
// substring test against a serialized rendered subtree.
const SENTINEL_COLORS = {
  accent: '#ACCENT0',
  success: '#SUCCES0',
  error: '#ERROR00',
  warning: '#WARN000',
  textSecondary: '#MUTED00',
  card: '#CARD000',
  text: '#TEXT000',
  dark: '#DARK000',
  light: '#LIGHT00',
  primary: '#PRIMAR0',
};

jest.mock('@react-navigation/native', () => ({
  useTheme: () => ({ colors: SENTINEL_COLORS }),
}));

jest.mock('react-native-vector-icons/FontAwesome6', () => 'FontAwesome6');

// eslint-disable-next-line @typescript-eslint/no-var-requires
const {
  TransportStatusCard,
  transportCopy,
  TRANSPORT_STATE_ICONS,
  TRANSPORT_BODY_KEYS,
} = require('../TransportStatusCard');

function renderCard(tree: React.ReactElement): renderer.ReactTestRenderer {
  let tr!: renderer.ReactTestRenderer;
  renderer.act(() => {
    tr = renderer.create(tree);
  });
  return tr;
}

// `findAll` matches BOTH the composite (component/forwardRef) fiber and the host
// (platform-primitive) fiber for the same element — a `View` with a given `testID` therefore
// counts twice unless filtered to host nodes only (`typeof node.type === 'string'`). This mirrors
// the convention in TransparencyStatsCard.test.tsx.
function findByTestID(
  root: renderer.ReactTestInstance,
  id: string,
): renderer.ReactTestInstance[] {
  return root.findAll(
    (node) => typeof node.type === 'string' && node.props.testID === id,
  );
}

// `ReactTestInstance` has no `.toJSON()` (that only exists on the top-level renderer). This walks
// a subtree and concatenates each node's non-children props (JSON-stringified) plus leaf text, so
// substring assertions (colors, i18n keys) can run against an arbitrary subtree, not just the
// whole page.
function serializeSubtree(node: renderer.ReactTestInstance): string {
  const parts: string[] = [];
  function visit(n: renderer.ReactTestInstance | string): void {
    if (typeof n === 'string') {
      parts.push(n);
      return;
    }
    const { children: _children, ...rest } = n.props;
    try {
      parts.push(JSON.stringify(rest));
    } catch {
      // Non-serializable prop bag (e.g. a function-valued prop that circularly references the
      // fiber) — skip, the leaf text/other props still get walked.
    }
    n.children.forEach(visit);
  }
  visit(node);
  return parts.join('|');
}

function findHostDescendants(
  root: renderer.ReactTestInstance,
  predicate: (node: renderer.ReactTestInstance) => boolean,
): renderer.ReactTestInstance[] {
  return root.findAll((node) => typeof node.type === 'string' && predicate(node));
}

const KINDS = ['filesystem', 'rest'] as const;
const STATES = ['never', 'success', 'error'] as const;

// ---------------------------------------------------------------------------
// Suite A — transportCopy as a pure unit (no rendering).
// ---------------------------------------------------------------------------

describe('transportCopy — pure resolver', () => {
  const expectedHeadingKey = {
    filesystem: 'bulkImportSyncFilesystemHeading',
    rest: 'bulkImportSyncRestHeading',
  };
  // Three DISTINCT body keys, one per state — this is the exhaustive-Record contract Task 2
  // introduces. The `error` row is the assertion that is RED against today's two-way ternary,
  // which collapses `error` into `bulkImportSyncLastSyncedLabel`.
  const expectedBodyKey = {
    never: 'bulkImportSyncNeverSyncedBody',
    success: 'bulkImportSyncSyncedBody',
    error: 'bulkImportSyncErrorBody',
  };

  for (const kind of KINDS) {
    for (const state of STATES) {
      it(`returns testIDBase/headingKey/bodyKey together for (${kind}, ${state})`, () => {
        const copy = transportCopy(kind, state);
        expect(copy.testIDBase).toBe(`transport-status-${kind}-${state}`);
        expect(copy.headingKey).toBe(expectedHeadingKey[kind]);
        expect(copy.bodyKey).toBe(expectedBodyKey[state]);
      });
    }
  }

  it('heading key is a pure function of kind alone, across all six pairs', () => {
    for (const kind of KINDS) {
      const headingKeys = STATES.map((state) => transportCopy(kind, state).headingKey);
      expect(new Set(headingKeys).size).toBe(1);
      expect(headingKeys[0]).toBe(expectedHeadingKey[kind]);
    }
  });

  it('body key is a pure function of syncState alone, across all six pairs', () => {
    for (const state of STATES) {
      const bodyKeys = KINDS.map((kind) => transportCopy(kind, state).bodyKey);
      expect(new Set(bodyKeys).size).toBe(1);
      expect(bodyKeys[0]).toBe(expectedBodyKey[state]);
    }
  });

  it('the three body keys are pairwise distinct, and bulkImportSyncLastSyncedLabel is not among them', () => {
    const bodyKeys = STATES.map((state) => expectedBodyKey[state]);
    expect(new Set(bodyKeys).size).toBe(bodyKeys.length);
    expect(bodyKeys).not.toContain('bulkImportSyncLastSyncedLabel');
  });
});

// ---------------------------------------------------------------------------
// Suite B2 — TRANSPORT_BODY_KEYS shape: exhaustive over the three-valued state, mirroring
// TRANSPORT_STATE_ICONS's own Record shape so a future fourth state is a compile error rather
// than a silent fallthrough.
// ---------------------------------------------------------------------------

describe('TRANSPORT_BODY_KEYS — shape', () => {
  it('has exactly three own keys, matching Object.keys(TRANSPORT_STATE_ICONS)', () => {
    expect(Object.keys(TRANSPORT_BODY_KEYS).sort()).toEqual(
      Object.keys(TRANSPORT_STATE_ICONS).sort(),
    );
    expect(Object.keys(TRANSPORT_BODY_KEYS).sort()).toEqual(['error', 'never', 'success']);
  });

  it('maps each state to its own distinct body key', () => {
    expect(TRANSPORT_BODY_KEYS).toEqual({
      never: 'bulkImportSyncNeverSyncedBody',
      success: 'bulkImportSyncSyncedBody',
      error: 'bulkImportSyncErrorBody',
    });
  });
});

// ---------------------------------------------------------------------------
// Suite B — TRANSPORT_STATE_ICONS shape.
// ---------------------------------------------------------------------------

describe('TRANSPORT_STATE_ICONS — shape', () => {
  it('has exactly three keys', () => {
    expect(Object.keys(TRANSPORT_STATE_ICONS).sort()).toEqual(['error', 'never', 'success']);
  });

  it('maps never -> circle-question / muted', () => {
    expect(TRANSPORT_STATE_ICONS.never).toEqual({ icon: 'circle-question', colorRole: 'muted' });
  });

  it('maps success -> circle-check / success', () => {
    expect(TRANSPORT_STATE_ICONS.success).toEqual({ icon: 'circle-check', colorRole: 'success' });
  });

  it('maps error -> circle-xmark / error', () => {
    expect(TRANSPORT_STATE_ICONS.error).toEqual({ icon: 'circle-xmark', colorRole: 'error' });
  });
});

// ---------------------------------------------------------------------------
// Suite C — rendered filesystem/REST cards, all three states, both kinds (six renders).
// ---------------------------------------------------------------------------

describe('TransportStatusCard — rendered state proofs', () => {
  const expectedIconColor: Record<string, string> = {
    never: SENTINEL_COLORS.textSecondary,
    success: SENTINEL_COLORS.success,
    error: SENTINEL_COLORS.error,
  };
  const expectedIconName: Record<string, string> = {
    never: 'circle-question',
    success: 'circle-check',
    error: 'circle-xmark',
  };

  for (const kind of KINDS) {
    for (const state of STATES) {
      it(`renders the ${state} state correctly for kind=${kind} (root, icon, heading+body together)`, () => {
        const onSyncNow = jest.fn();
        const tree = renderCard(
          <TransportStatusCard kind={kind} syncState={state} onSyncNow={onSyncNow} />,
        );

        // Root node exists.
        expect(findByTestID(tree.root, `transport-status-card-${kind}`)).toHaveLength(1);

        // Icon carries the expected name and sentinel color.
        const iconWrap = findByTestID(tree.root, `transport-status-icon-${kind}`)[0];
        const iconNode = iconWrap.findByType('FontAwesome6' as never);
        expect(iconNode.props.name).toBe(expectedIconName[state]);
        expect(iconNode.props.color).toBe(expectedIconColor[state]);

        // Heading and body asserted together, in the same test, so a mismatch fails as one
        // named failure.
        const copy = transportCopy(kind, state);
        const headingNode = findByTestID(tree.root, `${copy.testIDBase}-heading`)[0];
        const bodyNode = findByTestID(tree.root, `${copy.testIDBase}-body`)[0];
        expect(serializeSubtree(headingNode)).toContain(copy.headingKey);
        expect(serializeSubtree(bodyNode)).toContain(copy.bodyKey);
      });
    }

    it(`Sync Now button (kind=${kind}) is accent-colored and never warning-colored`, () => {
      const onSyncNow = jest.fn();
      const tree = renderCard(
        <TransportStatusCard kind={kind} syncState="never" onSyncNow={onSyncNow} />,
      );
      const buttonSubtree = findByTestID(tree.root, `transport-sync-now-${kind}`)[0];
      const serialized = serializeSubtree(buttonSubtree);
      expect(serialized).toContain(SENTINEL_COLORS.accent);
      expect(serialized).not.toContain(SENTINEL_COLORS.warning);
    });
  }
});

// ---------------------------------------------------------------------------
// Suite D — the disabled legibility contract. Legibility control, NOT a security boundary —
// the 'vrg' scope gate is not enforcement (Phase 999.1).
// ---------------------------------------------------------------------------

describe('TransportStatusCard — disabled legibility contract', () => {
  for (const kind of KINDS) {
    it(`renders the Sync Now control (not hidden) with disabled=true for kind=${kind}, and does not invoke onSyncNow`, () => {
      const onSyncNow = jest.fn();
      const tree = renderCard(
        <TransportStatusCard kind={kind} syncState="never" disabled onSyncNow={onSyncNow} />,
      );
      const buttonWrap = findByTestID(tree.root, `transport-sync-now-${kind}`)[0];
      expect(buttonWrap).toBeDefined();

      // `disabled` is consumed by TouchableOpacity itself (a composite, not a host primitive) —
      // it is never forwarded onto the underlying host View, so this search deliberately does
      // NOT filter to host-only nodes the way findByTestID/findHostDescendants do elsewhere.
      const disabledTouchables = buttonWrap.findAll((node) => node.props.disabled === true);
      expect(disabledTouchables.length).toBeGreaterThanOrEqual(1);
      disabledTouchables[0].props.onPress?.();
      expect(onSyncNow).not.toHaveBeenCalled();
    });
  }
});

// ---------------------------------------------------------------------------
// Suite E — counts line.
// ---------------------------------------------------------------------------

describe('TransportStatusCard — counts line', () => {
  for (const kind of KINDS) {
    it(`omits the counts node (kind=${kind}) when all three counts are undefined`, () => {
      const onSyncNow = jest.fn();
      const tree = renderCard(
        <TransportStatusCard kind={kind} syncState="never" onSyncNow={onSyncNow} />,
      );
      expect(findByTestID(tree.root, `transport-status-counts-${kind}`)).toHaveLength(0);
    });

    it(`renders only the imported segment (kind=${kind}) when importedCount=12 and the rest are undefined`, () => {
      const onSyncNow = jest.fn();
      const tree = renderCard(
        <TransportStatusCard
          kind={kind}
          syncState="success"
          importedCount={12}
          onSyncNow={onSyncNow}
        />,
      );
      const countsNode = findByTestID(tree.root, `transport-status-counts-${kind}`)[0];
      expect(countsNode).toBeDefined();
      const serialized = serializeSubtree(countsNode);
      expect(serialized).toContain('bulkImportSyncImportedCountLabel');
      expect(serialized).not.toContain('bulkImportSyncPendingCountLabel');
      expect(serialized).not.toContain('bulkImportSyncErrorCountLabel');
    });
  }
});

// ---------------------------------------------------------------------------
// Suite E2 — the state-by-date-presence render matrix (48-UAT.md gap 1 / DEFECT-2). Six cells per
// kind (three states x date-present/date-absent) = twelve total across both kinds. Proves the
// dateless "Last synced" render this UAT photographed is now unreachable, and that
// `bulkImportSyncLastSyncedLabel` never leaks into the body node, in every one of the twelve
// cells — including the `error` + no-date cell, the exact cell the UAT photographed.
// ---------------------------------------------------------------------------

describe('TransportStatusCard — state-by-date-presence render matrix (48-UAT.md gap 1)', () => {
  const SENTINEL_TIMESTAMP = '2026-08-05T12:00:00Z';
  // WR-18: the date line renders the FORMATTED value, not the raw ISO-8601 one.
  const SENTINEL_DATE = '2026-08-05';
  const expectedBodyKey = {
    never: 'bulkImportSyncNeverSyncedBody',
    success: 'bulkImportSyncSyncedBody',
    error: 'bulkImportSyncErrorBody',
  };

  for (const kind of KINDS) {
    for (const state of STATES) {
      it(`kind=${kind} state=${state}, lastSyncedAt UNDEFINED: no date line, body is the state's own key, never bulkImportSyncLastSyncedLabel`, () => {
        const onSyncNow = jest.fn();
        const tree = renderCard(
          <TransportStatusCard kind={kind} syncState={state} onSyncNow={onSyncNow} />,
        );

        expect(
          findByTestID(tree.root, `transport-status-last-synced-${kind}`),
        ).toHaveLength(0);

        const bodyNode = findByTestID(tree.root, `transport-status-${kind}-${state}-body`)[0];
        const serialized = serializeSubtree(bodyNode);
        expect(serialized).toContain(expectedBodyKey[state]);
        expect(serialized).not.toContain('bulkImportSyncLastSyncedLabel');
      });

      it(`kind=${kind} state=${state}, lastSyncedAt SET: date line present and carries the FORMATTED date (never the raw ISO string), body is still the state's own key`, () => {
        const onSyncNow = jest.fn();
        const tree = renderCard(
          <TransportStatusCard
            kind={kind}
            syncState={state}
            lastSyncedAt={SENTINEL_TIMESTAMP}
            onSyncNow={onSyncNow}
          />,
        );

        const dateNode = findByTestID(tree.root, `transport-status-last-synced-${kind}`)[0];
        expect(dateNode).toBeDefined();
        const dateSerialized = serializeSubtree(dateNode);
        expect(dateSerialized).toContain('bulkImportSyncLastSyncedLabel');
        // WR-18: this assertion previously read `toContain(SENTINEL_TIMESTAMP)` and so pinned the
        // defect in place — this card was the only timestamp surface in the phase that rendered
        // `2026-08-05T12:00:00Z` where the inbox row, the approval summary and the rejected block
        // all render `2026-08-05`. Both directions are asserted so a silent revert to raw
        // interpolation goes red rather than merely passing a weaker check.
        expect(dateSerialized).toContain(SENTINEL_DATE);
        expect(dateSerialized).not.toContain(SENTINEL_TIMESTAMP);

        const bodyNode = findByTestID(tree.root, `transport-status-${kind}-${state}-body`)[0];
        const bodySerialized = serializeSubtree(bodyNode);
        expect(bodySerialized).toContain(expectedBodyKey[state]);
        expect(bodySerialized).not.toContain('bulkImportSyncLastSyncedLabel');
      });
    }
  }
});

// ---------------------------------------------------------------------------
// Suite E3 — source-level gate on TransportStatusCard.tsx (comments stripped, since the file's own
// header prose names these identifiers and an unfiltered count would be self-invalidating).
// ---------------------------------------------------------------------------

describe('TransportStatusCard.tsx — source-level gate (comments stripped)', () => {
  function sourceWithoutComments(): string {
    const raw = fs.readFileSync(path.resolve(__dirname, '../TransportStatusCard.tsx'), 'utf8');
    return raw
      .split('\n')
      .filter((line) => !/^\s*\*/.test(line) && !/^\s*\/\//.test(line))
      .join('\n');
  }

  it('bulkImportSyncLastSyncedLabel appears exactly once', () => {
    const src = sourceWithoutComments();
    const occurrences = (src.match(/bulkImportSyncLastSyncedLabel/g) || []).length;
    expect(occurrences).toBe(1);
  });

  it('t(copy.bodyKey appears exactly once and is followed by ) with no interpolation object', () => {
    const src = sourceWithoutComments();
    const occurrences = (src.match(/t\(copy\.bodyKey/g) || []).length;
    expect(occurrences).toBe(1);
    expect(src).toMatch(/t\(copy\.bodyKey\)/);
    expect(src).not.toMatch(/t\(copy\.bodyKey,/);
  });
});
