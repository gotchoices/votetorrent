import {useCallback, useEffect, useRef, useState} from 'react';
import {useTranslation} from 'react-i18next';
import {fingerprintMedia, MediaFingerprintError} from '@votetorrent/vote-engine/rn';
import type {MediaFingerprintFailure} from '@votetorrent/vote-engine/rn';

/**
 * State behind one "Make Permanent" chip on an image/video URL field. `pin(url)` downloads the
 * media once and records its content id (vote-engine `fingerprintMedia`); `cidFor(url)` returns
 * that cid ONLY while the field still holds the exact URL that was fingerprinted — editing the
 * URL silently un-pins it, so a cid is never saved next to a URL it does not describe.
 */
type PinState =
	| {kind: 'idle'}
	| {kind: 'pinning'; url: string}
	| {kind: 'pinned'; url: string; cid: string}
	| {kind: 'failed'; url: string; reason: MediaFingerprintFailure};

export interface MediaPinStatus {
	label: string;
	tone: 'muted' | 'success' | 'error';
}

const FAILURE_KEY: Record<MediaFingerprintFailure, string> = {
	'invalid-url': 'mediaPinInvalidUrl',
	network: 'mediaPinNetwork',
	http: 'mediaPinHttp',
	'too-large': 'mediaPinTooLarge',
	empty: 'mediaPinEmpty',
};

/** A cid is long; the status line shows enough to compare by eye. */
function shortCid(cid: string): string {
	return cid.length > 16 ? `${cid.slice(0, 10)}…${cid.slice(-6)}` : cid;
}

export function useMediaPin(initial?: {url?: string; cid?: string}) {
	const {t} = useTranslation();
	const [state, setState] = useState<PinState>(
		initial?.url && initial.cid ? {kind: 'pinned', url: initial.url.trim(), cid: initial.cid} : {kind: 'idle'},
	);
	const mounted = useRef(true);
	useEffect(
		() => () => {
			mounted.current = false;
		},
		[],
	);

	/** Re-seed from a record that loaded after mount (an existing option or network revision). */
	const reset = useCallback((ref?: {url?: string; cid?: string}) => {
		setState(ref?.url && ref.cid ? {kind: 'pinned', url: ref.url.trim(), cid: ref.cid} : {kind: 'idle'});
	}, []);

	const pin = useCallback(async (rawUrl: string) => {
		const url = rawUrl.trim();
		setState({kind: 'pinning', url});
		try {
			const result = await fingerprintMedia(url);
			if (mounted.current) setState({kind: 'pinned', url: result.url, cid: result.cid});
		} catch (err) {
			const reason: MediaFingerprintFailure = err instanceof MediaFingerprintError ? err.reason : 'network';
			if (mounted.current) setState({kind: 'failed', url, reason});
		}
	}, []);

	const cidFor = useCallback(
		(url: string): string | undefined => (state.kind === 'pinned' && state.url === url.trim() ? state.cid : undefined),
		[state],
	);

	/** Status line for the field's current value; nothing once the URL no longer matches. */
	const statusFor = useCallback(
		(url: string): MediaPinStatus | undefined => {
			if (state.kind === 'idle' || state.url !== url.trim()) return undefined;
			if (state.kind === 'pinning') return {label: t('mediaPinning'), tone: 'muted'};
			if (state.kind === 'pinned') return {label: t('mediaPinned', {cid: shortCid(state.cid)}), tone: 'success'};
			return {label: t(FAILURE_KEY[state.reason]), tone: 'error'};
		},
		[state, t],
	);

	return {pin, cidFor, statusFor, reset, isPinning: state.kind === 'pinning'};
}
