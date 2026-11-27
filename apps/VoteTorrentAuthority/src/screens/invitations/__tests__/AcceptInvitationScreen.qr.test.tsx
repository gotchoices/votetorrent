/**
 * AcceptInvitationScreen.qr.test.tsx - Scan QR code and Choose image on Accept an Invitation.
 *
 * A scan or a decoded image only fills the field, exactly as a paste would: no navigation and no
 * engine call happens until Continue. The scanned value is not hand-typed: it is what jsQR reads off
 * the QR the sender's Keyholder Invitation screen draws. A join code (vote-engine's real-encoder
 * fixture) or any other QR is refused with its own sentence. Camera states come from the
 * VisionCamera manual mock; the image path mocks `engines/qr-image-decode` (its own suite covers
 * the native pipeline). Text comparisons are boolean so a failing matcher never prints a secret.
 */

import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { Linking } from 'react-native';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { bytesToHex } from '@noble/curves/utils.js';
import { JOIN_CODE_FIXTURES } from '@votetorrent/vote-engine/test/fixtures/join-code-fixtures';
import { resources } from '../../../i18n';
import { serializeInviteShare } from '../invite-share';
import { takeInviteShare } from '../invite-share-handoff';
import { tryBuildInvitationQr } from '../../../utils/qr/invite-qr';
import { readQrPngBase64 } from '../../__fixtures__/read-qr-png';
import { captureConsole, expectNoSecretInConsole } from '../../../engines/__fixtures__/console-leak';

jest.mock('@votetorrent/attestation-native', () => ({ setSecureScreen: jest.fn(async () => true) }));
jest.mock('react-native-vector-icons/FontAwesome6', () => 'FontAwesome6');
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
  SafeAreaProvider: ({ children }: { children: unknown }) => children,
}));
jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { resources: res } = require('../../../i18n');
      const value = (res.en.translation as Record<string, string>)[key];
      if (typeof value !== 'string') throw new Error('missing i18n key ' + key);
      return value;
    },
  }),
  initReactI18next: { type: '3rdParty', init: jest.fn() },
}));
jest.mock('../../../providers/SettingsProvider', () => ({ useSettings: () => ({ showHelpIcons: false }) }));
const mockGetEngine = jest.fn();
jest.mock('../../../providers/AppProvider', () => ({ useApp: () => ({ getEngine: mockGetEngine }) }));
const mockReplace = jest.fn();
const mockNavigate = jest.fn();
const mockSetParams = jest.fn();
jest.mock('@react-navigation/native', () => ({
  useTheme: () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require('../../../theme/themes').lightTheme;
  },
  useFocusEffect: (cb: () => void | (() => void)) => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const R = require('react');
    R.useEffect(cb, [cb]);
  },
  useNavigation: () => ({ replace: mockReplace, navigate: mockNavigate, setParams: mockSetParams, goBack: jest.fn(), setOptions: jest.fn() }),
}));
const mockAvailable = jest.fn(() => true);
const mockPick = jest.fn();
jest.mock('../../../engines/qr-image-decode', () => ({
  isQrImageDecodeAvailable: () => mockAvailable(),
  pickImageAndReadQrCodes: () => mockPick(),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { AcceptInvitationScreen } = require('../AcceptInvitationScreen');

interface VcMock {
  __setCameraDevice(d: unknown): void;
  __setCameraPermissionStatus(s: string): void;
  __setCameraPermissionRequestResult(r: unknown): void;
  __cameraPermissionRequestCount(): number;
  __resetVisionCameraMock(): void;
}
interface BsMock {
  __emitBarcodes(b: unknown[]): void;
  __resetBarcodeScannerMock(): void;
}
// eslint-disable-next-line @typescript-eslint/no-var-requires
const vc = require('../../../../__mocks__/react-native-vision-camera.js') as VcMock;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const bs = require('../../../../__mocks__/react-native-vision-camera-barcode-scanner.js') as BsMock;

const en = resources.en.translation as Record<string, string>;
const JOIN_CODE = JOIN_CODE_FIXTURES['v2-1-member'].text;

function invitation(type: 'k' | 'of' | 'au' = 'k'): { text: string; invitePrivate: string } {
  const priv = secp256k1.utils.randomSecretKey();
  const invitePrivate = bytesToHex(priv);
  const text = serializeInviteShare({
    invitePrivate,
    inviteKey: bytesToHex(secp256k1.getPublicKey(priv)),
    expiration: '2026-11-25T09:30:00.000Z',
    type,
    name: 'Kay Holder',
  });
  return { text, invitePrivate };
}
/** What a camera reads off the QR the sender's screen draws for `text`. */
function scannedFromSenderScreen(text: string): string {
  const attempt = tryBuildInvitationQr(text, 984);
  if (!attempt.ok) throw new Error('no QR');
  const read = readQrPngBase64(attempt.base64);
  if (read === null) throw new Error('QR did not read');
  return read;
}

type Inst = renderer.ReactTestInstance;
let tr: renderer.ReactTestRenderer | undefined;
async function mount(): Promise<void> {
  await act(async () => {
    tr = renderer.create(<AcceptInvitationScreen />, { createNodeMock: () => ({}) });
  });
}
const root = () => (tr as renderer.ReactTestRenderer).root;
const cams = () => root().findAll((n) => (n.type as unknown) === 'VisionCameraMock');
const hostById = (id: string): Inst | undefined => root().findAll((n) => typeof n.type === 'string' && n.props.testID === id)[0];
function elWith(id: string, prop: string): Inst {
  const found = root().findAll((n) => n.props.testID === id && typeof n.props[prop] === 'function')[0];
  if (!found) throw new Error('no element ' + id + ' with ' + prop);
  return found;
}
function textOf(n: Inst): string {
  return n.children.map((c) => (typeof c === 'string' ? c : textOf(c))).join('');
}
const statusText = () => {
  const h = hostById('accept-invitation-scan-status');
  return h ? textOf(h) : '';
};
const summaryShown = () => hostById('accept-invitation-summary') !== undefined;
const disabled = (id: string) => elWith(id, 'onPress').props.disabled === true;
async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve();
  });
}
async function press(id: string): Promise<void> {
  await act(async () => {
    await elWith(id, 'onPress').props.onPress();
  });
  await settle();
}
async function emitScan(rawValue: string): Promise<void> {
  await act(async () => {
    bs.__emitBarcodes([{ rawValue }]);
  });
}

beforeEach(() => {
  vc.__resetVisionCameraMock();
  bs.__resetBarcodeScannerMock();
  for (const m of [mockReplace, mockNavigate, mockSetParams, mockGetEngine, mockPick]) m.mockReset();
  mockAvailable.mockReset();
  mockAvailable.mockReturnValue(true);
});
afterEach(async () => {
  // Nothing the scanner or the picker reads ever reaches navigation state or an engine.
  expect(mockNavigate).not.toHaveBeenCalled();
  expect(mockSetParams).not.toHaveBeenCalled();
  expect(mockGetEngine).not.toHaveBeenCalled();
  await act(async () => {
    tr?.unmount();
  });
  tr = undefined;
  jest.restoreAllMocks();
});

describe('Scan QR code', () => {
  it('SC1: Scan opens the camera; the sender screen QR fills the field; nothing happens until Continue', async () => {
    const { text, invitePrivate } = invitation('k');
    const payload = scannedFromSenderScreen(text);
    expect(payload === text).toBe(true);
    const capture = captureConsole();
    try {
      await mount();
      expect(cams()).toHaveLength(0);
      expect(vc.__cameraPermissionRequestCount()).toBe(0);
      await press('accept-invitation-scan');
      expect(cams()).toHaveLength(1);

      await emitScan(payload);
      expect(cams()).toHaveLength(0);
      expect(summaryShown()).toBe(true);
      expect(statusText()).toBe(en.inviteScanScanned);
      expect(disabled('accept-invitation-continue')).toBe(false);
      expect(mockReplace).not.toHaveBeenCalled();
      expect(JSON.stringify(tr?.toJSON()).includes(invitePrivate)).toBe(false);

      await press('accept-invitation-continue');
      expect(mockReplace).toHaveBeenCalledTimes(1);
      const [route, params] = mockReplace.mock.calls[0];
      expect(route).toBe('KeyholderInvitation');
      expect(takeInviteShare(params.shareToken) === text).toBe(true);
      expectNoSecretInConsole(capture, [text, invitePrivate]);
    } finally {
      capture.restore();
    }
  });

  it('SC2: a join code is refused with the join-code banner; the field stays empty and the scanner stays open', async () => {
    await mount();
    await press('accept-invitation-scan');
    await emitScan(JOIN_CODE);
    expect(cams()).toHaveLength(1);
    expect(textOf(hostById('accept-invitation-scan-banner') as Inst)).toBe(en.inviteScanIsJoinCode);
    expect(summaryShown()).toBe(false);
    expect(disabled('accept-invitation-continue')).toBe(true);
  });

  it('SC3: any other QR is refused with the not-an-invitation banner', async () => {
    await mount();
    await press('accept-invitation-scan');
    await emitScan('https://example.org/not-an-invitation');
    expect(textOf(hostById('accept-invitation-scan-banner') as Inst)).toBe(en.inviteScanNotInvitation);
    expect(summaryShown()).toBe(false);
  });

  it('SC4: a bare private key (no role type) is not taken as an invitation QR', async () => {
    await mount();
    await press('accept-invitation-scan');
    await emitScan(invitation().invitePrivate);
    expect(cams()).toHaveLength(1);
    expect(summaryShown()).toBe(false);
  });

  it('SC5: the scanner shows the invitation copy, and Paste instead / Close leave the field unchanged', async () => {
    await mount();
    for (const id of ['accept-invitation-scan-paste', 'accept-invitation-scan-close']) {
      await press('accept-invitation-scan');
      expect(textOf(hostById('accept-invitation-scan-title') as Inst)).toBe(en.inviteScanTitle);
      await act(async () => {
        cams()[0].props.onStarted();
      });
      expect(textOf(hostById('accept-invitation-scan-instruction') as Inst)).toBe(en.inviteScanInstruction);
      expect(textOf(hostById('accept-invitation-scan-paste') as Inst)).toBe(en.inviteScanPasteInstead);
      await act(async () => {
        elWith(id, 'onPress').props.onPress();
      });
      expect(cams()).toHaveLength(0);
      expect(summaryShown()).toBe(false);
    }
  });
});

describe('camera states', () => {
  it('CS1: not-determined -> asked only on the Scan press; a grant opens the camera', async () => {
    vc.__setCameraPermissionStatus('not-determined');
    await mount();
    await settle();
    expect(vc.__cameraPermissionRequestCount()).toBe(0);
    await press('accept-invitation-scan');
    expect(vc.__cameraPermissionRequestCount()).toBe(1);
    expect(cams()).toHaveLength(1);
  });

  it('CS2: a refused request shows the denied sentence and keeps Scan enabled', async () => {
    vc.__setCameraPermissionStatus('not-determined');
    vc.__setCameraPermissionRequestResult('not-determined');
    await mount();
    await press('accept-invitation-scan');
    await settle();
    expect(cams()).toHaveLength(0);
    expect(statusText()).toBe(en.inviteScanCameraDenied);
    expect(disabled('accept-invitation-scan')).toBe(false);
  });

  it('CS3: a blocked permission disables Scan, says so, and offers Open Settings', async () => {
    vc.__setCameraPermissionStatus('denied');
    const openSettings = jest.spyOn(Linking, 'openSettings').mockResolvedValue(undefined);
    await mount();
    await settle();
    expect(disabled('accept-invitation-scan')).toBe(true);
    expect(statusText()).toContain(en.inviteScanCameraBlocked);
    await act(async () => {
      elWith('accept-invitation-scan-open-settings', 'onPress').props.onPress();
    });
    expect(openSettings).toHaveBeenCalledTimes(1);
    // Choose image and paste still work.
    expect(disabled('accept-invitation-choose-image')).toBe(false);
  });

  it('CS4: no camera disables Scan and points to an image or paste', async () => {
    vc.__setCameraDevice(undefined);
    await mount();
    await settle();
    expect(disabled('accept-invitation-scan')).toBe(true);
    expect(statusText()).toBe(en.inviteScanCameraNone);
  });

  it('CS5: a camera error closes the scanner and shows the failed sentence with Scan enabled', async () => {
    await mount();
    await press('accept-invitation-scan');
    await act(async () => {
      cams()[0].props.onError(new Error('camera busy'));
    });
    expect(cams()).toHaveLength(0);
    expect(statusText()).toBe(en.inviteScanCameraFailed);
    expect(disabled('accept-invitation-scan')).toBe(false);
  });
});

describe('Choose image', () => {
  it('IM1: a decoded invitation fills the field; Continue routes it by type', async () => {
    const { text } = invitation('of');
    mockPick.mockResolvedValueOnce({ kind: 'decoded', values: ['https://example.org', text] });
    await mount();
    await press('accept-invitation-choose-image');
    expect(mockPick).toHaveBeenCalledTimes(1);
    expect(summaryShown()).toBe(true);
    expect(statusText()).toBe(en.inviteImageRead);
    expect(mockReplace).not.toHaveBeenCalled();
    await press('accept-invitation-continue');
    const [route, params] = mockReplace.mock.calls[0];
    expect(route).toBe('AdministratorInvitation');
    expect(takeInviteShare(params.shareToken) === text).toBe(true);
  });

  it.each([
    ['a join code', { kind: 'decoded', values: [JOIN_CODE] }, 'inviteImageIsJoinCode'],
    ['another QR', { kind: 'decoded', values: ['hello'] }, 'inviteImageNotInvitation'],
    ['no QR', { kind: 'no-code' }, 'inviteImageNoCode'],
    ['an unreadable image', { kind: 'unreadable' }, 'inviteImageUnreadable'],
    ['a missing native module', { kind: 'unavailable' }, 'inviteImageUnavailable'],
  ])('IM2: %s shows its sentence and leaves the field empty', async (_label, result, key) => {
    mockPick.mockResolvedValueOnce(result);
    await mount();
    await press('accept-invitation-choose-image');
    expect(statusText()).toBe(en[key]);
    expect(summaryShown()).toBe(false);
    expect(disabled('accept-invitation-continue')).toBe(true);
  });

  it('IM3: a cancelled pick changes nothing', async () => {
    mockPick.mockResolvedValueOnce({ kind: 'cancelled' });
    await mount();
    await press('accept-invitation-choose-image');
    expect(hostById('accept-invitation-scan-status')).toBeUndefined();
    expect(summaryShown()).toBe(false);
  });

  it('IM4: a second tap while the picker is open does not open a second picker', async () => {
    let resolve!: (v: unknown) => void;
    mockPick.mockImplementationOnce(() => new Promise((r) => (resolve = r)));
    await mount();
    const button = elWith('accept-invitation-choose-image', 'onPress');
    await act(async () => {
      button.props.onPress();
      button.props.onPress();
    });
    expect(mockPick).toHaveBeenCalledTimes(1);
    await act(async () => {
      resolve({ kind: 'cancelled' });
    });
  });

  it('IM5: not available on this build: Choose image is disabled and the screen says so; paste and scan still work', async () => {
    mockAvailable.mockReturnValue(false);
    await mount();
    expect(disabled('accept-invitation-choose-image')).toBe(true);
    expect(textOf(hostById('accept-invitation-image-unavailable') as Inst)).toBe(en.inviteImageUnavailable);
    await press('accept-invitation-choose-image');
    expect(mockPick).not.toHaveBeenCalled();
    expect(disabled('accept-invitation-scan')).toBe(false);
  });

  it('IM6: typing in the field clears an image notice', async () => {
    mockPick.mockResolvedValueOnce({ kind: 'no-code' });
    await mount();
    await press('accept-invitation-choose-image');
    expect(statusText()).toBe(en.inviteImageNoCode);
    await act(async () => {
      elWith('accept-invitation-input', 'onChangeText').props.onChangeText('x');
    });
    expect(hostById('accept-invitation-scan-status')).toBeUndefined();
  });
});

describe('Choose image inside the scanner', () => {
  const inScanner = (id: string) =>
    (hostById('accept-invitation-scanner') as Inst | undefined)?.findAll((n) => typeof n.type === 'string' && n.props.testID === id).length === 1;

  it('SI1: the invitation scanner has its own Choose image; a picked invitation fills the field as a scan does', async () => {
    const { text, invitePrivate } = invitation('k');
    mockPick.mockResolvedValueOnce({ kind: 'decoded', values: [JOIN_CODE, text] });
    const capture = captureConsole();
    try {
      await mount();
      await press('accept-invitation-scan');
      expect(inScanner('accept-invitation-scan-image')).toBe(true);
      expect(elWith('accept-invitation-scan-image', 'onPress').props.accessibilityLabel).toBe(en.scanImageLabel);
      await press('accept-invitation-scan-image');
      expect(mockPick).toHaveBeenCalledTimes(1);
      expect(cams()).toHaveLength(0);
      expect(summaryShown()).toBe(true);
      expect(statusText()).toBe(en.inviteScanScanned);
      expect(mockReplace).not.toHaveBeenCalled();
      await press('accept-invitation-continue');
      const [route, params] = mockReplace.mock.calls[0];
      expect(route).toBe('KeyholderInvitation');
      expect(takeInviteShare(params.shareToken) === text).toBe(true);
      expectNoSecretInConsole(capture, [text, invitePrivate]);
    } finally {
      capture.restore();
    }
  });

  it.each([
    ['a join code', { kind: 'decoded', values: [JOIN_CODE] }, 'inviteScanIsJoinCode'],
    ['another QR', { kind: 'decoded', values: ['hello'] }, 'inviteScanNotInvitation'],
    ['no QR', { kind: 'no-code' }, 'inviteImageNoCode'],
    ['an unreadable image', { kind: 'unreadable' }, 'inviteImageUnreadable'],
    ['a cancelled pick', { kind: 'cancelled' }, 'scanImageCancelled'],
  ])('SI2: %s shows its banner in the scanner, which stays open with the camera running', async (_label, result, key) => {
    mockPick.mockResolvedValueOnce(result);
    await mount();
    await press('accept-invitation-scan');
    await press('accept-invitation-scan-image');
    expect(textOf(hostById('accept-invitation-scan-banner') as Inst)).toBe(en[key]);
    expect(cams()).toHaveLength(1);
    expect(cams()[0].props.isActive).toBe(true);
    expect(summaryShown()).toBe(false);
  });

  it('SI3: not available on this build: the scanner shows its Choose image disabled with the sentence', async () => {
    mockAvailable.mockReturnValue(false);
    await mount();
    await press('accept-invitation-scan');
    expect(elWith('accept-invitation-scan-image', 'onPress').props.disabled).toBe(true);
    expect(textOf(hostById('accept-invitation-scan-image-unavailable') as Inst)).toBe(en.inviteImageUnavailable);
    expect(mockPick).not.toHaveBeenCalled();
  });
});

describe('copy', () => {
  it('every new sentence exists in English and Spanish', () => {
    const es = resources.es.translation as Record<string, string>;
    const keys = Object.keys(en).filter((k) => /^(inviteScan|inviteImage|invitationQr)/.test(k));
    expect(keys.length).toBeGreaterThanOrEqual(25);
    for (const k of [...keys, 'joinScanIsInvitation']) {
      expect(typeof es[k]).toBe('string');
      expect(es[k].length).toBeGreaterThan(0);
      expect(es[k] !== en[k]).toBe(true);
    }
  });
});
