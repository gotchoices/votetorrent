/**
 * AuthorityDetailsScreen.image.test.tsx — the 200x200 image box at the top of Authority Details
 * renders only when the authority has an image URL. Before, an authority with no image got an
 * empty 200x200 box, which left a large blank space above the name.
 *
 * Mock scaffold mirrors AuthorityDetailsScreen.peerUnavailable.test.tsx.
 */

import React from "react";
import renderer from "react-test-renderer";
import { Image } from "react-native";

jest.mock("react-native-vector-icons/FontAwesome6", () => "FontAwesome6");

const mockT = (key: string) => key;
jest.mock("react-i18next", () => ({
	useTranslation: () => ({ t: mockT }),
}));

let mockRouteParams: { authority: any } = { authority: null };

jest.mock("@react-navigation/native", () => ({
	useTheme: () => ({
		colors: {
			primary: "p", background: "b", card: "c", text: "t", border: "bo", notification: "n",
			error: "e", textSecondary: "ts", important: "i", success: "s", accent: "a", warning: "w",
		},
	}),
	useNavigation: () => ({ navigate: jest.fn(), goBack: jest.fn(), setOptions: jest.fn() }),
	useRoute: () => ({ params: mockRouteParams }),
	// Run the callback once on mount (like a first focus); an effect keyed on `cb` would re-run every render.
	useFocusEffect: (cb: () => void | (() => void)) => {
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const ReactLib = require("react");
		ReactLib.useEffect(() => {
			const cleanup = cb();
			return typeof cleanup === "function" ? cleanup : undefined;
			// eslint-disable-next-line react-hooks/exhaustive-deps
		}, []);
	},
}));

const IMAGE_URL = "https://test.example.org/seal.png";
const BASE_AUTHORITY = { id: "authority-1", name: "Test Authority", domainName: "test.example.org" };

const mockAuthorityEngine = {
	getPendingInviteCids: jest.fn(async () => []),
	getAdminDetails: jest.fn(async () => ({
		admin: { id: "admin-1", authorityId: "authority-1", officers: [], effectiveAt: Date.UTC(2026, 9, 1), thresholdPolicies: [] },
		proposed: undefined,
	})),
};
const mockNetworkEngine = {
	openAuthority: jest.fn(async () => mockAuthorityEngine),
	getPinnedAuthorities: jest.fn(async () => []),
	pinAuthority: jest.fn(async () => {}),
	unpinAuthority: jest.fn(async () => {}),
	getUser: jest.fn(),
};
const mockGetEngine = jest.fn(async (name: string) => (name === "network" ? mockNetworkEngine : name === "invitations" ? { getOfficerInvite: jest.fn(async () => undefined) } : undefined));

jest.mock("../../../providers/AppProvider", () => ({
	useApp: () => ({ getEngine: mockGetEngine }),
}));

async function renderScreen(authority: any): Promise<renderer.ReactTestRenderer> {
	mockRouteParams = { authority };
	// eslint-disable-next-line @typescript-eslint/no-var-requires
	const AuthorityDetailsScreen = require("../AuthorityDetailsScreen").default;
	let tr!: renderer.ReactTestRenderer;
	await renderer.act(async () => {
		tr = renderer.create(<AuthorityDetailsScreen />);
	});
	for (let i = 0; i < 6; i++) {
		// eslint-disable-next-line no-await-in-loop
		await renderer.act(async () => {
			await Promise.resolve();
		});
	}
	return tr;
}

function imageBoxes(tr: renderer.ReactTestRenderer) {
	return tr.root.findAll((n) => typeof n.type === "string" && n.props?.testID === "authority-details-image");
}

beforeEach(() => {
	jest.clearAllMocks();
});

describe("AuthorityDetailsScreen — the image box renders only for an image URL", () => {
	it.each([
		["no imageRef", { ...BASE_AUTHORITY, imageRef: undefined }],
		["an imageRef with no url", { ...BASE_AUTHORITY, imageRef: { url: undefined } }],
		["an imageRef with an empty url", { ...BASE_AUTHORITY, imageRef: { url: "" } }],
	])("%s: no image box and no Image", async (_label, authority) => {
		const tr = await renderScreen(authority);

		// The screen did render (the authority name is on screen).
		expect(tr.root.findAll((n) => n.props?.children === "Test Authority").length).toBeGreaterThan(0);
		expect(imageBoxes(tr)).toHaveLength(0);
		expect(tr.root.findAllByType(Image)).toHaveLength(0);
	});

	it("an image URL: the box renders with the image", async () => {
		const tr = await renderScreen({ ...BASE_AUTHORITY, imageRef: { url: IMAGE_URL } });

		const boxes = imageBoxes(tr);
		expect(boxes).toHaveLength(1);
		const images = boxes[0].findAllByType(Image);
		expect(images).toHaveLength(1);
		expect(images[0].props.source).toEqual({ uri: IMAGE_URL });
	});
});
