/**
 * @format
 */

// IMPORTANT: This must be imported FIRST to polyfill crypto.getRandomValues
// Required by @noble/curves and @noble/hashes for cryptographic operations
import 'react-native-get-random-values';

import {AppRegistry} from 'react-native';
import App from './App';
import {name as appName} from './app.json';

AppRegistry.registerComponent(appName, () => App);
