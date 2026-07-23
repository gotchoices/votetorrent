/**
 * @format
 */

// Polyfills MUST run before any library import (libp2p / Optimystic / Quereus).
// Ported from apps/VoteTorrentAuthority/index.js (Phase 44, D-02/D-04) — see
// polyfills.bootstrap.js.
import './polyfills.bootstrap';

import {AppRegistry} from 'react-native';
import App from './App';
import {name as appName} from './app.json';

AppRegistry.registerComponent(appName, () => App);
