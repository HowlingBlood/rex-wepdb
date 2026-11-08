import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { diffDatabases, isDatabasePath, loadCatalog, loadDatabase, sortVersions, validateCatalog } from '../visitor/data-core.js';
import { normalizeDatabase, validateDatabase } from '../visitor/engine.js';

const weapon = (patch = {}) => ({
  id: 'stable-weapon', name: '验证步枪', category: '步枪', notes: '', velocity: 700, triggerDelayMs: 20,
  ranges: [{ until: 20, damage: 30 }, { until: 40, damage: 24 }, { until: null, damage: 20 }],
  multipliers: { head: 1.5, neck: 1.1, chest: 1, abdomen: 1, upperArm: 1, forearm: .9, thigh: .9, calf: .9 },
  modes: [{ id: 'auto', name: '全自动', type: 'auto', rpm: 600, cycleMs: 1000, burstSize: 3, gapMs: 200 }],
  ...patch,
});
const database = (weapons = [weapon()], patch = {}) => ({ schemaVersion: 1, name: '验证库', updatedAt: '2026-11-08T00:00:00Z', weapons, ...patch });
const catalog = () => ({
  schemaVersion: 1, defaultMode: 'wz', description: '静态数据清单',
  modes: [
    { id: 'mp', label: '多人模式', latest: 'latest-mp.json', currentVersion: null, versions: [], available: false },
    { id: 'wz', label: '战争地带', latest: 'latest-wz.json', currentVersion: 'wz-v2', available: true, versions: [
      { id: 'wz-v1', label: '第一版', effectiveAt: '2026-11-07', file: 'history/wz/v1.json' },
      { id: 'wz-v2', label: '第二版', effectiveAt: '2026-11-08', file: 'history/wz/v2.json', notes: '验证变更' },
    ] },
  ],
});
const response = json => ({ ok: true, status: 200, json: async () => structuredClone(json) });

test('version revisions use natural ordering and leave the manual catalog order intact', () => {
  const versions = ['r10', 'r2', 'r1'].map(id => ({ id, effectiveAt: '2026-11-08' }));
  const result = sortVersions(versions);
  assert.deepEqual(result.map(version => version.id), ['r1', 'r2', 'r10']);
  assert.deepEqual(versions.map(version => version.id), ['r10', 'r2', 'r1']);
  assert.notEqual(result, versions);
});

test('version dates compare actual instants rather than ISO string spelling or timezone', () => {
  const versions = [
    { id: 'r10', effectiveAt: '2026-11-08T10:00:00+08:00' },
    { id: 'later', effectiveAt: '2026-11-08T03:00:00Z' },
    { id: 'r2', effectiveAt: '2026-11-08T02:00:00Z' },
    { id: 'earlier', effectiveAt: '2026-11-07T18:00:00-07:00' },
  ];
  assert.deepEqual(sortVersions(versions).map(version => version.id), ['earlier', 'r2', 'r10', 'later']);
  assert.deepEqual(sortVersions([]), []);
  assert.throws(() => sortVersions([{ id: 'bad', effectiveAt: '2026-02-30' }]), /生效日期/);
});

test('catalog supports an available mode and an explicitly unavailable mode', () => {
  const c = catalog();
  assert.deepEqual(validateCatalog(c), { valid: true, errors: [] });
  assert.equal(c.modes[0].currentVersion, null);
});

test('catalog rejects duplicate identities, unresolved current versions and malformed dates', () => {
  const c = catalog();
  c.modes.push(structuredClone(c.modes[1]));
  c.modes[1].versions[1].id = 'wz-v1';
  c.modes[1].versions[1].effectiveAt = '2026-02-30';
  const report = validateCatalog(c);
  assert.equal(report.valid, false);
  assert.ok(report.errors.some(e => e.includes('模式 ID')));
  assert.ok(report.errors.some(e => e.includes('版本 ID')));
  assert.ok(report.errors.some(e => e.includes('currentVersion')));
  assert.ok(report.errors.some(e => e.includes('effectiveAt')));
});

test('catalog requires a registered current snapshot for an available mode', () => {
  const c = catalog();
  c.modes[0].available = true;
  assert.ok(validateCatalog(c).errors.some(e => e.includes('已开放')));
  c.defaultMode = 'missing';
  assert.ok(validateCatalog(c).errors.some(e => e.includes('defaultMode')));
  assert.equal(validateCatalog({ schemaVersion: 1, defaultMode: 'wz', modes: [] }).valid, false);
});

test('a historical snapshot cannot alias the mutable latest file', () => {
  const c = catalog(); c.modes[1].versions[1].file = c.modes[1].latest;
  assert.ok(validateCatalog(c).errors.some(e => e.includes('独立文件')));
});

test('JSON paths stay relative and reject encoded as well as literal directory traversal', () => {
  for (const path of ['latest-wz.json', 'history/wz/2026-11-08-r1.json', 'history/测试版.json']) assert.equal(isDatabasePath(path), true, path);
  for (const path of ['../data.json', '/data.json', '//example.com/a.json', 'https://example.com/a.json', 'history/../a.json', 'history/./a.json', '..\\a.json', '%2e%2e/a.json', 'history/%2e%2e/a.json', '%252e%252e/a.json', 'x%2f..%2fy.json', 'a.json?token=x', 'a.json#part', 'a.json%00', 'a.txt', '', ' latest.json', 'history//a.json']) {
    assert.equal(isDatabasePath(path), false, path);
  }
  const c = catalog();
  c.modes[1].latest = 'https://example.com/a.json';
  c.modes[1].versions[0].file = '../v1.json';
  assert.equal(validateCatalog(c).valid, false);
});

test('catalog loader honours a project subpath and requests a fresh manifest', async () => {
  const original = catalog(); let requested;
  const result = await loadCatalog('https://owner.github.io/repository/weapon_db/', { fetchImpl: async (url, options) => { requested = { url, options }; return response(original); } });
  assert.equal(requested.url, 'https://owner.github.io/repository/weapon_db/index.json');
  assert.equal(requested.options.cache, 'no-store');
  assert.equal(requested.options.redirect, 'error');
  assert.equal(requested.options.credentials, 'same-origin');
  result.modes[1].label = '已修改返回值';
  assert.equal(original.modes[1].label, '战争地带');
});

test('database loader normalises old decimals without mutating input or losing metadata', async () => {
  const w = weapon(); w.ranges[0].damage = 30.4; w.multipliers.head = 1.333333333333;
  const original = database([w], { source: { label: '手工记录' }, dataVersion: 'wz-v2' });
  let requested;
  const result = await loadDatabase('https://owner.github.io/repo/weapon_db', 'latest-wz.json', { revision: 'wz-v2 / corrected', fetchImpl: async (url, options) => { requested = { url, options }; return response(original); } });
  assert.equal(new URL(requested.url).pathname, '/repo/weapon_db/latest-wz.json');
  assert.equal(new URL(requested.url).searchParams.get('v'), 'wz-v2 / corrected');
  assert.equal(result.weapons[0].ranges[0].damage, 30);
  assert.equal(result.weapons[0].multipliers.head, 1.3);
  assert.deepEqual(result.source, { label: '手工记录' });
  assert.equal(original.weapons[0].multipliers.head, 1.333333333333);
});

test('loader failures are explicit and never substitute a demo or another mode', async () => {
  await assert.rejects(loadCatalog('https://example.com/weapon_db/', { fetchImpl: async () => ({ ok: false, status: 404 }) }), /index\.json.*HTTP 404/);
  await assert.rejects(loadDatabase('https://example.com/weapon_db/', 'latest-wz.json', { fetchImpl: async () => { throw new Error('offline'); } }), /无法读取 latest-wz\.json/);
  await assert.rejects(loadDatabase('https://example.com/weapon_db/', 'latest-wz.json', { fetchImpl: async () => ({ ok: true, json: async () => { throw new SyntaxError('bad'); } }) }), /不是有效的 JSON/);
  await assert.rejects(loadDatabase('https://example.com/weapon_db/', 'latest-wz.json', { fetchImpl: async () => response(database([{ name: 'incomplete' }])) }), /数据库未通过校验/);
  await assert.rejects(loadCatalog('https://example.com/weapon_db/', { fetchImpl: async () => response({ schemaVersion: 99, modes: [] }) }), /模式清单未通过校验/);
});

test('invalid paths are rejected before fetch and AbortError remains recognisable', async () => {
  let called = false;
  await assert.rejects(loadDatabase('https://example.com/weapon_db/', '../secret.json', { fetchImpl: async () => { called = true; return response(database()); } }), /路径无效/);
  await assert.rejects(loadCatalog('file:///tmp/weapon_db/', { fetchImpl: async () => { called = true; return response(catalog()); } }), /HTTP/);
  assert.equal(called, false);
  const aborted = new Error('aborted'); aborted.name = 'AbortError';
  await assert.rejects(loadDatabase('https://example.com/weapon_db/', 'latest-wz.json', { fetchImpl: async () => { throw aborted; } }), error => error === aborted);
});

test('history matches stable IDs through rename, addition and removal', () => {
  const previous = database([weapon(), weapon({ id: 'removed', name: '退役武器' })]);
  const current = database([weapon({ name: '新名称' }), weapon({ id: 'added', name: '新增武器' })]);
  const result = diffDatabases(previous, current);
  assert.deepEqual(result.counts, { added: 1, removed: 1, changed: 1, unchanged: 0, total: 3 });
  assert.deepEqual(result.changes.map(item => [item.id, item.status]), [['stable-weapon', 'changed'], ['added', 'added'], ['removed', 'removed']]);
  assert.equal(result.changes[0].fields[0].key, 'name');
  assert.equal(result.changes[0].before.name, '验证步枪');
  assert.equal(result.changes[0].after.name, '新名称');
  assert.equal(result.changes[1].before, null);
  assert.equal(result.changes[2].after, null);
});

test('database timestamp, database name, weapon ordering and extra metadata do not create changes', () => {
  const a = weapon(), b = weapon({ id: 'second' });
  const before = database([a, b]);
  const after = database([structuredClone(b), structuredClone(a)], { updatedAt: '2026-11-09T00:00:00Z', name: '重新导出的库', metadata: { revision: 9 } });
  assert.deepEqual(diffDatabases(before, after).counts, { added: 0, removed: 0, changed: 0, unchanged: 2, total: 2 });
});

test('mode ordering and inactive stale parameters do not create a balance change', () => {
  const auto = weapon().modes[0];
  const bolt = { id: 'bolt', name: '栓动', type: 'bolt', cycleMs: 1000, rpm: 600 };
  const before = weapon({ modes: [auto, bolt] });
  const after = structuredClone(before); after.modes.reverse(); after.modes[0].rpm = 100; after.modes[1].cycleMs = 4000; after.modes[1].gapMs = 900;
  assert.equal(diffDatabases(database([before]), database([after])).changes[0].status, 'unchanged');
});

test('effective mode timing, mode additions and removals are matched by mode ID', () => {
  const before = weapon({ modes: [{ id: 'burst', name: '三连发', type: 'burst', rpm: 900, burstSize: 3, gapMs: 300 }, { id: 'retired', name: '半自动', type: 'semi', rpm: 300 }] });
  const after = weapon({ modes: [{ id: 'burst', name: '三连发', type: 'burst', rpm: 1000, burstSize: 3, gapMs: 200 }, { id: 'added', name: '全自动', type: 'auto', rpm: 700 }] });
  const fields = diffDatabases(database([before]), database([after])).changes[0].fields;
  assert.equal(fields.find(field => field.key === 'modes.burst.rpm').direction, 'buff');
  assert.equal(fields.find(field => field.key === 'modes.burst.gapMs').direction, 'buff');
  assert.equal(fields.find(field => field.key === 'modes.added').before, null);
  assert.equal(fields.find(field => field.key === 'modes.retired').after, null);
});

test('changing fire type compares only old and new effective timing fields', () => {
  const before = weapon();
  const after = weapon({ modes: [{ id: 'auto', name: '泵动', type: 'bolt', cycleMs: 750, rpm: 600 }] });
  const fields = diffDatabases(database([before]), database([after])).changes[0].fields;
  assert.equal(fields.find(field => field.key === 'modes.auto.rpm').after, null);
  assert.equal(fields.find(field => field.key === 'modes.auto.cycleMs').before, null);
  assert.ok(fields.some(field => field.key === 'modes.auto.type'));
});

test('range damage compares the breakpoint union, not array indexes', () => {
  const before = weapon();
  const after = weapon({ ranges: [{ until: 25, damage: 30 }, { until: 40, damage: 24 }, { until: null, damage: 20 }] });
  const change = diffDatabases(database([before]), database([after])).changes[0];
  assert.deepEqual(change.rangeChanges.map(({ from, to, beforeDamage, afterDamage }) => ({ from, to, beforeDamage, afterDamage })), [{ from: 20, to: 25, beforeDamage: 24, afterDamage: 30 }]);
  assert.equal(change.rangeChanges[0].beforeParts.head, 36);
  assert.equal(change.rangeChanges[0].afterParts.head, 45);
  assert.equal(change.fields.find(field => field.key === 'ranges').direction, 'buff');
});

test('the final infinite interval is compared and adjacent identical changes are merged', () => {
  const before = weapon({ ranges: [{ until: 20, damage: 30 }, { until: 40, damage: 30 }, { until: null, damage: 20 }] });
  const after = weapon({ ranges: [{ until: 10, damage: 25 }, { until: 40, damage: 25 }, { until: null, damage: 18 }] });
  const ranges = diffDatabases(database([before]), database([after])).changes[0].rangeChanges;
  assert.deepEqual(ranges.map(range => [range.from, range.to]), [[0, 40], [40, null]]);
  assert.ok(ranges.every(range => range.direction === 'nerf'));
});

test('a redundant breakpoint is a recorded range change without a false damage buff', () => {
  const before = weapon({ ranges: [{ until: null, damage: 30 }] });
  const after = weapon({ ranges: [{ until: 20, damage: 30 }, { until: null, damage: 30 }] });
  const change = diffDatabases(database([before]), database([after])).changes[0];
  assert.equal(change.status, 'changed');
  assert.deepEqual(change.rangeChanges, []);
  assert.equal(change.fields[0].direction, 'neutral');
});

test('global multipliers derive integer part changes on every affected interval', () => {
  const before = weapon(), after = structuredClone(before); after.multipliers.head = 1.4;
  const change = diffDatabases(database([before]), database([after])).changes[0];
  assert.equal(change.fields.find(field => field.key === 'multipliers.head').direction, 'nerf');
  assert.equal(change.rangeChanges.length, 3);
  assert.deepEqual(change.rangeChanges.map(range => [range.beforeParts.head, range.afterParts.head]), [[45, 42], [36, 34], [30, 28]]);
  assert.ok(change.rangeChanges.every(range => range.beforeParts.chest === range.afterParts.chest));
});

test('legacy precision differences disappear under the shared calculation rules', () => {
  const before = weapon(), after = structuredClone(before);
  before.multipliers.head = 1.333333333333;
  before.ranges[0].damage = 30.4;
  after.multipliers.head = 1.3;
  const snapshot = structuredClone(before);
  const result = diffDatabases(database([before]), database([after]));
  assert.equal(result.changes[0].status, 'unchanged');
  assert.deepEqual(before, snapshot);
  assert.equal(result.changes[0].before.multipliers.head, 1.3);
});

test('beneficial direction respects delay versus speed and mixed range effects', () => {
  const before = weapon(), after = structuredClone(before);
  after.velocity = 800; after.triggerDelayMs = 30;
  after.ranges = [{ until: 20, damage: 31 }, { until: 40, damage: 23 }, { until: null, damage: 20 }];
  const fields = diffDatabases(database([before]), database([after])).changes[0].fields;
  assert.equal(fields.find(field => field.key === 'velocity').direction, 'buff');
  assert.equal(fields.find(field => field.key === 'triggerDelayMs').direction, 'nerf');
  assert.equal(fields.find(field => field.key === 'ranges').direction, 'mixed');
});

test('history rejects duplicate weapon or mode IDs instead of silently matching the wrong item', () => {
  assert.throws(() => diffDatabases(database([weapon(), weapon()]), database()), /武器 ID.*重复/);
  const w = weapon(); w.modes.push(structuredClone(w.modes[0]));
  assert.throws(() => diffDatabases(database(), database([w])), /模式 ID 重复/);
});

test('the real visitor catalog and all registered databases satisfy the shared contract', async () => {
  const base = new URL('../weapon_db/', import.meta.url);
  const read = async path => JSON.parse((await readFile(new URL(path, base), 'utf8')).replace(/^\uFEFF/, ''));
  const manifest = await read('index.json');
  const report = validateCatalog(manifest);
  assert.equal(report.valid, true, report.errors.join('\n'));
  const files = new Map();
  for (const mode of manifest.modes) {
    for (const path of [mode.latest, ...mode.versions.map(version => version.file)]) {
      if (files.has(path)) continue;
      const value = await read(path), validation = validateDatabase(value);
      assert.equal(validation.valid, true, `${path}: ${validation.errors.join('\n')}`);
      const comparison = diffDatabases(value, normalizeDatabase(value));
      assert.equal(comparison.counts.unchanged, value.weapons.length, `${path} 自身规范化不应产生历史变动`);
      assert.equal(comparison.counts.changed + comparison.counts.added + comparison.counts.removed, 0, path);
      files.set(path, value);
    }
    if (mode.available) {
      const current = mode.versions.find(version => version.id === mode.currentVersion);
      assert.deepEqual(normalizeDatabase(files.get(mode.latest)), normalizeDatabase(files.get(current.file)), `${mode.id}: latest 必须与登记的当前历史快照一致`);
    }
  }
});
