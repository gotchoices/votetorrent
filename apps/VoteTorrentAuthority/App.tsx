import React from 'react';
import {NavigationContainer} from '@react-navigation/native';
import './src/i18n';
import {RootNavigator} from './src/navigation';
import {darkTheme, lightTheme} from './src/theme/themes';
import {useColorScheme} from 'react-native';

export default function App() {
  const colorScheme = useColorScheme();

  return (
    <NavigationContainer
      theme={colorScheme === 'dark' ? darkTheme : lightTheme}>
      <RootNavigator />
    </NavigationContainer>
  );
}
