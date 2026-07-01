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

// Phase 17 (P2P-01) dev-only dial probe. Fire-and-forget; no-op unless
// __DEV__ && DIAL_PROBE_ENABLED (see proof-flags.generated.ts). Logs under [dial-probe].
import {runDialProbe} from './src/engines/dial-probe';
runDialProbe();

// Dev-only symmetric replication proof. Fire-and-forget; no-op unless
// __DEV__ && REPLICATION_PROOF_ENABLED (see proof-flags.generated.ts). Logs under [replication-proof].
import {runReplicationProof} from './src/engines/replication-proof-runner';
runReplicationProof();

// Phase 28 (D-07 / SIGN-04) dev-only signing round-trip proof. Fire-and-forget; no-op unless
// __DEV__ && SIGNING_PROOF_ENABLED (see proof-flags.generated.ts). Logs under [spike013].
import {runSigningProofRunner} from './src/engines/signing-proof-runner';
runSigningProofRunner();

// Phase 37 (STR-02) dev-only on-device strand persistence proof. Fire-and-forget; no-op
// unless __DEV__ && STRAND_PERSISTENCE_PROOF_ENABLED (see proof-flags.generated.ts). Boots its
// own bootstrap/solo CadreNode and calls the existing runPersistenceProof(node), which emits
// the FULL-CHAIN VERDICT line under [proof]. Logs its own boot markers under [strand-persistence-proof].
import {runStrandPersistenceProof} from './src/engines/strand-persistence-proof-runner';
runStrandPersistenceProof();
