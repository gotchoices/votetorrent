/**
 * The results screen's 'unavailable' state shows plain copy, never the engine's reason code. Every reason the
 * results engine can return maps to a key with English and Spanish copy; an unknown code falls back to general.
 */
import { resources } from "../../../i18n";
import { unavailableCopyKey } from "../results-unavailable";

const ENGINE_REASONS = [
	// ElectionResultsEngine's own
	"election-key-inconsistent", "no-timeline", "read-failed", "reconstruction-failed",
	// KeyReleaseError codes reconstructElectionKey can throw
	"no-current-revision", "revision-not-current", "no-election-key", "share-missing", "share-invalid",
	"insufficient-shares", "group-key-mismatch", "release-window-not-open",
	// TallyTreeRefusal
	"malformed-input", "not-released", "inconsistent-inputs", "count-overflow", "malformed-row", "duplicate-block",
	"mixed-election", "mixed-revision", "invalid-secret", "secret-mismatch",
];

const en = resources.en.translation as Record<string, string>;
const es = resources.es.translation as Record<string, string>;

describe("results unavailable copy", () => {
	it.each(ENGINE_REASONS)("%s has plain copy in English and Spanish, without the code", (reason) => {
		const key = unavailableCopyKey(reason);
		expect(key).not.toBe("resultsUnavailableGeneral");
		expect(en[key]).toEqual(expect.any(String));
		expect(es[key]).toEqual(expect.any(String));
		expect(es[key]).not.toBe(en[key]);
		expect(en[key]).not.toContain(reason);
	});

	it("an unknown code falls back to the general sentence", () => {
		expect(unavailableCopyKey("some-future-code")).toBe("resultsUnavailableGeneral");
		expect(unavailableCopyKey("toString")).toBe("resultsUnavailableGeneral");
		expect(en.resultsUnavailableGeneral).toEqual(expect.any(String));
		expect(es.resultsUnavailableGeneral).toEqual(expect.any(String));
	});

	it("the old 'Reason: {{reason}}' line is gone from both catalogs", () => {
		expect(en.resultsUnavailableReason).toBeUndefined();
		expect(es.resultsUnavailableReason).toBeUndefined();
	});
});
