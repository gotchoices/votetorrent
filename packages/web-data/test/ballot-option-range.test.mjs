import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseOptionRange } from '../src/officer/index.js';

test('parseOptionRange reads the pg form, the legacy JSON form and an already-parsed object', () => {
	assert.deepEqual(parseOptionRange('{1, 3}'), { min: 1, max: 3 });
	assert.deepEqual(parseOptionRange('{"min":2,"max":4}'), { min: 2, max: 4 });
	assert.deepEqual(parseOptionRange({ min: 1, max: 1 }), { min: 1, max: 1 });
});

test('parseOptionRange never throws and returns null for anything unreadable', () => {
	for (const bad of [null, undefined, '', 'garbage', '{"min":"a"}', '[1,2]', '{1.5, 2}', 42]) {
		assert.equal(parseOptionRange(bad), null, String(bad));
	}
});
