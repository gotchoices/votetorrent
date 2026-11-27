import { classifyPeerReadFailure } from "../engines/peer-read-unavailable";

/**
 * Shared classifier turning a peer-unavailable failure (a block unreachable through its cohort, or
 * possibly stale) into translated copy. Returns undefined for every other error so callers keep
 * their existing message: `peerUnavailableMessage(err, t, "read") ?? <existing>`; only the
 * peer-unavailable case changes.
 *
 * Used by the tab and write surfaces (gap 4: after a cold start a bundle-importing joiner does not
 * hold most table headers, so the first read or write of them can fail cohort-unreachable).
 * Pure; never throws.
 */
export function peerUnavailableMessage(
	err: unknown,
	t: (key: string) => string,
	kind: "read" | "write",
): string | undefined {
	if (!classifyPeerReadFailure(err)) return undefined;
	return kind === "read" ? t("peerReadUnavailableBody") : t("peerWriteUnavailable");
}
