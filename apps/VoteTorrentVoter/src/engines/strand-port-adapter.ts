/**
 * strand-port-adapter.ts — Phase 62 Plan 22 (D-28/D-32).
 *
 * Wraps the established network's ALREADY-OPEN Quereus `Database` (the handle
 * `EngineFactory`'s DbFactory lambda already holds, via `createStrandDbFactory` ->
 * `CadreNode.addStrand`) as the narrow `VoterStrandPort` the 62-15 P2P transports and the
 * 62-14 intake query port both consume structurally. This module imports NO `@serfab`,
 * `@optimystic/db-p2p` or `@libp2p` package — it never opens a strand itself, and never calls
 * `addStrand` a second time. The strand fabric is reached ONLY through `rn-db-factory.ts`
 * (app layer), exactly as that file's own header requires.
 *
 * `close()` is DELIBERATELY a no-op: the strand database is CadreNode-owned and shared with
 * every other engine built over the same established network context (NetworkEngine,
 * RegistrationEngine, AssociationEngine, ...). A transport that closed it on its own `close()`
 * call would tear down every sibling engine's handle too — see 62-21/62-22's shared-tree note.
 *
 * The three digest functions below never re-implement `Digest()` in TypeScript. Each one binds
 * the exact SQL tuple the schema's own `SignatureValid` CHECK recomputes (registration DG-1:
 * `registration-engine.ts:1836-1848`; association leg 1/leg 2:
 * `association-request-digest.ts`'s header) and decodes the strand's own answer.
 */
import type { Database, SqlValue } from '@quereus/quereus'
import type {
	AssociationAttestationAnswer,
	AssociationRequestInit,
	RegistrationRequestInit,
} from '@votetorrent/vote-core'

/** The narrow, injected seam `RegistrationStrandPort`/`AssociationStrandPort`
 * (62-15) and `IntakeQueryPort` (62-14) both accept structurally. */
export interface VoterStrandPort {
	query<T>(sql: string, params: Record<string, unknown>): Promise<T[]>
	mutate(sql: string, params: Record<string, unknown>): Promise<void>
	/** No-op — see this module's header. The shared strand DB outlives any one transport. */
	close(): Promise<void>
}

/** Collects `db.eval(sql, params)` rows into an array of plain objects. */
export function createVoterStrandPort(db: Database): VoterStrandPort {
	return {
		async query<T>(sql: string, params: Record<string, unknown>): Promise<T[]> {
			const rows: T[] = []
			for await (const row of db.eval(sql, params as Record<string, SqlValue>)) {
				rows.push(row as T)
			}
			return rows
		},
		async mutate(sql: string, params: Record<string, unknown>): Promise<void> {
			// 62-06's probe (`param.execBinding = ok`) confirmed db.exec binds named params
			// correctly on a strand database — the db.prepare(sql).run(params) fallback the plan
			// names is not needed here. See the SUMMARY's "mutate call shape" note.
			await db.exec(sql, params as Record<string, SqlValue>)
		},
		async close(): Promise<void> {
			// Deliberately does nothing — see this module's header.
		},
	}
}

// Quereus parses bind names "limit", "desc", "group", "order" and "type" (each preceded by a
// colon) as keywords rather than parameters — no SQL text below binds any of those five bare
// names (the "issuerType" param's capital letter mid-word is a different token entirely).

type QueryOnly = Pick<VoterStrandPort, 'query'>

/**
 * Decodes a `Digest()` UDF result (always 43-char unpadded base64url for a 32-byte SHA-256
 * digest on this stack) into raw bytes, using the same `globalThis` `atob` cast idiom
 * `packages/attestation-native/src/secret-wrap.ts` uses (no ambient `dom` lib dependency).
 * Throws a release-bundle-detectable marker unless the result is exactly 32 bytes.
 */
type AtobGlobalEnv = { atob: (data: string) => string }
const { atob: atobFn } = globalThis as unknown as AtobGlobalEnv

function base64UrlDigestToBytes(value: unknown, site: string): Uint8Array {
	if (typeof value !== 'string' || value.length === 0) {
		throw new Error('voter-request-transports: digest is not a 32-byte base64url value (' + site + ')')
	}
	// Restore standard base64 padding (43 -> 44 chars) before decoding — mirrors
	// vote-engine/src/utils.ts's digestToBytes base64url branch.
	const b64 = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=')
	let bytes: Uint8Array
	try {
		const binary = atobFn(b64)
		bytes = new Uint8Array(binary.length)
		for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
	} catch {
		throw new Error('voter-request-transports: digest is not a 32-byte base64url value (' + site + ')')
	}
	if (bytes.length !== 32) {
		throw new Error('voter-request-transports: digest is not a 32-byte base64url value (' + site + ')')
	}
	return bytes
}

/**
 * Reproduces `RegistrationEngine.submitRegistrationRequest`'s DG-1 computation field for field
 * (`registration-engine.ts:1796-1848`): `PayloadCid = Digest(JSON.stringify(init.payload))`, then
 * `Digest(Id, AuthorityId, RequesterKey, IssuerType, BridgeId, PayloadCid, SubmittedAt)`. Never a
 * TypeScript re-implementation of `Digest()` — both selects run through the strand's own UDF.
 */
export function createRegistrationRequestDigestFn(
	port: QueryOnly,
): (init: RegistrationRequestInit, requesterKey: string) => Promise<Uint8Array> {
	return async (init: RegistrationRequestInit, requesterKey: string): Promise<Uint8Array> => {
		const payload = JSON.stringify(init.payload)
		const payloadCidRows = await port.query<{ d: string | null }>('select Digest(:payload) as d', { payload })
		const payloadCid = payloadCidRows[0]?.d
		if (payloadCid == null) {
			throw new Error('createRegistrationRequestDigestFn: Digest() returned null for Payload')
		}

		const issuerType = init.issuerType ?? 'registrant'
		const bridgeId = init.bridgeId ?? null

		const digestRows = await port.query<{ d: string | null }>(
			'select Digest(:id, :rowAuthorityId, :requesterKey, :issuerType, :bridgeId, :payloadCid, :submittedAt) as d',
			{
				id: init.id,
				rowAuthorityId: init.authorityId,
				requesterKey,
				issuerType,
				bridgeId,
				payloadCid,
				submittedAt: init.submittedAt,
			},
		)
		return base64UrlDigestToBytes(digestRows[0]?.d, 'registration-request')
	}
}

/**
 * Reproduces `association-request-digest.ts`'s leg-1 tuple
 * (`Digest(Id, AuthorityId, RegistrantId, DeviceKey, ElectionId, SubmittedAt)`), with
 * `DeviceKey := requesterKey` (the engine's own binding) and `ElectionId := init.electionId ?? null`.
 */
export function createAssociationRequestDigestFn(
	port: QueryOnly,
): (init: AssociationRequestInit, requesterKey: string) => Promise<Uint8Array> {
	return async (init: AssociationRequestInit, requesterKey: string): Promise<Uint8Array> => {
		const rows = await port.query<{ d: string | null }>(
			'select Digest(:id, :rowAuthorityId, :registrantId, :deviceKey, :electionId, :submittedAt) as d',
			{
				id: init.id,
				rowAuthorityId: init.authorityId,
				registrantId: init.registrantId,
				deviceKey: requesterKey,
				electionId: init.electionId ?? null,
				submittedAt: init.submittedAt,
			},
		)
		return base64UrlDigestToBytes(rows[0]?.d, 'association-request')
	}
}

/**
 * Reproduces `association-request-digest.ts`'s leg-2 tuple
 * (`Digest(RequestId, Nonce, AttestationJson, DeviceHash)`), where
 * `AttestationJson = JSON.stringify(answer.attestation)` — the serialization is part of the
 * tuple, not an implementation detail (object key order is a digest input).
 */
export function createAssociationAttestationDigestFn(
	port: QueryOnly,
): (answer: AssociationAttestationAnswer, requesterKey: string) => Promise<Uint8Array> {
	return async (answer: AssociationAttestationAnswer): Promise<Uint8Array> => {
		const rows = await port.query<{ d: string | null }>(
			'select Digest(:requestId, :nonce, :attestationJson, :deviceHash) as d',
			{
				requestId: answer.requestId,
				nonce: answer.nonce,
				attestationJson: JSON.stringify(answer.attestation),
				deviceHash: answer.deviceHash ?? null,
			},
		)
		return base64UrlDigestToBytes(rows[0]?.d, 'association-attestation')
	}
}

/** `RequesterKey` is a cleartext column (62-01) — this read never touches sealed content. */
export function listOwnStagedAssociationRequestIds(
	port: QueryOnly,
	strandId: string,
	requesterKey: string,
): Promise<string[]> {
	return port
		.query<{ RequestId: string }>(
			'select RequestId from AssociationRequestStaging where StrandId = :strandId and RequesterKey = :requesterKey order by Cursor',
			{ strandId, requesterKey },
		)
		.then((rows) => rows.map((row) => row.RequestId))
}

/**
 * Phase 62 Plan 28 (D-45) — same shape as `listOwnStagedAssociationRequestIds`, over
 * `RegistrationRequestStaging`. Exists so the D-45 registration-code card is offered only for a
 * registration whose sealed staging row an officer can actually open (REST-bridge/filesystem
 * registrations have no such row) — see `continuity.ts`'s `resolveRegistrationCodeAvailability`.
 */
export function listOwnStagedRegistrationRequestIds(
	port: QueryOnly,
	strandId: string,
	requesterKey: string,
): Promise<string[]> {
	return port
		.query<{ RequestId: string }>(
			'select RequestId from RegistrationRequestStaging where StrandId = :strandId and RequesterKey = :requesterKey order by Cursor',
			{ strandId, requesterKey },
		)
		.then((rows) => rows.map((row) => row.RequestId))
}
