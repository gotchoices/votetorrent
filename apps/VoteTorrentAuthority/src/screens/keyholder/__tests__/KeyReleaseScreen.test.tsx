/**
 * KeyReleaseScreen.test.tsx — S1-S6 (Surface 6 key release ceremony). Real catalog strings for EN
 * and ES (not an identity-t mock), `releaseKeyholderShare` mocked while `keyReleaseErrorCopyKey`
 * stays real. There is no layout engine in jest, so "geometry" means flattened style props and
 * render-tree order.
 */

import React from 'react';
import renderer from 'react-test-renderer';
import { StyleSheet, TouchableOpacity } from 'react-native';
import { resources } from '../../../i18n';

let mockLng: 'en' | 'es' = 'en';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockCatalog = (lng: 'en' | 'es', key: string): string => (resources as any)[lng].translation[key] ?? key;

jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => mockCatalog(mockLng, key) }),
  initReactI18next: { type: '3rdParty', init: () => {} },
}));

jest.mock('react-native-vector-icons/FontAwesome6', () => 'FontAwesome6');

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
};

let mockTask: unknown;

jest.mock('@react-navigation/native', () => ({
  useTheme: () => ({ dark: false, colors: PALETTE }),
  useRoute: () => ({ params: { task: mockTask } }),
}));

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

jest.mock('../../../providers/AppProvider', () => ({
  useApp: () => ({ getEngine: jest.fn() }),
}));

jest.mock('../../../engines/keyholder-vault', () => ({
  resolveKeyholderKeyVault: () => ({}),
}));

const mockRelease = jest.fn();
jest.mock('../key-release-ceremony', () => {
  const actual = jest.requireActual('../key-release-ceremony');
  return { ...actual, releaseKeyholderShare: (...args: unknown[]) => mockRelease(...args) };
});

// eslint-disable-next-line @typescript-eslint/no-var-requires
const KeyReleaseScreen = require('../KeyReleaseScreen').default;

const LONG_TITLE = 'Statewide General Election For The Office Of County Clerk 2026 X';

function render() {
  let tr!: renderer.ReactTestRenderer;
  renderer.act(() => {
    tr = renderer.create(<KeyReleaseScreen />);
  });
  return tr;
}

function byId(tr: renderer.ReactTestRenderer, testID: string) {
  return tr.root.findAll((n) => n.props?.testID === testID && typeof n.type === 'string');
}

function one(tr: renderer.ReactTestRenderer, testID: string) {
  const found = byId(tr, testID);
  expect(found).toHaveLength(1);
  return found[0]!;
}

function textOf(node: renderer.ReactTestInstance): string {
  const parts: string[] = [];
  const walk = (n: renderer.ReactTestInstance | string) => {
    if (typeof n === 'string') parts.push(n);
    else n.children.forEach(walk);
  };
  walk(node);
  return parts.join('');
}

function button(tr: renderer.ReactTestRenderer) {
  return tr.root.findByType(TouchableOpacity);
}

async function flush() {
  await renderer.act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function pendingRelease() {
  let resolve!: (v: unknown) => void;
  const promise = new Promise((r) => {
    resolve = r;
  });
  mockRelease.mockReturnValueOnce(promise);
  return resolve;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockLng = 'en';
  mockTask = {
    type: 'release-key',
    userId: 'kh-1',
    network: { name: 'Test Network' },
    election: { election: { title: LONG_TITLE } },
  };
});

describe('KeyReleaseScreen (Surface 6)', () => {
  it.each(['en', 'es'] as const)('S1 anchors (%s): error slot, body, button in order inside the card; full copy; card colour', (lng) => {
    mockLng = lng;
    const tr = render();
    const card = one(tr, 'key-release-card');

    expect(StyleSheet.flatten(card.props.style).backgroundColor).toBe(PALETTE.card);
    expect(textOf(one(tr, 'key-release-body'))).toBe(mockCatalog(lng, 'keyholderReleaseBody'));
    expect(textOf(one(tr, 'key-release-election-title'))).toBe(LONG_TITLE);
    expect(LONG_TITLE).toHaveLength(64);
    expect(button(tr).props.accessibilityLabel).toBe(mockCatalog(lng, 'keyholderReleaseButton'));

    // Tree order: the InlineError slot (empty, so nothing rendered) comes before the card, and the
    // body comes before the release button in a depth-first walk of the whole screen.
    expect(byId(tr, 'key-release-error')).toHaveLength(0);
    const order: string[] = [];
    const walk = (n: renderer.ReactTestInstance | string) => {
      if (typeof n === 'string') return;
      const id = n.props?.testID;
      if (typeof n.type === 'string' && (id === 'key-release-card' || id === 'key-release-body' || id === 'key-release-button')) order.push(id);
      n.children.forEach(walk);
    };
    walk(tr.root);
    expect(order).toEqual(['key-release-card', 'key-release-body', 'key-release-button']);
    expect(card.findAll((n) => n.props?.testID === 'key-release-body')).not.toHaveLength(0);
  });

  it.each(['en', 'es'] as const)('S2 geometry (%s): no truncation, shrinkable text, no clipping ancestor, 56pt button', (lng) => {
    mockLng = lng;
    const tr = render();
    for (const id of ['key-release-body', 'key-release-election-title']) {
      const node = one(tr, id);
      expect(node.props.numberOfLines).toBeUndefined();
      expect(node.props.ellipsizeMode).toBeUndefined();
      expect(StyleSheet.flatten(node.props.style).flexShrink).toBe(1);
      let anc: renderer.ReactTestInstance | null = node.parent;
      while (anc) {
        const flat = (StyleSheet.flatten(anc.props?.style) ?? {}) as Record<string, unknown>;
        expect(flat.height).toBeUndefined();
        expect(flat.maxHeight).toBeUndefined();
        expect(flat.overflow).not.toBe('hidden');
        anc = anc.parent;
      }
    }
    // Measured as button-radius-padding.test.tsx does: the tall box is paddingVertical 16*2 + minHeight 24.
    const flat = StyleSheet.flatten(button(tr).props.style) as Record<string, number>;
    expect(flat.paddingVertical * 2 + 24).toBeGreaterThanOrEqual(44);
  });

  it('S3 in flight: shows the in-progress line, disables the button, and a second press leaves one call', async () => {
    const resolve = pendingRelease();
    const tr = render();

    await renderer.act(async () => {
      button(tr).props.onPress();
    });
    expect(textOf(one(tr, 'key-release-in-progress'))).toBe(mockCatalog('en', 'keyholderReleaseInProgress'));
    expect(button(tr).props.disabled).toBe(true);

    await renderer.act(async () => {
      button(tr).props.onPress();
    });
    expect(mockRelease).toHaveBeenCalledTimes(1);

    await renderer.act(async () => {
      resolve({ kind: 'released' });
    });
    await flush();
  });

  it('S4 success: success line with a circle-check glyph in the success colour, button disabled not hidden, no error', async () => {
    mockRelease.mockResolvedValueOnce({ kind: 'released' });
    const tr = render();
    await renderer.act(async () => {
      button(tr).props.onPress();
    });
    await flush();

    const success = one(tr, 'key-release-success');
    expect(textOf(success)).toContain(mockCatalog('en', 'keyholderReleaseSuccess'));
    const glyph = success.findAll((n) => n.props?.name === 'circle-check');
    expect(glyph.length).toBeGreaterThan(0);
    expect(glyph[0]!.props.color).toBe(PALETTE.success);
    expect(button(tr).props.disabled).toBe(true);
    expect(byId(tr, 'key-release-in-progress')).toHaveLength(0);
    expect(JSON.stringify(tr.toJSON())).not.toContain(mockCatalog('en', 'keyholderReleaseError'));
  });

  it('S5 biometric denial: shows the generic verify copy and re-enables the button', async () => {
    mockRelease.mockResolvedValueOnce({ kind: 'failed', code: 'auth-denied', authDenied: true });
    const tr = render();
    await renderer.act(async () => {
      button(tr).props.onPress();
    });
    await flush();

    expect(JSON.stringify(tr.toJSON())).toContain(mockCatalog('en', 'deviceSigningErrorGeneric'));
    expect(button(tr).props.disabled).toBe(false);
    expect(byId(tr, 'key-release-success')).toHaveLength(0);
  });

  it('S6 no raw message: any other failure shows the release error copy only, never the code or a hex run', async () => {
    mockRelease.mockResolvedValueOnce({ kind: 'failed', code: 'release-window-not-open', authDenied: false });
    const tr = render();
    await renderer.act(async () => {
      button(tr).props.onPress();
    });
    await flush();

    const json = JSON.stringify(tr.toJSON());
    expect(json).toContain(mockCatalog('en', 'keyholderReleaseError'));
    expect(json).not.toContain('release-window-not-open');
    expect(/[0-9a-f]{64}/i.test(json)).toBe(false);
  });
});
