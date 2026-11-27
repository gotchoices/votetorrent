/**
 * headerTouchTargets.test.tsx — O-03: the native-stack header buttons share `styles.headerButton`
 * and must have a LAYOUT box of at least 44 x 44 dp (hitSlop grows the touch area but not the
 * bounds the geometry gates measure). The CloseButton must also be announced as a button.
 */
import React from "react";
import renderer from "react-test-renderer";
import { StyleSheet } from "react-native";

jest.setTimeout(60_000);

jest.mock("react-native-vector-icons/FontAwesome6", () => "FontAwesome6");
jest.mock("react-native-splash-view", () => ({ hideSplash: jest.fn() }));
jest.mock("../../providers/AppProvider", () => ({
	useApp: () => ({}),
	AppProvider: ({ children }: { children: React.ReactNode }) => children,
}));
jest.mock("../../providers/CadreNodeProvider", () => ({
	useCadreNode: () => ({ node: null, syncState: "offline", connectedPeers: () => 0 }),
	CadreNodeProvider: ({ children }: { children: React.ReactNode }) => children,
}));

describe("Authority header touch targets (O-03)", () => {
	async function renderClose() {
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const { NavigationContainer } = require("@react-navigation/native");
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const { CloseButton } = require("../index");
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const { lightTheme } = require("../../theme/themes");
		const onPress = jest.fn();
		let tr!: renderer.ReactTestRenderer;
		await renderer.act(async () => {
			tr = renderer.create(
				<NavigationContainer theme={lightTheme}>
					<CloseButton onPress={onPress} />
				</NavigationContainer>,
			);
		});
		return { tr, onPress };
	}

	it("N1/N3: CloseButton box is >= 44 x 44, centred, keeps hitSlop, has role and label", async () => {
		const { tr } = await renderClose();
		const btn = tr.root.findAll(n => n.props.hitSlop === 8 && typeof n.props.onPress === 'function')[0];
		const style = StyleSheet.flatten(btn.props.style) as Record<string, unknown>;
		expect(style.minWidth).toBeGreaterThanOrEqual(44);
		expect(style.minHeight).toBeGreaterThanOrEqual(44);
		expect(style.alignItems).toBe("center");
		expect(style.justifyContent).toBe("center");
		expect(btn.props.hitSlop).toBe(8);
		expect(btn.props.accessibilityRole).toBe("button");
		expect(typeof btn.props.accessibilityLabel).toBe("string");
		expect(btn.props.accessibilityLabel.length).toBeGreaterThan(0);
	});

	it("N2: network and settings header buttons use the same shared 44 dp style", () => {
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const src = require("fs").readFileSync(require("path").join(__dirname, "..", "index.tsx"), "utf8");
		const uses = src.match(/style=\{styles\.headerButton\}/g) ?? [];
		expect(uses.length).toBeGreaterThanOrEqual(3);
		expect(src).toMatch(/headerButton:\s*\{[^}]*minWidth:\s*44[^}]*minHeight:\s*44/s);
	});
});
