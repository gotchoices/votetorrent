/**
 * @format
 */

// Polyfills MUST run before any library import (libp2p / Optimystic / Quereus).
// Ported from apps/VoteTorrentAuthority/index.js (Phase 44, D-02/D-04) — see
// polyfills.bootstrap.js.
import './polyfills.bootstrap';

// Native SHA-256/512 + Ed25519 (react-native-quick-crypto) in place of the pure-JS ones above.
// After the bootstrap, whose shims it replaces; before App, because @libp2p/crypto probes
// WebCrypto Ed25519 once when it loads. See polyfills/native-crypto.js.
import './polyfills/native-crypto';

// Before App: see rnscreens-flags.js (keyboard open/close must not reset Screen sizes).
import './rnscreens-flags';

import {AppRegistry} from 'react-native';
import App from './App';
import {name as appName} from './app.json';

AppRegistry.registerComponent(appName, () => App);
