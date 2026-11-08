/**
 * Weapon Lab calculation model. Times are milliseconds; distances metres.
 * Each range stores base damage, while body multipliers apply at every range.
 * Base damage and final body damage are rounded to integers. Global body
 * multipliers are rounded to two decimals. These canonical values drive all
 * calculations, not merely their display. Decimal half-up rounding uses exact
 * integer arithmetic, avoiding binary floating-point half-boundary errors.
 */
export const BODY_PARTS = Object.freeze([
  { id: 'head', label: '头部' },
  { id: 'neck', label: '颈部' },
  { id: 'chest', label: '胸部' },
  { id: 'abdomen', label: '腹部' },
  { id: 'upperArm', label: '上臂' },
  { id: 'forearm', label: '前臂' },
  { id: 'thigh', label: '大腿' },
  { id: 'calf', label: '小腿' },
].map(Object.freeze));

export const MULTIPLIER_DIGITS = 2;
const MULTIPLIER_SCALE = 10n ** BigInt(MULTIPLIER_DIGITS);

export const DEFAULT_LIMITS = Object.freeze({
  maxStates: 20000,
  maxTransitions: 2000000,
  maxDistributionShots: 1024,
  distributionTolerance: 1e-12,
});

const PART_IDS = BODY_PARTS.map(p => p.id);
const TYPES = new Set(['auto', 'semi', 'bolt', 'burst']);
const mixedCache = new Map();
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const finite = value => typeof value === 'number' && Number.isFinite(value);
const positive = value => finite(value) && value > 0;
const nonnegative = value => finite(value) && value >= 0;
const text = value => typeof value === 'string' && value.trim().length > 0;
const fail = message => { throw new Error(message); };

/** Round a nonnegative finite decimal Number with ties going upward. */
export function roundHalfUp(value, digits = 0) {
  if (!nonnegative(value)) fail('四舍五入的数值必须是非负有限数值。');
  if (!Number.isInteger(digits) || digits < 0 || digits > 12) fail('四舍五入的小数位数必须是 0–12 的整数。');
  const parts = decimalParts(value);
  if (parts.decimals <= digits) return value;
  const divisor = 10n ** BigInt(parts.decimals - digits);
  const rounded = (parts.digits + divisor / 2n) / divisor;
  return Number(`${rounded}e-${digits}`);
}

function roundedBaseDamage(value) {
  if (!positive(value)) fail('基础伤害必须是大于 0 的有限数值。');
  const rounded = roundHalfUp(value);
  if (rounded === 0) fail('基础伤害四舍五入后为 0；请填写四舍五入后至少为 1 的基础伤害。');
  return rounded;
}

/** Derive the actual integer damage used by fixed and mixed calculations. */
export function deriveDamage(baseDamage, multiplier) {
  const base = roundedBaseDamage(baseDamage);
  if (!nonnegative(multiplier)) fail('部位倍率必须是非负有限数值。');
  const canonicalMultiplier = roundHalfUp(multiplier, MULTIPLIER_DIGITS);
  const baseTicks = decimalParts(base).digits;
  const multiplierParts = decimalParts(canonicalMultiplier);
  const multiplierTicks = multiplierParts.digits * 10n ** BigInt(MULTIPLIER_DIGITS - multiplierParts.decimals);
  const result = Number((baseTicks * multiplierTicks + MULTIPLIER_SCALE / 2n) / MULTIPLIER_SCALE);
  if (!nonnegative(result)) fail('部位伤害超出可计算范围。');
  return result;
}

function normalizeDamageFields(weapon) {
  if (!record(weapon)) return weapon;
  if (Array.isArray(weapon.ranges)) for (const range of weapon.ranges) {
    if (record(range) && nonnegative(range.damage)) range.damage = roundHalfUp(range.damage);
  }
  if (record(weapon.multipliers)) for (const part of PART_IDS) {
    if (nonnegative(weapon.multipliers[part])) weapon.multipliers[part] = roundHalfUp(weapon.multipliers[part], MULTIPLIER_DIGITS);
  }
  return weapon;
}

/** Clone and canonicalise damage inputs; malformed values remain for validation. */
export function normalizeWeapon(weapon) {
  return normalizeDamageFields(structuredClone(weapon));
}

/** Preserve schema/metadata and the source object while normalising old decimals. */
export function normalizeDatabase(database) {
  const result = structuredClone(database);
  if (record(result) && Array.isArray(result.weapons)) result.weapons.forEach(normalizeDamageFields);
  return result;
}

function btkForDisplay(value) {
  if (!Number.isFinite(value)) return value;
  // Only remove numerical noise near an integer. Never round the expectation
  // used to compute TTK, including when a mixture crosses a burst boundary.
  const nearest = Math.round(value);
  const tolerance = 32 * Number.EPSILON * Math.max(1, Math.abs(value));
  return Math.ceil(Math.abs(value - nearest) <= tolerance ? nearest : value);
}

export function validateWeapon(weapon) {
  const errors = [];
  if (!record(weapon)) return ['武器必须是一个对象。'];
  if (!text(weapon.id)) errors.push('武器 ID 不能为空。');
  if (!text(weapon.name)) errors.push('武器名称不能为空。');
  if (weapon.category !== undefined && typeof weapon.category !== 'string') errors.push('武器类别必须是文字。');
  if (weapon.notes !== undefined && typeof weapon.notes !== 'string') errors.push('武器备注必须是文字。');
  if (!positive(weapon.velocity)) errors.push('子弹速度必须是大于 0 的有限数值（米/秒）。');
  if (!nonnegative(weapon.triggerDelayMs)) errors.push('扳机延迟必须是非负有限数值（毫秒）。');

  if (!Array.isArray(weapon.ranges) || weapon.ranges.length === 0) {
    errors.push('至少需要一个伤害射程段。');
  } else {
    let previous = 0;
    weapon.ranges.forEach((range, index) => {
      const prefix = `第 ${index + 1} 个射程段：`;
      if (!record(range)) { errors.push(`${prefix}必须是一个对象。`); return; }
      if (!positive(range.damage)) errors.push(`${prefix}基础伤害必须是正数，且四舍五入后至少为 1。`);
      else if (roundHalfUp(range.damage) === 0) errors.push(`${prefix}基础伤害四舍五入后为 0，必须至少为 1。`);
      if (index === weapon.ranges.length - 1) {
        if (range.until !== null) errors.push(`${prefix}最后一段的终点必须为 null，表示无限远。`);
      } else if (!positive(range.until) || range.until <= previous) {
        errors.push(`${prefix}射程终点必须大于上一段终点。`);
      } else previous = range.until;
    });
  }

  if (!record(weapon.multipliers)) errors.push('需要填写全部部位的全程伤害倍率。');
  else for (const part of BODY_PARTS) {
    if (!nonnegative(weapon.multipliers[part.id])) errors.push(`${part.label}倍率必须是非负有限数值。`);
    else if (Array.isArray(weapon.ranges)) weapon.ranges.forEach((range, index) => {
      if (positive(range?.damage) && roundHalfUp(range.damage) > 0) {
        try { deriveDamage(range.damage, weapon.multipliers[part.id]); }
        catch { errors.push(`第 ${index + 1} 个射程段的${part.label}伤害超出可计算范围。`); }
      }
    });
  }

  if (!Array.isArray(weapon.modes) || weapon.modes.length === 0) {
    errors.push('至少需要一个射击模式。');
  } else {
    const ids = new Set();
    weapon.modes.forEach((mode, index) => {
      const prefix = `第 ${index + 1} 个射击模式：`;
      if (!record(mode)) { errors.push(`${prefix}必须是一个对象。`); return; }
      if (!text(mode.id)) errors.push(`${prefix}模式 ID 不能为空。`);
      else if (ids.has(mode.id)) errors.push(`${prefix}模式 ID 重复。`);
      ids.add(mode.id);
      if (!text(mode.name)) errors.push(`${prefix}模式名称不能为空。`);
      if (!TYPES.has(mode.type)) errors.push(`${prefix}射击方式必须是 auto、semi、bolt 或 burst。`);
      if (['auto', 'semi', 'burst'].includes(mode.type) && !positive(mode.rpm)) errors.push(`${prefix}射速必须大于 0 RPM。`);
      if (mode.type === 'bolt' && !positive(mode.cycleMs)) errors.push(`${prefix}完整拉栓/泵动周期必须大于 0 毫秒。`);
      if (mode.type === 'burst') {
        if (!Number.isInteger(mode.burstSize) || mode.burstSize < 1 || mode.burstSize > 100) errors.push(`${prefix}每组发数必须是 1–100 的整数。`);
        if (!nonnegative(mode.gapMs)) errors.push(`${prefix}组间间隔必须是非负有限数值。`);
        if (mode.burstSize === 1 && mode.gapMs === 0) errors.push(`${prefix}单发点射的组间间隔必须大于 0。`);
      }
    });
  }
  return errors;
}

export function validateDatabase(database) {
  const errors = [];
  if (!record(database)) return { valid: false, errors: ['数据库必须是一个 JSON 对象。'] };
  if (database.schemaVersion !== 1) errors.push('不支持此数据库版本：schemaVersion 必须为 1。');
  if (!text(database.name)) errors.push('数据库名称不能为空。');
  if (typeof database.updatedAt !== 'string' || !Number.isFinite(Date.parse(database.updatedAt))) errors.push('数据库 updatedAt 必须是有效日期字符串。');
  if (!Array.isArray(database.weapons)) errors.push('数据库 weapons 必须是武器数组。');
  else {
    const ids = new Set();
    database.weapons.forEach((weapon, index) => {
      for (const error of validateWeapon(weapon)) errors.push(`武器 ${index + 1}：${error}`);
      if (text(weapon?.id)) {
        if (ids.has(weapon.id)) errors.push(`武器 ${index + 1}：武器 ID「${weapon.id}」重复。`);
        ids.add(weapon.id);
      }
    });
  }
  return { valid: errors.length === 0, errors };
}

export function inferMultiplier(baseDamage, bodyDamage) {
  const base = roundedBaseDamage(baseDamage);
  if (!nonnegative(bodyDamage)) fail('部位伤害必须是非负有限数值。');
  const body = roundHalfUp(bodyDamage);
  const baseTicks = decimalParts(base).digits;
  const bodyTicks = decimalParts(body).digits;
  const multiplierTicks = (bodyTicks * MULTIPLIER_SCALE * 2n + baseTicks) / (baseTicks * 2n);
  const result = Number(`${multiplierTicks}e-${MULTIPLIER_DIGITS}`);
  if (!Number.isFinite(result)) fail('推算倍率超出可计算范围。');
  return result;
}

export function rangeAt(weapon, distance) {
  if (!nonnegative(distance)) fail('距离必须是非负有限数值。');
  if (!Array.isArray(weapon?.ranges) || weapon.ranges.length === 0) fail('武器缺少伤害射程段。');
  const index = weapon.ranges.findIndex(range => range.until === null || distance < range.until);
  if (index < 0) fail('伤害射程没有覆盖当前距离；最后一段必须延伸至无限远。');
  return { index, range: weapon.ranges[index] };
}

function resolveMode(weapon, modeId) {
  const mode = modeId === undefined || modeId === null ? weapon.modes?.[0] : weapon.modes?.find(item => item.id === modeId);
  if (!mode) fail('找不到所选射击模式。');
  return mode;
}

export function shotTime(weapon, mode, shots) {
  if (!Number.isSafeInteger(shots) || shots < 1) fail('发数必须是大于 0 的安全整数。');
  if (typeof mode === 'string' || mode == null) mode = resolveMode(weapon, mode);
  const elapsedShots = shots - 1;
  let elapsed;
  if (mode.type === 'bolt') {
    if (!positive(mode.cycleMs)) fail('完整拉栓/泵动周期必须大于 0。');
    elapsed = elapsedShots * mode.cycleMs;
  } else if (mode.type === 'burst') {
    if (!positive(mode.rpm) || !Number.isInteger(mode.burstSize) || mode.burstSize < 1 || !nonnegative(mode.gapMs)) fail('点射参数无效。');
    const interval = 60000 / mode.rpm;
    const groups = Math.floor(elapsedShots / mode.burstSize);
    const remainder = elapsedShots % mode.burstSize;
    elapsed = groups * ((mode.burstSize - 1) * interval + mode.gapMs) + remainder * interval;
  } else if (mode.type === 'auto' || mode.type === 'semi') {
    if (!positive(mode.rpm)) fail('射速必须大于 0。');
    elapsed = elapsedShots * 60000 / mode.rpm;
  } else fail('不支持此射击模式。');
  const result = elapsed + weapon.triggerDelayMs;
  if (!nonnegative(result)) fail('射击时间超出可计算范围。');
  return result;
}

// Turn decimal Number strings into exact integer ticks before BTK comparisons.
function decimalParts(value) {
  const [mantissa, exponentText = '0'] = value.toString().toLowerCase().split('e');
  const exponent = Number(exponentText);
  const [whole, fractional = ''] = mantissa.split('.');
  const digits = BigInt(whole + fractional);
  const decimals = fractional.length - exponent;
  return decimals < 0 ? { digits: digits * 10n ** BigInt(-decimals), decimals: 0 } : { digits, decimals };
}

function ticksFor(values) {
  const parts = values.map(decimalParts);
  const decimals = Math.max(...parts.map(part => part.decimals));
  return parts.map(part => part.digits * 10n ** BigInt(decimals - part.decimals));
}

function requiredShots(health, damage) {
  if (damage === 0) return Infinity;
  const [h, d] = ticksFor([health, damage]);
  const count = (h + d - 1n) / d;
  if (count > BigInt(Number.MAX_SAFE_INTEGER)) fail('击杀所需发数过大，无法可靠计算；请检查伤害和血量。');
  return Number(count);
}

function probabilityOutcomes(weapon, baseDamage, probabilities) {
  if (!record(probabilities)) fail('命中概率必须是按部位填写的对象。');
  let sum = 0;
  for (const [key, value] of Object.entries(probabilities)) {
    if (!PART_IDS.includes(key)) fail(`未知的命中部位：${key}。`);
    if (!nonnegative(value)) fail('命中概率必须是非负有限数值。');
    sum += value;
  }
  if (!positive(sum)) fail('至少一个部位的命中概率必须大于 0。');
  const aggregated = new Map();
  for (const part of PART_IDS) {
    const weight = probabilities[part] ?? 0;
    if (weight === 0) continue;
    const damage = deriveDamage(baseDamage, weapon.multipliers[part]);
    aggregated.set(damage, (aggregated.get(damage) ?? 0) + weight / sum);
  }
  // When every selected body part has the same damage, its total probability
  // is exactly one. Summing independently divided weights must not introduce
  // a tiny excess which accumulates across many shots.
  if (aggregated.size === 1) return [{ damage: aggregated.keys().next().value, probability: 1 }];
  return [...aggregated].map(([damage, probability]) => ({ damage, probability })).sort((a, b) => a.damage - b.damage);
}

function intervalsFor(mode) {
  if (mode.type === 'bolt') return [mode.cycleMs];
  const interval = 60000 / mode.rpm;
  if (mode.type !== 'burst') return [interval];
  return Array.from({ length: mode.burstSize }, (_, index) => index === mode.burstSize - 1 ? mode.gapMs : interval);
}

function getLimits(overrides) {
  const limits = { ...DEFAULT_LIMITS, ...overrides };
  for (const key of ['maxStates', 'maxTransitions', 'maxDistributionShots']) {
    if (!Number.isSafeInteger(limits[key]) || limits[key] < 1) fail(`计算限制 ${key} 必须是正整数。`);
  }
  if (!positive(limits.distributionTolerance) || limits.distributionTolerance >= 1) fail('分布尾概率容差必须在 0 和 1 之间。');
  return limits;
}

function mixedStatistics(health, outcomes, mode, limits) {
  const key = JSON.stringify([health, outcomes, intervalsFor(mode), limits]);
  if (mixedCache.has(key)) return mixedCache.get(key);
  const positiveOutcomes = outcomes.filter(outcome => outcome.damage > 0);
  // Read the zero mass explicitly. A sum of several positive outcomes can be
  // 0.9999999999999999; that must not invent a zero-damage infinite tail.
  const zeroProbability = outcomes.find(outcome => outcome.damage === 0)?.probability ?? 0;
  const positiveProbability = zeroProbability === 0 ? 1 : Math.min(1, positiveOutcomes.reduce((sum, item) => sum + item.probability, 0));
  if (positiveOutcomes.length === 0 || positiveProbability === 0) return { btk: Infinity, shotMs: Infinity, distribution: [], distributionTailProbability: 1, distributionTruncated: false, impossible: true };
  const intervals = intervalsFor(mode);
  const phases = intervals.length;
  const [healthTicks, ...damageTicks] = ticksFor([health, ...positiveOutcomes.map(item => item.damage)]);
  const scaledOutcomes = positiveOutcomes.map((item, index) => ({ damage: damageTicks[index], probability: item.probability }));
  let transitions = 0;
  const checkTransitions = increment => {
    transitions += increment;
    if (transitions > limits.maxTransitions) fail(`混合命中计算过于复杂（超过 ${limits.maxTransitions.toLocaleString()} 次状态转移）。请减少不同倍率的数量或提高伤害。`);
  };

  const reachable = [healthTicks];
  const seen = new Set([healthTicks]);
  for (let cursor = 0; cursor < reachable.length; cursor++) {
    const remaining = reachable[cursor];
    checkTransitions(scaledOutcomes.length);
    for (const outcome of scaledOutcomes) {
      const next = remaining - outcome.damage;
      if (next > 0n && !seen.has(next)) {
        seen.add(next);
        reachable.push(next);
        if (reachable.length > limits.maxStates) fail(`混合命中计算过于复杂（超过 ${limits.maxStates.toLocaleString()} 个伤害状态）。请减少不同倍率的数量或提高伤害。`);
      }
    }
  }
  reachable.sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
  const stateIndex = new Map(reachable.map((remaining, index) => [remaining, index]));
  const expectedShots = new Float64Array(reachable.length);
  const expectedTimes = new Array(reachable.length);
  const denominator = zeroProbability === 0 ? 1 : -Math.expm1(phases * Math.log1p(-positiveProbability));

  for (let index = 0; index < reachable.length; index++) {
    const remaining = reachable[index];
    let shots = 1;
    let nonlethalProbability = zeroProbability;
    const a = new Float64Array(phases);
    checkTransitions(scaledOutcomes.length * phases);
    for (const outcome of scaledOutcomes) {
      const next = remaining - outcome.damage;
      if (next <= 0n) continue;
      const target = stateIndex.get(next);
      shots += outcome.probability * expectedShots[target];
      nonlethalProbability += outcome.probability;
      for (let phase = 0; phase < phases; phase++) a[phase] += outcome.probability * expectedTimes[target][(phase + 1) % phases];
    }
    expectedShots[index] = shots / positiveProbability;
    for (let phase = 0; phase < phases; phase++) a[phase] += nonlethalProbability * intervals[phase];
    const times = new Float64Array(phases);
    if (zeroProbability === 0) times.set(a);
    else {
      let numerator = 0;
      let power = 1;
      for (let phase = 0; phase < phases; phase++) {
        numerator += power * a[phase];
        power *= zeroProbability;
      }
      times[0] = numerator / denominator;
      let nextTime = times[0];
      for (let phase = phases - 1; phase > 0; phase--) {
        times[phase] = a[phase] + zeroProbability * nextTime;
        nextTime = times[phase];
      }
    }
    expectedTimes[index] = times;
  }

  const startIndex = stateIndex.get(healthTicks);
  const btk = positiveOutcomes.length === 1
    ? requiredShots(health, positiveOutcomes[0].damage) / positiveProbability
    : expectedShots[startIndex];
  const shotMs = phases === 1 ? (btk - 1) * intervals[0] : expectedTimes[startIndex][0];
  if (!positive(btk) || !nonnegative(shotMs)) fail('混合命中期望超出可计算范围；请检查概率和伤害。');

  const distribution = [];
  let active = new Map([[healthTicks, 1]]);
  let tail = 1;
  let truncated = false;
  for (let shots = 1; shots <= limits.maxDistributionShots; shots++) {
    const next = new Map();
    let killed = 0;
    checkTransitions(active.size * (scaledOutcomes.length + (zeroProbability > 0 ? 1 : 0)));
    for (const [remaining, probability] of active) {
      if (zeroProbability > 0) next.set(remaining, (next.get(remaining) ?? 0) + probability * zeroProbability);
      for (const outcome of scaledOutcomes) {
        const contribution = probability * outcome.probability;
        const after = remaining - outcome.damage;
        if (after <= 0n) killed += contribution;
        else next.set(after, (next.get(after) ?? 0) + contribution);
      }
    }
    if (killed > 0) distribution.push({ shots, probability: killed });
    tail = [...next.values()].reduce((sum, probability) => sum + probability, 0);
    active = next;
    if (active.size === 0) { tail = 0; break; }
    if (zeroProbability > 0 && tail <= limits.distributionTolerance) { truncated = true; break; }
    if (shots === limits.maxDistributionShots) truncated = true;
  }
  const result = { btk, shotMs, distribution, distributionTailProbability: tail, distributionTruncated: truncated, impossible: false };
  mixedCache.set(key, result);
  if (mixedCache.size > 128) mixedCache.delete(mixedCache.keys().next().value);
  return result;
}

/**
 * probabilities are nonnegative weights (fractions and percentages both work).
 * A zero-damage hit is permitted. Expected values analytically eliminate its
 * self-loop. Its infinite distribution is explicitly marked with a tail mass.
 */
export function calculate(weapon, options = {}) {
  const {
    distance = 0,
    health = 100,
    part = 'chest',
    modeId,
    includeTravel = false,
    probabilities = null,
    limits: limitOverrides,
  } = options;
  weapon = normalizeWeapon(weapon);
  const errors = validateWeapon(weapon);
  if (errors.length) fail(errors[0]);
  if (!positive(health)) fail('目标血量必须是大于 0 的有限数值。');
  if (!PART_IDS.includes(part)) fail('未知的命中部位。');
  const { index: rangeIndex, range } = rangeAt(weapon, distance);
  const baseDamage = roundedBaseDamage(range.damage);
  const mode = resolveMode(weapon, modeId);
  const triggerMs = weapon.triggerDelayMs;
  const travelMs = includeTravel ? distance / weapon.velocity * 1000 : 0;
  if (!nonnegative(travelMs)) fail('子弹飞行时间超出可计算范围。');

  if (probabilities === null) {
    const damage = deriveDamage(baseDamage, weapon.multipliers[part]);
    const btk = requiredShots(health, damage);
    const impossible = !Number.isFinite(btk);
    const shotMs = impossible ? Infinity : shotTime(weapon, mode, btk) - triggerMs;
    const ttk = shotMs + triggerMs + travelMs;
    return {
      btk, displayBtk: btkForDisplay(btk), ttk, damage, baseDamage, rangeIndex, shotMs, triggerMs, travelMs,
      distribution: impossible ? [] : [{ shots: btk, probability: 1, ttk }],
      mixed: false, impossible,
      distributionTailProbability: impossible ? 1 : 0,
      distributionTruncated: false,
    };
  }

  const outcomes = probabilityOutcomes(weapon, baseDamage, probabilities);
  const limits = getLimits(limitOverrides);
  const result = mixedStatistics(health, outcomes, mode, limits);
  const damage = outcomes.reduce((sum, item) => sum + item.damage * item.probability, 0);
  return {
    btk: result.btk,
    displayBtk: btkForDisplay(result.btk),
    ttk: result.shotMs + triggerMs + travelMs,
    damage, baseDamage, rangeIndex,
    shotMs: result.shotMs, triggerMs, travelMs,
    distribution: result.distribution.map(item => ({ ...item, ttk: shotTime(weapon, mode, item.shots) + travelMs })),
    mixed: true,
    impossible: result.impossible,
    distributionTailProbability: result.distributionTailProbability,
    distributionTruncated: result.distributionTruncated,
  };
}
