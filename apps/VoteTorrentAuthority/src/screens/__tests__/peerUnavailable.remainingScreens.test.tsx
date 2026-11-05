/**
 * peerUnavailable.remainingScreens.test.tsx — representative screens from the remaining read/write
 * inventory render translated copy (never raw block text) when other devices cannot be reached,
 * and still render the raw message for any other error.
 */
import React from "react";
import renderer from "react-test-renderer";

const PEER_RAW = "Block abc123 is unavailable (cohort-unreachable)";
const peerErr = () => Object.assign(new Error(PEER_RAW), { name: "QuereusError" });

let mockRejection: unknown;
let mockRouteParams: any = {};

// Named so each case can assert its rejecting call ran (REVIEW WR-R5-04): the generic key is what
// ANY exception maps to, so a harness TypeError would otherwise pass for the planted rejection.
const mockListRegistrationRequests = jest.fn(async () => { throw mockRejection; });
const mockResendRevision = jest.fn(async () => { throw mockRejection; });
const mockGetEngine = jest.fn(async (name: string): Promise<any> => {
	if (name === "registration") {
		return { listRegistrationRequests: mockListRegistrationRequests };
	}
	if (name === "network") {
		return {
			getDetails: jest.fn(async () => { throw mockRejection; }),
			proposeRevision: jest.fn(async () => { throw mockRejection; }),
			resendRevision: mockResendRevision,
			openAuthority: jest.fn(async () => { throw mockRejection; }),
		};
	}
	return null;
});

jest.mock("react-native-vector-icons/FontAwesome6", () => "FontAwesome6");
jest.mock("react-native-safe-area-context", () => ({
	useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
jest.mock("@votetorrent/vote-engine/rn", () => ({}), { virtual: true });
jest.mock("../../providers/SettingsProvider", () => ({
	useSettings: () => ({ showHelpIcons: false }),
}));
jest.mock("react-i18next", () => ({
	useTranslation: () => ({ t: (key: string) => key }),
}));
jest.mock("../../providers/AppProvider", () => ({
	useApp: () => ({ getEngine: mockGetEngine }),
}));
jest.mock("../../engines/device-user", () => ({
	getOrCreateDeviceUser: jest.fn(async () => ({ id: "device-user-1", name: "Device User" })),
}));
// 62-143: the inbox now mounts the review toggle, which imports the device signer; the real module
// initialises i18next, which this suite's react-i18next mock does not provide.
jest.mock("../../engines/device-signer", () => ({
	createDeviceSigner: jest.fn(async () => async () => ({ signature: "s", signerKey: "k", signerUserId: "u" })),
}));
jest.mock("../../hooks/useMediaPin", () => ({
	useMediaPin: () => ({ reset: jest.fn(), cidFor: () => undefined, statusFor: () => undefined, pin: jest.fn(), isPinning: false }),
}));
jest.mock("@react-navigation/native", () => ({
	useTheme: () => ({
		colors: new Proxy({}, { get: (_t, p) => `c-${String(p)}` }),
	}),
	useNavigation: () => ({ navigate: jest.fn(), goBack: jest.fn(), setOptions: jest.fn(), setParams: jest.fn() }),
	useRoute: () => ({ params: mockRouteParams }),
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

async function flush(): Promise<void> {
	await renderer.act(async () => {
		for (let i = 0; i < 15; i++) await Promise.resolve();
	});
}

async function mount(el: React.ReactElement): Promise<renderer.ReactTestRenderer> {
	let tr!: renderer.ReactTestRenderer;
	await renderer.act(async () => {
		tr = renderer.create(el);
	});
	await flush();
	return tr;
}

function texts(tr: renderer.ReactTestRenderer): string {
	const out: string[] = [];
	const walk = (n: any) => {
		if (n == null) return;
		if (typeof n === "string") { out.push(n); return; }
		if (Array.isArray(n)) { n.forEach(walk); return; }
		walk(n.children);
	};
	walk(tr.toJSON());
	return out.join("|");
}

function press(tr: renderer.ReactTestRenderer, label: string) {
	const node = tr.root.findAll(
		(n) => typeof n.props.title === "string" && n.props.title === label && typeof n.props.onPress === "function",
	)[0];
	if (!node) throw new Error(`no control titled ${label}`);
	return node.props.onPress();
}

const defaultGetEngine = mockGetEngine.getMockImplementation()!;
beforeEach(() => {
	mockGetEngine.mockReset();
	mockGetEngine.mockImplementation(defaultGetEngine);
	mockListRegistrationRequests.mockClear();
	mockResendRevision.mockClear();
});
const errorSpy = jest.spyOn(console, "warn").mockImplementation(() => undefined);
afterAll(() => errorSpy.mockRestore());

describe("remaining screens: peer-unavailable copy", () => {
	describe("UserDetailsScreen load (READ)", () => {
		let userEngine: { getSummary: jest.Mock; getHistory: jest.Mock };
		const renderScreen = () => {
			const { UserDetailsScreen } = require("../users/UserDetailsScreen");
			userEngine = {
				getSummary: jest.fn(async () => { throw mockRejection; }),
				getHistory: jest.fn(async () => { throw mockRejection; }),
			};
			mockRouteParams = { user: { id: "u1", name: "U", activeKeys: [] }, userEngine };
			return mount(<UserDetailsScreen />);
		};

		it("R-1: renders translated read copy, not the raw block text", async () => {
			mockRejection = peerErr();
			const tr = await renderScreen();
			const s = texts(tr);
			expect(s).toContain("peerReadUnavailableBody");
			expect(s).not.toContain("abc123");
		});
		it("R-2: a generic error renders translated copy, never its raw message", async () => {
			mockRejection = new Error("disk corrupt");
			const tr = await renderScreen();
			expect(userEngine.getSummary).toHaveBeenCalled();
			const s = texts(tr);
			expect(s).toContain("errorLoadFailedGeneric");
			expect(s).not.toContain("disk corrupt");
			expect(s).not.toContain("peerReadUnavailableBody");
		});
	});

	describe("NetworkRevisionScreen submit (WRITE)", () => {
		let proposeRevision: jest.Mock;
		const submit = async () => {
			const NetworkRevisionScreen = require("../networks/NetworkRevisionScreen").default;
			mockRouteParams = { networkId: "n1" };
			// load succeeds so the only error shown is the submit one
			const engine = {
				getDetails: jest.fn(async () => ({
					network: {
						name: "N", imageRef: undefined, relays: [],
						policies: { electionType: "adhoc", numberRequiredTSAs: 1, timestampAuthorities: [] },
					},
				})),
				proposeRevision: jest.fn(async () => { throw mockRejection; }),
			};
			proposeRevision = engine.proposeRevision;
			mockGetEngine.mockImplementation(async () => engine);
			const tr = await mount(<NetworkRevisionScreen />);
			const btn = tr.root.findAll((n) => typeof n.props.onPress === "function" && /propose/i.test(String(n.props.title ?? "")))[0];
			if (!btn) throw new Error("no propose button; titles: " + tr.root.findAll((n) => typeof n.props.title === "string").map((n) => n.props.title).join(","));
			await renderer.act(async () => { await btn.props.onPress(); });
			await flush();
			return tr;
		};

		it("R-1: renders translated write copy, not the raw block text", async () => {
			mockRejection = peerErr();
			const s = texts(await submit());
			expect(s).toContain("peerWriteUnavailable");
			expect(s).not.toContain("abc123");
		});
		it("R-2: a generic error renders translated copy, never its raw message", async () => {
			mockRejection = new Error("disk corrupt");
			const s = texts(await submit());
			expect(proposeRevision).toHaveBeenCalled();
			expect(s).toContain("errorActionFailedGeneric");
			expect(s).not.toContain("disk corrupt");
			expect(s).not.toContain("peerWriteUnavailable");
		});
	});

	describe("RegistrationInboxScreen load (READ)", () => {
		const renderScreen = () => {
			const mod = require("../registration/RegistrationInboxScreen");
			const Screen = mod.default ?? mod.RegistrationInboxScreen;
			mockRouteParams = { authorityId: "a1" };
			return mount(<Screen />);
		};
		it("R-3: renders translated read copy, not the raw block text", async () => {
			mockRejection = peerErr();
			const tr = await renderScreen();
			const s = texts(tr);
			expect(s).toContain("peerReadUnavailableBody");
			expect(s).not.toContain("abc123");
		});
		it("R-4: a generic error renders translated copy, never its raw message", async () => {
			mockRejection = new Error("disk corrupt");
			const s = texts(await renderScreen());
			expect(mockListRegistrationRequests).toHaveBeenCalled();
			expect(s).toContain("errorLoadFailedGeneric");
			expect(s).not.toContain("disk corrupt");
			expect(s).not.toContain("peerReadUnavailableBody");
		});
	});

	describe("ProposedRevisionScreen resend (WRITE)", () => {
		const resend = async () => {
			const Screen = require("../tasks/ProposedRevisionScreen").default;
			mockRouteParams = { name: "N", revision: {} };
			const tr = await mount(<Screen />);
			const btn = tr.root.findAll((n) => typeof n.props.onPress === "function" && typeof n.props.title === "string")[0];
			if (!btn) throw new Error("no button");
			await renderer.act(async () => { await btn.props.onPress(); });
			await flush();
			return tr;
		};
		it("R-3: renders translated write copy, not the raw block text", async () => {
			mockRejection = peerErr();
			const s = texts(await resend());
			expect(s).toContain("peerWriteUnavailable");
			expect(s).not.toContain("abc123");
		});
		it("R-4: a generic error renders translated copy, never its raw message", async () => {
			mockRejection = new Error("disk corrupt");
			const s = texts(await resend());
			expect(mockResendRevision).toHaveBeenCalled();
			expect(s).toContain("errorActionFailedGeneric");
			expect(s).not.toContain("disk corrupt");
		});
	});
});
