/**
 * main.tsx -- the dashboard's composition root.
 *
 * ROUTING RULE. The browser opens on the live shell when the registry holds a
 * paired network, and on the pairing screen otherwise: no entries, or only
 * legacy entries (networks restored by the retired sign-in code, which carry
 * no pairing). A legacy entry never reaches the shell; pairing replaces it.
 *
 * The shell (DashboardShell) runs the live boot itself and owns switching
 * between paired networks. A fresh pairing hands its member node and strand
 * reader to the shell as `adopt`, so the first open reuses the node the
 * pairing just started. The shell reports back through three callbacks:
 * "pair another network" (after it stopped its own boot), "this browser was
 * unpaired" (after the wipe settled) and "no paired network remains". Each
 * lands on the pairing screen; Escape from there returns to the network the
 * officer came from, while it is still paired.
 *
 * Nothing here reads stored network data, starts a peer, or holds a timer:
 * the registry read below is the whole decision.
 */
import './app.css';
import { StrictMode, useCallback, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { enginePreflight } from './engine-preflight.js';
import { isLegacyEntry, listNetworks } from '@votetorrent/web-data/officer';
import { Pairing, routeFromRegistry } from './screens/Pairing';
import type { PairingHandoff, UnpairedNotice } from './screens/Pairing';
import { DashboardShell } from './screens/DashboardShell';

declare global {
	interface Window {
		__DASHBOARD__?: Readonly<{ engineExportCount: number; engineExportNames: string[] }>;
	}
}

const { exportCount: engineExportCount, exportNames: engineExportNames } = enginePreflight();

// Stable, frozen readout hook — 50-05's two-page gate and 50-12's model↔DOM
// cross-check read this, mirroring the spikes' `window.__SPIKE076__` /
// `window.__SPIKE078__` convention.
window.__DASHBOARD__ = Object.freeze({ engineExportCount, engineExportNames });

type AppRoute =
	| { kind: 'pairing'; notice: UnpairedNotice | null; returnTo: string | null }
	| { kind: 'shell'; networkHash: string; adopt: PairingHandoff | null; mount: number };

/** The registry's routing verdict right now (the registry read is synchronous). */
function currentRoute(preferredHash?: string | null) {
	return routeFromRegistry(listNetworks(), isLegacyEntry, preferredHash);
}

let mountSeq = 0;

function initialRoute(): AppRoute {
	const route = currentRoute();
	if (route.kind === 'shell') return { kind: 'shell', networkHash: route.networkHash, adopt: null, mount: ++mountSeq };
	return { kind: 'pairing', notice: null, returnTo: null };
}

function App() {
	const [route, setRoute] = useState<AppRoute>(initialRoute);

	const shellNetworkHash = route.kind === 'shell' ? route.networkHash : null;

	const handlePairAnother = useCallback(() => {
		setRoute({ kind: 'pairing', notice: null, returnTo: shellNetworkHash });
	}, [shellNetworkHash]);

	const handleUnpaired = useCallback((notice: UnpairedNotice) => {
		const next = currentRoute();
		setRoute({ kind: 'pairing', notice, returnTo: next.kind === 'shell' ? next.networkHash : null });
	}, []);

	const handleNoNetworks = useCallback(() => {
		setRoute({ kind: 'pairing', notice: null, returnTo: null });
	}, []);

	const handlePaired = useCallback((result: { networkHash: string; handoff: PairingHandoff }) => {
		setRoute({ kind: 'shell', networkHash: result.networkHash, adopt: result.handoff, mount: ++mountSeq });
	}, []);

	const handleDismissNotice = useCallback(() => {
		setRoute((current) => (current.kind === 'pairing' && current.notice !== null ? { ...current, notice: null } : current));
	}, []);

	const returnTo = route.kind === 'pairing' ? route.returnTo : null;
	const handleCancel = useCallback(() => {
		if (returnTo === null) return;
		const back = currentRoute(returnTo);
		if (back.kind === 'shell' && back.networkHash === returnTo) {
			setRoute({ kind: 'shell', networkHash: back.networkHash, adopt: null, mount: ++mountSeq });
		}
	}, [returnTo]);

	if (route.kind === 'shell') {
		return (
			<DashboardShell
				key={route.mount}
				initialNetworkHash={route.networkHash}
				adopt={route.adopt}
				onPairAnother={handlePairAnother}
				onUnpaired={handleUnpaired}
				onNoNetworks={handleNoNetworks}
			/>
		);
	}

	return (
		<Pairing
			notice={route.notice}
			onDismissNotice={handleDismissNotice}
			hasPairedNetworks={currentRoute().kind === 'shell'}
			onPaired={handlePaired}
			onCancel={handleCancel}
		/>
	);
}

const rootElement = document.getElementById('root');
if (!rootElement) {
	throw new Error('#root element not found');
}

createRoot(rootElement).render(
	<StrictMode>
		<App />
	</StrictMode>,
);
