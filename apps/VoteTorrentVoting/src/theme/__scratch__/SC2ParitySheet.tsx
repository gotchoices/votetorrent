/**
 * THROWAWAY scratch render — SC2 parity proof (D-13/D-14).
 *
 * Built purely from `lightTheme`/`darkTheme`/`type` (theme/themes.ts) and `globalStyles`
 * (theme/styles.ts) — zero inline hex/size color-or-type literals for the swatch chips, type
 * samples, or the rebuilt Home election card / Ballot question row below. This proves the token
 * set composes into real, screenshot-able React Native UI (not just a list of exported values).
 *
 * NOT imported by App.tsx, navigation, or any dev route. The orchestrator renders this component
 * directly (Task 3), screenshots it, diffs against the Figma Home 2761:1125 / Ballot 2764:1181
 * crops, then deletes `theme/__scratch__/` entirely (D-14). It is not a retained dev tool.
 */
import React, { useState } from 'react';
import { ScrollView, View, Text, Pressable, StyleSheet } from 'react-native';
import { lightTheme, darkTheme, type as typeScale } from '../themes';
import { globalStyles, globalStyleDefs } from '../styles';

type ExtendedTheme = typeof lightTheme;

const COLOR_ROLES = [
	'primary',
	'background',
	'surface',
	'card',
	'text',
	'textSecondary',
	'border',
	'notification',
	'secondary',
	'accent',
	'error',
	'warning',
	'contrast',
	'success',
	'dark',
	'light',
	'important',
	'muted',
	'link',
	'progressFill',
	'progressTrack',
	'secondaryButtonSurface',
] as const;

const TYPE_STEPS = ['display', 'h1', 'h2', 'h3', 'h4', 'body', 'caption'] as const;

function SwatchChip({ theme, role }: { theme: ExtendedTheme; role: (typeof COLOR_ROLES)[number] }) {
	const value = theme.colors[role];
	return (
		<View style={sheetStyles.chip}>
			<View style={[sheetStyles.chipSwatch, { backgroundColor: value, borderColor: theme.colors.border }]} />
			<Text style={[theme.fonts.medium, typeScale.caption, { color: theme.colors.text }]}>{role}</Text>
			<Text style={[theme.fonts.regular, typeScale.caption, { color: theme.colors.textSecondary }]}>{value}</Text>
		</View>
	);
}

function TypeSample({ theme, step }: { theme: ExtendedTheme; step: (typeof TYPE_STEPS)[number] }) {
	const scale = typeScale[step];
	return (
		<View style={sheetStyles.typeRow}>
			<Text
				style={[
					theme.fonts.medium,
					{ fontSize: scale.fontSize, lineHeight: scale.lineHeight, color: theme.colors.text },
				]}
			>
				{step}
			</Text>
			<Text style={[theme.fonts.regular, typeScale.caption, { color: theme.colors.textSecondary }]}>
				{`${scale.fontSize}/${scale.lineHeight}`}
			</Text>
		</View>
	);
}

function SpacingSample({ theme, label, value }: { theme: ExtendedTheme; label: string; value: number }) {
	return (
		<View style={sheetStyles.spacingRow}>
			<View style={[sheetStyles.spacingBlock, { width: value, height: value, backgroundColor: theme.colors.primary }]} />
			<Text style={[theme.fonts.regular, typeScale.caption, { color: theme.colors.textSecondary }]}>
				{`${label}: ${value}px`}
			</Text>
		</View>
	);
}

/** Token-only rebuild of ONE representative Home election card (node 2761:1125). */
function HomeElectionCardDemo({ theme }: { theme: ExtendedTheme }) {
	// A representative in-progress countdown percentage — not a Figma-sourced literal, just a
	// demo data point driving the progressFill/progressTrack width split below.
	const percentComplete = 62;
	return (
		<View style={[globalStyles.cardSurface, { backgroundColor: theme.colors.surface }]}>
			<Text style={[theme.fonts.medium, typeScale.h2, { color: theme.colors.text }]}>General Election 2025</Text>
			<Text style={[theme.fonts.regular, typeScale.display, { color: theme.colors.text }]}>06 : 05 : 02</Text>
			<View style={[sheetStyles.progressTrack, { backgroundColor: theme.colors.progressTrack }]}>
				<View
					style={[
						sheetStyles.progressFill,
						{ backgroundColor: theme.colors.progressFill, width: `${percentComplete}%` },
					]}
				/>
			</View>
			<Text style={[theme.fonts.regular, typeScale.caption, { color: theme.colors.textSecondary }]}>
				2/15 questions completed
			</Text>
			<Pressable style={[sheetStyles.primaryButton, { backgroundColor: theme.colors.primary }]}>
				<Text style={[theme.fonts.medium, typeScale.h4, { color: theme.colors.light }]}>Vote now</Text>
			</Pressable>
			<Text style={[theme.fonts.regular, typeScale.body, { color: theme.colors.link }]}>
				Learn about this election
			</Text>
		</View>
	);
}

/** Token-only rebuild of ONE Ballot question/office row (node 2764:1181). */
function BallotQuestionRowDemo({ theme }: { theme: ExtendedTheme }) {
	return (
		<View style={[globalStyles.cardSurface, { backgroundColor: theme.colors.card }]}>
			<Text style={[theme.fonts.bold, typeScale.h4, { color: theme.colors.text }]}>President</Text>
			<Text style={[theme.fonts.medium, typeScale.body, { color: theme.colors.success }]}>Jane A. Voter</Text>
			<Text style={[theme.fonts.regular, typeScale.caption, { color: theme.colors.textSecondary }]}>
				Independent Party
			</Text>
			<Pressable
				style={[
					sheetStyles.secondaryButton,
					{ backgroundColor: theme.colors.secondaryButtonSurface, borderColor: theme.colors.primary },
				]}
			>
				<Text style={[theme.fonts.medium, typeScale.h4, { color: theme.colors.primary }]}>Save & Exit</Text>
			</Pressable>
		</View>
	);
}

function ThemeSection({ theme, label }: { theme: ExtendedTheme; label: string }) {
	return (
		<View style={[globalStyles.section, { backgroundColor: theme.colors.background }]}>
			<Text style={[theme.fonts.bold, typeScale.h1, { color: theme.colors.text }]}>{label}</Text>

			<Text style={[theme.fonts.medium, typeScale.h3, globalStyles.sectionTitle, { color: theme.colors.text }]}>
				Swatch sheet
			</Text>
			<View style={sheetStyles.chipGrid}>
				{COLOR_ROLES.map((role) => (
					<SwatchChip key={role} theme={theme} role={role} />
				))}
			</View>

			<Text style={[theme.fonts.medium, typeScale.h3, globalStyles.sectionTitle, { color: theme.colors.text }]}>
				Type sheet
			</Text>
			{TYPE_STEPS.map((step) => (
				<TypeSample key={step} theme={theme} step={step} />
			))}

			<Text style={[theme.fonts.medium, typeScale.h3, globalStyles.sectionTitle, { color: theme.colors.text }]}>
				Spacing samples
			</Text>
			{/* Read numeric values from `globalStyleDefs` (the raw style-object map), not
			`globalStyles` — StyleSheet.create resolves to opaque numeric style IDs at runtime,
			not the original value objects (see theme/styles.ts's own comment on this). */}
			<SpacingSample theme={theme} label="container padding" value={globalStyleDefs.container.padding} />
			<SpacingSample theme={theme} label="section marginBottom" value={globalStyleDefs.section.marginBottom} />
			<SpacingSample theme={theme} label="cardSurface borderRadius" value={globalStyleDefs.cardSurface.borderRadius} />

			<Text style={[theme.fonts.medium, typeScale.h3, globalStyles.sectionTitle, { color: theme.colors.text }]}>
				Home election card (rebuilt)
			</Text>
			<HomeElectionCardDemo theme={theme} />

			<Text style={[theme.fonts.medium, typeScale.h3, globalStyles.sectionTitle, { color: theme.colors.text }]}>
				Ballot question row (rebuilt)
			</Text>
			<BallotQuestionRowDemo theme={theme} />
		</View>
	);
}

/** Top-level scratch component — toggles between lightTheme/darkTheme for the orchestrator's
 * Task 3 screenshot pass. Not wired into App.tsx/navigation (D-14). */
export default function SC2ParitySheet() {
	const [dark, setDark] = useState(false);
	const theme = dark ? darkTheme : lightTheme;

	return (
		<ScrollView style={[globalStyles.content, { backgroundColor: theme.colors.background }]} contentContainerStyle={globalStyles.container}>
			<Pressable
				style={[sheetStyles.primaryButton, { backgroundColor: theme.colors.primary }]}
				onPress={() => setDark((d) => !d)}
			>
				<Text style={[theme.fonts.medium, typeScale.h4, { color: theme.colors.light }]}>
					{dark ? 'Switch to light' : 'Switch to dark'}
				</Text>
			</Pressable>
			<ThemeSection theme={theme} label={dark ? 'Dark' : 'Light'} />
		</ScrollView>
	);
}

// Structural layout-only styles (no Figma color/size values — chip dimensions, flex wiring,
// pressable padding are implementation plumbing, not Figma-derived visual tokens).
const sheetStyles = StyleSheet.create({
	chipGrid: {
		flexDirection: 'row',
		flexWrap: 'wrap',
		gap: 8,
	},
	chip: {
		width: 110,
		gap: 2,
	},
	chipSwatch: {
		width: '100%',
		height: 40,
		borderWidth: 1,
	},
	typeRow: {
		flexDirection: 'row',
		justifyContent: 'space-between',
		alignItems: 'baseline',
	},
	spacingRow: {
		flexDirection: 'row',
		alignItems: 'center',
		gap: 8,
	},
	spacingBlock: {},
	progressTrack: {
		height: 8,
		overflow: 'hidden',
	},
	progressFill: {
		height: 8,
	},
	primaryButton: {
		alignItems: 'center',
		justifyContent: 'center',
		paddingVertical: 12,
	},
	secondaryButton: {
		alignItems: 'center',
		justifyContent: 'center',
		paddingVertical: 12,
		borderWidth: 1,
	},
});
