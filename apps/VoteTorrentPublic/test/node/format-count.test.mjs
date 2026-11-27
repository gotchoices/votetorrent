/**
 * format-count.test.mjs -- counts on the page carry the page language's digit
 * grouping (2026-11-23 todo: "12345 votes" read as one run of digits).
 *
 * Two halves: the formatter itself, executed; and a source scan that every
 * count handed to a copy call in the results and turnout cards goes through
 * it, so a new count site cannot interpolate a raw number unnoticed.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { publicSrc } from '../../../../scripts/lib/source-paths.mjs';
import { stripComments } from '../../../../scripts/lib/strip-comments.mjs';
import { formatCount, pageLanguage } from '../../src/format-count.js';

test('formatCount groups thousands in the page language', () => {
	assert.equal(formatCount(12345), '12,345');
	assert.equal(formatCount(1234567), '1,234,567');
	assert.equal(formatCount(999), '999');
	assert.equal(formatCount(0), '0');
	assert.equal(formatCount(12345n), '12,345');
	assert.equal(formatCount(12345, 'de'), '12.345');
	assert.equal(formatCount(12345, 'es'), '12.345');
});

test('formatCount never throws and leaves a non-count as its plain text', () => {
	assert.equal(formatCount(null), 'null');
	assert.equal(formatCount(Number.NaN), 'NaN');
	assert.equal(formatCount('7'), '7');
	assert.equal(formatCount(12345, 'not a language tag!'), '12,345');
});

test('pageLanguage reads the document root lang and falls back to en', () => {
	assert.equal(pageLanguage(), 'en', 'node has no document');
	const g = /** @type {any} */ (globalThis);
	const had = 'document' in g;
	const prev = g.document;
	try {
		g.document = { documentElement: { lang: 'es' } };
		assert.equal(pageLanguage(), 'es');
		assert.equal(formatCount(12345), '12.345');
		g.document = { documentElement: { lang: '' } };
		assert.equal(pageLanguage(), 'en');
	} finally {
		if (had) g.document = prev;
		else delete g.document;
	}
});

/**
 * Every `name: <expr>` param inside a t('public.fact.(results|turnout).*', {...}) call.
 * @param {string} source
 * @returns {Array<{ name: string, expr: string }>}
 */
function countParams(source) {
	/** @type {Array<{ name: string, expr: string }>} */
	const out = [];
	const callRe = /t\('public\.(?:fact\.results|fact\.turnout|registrantRoll\.chart)\.[\w]+',\s*\{([^}]*)\}\)/g;
	let m;
	while ((m = callRe.exec(source))) {
		for (const part of m[1].split(',')) {
			const i = part.indexOf(':');
			if (i > 0) out.push({ name: part.slice(0, i).trim(), expr: part.slice(i + 1).trim() });
		}
	}
	return out;
}

const TEXT_PARAMS = new Set(['option', 'question', 'district']);

test('control: the param reader sees a raw count and a formatted one', () => {
	const found = countParams("t('public.fact.results.blank', { count: question.blank }) t('public.fact.results.optionCount', { option: o.title, count: formatCount(o.count) })");
	assert.deepEqual(found, [
		{ name: 'count', expr: 'question.blank' },
		{ name: 'option', expr: 'o.title' },
		{ name: 'count', expr: 'formatCount(o.count)' },
	]);
});

for (const file of ['PublishedResults.tsx', 'FactSections.tsx']) {
	test(`${file}: every count handed to results/turnout/roll-chart copy goes through formatCount`, () => {
		const params = countParams(stripComments(readFileSync(publicSrc('screens', file), 'utf8')));
		const counts = params.filter((p) => !TEXT_PARAMS.has(p.name));
		assert.ok(counts.length > 0, `expected count params in ${file}`);
		for (const p of counts) {
			assert.match(p.expr, /^formatCount\(/, `${file}: "${p.name}: ${p.expr}" interpolates a raw count`);
		}
	});
}
