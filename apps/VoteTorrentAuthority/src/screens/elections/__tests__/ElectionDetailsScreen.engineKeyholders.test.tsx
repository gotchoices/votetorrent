/**
 * ElectionDetailsScreen.engineKeyholders.test.tsx — D-27 (phase 62 plan 09).
 *
 * Proves the keyholder cards on this screen come straight from
 * `electionEngine.getElectionDetails().current.keyholders` and from nowhere
 * else. Before this plan, `loadElectionDetails` merged a per-device
 * AsyncStorage `local-keyholders:<electionId>` entry on top of the engine
 * result whenever the engine returned zero keyholders — so a stale local
 * entry from a prior app session could render a keyholder card the network
 * does not have (T-62-09-04). The removal-control test below seeds exactly
 * that stale entry and asserts it renders NOTHING; with the scaffold still
 * present it rendered a 'Ghost' card (the RED case for this file — see the
 * SUMMARY for the exact failure captured before `local-keyholders.ts` was
 * removed from this screen's import list).
 *
 * Mock preamble copied from `ElectionDetailsScreen.navigation.test.tsx`
 * (vector-icons, safe-area, react-i18next identity `t`, the navigation
 * mocks with `useRoute` returning the per-test `mockElectionEngine`).
 */

import React from "react";
import renderer from "react-test-renderer";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { KeyholderCard } from "../components/KeyholderCard";
import { ThemedText } from "../../../components/ThemedText";
import type { InviteStatus, SentKeyholderInvite } from "@votetorrent/vote-core";

jest.mock("react-native-vector-icons/FontAwesome6", () => "FontAwesome6");

jest.mock("react-native-safe-area-context", () => ({
	useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

jest.mock("react-i18next", () => ({
	useTranslation: () => ({ t: (key: string) => key }),
}));

const mockNavigate = jest.fn();
const mockGoBack = jest.fn();
const mockSetOptions = jest.fn();
// Prefixed `mock` so babel-plugin-jest-hoist allows the jest.mock() factory
// below (hoisted above this declaration) to close over it.
let mockElectionEngine: any;
const mockFocusCallbacks: Array<() => void | (() => void)> = [];

jest.mock("@react-navigation/native", () => ({
	useTheme: () => ({
		colors: {
			primary: "sentinel-primary",
			background: "sentinel-background",
			card: "sentinel-card",
			text: "sentinel-text",
			border: "sentinel-border",
			notification: "sentinel-notification",
			error: "sentinel-error",
			textSecondary: "sentinel-textSecondary",
			important: "sentinel-important",
			success: "sentinel-success",
			accent: "sentinel-accent",
			warning: "sentinel-warning",
		},
	}),
	useNavigation: () => ({
		navigate: mockNavigate,
		goBack: mockGoBack,
		setOptions: mockSetOptions,
	}),
	// Deferred via a real useEffect (not called synchronously during render) —
	// matches the navigation.test.tsx sibling's own comment: calling cb()
	// unconditionally during render can infinite-loop a screen whose focus
	// callback sets state on every invocation.
	useFocusEffect: (cb: () => void | (() => void)) => {
		// Recorded so a test can simulate a RE-focus (UAT 62 M) by invoking the latest callbacks.
		mockFocusCallbacks.push(cb);
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const ReactLib = require("react");
		ReactLib.useEffect(() => {
			cb();
			// eslint-disable-next-line react-hooks/exhaustive-deps
		}, []);
	},
	useRoute: () => ({ params: { electionEngine: mockElectionEngine } }),
}));

function makeElectionEngine(current: {
	keyholders: Array<InviteStatus<SentKeyholderInvite>>;
	keyholderThreshold: number;
}) {
	return {
		getElectionDetails: jest.fn(async () => ({
			election: {
				id: "election-1",
				title: "Test Election",
				authorityId: "authority-1",
				type: 0,
				date: Date.now(),
				revisionDeadline: Date.now(),
				ballotDeadline: Date.now(),
			},
			current: {
				revision: 1,
				revisionTimestamp: [],
				tags: [],
				timeline: {},
				keyholderThreshold: current.keyholderThreshold,
				keyholders: current.keyholders,
			},
			proposed: undefined,
		})),
		getBallots: jest.fn(async () => []),
		getBallotConfirmationState: jest.fn(async () => ({ locked: false, confirmed: false })),
	};
}

async function renderScreen(): Promise<renderer.ReactTestRenderer> {
	// eslint-disable-next-line @typescript-eslint/no-var-requires
	const ElectionDetailsScreenModule = require("../ElectionDetailsScreen");
	const ElectionDetailsScreen = ElectionDetailsScreenModule.default;

	let tr!: renderer.ReactTestRenderer;
	await renderer.act(async () => {
		tr = renderer.create(<ElectionDetailsScreen />);
	});
	await renderer.act(async () => {
		await Promise.resolve();
		await Promise.resolve();
		await Promise.resolve();
	});
	return tr;
}

/** Flatten a ThemedText node's children (React may split `{a} of {b}` into an array) into a plain string. */
function textOf(node: ReturnType<renderer.ReactTestRenderer["root"]["findAllByType"]>[number]): string {
	return ([] as unknown[]).concat(node.props.children as unknown).join("");
}

/** Find the single "<threshold> of <count>" keyholder-policy ThemedText node. */
function policyText(tr: renderer.ReactTestRenderer): string {
	const match = tr.root.findAllByType(ThemedText).map(textOf).find((text) => /^\d+ of \d+$/.test(text));
	if (match === undefined) {
		throw new Error("policyText: no ThemedText node matched the '<n> of <n>' keyholder-policy shape");
	}
	return match;
}

beforeEach(async () => {
	jest.clearAllMocks();
	await AsyncStorage.clear();
});

describe("ElectionDetailsScreen — keyholders render from the engine only (D-27)", () => {
	it("renders exactly the keyholder cards the engine returns, in order, with matching invitationStatus props", async () => {
		const keyholders: Array<InviteStatus<SentKeyholderInvite>> = [
			{ invite: { name: "Alice" } },
			{ invite: { name: "Bob" }, result: { isAccepted: true, invitationSignature: "", invokedId: "u-bob" } },
		];
		mockElectionEngine = makeElectionEngine({ keyholders, keyholderThreshold: 2 });

		const tr = await renderScreen();

		const cards = tr.root.findAllByType(KeyholderCard);
		expect(cards).toHaveLength(2);
		expect(cards.map((c) => c.props.invitationStatus)).toEqual(keyholders);
		expect(policyText(tr)).toBe("2 of 2");
	});

	it("a stale local-keyholders AsyncStorage entry no longer adds cards (the scaffold-era RED case)", async () => {
		await AsyncStorage.setItem("local-keyholders:election-1", JSON.stringify(["Ghost"]));
		mockElectionEngine = makeElectionEngine({ keyholders: [], keyholderThreshold: 1 });

		const tr = await renderScreen();

		const cards = tr.root.findAllByType(KeyholderCard);
		expect(cards).toHaveLength(0);
		const allText = tr.root.findAllByType(ThemedText).map(textOf).join(" | ");
		expect(allText).not.toContain("Ghost");
		expect(policyText(tr)).toBe("1 of 0");
	});
});

describe("ElectionDetailsScreen — keyholder INVITE prefill (UAT 62 L1)", () => {
	async function pressInvite(tr: renderer.ReactTestRenderer) {
		const invite = tr.root.findAll((n) => n.props?.title === "invite" && typeof n.props?.onPress === "function")[0];
		await renderer.act(async () => invite.props.onPress());
	}

	it("passes the single not-yet-accepted keyholder so the send form's Name is prefilled", async () => {
		const kay = { invite: { name: "Kay Holder" } };
		mockElectionEngine = makeElectionEngine({
			keyholders: [{ invite: { name: "Ann" }, result: { isAccepted: true, invitationSignature: "", invokedId: "u-ann" } }, kay],
			keyholderThreshold: 2,
		});
		const tr = await renderScreen();
		await pressInvite(tr);
		expect(mockNavigate).toHaveBeenCalledWith("KeyholderInvitation", expect.objectContaining({ mode: "send", keyholder: kay }));
	});

	it("passes no keyholder when the invitee is ambiguous", async () => {
		mockElectionEngine = makeElectionEngine({
			keyholders: [{ invite: { name: "Ann" } }, { invite: { name: "Bob" } }],
			keyholderThreshold: 2,
		});
		const tr = await renderScreen();
		await pressInvite(tr);
		expect(mockNavigate).toHaveBeenCalledWith("KeyholderInvitation", expect.objectContaining({ mode: "send", keyholder: undefined }));
	});
});

describe("ElectionDetailsScreen — keyholder cards refresh on focus (UAT 62 M)", () => {
	it("a keyholder accepted while the screen was under the stack reads Accepted after re-focus", async () => {
		const pending = { invite: { name: "Kay Holder" } };
		const accepted = { invite: { name: "Kay Holder" }, result: { isAccepted: true, invitationSignature: "", invokedId: "u-kay" } };
		mockElectionEngine = makeElectionEngine({ keyholders: [pending], keyholderThreshold: 1 });
		const tr = await renderScreen();
		expect(tr.root.findAllByType(KeyholderCard)[0].props.invitationStatus).toEqual(pending);

		const refreshed = makeElectionEngine({ keyholders: [accepted], keyholderThreshold: 1 });
		mockElectionEngine.getElectionDetails.mockImplementation(refreshed.getElectionDetails);
		const callbacks = mockFocusCallbacks.splice(0);
		await renderer.act(async () => {
			callbacks.slice(-2).forEach((cb) => cb());
			await Promise.resolve();
			await Promise.resolve();
		});

		expect(tr.root.findAllByType(KeyholderCard)[0].props.invitationStatus).toEqual(accepted);
		const allText = tr.root.findAllByType(ThemedText).map(textOf).join(" | ");
		expect(allText).toContain("accepted");
		expect(allText).not.toContain("unsent");
	});
});
