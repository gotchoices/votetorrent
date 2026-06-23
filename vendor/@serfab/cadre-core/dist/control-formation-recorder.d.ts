import type { ControlDatabase } from './control-database.js';
import type { FormationUsageRecorder, ResolvedHostStrand } from './strand-solicitation.js';
import type { OpenInvitation } from './types.js';
/**
 * {@link FormationUsageRecorder} backed by the real `CadreControl` tables.
 *
 * It reads `FormationInvite` / `FormationUsage` to answer token-validity and
 * usage questions, and writes the consent row that records a redemption. Two
 * provisioning shapes are supported, keyed on whether the invite binds a host strand:
 *
 * - **Bound (provision-then-record):** the host strand already exists (authority-signed
 *   up front and named by the invite's `StrandId`), so {@link resolveStrand} reports it
 *   and {@link recordUsage} writes the consent row against that pre-existing strand
 *   (record-only) rather than inserting a new `Strand`.
 * - **Unbound (responder-provisions):** the invite carries no `StrandId`, so
 *   {@link provisionAndRecord} mints a fresh strand and records consent against it
 *   ATOMICALLY (one `FormationUsage` row), closing the single-use hole the older
 *   never-record fallback left open.
 *
 * This replaces the in-memory stubs used by the formation tests so the consent path
 * is exercised against the persisted control network.
 *
 * Usage accounting follows the schema's `FormationUsage.Authorized` semantics:
 * a null `TotalUses` means unlimited uses; otherwise the invite is "used up"
 * once the recorded usage count reaches `TotalUses`.
 */
export declare class ControlFormationUsageRecorder implements FormationUsageRecorder {
    private readonly controlDatabase;
    constructor(controlDatabase: ControlDatabase);
    /** A token is valid when a matching, unexpired `FormationInvite` exists. */
    isTokenValid(token: string): Promise<{
        valid: boolean;
        invitation?: OpenInvitation;
    }>;
    /**
     * A token is "used" when its recorded usage count has reached the invite's
     * `TotalUses`. A null `TotalUses` (unlimited) is never used up; an unknown
     * token is reported not-used (validity is handled by {@link isTokenValid}).
     */
    isTokenUsed(token: string): Promise<boolean>;
    /**
     * Record consent against an **already-existing** host strand (record-only): the
     * single `FormationUsage` insert auto-commits and the deferred `StrandExists`
     * CHECK is satisfied by the pre-existing strand. This is the provision-then-record
     * commitment — the strand was minted authority-signed up front, so we do NOT
     * re-insert it (which would double-insert the same PK). `initiatorKey` is carried
     * as the usage `PeerId` (advisory). Use {@link ControlDatabase.redeemInvitation}
     * for the consent-creates-strand path instead.
     */
    recordUsage(token: string, initiatorKey: string, strandId: string): Promise<void>;
    /**
     * Classify the host strand this invite binds to (see {@link ResolvedHostStrand}):
     *
     * - no invite / no `StrandId` → `unbound` (responder-provisions path).
     * - `StrandId` set AND the strand row is present → `bound`, carrying its
     *   `MemberPrivateKey` (the closed-strand read-gating secret) for delivery to a
     *   validated invitee.
     * - `StrandId` set but the strand row is absent → `missing` (the host strand has not
     *   converged on this responder yet); the manager rejects cleanly instead of recording
     *   usage against a non-existent strand, which would fail the deferred `StrandExists`
     *   CHECK at commit and drop the result frame.
     */
    resolveStrand(token: string): Promise<ResolvedHostStrand>;
    /**
     * Provision a NEW strand for an UNBOUND invite and record consent against it in ONE
     * transaction (the responder-provisions fallback, now single-use-enforced).
     *
     * Mints a fresh, globally-unique strand id from {@link randomBytes} — the same
     * cross-platform CSPRNG `control-database`'s `generateStampId` uses, NOT
     * `crypto.randomUUID` / `Date.now` / `Math.random` (not uniformly available across
     * node/browser/RN) — then delegates to {@link ControlDatabase.redeemInvitation}, whose
     * single `begin … commit` inserts the consent-authorized `Strand` row AND the matching
     * `FormationUsage` row together (both deferred CHECKs see both rows at commit). That one
     * `FormationUsage` row makes the unbound redemption single-use exactly like the bound
     * path: the next redemption of a `TotalUses:1` invite sees `count 1 >= 1` and is rejected.
     *
     * The strand is open (`'o'`) — an unbound responder-provisioned strand has no membership
     * key — so the returned `memberPrivateKey` is null. `sAppId` is accepted for parity/future
     * use; `redeemInvitation` does not currently thread it into the `Strand` row.
     *
     * A concurrent redemption of the same single-use invite collides on the
     * `(Token, UseNumber)` PK and this call THROWS for the loser — the manager maps that to a
     * clean protocol rejection (it never lets the dropped insert close the stream silently).
     */
    provisionAndRecord(token: string, initiatorKey: string, _sAppId: string): Promise<{
        strandId: string;
        memberPrivateKey: string | null;
    }>;
}
