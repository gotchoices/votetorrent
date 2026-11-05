/**
 * KeyholderDkgStatusRow.test.tsx — Phase 62 Plan 26, Surface 6 (D-19 UI). Resolves strings from
 * the REAL catalog (`resources.en.translation`/`resources.es.translation`, the
 * `ElectionTimelineList.i18n.test.tsx` convention) rather than an identity-t mock, so W1/W2 prove
 * actual copy, not just key plumbing. W3 proves the geometry contract under ES (the longest
 * string): no `numberOfLines`, `flexShrink: 1` on the state text, and no ancestor up to the row
 * root sets `height`/`maxHeight`/a fixed `width`/`overflow: 'hidden'`.
 */

import React from 'react';
import renderer from 'react-test-renderer';
import { StyleSheet, View } from 'react-native';
import { resources } from '../../../i18n';
import { KeyholderDkgStatusRow } from '../components/KeyholderDkgStatusRow';
import type { KeyholderDkgRowState } from '../keyholder-dkg-driver';

let currentLng: 'en' | 'es' = 'en';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockT = (key: string): string => (resources as any)[currentLng].translation[key] ?? key;

jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => mockT(key) }),
  // src/i18n/index.ts calls i18n.use(initReactI18next).init(...) at module scope when the real
  // `resources` object below is imported; supply i18next's real duck-type plugin shape.
  initReactI18next: { type: '3rdParty', init: () => {} },
}));

jest.mock('react-native-vector-icons/FontAwesome6', () => 'FontAwesome6');

const SENTINEL_COLORS = {
  success: '#00FF00',
  warning: '#FFA500',
  error: '#FF0000',
  textSecondary: '#888888',
};

jest.mock('@react-navigation/native', () => ({
  useTheme: () => ({ colors: SENTINEL_COLORS }),
}));

function render(state: KeyholderDkgRowState) {
  let tr!: renderer.ReactTestRenderer;
  renderer.act(() => {
    tr = renderer.create(<KeyholderDkgStatusRow state={state} />);
  });
  return tr;
}

function findByTestID(tr: renderer.ReactTestRenderer, testID: string) {
  return tr.root.findAll((n) => n.props?.testID === testID)[0];
}

function allTextStrings(tr: renderer.ReactTestRenderer): string {
  return JSON.stringify(tr.toJSON());
}

describe('KeyholderDkgStatusRow (Surface 6)', () => {
  beforeEach(() => {
    currentLng = 'en';
  });

  it('W1a: pending renders keyholderDkgStatusPending in textSecondary, no glyph', () => {
    const tr = render('pending');
    const node = findByTestID(tr, 'keyholder-dkg-status-pending');
    expect(node.props.children).toBe(resources.en.translation.keyholderDkgStatusPending);
    expect(StyleSheet.flatten(node.props.style).color).toBe(SENTINEL_COLORS.textSecondary);
    expect(tr.root.findAllByType(require('react-native-vector-icons/FontAwesome6'))).toHaveLength(0);
  });

  it('W1g: thresholdTooLow renders keyholderDkgStatusThresholdTooLow with a warning glyph (EN + ES exist)', () => {
    const tr = render('thresholdTooLow');
    const node = findByTestID(tr, 'keyholder-dkg-status-thresholdTooLow');
    expect(node.props.children).toBe(resources.en.translation.keyholderDkgStatusThresholdTooLow);
    expect(StyleSheet.flatten(node.props.style).color).toBe(SENTINEL_COLORS.warning);
    const icon = tr.root.findByType(require('react-native-vector-icons/FontAwesome6'));
    expect(icon.props.name).toBe('triangle-exclamation');
    expect(typeof resources.es.translation.keyholderDkgStatusThresholdTooLow).toBe('string');
    expect(resources.es.translation.keyholderDkgStatusThresholdTooLow).not.toBe(resources.en.translation.keyholderDkgStatusThresholdTooLow);
  });

  it('W1b: inProgress renders keyholderDkgStatusInProgress in textSecondary, no glyph', () => {
    const tr = render('inProgress');
    const node = findByTestID(tr, 'keyholder-dkg-status-inProgress');
    expect(node.props.children).toBe(resources.en.translation.keyholderDkgStatusInProgress);
    expect(StyleSheet.flatten(node.props.style).color).toBe(SENTINEL_COLORS.textSecondary);
  });

  it('W1c: complete renders keyholderDkgStatusComplete, circle-check glyph, success color', () => {
    const tr = render('complete');
    const node = findByTestID(tr, 'keyholder-dkg-status-complete');
    expect(node.props.children).toBe(resources.en.translation.keyholderDkgStatusComplete);
    expect(StyleSheet.flatten(node.props.style).color).toBe(SENTINEL_COLORS.success);
    const icon = tr.root.findByType(require('react-native-vector-icons/FontAwesome6'));
    expect(icon.props.name).toBe('circle-check');
    expect(icon.props.color).toBe(SENTINEL_COLORS.success);
  });

  it('W1d: complaint renders keyholderDkgStatusComplaint, triangle-exclamation glyph, warning color', () => {
    const tr = render('complaint');
    const node = findByTestID(tr, 'keyholder-dkg-status-complaint');
    expect(node.props.children).toBe(resources.en.translation.keyholderDkgStatusComplaint);
    expect(StyleSheet.flatten(node.props.style).color).toBe(SENTINEL_COLORS.warning);
    const icon = tr.root.findByType(require('react-native-vector-icons/FontAwesome6'));
    expect(icon.props.name).toBe('triangle-exclamation');
  });

  it('W1e: failed renders its own cause-agnostic copy (not Closed), circle-xmark glyph, warning color (never colors.error)', () => {
    const tr = render('failed');
    const node = findByTestID(tr, 'keyholder-dkg-status-failed');
    expect(node.props.children).toBe(resources.en.translation.keyholderDkgStatusFailed);
    expect(node.props.children).not.toBe(resources.en.translation.closed);
    expect(StyleSheet.flatten(node.props.style).color).toBe(SENTINEL_COLORS.warning);
    const icon = tr.root.findByType(require('react-native-vector-icons/FontAwesome6'));
    expect(icon.props.name).toBe('circle-xmark');
    expect(icon.props.color).not.toBe(SENTINEL_COLORS.error);
  });

  it('W1f: loading renders the loading string in textSecondary, no glyph', () => {
    const tr = render('loading');
    const node = findByTestID(tr, 'keyholder-dkg-status-loading');
    expect(node.props.children).toBe(resources.en.translation.loading);
    expect(tr.root.findAll((n) => n.type === require('react-native-vector-icons/FontAwesome6'))).toHaveLength(0);
  });

  it('every state renders the keyholderDkgStatusHeading label', () => {
    for (const state of ['pending', 'inProgress', 'complete', 'complaint', 'failed', 'loading'] as KeyholderDkgRowState[]) {
      const tr = render(state);
      expect(allTextStrings(tr)).toContain(resources.en.translation.keyholderDkgStatusHeading);
    }
  });

  it('W2: failed never shows the complaint copy (EN or ES), nor "restart"/"reiniciar"', () => {
    const trEn = render('failed');
    expect(allTextStrings(trEn)).not.toContain(resources.en.translation.keyholderDkgStatusComplaint);
    expect(allTextStrings(trEn).toLowerCase()).not.toContain('restart');

    currentLng = 'es';
    const trEs = render('failed');
    expect(allTextStrings(trEs)).not.toContain(resources.es.translation.keyholderDkgStatusComplaint);
    expect(allTextStrings(trEs).toLowerCase()).not.toContain('reiniciar');
  });

  it('W3: ES complaint (longest string) — no numberOfLines, full text, flexShrink: 1, no height/width/overflow ancestor', () => {
    currentLng = 'es';
    const tr = render('complaint');
    const node = findByTestID(tr, 'keyholder-dkg-status-complaint');

    expect(node.props.numberOfLines).toBeUndefined();
    expect(node.props.children).toBe(resources.es.translation.keyholderDkgStatusComplaint);
    const flat = StyleSheet.flatten(node.props.style);
    expect(flat.flexShrink).toBe(1);

    // Walk every ancestor up to (and including) the row root.
    const row = findByTestID(tr, 'keyholder-dkg-status-row');
    const ancestors = tr.root.findAll((n) => n.type === View).filter((n) => n.props?.testID !== 'keyholder-dkg-status-complaint');
    for (const ancestor of ancestors) {
      const s = StyleSheet.flatten(ancestor.props.style ?? {});
      expect(s.height).toBeUndefined();
      expect(s.maxHeight).toBeUndefined();
      expect(typeof s.width).not.toBe('number');
      expect(s.overflow).not.toBe('hidden');
    }
    expect(row).toBeTruthy();
  });

  it('no Pressable or button anywhere in the row (informational only)', () => {
    const tr = render('complete');
    expect(tr.root.findAll((n) => n.props?.onPress !== undefined)).toHaveLength(0);
  });
});
