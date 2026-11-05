import { useEffect, useRef, useState } from "react";
import { ExtendedTheme, useRoute, useTheme } from "@react-navigation/native";
import { ScrollView, StyleSheet, View } from "react-native";
import FontAwesome6 from "react-native-vector-icons/FontAwesome6";
import { useTranslation } from "react-i18next";
import type { ReleaseKeyTask } from "@votetorrent/vote-core";
import { ThemedText } from "../../components/ThemedText";
import { CustomButton } from "../../components/CustomButton";
import { Footer } from "../../components/Footer";
import { InlineError } from "../../components/InlineError";
import { globalStyles } from "../../theme/styles";
import { useApp } from "../../providers/AppProvider";
import { resolveKeyholderKeyVault } from "../../engines/keyholder-vault";
import { keyReleaseErrorCopyKey, releaseKeyholderShare } from "./key-release-ceremony";

/**
 * KeyReleaseScreen — Surface 6 keyholder share release ceremony (D-17, D-20). Reached only from a
 * release-key task in the Tasks inbox, whose tasks exist only once the election has entered the key
 * release period. Pressing the button runs `releaseKeyholderShare` (one biometric prompt the first
 * time for a seat accepted since prompt batching, two for an older seat, none on a repeat). Success stays on screen with the button disabled, never hidden: a public,
 * irreversible release deserves an explicit confirmation, and the header Close returns to the inbox.
 * Every failure shows catalog copy only, never an error message.
 */
type Phase = "idle" | "releasing" | "released";

export default function KeyReleaseScreen() {
	const { task } = useRoute().params as { task: ReleaseKeyTask };
	const { t } = useTranslation();
	const { colors } = useTheme() as ExtendedTheme;
	const { getEngine } = useApp();

	const [phase, setPhase] = useState<Phase>("idle");
	const [errorKey, setErrorKey] = useState<string | null>(null);
	const inFlight = useRef(false);
	const active = useRef(true);

	useEffect(() => {
		active.current = true;
		return () => {
			active.current = false;
		};
	}, []);

	const onRelease = async () => {
		if (inFlight.current) return;
		inFlight.current = true;
		setErrorKey(null);
		setPhase("releasing");
		try {
			const outcome = await releaseKeyholderShare({ getEngine, vault: resolveKeyholderKeyVault() }, task);
			if (!active.current) return;
			if (outcome.kind === "released") {
				setPhase("released");
			} else {
				setErrorKey(keyReleaseErrorCopyKey(outcome));
				setPhase("idle");
			}
		} catch {
			if (!active.current) return;
			setErrorKey("keyholderReleaseError");
			setPhase("idle");
		} finally {
			inFlight.current = false;
		}
	};

	return (
		<View style={styles.content}>
			<ScrollView style={styles.container}>
				<InlineError message={errorKey ? t(errorKey) : ""} />
				<View testID="key-release-card" style={[styles.cardSurface, { backgroundColor: colors.card }]}>
					<ThemedText testID="key-release-election-title" type="cardTitle" style={localStyles.shrink}>
						{task.election.election.title}
					</ThemedText>
					{task.network?.name ? (
						<View style={localStyles.detail}>
							<ThemedText type="defaultSemiBold" style={localStyles.shrink}>
								{t("network")}:{" "}
							</ThemedText>
							<ThemedText style={localStyles.shrink}>{task.network.name}</ThemedText>
						</View>
					) : null}
					<ThemedText testID="key-release-body" style={localStyles.shrink}>
						{t("keyholderReleaseBody")}
					</ThemedText>
				</View>
				{phase === "releasing" ? (
					<ThemedText testID="key-release-in-progress" type="small" style={[localStyles.shrink, { color: colors.textSecondary }]}>
						{t("keyholderReleaseInProgress")}
					</ThemedText>
				) : null}
				{phase === "released" ? (
					<View testID="key-release-success" style={localStyles.successRow}>
						<FontAwesome6 name="circle-check" size={16} color={colors.success} />
						<ThemedText type="small" style={[localStyles.shrink, { color: colors.success }]}>
							{t("keyholderReleaseSuccess")}
						</ThemedText>
					</View>
				) : null}
			</ScrollView>
			<Footer>
				<View testID="key-release-button">
					<CustomButton
						title={t("keyholderReleaseButton")}
						backgroundColor={colors.success}
						disabled={phase !== "idle"}
						onPress={() => {
							onRelease();
						}}
					/>
				</View>
			</Footer>
		</View>
	);
}

const localStyles = StyleSheet.create({
	shrink: {
		flexShrink: 1,
	},
	detail: {
		flexDirection: "row",
		flexWrap: "wrap",
		marginVertical: 4,
	},
	successRow: {
		flexDirection: "row",
		alignItems: "center",
		gap: 8,
		marginTop: 8,
	},
});

const styles = { ...globalStyles, ...localStyles };
