import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * fixture-dist.ts — a throwaway directory shaped exactly like a real Vite
 * build of the dashboard.
 *
 * The shape is not invented. `apps/VoteTorrentDashboard/vite.config.ts` sets
 * `build: { target: 'es2022', sourcemap: true }` with no `rollupOptions`, no
 * `assetsDir` override and no `publicDir` override, so a real build emits
 * exactly `index.html`, `assets/index-<hash>.js`, `assets/index-<hash>.js.map`
 * and `assets/index-<hash>.css`. This helper mirrors that, hash and all, so a
 * test asserting against the fixture is asserting against the same shape the
 * service will meet in production.
 *
 * The overrides exist so a test can produce each *unhealthy* dist the
 * provenance gate has to refuse — a missing asset, an untypeable extension, a
 * planted symlink, or the dashboard's source root mistaken for its build
 * output.
 */

export const FIXTURE_HASH = 'TESTHASH'
export const FIXTURE_SCRIPT_HREF = `/assets/index-${FIXTURE_HASH}.js`
export const FIXTURE_STYLESHEET_HREF = `/assets/index-${FIXTURE_HASH}.css`

export interface FixtureDistOverrides {
	/** Point `index.html` at the SOURCE entry points, reproducing an operator
	 * who configured the dashboard's source root instead of its `dist/`. */
	sourceRootIndex?: boolean
	/** Reference a script that is deliberately never written to disk. */
	missingScriptHref?: string
	/** Skip writing the stylesheet the index references. */
	omitStylesheet?: boolean
	/** Extra files to plant, keyed by path relative to the dist root. */
	extraFiles?: Record<string, string>
	/** A symbolic link to plant inside the dist root, keyed by relative path,
	 * valued with the absolute target it points at. */
	symlinks?: Record<string, string>
}

export interface FixtureDist {
	distDir: string
	indexHtmlPath: string
	scriptPath: string
	stylesheetPath: string
	sourceMapPath: string
	cleanup: () => void
}

function indexHtmlFor (scriptHref: string, stylesheetHref: string): string {
	return [
		'<!doctype html>',
		'<html lang="en">',
		'<head>',
		'\t<meta charset="utf-8" />',
		'\t<title>VoteTorrent Authority Dashboard</title>',
		`\t<script type="module" crossorigin src="${scriptHref}"></script>`,
		`\t<link rel="stylesheet" crossorigin href="${stylesheetHref}">`,
		'</head>',
		'<body>',
		'\t<div id="root"></div>',
		'</body>',
		'</html>',
		''
	].join('\n')
}

export function createFixtureDist (overrides: FixtureDistOverrides = {}): FixtureDist {
	const distDir = mkdtempSync(join(tmpdir(), 'bootstrap-rendezvous-dist-'))
	mkdirSync(join(distDir, 'assets'), { recursive: true })

	const scriptHref = overrides.sourceRootIndex === true
		? '/src/main.tsx'
		: overrides.missingScriptHref ?? FIXTURE_SCRIPT_HREF
	const stylesheetHref = overrides.sourceRootIndex === true ? '/src/app.css' : FIXTURE_STYLESHEET_HREF

	const indexHtmlPath = join(distDir, 'index.html')
	writeFileSync(indexHtmlPath, indexHtmlFor(scriptHref, stylesheetHref), 'utf8')

	// The real asset set is always written under its canonical name, so a test
	// that points `index.html` at a missing href still has a healthy file to
	// fetch alongside it.
	const scriptPath = join(distDir, 'assets', `index-${FIXTURE_HASH}.js`)
	const sourceMapPath = `${scriptPath}.map`
	const stylesheetPath = join(distDir, 'assets', `index-${FIXTURE_HASH}.css`)
	writeFileSync(scriptPath, 'export const marker = "fixture-dist-entry";\n', 'utf8')
	writeFileSync(sourceMapPath, '{"version":3,"sources":[],"mappings":""}\n', 'utf8')
	if (overrides.omitStylesheet !== true) {
		writeFileSync(stylesheetPath, ':root { --fixture: 1; }\n', 'utf8')
	}

	for (const [relative, contents] of Object.entries(overrides.extraFiles ?? {})) {
		const full = join(distDir, relative)
		mkdirSync(join(full, '..'), { recursive: true })
		writeFileSync(full, contents, 'utf8')
	}

	for (const [relative, target] of Object.entries(overrides.symlinks ?? {})) {
		const full = join(distDir, relative)
		mkdirSync(join(full, '..'), { recursive: true })
		symlinkSync(target, full)
	}

	return {
		distDir,
		indexHtmlPath,
		scriptPath,
		stylesheetPath,
		sourceMapPath,
		cleanup: () => {
			rmSync(distDir, { recursive: true, force: true })
		}
	}
}

/**
 * A throwaway source tree for the staleness leg. `newerThanMs` is a numeric
 * epoch-millisecond value, never a formatted datetime — the whole staleness
 * comparison in `static.ts` is `Stats.mtimeMs` arithmetic and nothing else.
 */
export function createFixtureSourceDir (options: { newestFileMtimeMs: number }): { sourceDir: string, newestFilePath: string, cleanup: () => void } {
	const sourceDir = mkdtempSync(join(tmpdir(), 'bootstrap-rendezvous-src-'))
	const newestFilePath = join(sourceDir, 'main.tsx')
	writeFileSync(newestFilePath, 'export const entry = 1;\n', 'utf8')
	writeFileSync(join(sourceDir, 'app.css'), ':root { --src: 1; }\n', 'utf8')
	touch(newestFilePath, options.newestFileMtimeMs)
	touch(join(sourceDir, 'app.css'), options.newestFileMtimeMs - 60_000)
	return {
		sourceDir,
		newestFilePath,
		cleanup: () => {
			rmSync(sourceDir, { recursive: true, force: true })
		}
	}
}

/** Sets both atime and mtime from an epoch-millisecond number. */
export function touch (filePath: string, mtimeMs: number): void {
	const seconds = mtimeMs / 1000
	utimesSync(filePath, seconds, seconds)
}
