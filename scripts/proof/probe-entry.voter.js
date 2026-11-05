// probe-entry.voter.js - the Voter entry used ONLY when a scratch Metro wrapper serves the dev probes.
//
// That wrapper redirects the resolved Voter index.js to this file when its probes flag is set, and it must
// not redirect imports made from scripts/proof/ itself, or this entry would import itself. No tracked Metro
// config names this file, and no app source imports it.
//
// The app's own index.js is imported FIRST, so the polyfills, the native crypto and the component registration
// run exactly as in the real app before any probe registers.
import '../../apps/VoteTorrentVoter/index.js';
import { registerDecryptProbe } from './decrypt-probe';

if (__DEV__) {
	registerDecryptProbe();
	console.info('[vt64-probes] voter probes registered');
}
