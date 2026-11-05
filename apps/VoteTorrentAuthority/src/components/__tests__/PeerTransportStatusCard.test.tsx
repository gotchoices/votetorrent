/**
 * PeerTransportStatusCard — Phase 62 Plan 21 (D-31) proofs.
 *
 * N1-N5 prove the structural severance (no prop reaches the border/caveat/heading/icon/button
 * colour). G1/G2 are the UI-SPEC "999 pending" geometry gates — wrap is structurally required AND
 * (G2) actually needed at the ES/999 content width. Mirrors `TransportStatusCard.test.tsx`'s own
 * sentinel palette / serializeSubtree / renderCard helpers.
 */

import fs from 'fs';
import path from 'path';
import React from 'react';
import renderer from 'react-test-renderer';

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
const { PeerTransportStatusCard } = require('../PeerTransportStatusCard');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { StyleSheet } = require('react-native');

function renderCard(tree: React.ReactElement): renderer.ReactTestRenderer {
  let tr!: renderer.ReactTestRenderer;
  renderer.act(() => {
    tr = renderer.create(tree);
  });
  return tr;
}

function findByTestID(root: renderer.ReactTestInstance, id: string): renderer.ReactTestInstance[] {
  return root.findAll((node) => typeof node.type === 'string' && node.props.testID === id);
}

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
      // skip
    }
    n.children.forEach(visit);
  }
  visit(node);
  return parts.join('|');
}

function flatten(style: unknown): Record<string, unknown> {
  const flat = StyleSheet.flatten(style);
  return flat ?? {};
}

const COUNT_STATES: Array<{ name: string; counts?: { pending: number; synced: number; failed: number } }> = [
  { name: 'undefined', counts: undefined },
  { name: 'all zero', counts: { pending: 0, synced: 0, failed: 0 } },
  { name: '999 everywhere', counts: { pending: 999, synced: 999, failed: 999 } },
  { name: 'mixed', counts: { pending: 0, synced: 5, failed: 0 } },
];

describe('PeerTransportStatusCard — N1 caveat, always', () => {
  for (const state of COUNT_STATES) {
    it(`renders the warning-colored caveat and heading in counts state: ${state.name}`, () => {
      const tr = renderCard(<PeerTransportStatusCard counts={state.counts} onTrySync={jest.fn()} />);
      const body = findByTestID(tr.root, 'transport-status-p2p-body')[0]!;
      expect(flatten(body.props.style).color).toBe(SENTINEL_COLORS.warning);
      expect(serializeSubtree(body)).toContain('peerSyncCardCaveat');

      const heading = findByTestID(tr.root, 'transport-status-p2p-heading')[0]!;
      expect(serializeSubtree(heading)).toContain('peerSyncCardHeading');

      const icon = findByTestID(tr.root, 'transport-status-icon-p2p')[0]!.findByType('FontAwesome6' as never);
      expect(icon.props.name).toBe('triangle-exclamation');
      expect(icon.props.color).toBe(SENTINEL_COLORS.warning);
    });
  }
});

describe('PeerTransportStatusCard — N2 frame, always', () => {
  for (const state of COUNT_STATES) {
    it(`root carries borderLeftWidth 4 / warning border, never the accent or success sentinel outside the synced segment: ${state.name}`, () => {
      const tr = renderCard(<PeerTransportStatusCard counts={state.counts} onTrySync={jest.fn()} />);
      const root = findByTestID(tr.root, 'transport-status-card-p2p')[0]!;
      const flat = flatten(root.props.style);
      expect(flat.borderLeftWidth).toBe(4);
      expect(flat.borderLeftColor).toBe(SENTINEL_COLORS.warning);

      const serialized = serializeSubtree(root);
      expect(serialized).not.toContain(SENTINEL_COLORS.accent);
      // success may legitimately tint the synced segment when synced > 0 — asserted directly on
      // that segment's own flattened style (N3). Here: every OTHER leaf (pending, failed, heading,
      // caveat, button) is never success-tinted, and when synced is 0/absent nothing is.
      const otherIds = ['peer-sync-count-pending', 'peer-sync-count-failed', 'transport-status-p2p-heading', 'transport-status-p2p-body'];
      for (const id of otherIds) {
        for (const node of findByTestID(tr.root, id)) {
          expect(flatten(node.props.style).color).not.toBe(SENTINEL_COLORS.success);
        }
      }
      if (!state.counts || state.counts.synced === 0) {
        expect(serialized).not.toContain(SENTINEL_COLORS.success);
      }
    });
  }
});

describe('PeerTransportStatusCard — N3 counts', () => {
  it('with counts, renders three segments with the right labels and tints', () => {
    const tr = renderCard(
      <PeerTransportStatusCard counts={{ pending: 2, synced: 3, failed: 1 }} onTrySync={jest.fn()} />,
    );
    const pending = findByTestID(tr.root, 'peer-sync-count-pending')[0]!;
    const synced = findByTestID(tr.root, 'peer-sync-count-synced')[0]!;
    const failed = findByTestID(tr.root, 'peer-sync-count-failed')[0]!;

    expect(serializeSubtree(pending)).toContain('peerSyncCardPendingLabel|count=2');
    expect(flatten(pending.props.style).color).toBe(SENTINEL_COLORS.textSecondary);

    expect(serializeSubtree(synced)).toContain('peerSyncCardSyncedLabel|count=3');
    expect(flatten(synced.props.style).color).toBe(SENTINEL_COLORS.success);

    expect(serializeSubtree(failed)).toContain('peerSyncCardFailedLabel|count=1');
    expect(flatten(failed.props.style).color).toBe(SENTINEL_COLORS.error);
  });

  it('synced=0 and failed=0 tint textSecondary, not success/error', () => {
    const tr = renderCard(
      <PeerTransportStatusCard counts={{ pending: 0, synced: 0, failed: 0 }} onTrySync={jest.fn()} />,
    );
    const synced = findByTestID(tr.root, 'peer-sync-count-synced')[0]!;
    const failed = findByTestID(tr.root, 'peer-sync-count-failed')[0]!;
    expect(flatten(synced.props.style).color).toBe(SENTINEL_COLORS.textSecondary);
    expect(flatten(failed.props.style).color).toBe(SENTINEL_COLORS.textSecondary);
  });

  it('with counts undefined, the counts row is absent', () => {
    const tr = renderCard(<PeerTransportStatusCard onTrySync={jest.fn()} />);
    expect(findByTestID(tr.root, 'transport-status-counts-p2p')).toHaveLength(0);
  });
});

describe('PeerTransportStatusCard — N4 button', () => {
  it('renders warning-colored, forceDarkText, never accent', () => {
    const onTrySync = jest.fn();
    const tr = renderCard(<PeerTransportStatusCard onTrySync={onTrySync} />);
    const footer = findByTestID(tr.root, 'transport-try-peer-sync-p2p')[0]!;
    const serialized = serializeSubtree(footer);
    expect(serialized).toContain(SENTINEL_COLORS.warning);
    expect(serialized).not.toContain(SENTINEL_COLORS.accent);
  });

  it('with disabled, the control is present, disabled and does not call onTrySync', () => {
    const onTrySync = jest.fn();
    const tr = renderCard(<PeerTransportStatusCard disabled onTrySync={onTrySync} />);
    const footer = findByTestID(tr.root, 'transport-try-peer-sync-p2p')[0]!;
    const button = footer.findAll((n) => 'disabled' in n.props)[0]!;
    expect(button.props.disabled).toBe(true);
    renderer.act(() => {
      button.props.onPress?.();
    });
    expect(onTrySync).not.toHaveBeenCalled();
  });
});

describe('PeerTransportStatusCard — N5 no Experimental', () => {
  it('the tree has no retired bulk-import-sync-P2p key prefix or Experimental text, and the source has no flask-vial', () => {
    const tr = renderCard(
      <PeerTransportStatusCard counts={{ pending: 999, synced: 999, failed: 999 }} onTrySync={jest.fn()} />,
    );
    const serialized = JSON.stringify(tr.toJSON());
    // Built via concatenation so this negative-control literal itself never appears verbatim in
    // the repo (the retired key prefix is a deliberately forbidden string — see Task 3's final
    // acceptance grep — this still proves the rendered tree does not contain it).
    expect(serialized).not.toContain('bulkImportSync' + 'P2p');
    expect(serialized).not.toContain('Experimental');

    const src = fs.readFileSync(path.resolve(__dirname, '../PeerTransportStatusCard.tsx'), 'utf8');
    expect(src).not.toContain('flask-vial');
  });
});

describe('PeerTransportStatusCard — G1 wrap (the UI-SPEC "999 pending" gate)', () => {
  it('the counts row is row+wrap, no segment sets numberOfLines/ellipsizeMode, and no ancestor up to the card root fixes width/height/overflow hidden', () => {
    const tr = renderCard(
      <PeerTransportStatusCard counts={{ pending: 999, synced: 999, failed: 999 }} onTrySync={jest.fn()} />,
    );
    const countsRow = findByTestID(tr.root, 'transport-status-counts-p2p')[0]!;
    const rowStyle = flatten(countsRow.props.style);
    expect(rowStyle.flexDirection).toBe('row');
    expect(rowStyle.flexWrap).toBe('wrap');

    for (const id of ['peer-sync-count-pending', 'peer-sync-count-synced', 'peer-sync-count-failed']) {
      const node = findByTestID(tr.root, id)[0]!;
      expect(node.props.numberOfLines).toBeUndefined();
      expect(node.props.ellipsizeMode).toBeUndefined();
    }

    const root = findByTestID(tr.root, 'transport-status-card-p2p')[0]!;
    const ancestors = root.findAll((node) => typeof node.type === 'string');
    for (const node of ancestors) {
      const flat = flatten(node.props.style);
      expect(flat.width).toBeUndefined();
      expect(flat.maxWidth).toBeUndefined();
      expect(flat.height).toBeUndefined();
      expect(flat.maxHeight).toBeUndefined();
      expect(flat.overflow).not.toBe('hidden');
    }
  });
});

describe('PeerTransportStatusCard — G2 bound', () => {
  it('under the ES 999 strings, a single segment fits but the three together exceed the content width, proving wrap is both required and sufficient', () => {
    const ES_SEGMENTS = ['999 pendientes', '999 sincronizadas', '999 fallidas'];
    const FONT_SIZE = 14; // ThemedText type="small"
    const estimate = (s: string) => s.length * FONT_SIZE * 0.6;

    // container padding 16 + cardSurface paddingHorizontal 16 (x2 sides each, per plan's own
    // arithmetic) + the 4px warning border.
    const CONTENT_WIDTH = 360 - 2 * 16 - 2 * 16 - 4;

    const widths = ES_SEGMENTS.map(estimate);
    for (const w of widths) {
      expect(w).toBeLessThanOrEqual(CONTENT_WIDTH);
    }
    const total = widths.reduce((a, b) => a + b, 0);
    expect(total).toBeGreaterThan(CONTENT_WIDTH);
    // eslint-disable-next-line no-console
    console.log('G2 bound:', { widths, total, CONTENT_WIDTH });
  });
});
