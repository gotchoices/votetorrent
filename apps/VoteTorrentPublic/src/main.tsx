import './app.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { enginePreflight } from './engine-preflight.js';
import { PublicApp } from './screens/PublicApp';

declare global {
	interface Window {
		__PUBLIC_APP__?: Readonly<{ schemaByteLength: number; schemaLineCount: number }>;
	}
}

const { schemaByteLength, schemaLineCount } = enginePreflight();

// Stable, frozen readout hook, adapted from the dashboard's `__DASHBOARD__`
// convention (not copied — the fields are this app's own D-13 preflight
// fields). This is a PRODUCTION readout, not a test-harness global: 53-09's
// `assert-no-test-harness-in-dist.mjs` instance for this app must not list
// `__PUBLIC_APP__` among the harness tokens it forbids in `dist/`.
//
// Assigning to a global is a side effect Rollup preserves, which is the
// second half of why the schema string cannot be shaken out of the bundle
// (see engine-preflight.js's header for the first half).
window.__PUBLIC_APP__ = Object.freeze({ schemaByteLength, schemaLineCount });

const rootElement = document.getElementById('root');
if (!rootElement) {
	throw new Error('main.tsx: #root element not found in index.html');
}

createRoot(rootElement).render(
	<StrictMode>
		{/* 56-12: production mounts PublicApp, not a bare ElectionShell, with
		    no props of its own. 56-14 MOVED the one production peer-boot call
		    site INTO PublicApp.tsx -- a boot whose result lives outside React
		    can never reach a component, and `PublicApp` is now the thing that
		    needs the result (the second conjunct of the connection
		    predicate). PublicApp resolves 56-06's bootstrap config once at
		    boot, boots the peer layer once at boot, and hands ElectionShell
		    one resolved deployment fault (or null) plus one observed
		    peer-feed status -- both resolved ABOVE the shell because the
		    shell holds no effects. Everything ElectionShell itself still
		    supplies no facts about: no injected election, no instant, no
		    injected search, no source. The production import graph still
		    reaches `src/peer/boot.js` through PublicApp.tsx, so the
		    libp2p/strand closure still lands in `dist/` -- see
		    PublicApp.tsx's own header for the full accounting. */}
		<PublicApp />
	</StrictMode>,
);
