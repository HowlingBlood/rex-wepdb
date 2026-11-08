import { BODY_PARTS, deriveDamage, normalizeDatabase, rangeAt, validateDatabase } from './engine.js?v=1.2.1';

const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonempty = value => typeof value === 'string' && value.trim().length > 0;
const fail = message => { throw new Error(message); };
const modeNames = { auto: '全自动', semi: '半自动', bolt: '栓动 / 泵动', burst: '点射' };

/** A catalog path is a JSON file beneath weapon_db, never a remote URL. */
export function isDatabasePath(path) {
  if (!nonempty(path) || path !== path.trim() || /[\\?#\u0000-\u001f\u007f]/.test(path)) return false;
  if (path.startsWith('/') || /^[a-z][a-z\d+.-]*:/i.test(path)) return false;
  let decoded = path;
  try {
    // Reject traversal even when a manually edited path contains URL escapes.
    for (let pass = 0; pass < 4; pass++) {
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      decoded = next;
    }
  } catch { return false; }
  if (/[\\?#\u0000-\u001f\u007f]/.test(decoded) || decoded.startsWith('/') || decoded.includes('%')) return false;
  if (/^[a-z][a-z\d+.-]*:/i.test(decoded) || decoded.split('/').some(segment => segment === '.' || segment === '..' || segment === '')) return false;
  return /\.json$/i.test(decoded);
}

function validDate(value) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) return false;
  return !/^\d{4}-\d{2}-\d{2}$/.test(value) || new Date(value).toISOString().slice(0, 10) === value;
}

/** Chronological order, then natural revision IDs such as r1, r2 and r10. */
export function sortVersions(versions) {
  if (!Array.isArray(versions) || versions.some(version => !isRecord(version) || !nonempty(version.id) || !validDate(version.effectiveAt))) fail('历史版本需要有效的 ID 和生效日期。');
  return [...versions].sort((a, b) => Date.parse(a.effectiveAt) - Date.parse(b.effectiveAt) || a.id.localeCompare(b.id, undefined, { numeric: true }));
}

/** Validate only the manifest contract; unknown descriptive metadata is retained. */
export function validateCatalog(catalog) {
  const errors = [];
  if (!isRecord(catalog)) return { valid: false, errors: ['模式清单必须是一个 JSON 对象。'] };
  if (catalog.schemaVersion !== 1) errors.push('模式清单 schemaVersion 必须为 1。');
  if (!nonempty(catalog.defaultMode)) errors.push('模式清单需要 defaultMode。');
  if (!Array.isArray(catalog.modes) || catalog.modes.length === 0) {
    errors.push('模式清单至少需要一个模式。');
    return { valid: false, errors };
  }
  const modeIds = new Set();
  catalog.modes.forEach((mode, modeIndex) => {
    const prefix = `模式 ${modeIndex + 1}：`;
    if (!isRecord(mode)) { errors.push(`${prefix}必须是一个对象。`); return; }
    if (!nonempty(mode.id) || !/^[a-z][a-z\d-]*$/.test(mode.id)) errors.push(`${prefix}ID 需要使用小写英文字母、数字或连字符。`);
    else if (modeIds.has(mode.id)) errors.push(`${prefix}模式 ID「${mode.id}」重复。`);
    modeIds.add(mode.id);
    if (!nonempty(mode.label)) errors.push(`${prefix}显示名称不能为空。`);
    if (mode.description !== undefined && typeof mode.description !== 'string') errors.push(`${prefix}description 必须是文字。`);
    if (typeof mode.available !== 'boolean') errors.push(`${prefix}available 必须为 true 或 false。`);
    if (!isDatabasePath(mode.latest)) errors.push(`${prefix}latest 必须是 weapon_db 内的相对 JSON 文件路径。`);
    if (mode.currentVersion !== null && !nonempty(mode.currentVersion)) errors.push(`${prefix}currentVersion 必须为版本 ID 或 null。`);
    if (!Array.isArray(mode.versions)) { errors.push(`${prefix}versions 必须是历史版本数组。`); return; }
    const versionIds = new Set();
    const versionFiles = new Set();
    mode.versions.forEach((version, versionIndex) => {
      const versionPrefix = `${prefix}版本 ${versionIndex + 1}：`;
      if (!isRecord(version)) { errors.push(`${versionPrefix}必须是一个对象。`); return; }
      if (!nonempty(version.id)) errors.push(`${versionPrefix}ID 不能为空。`);
      else if (versionIds.has(version.id)) errors.push(`${versionPrefix}版本 ID「${version.id}」重复。`);
      versionIds.add(version.id);
      if (!nonempty(version.label)) errors.push(`${versionPrefix}显示名称不能为空。`);
      if (!validDate(version.effectiveAt)) errors.push(`${versionPrefix}effectiveAt 必须是有效日期。`);
      if (!isDatabasePath(version.file)) errors.push(`${versionPrefix}file 必须是 weapon_db 内的相对 JSON 文件路径。`);
      else if (version.file === mode.latest) errors.push(`${versionPrefix}历史快照必须使用独立文件，不能直接指向 latest 文件。`);
      else if (versionFiles.has(version.file)) errors.push(`${versionPrefix}历史文件路径重复。`);
      versionFiles.add(version.file);
      if (version.notes !== undefined && typeof version.notes !== 'string') errors.push(`${versionPrefix}notes 必须是文字。`);
    });
    if (nonempty(mode.currentVersion) && !versionIds.has(mode.currentVersion)) errors.push(`${prefix}currentVersion 没有对应的历史版本。`);
    if (mode.available && (!nonempty(mode.currentVersion) || mode.versions.length === 0)) errors.push(`${prefix}已开放的模式必须登记当前历史版本。`);
  });
  if (nonempty(catalog.defaultMode) && !modeIds.has(catalog.defaultMode)) errors.push('defaultMode 没有对应的模式。');
  return { valid: errors.length === 0, errors };
}

function resolveDatabaseUrl(baseUrl, path) {
  if (!isDatabasePath(path)) fail('数据库路径无效；只能读取 weapon_db 内的相对 JSON 文件。');
  let base;
  try { base = new URL(baseUrl); } catch { fail('数据库目录地址无效。'); }
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) fail('数据库目录必须是有效的 HTTP 或 HTTPS 地址。');
  if (!base.pathname.endsWith('/')) base.pathname += '/';
  const url = new URL(path, base);
  if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname)) fail('数据库路径超出了 weapon_db 目录。');
  return url;
}

async function readJson(baseUrl, path, { revision, fetchImpl = globalThis.fetch, signal } = {}) {
  const url = resolveDatabaseUrl(baseUrl, path);
  if (revision !== undefined && revision !== null) url.searchParams.set('v', String(revision));
  if (typeof fetchImpl !== 'function') fail('当前环境不支持读取数据库。请通过网页服务器访问。');
  let response;
  try { response = await fetchImpl(url.href, { cache: 'no-store', signal, credentials: 'same-origin', redirect: 'error' }); }
  catch (error) {
    if (signal?.aborted || error?.name === 'AbortError') throw error;
    throw new Error(`无法读取 ${path}。请检查网络连接和数据库文件是否已发布。`, { cause: error });
  }
  if (!response?.ok) fail(`无法读取 ${path}（HTTP ${response?.status ?? '未知'}）。请检查文件路径及部署结果。`);
  try { return await response.json(); }
  catch (error) {
    if (signal?.aborted || error?.name === 'AbortError') throw error;
    throw new Error(`${path} 不是有效的 JSON 文件。`, { cause: error });
  }
}

export async function loadCatalog(baseUrl, options = {}) {
  const catalog = await readJson(baseUrl, 'index.json', options);
  const report = validateCatalog(catalog);
  if (!report.valid) fail(`模式清单未通过校验：${report.errors.join('；')}`);
  return structuredClone(catalog);
}

export async function loadDatabase(baseUrl, path, options = {}) {
  const database = await readJson(baseUrl, path, options);
  const report = validateDatabase(database);
  if (!report.valid) fail(`数据库未通过校验（${path}）：${report.errors.slice(0, 8).join('；')}`);
  return normalizeDatabase(database);
}

function canonicalDatabase(value, label) {
  const report = validateDatabase(value);
  if (!report.valid) fail(`${label}数据库未通过校验：${report.errors.slice(0, 8).join('；')}`);
  return normalizeDatabase(value);
}

const valueOrNull = value => value === undefined ? null : value;
const textOrEmpty = value => typeof value === 'string' ? value : '';
function directionFor(before, after, higherIsBetter = true) {
  if (typeof before !== 'number' || typeof after !== 'number' || before === after) return 'neutral';
  return (after > before) === higherIsBetter ? 'buff' : 'nerf';
}
function aggregateDirections(directions) {
  const distinct = new Set(directions.filter(direction => direction !== 'neutral'));
  return distinct.size > 1 ? 'mixed' : distinct.values().next().value || 'neutral';
}
function rangeSummary(ranges) {
  let start = 0;
  return ranges.map(range => {
    const summary = `${start}–${range.until === null ? '∞' : range.until} m：${range.damage}`;
    start = range.until;
    return summary;
  }).join(' / ');
}
function sameRangeLayout(before, after) {
  return before.length === after.length && before.every((range, i) => range.until === after[i].until && range.damage === after[i].damage);
}
function actualParts(weapon, baseDamage) {
  return Object.fromEntries(BODY_PARTS.map(part => [part.id, deriveDamage(baseDamage, weapon.multipliers[part.id])]));
}
function partsEqual(before, after) { return BODY_PARTS.every(part => before[part.id] === after[part.id]); }

/** Compare effective damage across the union of both range breakpoint sets. */
function compareRanges(before, after) {
  const starts = [...new Set([0, ...before.ranges, ...after.ranges].map(item => typeof item === 'number' ? item : item.until).filter(value => value !== null))].sort((a, b) => a - b);
  const changed = [];
  const baseDirections = [];
  for (let i = 0; i < starts.length; i++) {
    const from = starts[i], to = starts[i + 1] ?? null;
    const beforeDamage = rangeAt(before, from).range.damage;
    const afterDamage = rangeAt(after, from).range.damage;
    const beforeParts = actualParts(before, beforeDamage), afterParts = actualParts(after, afterDamage);
    baseDirections.push(directionFor(beforeDamage, afterDamage));
    if (beforeDamage === afterDamage && partsEqual(beforeParts, afterParts)) continue;
    const direction = aggregateDirections(BODY_PARTS.map(part => directionFor(beforeParts[part.id], afterParts[part.id])));
    const entry = { from, to, beforeDamage, afterDamage, beforeParts, afterParts, direction };
    const previous = changed.at(-1);
    if (previous && previous.to === from && previous.beforeDamage === beforeDamage && previous.afterDamage === afterDamage && partsEqual(previous.beforeParts, beforeParts) && partsEqual(previous.afterParts, afterParts)) previous.to = to;
    else changed.push(entry);
  }
  return { changes: changed, direction: aggregateDirections(baseDirections) };
}

const effectiveModeKeys = mode => mode.type === 'bolt' ? ['cycleMs'] : mode.type === 'burst' ? ['rpm', 'burstSize', 'gapMs'] : ['rpm'];
function modeSummary(mode) {
  if (mode.type === 'bolt') return `${mode.name}（${modeNames[mode.type]}，完整周期 ${mode.cycleMs} ms）`;
  if (mode.type === 'burst') return `${mode.name}（${mode.burstSize} 连发，组内 ${mode.rpm} RPM，组间 ${mode.gapMs} ms）`;
  return `${mode.name}（${modeNames[mode.type]}，${mode.rpm} RPM）`;
}
function compareModes(before, after, fields) {
  const oldModes = new Map(before.modes.map(mode => [mode.id, mode]));
  const newModes = new Map(after.modes.map(mode => [mode.id, mode]));
  const ids = [...new Set([...after.modes.map(mode => mode.id), ...before.modes.map(mode => mode.id)])];
  const labels = { rpm: '射速（RPM）', cycleMs: '完整拉栓间隔（ms）', burstSize: '每组发数', gapMs: '组间间隔（ms）' };
  for (const id of ids) {
    const oldMode = oldModes.get(id), newMode = newModes.get(id), prefix = `modes.${id}`;
    if (!oldMode || !newMode) {
      fields.push({ key: prefix, label: `${oldMode ? '移除' : '新增'}射击模式`, before: oldMode ? modeSummary(oldMode) : null, after: newMode ? modeSummary(newMode) : null, kind: 'mode', direction: 'neutral' });
      continue;
    }
    const name = newMode.name || oldMode.name;
    if (oldMode.name !== newMode.name) fields.push({ key: `${prefix}.name`, label: '射击模式名称', before: oldMode.name, after: newMode.name, kind: 'text', direction: 'neutral' });
    if (oldMode.type !== newMode.type) fields.push({ key: `${prefix}.type`, label: `${name} · 射击方式`, before: modeNames[oldMode.type], after: modeNames[newMode.type], kind: 'mode', direction: 'neutral' });
    const oldKeys = effectiveModeKeys(oldMode), newKeys = effectiveModeKeys(newMode);
    for (const key of new Set([...newKeys, ...oldKeys])) {
      const oldValue = oldKeys.includes(key) ? oldMode[key] : null;
      const newValue = newKeys.includes(key) ? newMode[key] : null;
      if (oldValue === newValue) continue;
      fields.push({ key: `${prefix}.${key}`, label: `${name} · ${labels[key]}`, before: valueOrNull(oldValue), after: valueOrNull(newValue), kind: 'number', direction: key === 'burstSize' ? 'neutral' : directionFor(oldValue, newValue, key === 'rpm') });
    }
  }
}

function compareWeapon(before, after) {
  const fields = [];
  for (const [key, label] of [['name', '武器名称'], ['category', '武器类别'], ['notes', '备注 / 数据来源']]) {
    if (textOrEmpty(before[key]) !== textOrEmpty(after[key])) fields.push({ key, label, before: textOrEmpty(before[key]), after: textOrEmpty(after[key]), kind: 'text', direction: 'neutral' });
  }
  for (const [key, label, higherIsBetter] of [['velocity', '子弹速度（m/s）', true], ['triggerDelayMs', '首发扳机延迟（ms）', false]]) {
    if (before[key] !== after[key]) fields.push({ key, label, before: before[key], after: after[key], kind: 'number', direction: directionFor(before[key], after[key], higherIsBetter) });
  }
  const ranges = compareRanges(before, after);
  if (!sameRangeLayout(before.ranges, after.ranges)) fields.push({ key: 'ranges', label: '基础伤害 / 射程分段', before: rangeSummary(before.ranges), after: rangeSummary(after.ranges), kind: 'range', direction: ranges.direction });
  for (const part of BODY_PARTS) {
    if (before.multipliers[part.id] !== after.multipliers[part.id]) fields.push({ key: `multipliers.${part.id}`, label: `${part.label}全程倍率`, before: before.multipliers[part.id], after: after.multipliers[part.id], kind: 'number', direction: directionFor(before.multipliers[part.id], after.multipliers[part.id]) });
  }
  compareModes(before, after, fields);
  return { fields, rangeChanges: ranges.changes };
}

/** Stable IDs determine identity. Array ordering and database metadata do not. */
export function diffDatabases(beforeDatabase, afterDatabase) {
  const before = canonicalDatabase(beforeDatabase, '旧版'), after = canonicalDatabase(afterDatabase, '新版');
  const oldWeapons = new Map(before.weapons.map(weapon => [weapon.id, weapon]));
  const newWeapons = new Map(after.weapons.map(weapon => [weapon.id, weapon]));
  const ids = [...new Set([...after.weapons.map(weapon => weapon.id), ...before.weapons.map(weapon => weapon.id)])];
  const changes = ids.map(id => {
    const oldWeapon = oldWeapons.get(id) ?? null, newWeapon = newWeapons.get(id) ?? null;
    if (!oldWeapon || !newWeapon) return { id, status: oldWeapon ? 'removed' : 'added', before: oldWeapon, after: newWeapon, fields: [], rangeChanges: [] };
    const comparison = compareWeapon(oldWeapon, newWeapon);
    return { id, status: comparison.fields.length ? 'changed' : 'unchanged', before: oldWeapon, after: newWeapon, ...comparison };
  });
  const counts = { added: 0, removed: 0, changed: 0, unchanged: 0, total: changes.length };
  changes.forEach(change => counts[change.status]++);
  return { changes, counts };
}
