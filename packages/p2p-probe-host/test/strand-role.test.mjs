import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveStrandRole, strandFounderOption } from '../strand-role.mjs';

test('unset role defaults from control founder', () => {
  assert.deepEqual(resolveStrandRole({}, true), { role: 'found', explicit: false });
  assert.deepEqual(resolveStrandRole({}, false), { role: 'join', explicit: false });
});
test('empty string is unset', () => {
  assert.deepEqual(resolveStrandRole({ DRONE_STRAND_ROLE: '' }, true), { role: 'found', explicit: false });
});
test('explicit roles win', () => {
  assert.deepEqual(resolveStrandRole({ DRONE_STRAND_ROLE: 'join' }, true), { role: 'join', explicit: true });
  assert.deepEqual(resolveStrandRole({ DRONE_STRAND_ROLE: 'found' }, false), { role: 'found', explicit: true });
});
test('invalid role throws naming allowed values', () => {
  assert.throws(() => resolveStrandRole({ DRONE_STRAND_ROLE: 'bogus' }, true), /found.*join|join.*found/);
});
test('default found -> founder:true', () => {
  assert.deepEqual(strandFounderOption({ role: 'found', explicit: false }), { founder: true });
});
test('default join -> no founder key', () => {
  const o = strandFounderOption({ role: 'join', explicit: false });
  assert.deepEqual(o, {});
  assert.equal(Object.prototype.hasOwnProperty.call(o, 'founder'), false);
});
test('explicit join -> founder:false', () => {
  assert.deepEqual(strandFounderOption({ role: 'join', explicit: true }), { founder: false });
});
test('explicit found -> founder:true', () => {
  assert.deepEqual(strandFounderOption({ role: 'found', explicit: true }), { founder: true });
});
test('explicit STRAND_ID with no role throws naming both roles', () => {
  assert.throws(() => resolveStrandRole({ STRAND_ID: 'abc' }, true), /DRONE_STRAND_ROLE.*found or join/);
  assert.throws(() => resolveStrandRole({ STRAND_ID: 'abc', DRONE_STRAND_ROLE: '' }, false), /DRONE_STRAND_ROLE/);
});
test('explicit STRAND_ID with an explicit role resolves', () => {
  assert.deepEqual(resolveStrandRole({ STRAND_ID: 'abc', DRONE_STRAND_ROLE: 'join' }, true), { role: 'join', explicit: true });
});
test('empty STRAND_ID keeps the inferred default', () => {
  assert.deepEqual(resolveStrandRole({ STRAND_ID: '' }, false), { role: 'join', explicit: false });
});
