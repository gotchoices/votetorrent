import { ExtendedTheme, useTheme } from "@react-navigation/native";
import { useTranslation } from "react-i18next";
import type { SigningStatus } from "@votetorrent/vote-core";
import { ThemedText } from "../../../components/ThemedText";

export interface ThresholdProgressNoteProps {
	status: SigningStatus | null | undefined;
	testID?: string;
}

/**
 * ThresholdProgressNote — Surface 5 of the UI-SPEC (62-12, D-09/D-10/D-11).
 *
 * Renders nothing at threshold <= 1 (byte-identical to pre-62-12 rendering, the status is
 * display-only and fails open), on a null/undefined status (read failure, or no session), and
 * when the session is unreachable (D-11 — an unreachable session takes the EXISTING closed-task
 * path on the screens that embed this component; this component never renders a veto/failure
 * pill of its own).
 *
 * At or past the threshold (D-10) the note reads identically regardless of how many signatures
 * arrived after the threshold was crossed — reaching the threshold is informational only,
 * because the session's siblings stay open and signable (D-09). `rejected` and `openTasks` are
 * NEVER surfaced here: no copy exists for them, and showing a reject count would read as veto
 * framing, which D-11 forbids.
 *
 * `small` (14px, no explicit line height from ThemedText) is used here with an explicit
 * `lineHeight: 20` rather than the UI-SPEC typography table's `smallBold` — Surface 5's own
 * interaction contract (the binding per-surface text) specifies `small` / `colors.textSecondary`,
 * which takes precedence per this plan's Claude-discretion note (recorded in the SUMMARY).
 */
export function ThresholdProgressNote({ status, testID = "threshold-progress-note" }: ThresholdProgressNoteProps) {
	const { colors } = useTheme() as ExtendedTheme;
	const { t } = useTranslation();

	if (!status || status.threshold <= 1 || status.unreachable) {
		return null;
	}

	const text = status.reached
		? t("signatureTaskThresholdReached")
		: t("signatureTaskThresholdProgress", { signed: status.signatures, threshold: status.threshold });

	return (
		<ThemedText type="small" testID={testID} style={{ color: colors.textSecondary, lineHeight: 20 }}>
			{text}
		</ThemedText>
	);
}

export default ThresholdProgressNote;
