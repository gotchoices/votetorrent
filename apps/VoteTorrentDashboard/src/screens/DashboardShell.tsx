/**
 * DashboardShell.tsx -- the live shell around one paired network's data.
 *
 * What it owns:
 *   - The selected network's live boot. One network runs at a time: the
 *     other networks in the switcher are listed but not syncing, and a
 *     switch stops the old boot before the new one starts, so the old
 *     network's chip and panels leave the screen at once.
 *   - ONE header status chip, driven by the status reducer's view. A change
 *     of kind renders only after it has held for one second, the hold resets
 *     on every new boot (no "Live" carried over from another network), and
 *     the chip is the page's only status role.
 *   - Reconnect, beside the chip and outside its live region, while Offline.
 *   - The follower note, when another tab of this browser runs the network.
 *   - Advisory scope gating and "Preview as". Scopes are read for the
 *     VERIFIED officer user id the registry holds and re-read when the data
 *     changes; gating stays advisory and says so.
 *   - The officer each network is paired as, named in every switcher row
 *     (the registry's optional display name, else the officer user id).
 *     "+ Pair another network" stops the running boot before pairing starts,
 *     so pairing (and any officer swap it asks about, which the pairing
 *     screen shows) never races a live boot.
 *   - The forget dialog, with copy that promises no erasure elsewhere.
 *
 * The peer layer is reached only through a dynamic import of the boot
 * module, inside the boot controller's loader, so the entry chunk carries no
 * peer stack. The panel grid gets a memoized data version, keyed by network
 * hash, with marks held off during the first catch-up and on a local-copy
 * load.
 *
 * Logging: one fixed prefix plus an error's name. No row value, name or
 * message text.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Database } from '@quereus/quereus';
import { t } from '@votetorrent/ui-web';
import type { ScopeCode } from '../auth/capabilities.js';
import { CAPABILITIES, PANEL_GROUPS } from '../auth/capabilities.js';
import { readGrantedScopes } from '../auth/is-privileged.js';
import { isLegacyEntry, listNetworks } from '@votetorrent/web-data/officer';
import type { NetworkRegistryEntry } from '@votetorrent/web-data/officer';
import { forgetNetwork } from '../lifecycle/forget-network.js';
import { useBootDataVersion, useLiveStatus } from '../live/useLiveStatus.js';
import {
	chipModel,
	createShellBootController,
	officerLabel,
	panelDataVersion,
	stepChipDebounce,
} from '../live/shell-live.js';
import type {
	ChipDebounceState,
	ChipModel,
	ChipView,
	ShellAdopt,
	ShellBoot,
	ShellBootController,
	ShellBootModule,
	UnpairedReason,
} from '../live/shell-live.js';
import { AdvisoryDisclosure, PreviewAsControl, PreviewAsProvider } from './PreviewAsControl.js';
import { PanelGrid } from './PanelGrid.js';
import './shell.css';

/** What the pairing screen needs to show the unpaired notice. */
export interface UnpairedNotice {
	reason: UnpairedReason;
	authorityName: string;
	officerName: string | null;
}

export interface DashboardShellProps {
	/** The network to open first; the first paired network when absent or unknown. */
	initialNetworkHash?: string;
	/** The pairing handoff for `initialNetworkHash`, consumed by the first open only. */
	adopt?: ShellAdopt | null;
	/** Called once the running boot has stopped. */
	onPairAnother: () => void;
	/** Called after the boot unpaired this browser (the local copy is already gone). */
	onUnpaired: (notice: UnpairedNotice) => void;
	/** Called when no paired network is left. */
	onNoNetworks: () => void;
	/** Forwarded verbatim to the boot (the gates' fake peer layer). */
	bootDeps?: Record<string, unknown>;
}

const LOG_PREFIX = 'screens/DashboardShell:';

function logFailure(err: unknown): void {
	const name =
		err !== null && typeof err === 'object' && typeof (err as { name?: unknown }).name === 'string'
			? (err as { name: string }).name
			: 'Error';
	// eslint-disable-next-line no-console
	console.error(LOG_PREFIX, name);
}

/**
 * The peer layer arrives only through this lazy import, so the entry chunk
 * carries no cadre-core. The controller uses only its two boot functions
 * (`startDashboardBoot`, `switchDashboardBoot`).
 */
function loadBootModule(): Promise<ShellBootModule> {
	return import('../peer/boot.js').then(asShellBootModule);
}

function asShellBootModule(module: unknown): ShellBootModule {
	return module as ShellBootModule;
}

/** The paired networks only; a registry that cannot be read lists none. */
function readPairedNetworks(): NetworkRegistryEntry[] {
	try {
		return listNetworks().filter((entry) => !isLegacyEntry(entry));
	} catch (err) {
		logFailure(err);
		return [];
	}
}

/** A stable key per boot object, so the chip's debounce resets on every new boot. */
const bootKeys = new WeakMap<object, string>();
let nextBootKey = 0;
function bootKeyOf(boot: ShellBoot | null): string | null {
	if (!boot) return null;
	let key = bootKeys.get(boot);
	if (key === undefined) {
		nextBootKey += 1;
		key = `boot-${nextBootKey}`;
		bootKeys.set(boot, key);
	}
	return key;
}

/**
 * The view the chip shows: `stepChipDebounce` on every view change, with ONE
 * timeout while a flip is held. A new boot's first view shows at once.
 */
function useChipDebounce(view: ChipView | null, bootKey: string | null): ChipView | null {
	const stateRef = useRef<ChipDebounceState | null>(null);
	const [state, setState] = useState<ChipDebounceState | null>(null);
	useEffect(() => {
		let timer: ReturnType<typeof setTimeout> | null = null;
		const run = (): void => {
			const step = stepChipDebounce(stateRef.current, view, Date.now(), bootKey);
			stateRef.current = step.state;
			setState(step.state);
			if (step.wakeAt !== null) {
				timer = setTimeout(run, Math.max(0, step.wakeAt - Date.now()));
			}
		};
		run();
		return () => {
			if (timer !== null) clearTimeout(timer);
		};
	}, [view, bootKey]);
	return state !== null && state.bootKey === bootKey ? state.shown : view;
}

export interface SwitcherRowModel {
	networkHash: string;
	authorityName: string;
	detail: string;
	active: boolean;
}

export interface ShellTopBarProps {
	active: { authorityName: string; domain: string };
	rows: ReadonlyArray<SwitcherRowModel>;
	switcherOpen: boolean;
	onToggleSwitcher: () => void;
	onSelectNetwork: (networkHash: string) => void;
	onPairAnother: () => void;
	model: ChipModel | null;
	onReconnect: () => void;
	kebabOpen: boolean;
	onToggleKebab: () => void;
	onOpenForget: () => void;
}

/** The status region: the chip (the page's one status role) and, in Offline, Reconnect beside it. */
export function StatusChip({ model, onReconnect }: { model: ChipModel | null; onReconnect: () => void }) {
	if (!model) {
		return <div className="sh-status-region" />;
	}
	return (
		<div className="sh-status-region">
			<span
				className="sh-status-chip"
				data-kind={model.kind}
				role="status"
				aria-live="polite"
				aria-atomic="true"
				title={model.title ?? undefined}
			>
				<span className="sh-status-dot" aria-hidden="true" />
				<span className="sh-status-word">{model.word}</span>
				{model.separator !== null && model.detail !== null ? (
					<>
						<span className="sh-status-sep">{model.separator}</span>
						<span className="sh-status-detail">{model.detail}</span>
					</>
				) : null}
			</span>
			{model.showReconnect ? (
				<button type="button" className="sh-reconnect" disabled={model.reconnecting} onClick={onReconnect}>
					{model.reconnecting ? t('status.reconnecting') : t('status.reconnect')}
				</button>
			) : null}
		</div>
	);
}

/** The top bar: identity, switcher, status, preview-as and the kebab, then the follower note. */
export function ShellTopBar(props: ShellTopBarProps) {
	const { active, rows, switcherOpen, model, kebabOpen } = props;
	return (
		<div className="sh-topbar">
			<div className="sh-identity">
				<span className="sh-authority-name" title={active.authorityName}>
					{active.authorityName}
				</span>
				<span className="sh-domain">{active.domain}</span>
			</div>

			<div className="sh-topbar-actions">
				<div className="sh-switcher">
					<button
						type="button"
						className="sh-switcher-button"
						title={active.authorityName}
						aria-expanded={switcherOpen}
						onClick={props.onToggleSwitcher}
					>
						{active.authorityName}
					</button>
					{switcherOpen ? (
						<div className="sh-switcher-list" role="menu">
							{rows.map((row) =>
								row.active ? (
									<button
										key={row.networkHash}
										type="button"
										role="menuitem"
										className="sh-switcher-row sh-switcher-row--active"
										aria-current="true"
										onClick={() => props.onSelectNetwork(row.networkHash)}
									>
										<span className="sh-switcher-row-name" title={row.authorityName}>
											{row.authorityName}
										</span>
										<span className="sh-switcher-row-meta" title={row.detail}>
											{row.detail}
										</span>
									</button>
								) : (
									<button
										key={row.networkHash}
										type="button"
										role="menuitem"
										className="sh-switcher-row"
										onClick={() => props.onSelectNetwork(row.networkHash)}
									>
										<span className="sh-switcher-row-name" title={row.authorityName}>
											{row.authorityName}
										</span>
										<span className="sh-switcher-row-meta sh-switcher-row-meta--idle" title={row.detail}>
											{row.detail}
										</span>
									</button>
								),
							)}
							<button type="button" role="menuitem" className="sh-switcher-pair" onClick={props.onPairAnother}>
								{t('switcher.pairAnother')}
							</button>
						</div>
					) : null}
				</div>

				<StatusChip model={model} onReconnect={props.onReconnect} />

				<PreviewAsControl />
				<AdvisoryDisclosure variant="authority" />

				<div className="sh-kebab">
					<button
						type="button"
						className="sh-kebab-button"
						aria-label={t('chrome.moreOptionsAriaLabel')}
						aria-expanded={kebabOpen}
						onClick={props.onToggleKebab}
					>
						⋮
					</button>
					{kebabOpen ? (
						<div className="sh-kebab-menu" role="menu">
							<button type="button" role="menuitem" className="sh-kebab-item--destructive" onClick={props.onOpenForget}>
								{t('forget.cta')}
							</button>
						</div>
					) : null}
				</div>
			</div>

			{model?.showFollowerNote ? (
				<p className="sh-follower-note">
					<span className="sh-follower-word">{t('status.chip.not-live')}</span>{' '}{t('status.followerNote')}
				</p>
			) : null}
		</div>
	);
}

export function DashboardShell({
	initialNetworkHash,
	adopt = null,
	onPairAnother,
	onUnpaired,
	onNoNetworks,
	bootDeps,
}: DashboardShellProps) {
	const [networks, setNetworks] = useState<NetworkRegistryEntry[]>(() => readPairedNetworks());
	const [activeNetworkHash, setActiveNetworkHash] = useState<string | undefined>(() =>
		initialNetworkHash !== undefined && networks.some((entry) => entry.networkHash === initialNetworkHash)
			? initialNetworkHash
			: networks[0]?.networkHash,
	);
	const activeEntry = networks.find((entry) => entry.networkHash === activeNetworkHash);

	// Props are read at mount; the latest callbacks are kept in refs so the
	// boot subscriptions never call a stale closure.
	const onPairAnotherRef = useRef(onPairAnother);
	const onUnpairedRef = useRef(onUnpaired);
	const onNoNetworksRef = useRef(onNoNetworks);
	onPairAnotherRef.current = onPairAnother;
	onUnpairedRef.current = onUnpaired;
	onNoNetworksRef.current = onNoNetworks;
	const networksRef = useRef(networks);
	networksRef.current = networks;
	const adoptRef = useRef<ShellAdopt | null>(adopt);
	const initialHashRef = useRef(activeNetworkHash);

	const controllerRef = useRef<ShellBootController | null>(null);
	if (controllerRef.current === null) {
		controllerRef.current = createShellBootController({
			loadBootModule,
			bootDeps,
		});
	}
	const controller = controllerRef.current;

	const [boot, setBoot] = useState<ShellBoot | null>(null);
	const [openFailed, setOpenFailed] = useState(false);
	const [grantedScopes, setGrantedScopes] = useState<ScopeCode[]>([]);
	// Gates the "Preview as" controls: true only once the scopes have been
	// read for the current boot; re-closed on every boot change.
	const [scopesResolved, setScopesResolved] = useState(false);
	const [liveBootKey, setLiveBootKey] = useState<string | null>(null);

	const [revealDenied, setRevealDenied] = useState(false);
	const [switcherOpen, setSwitcherOpen] = useState(false);
	const [kebabOpen, setKebabOpen] = useState(false);

	const [forgetConfirmationInput, setForgetConfirmationInput] = useState('');
	const [forgetFailed, setForgetFailed] = useState(false);
	const forgetDialogRef = useRef<HTMLDialogElement | null>(null);
	// The ref, not the state, is the re-entrancy guard: a double-click
	// dispatches both clicks before any re-render could disable the control.
	// Released on both outcomes, because a failed forget changes nothing and
	// may be retried.
	const forgettingRef = useRef(false);
	const [forgetting, setForgetting] = useState(false);

	useEffect(() => controller.subscribe(setBoot), [controller]);

	const openNetwork = useCallback(
		async (networkHash: string, openAdopt?: ShellAdopt | null): Promise<void> => {
			setOpenFailed(false);
			const result = await controller.open(networkHash, { adopt: openAdopt ?? undefined });
			if (result.stale) return;
			if (result.loadFailed) {
				setOpenFailed(true);
				return;
			}
			if (result.boot?.failure === 'unknown-network') {
				const remaining = readPairedNetworks().filter((entry) => entry.networkHash !== networkHash);
				const next = remaining[0];
				if (next) {
					setNetworks(remaining);
					setActiveNetworkHash(next.networkHash);
					void openNetwork(next.networkHash);
				} else {
					// The empty list routes away (the effect below calls onNoNetworks).
					await controller.stopActive();
					setNetworks([]);
				}
			}
		},
		[controller],
	);

	/** Re-read the registry, then open its first paired network or leave the shell. */
	const openNextOrLeave = useCallback(async (): Promise<void> => {
		const remaining = readPairedNetworks();
		const next = remaining[0];
		if (!next) {
			await controller.stopActive();
			setNetworks([]);
			return;
		}
		setNetworks(remaining);
		setActiveNetworkHash(next.networkHash);
		await openNetwork(next.networkHash);
	}, [controller, openNetwork]);

	// The first open, with the pairing handoff when one was given. StrictMode
	// runs this twice: the handoff is taken once, and the second run resumes
	// from storage.
	useEffect(() => {
		const hash = initialHashRef.current;
		if (hash === undefined) return undefined;
		const handoff = adoptRef.current;
		adoptRef.current = null;
		void openNetwork(hash, handoff);
		return () => {
			void controller.stopActive();
		};
	}, [controller, openNetwork]);

	// With no paired network left there is nothing to show: route away.
	useEffect(() => {
		if (networks.length === 0) onNoNetworksRef.current();
	}, [networks.length]);

	// Per-boot subscriptions. The names are captured now: once the boot
	// unpairs, the registry entry is gone.
	useEffect(() => {
		if (!boot) return undefined;
		const entry = networksRef.current.find((candidate) => candidate.networkHash === boot.networkHash);
		const captured = { authorityName: entry?.authorityName ?? '', officerName: entry?.officerName ?? null };
		const offUnpaired = boot.onUnpaired((reason) => {
			onUnpairedRef.current({ reason, authorityName: captured.authorityName, officerName: captured.officerName });
		});
		const offForgotten = boot.onForgotten(() => {
			if (forgettingRef.current) return;
			void openNextOrLeave();
		});
		return () => {
			offUnpaired();
			offForgotten();
		};
	}, [boot, openNextOrLeave]);

	const view = useLiveStatus(boot);
	const bootKey = bootKeyOf(boot);
	const shownView = useChipDebounce(view, bootKey);
	const model = chipModel(shownView);

	useEffect(() => {
		if (view?.kind === 'live' && bootKey !== null) setLiveBootKey(bootKey);
	}, [view?.kind, bootKey]);

	const bootVersion = useBootDataVersion(boot);
	const everLive = bootKey !== null && liveBootKey === bootKey;
	const follower = view?.kind === 'not-live';
	const panelVersion = useMemo(
		() => panelDataVersion(bootVersion, { everLive, follower }),
		[bootVersion, everLive, follower],
	);

	// Scopes for the VERIFIED officer id; re-read when the data version moves.
	useEffect(() => {
		setGrantedScopes([]);
		setScopesResolved(false);
	}, [boot]);
	useEffect(() => {
		const db = boot?.db as Database | null | undefined;
		if (!boot || !db || !activeEntry || boot.networkHash !== activeEntry.networkHash) return undefined;
		let cancelled = false;
		void (async () => {
			try {
				const scopes = await readGrantedScopes(db, activeEntry.officerUserId);
				if (cancelled) return;
				setGrantedScopes((prev) => (prev.join(',') === scopes.join(',') ? prev : scopes));
				setScopesResolved(true);
			} catch (err) {
				if (!cancelled) logFailure(err);
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [boot, bootVersion.version, activeEntry]);

	// Esc closes an open switcher or kebab.
	useEffect(() => {
		if (!switcherOpen && !kebabOpen) return undefined;
		const onKeyDown = (event: KeyboardEvent): void => {
			if (event.key === 'Escape') {
				setSwitcherOpen(false);
				setKebabOpen(false);
			}
		};
		window.addEventListener('keydown', onKeyDown);
		return () => window.removeEventListener('keydown', onKeyDown);
	}, [switcherOpen, kebabOpen]);

	function handleSelectNetwork(networkHash: string): void {
		setSwitcherOpen(false);
		if (networkHash === activeNetworkHash) return;
		setActiveNetworkHash(networkHash);
		void openNetwork(networkHash);
	}

	async function handlePairAnother(): Promise<void> {
		setSwitcherOpen(false);
		await controller.stopActive();
		onPairAnotherRef.current();
	}

	function handleReconnect(): void {
		if (boot) void boot.reconnect().catch(logFailure);
	}

	function handleRetryOpen(): void {
		if (activeNetworkHash !== undefined) void openNetwork(activeNetworkHash);
	}

	function handleOpenForgetDialog(): void {
		setForgetConfirmationInput('');
		setForgetFailed(false);
		setKebabOpen(false);
		forgetDialogRef.current?.showModal();
	}

	async function handleConfirmForget(): Promise<void> {
		if (!activeEntry || forgettingRef.current) return;
		forgettingRef.current = true;
		setForgetting(true);
		setForgetFailed(false);
		try {
			await forgetNetwork({ networkHash: activeEntry.networkHash, typedConfirmation: forgetConfirmationInput });
			forgetDialogRef.current?.close();
			// The forget already stopped the boot; this clears the shell's hold on it.
			await controller.stopActive();
			await openNextOrLeave();
		} catch (err) {
			// The dialog stays open and the network stays listed: nothing changed.
			logFailure(err);
			setForgetFailed(true);
		} finally {
			forgettingRef.current = false;
			setForgetting(false);
		}
	}

	if (!activeEntry) {
		return null;
	}

	const rows: SwitcherRowModel[] = networks.map((entry) => {
		const active = entry.networkHash === activeNetworkHash;
		const officerName = officerLabel(entry.officerName, entry.officerUserId);
		return {
			networkHash: entry.networkHash,
			authorityName: entry.authorityName,
			active,
			detail: active
				? t('switcher.rowDetail', { domain: entry.domain, officerName })
				: t('switcher.rowDetailNotSyncing', { domain: entry.domain, officerName }),
		};
	});

	// An EMPTY expected name leaves nothing to confirm against, so the
	// destructive control stays disabled; `forgetNetwork` refuses the same
	// case on its own.
	const forgetExpectedName = activeEntry.authorityName.trim();
	const forgetConfirmDisabled =
		forgetting || forgetExpectedName.length === 0 || forgetConfirmationInput.trim() !== forgetExpectedName;

	const bootFailed = openFailed || (boot !== null && boot.failure !== null && boot.failure !== 'unknown-network');
	const unpairing = view?.kind === 'unpaired';
	const bootDb = (boot?.db ?? null) as Database | null;

	return (
		<PreviewAsProvider realScopes={grantedScopes} scopesResolved={scopesResolved}>
			<div className="sh-layout">
				<ShellTopBar
					active={{ authorityName: activeEntry.authorityName, domain: activeEntry.domain }}
					rows={rows}
					switcherOpen={switcherOpen}
					onToggleSwitcher={() => setSwitcherOpen((open) => !open)}
					onSelectNetwork={handleSelectNetwork}
					onPairAnother={() => void handlePairAnother()}
					model={unpairing ? null : model}
					onReconnect={handleReconnect}
					kebabOpen={kebabOpen}
					onToggleKebab={() => setKebabOpen((open) => !open)}
					onOpenForget={handleOpenForgetDialog}
				/>

				<div className="sh-body">
					<nav className="sh-sidebar">
						{PANEL_GROUPS.map((group) => (
							<div key={group.id} className="sh-sidebar-group">
								<div className="sh-sidebar-heading">{t(group.titleKey)}</div>
								{CAPABILITIES.filter((capability) => capability.group === group.id).map((capability) => (
									<a key={capability.id} className="sh-sidebar-row" href={`#panel-${capability.id}`}>
										{t(capability.titleKey)}
									</a>
								))}
							</div>
						))}
					</nav>

					<main>
						{unpairing ? null : bootFailed ? (
							<div className="sh-error-banner">
								<p>{t('shell.openFailed')}</p>
								<button type="button" className="sh-error-retry" onClick={handleRetryOpen}>
									{t('status.reconnect')}
								</button>
							</div>
						) : boot === null ? (
							<p className="sh-opening">{t('switcher.opening', { authorityName: activeEntry.authorityName })}</p>
						) : (
							<PanelGrid
								key={activeNetworkHash}
								db={bootDb}
								revealDenied={revealDenied}
								onToggleReveal={() => setRevealDenied((value) => !value)}
								dataVersion={panelVersion}
							/>
						)}
					</main>
				</div>

				{/*
				 * No invented cancel label: Esc fires the dialog's native cancel
				 * event. The destructive control stays disabled until the typed
				 * text equals the authority name exactly.
				 */}
				<dialog ref={forgetDialogRef} className="sh-dialog" onCancel={() => setForgetFailed(false)}>
					<h2>{t('forget.heading', { authorityName: activeEntry.authorityName })}</h2>
					<p>{t('forget.body', { authorityName: activeEntry.authorityName })}</p>
					<label htmlFor="sh-forget-confirmation">{t('forget.fieldLabel')}</label>
					<input
						id="sh-forget-confirmation"
						className="sh-dialog-input"
						type="text"
						autoComplete="off"
						value={forgetConfirmationInput}
						onChange={(event) => setForgetConfirmationInput(event.target.value)}
					/>
					{forgetFailed ? <p className="sh-dialog-error">{t('forget.failed')}</p> : null}
					<div className="sh-dialog-actions">
						<button
							type="button"
							className="sh-dialog-cta--destructive"
							disabled={forgetConfirmDisabled}
							onClick={() => void handleConfirmForget()}
						>
							{t('forget.cta')}
						</button>
					</div>
				</dialog>
			</div>
		</PreviewAsProvider>
	);
}

export default DashboardShell;
