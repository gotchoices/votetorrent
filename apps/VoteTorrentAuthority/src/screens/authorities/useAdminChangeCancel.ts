import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { IAuthorityEngine, Officer, PendingAdminChange, Scope } from "@votetorrent/vote-core";
import { createDeviceSigner } from "../../engines/device-signer";
import { getDeviceUser, getOrCreateDeviceUser } from "../../engines/device-user";
import { useDeviceSigningErrorHandler } from "../../hooks/useDeviceSigningErrorHandler";
import { adminChangeErrorKey } from "../../utils/adminChangeErrors";
import { errorCopy } from "../../utils/errorCopy";

/**
 * useAdminChangeCancel — the single Cancel change path for Authority Details and Proposed
 * Administration (D-05). Both screens render the pending card with what this returns.
 *
 * Who may cancel: any current officer holding the revise-the-administration scope (`rad`). The
 * check is derived from the caller's own administration read (`currentOfficers`) plus the
 * read-only device user, not from a separate scope lookup: a second lookup would add engine opens
 * and administration reads to Authority Details, whose read counts are pinned. `canCancel` only
 * hides the button. The schema's canceller check and the engine's pre-prompt refusal enforce it.
 *
 * One tap costs one device signer and one `cancelAdminChange` call, so one biometric prompt. On
 * success the hook calls `onSettled` and the caller re-reads the administration; the hook never
 * patches administration data itself. A refusal shows translated copy by code and never the
 * engine's text. The hook reads only `pending.effectiveAt`, so a refused-promotion change
 * (not promoted) is cancelled exactly like a promoted one.
 */
export interface AdminChangeCancelArgs {
	pending: PendingAdminChange | undefined;
	currentOfficers: Officer[] | undefined;
	openEngine: () => Promise<IAuthorityEngine | null | undefined>;
	signerName: string;
	onSettled: () => void | Promise<void>;
}

export interface AdminChangeCancelState {
	canCancel: boolean;
	cancelling: boolean;
	cancelError: string;
	cancelled: boolean;
	cancel: () => Promise<void>;
}

const RAD = "rad" as Scope;

export function useAdminChangeCancel({
	pending,
	currentOfficers,
	openEngine,
	signerName,
	onSettled,
}: AdminChangeCancelArgs): AdminChangeCancelState {
	const { t } = useTranslation();
	const handleDeviceSigningError = useDeviceSigningErrorHandler();
	const [deviceUserId, setDeviceUserId] = useState<string | undefined>(undefined);
	const [cancelling, setCancelling] = useState(false);
	const [cancelError, setCancelError] = useState("");
	const [cancelled, setCancelled] = useState(false);
	const inFlightRef = useRef(false);

	const pendingEffectiveAt = pending?.effectiveAt;
	useEffect(() => {
		if (pendingEffectiveAt === undefined) return;
		let stale = false;
		setCancelled(false);
		setCancelError("");
		(async () => {
			try {
				const user = await getDeviceUser();
				if (!stale) setDeviceUserId(user?.id);
			} catch {
				if (!stale) setDeviceUserId(undefined);
			}
		})();
		return () => {
			stale = true;
		};
	}, [pendingEffectiveAt]);

	const canCancel =
		pending !== undefined &&
		deviceUserId !== undefined &&
		(currentOfficers ?? []).some(
			(o) => o.userId === deviceUserId && (o.scopes ?? []).includes(RAD)
		);

	const cancel = async (): Promise<void> => {
		if (inFlightRef.current || !pending) return;
		inFlightRef.current = true;
		setCancelling(true);
		setCancelError("");
		try {
			const engine = await openEngine();
			if (!engine) return;
			const deviceUser = await getOrCreateDeviceUser(signerName);
			const sign = await createDeviceSigner(signerName);
			await engine.cancelAdminChange(
				{ effectiveAt: pending.effectiveAt, userId: deviceUser.id },
				sign
			);
			setCancelled(true);
			await onSettled();
		} catch (err) {
			const outcome = handleDeviceSigningError(err);
			if (outcome.handled) return;
			const key = adminChangeErrorKey(err);
			setCancelError(key ? t(key) : outcome.message ?? errorCopy(err, t, "write"));
		} finally {
			inFlightRef.current = false;
			setCancelling(false);
		}
	};

	return { canCancel, cancelling, cancelError, cancelled, cancel };
}
