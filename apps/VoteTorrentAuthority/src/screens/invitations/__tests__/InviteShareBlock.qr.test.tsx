/**
 * InviteShareBlock.qr.test.tsx - "Show QR code" on the keyholder invitation (sender side).
 *
 * The QR shown is read back with jsQR from the exact PNG the Image draws and must equal the Share /
 * Copy text byte for byte. Share QR image writes a QR-only PNG to the cache, opens the share sheet on
 * it by file://, and deletes it; a share the sheet reports as sent counts as shared, showing the QR
 * does not. While the QR shows, the window holds the secure-screen lease and is kept awake. Without
 * `showQr` (administrator and authority invitations) nothing changes. Text comparisons are boolean.
 */

import React from 'react';
import renderer, { act } from 'react-test-renderer';
import Share from 'react-native-share';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { bytesToHex } from '@noble/curves/utils.js';
import { serializeInviteShare } from '../invite-share';
import { readQrPngBase64, readQrPng } from '../../__fixtures__/read-qr-png';
import { base64ToBytes } from '../../../utils/qr/gray-png';
import { SHARED_INVITATION_QR_IMAGE_FILENAME } from '../../../engines/qr-share';
import { captureConsole, expectNoSecretInConsole } from '../../../engines/__fixtures__/console-leak';

jest.mock('react-native-vector-icons/FontAwesome6', () => 'FontAwesome6');
jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
jest.mock('@react-navigation/native', () => ({
  useTheme: () => ({
    dark: false,
    colors: { text: '#T', textSecondary: '#TS', card: '#CA', accent: '#AC', success: '#SU', error: '#ER', light: '#LI', dark: '#DA', border: '#BO' },
  }),
}));
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
jest.mock('@react-native-clipboard/clipboard', () => ({ __esModule: true, default: { setString: jest.fn(), getString: jest.fn(async () => '') } }));
const mockSetSecureScreen = jest.fn(async (_enabled: boolean) => true);
jest.mock('@votetorrent/attestation-native', () => ({ setSecureScreen: (enabled: boolean) => mockSetSecureScreen(enabled) }));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { InviteShareBlock } = require('../InviteShareBlock');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { ToastProvider } = require('../../../components/Toast');

interface FsMock {
  CachesDirectoryPath: string;
  writeFile: jest.Mock;
  unlink: jest.Mock;
  __fsFiles(): Array<{ path: string }>;
  __resetFsMock(): void;
}
// eslint-disable-next-line @typescript-eslint/no-var-requires
const fsMock = require('../../../../__mocks__/@dr.pogodin/react-native-fs.js') as FsMock;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const keepAwake = require('../../../../__mocks__/@sayem314/react-native-keep-awake.js') as { activateKeepAwake: jest.Mock; deactivateKeepAwake: jest.Mock };
const open = jest.mocked(Share.open);
const FILE = fsMock.CachesDirectoryPath + '/' + SHARED_INVITATION_QR_IMAGE_FILENAME;

function invitation(name = 'Kay Holder'): { text: string; invitePrivate: string } {
  const priv = secp256k1.utils.randomSecretKey();
  const invitePrivate = bytesToHex(priv);
  const text = serializeInviteShare({
    invitePrivate,
    inviteKey: bytesToHex(secp256k1.getPublicKey(priv)),
    expiration: '2026-11-25T09:30:00.000Z',
    type: 'k',
    name,
  });
  return { text, invitePrivate };
}

const mounted: renderer.ReactTestRenderer[] = [];
function render(shareText: string, opts: { showQr?: boolean; onShared?: () => void } = {}) {
  let tr!: renderer.ReactTestRenderer;
  act(() => {
    tr = renderer.create(
      <ToastProvider>
        <InviteShareBlock label="invitationKey" shareText={shareText} testIDPrefix="p" onShared={opts.onShared} showQr={opts.showQr ?? true} />
      </ToastProvider>,
    );
  });
  mounted.push(tr);
  return tr;
}
const byId = (tr: renderer.ReactTestRenderer, id: string) => tr.root.findAll((n) => n.props?.testID === id);
async function press(tr: renderer.ReactTestRenderer, id: string) {
  const b = byId(tr, id).find((n) => typeof n.props?.onPress === 'function');
  if (!b) throw new Error('no pressable ' + id);
  await act(async () => {
    await b.props.onPress();
  });
}
/** The base64 the QR Image draws. */
function qrBase64(tr: renderer.ReactTestRenderer): string {
  const img = byId(tr, 'p-qr-image').find((n) => typeof n.props?.source?.uri === 'string');
  if (!img) throw new Error('no QR image');
  const uri: string = img.props.source.uri;
  expect(uri.startsWith('data:image/png;base64,')).toBe(true);
  return uri.slice('data:image/png;base64,'.length);
}

beforeEach(() => {
  jest.clearAllMocks();
  fsMock.__resetFsMock();
  open.mockReset();
  open.mockImplementation(async () => ({ success: true, message: '' }));
});
afterEach(() => {
  act(() => {
    for (const tr of mounted.splice(0)) tr.unmount();
  });
});

describe('Show QR code', () => {
  it('Q1: is offered after Send, and the QR it shows reads back as exactly the Share/Copy text', async () => {
    const { text, invitePrivate } = invitation();
    const capture = captureConsole();
    try {
      const tr = render(text);
      expect(byId(tr, 'p-qr-panel')).toHaveLength(0);
      await press(tr, 'p-qr-open');
      expect(byId(tr, 'p-qr-panel').length).toBeGreaterThan(0);
      expect(byId(tr, 'p-qr-open')).toHaveLength(0);
      expect(readQrPngBase64(qrBase64(tr)) === text).toBe(true);
      // Share and Copy stay available next to the QR.
      expect(byId(tr, 'p-share').length).toBeGreaterThan(0);
      expect(byId(tr, 'p-copy').length).toBeGreaterThan(0);
      // The secret is in no text, label or testID on screen, only inside the PNG.
      const json = JSON.stringify(tr.toJSON());
      expect(json.replace(qrBase64(tr), '').includes(invitePrivate)).toBe(false);
      expectNoSecretInConsole(capture, [text, invitePrivate]);
    } finally {
      capture.restore();
    }
  });

  it('Q2: a non-ASCII name reads back byte for byte too', async () => {
    const { text } = invitation('Zoë Ñandú 李雷');
    const tr = render(text);
    await press(tr, 'p-qr-open');
    expect(readQrPngBase64(qrBase64(tr)) === text).toBe(true);
  });

  it('Q3: shows the one-person warning with the QR', async () => {
    const tr = render(invitation().text);
    await press(tr, 'p-qr-open');
    const warning = byId(tr, 'p-qr-warning').find((n) => typeof n.props?.children === 'string');
    expect(warning?.props.children).toBe('invitationQrWarning');
  });

  it('Q4: holds the secure-screen lease and keeps the screen awake only while shown; Hide removes it', async () => {
    const tr = render(invitation().text);
    expect(mockSetSecureScreen).not.toHaveBeenCalled();
    await press(tr, 'p-qr-open');
    expect(mockSetSecureScreen.mock.calls).toEqual([[true]]);
    expect(keepAwake.activateKeepAwake).toHaveBeenCalledTimes(1);
    await press(tr, 'p-qr-hide');
    expect(byId(tr, 'p-qr-panel')).toHaveLength(0);
    expect(mockSetSecureScreen.mock.calls).toEqual([[true], [false]]);
    expect(keepAwake.deactivateKeepAwake).toHaveBeenCalledTimes(1);
    expect(byId(tr, 'p-qr-open').length).toBeGreaterThan(0);
  });

  it('Q5: showing the QR alone does not count as shared', async () => {
    const onShared = jest.fn();
    const tr = render(invitation().text, { onShared });
    await press(tr, 'p-qr-open');
    expect(onShared).not.toHaveBeenCalled();
  });

  it('Q6: an invitation too long for a QR says so and offers no image share', async () => {
    const tr = render(JSON.stringify({ invitePrivate: 'a'.repeat(64), name: 'x'.repeat(2400) }));
    await press(tr, 'p-qr-open');
    expect(byId(tr, 'p-qr-render-failed').length).toBeGreaterThan(0);
    expect(byId(tr, 'p-qr-image')).toHaveLength(0);
    expect(byId(tr, 'p-qr-share')).toHaveLength(0);
  });

  it('Q7: without showQr (administrator and authority invitations) there is no QR option', () => {
    const tr = render(invitation().text, { showQr: false });
    expect(byId(tr, 'p-qr-open')).toHaveLength(0);
    expect(byId(tr, 'p-share').length).toBeGreaterThan(0);
  });
});

describe('Share QR image', () => {
  it('S1: writes a QR-only PNG of the exact text, shares it by file:// as image/png, deletes it, and counts as shared', async () => {
    const { text } = invitation();
    const onShared = jest.fn();
    let written = '';
    fsMock.writeFile.mockImplementationOnce(async (_p: string, contents: string) => {
      written = contents;
    });
    const tr = render(text, { onShared });
    await press(tr, 'p-qr-open');
    await press(tr, 'p-qr-share');
    expect(fsMock.writeFile).toHaveBeenCalledWith(FILE, expect.any(String), 'base64');
    expect(readQrPng(base64ToBytes(written)) === text).toBe(true);
    expect(open).toHaveBeenCalledTimes(1);
    const opts = open.mock.calls[0][0] as Record<string, unknown>;
    expect(opts.url).toBe('file://' + FILE);
    expect(opts.type).toBe('image/png');
    expect(opts.excludedActivityTypes).toEqual(['com.apple.UIKit.activity.SaveToCameraRoll']);
    expect(JSON.stringify(opts).includes(text)).toBe(false);
    expect(fsMock.__fsFiles()).toHaveLength(0);
    expect(onShared).toHaveBeenCalledTimes(1);
  });

  it('S2: a dismissed sheet does not count as shared', async () => {
    open.mockImplementationOnce(async () => ({ success: false, message: '' }) as never);
    const onShared = jest.fn();
    const tr = render(invitation().text, { onShared });
    await press(tr, 'p-qr-open');
    await press(tr, 'p-qr-share');
    expect(onShared).not.toHaveBeenCalled();
    expect(byId(tr, 'p-qr-share-failed')).toHaveLength(0);
  });

  it('S3: a failed share shows the failed line, logs a closed token, and still deletes the file', async () => {
    open.mockImplementationOnce(async () => {
      throw new Error('native text');
    });
    const { text } = invitation();
    const capture = captureConsole();
    try {
      const onShared = jest.fn();
      const tr = render(text, { onShared });
      await press(tr, 'p-qr-open');
      await press(tr, 'p-qr-share');
      expect(byId(tr, 'p-qr-share-failed').length).toBeGreaterThan(0);
      expect(onShared).not.toHaveBeenCalled();
      expect(fsMock.__fsFiles()).toHaveLength(0);
      expect(capture.calls().some((c) => c[0] === '[invite] qr-share: failed')).toBe(true);
      expectNoSecretInConsole(capture, [text]);
    } finally {
      capture.restore();
    }
  });
});
