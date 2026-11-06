import test from 'node:test';
import assert from 'node:assert/strict';
import { BODY_PARTS, calculate, inferMultiplier, rangeAt, shotTime, validateDatabase, validateWeapon } from '../dist/engine.js';
import { DEMO_DATABASE } from '../dist/demo-data.js';

const close = (actual, expected, tolerance = 1e-8) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} ≠ ${expected}`);
const weapon = (patch = {}) => ({
  id: 'test', name: '验证武器', category: '步枪', notes: '', velocity: 500, triggerDelayMs: 20,
  ranges: [{ until: 20, damage: 30 }, { until: null, damage: 24 }],
  multipliers: { head: 1.5, neck: 1.2, chest: 1, abdomen: 1, upperArm: 1, forearm: 0.8, thigh: 0.8, calf: 0.8 },
  modes: [{ id: 'auto', name: '全自动', type: 'auto', rpm: 600 }], ...patch,
});
const database = (weapons = [weapon()]) => ({ schemaVersion: 1, name: '测试数据库', updatedAt: '2026-11-07T00:00:00.000Z', weapons });

test('eight shared body parts have stable distinct identifiers', () => {
  assert.equal(BODY_PARTS.length, 8);
  assert.equal(new Set(BODY_PARTS.map(item => item.id)).size, 8);
});

test('range boundaries enter the next segment, including exact boundaries', () => {
  const w = weapon();
  assert.equal(rangeAt(w, 0).index, 0);
  assert.equal(rangeAt(w, 19.999).index, 0);
  assert.equal(rangeAt(w, 20).index, 1);
  assert.equal(rangeAt(w, 10000).index, 1);
  assert.throws(() => rangeAt(w, -1), /距离/);
});

test('continuous fire counts N−1 intervals and one initial trigger delay', () => {
  const result = calculate(weapon(), { health: 100 });
  assert.equal(result.btk, 4);
  assert.equal(result.shotMs, 300);
  assert.equal(result.ttk, 320);
  assert.equal(result.distribution[0].probability, 1);
});

test('one-shot kill has trigger delay but no firing interval', () => {
  assert.equal(calculate(weapon(), { health: 30 }).ttk, 20);
});

test('flight time is included only when enabled and uses selected distance', () => {
  const w = weapon();
  const without = calculate(w, { distance: 50, health: 100 });
  const withFlight = calculate(w, { distance: 50, health: 100, includeTravel: true });
  assert.equal(withFlight.travelMs, 100);
  assert.equal(withFlight.ttk - without.ttk, 100);
});

test('a single global multiplier derives body damage at all distances', () => {
  const w = weapon();
  assert.equal(calculate(w, { distance: 0, part: 'head' }).damage, 45);
  assert.equal(calculate(w, { distance: 30, part: 'head' }).damage, 36);
});

test('damage inference keeps recurring multiplier precise at BTK boundaries', () => {
  const w = weapon();
  w.multipliers.head = inferMultiplier(30, 40);
  const result = calculate(w, { health: 120, part: 'head' });
  assert.equal(result.damage, 40);
  assert.equal(result.btk, 3);
  assert.throws(() => inferMultiplier(0, 40), /基础伤害/);
  assert.throws(() => inferMultiplier(30, -1), /部位伤害/);
});

test('decimal damage is compared as integer ticks, with no false extra bullet', () => {
  const w = weapon({ ranges: [{ until: null, damage: 0.1 }] });
  w.multipliers.chest = 3;
  assert.equal(calculate(w, { health: 0.9 }).btk, 3);
  w.ranges[0].damage = 33.3333333333;
  w.multipliers.chest = 1;
  assert.equal(calculate(w, { health: 100 }).btk, 4);
});

test('bolt/pump uses its full cycle and does not add the nominal RPM interval', () => {
  const w = weapon({ modes: [{ id: 'bolt', name: '栓动', type: 'bolt', cycleMs: 800, rpm: 30 }] });
  assert.equal(calculate(w).ttk, 2420);
});

test('semi-auto is modelled at its fastest allowed cadence', () => {
  const w = weapon({ modes: [{ id: 'semi', name: '半自动', type: 'semi', rpm: 300 }] });
  assert.equal(calculate(w).ttk, 620);
});

test('burst gap is measured from previous last shot to next first shot', () => {
  const w = weapon({ modes: [{ id: 'burst', name: '三连发', type: 'burst', rpm: 600, burstSize: 3, gapMs: 300 }] });
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7].map(n => shotTime(w, w.modes[0], n)), [20, 120, 220, 520, 620, 720, 1020]);
  assert.equal(calculate(w, { health: 100 }).ttk, 520);
});

test('mixed expected BTK differs from BTK calculated using average damage', () => {
  const w = weapon({ ranges: [{ until: null, damage: 50 }] });
  w.multipliers.head = 2;
  const result = calculate(w, { probabilities: { head: 50, chest: 50 } });
  assert.equal(result.btk, 1.5);
  assert.equal(result.ttk, 70);
  assert.equal(result.damage, 75);
  assert.deepEqual(result.distribution.map(({ shots, probability }) => ({ shots, probability })), [{ shots: 1, probability: 0.5 }, { shots: 2, probability: 0.5 }]);
});

test('mixed burst TTK weights actual shot times across the burst boundary', () => {
  const w = weapon({ ranges: [{ until: null, damage: 25 }], modes: [{ id: 'burst', name: '三连发', type: 'burst', rpm: 600, burstSize: 3, gapMs: 300 }] });
  w.multipliers.head = 2;
  const result = calculate(w, { probabilities: { head: 50, chest: 50 } });
  close(result.btk, 2.875);
  close(result.ttk, 232.5);
  close(result.distribution.reduce((sum, item) => sum + item.probability * item.ttk, 0), result.ttk);
  assert.notEqual(result.ttk, (result.btk - 1) * 100 + 20);
});

test('probabilities accept fractions or percentage weights and normalise them', () => {
  const w = weapon();
  close(calculate(w, { probabilities: { head: 20, chest: 80 } }).ttk, calculate(w, { probabilities: { head: 0.2, chest: 0.8 } }).ttk);
  close(calculate(w, { probabilities: { head: 2, chest: 8 } }).ttk, calculate(w, { probabilities: { head: 20, chest: 80 } }).ttk);
});

test('same-damage parts collapse without changing expected result', () => {
  const result = calculate(weapon(), { probabilities: { chest: 20, abdomen: 30, upperArm: 50 } });
  assert.equal(result.btk, 4);
  assert.equal(result.ttk, 320);
  assert.equal(result.distributionTailProbability, 0);
});

test('several distinct positive outcomes do not invent zero-damage probability through summation noise', () => {
  const w = weapon();
  const result = calculate(w, { probabilities: { head: 10, neck: 10, chest: 10, abdomen: 10, upperArm: 10, forearm: 10, thigh: 10, calf: 30 } });
  assert.equal(result.distributionTailProbability, 0);
  assert.equal(result.distributionTruncated, false);
  close(result.distribution.reduce((sum, item) => sum + item.probability, 0), 1);
});

test('zero-damage fixed part and all-zero mixture are explicitly impossible', () => {
  const w = weapon();
  w.multipliers.head = 0;
  const fixed = calculate(w, { part: 'head' });
  assert.equal(fixed.ttk, Infinity);
  assert.equal(fixed.impossible, true);
  const mixed = calculate(w, { probabilities: { head: 100 } });
  assert.equal(mixed.btk, Infinity);
  assert.equal(mixed.impossible, true);
});

test('zero-damage hits use exact geometric expectation and expose infinite distribution tail', () => {
  const w = weapon({ ranges: [{ until: null, damage: 100 }] });
  w.multipliers.head = 0;
  const result = calculate(w, { probabilities: { head: 50, chest: 50 } });
  assert.equal(result.btk, 2);
  close(result.ttk, 120);
  assert.equal(result.distributionTruncated, true);
  assert.ok(result.distributionTailProbability > 0);
  assert.ok(result.distributionTailProbability <= 1e-12);
  close(result.distribution.reduce((sum, item) => sum + item.probability, 0) + result.distributionTailProbability, 1);
});

test('geometric mixture integrates burst phase exactly rather than approximating with mean shots', () => {
  const w = weapon({ ranges: [{ until: null, damage: 100 }], modes: [{ id: 'burst', name: '三连发', type: 'burst', rpm: 600, burstSize: 3, gapMs: 300 }] });
  w.multipliers.head = 0;
  const result = calculate(w, { probabilities: { head: 50, chest: 50 } });
  close(result.btk, 2);
  // E[N−1]=1; E[floor((N−1)/3)] = 0.5^3 / (1−0.5^3) = 1/7.
  close(result.ttk, 20 + 100 + 200 / 7);
  close(result.distribution.reduce((sum, item) => sum + item.probability * item.ttk, 0), result.ttk, 1e-7);
});

test('distribution cap preserves exact expectation and explicitly reports omitted probability', () => {
  const w = weapon({ ranges: [{ until: null, damage: 100 }] });
  w.multipliers.head = 0;
  const result = calculate(w, { probabilities: { head: 50, chest: 50 }, limits: { maxDistributionShots: 2 } });
  assert.equal(result.btk, 2);
  assert.equal(result.ttk, 120);
  assert.equal(result.distributionTailProbability, 0.25);
  assert.equal(result.distributionTruncated, true);
});

test('state guard reports complex data rather than returning a guessed answer', () => {
  const w = weapon({ ranges: [{ until: null, damage: 1 }] });
  assert.throws(() => calculate(w, { probabilities: { chest: 100 }, limits: { maxStates: 2 } }), /计算过于复杂/);
  assert.throws(() => calculate(w, { probabilities: { head: 50, chest: 50 }, limits: { maxTransitions: 1 } }), /状态转移/);
});

test('valid database round-trips through JSON and may intentionally be empty', () => {
  assert.deepEqual(validateDatabase(JSON.parse(JSON.stringify(database()))), { valid: true, errors: [] });
  assert.equal(validateDatabase(database([])).valid, true);
});

test('database validation catches duplicate IDs, unsupported versions and malformed dates', () => {
  assert.match(validateDatabase(database([weapon(), weapon()])).errors.join(' '), /ID.*重复/);
  assert.equal(validateDatabase({ ...database(), schemaVersion: 2 }).valid, false);
  assert.equal(validateDatabase({ ...database(), updatedAt: 'invalid' }).valid, false);
  assert.equal(validateDatabase(null).valid, false);
});

test('weapon validation rejects broken ranges and incomplete multiplier tables', () => {
  const w = weapon({ ranges: [{ until: 20, damage: 30 }, { until: 10, damage: 20 }, { until: null, damage: 15 }] });
  assert.match(validateWeapon(w).join(' '), /射程终点/);
  const missing = weapon();
  delete missing.multipliers.neck;
  assert.match(validateWeapon(missing).join(' '), /颈部/);
  assert.match(validateWeapon(weapon({ ranges: [{ until: 20, damage: 30 }] })).join(' '), /null/);
});

test('mode validation rejects unsupported timing and duplicate mode IDs', () => {
  const w = weapon({ modes: [{ id: 'x', name: '点射', type: 'burst', rpm: 600, burstSize: 0, gapMs: -1 }, { id: 'x', name: '栓动', type: 'bolt', cycleMs: 0 }] });
  const errors = validateWeapon(w).join(' ');
  assert.match(errors, /每组发数/);
  assert.match(errors, /组间间隔/);
  assert.match(errors, /ID 重复/);
  assert.match(errors, /周期/);
});

test('calculation rejects invalid targets, modes, probabilities and performance limits', () => {
  const w = weapon();
  assert.throws(() => calculate(w, { health: 0 }), /血量/);
  assert.throws(() => calculate(w, { distance: NaN }), /距离/);
  assert.throws(() => calculate(w, { modeId: 'missing' }), /模式/);
  assert.throws(() => calculate(w, { probabilities: { chest: 0 } }), /概率/);
  assert.throws(() => calculate(w, { probabilities: { chest: -1 } }), /概率/);
  assert.throws(() => calculate(w, { probabilities: { unknown: 1 } }), /未知/);
  assert.throws(() => calculate(w, { probabilities: { chest: 1 }, limits: { maxStates: 0 } }), /计算限制/);
});

test('results are independent of mutation of a previously returned distribution', () => {
  const w = weapon();
  const first = calculate(w, { probabilities: { head: 50, chest: 50 } });
  first.distribution[0].probability = 0;
  const second = calculate(w, { probabilities: { head: 50, chest: 50 } });
  assert.notEqual(second.distribution[0].probability, 0);
});

test('every demo weapon, firing mode, range and target has consistent fixed and mixed results', () => {
  assert.equal(validateDatabase(DEMO_DATABASE).valid, true);
  const probabilities = { head: 10, neck: 5, chest: 45, abdomen: 20, upperArm: 10, forearm: 5, thigh: 3, calf: 2 };
  let calculations = 0;
  for (const w of DEMO_DATABASE.weapons) for (const mode of w.modes) for (let rangeIndex = 0; rangeIndex < w.ranges.length; rangeIndex++) for (const health of [100, 150, 300]) {
    const distance = rangeIndex ? w.ranges[rangeIndex - 1].until : 0;
    const options = { distance, health, modeId: mode.id, includeTravel: true };
    for (const part of BODY_PARTS) {
      const result = calculate(w, { ...options, part: part.id });
      assert.equal(result.rangeIndex, rangeIndex);
      assert.ok(Number.isInteger(result.btk) && result.btk >= 1, `${w.name} ${part.id} ${distance}m ${health}HP`);
      assert.ok(Number.isFinite(result.ttk) && result.ttk >= 0);
      assert.equal(result.distribution.length, 1);
      assert.equal(result.distribution[0].probability, 1);
      assert.equal(result.distribution[0].ttk, result.ttk);
      calculations++;
    }
    const mixed = calculate(w, { ...options, probabilities });
    assert.equal(mixed.rangeIndex, rangeIndex);
    assert.ok(Number.isFinite(mixed.btk) && mixed.btk >= 1);
    assert.ok(Number.isFinite(mixed.ttk) && mixed.ttk >= 0);
    assert.equal(mixed.distributionTruncated, false);
    close(mixed.distribution.reduce((sum, entry) => sum + entry.probability, 0), 1);
    close(mixed.distribution.reduce((sum, entry) => sum + entry.shots * entry.probability, 0), mixed.btk);
    close(mixed.distribution.reduce((sum, entry) => sum + entry.ttk * entry.probability, 0), mixed.ttk, 1e-6);
    calculations++;
  }
  assert.ok(calculations > 0);
});
