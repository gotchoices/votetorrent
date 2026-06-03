/**
 * @format
 */

// Polyfills MUST run before any library import (libp2p / Optimystic / Quereus).
// Spike 002 scaffold — see polyfills.bootstrap.js.
import './polyfills.bootstrap';

import {AppRegistry} from 'react-native';
import App from './App';
import {name as appName} from './app.json';

AppRegistry.registerComponent(appName, () => App);

// Phase 14 (D-16 / PERSIST-03) dev-only boot proof. Auto-selects write vs read
// from saved state so the manual test is launch → force-stop → relaunch.
// Disable via PROOF_ENABLED in persistence-proof-runner.ts. Logs under [proof].
import {runPersistenceProof} from './src/engines/persistence-proof-runner';
runPersistenceProof();
