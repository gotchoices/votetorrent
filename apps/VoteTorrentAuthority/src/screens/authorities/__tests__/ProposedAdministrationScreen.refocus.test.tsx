/**
 * ProposedAdministrationScreen.refocus.test.tsx — UAT 62: the screen read getAdminDetails once
 * per mount. EditOfficer persists an added administrator through proposeAdmin and goes back, so
 * the new invitee never appeared until the screen was rebuilt. It must re-read on every focus.
 */

import React from "react";
import renderer from "react-test-renderer";

jest.mock("react-native-vector-icons/FontAwesome6", () => "FontAwesome6");

jest.mock("react-i18next", () => ({
	useTranslation: () => ({ t: (key: string) => key }),
}));

jest.mock("react-native-safe-area-context", () => ({
	useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

jest.mock("../../../providers/SettingsProvider", () => ({
	useSettings: () => ({ showHelpIcons: false }),
}));

jest.mock("../../../engines/device-signer", () => ({
	createDeviceSigner: jest.fn(async () => jest.fn()),
}));
jest.mock("../../../engines/device-user", () => ({
	getOrCreateDeviceUser: jest.fn(async () => ({ id: "user-1", name: "Device User" })),
}));
jest.mock("../../../hooks/useDeviceSigningErrorHandler", () => ({
	useDeviceSigningErrorHandler: () => () => ({ handled: false }),
}));

const AUTHORITY = { id: "authority-1", name: "Test Authority", domainName: "test.example.org" };
const FOUNDER = { userId: "user-1", authorityId: AUTHORITY.id, title: "Chair", scopes: ["rad"] };

// Prefixed `mock` so babel-plugin-jest-hoist allows the jest.mock() factories to close over them.
const mockFocusCallbacks: Array<() => void | (() => void)> = [];
const mockGetAdminDetails = jest.fn();
const mockAuthorityEngine = {
	getAdminDetails: mockGetAdminDetails,
	getDetails: jest.fn(async () => ({ authority: AUTHORITY })),
};
const mockNetworkEngine = {
	openAuthority: jest.fn(async () => mockAuthorityEngine),
	getUser: jest.fn(async () => ({ getSummary: async () => ({ id: "user-1", name: "Founding Chair" }) })),
};
const mockGetEngine = jest.fn(async (name: string) => (name === "network" ? mockNetworkEngine : undefined));

jest.mock("../../../providers/AppProvider", () => ({
	useApp: () => ({ getEngine: mockGetEngine }),
}));

jest.mock("@react-navigation/native", () => ({
	useTheme: () => ({
		colors: {
			primary: "p",
			background: "b",
			card: "c",
			text: "t",
			border: "bo",
			notification: "n",
			error: "e",
			textSecondary: "ts",
			important: "i",
			success: "s",
			accent: "a",
			warning: "w",
		},
	}),
	useNavigation: () => ({ navigate: jest.fn(), goBack: jest.fn(), setOptions: jest.fn() }),
	useRoute: () => ({ params: { authorityId: "authority-1" } }),
	// Run the callback once on mount (like a first focus) and record it so a test can simulate
	// a RE-focus by invoking it again.
	useFocusEffect: (cb: () => void | (() => void)) => {
		mockFocusCallbacks.push(cb);
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const ReactLib = require("react");
		ReactLib.useEffect(() => {
			const cleanup = cb();
			return typeof cleanup === "function" ? cleanup : undefined;
			// eslint-disable-next-line react-hooks/exhaustive-deps
		}, []);
	},
}));

function adminDetails(proposedOfficers?: unknown[]) {
	return {
		admin: { id: "authority-1:2026-10-01T00:00:00", authorityId: AUTHORITY.id, effectiveAt: 0, officers: [FOUNDER], thresholdPolicies: [] },
		proposed: proposedOfficers
			? { proposed: { officers: proposedOfficers, effectiveAt: 1, thresholdPolicies: [] }, signers: [] }
			: undefined,
	};
}

async function flush() {
	for (let i = 0; i < 6; i++) {
		// eslint-disable-next-line no-await-in-loop
		await renderer.act(async () => {
			await Promise.resolve();
		});
	}
}

function cardTitles(tr: renderer.ReactTestRenderer): string[] {
	// eslint-disable-next-line @typescript-eslint/no-var-requires
	const { InfoCard } = require("../../../components/InfoCard");
	return tr.root.findAllByType(InfoCard).map((n) => n.props.title as string);
}

describe("ProposedAdministrationScreen — reloads on focus (UAT 62)", () => {
	it("an administrator proposed while EditOfficer was on top shows after re-focus", async () => {
		mockGetAdminDetails.mockResolvedValue(adminDetails());
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const ProposedAdministrationScreen = require("../ProposedAdministrationScreen").default;
		let tr!: renderer.ReactTestRenderer;
		await renderer.act(async () => {
			tr = renderer.create(<ProposedAdministrationScreen />);
		});
		await flush();
		expect(cardTitles(tr)).toEqual(["Founding Chair"]);

		// EditOfficer persisted a proposal with a new invitee, then went back.
		mockGetAdminDetails.mockResolvedValue(
			adminDetails([{ existing: FOUNDER }, { init: { name: "Bea Two", title: "Clerk", scopes: ["vrg"] } }]),
		);
		const callbacks = mockFocusCallbacks.splice(0);
		await renderer.act(async () => {
			// The latest render's callback only; an old mount-only screen registers none.
			callbacks.slice(-1).forEach((cb) => cb());
		});
		await flush();

		expect(mockGetAdminDetails).toHaveBeenCalledTimes(2);
		expect(cardTitles(tr)).toEqual(["Founding Chair", "Bea Two"]);
	});
});
