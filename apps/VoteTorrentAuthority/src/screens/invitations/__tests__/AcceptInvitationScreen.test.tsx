/**
 * AcceptInvitationScreen.test.tsx - the paste-first dispatcher (UAT 62 test 10).
 * Pure parse + route: no engine call is made here; the role screens resolve the slot.
 */

import React from 'react';
import renderer from 'react-test-renderer';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { bytesToHex } from '@noble/curves/utils.js';
import { takeInviteShare } from '../invite-share-handoff';

const mockSetSecureScreen = jest.fn(async (_enabled: boolean) => true);
jest.mock('@votetorrent/attestation-native', () => ({
  setSecureScreen: (enabled: boolean) => mockSetSecureScreen(enabled),
}));

const mockReplace = jest.fn();
const mockSetOptions = jest.fn();
const mockGetEngine = jest.fn();

jest.mock('react-native-vector-icons/FontAwesome6', () => 'FontAwesome6');
jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
jest.mock('../../../providers/SettingsProvider', () => ({ useSettings: () => ({ showHelpIcons: false }) }));
jest.mock('../../../providers/AppProvider', () => ({ useApp: () => ({ getEngine: mockGetEngine }) }));
jest.mock('@react-navigation/native', () => ({
  useTheme: () => ({
    colors: {
      primary: '#007AFF', background: '#FFFFFF', card: '#F2F2F7', text: '#000000', border: '#C6C6C8',
      notification: '#FF3B30', error: '#FF3B30', textSecondary: '#888888', important: '#FF9500', success: '#34C759',
    },
  }),
  useFocusEffect: (cb: () => void | (() => void)) => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const R = require('react');
    R.useEffect(cb, [cb]);
  },
  useNavigation: () => ({ replace: mockReplace, navigate: jest.fn(), goBack: jest.fn(), setOptions: mockSetOptions }),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const mod = require('../AcceptInvitationScreen');
const AcceptInvitationScreen = mod.default ?? mod.AcceptInvitationScreen;

function share(type?: string) {
  const priv = secp256k1.utils.randomSecretKey();
  const invitePrivate = bytesToHex(priv);
  const body: Record<string, unknown> = { invitePrivate, inviteKey: bytesToHex(secp256k1.getPublicKey(priv)), name: 'Kay Two' };
  if (type) body.type = type;
  return { invitePrivate, text: JSON.stringify(body) };
}

const trees: renderer.ReactTestRenderer[] = [];
afterEach(async () => {
  // Release every secure-screen lease a test left behind (the lease counter is module state).
  await renderer.act(async () => {
    trees.splice(0).forEach((t) => t.unmount());
  });
});

async function render() {
  let tr!: renderer.ReactTestRenderer;
  await renderer.act(async () => {
    tr = renderer.create(<AcceptInvitationScreen />);
  });
  trees.push(tr);
  return tr;
}
const input = (tr: renderer.ReactTestRenderer) =>
  tr.root.findAll((n) => n.props?.testID === 'accept-invitation-input' && typeof n.props?.onChangeText === 'function')[0];
const cont = (tr: renderer.ReactTestRenderer) =>
  tr.root.findAll((n) => n.props?.testID === 'accept-invitation-continue' && typeof n.props?.onPress === 'function')[0];

async function paste(tr: renderer.ReactTestRenderer, text: string) {
  await renderer.act(async () => {
    input(tr).props.onChangeText(text);
  });
}
async function press(tr: renderer.ReactTestRenderer) {
  await renderer.act(async () => {
    await cont(tr).props.onPress();
  });
}

beforeEach(() => jest.clearAllMocks());

describe('AcceptInvitationScreen', () => {
  it('Continue is disabled with no paste', async () => {
    const tr = await render();
    expect(cont(tr).props.disabled).toBe(true);
    await paste(tr, 'x');
    expect(cont(tr).props.disabled).toBeFalsy();
  });

  it.each([
    ['k', 'KeyholderInvitation'],
    ['of', 'AdministratorInvitation'],
    ['au', 'AuthorityInvitation'],
  ])('routes a %s share to %s in accept mode handing the text over by one-shot token', async (type, route) => {
    const tr = await render();
    const { text } = share(type);
    await paste(tr, text);
    await press(tr);
    expect(mockReplace).toHaveBeenCalledTimes(1);
    const [calledRoute, params] = mockReplace.mock.calls[0];
    expect(calledRoute).toBe(route);
    expect(Object.keys(params).sort()).toEqual(['mode', 'shareToken']);
    expect(params.mode).toBe('accept');
    expect(JSON.stringify(params)).not.toMatch(/[0-9a-f]{64}/i);
    expect(takeInviteShare(params.shareToken)).toBe(text);
    expect(mockGetEngine).not.toHaveBeenCalled();
  });

  it('a raw hex key (no type) gets the malformed copy and does not navigate', async () => {
    const tr = await render();
    await paste(tr, share().invitePrivate);
    await press(tr);
    expect(mockReplace).not.toHaveBeenCalled();
    expect(JSON.stringify(tr.toJSON())).toContain('invitationAcceptMalformed');
  });

  it("type 'r' gets the wrong-type copy and does not navigate", async () => {
    const tr = await render();
    await paste(tr, share('r').text);
    await press(tr);
    expect(mockReplace).not.toHaveBeenCalled();
    expect(JSON.stringify(tr.toJSON())).toContain('invitationAcceptWrongType');
  });

  it('garbage gets the malformed copy and does not navigate', async () => {
    const tr = await render();
    await paste(tr, 'hello');
    await press(tr);
    expect(mockReplace).not.toHaveBeenCalled();
    expect(JSON.stringify(tr.toJSON())).toContain('invitationAcceptMalformed');
  });

  it('masks the input before the share parses', async () => {
    const tr = await render();
    expect(input(tr).props.secureTextEntry).toBe(true);
    expect(input(tr).props.autoCorrect).toBe(false);
  });

  it('after a valid paste shows only a masked summary and no field holds the private key', async () => {
    const tr = await render();
    const { text, invitePrivate } = share('of');
    await paste(tr, text);
    const json = JSON.stringify(tr.toJSON());
    expect(json).toContain('invitationPastedSummary');
    const inputs = tr.root.findAll((n) => String(n.type) === 'TextInput');
    expect(inputs.length).toBe(0);
    expect(json).not.toContain(invitePrivate);
    await renderer.act(async () => {
      tr.root.findAll((n) => n.props?.testID === 'accept-invitation-clear' && typeof n.props?.onPress === 'function')[0].props.onPress();
    });
    expect(input(tr)).toBeDefined();
    expect(cont(tr).props.disabled).toBe(true);
  });
});

describe('InviteSharePasteField secure-screen lease', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { InviteSharePasteField } = require('../InviteSharePasteField');
  const mount = async (value: string) => {
    let tr!: renderer.ReactTestRenderer;
    await renderer.act(async () => {
      tr = renderer.create(<InviteSharePasteField value={value} onChangeText={() => {}} testIDPrefix="f" />);
    });
    trees.push(tr);
    return tr;
  };

  it('is ref-counted: one true on first holder, one false after the last releases', async () => {
    const { text } = share('of');
    const a = await mount(text);
    const b = await mount(text);
    await renderer.act(async () => a.unmount());
    expect(mockSetSecureScreen.mock.calls).toEqual([[true]]);
    await renderer.act(async () => b.unmount());
    expect(mockSetSecureScreen.mock.calls).toEqual([[true], [false]]);
  });

  it('holds no lease while the field is empty', async () => {
    const a = await mount('');
    await renderer.act(async () => a.unmount());
    expect(mockSetSecureScreen).not.toHaveBeenCalled();
  });
});
