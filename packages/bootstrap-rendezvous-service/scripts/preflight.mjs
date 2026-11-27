#!/usr/bin/env node
/**
 * preflight.mjs — the documented pre-restart check.
 *
 * **It runs the SAME gate the service runs at startup.** `runMain` parses the
 * environment and then calls `assertDistProvenance` *before* it binds the port,
 * so a missing, half-written, source-root-pointed or stale build directory makes
 * the process refuse to listen at all. That refusal is correct, and startup is a
 * terrible time to discover it: by then the operator has already stopped the
 * instance that was serving. This script asks the same question while the old
 * instance is still up.
 *
 * So: a green preflight means the next restart will bind the port. A red
 * preflight means it will not — do not restart until it is green.
 *
 * It prints the served entry script and the first sixteen hex characters of its
 * SHA-256. That value is the answer to "is the browser looking at what I
 * deployed?": compare it against the script the browser actually fetched. A
 * mismatch is a browser cache, not a server problem.
 *
 * Usage (from the repository root, with the deployment environment exported):
 *
 *     node packages/bootstrap-rendezvous-service/scripts/preflight.mjs
 *
 * Exit: 0 — the configuration parses and the build directory is servable
 *       1 — a configuration fault or a refused build directory
 *
 * Both imports below are RELATIVE paths into this package's own `dist/`. The
 * package's `exports` map declares only `"."`, so a self-referential package
 * specifier would be rejected by Node; a relative path inside the same package
 * is unaffected. The service must therefore be built before this runs.
 */

import { ServiceConfigError, loadServiceConfig } from '../dist/config.js'
import { DistProvenanceError, assertDistProvenance } from '../dist/static.js'

const REBUILD_COMMAND = 'yarn workspace votetorrent-dashboard build'

function out (line) {
	process.stdout.write(`${line}\n`)
}

function err (line) {
	process.stderr.write(`${line}\n`)
}

function main () {
	let config
	try {
		config = loadServiceConfig(process.env)
	} catch (error) {
		if (error instanceof ServiceConfigError) {
			// Service-authored text, naming the variable and the remedy.
			err(`[preflight] FAIL: ${error.message}`)
			return 1
		}
		// Never a foreign error's message: it can carry a filesystem path or the
		// operator's bearer token. The class name carries neither.
		err(`[preflight] FAIL: ${(error && error.name) || 'Error'} while loading the configuration.`)
		return 1
	}

	let provenance
	try {
		provenance = assertDistProvenance(config)
	} catch (error) {
		if (error instanceof DistProvenanceError) {
			err(`[preflight] FAIL: ${error.message}`)
			err(`[preflight] Rebuild with: ${REBUILD_COMMAND}`)
			return 1
		}
		err(`[preflight] FAIL: ${(error && error.name) || 'Error'} while inspecting the build directory.`)
		err(`[preflight] Rebuild with: ${REBUILD_COMMAND}`)
		return 1
	}

	out(`[preflight] dist directory     : ${provenance.distDir}`)
	out(`[preflight] entry script        : ${provenance.entryScriptHref ?? '(none found)'}`)
	// The value to compare against what a browser actually fetched. A mismatch
	// is a stale browser cache; an unchanged value after a rebuild is a stale
	// server build.
	out(`[preflight] entry script sha256 : ${provenance.entryScriptSha256Prefix ?? '(none)'}`)
	out(`[preflight] entry stylesheet    : ${provenance.entryStylesheetHref ?? '(none found)'}`)
	out(`[preflight] asset count         : ${provenance.assetCount}`)
	out(
		config.distSourceDir === undefined
			? '[preflight] staleness check     : not configured'
			: '[preflight] staleness check     : clean'
	)
	out('[preflight] OK — this build directory is servable; the next restart will bind the port.')
	return 0
}

process.exitCode = main()
