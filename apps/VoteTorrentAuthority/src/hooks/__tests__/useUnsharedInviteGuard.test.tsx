/**
 * useUnsharedInviteGuard on a REAL NavigationContainer + native-stack (the navigator RootNavigator
 * uses). Proves block / Stay / Leave / shared-pops.
 */
import React from 'react';
import { Alert, Pressable, View } from 'react-native';
import renderer, { act } from 'react-test-renderer';
import { NavigationContainer, createNavigationContainerRef } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';

jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

import { useUnsharedInviteGuard } from '../useUnsharedInviteGuard';

const Stack = createNativeStackNavigator();
const navigationRef = createNavigationContainerRef<any>();

let currentShareText = 'invite-text';
let setTextInScreen: (v: string) => void = () => undefined;

function Home() {
  return <View />;
}

function Invite() {
  const [text, setText] = React.useState(currentShareText);
  setTextInScreen = setText;
  const markShared = useUnsharedInviteGuard(text);
  return <Pressable testID="mark-shared" onPress={markShared} />;
}

function App() {
  return (
    <NavigationContainer ref={navigationRef}>
      <Stack.Navigator>
        <Stack.Screen name="Home" component={Home} />
        <Stack.Screen name="Invite" component={Invite} />
      </Stack.Navigator>
    </NavigationContainer>
  );
}

let tr: renderer.ReactTestRenderer;
let alertSpy: jest.SpyInstance;

function route(): string | undefined {
  return navigationRef.getCurrentRoute()?.name;
}

function mount(shareText: string) {
  currentShareText = shareText;
  act(() => {
    tr = renderer.create(<App />);
  });
  act(() => {
    navigationRef.navigate('Invite');
  });
  expect(route()).toBe('Invite');
}

function back() {
  act(() => {
    navigationRef.goBack();
  });
}

function lastButtons(): Array<{ text: string; style?: string; onPress?: () => void }> {
  const calls = alertSpy.mock.calls;
  return calls[calls.length - 1][2];
}

beforeEach(() => {
  alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
});

afterEach(() => {
  act(() => tr.unmount());
  alertSpy.mockRestore();
});

describe('useUnsharedInviteGuard', () => {
  it('G1: blocks Back on an unshared invite and raises the confirm Alert', () => {
    mount('invite-text');
    back();
    expect(route()).toBe('Invite');
    expect(alertSpy).toHaveBeenCalledTimes(1);
    const [title, message, buttons] = alertSpy.mock.calls[0];
    expect(title).toBe('inviteLeaveUnsharedTitle');
    expect(message).toBe('inviteLeaveUnsharedMessage');
    expect(buttons).toHaveLength(2);
    expect(buttons[0]).toEqual({ text: 'inviteLeaveUnsharedStay', style: 'cancel' });
    expect(buttons[1]).toMatchObject({ text: 'inviteLeaveUnsharedLeave', style: 'destructive' });
    expect(typeof buttons[1].onPress).toBe('function');
  });

  it('G2: the destructive button completes the blocked navigation', () => {
    mount('invite-text');
    back();
    act(() => lastButtons()[1].onPress!());
    expect(route()).toBe('Home');
  });

  it('G3: Stay keeps the screen, and a second Back raises the Alert again', () => {
    mount('invite-text');
    back();
    expect(route()).toBe('Invite');
    back();
    expect(route()).toBe('Invite');
    expect(alertSpy).toHaveBeenCalledTimes(2);
  });

  it('G4: after markShared, Back pops with no Alert', () => {
    mount('invite-text');
    act(() => {
      tr.root.findByProps({ testID: 'mark-shared' }).props.onPress();
    });
    back();
    expect(route()).toBe('Home');
    expect(alertSpy).not.toHaveBeenCalled();
  });

  it('G5: empty shareText (accept mode / pre-Send) is never guarded', () => {
    mount('');
    back();
    expect(route()).toBe('Home');
    expect(alertSpy).not.toHaveBeenCalled();
  });

  it('G6: the shared state is tied to the text that was shared', () => {
    mount('invite-text');
    act(() => {
      tr.root.findByProps({ testID: 'mark-shared' }).props.onPress();
    });
    act(() => setTextInScreen('another-invite'));
    back();
    expect(route()).toBe('Invite');
    expect(alertSpy).toHaveBeenCalledTimes(1);
  });
});
