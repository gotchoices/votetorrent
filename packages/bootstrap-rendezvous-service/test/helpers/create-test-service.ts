import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ServiceConfig } from '../../src/config.js'
import { createServiceLogger, type ServiceLogger } from '../../src/logging.js'
import { startService, type RunningService } from '../../src/server.js'
import { assertDistProvenance, resetDistProvenanceCache } from '../../src/static.js'
import { createRendezvousStores, type RendezvousRecord, type RendezvousStores } from '../../src/store.js'
import { createFixtureDist, type FixtureDist } from './fixture-dist.js'

/**
 * create-test-service.ts — the REAL-service test factory.
 *
 * ## Why this file exists (D-27)
 *
 * The shared bootstrap-transport conformance suite lives in
 * `packages/vote-engine/test/bootstrap-transport-conformance.spec.ts`. Until
 * `52-13` its REST binding was graded against a hand-written in-test
 * `node:http` receiver with a `Map` behind it — a fixture written by the same
 * hand, in the same file, on the same afternoon as the assertions that graded
 * it. **A conformance suite that tests a mock proves the mock.** That is
 * precisely how a whole phase shipped believing the protocol had a server.
 *
 * This factory is the correction. It starts the REAL service — the real route
 * table, the real dispatcher, the real store, the real validators — on an
 * ephemeral loopback port, so the conformance suite proves service↔binding
 * agreement rather than binding↔stand-in agreement.
 *
 * ## How the conformance suite reaches it
 *
 * By RELATIVE PATH across the package boundary, not by package specifier:
 *
 *     import { createTestService } from
 *       '../../bootstrap-rendezvous-service/test/helpers/create-test-service.js'
 *
 * The reasons are written out in that spec's own module header. In one line:
 * a package specifier would need this package as a devDependency of
 * `@votetorrent/vote-engine`, which this package already depends on — a
 * workspace cycle, and a build-ordering cycle with it. The relative specifier
 * resolves to TypeScript SOURCE, which ts-node transpiles in-process, so only
 * `@votetorrent/vote-engine` ever has to be built.
 *
 * ## Teardown is not a detail
 *
 * This factory binds a real port. A leaked listener hangs mocha, and a hung
 * suite is indistinguishable from a slow one — so `close()` is idempotent, it
 * stops the retention sweep, it closes the socket, and it removes both temp
 * directories. Neither package's `test` script carries `--exit`, deliberately:
 * a leak must be a visible hang, not something a flag quietly papers over.
 *
 * ## Why not the process entry point
 *
 * `src/main.ts`'s exported bootstrap reads `process.env`, installs
 * `SIGINT`/`SIGTERM` handlers and sets `process.exitCode`. None of those belong
 * in a test process, and a signal handler installed once per created service
 * would accumulate across a suite. This factory therefore builds a
 * `ServiceConfig` by hand and calls `startService` directly, exactly as this
 * package's own `server-routes.spec.ts` does. A structural gate in `52-13`
 * counts zero occurrences of that entry point's symbol name in this file, so
 * the name is deliberately not written out anywhere above.
 */

/**
 * Knobs the conformance harness does not normally touch. Every one of them has
 * a default chosen so a conformance run is deterministic and silent; they exist
 * for the odd spec that needs to observe something specific.
 */
export interface CreateTestServiceOptions {
	/** The upload ceiling in bytes. Default 8 MiB — the package default, so an
	 * upload the real service would accept is accepted here too. */
	maxUploadBytes?: number
	/** How long an expired record survives before the sweep may erase it.
	 * Default 60 minutes. Irrelevant while `sweepIntervalSeconds` keeps the
	 * sweep from ever firing, and present so a sweep-aware spec can set it. */
	graceWindowMinutes?: number
	/** Default 3600 — see the comment on the config literal below. */
	sweepIntervalSeconds?: number
	/** Default `'production'`, which is silent. Set `'development'` together
	 * with `sink` to capture the log stream while debugging a run. */
	logMode?: 'production' | 'development'
	/** Receives every emitted log line instead of the process's stdout. */
	sink?: (line: string) => void
}

export interface TestServiceHandle {
	/** `http://127.0.0.1:<ephemeral port>` — no trailing slash. */
	readonly baseUrl: string
	/** The port the kernel actually assigned. Never zero. */
	readonly port: number
	/** The operator bearer token this instance was started with. Unique per
	 * instance, so two concurrent services never share one. */
	readonly uploadToken: string
	readonly dataDir: string
	readonly distDir: string
	readonly config: ServiceConfig
	/**
	 * Arms a ONE-SHOT fault inside the running service: the next
	 * `store.getRecord` call rejects, the flag clears itself, and every
	 * subsequent call behaves normally again.
	 *
	 * This is what lets the conformance suite's `makeFailingSource` produce a
	 * GENUINE service-internal fault — the mirror of the filesystem harness's
	 * corrupted on-disk document — that travels the real dispatcher and emerges
	 * as a real `500`. It is deliberately NOT implemented by closing the socket:
	 * that would prove the transport handles a dead endpoint, which is a
	 * different claim entirely.
	 */
	failNextRecordRead: () => void
	/** Idempotent. A second call resolves immediately and does nothing. */
	close: () => Promise<void>
}

/**
 * Distinguishes one instance's operator token from another's, and makes a token
 * that ever appears in an error message unmistakably test-authored.
 */
let tokenSeq = 0

/** The fixed message of the injected fault. It carries NO look-up id: an
 * injected fault must not be the thing that teaches a leak into a response. */
export const INJECTED_RECORD_READ_FAULT_MESSAGE = 'create-test-service: injected record-read fault'

export async function createTestService (options: CreateTestServiceOptions = {}): Promise<TestServiceHandle> {
	// 1. A throwaway data root. The service creates its own sub-structure
	// underneath it; nothing here anticipates that layout.
	const dataDir = await mkdtemp(join(tmpdir(), 'brs-conformance-data-'))

	// 2. A dist fixture shaped exactly like a real Vite build, from `52-04`'s
	// own helper — never a hand-written index.html, which would be a second
	// declaration of a shape that package already owns.
	let fixture: FixtureDist
	try {
		fixture = createFixtureDist()
	} catch (err) {
		await rm(dataDir, { recursive: true, force: true })
		throw err
	}
	const distDir = fixture.distDir

	// 3. A per-instance operator token.
	tokenSeq += 1
	const uploadToken = `conformance-upload-token-${tokenSeq}`

	// 4. ANNOTATED, not inferred: a field added to `ServiceConfig` by a later
	// plan becomes a compile error in this package's own typecheck rather than
	// a silently-defaulted hole in the conformance harness.
	const config: ServiceConfig = {
		bindHost: '127.0.0.1',
		port: 0,
		allowNonLoopbackBind: false,
		uploadToken,
		maxUploadBytes: options.maxUploadBytes ?? 8 * 1024 * 1024,
		graceWindowMinutes: options.graceWindowMinutes ?? 60,
		// An hour. The sweep therefore CANNOT fire during a suite run, so no
		// conformance case can be made flaky by a background erasure it never
		// asked for. The retention sweep has its own deterministic tests in
		// `52-10`; it does not need re-proving from here.
		sweepIntervalSeconds: options.sweepIntervalSeconds ?? 3600,
		dataDir,
		distDir,
		distSourceDir: undefined,
		allowStaleDist: false,
		// Silent by default, which is the shipped default. `logMode` and `sink`
		// together turn the stream back on when a run needs to be debugged.
		logMode: options.logMode ?? 'production'
	}

	// 5. The provenance gate, HERE, before a port is bound.
	//
	// `52-04` wired this gate into `src/main.ts`'s process bootstrap, NOT into
	// `startService`. A factory
	// that assumed otherwise would happily start against a broken fixture dist
	// and fail only on a static request the conformance suite never makes.
	// Calling it here means a malformed fixture fails at harness construction,
	// with `DistProvenanceError`'s own operator-actionable message. The error is
	// deliberately NOT caught — it is the answer, not an obstacle.
	try {
		assertDistProvenance(config)
	} catch (err) {
		fixture.cleanup()
		await rm(dataDir, { recursive: true, force: true })
		throw err
	}

	// 6. The one real store instance.
	const baseStore = await createRendezvousStores(dataDir)

	// 7. The faulting decorator. Typed as `RendezvousStores` so a method added
	// to that interface later is a compile error here rather than a silent hole
	// in the pass-through.
	let failNextRecordReadFlag = false
	const faultingStore: RendezvousStores = {
		...baseStore,
		async getRecord (lookupId: string): Promise<RendezvousRecord | undefined> {
			if (failNextRecordReadFlag) {
				// Cleared BEFORE the throw, so the fault is one-shot and the
				// harness is healthy again on the very next call.
				failNextRecordReadFlag = false
				throw new Error(INJECTED_RECORD_READ_FAULT_MESSAGE)
			}
			return await baseStore.getRecord(lookupId)
		}
	}

	const logger: ServiceLogger = createServiceLogger(
		options.sink === undefined
			? { mode: config.logMode }
			: { mode: config.logMode, sink: options.sink }
	)

	let running: RunningService
	try {
		running = await startService(config, { store: faultingStore, logger })
	} catch (err) {
		fixture.cleanup()
		await rm(dataDir, { recursive: true, force: true })
		throw err
	}

	const baseUrl = `http://127.0.0.1:${running.port}`

	let closed = false

	return {
		baseUrl,
		port: running.port,
		uploadToken,
		dataDir,
		distDir,
		config,
		failNextRecordRead (): void {
			failNextRecordReadFlag = true
		},
		async close (): Promise<void> {
			// Idempotent because the conformance harness's `afterEach` calls
			// `close()` unconditionally while an individual case may already
			// have closed the handle itself.
			if (closed) return
			closed = true
			// Stops the sweep interval and closes the listening socket.
			await running.close()
			await rm(dataDir, { recursive: true, force: true })
			await rm(distDir, { recursive: true, force: true })
			// The provenance verdict is memoised per `distDir`, and temp
			// directory names can in principle repeat across a long run. Dropping
			// the memo means a later instance re-walks its own fixture rather
			// than inheriting a verdict about a directory that no longer exists.
			resetDistProvenanceCache()
		}
	}
}
