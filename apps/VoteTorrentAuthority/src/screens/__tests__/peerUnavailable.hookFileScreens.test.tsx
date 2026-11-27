/**
 * peerUnavailable.hookFileScreens.test.tsx — gap 4 residue, W6 part 2 (D-23/D-39). Screens that
 * DO use the signing-error hook but whose catch bypasses `outcome.message ??` rendered the raw
 * engine block text ("Block ... is unavailable (cohort-unreachable)"). Each representative site
 * now shows translated copy for a can't-reach-devices failure; every other error is unchanged
 * (negative controls). The hook itself is mocked: this suite's subject is the catch classification.
 */

import React from "react";
import renderer from "react-test-renderer";

const RAW = "Block default/app/Admin is unavailable (cohort-unreachable): the repo could not determine whether it exists";

function peerError(): Error {
	return Object.assign(new Error(RAW), { name: "BlockUnavailableError", reason: "cohort-unreachable" });
}

let mockEngines: Record<string, any> = {};
const mockGetEngine = jest.fn(async (name: string) => mockEngines[name]);
let mockRouteParams: any = {};
const mockNavigation = { navigate: jest.fn(), setOptions: jest.fn(), popTo: jest.fn(), goBack: jest.fn() };
let mockDkgOutcome: any;

jest.mock("react-native-vector-icons/FontAwesome6", () => "FontAwesome6");
jest.mock("react-native-safe-area-context", () => ({
	useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
jest.mock("@votetorrent/vote-engine/rn", () => ({}), { virtual: true });
jest.mock("../../providers/SettingsProvider", () => ({ useSettings: () => ({ showHelpIcons: false }) }));
jest.mock("react-i18next", () => ({
	...jest.requireActual("react-i18next"),
	useTranslation: () => ({ t: (key: string) => key }),
}));
jest.mock("@react-navigation/native", () => ({
	useTheme: () => ({
		colors: new Proxy({}, { get: (_t, p) => `sentinel-${String(p)}` }),
	}),
	useNavigation: () => mockNavigation,
	useRoute: () => ({ params: mockRouteParams }),
	useFocusEffect: (cb: () => void | (() => void)) => {
		const R = require("react");
		R.useEffect(() => cb(), []);
	},
}));
jest.mock("../../providers/AppProvider", () => ({ useApp: () => ({ getEngine: mockGetEngine, isAttestationVerifierProvisioned: () => true }) }));
jest.mock("../../hooks/useCurrentOfficerScopes", () => ({
	useCurrentOfficerScopes: () => ({ scopes: ["vrg", "cap"], loading: false }),
}));
jest.mock("../../hooks/useDeviceSigningErrorHandler", () => ({
	useDeviceSigningErrorHandler: () => () => ({ handled: false }),
}));
jest.mock("../../engines/device-user", () => ({
	getOrCreateDeviceUser: jest.fn(async () => ({ id: "device-user-1", name: "Device User" })),
}));
jest.mock("../../engines/device-signer", () => ({
	createDeviceSigner: jest.fn(async () => async () => ({
		signature: "mock-sig",
		signerKey: "mock-key",
		signerUserId: "device-user-1",
	})),
}));
jest.mock("../../engines/keyholder-vault", () => ({ resolveKeyholderKeyVault: () => ({}) }));
jest.mock("../keyholder/keyholder-dkg-driver", () => ({
	...jest.requireActual("../keyholder/keyholder-dkg-driver"),
	driveKeyholderDkg: async () => mockDkgOutcome,
}));

function allText(tr: renderer.ReactTestRenderer): string {
	return JSON.stringify(tr.toJSON());
}

async function flush(n = 8) {
	await renderer.act(async () => {
		for (let i = 0; i < n; i++) await Promise.resolve();
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

beforeEach(() => {
	mockEngines = {};
	mockRouteParams = {};
	mockDkgOutcome = undefined;
});

describe("H-1 AuthorityPeersScreen load", () => {
	async function run(err: Error) {
		mockRouteParams = { authorityId: "auth-1" };
		mockEngines = {
			authorityConfig: { getAuthorityPeers: jest.fn(async () => Promise.reject(err)) },
			network: { openAuthority: jest.fn(async () => ({ getAdminDetails: async () => ({ admin: { officers: [] } }) })) },
		};
		const Screen = require("../authorities/AuthorityPeersScreen").default;
		return mount(<Screen />);
	}
	it("shows translated copy, not the raw block text", async () => {
		const text = allText(await run(peerError()));
		expect(text).toContain("peerReadUnavailableBody");
		expect(text).not.toContain("cohort-unreachable");
	});
	it("negative control: a generic error renders translated copy, never its raw message", async () => {
		const text = allText(await run(new Error("disk corrupt")));
		expect(text).toContain("errorLoadFailedGeneric");
		expect(text).not.toContain("disk corrupt");
		expect(text).not.toContain("peerReadUnavailableBody");
	});
});

describe("H-2 ReviseUserScreen save", () => {
	async function run(err: Error) {
		const revise = jest.fn(async () => Promise.reject(err));
		mockRouteParams = { user: { id: "u1", name: "Una" }, userEngine: { revise } };
		const { ReviseUserScreen } = require("../users/ReviseUserScreen");
		const tr = await mount(<ReviseUserScreen />);
		const byTitle = (title: string) =>
			tr.root.findAll((n) => n.props?.title === title && typeof n.props?.onPress === "function")[0];
		// edit the name so Sign enables, then sign, then save
		const inputs = tr.root.findAll((n) => typeof n.props?.onChangeText === "function" && n.props?.title === "name");
		await renderer.act(async () => {
			inputs[0].props.onChangeText("Una Two");
		});
		await renderer.act(async () => {
			byTitle("sign").props.onPress();
		});
		await flush();
		await renderer.act(async () => {
			await byTitle("save").props.onPress();
		});
		await flush();
		expect(revise).toHaveBeenCalled();
		return tr;
	}
	it("shows translated write copy, not the raw block text", async () => {
		const text = allText(await run(peerError()));
		expect(text).toContain("peerWriteUnavailable");
		expect(text).not.toContain("cohort-unreachable");
	});
	it("negative control: a generic error renders translated copy, never its raw message", async () => {
		const text = allText(await run(new Error("disk corrupt")));
		expect(text).toContain("errorActionFailedGeneric");
		expect(text).not.toContain("disk corrupt");
		expect(text).not.toContain("peerWriteUnavailable");
	});
});

describe("H-3 mapElectionError", () => {
	const { mapElectionError } = require("../elections/election-error-messages");
	const t = (k: string) => k;
	it("returns peerWriteUnavailable for a peer-unavailable failure", () => {
		expect(mapElectionError(peerError(), t)).toBe("peerWriteUnavailable");
	});
	it("negative controls: existing cases unchanged", () => {
		expect(mapElectionError(new Error("CHECK BallotDeadlineValid failed"), t)).toBe("errBallotDeadlineAfterDate");
		expect(mapElectionError(new Error("RevisionDeadline Date"), t)).toBe("errRevisionDeadlineAfterDate");
		expect(mapElectionError(new Error("timeline broken"), t)).toBe("errTimelineOrder");
		expect(mapElectionError(new Error("disk corrupt"), t)).toBe("errCouldNotSaveElection");
	});
});

describe("H-4 KeyholderScreen DKG error", () => {
	async function run(outcome: any) {
		mockDkgOutcome = outcome;
		mockRouteParams = {
			keyholder: { invite: { name: "K" }, result: { invokedId: "inv-1", isAccepted: true } },
			electionEngine: { getElectionDetails: async () => ({ election: { id: "election-1" } }) },
		};
		const mod = require("../keyholder/KeyholderScreen");
		const Screen = mod.default ?? mod.KeyholderScreen;
		return mount(<Screen />);
	}
	// 62-137: the driver outcome error is { code, authDenied } only; peer-unavailable arrives as a code.
	it("a peer-unavailable DKG code renders translated write copy", async () => {
		const text = allText(
			await run({ status: null, error: { code: "peer-unavailable", authDenied: false } }),
		);
		expect(text).toContain("peerWriteUnavailable");
		expect(text).not.toContain("cohort-unreachable");
	});
	it("authDenied still renders deviceSigningErrorGeneric", async () => {
		const text = allText(
			await run({ status: null, error: { code: "unknown", authDenied: true, message: RAW } }),
		);
		expect(text).toContain("deviceSigningErrorGeneric");
		expect(text).not.toContain("peerWriteUnavailable");
	});
	it("negative control: any other code renders the generic DKG copy, never engine text", async () => {
		const text = allText(
			await run({ status: null, error: { code: "unknown", authDenied: false, message: "disk corrupt" } }),
		);
		expect(text).toContain("keyholderDkgError");
		expect(text).not.toContain("peerWriteUnavailable");
		expect(text).not.toContain("disk corrupt");
	});
});

describe("H-5 registration reads", () => {
	async function runAssociations(err: Error) {
		mockEngines = {
			association: {
				getAssociations: jest.fn(async () => Promise.reject(err)),
				getAttestationVerdicts: jest.fn(async () => []),
			},
		};
		const { AssociationsSection } = require("../registration/components/AssociationsSection");
		return mount(
			<AssociationsSection registrantId="r1" authorityId="a1" registrantDisplayName="Reg One" />,
		);
	}
	it("AssociationsSection getAssociations: translated, not raw", async () => {
		const text = allText(await runAssociations(peerError()));
		expect(text).toContain("peerReadUnavailableBody");
		expect(text).not.toContain("cohort-unreachable");
	});
	it("AssociationsSection negative control: generic error renders the generic key and not the raw text", async () => {
		const text = allText(await runAssociations(new Error("disk corrupt")));
		expect(text).toContain("errorLoadFailedGeneric");
		expect(text).not.toContain("disk corrupt");
		expect(text).not.toContain("peerReadUnavailableBody");
	});

	async function runDetail(err: Error) {
		mockRouteParams = { registrantId: "r1", authorityId: "a1" };
		mockEngines = {
			registration: {
				getRegistrant: jest.fn(async () => undefined),
				getRegistrantPublic: jest.fn(async () => undefined),
				getRegistrantSelective: jest.fn(async () => undefined),
				getRegistrantPrivate: jest.fn(async () => Promise.reject(err)),
			},
		};
		const Screen = require("../registration/RegistrantDetailScreen").default;
		return mount(<Screen />);
	}
	it("RegistrantDetailScreen private-tier load: translated, not raw", async () => {
		const text = allText(await runDetail(peerError()));
		expect(text).toContain("peerReadUnavailableBody");
		expect(text).not.toContain("cohort-unreachable");
	});
	it("RegistrantDetailScreen negative control: generic error renders the generic key and not the raw text", async () => {
		const text = allText(await runDetail(new Error("disk corrupt")));
		expect(text).toContain("errorLoadFailedGeneric");
		expect(text).not.toContain("disk corrupt");
		expect(text).not.toContain("peerReadUnavailableBody");
	});
});
