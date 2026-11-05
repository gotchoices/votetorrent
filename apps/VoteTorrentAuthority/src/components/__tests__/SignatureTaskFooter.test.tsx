/**
 * SignatureTaskFooter geometry pin (UAT 62, Redmi 8). The accept/decline footer of every invitation
 * accept screen measured 36dp tall buttons (bounds [48,1304][336,1376] at 2x). Each button now sits
 * in a row slot whose minHeight floors the CLICKABLE button at 48dp, the RejectReasonCard recipe.
 */

import React from 'react';
import { StyleSheet } from 'react-native';
import renderer from 'react-test-renderer';

jest.mock('react-native-vector-icons/FontAwesome6', () => 'FontAwesome6');

jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

jest.mock('@react-navigation/native', () => ({
  useTheme: () => ({
    colors: { text: '#T', card: '#CA', accent: '#AC', success: '#SU', error: '#ER', light: '#LI', dark: '#DA' },
  }),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { SignatureTaskFooter } = require('../SignatureTaskFooter');

const SLOTS = ['signature-task-footer-accept-slot', 'signature-task-footer-reject-slot'];

function renderFooter(props: Record<string, unknown> = {}) {
  let tr!: renderer.ReactTestRenderer;
  renderer.act(() => {
    tr = renderer.create(<SignatureTaskFooter onAccept={jest.fn()} onReject={jest.fn()} {...props} />);
  });
  return tr;
}

function slotStyle(tr: renderer.ReactTestRenderer, testID: string) {
  return StyleSheet.flatten(tr.root.findByProps({ testID }).props.style) as Record<string, unknown>;
}

/** Read CustomButton's REAL marginVertical from the rendered touchable, so a margin change breaks the pin. */
function buttonStyle(tr: renderer.ReactTestRenderer, slotTestID: string) {
  const slot = tr.root.findByProps({ testID: slotTestID });
  const touchable = slot.findAll((n) => n.props.accessibilityRole === 'button' && n.props.style !== undefined)[0];
  return StyleSheet.flatten(touchable.props.style) as Record<string, unknown>;
}

describe('SignatureTaskFooter', () => {
  it('floors each clickable button at 48dp: slot minHeight minus the button margins', () => {
    const tr = renderFooter();
    for (const id of SLOTS) {
      const slot = slotStyle(tr, id);
      const button = buttonStyle(tr, id);
      expect(slot.flexDirection).toBe('row');
      expect(button.alignSelf).toBe('stretch');
      expect((slot.minHeight as number) - 2 * ((button.marginVertical as number) ?? 0)).toBeGreaterThanOrEqual(48);
    }
  });

  it('renders the given labels and wires the presses', () => {
    const onAccept = jest.fn();
    const onReject = jest.fn();
    const tr = renderFooter({ onAccept, onReject, acceptLabel: 'accept', rejectLabel: 'decline' });
    const accept = tr.root.findByProps({ accessibilityLabel: 'accept' });
    const decline = tr.root.findByProps({ accessibilityLabel: 'decline' });
    renderer.act(() => accept.props.onPress());
    renderer.act(() => decline.props.onPress());
    expect(onAccept).toHaveBeenCalledTimes(1);
    expect(onReject).toHaveBeenCalledTimes(1);
  });

  it('disables both buttons together', () => {
    const tr = renderFooter({ disabled: true });
    for (const id of SLOTS) {
      expect(buttonStyle(tr, id).opacity).toBe(0.5);
    }
  });
});
