/**
 * InviteShareBlock (UAT 62 L2/L3, Redmi 8). The invite JSON used to be cut at 4 lines with no
 * ellipsis, and SHARE silently called Clipboard.setString, which left the system clipboard empty
 * with no feedback. SHARE opens the OS share sheet, and COPY toasts "Copied" only after an Android
 * read-back matches. The invite text itself is no longer shown at all (BIO-4: it held invitePrivate).
 */

import React from 'react';
import { Platform, Share } from 'react-native';
import renderer, { act } from 'react-test-renderer';

jest.mock('react-native-vector-icons/FontAwesome6', () => 'FontAwesome6');

jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

jest.mock('@react-navigation/native', () => ({
  useTheme: () => ({
    dark: false,
    colors: { text: '#T', textSecondary: '#TS', card: '#CA', accent: '#AC', success: '#SU', error: '#ER', light: '#LI', dark: '#DA' },
  }),
}));

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

const mockSetString = jest.fn();
const mockGetString = jest.fn(async () => '');
jest.mock('@react-native-clipboard/clipboard', () => ({
  __esModule: true,
  default: {
    setString: (s: string) => mockSetString(s),
    getString: () => mockGetString(),
  },
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { InviteShareBlock } = require('../InviteShareBlock');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { ToastProvider } = require('../../../components/Toast');

const SHARE = JSON.stringify({
  invitePrivate: 'a'.repeat(64),
  inviteKey: 'b'.repeat(66),
  expiration: '2026-10-06T12:00:00.000Z',
  type: 'k',
  name: 'Kay Holder',
});

// Every tree a test mounts, unmounted in afterEach. A COPY test shows a toast on REAL timers, and a
// provider left mounted keeps its 2.5 s fade timer running past this file; on a shared jest worker it
// then fired in a later file and threw `reading 'timing'` there (review-fix lanes B and C).
const mounted: renderer.ReactTestRenderer[] = [];

function render(onShared?: () => void) {
  let tr!: renderer.ReactTestRenderer;
  act(() => {
    tr = renderer.create(
      <ToastProvider>
        <InviteShareBlock label="invitationKey" shareText={SHARE} testIDPrefix="p" onShared={onShared} />
      </ToastProvider>,
    );
  });
  mounted.push(tr);
  return tr;
}

async function press(tr: renderer.ReactTestRenderer, testID: string) {
  const button = tr.root.findAll((n) => n.props?.testID === testID && typeof n.props?.onPress === 'function')[0];
  await act(async () => {
    await button.props.onPress();
  });
}

function statusText(tr: renderer.ReactTestRenderer): string | undefined {
  const found = tr.root.findAll((n) => n.props?.testID === 'p-status' && typeof n.props?.children === 'string');
  return found[0]?.props.children;
}

function toastText(tr: renderer.ReactTestRenderer): string | undefined {
  const found = tr.root.findAll((n) => n.props?.testID === 'toast-message' && typeof n.props?.children === 'string');
  return found[0]?.props.children;
}

const originalOS = Platform.OS;

beforeEach(() => {
  jest.clearAllMocks();
  Object.defineProperty(Platform, 'OS', { value: 'android', configurable: true });
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  act(() => {
    for (const tr of mounted.splice(0)) tr.unmount();
  });
});

afterAll(() => {
  Object.defineProperty(Platform, 'OS', { value: originalOS, configurable: true });
});

describe('InviteShareBlock', () => {
  // Redmi 8 BIO-4 (2026-10-08): after Send the block rendered the invite JSON, invitePrivate
  // included, in plain text (shoulder-surfing, screenshots, screen recording). The secret leaves the
  // device only through SHARE / COPY; the screen shows a ready line instead.
  it('never renders the invite material on screen, and shows the ready line instead', () => {
    const tr = render();
    const rendered = JSON.stringify(tr.toJSON());
    expect(rendered).not.toContain('a'.repeat(16));
    expect(rendered).not.toContain('b'.repeat(16));
    expect(rendered).not.toContain('invitePrivate');
    expect(tr.root.findAll((n) => n.props?.testID === 'p-text')).toHaveLength(0);
    const ready = tr.root.findAll((n) => n.props?.testID === 'p-ready' && n.props?.children === 'invitationShareReady');
    expect(ready.length).toBeGreaterThan(0);
  });

  it('SHARE opens the OS share sheet with the invite text', async () => {
    const spy = jest.spyOn(Share, 'share').mockResolvedValue({ action: 'sharedAction' } as never);
    const tr = render();
    await press(tr, 'p-share');
    expect(spy).toHaveBeenCalledWith({ message: SHARE });
    expect(statusText(tr)).toBeUndefined();
    expect(toastText(tr)).toBeUndefined();
  });

  it('a share-sheet failure shows the share-failed copy', async () => {
    jest.spyOn(Share, 'share').mockRejectedValue(new Error('no activity'));
    const tr = render();
    await press(tr, 'p-share');
    expect(statusText(tr)).toBe('invitationShareSheetFailed');
  });

  it('COPY toasts "Copied" only when the Android read-back matches, with no inline line', async () => {
    mockGetString.mockResolvedValueOnce(SHARE);
    const tr = render();
    await press(tr, 'p-copy');
    expect(mockSetString).toHaveBeenCalledWith(SHARE);
    expect(toastText(tr)).toBe('invitationShareCopied');
    expect(statusText(tr)).toBeUndefined();
  });

  it('COPY toasts a failure when the clipboard stays empty (the Redmi 8 symptom)', async () => {
    mockGetString.mockResolvedValueOnce('');
    const tr = render();
    await press(tr, 'p-copy');
    expect(toastText(tr)).toBe('invitationShareCopyFailed');
  });

  it('COPY toasts a failure when the clipboard module throws', async () => {
    mockSetString.mockImplementationOnce(() => {
      throw new Error('TurboModuleRegistry: RNCClipboard not found');
    });
    const tr = render();
    await press(tr, 'p-copy');
    expect(toastText(tr)).toBe('invitationShareCopyFailed');
  });

  it('iOS skips the read-back (it would raise the Allow Paste prompt) and confirms the copy', async () => {
    Object.defineProperty(Platform, 'OS', { value: 'ios', configurable: true });
    const tr = render();
    await press(tr, 'p-copy');
    expect(mockGetString).not.toHaveBeenCalled();
    expect(toastText(tr)).toBe('invitationShareCopied');
  });

  describe('onShared', () => {
    it('S1: Share resolving sharedAction calls onShared once', async () => {
      jest.spyOn(Share, 'share').mockResolvedValue({ action: Share.sharedAction } as never);
      const onShared = jest.fn();
      const tr = render(onShared);
      await press(tr, 'p-share');
      expect(onShared).toHaveBeenCalledTimes(1);
    });

    it('S2: a dismissed iOS share sheet is not shared and shows no status', async () => {
      jest.spyOn(Share, 'share').mockResolvedValue({ action: Share.dismissedAction } as never);
      const onShared = jest.fn();
      const tr = render(onShared);
      await press(tr, 'p-share');
      expect(onShared).not.toHaveBeenCalled();
      expect(statusText(tr)).toBeUndefined();
    });

    it('S3: a rejected Share is not shared and still shows the failure line', async () => {
      jest.spyOn(Share, 'share').mockRejectedValue(new Error('no activity'));
      const onShared = jest.fn();
      const tr = render(onShared);
      await press(tr, 'p-share');
      expect(onShared).not.toHaveBeenCalled();
      expect(statusText(tr)).toBe('invitationShareSheetFailed');
    });

    it('S4: COPY with a matching read-back calls onShared once', async () => {
      mockGetString.mockResolvedValueOnce(SHARE);
      const onShared = jest.fn();
      const tr = render(onShared);
      await press(tr, 'p-copy');
      expect(onShared).toHaveBeenCalledTimes(1);
    });

    it('S5: a failed copy (empty read-back, or setString throwing) is not shared', async () => {
      const onShared = jest.fn();
      mockGetString.mockResolvedValueOnce('');
      await press(render(onShared), 'p-copy');
      mockSetString.mockImplementationOnce(() => {
        throw new Error('no module');
      });
      await press(render(onShared), 'p-copy');
      expect(onShared).not.toHaveBeenCalled();
    });

    it('S6: without onShared, Share and Copy still work', async () => {
      jest.spyOn(Share, 'share').mockResolvedValue({ action: Share.sharedAction } as never);
      mockGetString.mockResolvedValueOnce(SHARE);
      const tr = render();
      await press(tr, 'p-share');
      await press(tr, 'p-copy');
      expect(toastText(tr)).toBe('invitationShareCopied');
    });
  });
});
