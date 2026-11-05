import * as fs from "fs";
import * as path from "path";
import { RegistrationContentAccessError } from "@votetorrent/vote-core";
import { resources } from "../../../i18n";
import {
	PeerReviewUnavailableError,
	classifyReassociationEvidence,
	createDecideTimeRegistrationPublisher,
	createLazyDeviceSign,
	isClosedAsDuplicateError,
	isPeerReviewUnavailable,
	isRegistrationContentAccessError,
	isThresholdCoSignRefusal,
	isRequesterSignatureUnverifiableError,
	openPeerReviewSession,
	publishRegistrationDecisionAfterDecide,
	reassociationRegistrantLabel,
	truncateDeviceKeyLabel,
	readOnlyReviewSign,
	registrationContentUnreadKey,
	type PeerReviewDeps,
} from "../continuity-review";

jest.mock("../../../engines/key-vault", () => ({
	resolveAuthorityKeyVault: jest.fn(() => ({ __vault: "default" })),
}));
jest.mock("react-native-vector-icons/FontAwesome6", () => "Icon");
// Only the parity test loads AssociationsSection for real; stub the native-backed providers it pulls in.
jest.mock("../../../providers/AppProvider", () => ({ useApp: jest.fn() }));
jest.mock("../../../engines/device-signer", () => ({ createDeviceSigner: jest.fn() }));

const SRC = path.resolve(__dirname, "../../..");
const stripComments = (s: string) =>
	s
		.split("\n")
		.filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
		.join("\n");

function makeTransports() {
	return {
		strandId: "strand-1",
		registration: { publishDecision: jest.fn(async () => "cid-1"), close: jest.fn(async () => undefined) },
		association: { close: jest.fn(async () => undefined) },
	};
}

function makeDeps(overrides: Partial<PeerReviewDeps> = {}) {
	const transports = makeTransports();
	const createOpener = jest.fn(() => ({ __opener: true }));
	const regEngine = {
		getRegistrationRequest: jest.fn(async () => ({ status: "a" })),
		publishRegistrationDecision: jest.fn(async () => ({ status: "published" })),
	};
	const getEngine = jest.fn(async (name: string) => {
		if (name === "intake") return { createOpener };
		if (name === "registration") return regEngine;
		throw new Error("unexpected engine " + name);
	});
	const createPeerStagingTransports = jest.fn(() => transports);
	const sign = jest.fn(async () => ({ signature: "s", signerKey: "k", signerUserId: "u" }));
	const deps = {
		getEngine,
		createPeerStagingTransports,
		authorityId: "auth-1",
		sign,
		resolveVault: jest.fn(() => ({ __vault: "injected" })),
		...overrides,
	} as unknown as PeerReviewDeps;
	return { deps, transports, createOpener, regEngine, getEngine, createPeerStagingTransports, sign };
}

describe("CR1 openPeerReviewSession unavailable", () => {
	it("rejects with no-transport-factory and never touches getEngine", async () => {
		const { deps, getEngine } = makeDeps({ createPeerStagingTransports: undefined });
		await expect(openPeerReviewSession(deps)).rejects.toMatchObject({
			peerReviewUnavailable: true,
			reason: "no-transport-factory",
		});
		expect(getEngine).not.toHaveBeenCalled();
	});

	it("maps a peerStrandUnavailable throw to peer-strand-unavailable", async () => {
		const { deps } = makeDeps({
			createPeerStagingTransports: jest.fn(() => {
				throw Object.assign(new Error("x"), { peerStrandUnavailable: true });
			}),
		});
		const err = await openPeerReviewSession(deps).catch((e) => e);
		expect(err).toBeInstanceOf(PeerReviewUnavailableError);
		expect(err.reason).toBe("peer-strand-unavailable");
		expect(isPeerReviewUnavailable(err)).toBe(true);
	});

	it("lets any other factory failure through unchanged", async () => {
		const boom = new Error("boom");
		const { deps } = makeDeps({
			createPeerStagingTransports: jest.fn(() => {
				throw boom;
			}),
		});
		await expect(openPeerReviewSession(deps)).rejects.toBe(boom);
	});
});

describe("CR2 openPeerReviewSession open + close", () => {
	it("opens once with the injected vault and decision signer, without signing", async () => {
		const { deps, getEngine, createOpener, createPeerStagingTransports, sign, transports } = makeDeps();
		const session = await openPeerReviewSession(deps);
		expect(getEngine).toHaveBeenCalledTimes(1);
		expect(getEngine).toHaveBeenCalledWith("intake");
		expect(createOpener).toHaveBeenCalledWith({ __vault: "injected" });
		expect(createPeerStagingTransports).toHaveBeenCalledTimes(1);
		const arg = (createPeerStagingTransports.mock.calls as any[])[0][0];
		expect(arg.opener).toEqual({ __opener: true });
		expect(arg.decisionSigner.authorityId).toBe("auth-1");
		expect(arg.decisionSigner.sign).toBe(sign);
		expect(sign).not.toHaveBeenCalled();

		expect(session.registrationPublisher.authorityId).toBe("auth-1");
		const decision = { requestId: "r" } as any;
		await session.registrationPublisher.publishDecision(decision);
		expect(transports.registration.publishDecision).toHaveBeenCalledTimes(1);
		expect(transports.registration.publishDecision).toHaveBeenCalledWith(decision);
	});

	it("uses the production vault resolver by default", async () => {
		const { deps, createOpener } = makeDeps({ resolveVault: undefined });
		await openPeerReviewSession(deps);
		expect(createOpener).toHaveBeenCalledWith({ __vault: "default" });
	});

	it("close() closes each transport once, survives a rejecting close, and is idempotent", async () => {
		const { deps, transports } = makeDeps();
		transports.registration.close.mockRejectedValueOnce(new Error("nope"));
		const session = await openPeerReviewSession(deps);
		await expect(session.close()).resolves.toBeUndefined();
		await session.close();
		expect(transports.registration.close).toHaveBeenCalledTimes(1);
		expect(transports.association.close).toHaveBeenCalledTimes(1);
	});

	it("createDecideTimeRegistrationPublisher delegates exactly once", async () => {
		const transport = { publishDecision: jest.fn(async () => "cid") };
		const pub = createDecideTimeRegistrationPublisher(transport, "a1");
		expect(pub.authorityId).toBe("a1");
		await pub.publishDecision({ requestId: "r" } as any);
		expect(transport.publishDecision).toHaveBeenCalledTimes(1);
	});
});

describe("CR3 publishRegistrationDecisionAfterDecide never throws", () => {
	it("no factory: unavailable, zero getEngine calls", async () => {
		const { deps, getEngine } = makeDeps({ createPeerStagingTransports: undefined });
		await expect(publishRegistrationDecisionAfterDecide(deps, "req-A", null)).resolves.toEqual({ kind: "unavailable" });
		expect(getEngine).not.toHaveBeenCalled();
	});

	it("status p: still-pending, no session, no publish", async () => {
		const { deps, regEngine, createPeerStagingTransports } = makeDeps();
		regEngine.getRegistrationRequest.mockResolvedValue({ status: "p" });
		await expect(publishRegistrationDecisionAfterDecide(deps, "req-A", "req-B")).resolves.toEqual({ kind: "still-pending" });
		expect(createPeerStagingTransports).not.toHaveBeenCalled();
		expect(regEngine.publishRegistrationDecision).not.toHaveBeenCalled();
	});

	it("status a with a closing candidate: one publish carrying closesRequestId, session closed", async () => {
		const { deps, regEngine, transports } = makeDeps();
		const out = await publishRegistrationDecisionAfterDecide(deps, "req-A", "req-B");
		expect(out).toEqual({ kind: "published", result: { status: "published" } });
		expect(regEngine.publishRegistrationDecision).toHaveBeenCalledTimes(1);
		const [publisher, id, opts] = regEngine.publishRegistrationDecision.mock.calls[0] as any[];
		expect(publisher.authorityId).toBe("auth-1");
		expect(id).toBe("req-A");
		expect(opts).toEqual({ closesRequestId: "req-B" });
		expect(transports.registration.close).toHaveBeenCalledTimes(1);
		expect(transports.association.close).toHaveBeenCalledTimes(1);
	});

	it("status r with no candidate passes closesRequestId null (never omitted)", async () => {
		const { deps, regEngine } = makeDeps();
		regEngine.getRegistrationRequest.mockResolvedValue({ status: "r" });
		await publishRegistrationDecisionAfterDecide(deps, "req-A", null);
		const opts = (regEngine.publishRegistrationDecision.mock.calls[0] as any[])[2];
		expect(opts).toEqual({ closesRequestId: null });
		expect(Object.prototype.hasOwnProperty.call(opts, "closesRequestId")).toBe(true);
	});

	it("maps a coded rejection to failed with that code, never copying the message", async () => {
		const { deps, regEngine, transports } = makeDeps();
		regEngine.publishRegistrationDecision.mockRejectedValue(Object.assign(new Error("SECRET-MSG"), { code: "cursor-exhausted" }));
		const out = await publishRegistrationDecisionAfterDecide(deps, "req-A", null);
		expect(out).toEqual({ kind: "failed", code: "cursor-exhausted" });
		expect(JSON.stringify(out)).not.toContain("SECRET-MSG");
		expect(transports.registration.close).toHaveBeenCalledTimes(1);
	});

	it("a codeless rejection is 'unknown'", async () => {
		const { deps, regEngine } = makeDeps();
		regEngine.publishRegistrationDecision.mockRejectedValue(new Error("x"));
		await expect(publishRegistrationDecisionAfterDecide(deps, "req-A", null)).resolves.toEqual({ kind: "failed", code: "unknown" });
	});

	it("getEngine throwing is failed/unknown", async () => {
		const { deps } = makeDeps({
			getEngine: jest.fn(async () => {
				throw new Error("engine down");
			}) as any,
		});
		await expect(publishRegistrationDecisionAfterDecide(deps, "req-A", null)).resolves.toEqual({ kind: "failed", code: "unknown" });
	});

	it("a PeerStrandUnavailable factory throw is unavailable and still closes nothing it never opened", async () => {
		const { deps } = makeDeps({
			createPeerStagingTransports: jest.fn(() => {
				throw { peerStrandUnavailable: true };
			}),
		});
		await expect(publishRegistrationDecisionAfterDecide(deps, "req-A", null)).resolves.toEqual({ kind: "unavailable" });
	});
});

describe("CR4 classifiers", () => {
	it("isClosedAsDuplicateError is structural and exact", () => {
		expect(isClosedAsDuplicateError({ name: "RegistrationDuplicateError", code: "closed-as-duplicate" })).toBe(true);
		expect(isClosedAsDuplicateError({ name: "RegistrationDuplicateError", code: "other" })).toBe(false);
		expect(isClosedAsDuplicateError({ name: "Error", code: "closed-as-duplicate" })).toBe(false);
		expect(isClosedAsDuplicateError(null)).toBe(false);
		expect(isClosedAsDuplicateError("closed-as-duplicate")).toBe(false);
	});

	it("C1: isRequesterSignatureUnverifiableError matches the name+code pair only", () => {
		expect(isRequesterSignatureUnverifiableError({ name: "RequesterSignatureUnverifiableError", code: "requester-signature-unverifiable" })).toBe(true);
		expect(isRequesterSignatureUnverifiableError(new Error("SignatureValid failed"))).toBe(false);
		expect(isRequesterSignatureUnverifiableError({ name: "RegistrationDuplicateError", code: "closed-as-duplicate" })).toBe(false);
		expect(isRequesterSignatureUnverifiableError({ name: "RequesterSignatureUnverifiableError", code: "other" })).toBe(false);
	});

	it("isThresholdCoSignRefusal covers ReassociationError and IntakeError only", () => {
		expect(isThresholdCoSignRefusal({ name: "ReassociationError", code: "threshold-requires-co-sign" })).toBe(true);
		expect(isThresholdCoSignRefusal({ name: "IntakeError", code: "threshold-requires-co-sign" })).toBe(true);
		expect(isThresholdCoSignRefusal({ name: "IntakeError", code: "policy-revision-conflict" })).toBe(false);
		expect(isThresholdCoSignRefusal({ name: "Other", code: "threshold-requires-co-sign" })).toBe(false);
		expect(isThresholdCoSignRefusal(null)).toBe(false);
		expect(isThresholdCoSignRefusal("threshold-requires-co-sign")).toBe(false);
	});

	it("classifyReassociationEvidence maps every evidence shape", () => {
		const r = (evidence: any) => classifyReassociationEvidence({ evidence } as any);
		expect(r({ kind: "code", outcome: "matched" })).toBe("code-matched");
		expect(r({ kind: "code", outcome: "unmatched" })).toBe("code-unmatched");
		expect(r({ kind: "code", outcome: "unverifiable" })).toBe("code-unverifiable");
		expect(r({ kind: "identity", fields: [] })).toBe("identity");
		expect(r({ kind: "none" })).toBe("no-evidence");
	});

	it("the local device-key truncation stays identical to AssociationsSection's export", () => {
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const { truncateDeviceKey } = require("../components/AssociationsSection");
		for (const key of ["", "abc", "abcdefgh", "0123456789abcdef"]) {
			expect(truncateDeviceKeyLabel(key)).toBe(truncateDeviceKey(key));
		}
	});

	it("reassociationRegistrantLabel falls back to the truncated new device key", () => {
		expect(reassociationRegistrantLabel({ registrantName: "Ada L", newDeviceKey: "abcdefgh" } as any)).toBe("Ada L");
		expect(reassociationRegistrantLabel({ newDeviceKey: "abcdefgh" } as any)).toBe("abcde...");
	});
});

describe("CR5 signs", () => {
	it("createLazyDeviceSign creates nothing until the first sign, and once across two signs", async () => {
		const inner = jest.fn(async () => ({ signature: "s", signerKey: "k", signerUserId: "u" }));
		const create = jest.fn(async () => inner);
		const lazy = createLazyDeviceSign(create);
		expect(create).not.toHaveBeenCalled();
		await lazy(new Uint8Array([1]));
		await lazy(new Uint8Array([2]));
		expect(create).toHaveBeenCalledTimes(1);
		expect(inner).toHaveBeenCalledTimes(2);
	});

	it("readOnlyReviewSign always rejects", async () => {
		await expect(readOnlyReviewSign(new Uint8Array([1]))).rejects.toThrow();
	});

	it("continuity-review.ts never calls createDeviceSigner, the console or __DEV__", () => {
		const src = stripComments(fs.readFileSync(path.join(SRC, "screens/registration/continuity-review.ts"), "utf8"));
		expect(src).not.toMatch(/createDeviceSigner\(/);
		expect(src).not.toMatch(/console\./);
		expect(src).not.toMatch(/__DEV__/);
		expect((src.match(/\.publishDecision\(/g) ?? []).length).toBe(1);
	});
});

describe("CR6 AppProvider passthrough", () => {
	const src = fs.readFileSync(path.join(SRC, "providers/AppProvider.tsx"), "utf8");
	it("declares the optional field once and passes it in the provider value", () => {
		expect((src.match(/createPeerStagingTransports\?:/g) ?? []).length).toBe(1);
		expect(src).toMatch(/value=\{\{[\s\S]*createPeerStagingTransports,[\s\S]*\}\}/);
	});
	it("is a pure factory-ref passthrough with no dev gate; the peer binding is untouched", () => {
		const cb = src.slice(src.indexOf("const createPeerStagingTransports = useCallback"), src.indexOf("// hasEngine delegates"));
		expect(cb).toContain("engineFactoryRef.current");
		expect(cb).not.toContain("__DEV__");
		expect((src.match(/attachPeerSyncBinding\(/g) ?? []).length).toBe(1);
	});
});

describe("CR7 D-49 mapping", () => {
	it("maps readable access to undefined", () => {
		expect(registrationContentUnreadKey(undefined)).toBeUndefined();
		expect(registrationContentUnreadKey("opened")).toBeUndefined();
		expect(registrationContentUnreadKey("unsealed")).toBeUndefined();
	});

	it("maps each unread access to its own key, and 'unreadable' is neither NoKey nor Tampered", () => {
		expect(registrationContentUnreadKey("not-a-recipient")).toBe("registrationContentNotRecipient");
		expect(registrationContentUnreadKey("no-opener")).toBe("registrationContentNoKey");
		expect(registrationContentUnreadKey("unreadable")).toBe("registrationContentUnreadable");
		expect(registrationContentUnreadKey("unreadable")).not.toBe("registrationContentNoKey");
		expect(registrationContentUnreadKey("unreadable")).not.toBe("registrationContentTampered");
		expect(registrationContentUnreadKey("tampered")).toBe("registrationContentTampered");
	});

	it("every returned key exists in both locales", () => {
		for (const a of ["not-a-recipient", "no-opener", "unreadable", "tampered"] as const) {
			const key = registrationContentUnreadKey(a)!;
			expect((resources.en.translation as Record<string, string>)[key]).toBeTruthy();
			expect((resources.es.translation as Record<string, string>)[key]).toBeTruthy();
		}
	});

	it("isRegistrationContentAccessError is structural", () => {
		expect(
			isRegistrationContentAccessError({
				name: "RegistrationContentAccessError",
				code: "registration-content-unreadable",
				access: "tampered",
				requestId: "r",
				message: "m",
			}),
		).toBe(true);
		expect(isRegistrationContentAccessError(new RegistrationContentAccessError("tampered", "r"))).toBe(true);
		expect(isRegistrationContentAccessError({ name: "X", code: "registration-content-unreadable", access: "tampered" })).toBe(false);
		expect(isRegistrationContentAccessError({ name: "RegistrationContentAccessError", code: "x", access: "tampered" })).toBe(false);
		expect(isRegistrationContentAccessError({ name: "RegistrationContentAccessError", code: "registration-content-unreadable" })).toBe(false);
		expect(isRegistrationContentAccessError(null)).toBe(false);
		expect(isRegistrationContentAccessError("RegistrationContentAccessError")).toBe(false);
	});
});
