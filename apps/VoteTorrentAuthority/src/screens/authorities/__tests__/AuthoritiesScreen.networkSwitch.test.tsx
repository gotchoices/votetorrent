/**
 * AuthoritiesScreen.networkSwitch.test.tsx - Session 1 Pixel_8 A-6 (2026-10-08). After switching network
 * in the same session (Sun Net -> Moon Net and back), the mounted Authorities tab kept showing the
 * previous network's pinned card, Find said "No authorities found" for the new network's own
 * authorities, and a refocus did not help; only a cold start did. The screen held the network engine
 * it resolved on mount, while the factory hands out a new engine per network.
 */

import React from "react";
import renderer from "react-test-renderer";
import { Text } from "react-native";

jest.mock("react-native-vector-icons/FontAwesome6", () => "FontAwesome6");

const mockT = (key: string) => key;
jest.mock("react-i18next", () => ({
	useTranslation: () => ({ t: mockT }),
}));

// The latest focus callback, so a test can re-focus the mounted tab the way a tab press does.
const mockFocus: { current: (() => void) | null } = { current: null };
jest.mock("@react-navigation/native", () => {
	const R = require("react");
	return {
		useTheme: () => ({
			colors: {
				primary: "p", background: "b", card: "c", text: "t", border: "bo", notification: "n",
				error: "e", textSecondary: "ts", important: "i", success: "s", accent: "a", warning: "w",
			},
		}),
		useNavigation: () => ({ navigate: jest.fn() }),
		useFocusEffect: (cb: () => void) =>
			R.useEffect(() => {
				mockFocus.current = cb;
				return cb();
			}, [cb]),
	};
});

const SUN_PINNED = { id: "sun-auth", name: "Sun Auth", domainName: "sun.test", imageRef: undefined };
const MOON_AUTH = { id: "moon-auth", name: "Moon Auth", domainName: "moon.test", imageRef: undefined };

function engineFor(pinned: any[], all: any[]) {
	return {
		getPinnedAuthorities: jest.fn(async () => pinned),
		getAuthoritiesByName: jest.fn(async () => ({ buffer: all })),
		pinAuthority: jest.fn(async () => {}),
		unpinAuthority: jest.fn(async () => {}),
	};
}
const sunEngine = engineFor([SUN_PINNED], [SUN_PINNED]);
const moonEngine = engineFor([], [MOON_AUTH]);
// The factory's current network engine; a network switch replaces it.
const mockCurrent: { engine: any } = { engine: sunEngine };
const mockGetEngine = jest.fn(async (_n: string): Promise<any> => mockCurrent.engine);

jest.mock("../../../providers/AppProvider", () => ({
	useApp: () => ({ getEngine: mockGetEngine, hasNetwork: true }),
}));

async function flush() {
	for (let i = 0; i < 8; i++) {
		await renderer.act(async () => {
			await Promise.resolve();
		});
	}
}

function textContent(node: renderer.ReactTestInstance): string {
	return node.children.map((c) => (typeof c === "string" ? c : textContent(c))).join("");
}
function allText(tr: renderer.ReactTestRenderer): string {
	return tr.root.findAllByType(Text).map(textContent).join("|");
}

beforeEach(() => {
	mockCurrent.engine = sunEngine;
	mockFocus.current = null;
	jest.spyOn(console, "warn").mockImplementation(() => {});
});

describe("AuthoritiesScreen - network switch on a mounted tab", () => {
	it("a refocus after the switch shows the new network's authorities, not the old pinned card", async () => {
		const Screen = require("../AuthoritiesScreen").default;
		let tr!: renderer.ReactTestRenderer;
		await renderer.act(async () => {
			tr = renderer.create(<Screen />);
		});
		await flush();
		expect(allText(tr)).toContain("Sun Auth");

		// Networks > Moon Net > Select, then back to the Authorities tab.
		mockCurrent.engine = moonEngine;
		await renderer.act(async () => {
			mockFocus.current!();
		});
		await flush();

		const text = allText(tr);
		expect(text).toContain("Moon Auth");
		expect(text).not.toContain("Sun Auth");
		expect(moonEngine.getPinnedAuthorities).toHaveBeenCalled();
		tr.unmount();
	});
});
