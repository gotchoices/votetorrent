import React from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import { ExtendedTheme, useTheme } from "@react-navigation/native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTranslation } from "react-i18next";
import FontAwesome6 from "react-native-vector-icons/FontAwesome6";
import { ThemedText } from "../../components/ThemedText";
import { globalStyles } from "../../theme/styles";
import { useApp } from "../../providers/AppProvider";

/**
 * AttestationProvisioningStatusScreen — the D-09 legibility surface.
 *
 * D-09 fixed a real defect: before it, unprovisioned Play Console keys threw
 * at `EngineFactory.getEngine('association')` construction, blocking every
 * association *read* too — not just device association. After D-09 the
 * engine constructs regardless of provisioning state and `verify()` fails
 * closed instead, so registrant and association reads work independently of
 * whether keys are provisioned. That is exactly the distinction the
 * not-provisioned body communicates to an operator.
 *
 * The probe is read fail-conservative: an unknown state (a throw, a missing
 * member, a drifted return value) is always reported as NOT provisioned,
 * never as provisioned. See resolveProvisioningState below.
 *
 * There is deliberately no scope gate here — provisioning is a build/device
 * concern, not registrant data (47-PATTERNS.md:838, D-13), so gating this
 * screen behind an officer scope would make it unreachable for exactly the
 * operator who needs to diagnose a build.
 *
 * There is deliberately no InlineError and no pressable control anywhere on
 * this screen. There is no async load to fail and no user input to reject,
 * so the only failure mode is the probe itself misbehaving — and that is
 * handled by resolving to NOT provisioned, not by surfacing a diagnostic
 * string. The SETUP.md pointer below is static text because this app has no
 * markdown renderer and no deep-link-into-a-file affordance.
 *
 * This screen reports a build state; it does not itself prevent anything —
 * `verify()` is the control (D-01 framing, carried phase-wide).
 */

/**
 * The T-47-01 fail-conservative boundary. Returns `true` ONLY when `probe()`
 * returns strictly the boolean `true`. This guards, and resolves DOWN for,
 * three distinct failures:
 * - a probe that throws (a future factory getter that stops being total) —
 *   an operator must never be told attestation works because a diagnostic
 *   call failed;
 * - a probe returning `undefined`/`null` (a caller that never landed the
 *   provider member) — impossible at compile time, but the app ships
 *   transpiled;
 * - a probe returning a truthy non-boolean (a contract drift returning `1`
 *   or a key string) — only an explicit `true` licenses the "attestation is
 *   fully operational" claim.
 * This is deliberately a SECOND conservative layer on top of AppProvider's
 * own `?? false` fallback around a missing engine factory — they guard
 * different failures (a null factory vs. a throwing/drifting getter), so
 * this is defense in depth, not redundancy.
 */
export function resolveProvisioningState(probe: () => boolean): boolean {
	try {
		return probe() === true;
	} catch {
		return false;
	}
}

/**
 * The ONE discriminant producing the testID base and both i18n keys
 * together, so a provisioned heading can never render above a
 * not-provisioned body (T-47-19-02). A future state addition adds a branch
 * here and nowhere else.
 */
export function provisioningCopy(provisioned: boolean): {
	testIDBase: string;
	headingKey: string;
	bodyKey: string;
} {
	if (provisioned) {
		return {
			testIDBase: "attestation-provisioning-provisioned",
			headingKey: "attestationProvisioningProvisionedHeading",
			bodyKey: "attestationProvisioningProvisionedBody",
		};
	}
	return {
		testIDBase: "attestation-provisioning-not-provisioned",
		headingKey: "attestationProvisioningNotProvisionedHeading",
		bodyKey: "attestationProvisioningNotProvisionedBody",
	};
}

export default function AttestationProvisioningStatusScreen() {
	const insets = useSafeAreaInsets();
	const { colors } = useTheme() as ExtendedTheme;
	const { t } = useTranslation();
	const { isAttestationVerifierProvisioned } = useApp();

	// The probe reference is passed, never called here — resolveProvisioningState
	// owns the call and its fail-conservative handling.
	const provisioned = resolveProvisioningState(isAttestationVerifierProvisioned);
	const copy = provisioningCopy(provisioned);
	// The status-color ladder: Provisioned = success, Not provisioned = warning.
	// One const feeds both the icon and the card border so they can never disagree.
	const statusColor = provisioned ? colors.success : colors.warning;

	return (
		<ScrollView
			testID="attestation-provisioning-screen"
			style={styles.container}
			contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}
		>
			{/* The status-color ladder above licenses the success border here in the
			    provisioned state, mirroring the Policy Issues card's warning-border
			    treatment (Phase 46) with the border color carried by statusColor
			    rather than hardcoded. */}
			<View
				testID="attestation-provisioning-card"
				style={[styles.cardSurface, { backgroundColor: colors.card, borderLeftWidth: 4, borderLeftColor: statusColor }]}
			>
				<View style={localStyles.headingRow}>
					<View testID="attestation-provisioning-icon">
						<FontAwesome6 name="shield-halved" size={16} color={statusColor} />
					</View>
					<ThemedText type="defaultSemiBold" testID={`${copy.testIDBase}-heading`}>
						{t(copy.headingKey)}
					</ThemedText>
				</View>

				<ThemedText type="default" style={localStyles.bodyText} testID={`${copy.testIDBase}-body`}>
					{t(copy.bodyKey)}
				</ThemedText>

				{/* Rendered in BOTH states. This is intentionally a plain ThemedText and
				    not a link: the app has no markdown renderer and no affordance to
				    open a repo file, so a tappable control here would be a dead end
				    that implies a capability the app does not have. */}
				<ThemedText
					type="small"
					style={[localStyles.setupPointer, { color: colors.textSecondary }]}
					testID="attestation-provisioning-setup-pointer"
				>
					{t("attestationProvisioningSetupLink")}
				</ThemedText>
			</View>
		</ScrollView>
	);
}

const localStyles = StyleSheet.create({
	headingRow: {
		flexDirection: "row",
		alignItems: "center",
		gap: 8,
	},
	bodyText: {
		marginTop: 8,
	},
	setupPointer: {
		marginTop: 16,
	},
});

const styles = { ...globalStyles, ...localStyles };
