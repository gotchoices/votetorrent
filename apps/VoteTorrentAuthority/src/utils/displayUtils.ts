import { ADMIN_CHANGE_DELAY_MS, UserKeyType } from '@votetorrent/vote-core';

export const getKeyTypeDisplayName = (keyType?: UserKeyType): string => {
	if (keyType === UserKeyType.mobile) {
		return 'mobile';
	} else if (keyType === UserKeyType.yubico) {
		return 'Yubico';
	}
	return keyType || 'Unknown';
};

export const formatDate = (dateValue: number | undefined | null): string => {
	if (dateValue === undefined || dateValue === null) {
		return 'N/A';
	}
	const date = new Date(dateValue);
	return date.toISOString().split('T')[0];
};

const pad2 = (n: number): string => (n < 10 ? '0' + n : String(n));

const CANONICAL_RE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?Z?$/;

/**
 * The instant a canonical UTC datetime names, or undefined when it does not match. Built with
 * Date.UTC from the matched parts: a string without a zone suffix would otherwise be read as
 * local time, and Hermes reads non-ISO forms differently from Node.
 */
const canonicalUtcMs = (canonical: string): number | undefined => {
	if (typeof canonical !== 'string') {
		return undefined;
	}
	const m = CANONICAL_RE.exec(canonical);
	if (!m) {
		return undefined;
	}
	const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]));
	return Number.isFinite(ms) ? ms : undefined;
};

/** Canonical UTC datetime in, the phone's local 24-hour `HH:MM` out (input returned unchanged when unreadable). */
export const formatLocalTime = (canonical: string): string => {
	const ms = canonicalUtcMs(canonical);
	if (ms === undefined) {
		return canonical;
	}
	const d = new Date(ms);
	return pad2(d.getHours()) + ':' + pad2(d.getMinutes());
};

/**
 * How long a confirm card may stay open before its effective time must be recomputed: one minute.
 * It is kept well under the five-minute change delay, so a signed time is always at least four
 * minutes away and the cancel window is never used up while the card sits open.
 */
export const ADMIN_CHANGE_CONFIRM_MAX_AGE_MS = 60_000;

/**
 * True when a confirm card has been open for more than one minute since the tap that produced
 * `confirmAt` (the effective time the card shows), or when `confirmAt` cannot be read. A stale
 * card is never signed: the screens recompute the time and show the card again, so the officer
 * always gets the full pending window. The engine accepts past times on purpose (fixtures, the
 * command-line tool and the live-mesh host rely on it), so this check belongs to the app.
 */
export const isAdminChangeConfirmStale = (confirmAt: string, nowMs: number): boolean => {
	const at = canonicalUtcMs(confirmAt);
	if (at === undefined || !Number.isFinite(nowMs)) {
		return true;
	}
	return nowMs > at - ADMIN_CHANGE_DELAY_MS + ADMIN_CHANGE_CONFIRM_MAX_AGE_MS;
};
