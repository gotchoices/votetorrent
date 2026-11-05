/**
 * ElectionResultsScreen.test.tsx — the results screen renders each ElectionResultsEngine outcome, recomputes on
 * Refresh, and resolves its engine as 'electionResults'. The engine itself is covered by vote-engine's
 * election-results.spec.ts.
 *
 * Publishing (the officer-signed ElectionTally row, engine 'tallyPublication', covered by vote-engine's
 * tally-publication.spec.ts): who sees Publish, when it is enabled, the confirm-then-sign order, each refused
 * outcome's copy, the published card's three verdicts, and the background recount on a strand change.
 */

import React from "react";
import renderer from "react-test-renderer";
import { Alert } from "react-native";

jest.mock("react-native-vector-icons/FontAwesome6", () => "FontAwesome6");

jest.mock("react-native-safe-area-context", () => ({
	useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

jest.mock("react-i18next", () => ({
	useTranslation: () => ({
		t: (key: string, opts?: Record<string, unknown>) => (opts ? `${key}:${JSON.stringify(opts)}` : key),
	}),
}));

const mockGetEngine = jest.fn();
jest.mock("../../../providers/AppProvider", () => ({
	useApp: () => ({ getEngine: mockGetEngine }),
}));

jest.mock("@react-navigation/native", () => ({
	useTheme: () => ({
		colors: {
			primary: "p", background: "b", card: "c", text: "t", border: "bo", notification: "n",
			error: "e", textSecondary: "ts", important: "i", success: "s", accent: "a", warning: "w",
		},
	}),
	useFocusEffect: (cb: () => void | (() => void)) => {
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const ReactLib = require("react");
		ReactLib.useEffect(() => cb(), []);
	},
	useRoute: () => ({ params: mockRouteParams }),
}));

let mockRouteParams: Record<string, unknown> = { electionId: "election-1", electionTitle: "Fruit poll", authorityId: "authority-1" };

// The officer gate: undefined scopes = not an officer of the authority (useCurrentOfficerScopes' contract).
let mockScopes: { scopes: string[] | undefined; loading: boolean } = { scopes: ["adm"], loading: false };
jest.mock("../../../hooks/useCurrentOfficerScopes", () => ({
	useCurrentOfficerScopes: (authorityId: string) => {
		mockScopesAuthorityIds.push(authorityId);
		return { ...mockScopes, refresh: () => undefined };
	},
}));
const mockScopesAuthorityIds: string[] = [];

// Captures the screen's strand-change subscription so a test can fire it.
const mockStrandSubs: Array<{ tables: readonly string[]; onChange: () => void; label: string }> = [];
jest.mock("../../../hooks/useStrandChanges", () => ({
	useStrandChanges: (tables: readonly string[], onChange: () => void, label: string) => {
		mockStrandSubs.push({ tables, onChange, label });
	},
}));

const mockHandleSigningError = jest.fn((_err: unknown) => ({ handled: false, message: undefined as string | undefined }));
jest.mock("../../../hooks/useDeviceSigningErrorHandler", () => ({
	useDeviceSigningErrorHandler: () => mockHandleSigningError,
}));

const mockSign = jest.fn(async (_d: Uint8Array) => ({ signature: "sig", signerKey: "02officer" }));
const mockCreateDeviceSigner = jest.fn(async (_name: string) => mockSign);
jest.mock("../../../engines/device-signer", () => ({
	createDeviceSigner: (name: string) => mockCreateDeviceSigner(name),
}));
let mockDeviceUser: unknown = { id: "officer-1", name: "Officer", activeKeys: [{ key: "02officer" }] };
jest.mock("../../../engines/device-user", () => ({
	getDeviceUser: async () => mockDeviceUser,
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const ElectionResultsScreen = require("../ElectionResultsScreen").default;

const TALLIED = {
	status: "tallied",
	electionId: "election-1",
	revision: 1,
	threshold: 2,
	keyholdersUsed: 2,
	blockCount: 1,
	totals: { blocks: 1, entries: 3, valid: 3, invalid: 0, excluded: 0, undecryptable: 0 },
	ballots: [
		{
			ballotId: "ballot-1",
			description: "Fruit poll",
			votes: 3,
			valid: 3,
			invalid: 0,
			excluded: 0,
			questions: [
				{
					code: "Q1", title: "Favourite fruit", type: "select", counted: true, answered: 3, blank: 0,
					options: [
						{ code: "A", title: "Apple", count: 2 },
						{ code: "B", title: "Banana", count: 1 },
						{ code: "C", title: "Mango", count: 0 },
					],
				},
			],
		},
	],
	tallyRoot: "abcdef0123456789abcdef",
	blockRoot: "00",
	tally: {},
};

function textOf(tr: renderer.ReactTestRenderer, testID: string): string {
	const node = tr.root.findAll((n) => n.props.testID === testID && typeof n.type !== "string")[0];
	if (!node) throw new Error(`no ${testID}`);
	const parts: string[] = [];
	const walk = (x: any): void => {
		if (typeof x === "string") parts.push(x);
		else if (x && x.children) x.children.forEach(walk);
	};
	walk(node);
	return parts.join("");
}

const has = (tr: renderer.ReactTestRenderer, testID: string): boolean => tr.root.findAll((n) => n.props.testID === testID).length > 0;

const COVERAGE_OK = { blocks: 1, declaredEntries: 3, voterRows: 3, complete: true };

interface PublicationStub {
	published?: unknown;
	coverage?: unknown;
	publishOutcome?: unknown;
	/** thrown by publishElectionTally */
	publishThrows?: Error;
	/** getEngine('tallyPublication') rejects */
	unavailable?: boolean;
}

async function render(results: unknown | Error, pub: PublicationStub = {}) {
	const engine = {
		getElectionResults: jest.fn(async () => {
			if (results instanceof Error) throw results;
			return results;
		}),
	};
	const publication = {
		readPublishedTally: jest.fn(async () => pub.published ?? null),
		blockCoverage: jest.fn(async () => pub.coverage ?? COVERAGE_OK),
		publishElectionTally: jest.fn(async () => {
			if (pub.publishThrows) throw pub.publishThrows;
			return pub.publishOutcome ?? { outcome: "published" };
		}),
	};
	mockGetEngine.mockReset();
	mockGetEngine.mockImplementation(async (name: string) => {
		if (name === "electionResults") return engine;
		if (name === "tallyPublication") {
			if (pub.unavailable) throw new Error("no strand");
			return publication;
		}
		throw new Error(`unexpected engine ${name}`);
	});
	let tr!: renderer.ReactTestRenderer;
	await renderer.act(async () => {
		tr = renderer.create(<ElectionResultsScreen />);
	});
	await renderer.act(async () => {
		await Promise.resolve();
	});
	return { tr, engine, publication };
}

async function flush() {
	for (let i = 0; i < 5; i++) {
		await renderer.act(async () => {
			await Promise.resolve();
		});
	}
}

function pressable(tr: renderer.ReactTestRenderer, testID: string) {
	return tr.root.findAll((n) => n.props.testID === testID && typeof n.props.onPress === "function")[0]!;
}

beforeEach(() => {
	mockRouteParams = { electionId: "election-1", electionTitle: "Fruit poll", authorityId: "authority-1" };
	mockScopes = { scopes: ["adm"], loading: false };
	mockScopesAuthorityIds.length = 0;
	mockStrandSubs.length = 0;
	mockDeviceUser = { id: "officer-1", name: "Officer", activeKeys: [{ key: "02officer" }] };
	mockHandleSigningError.mockReset();
	mockHandleSigningError.mockImplementation(() => ({ handled: false, message: undefined }));
	mockCreateDeviceSigner.mockClear();
	mockSign.mockClear();
	jest.restoreAllMocks();
});

describe("ElectionResultsScreen", () => {
	it("computes the election's results through the 'electionResults' engine and shows per-option counts", async () => {
		const { tr, engine } = await render(TALLIED);
		expect(mockGetEngine).toHaveBeenCalledWith("electionResults");
		expect(engine.getElectionResults).toHaveBeenCalledWith("election-1");
		expect(textOf(tr, "results-valid-total")).toContain('"count":3');
		expect(textOf(tr, "results-count-Q1-A")).toBe('resultsOptionCount:{"count":2,"percent":67}');
		expect(textOf(tr, "results-count-Q1-B")).toBe('resultsOptionCount:{"count":1,"percent":33}');
		expect(textOf(tr, "results-count-Q1-C")).toBe('resultsOptionCount:{"count":0,"percent":0}');
		expect(textOf(tr, "results-tally-root")).toContain("abcdef0123456789");
		expect(has(tr, "results-invalid-total")).toBe(false);
		expect(has(tr, "results-awaiting-keys")).toBe(false);
	});

	it("shows the locked state with the released-share count before the key is reconstructable", async () => {
		const { tr } = await render({
			status: "awaiting-keys", electionId: "election-1", phase: "releasing", revision: 1,
			threshold: 2, participants: 2, releasedCount: 1, releasingKeysAt: Date.UTC(2026, 10, 5, 8, 5),
		});
		expect(has(tr, "results-awaiting-keys")).toBe(true);
		expect(textOf(tr, "results-released-count")).toBe('resultsReleasedCount:{"released":1,"needed":2}');
		expect(has(tr, "results-summary")).toBe(false);
	});

	it("says the key is not generated yet when there is no election key", async () => {
		const { tr } = await render({
			status: "awaiting-keys", electionId: "election-1", phase: "no-election-key", revision: 1,
			threshold: null, participants: null, releasedCount: 0, releasingKeysAt: null,
		});
		expect(has(tr, "results-no-key")).toBe(true);
	});

	it("shows the refusal reason when the results cannot be computed", async () => {
		const { tr } = await render({ status: "unavailable", electionId: "election-1", reason: "group-key-mismatch", detail: "x" });
		expect(textOf(tr, "results-unavailable-reason")).toBe('resultsUnavailableReason:{"reason":"group-key-mismatch"}');
	});

	it("shows a load failure when the engine throws, and Refresh computes again", async () => {
		const { tr, engine } = await render(new Error("no network"));
		expect(has(tr, "results-failed")).toBe(true);
		const button = tr.root.findAll((n) => n.props.testID === "results-refresh" && typeof n.props.onPress === "function")[0]!;
		await renderer.act(async () => {
			button.props.onPress();
		});
		await renderer.act(async () => {
			await Promise.resolve();
		});
		expect(engine.getElectionResults).toHaveBeenCalledTimes(2);
	});

	it("says no vote blocks have arrived (never a bare 0) when the device has none yet", async () => {
		const { tr } = await render({ ...TALLIED, blockCount: 0, totals: { ...TALLIED.totals, blocks: 0, entries: 0, valid: 0 } });
		expect(has(tr, "results-no-blocks")).toBe(true);
		expect(has(tr, "results-summary")).toBe(false);
		expect(has(tr, "results-count-Q1-A")).toBe(false);
	});

	it("flags invalid and excluded votes when there are any", async () => {
		const { tr } = await render({ ...TALLIED, totals: { ...TALLIED.totals, invalid: 1, excluded: 3 } });
		expect(textOf(tr, "results-invalid-total")).toContain('"count":1');
		expect(textOf(tr, "results-excluded-total")).toContain('"count":3');
	});

	describe("publishing the count (ElectionTally)", () => {
		const PUBLISHED = {
			electionId: "election-1", revision: 1, blockRoot: "00", tallyRoot: "abcdef0123456789abcdef", blockCount: 1,
			publishedAt: "2026-11-02T10:00:00.000Z", publisherUserId: "officer-1", publisherKey: "02officer",
			signatureValid: true, treeCheck: { ok: true }, matchesRecomputed: true, tally: {},
		};

		it("reads the published tally with this device's own tree, and offers an officer Publish when coverage is complete", async () => {
			const { tr, publication } = await render(TALLIED);
			expect(publication.readPublishedTally).toHaveBeenCalledWith("election-1", 1, TALLIED.tally);
			expect(publication.blockCoverage).toHaveBeenCalledWith("election-1", 1);
			expect(mockScopesAuthorityIds).toContain("authority-1");
			expect(has(tr, "results-publish-explain")).toBe(true);
			expect(pressable(tr, "results-publish").props.disabled).toBe(false);
		});

		it("asks for confirmation with the block and vote counts, and signs nothing until the officer confirms", async () => {
			const alert = jest.spyOn(Alert, "alert").mockImplementation(() => undefined);
			const { tr, publication } = await render(TALLIED);
			await renderer.act(async () => {
				pressable(tr, "results-publish").props.onPress();
			});
			expect(alert).toHaveBeenCalledTimes(1);
			const [title, body, buttons] = alert.mock.calls[0]!;
			expect(title).toBe("resultsPublishConfirmTitle");
			expect(body).toBe('resultsPublishConfirmBody:{"blocks":1,"votes":3}');
			expect(mockCreateDeviceSigner).not.toHaveBeenCalled();
			expect(publication.publishElectionTally).not.toHaveBeenCalled();
			// Cancel signs nothing.
			expect((buttons as Array<{ style?: string; onPress?: () => void }>)[0]!.style).toBe("cancel");
		});

		it("on confirm, publishes this device's tree signed with the device user's key, then counts again", async () => {
			const alert = jest.spyOn(Alert, "alert").mockImplementation(() => undefined);
			const { tr, engine, publication } = await render(TALLIED);
			await renderer.act(async () => {
				pressable(tr, "results-publish").props.onPress();
			});
			const buttons = alert.mock.calls[0]![2] as Array<{ onPress?: () => void }>;
			await renderer.act(async () => {
				buttons[1]!.onPress!();
			});
			await flush();
			expect(mockCreateDeviceSigner).toHaveBeenCalledTimes(1);
			expect(publication.publishElectionTally).toHaveBeenCalledTimes(1);
			const [tally, publisher] = publication.publishElectionTally.mock.calls[0] as unknown as [unknown, { userId: string; signingPublicKey: string; sign: unknown }];
			expect(tally).toBe(TALLIED.tally);
			expect(publisher.userId).toBe("officer-1");
			expect(publisher.signingPublicKey).toBe("02officer");
			expect(publisher.sign).toBe(mockSign);
			expect(engine.getElectionResults).toHaveBeenCalledTimes(2);
			expect(has(tr, "results-publish-error")).toBe(false);
		});

		const publishAndRead = async (pub: PublicationStub) => {
			const alert = jest.spyOn(Alert, "alert").mockImplementation(() => undefined);
			const r = await render(TALLIED, pub);
			await renderer.act(async () => {
				pressable(r.tr, "results-publish").props.onPress();
			});
			await renderer.act(async () => {
				(alert.mock.calls[0]![2] as Array<{ onPress?: () => void }>)[1]!.onPress!();
			});
			await flush();
			return r;
		};

		it.each([
			[{ publishOutcome: { outcome: "conflict" } }, "resultsPublishConflict"],
			[{ publishOutcome: { outcome: "signer-key-mismatch" } }, "resultsPublishKeyMismatch"],
			[{ publishOutcome: { outcome: "invalid-tally", reason: "x" } }, "resultsPublishInvalid"],
			[{ publishOutcome: { outcome: "not-officer" } }, "resultsPublishNotOfficer"],
			[{ publishOutcome: { outcome: "keys-not-released" } }, "resultsPublishKeysNotReleased"],
			[{ publishThrows: new Error("CHECK constraint failed: something else") }, "resultsPublishFailed"],
		])("shows translated copy, never the raw error, for %j", async (pub, key) => {
			const { tr } = await publishAndRead(pub as PublicationStub);
			expect(textOf(tr, "results-publish-error")).toBe(key);
		});

		it("leaves a signing failure the device-signing handler owns to the handler, with no message of its own", async () => {
			mockHandleSigningError.mockImplementation(() => ({ handled: true, message: undefined }));
			const { tr } = await publishAndRead({ publishThrows: new Error("KEY_INVALIDATED") });
			expect(mockHandleSigningError).toHaveBeenCalledTimes(1);
			expect(has(tr, "results-publish-error")).toBe(false);
		});

		it("refuses to publish without a device signing key, before asking the engine", async () => {
			mockDeviceUser = undefined;
			const { tr, publication } = await publishAndRead({});
			expect(publication.publishElectionTally).not.toHaveBeenCalled();
			expect(textOf(tr, "results-publish-error")).toBe("resultsPublishNoKey");
		});

		it("disables Publish while blocks are still arriving: voter rows short of the declared entries, or more blocks than were counted", async () => {
			let r = await render(TALLIED, { coverage: { blocks: 1, declaredEntries: 3, voterRows: 2, complete: false } });
			expect(has(r.tr, "results-publish-waiting")).toBe(true);
			expect(pressable(r.tr, "results-publish").props.disabled).toBe(true);
			r = await render(TALLIED, { coverage: { blocks: 2, declaredEntries: 6, voterRows: 6, complete: true } });
			expect(pressable(r.tr, "results-publish").props.disabled).toBe(true);
		});

		it("offers no Publish to a device that is not an officer of the election's authority, or when the authority is unknown", async () => {
			mockScopes = { scopes: undefined, loading: false };
			let r = await render(TALLIED);
			expect(has(r.tr, "results-publish-officer-only")).toBe(true);
			expect(has(r.tr, "results-publish")).toBe(false);
			mockScopes = { scopes: ["adm"], loading: false };
			mockRouteParams = { electionId: "election-1" };
			r = await render(TALLIED);
			expect(has(r.tr, "results-publish")).toBe(false);
		});

		it("offers no Publish when no block has reached this device", async () => {
			const { tr } = await render({ ...TALLIED, blockCount: 0, totals: { ...TALLIED.totals, blocks: 0, entries: 0, valid: 0 } }, { coverage: { blocks: 0, declaredEntries: 0, voterRows: 0, complete: true } });
			expect(has(tr, "results-publish-card")).toBe(false);
		});

		it("shows a published count that matches, one that differs (naming both block counts), and one that fails its checks", async () => {
			let r = await render(TALLIED, { published: PUBLISHED });
			expect(has(r.tr, "results-published-matches")).toBe(true);
			expect(has(r.tr, "results-publish-card")).toBe(false);
			r = await render(TALLIED, { published: { ...PUBLISHED, blockCount: 4, matchesRecomputed: false } });
			expect(textOf(r.tr, "results-published-differs")).toBe('resultsPublishedDiffers:{"published":4,"local":1}');
			r = await render(TALLIED, { published: { ...PUBLISHED, signatureValid: false } });
			expect(has(r.tr, "results-published-invalid")).toBe(true);
			expect(has(r.tr, "results-published-matches")).toBe(false);
		});

		it("still shows the results, with no publication card, when the publication engine is unavailable", async () => {
			const { tr } = await render(TALLIED, { unavailable: true });
			expect(textOf(tr, "results-valid-total")).toContain('"count":3');
			expect(has(tr, "results-publish-card")).toBe(false);
			expect(has(tr, "results-published")).toBe(false);
		});

		it("counts again in the background on a key release, block or published tally, keeping the results on screen", async () => {
			const { tr, engine } = await render(TALLIED);
			const sub = mockStrandSubs[mockStrandSubs.length - 1]!;
			expect([...sub.tables].sort()).toEqual(["App.ElectionKey", "App.ElectionTally", "App.KeyholderShareRelease", "App.VoteBlock", "App.VoteBlockVoter"]);
			await renderer.act(async () => {
				sub.onChange();
			});
			expect(has(tr, "results-loading")).toBe(false);
			expect(has(tr, "results-summary")).toBe(true);
			await flush();
			expect(engine.getElectionResults).toHaveBeenCalledTimes(2);
		});
	});
});
