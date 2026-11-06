/** Interactive anatomical map and distance/TTK chart. No external dependencies. */
const PARTS = [
  ['head', '头部'], ['neck', '颈部'], ['chest', '胸部'], ['abdomen', '腹部'],
  ['upperArm', '上臂'], ['forearm', '前臂'], ['thigh', '大腿'], ['calf', '小腿'],
];
const LABELS = Object.fromEntries(PARTS);
const COLORS = ['#e4bb65', '#77b7aa', '#d79883', '#8faed1', '#b3bd84', '#b69fca'];
let instance = 0;

const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[character]));
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const finite = (value) => typeof value === 'number' && Number.isFinite(value);
const number = (value, digits = 1) => finite(value)
  ? new Intl.NumberFormat('zh-CN', { maximumFractionDigits: digits }).format(value) : '—';
const safeColor = (color, index) => /^(?:#[\da-f]{3}|#[\da-f]{4}|#[\da-f]{6}|#[\da-f]{8})$/i.test(color || '') ? color : COLORS[index % COLORS.length];

function restoreFocus(container, selector, hadFocus) {
  if (!hadFocus || document.activeElement !== document.body) return;
  const replacement = container.isConnected ? container : container.id ? document.getElementById(container.id) : null;
  replacement?.querySelector(selector)?.focus({ preventScroll: true });
}

const GEOMETRY = {
  head: '<path d="M221 49 C223 34 256 32 261 49 L263 71 Q262 88 249 97 L232 96 Q218 88 217 72 Z"/><path class="anatomy-detail" d="M222 65 L231 62 M249 62 L258 65 M240 68 L237 78 L243 79 M231 86 Q240 90 249 86"/>',
  neck: '<path d="M231 98 L249 98 L251 112 L263 119 L249 129 L232 129 L217 119 L229 112 Z"/><path class="anatomy-detail" d="M233 105 L239 117 L246 105"/>',
  chest: '<path d="M216 120 L231 131 L249 131 L264 120 L280 132 L275 177 L266 207 L215 207 L205 177 L200 132 Z"/><path class="anatomy-detail" d="M240 134 L240 198 M207 145 Q222 138 236 149 L235 171 Q224 178 209 167 M273 145 Q258 138 244 149 L245 171 Q256 178 271 167 M216 184 L233 188 M264 184 L247 188 M219 197 L233 199 M261 197 L247 199"/>',
  abdomen: '<path d="M216 212 L265 212 L264 236 L273 270 L263 294 L244 305 L237 305 L218 294 L208 270 L217 236 Z"/><path class="anatomy-detail" d="M240 218 L240 277 M223 228 L235 231 M257 228 L245 231 M222 245 L235 248 M258 245 L245 248 M225 262 L235 265 M255 262 L245 265 M218 278 L234 289 M262 278 L246 289"/>',
  upperArm: '<path d="M198 130 Q184 133 181 150 L166 205 L177 220 L190 207 L205 173 Z"/><path d="M282 130 Q296 133 299 150 L314 205 L303 220 L290 207 L275 173 Z"/><path class="anatomy-detail" d="M190 151 L177 199 M290 151 L303 199"/>',
  forearm: '<path d="M165 212 L175 226 L170 253 L154 296 L151 315 L142 325 L135 322 L138 304 L139 288 L150 241 Z"/><path d="M315 212 L305 226 L310 253 L326 296 L329 315 L338 325 L345 322 L342 304 L341 288 L330 241 Z"/><path class="anatomy-detail" d="M162 234 L147 291 M318 234 L333 291 M145 304 L142 316 M335 304 L338 316"/>',
  thigh: '<path d="M217 299 L237 311 L236 346 L230 397 L210 397 L202 352 L204 319 Z"/><path d="M263 299 L243 311 L244 346 L250 397 L270 397 L278 352 L276 319 Z"/><path class="anatomy-detail" d="M215 320 L220 378 M265 320 L260 378"/>',
  calf: '<path d="M210 403 L230 403 L231 426 L224 474 L224 493 L232 508 L229 516 L204 516 L202 510 L209 490 L206 453 L204 427 Z"/><path d="M250 403 L270 403 L276 427 L274 453 L271 490 L278 510 L276 516 L251 516 L248 508 L256 493 L256 474 L249 426 Z"/><path class="anatomy-detail" d="M214 422 L217 470 M266 422 L263 470 M211 501 L220 501 M260 501 L269 501"/>',
};
const ANNOTATIONS = {
  head: { line: '263,64 310,64 330,54', text: [345, 44], anchor: 'start', dot: [262, 64] },
  neck: { line: '229,112 160,112 140,102', text: [120, 92], anchor: 'end', dot: [229, 112] },
  chest: { line: '266,164 314,164 334,154', text: [347, 144], anchor: 'start', dot: [266, 164] },
  upperArm: { line: '185,175 142,175 127,165', text: [112, 155], anchor: 'end', dot: [185, 175] },
  abdomen: { line: '261,249 312,249 332,239', text: [347, 229], anchor: 'start', dot: [261, 249] },
  forearm: { line: '155,269 129,269 114,259', text: [100, 249], anchor: 'end', dot: [155, 269] },
  thigh: { line: '264,351 312,351 332,341', text: [347, 331], anchor: 'start', dot: [264, 351] },
  calf: { line: '210,444 158,444 138,434', text: [120, 424], anchor: 'end', dot: [210, 444] },
};

/** Render eight paired anatomical zones. `probability` values use the 0–1 scale. */
export function renderBody(container, { values = {}, selected = 'chest', view = 'damage', onSelect, suffix = '' } = {}) {
  const controller = new AbortController();
  const uid = `anatomy-${++instance}`;
  const probability = view === 'probability';
  let selection = selected;
  const max = Math.max(1, ...Object.values(values).filter(finite));
  const zones = PARTS.map(([id, label], index) => {
    const value = values[id];
    const display = finite(value) ? `${number(probability ? value * 100 : value, probability ? 1 : 2)}${probability ? '%' : suffix}` : '—';
    const opacity = probability ? 0.13 + clamp(finite(value) ? value : 0, 0, 1) * 0.66
      : 0.16 + clamp(finite(value) ? value / max : 0, 0, 1) * 0.20;
    const annotation = ANNOTATIONS[id];
    const [x, y] = annotation.text;
    return `<g class="anatomy-zone${id === selected ? ' is-selected' : ''}" data-part="${id}" role="button" tabindex="0" aria-pressed="${id === selected}" aria-label="${label}，${probability ? '命中概率' : '伤害'} ${escapeHtml(display)}" style="--zone-opacity:${opacity.toFixed(3)}">
      <title>${label} · ${probability ? '命中概率' : '伤害'} ${escapeHtml(display)}</title>
      <g class="anatomy-region">${GEOMETRY[id]}</g>
      <g class="anatomy-annotation"><polyline points="${annotation.line}"/><circle cx="${annotation.dot[0]}" cy="${annotation.dot[1]}" r="2.3"/>
        <text x="${x}" y="${y}" text-anchor="${annotation.anchor}" class="anatomy-label">${label}<tspan class="anatomy-number" x="${x}" dy="27">${escapeHtml(display)}</tspan></text>
      </g>
    </g>`;
  }).join('');
  container.innerHTML = `<div class="anatomy-map${probability ? ' anatomy-probability' : ''}">
    <svg viewBox="0 0 480 553" class="anatomy-svg" role="group" aria-labelledby="${uid}-title ${uid}-desc">
      <title id="${uid}-title">人体${probability ? '命中概率' : '伤害'}分布</title><desc id="${uid}-desc">点击人体或外侧标注选择部位，也可用 Tab 和回车键操作。左右同类部位共用数据。</desc>
      <defs><pattern id="${uid}-grid" width="24" height="24" patternUnits="userSpaceOnUse"><path d="M 24 0 L 0 0 0 24" fill="none" stroke="currentColor" stroke-width=".5"/></pattern></defs>
      <rect x="127" y="22" width="226" height="506" fill="url(#${uid}-grid)" class="anatomy-grid"/>
      <path d="M240 22 V528 M126 120 H354 M126 300 H354 M126 518 H354" class="anatomy-datum"/>
      <path d="M124 37 V23 H140 M340 23 H356 V37 M124 514 V528 H140 M340 528 H356 V514" class="anatomy-frame"/>
      ${zones}
      <text x="240" y="548" text-anchor="middle" class="anatomy-caption">${probability ? '命中分布' : '部位伤害'} · 左右同类部位合并</text>
    </svg>
    <div class="anatomy-selection" aria-live="polite"><span class="anatomy-selection-dot"></span><span>${escapeHtml(LABELS[selected] || '选择部位')}</span><span class="anatomy-selection-hint">点击部位查看 / 编辑</span></div>
  </div>`;
  const zoneElements = [...container.querySelectorAll('[data-part]')];
  const activate = (id) => {
    const hadFocus = zoneElements.includes(document.activeElement);
    selection = id;
    zoneElements.forEach((element) => {
      const active = element.dataset.part === selection;
      element.classList.toggle('is-selected', active);
      element.setAttribute('aria-pressed', String(active));
    });
    const status = container.querySelector('.anatomy-selection > span:nth-child(2)');
    if (status) status.textContent = LABELS[id];
    if (typeof onSelect === 'function') onSelect(id);
    restoreFocus(container, `[data-part="${id}"]`, hadFocus);
  };
  zoneElements.forEach((element) => {
    element.addEventListener('click', () => activate(element.dataset.part), { signal: controller.signal });
    element.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); event.stopPropagation(); activate(element.dataset.part); }
    }, { signal: controller.signal });
  });
  return () => controller.abort();
}

function niceStep(value) {
  const exponent = 10 ** Math.floor(Math.log10(Math.max(value, 0.001)));
  const ratio = value / exponent;
  return (ratio <= 1 ? 1 : ratio <= 2 ? 2 : ratio <= 2.5 ? 2.5 : ratio <= 5 ? 5 : 10) * exponent;
}

function sample(points, distance) {
  if (!points.length) return null;
  if (distance <= points[0].distance) return finite(points[0].ttk) ? points[0] : null;
  let low = 0;
  let high = points.length - 1;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (points[mid].distance <= distance) low = mid; else high = mid - 1;
  }
  const left = points[low];
  const right = points[low + 1];
  if (!finite(left.ttk)) return null;
  if (right && !finite(right.ttk)) return left;
  if (!right || right.distance === left.distance) return left;
  const factor = (distance - left.distance) / (right.distance - left.distance);
  return { distance, ttk: left.ttk + (right.ttk - left.ttk) * factor, btk: left.btk };
}

/** Plot prepared distance/TTK series. Supply both sides of a range boundary for a step. */
export function renderChart(container, { series = [], maxDistance = 100, health = 100, includeTravel = false, onDistance, selectedDistance = 0 } = {}) {
  const controller = new AbortController();
  const uid = `ttk-${++instance}`;
  const maximumDistance = finite(maxDistance) && maxDistance > 0 ? maxDistance : 100;
  const selected = clamp(finite(selectedDistance) ? selectedDistance : 0, 0, maximumDistance);
  const prepared = series.map((item, index) => {
    const allPoints = (item.points || []).filter((point) => finite(point.distance) && point.distance >= 0 && point.distance <= maximumDistance)
      .map((point) => ({ ...point, ttk: finite(point.ttk) && point.ttk >= 0 ? point.ttk : Infinity }))
      .sort((a, b) => a.distance - b.distance);
    const segments = [];
    let segment = [];
    allPoints.forEach((point) => {
      if (finite(point.ttk)) segment.push(point);
      else if (segment.length) { segments.push(segment); segment = []; }
    });
    if (segment.length) segments.push(segment);
    return { ...item, color: safeColor(item.color, index), allPoints, segments, points: allPoints.filter((point) => finite(point.ttk)) };
  }).filter((item) => item.points.length);
  if (!prepared.length) {
    container.innerHTML = '<div class="ttk-chart-empty"><span class="ttk-empty-mark">⌁</span><strong>暂无可绘制的曲线</strong><span>选择武器或填写有效数据后，查看距离与击杀时间。</span></div>';
    return () => controller.abort();
  }
  const initialWidth = container.clientWidth || 1000;
  const chartWidth = clamp(initialWidth, 430, 1000);
  const dimensions = { width: chartWidth, height: chartWidth < 600 ? 285 : 348, left: chartWidth < 600 ? 52 : 66, right: 24, top: 28, bottom: 46 };
  const plotWidth = dimensions.width - dimensions.left - dimensions.right;
  const plotHeight = dimensions.height - dimensions.top - dimensions.bottom;
  const rawMaximum = Math.max(1, ...prepared.flatMap((item) => item.points.map((point) => point.ttk)));
  const step = niceStep(rawMaximum * 1.08 / 4);
  const maximumTtk = Math.ceil(rawMaximum * 1.08 / step) * step;
  const x = (distance) => dimensions.left + distance / maximumDistance * plotWidth;
  const y = (ttk) => dimensions.top + (1 - ttk / maximumTtk) * plotHeight;
  const yTicks = [];
  for (let value = 0; value <= maximumTtk + step / 10; value += step) yTicks.push(value);
  const grids = yTicks.map((value) => `<g><line x1="${dimensions.left}" x2="${dimensions.width - dimensions.right}" y1="${y(value)}" y2="${y(value)}" class="ttk-grid-line"/><text x="${dimensions.left - 13}" y="${y(value) + 4}" text-anchor="end" class="ttk-axis-text">${number(value, 0)}</text></g>`).join('');
  const xTicks = Array.from({ length: 6 }, (_, index) => maximumDistance * index / 5).map((value) => `<g><line x1="${x(value)}" x2="${x(value)}" y1="${dimensions.top}" y2="${dimensions.height - dimensions.bottom}" class="ttk-grid-line ttk-grid-vertical"/><text x="${x(value)}" y="${dimensions.height - 20}" text-anchor="middle" class="ttk-axis-text">${number(value, 1)}</text></g>`).join('');
  const paths = prepared.map((item, index) => item.segments.map((segment) => `<path d="${segment.map((point, pointIndex) => `${pointIndex ? 'L' : 'M'}${x(point.distance).toFixed(3)},${y(point.ttk).toFixed(3)}`).join(' ')}" fill="none" stroke="${item.color}" stroke-width="${index ? 2 : 2.8}" stroke-linejoin="round" stroke-linecap="round" class="ttk-series-path"/>`).join('')).join('');
  container.innerHTML = `<div class="ttk-chart">
    <div class="ttk-chart-top"><div class="ttk-legend">${prepared.map((item) => `<span class="ttk-legend-item"><i style="background:${item.color}"></i><span title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</span></span>`).join('')}</div><span class="ttk-chart-context">${number(health, 0)} HP · ${includeTravel ? '含弹速' : '纯射击 + 扳机延迟'}</span></div>
    <div class="ttk-plot-wrap"><svg class="ttk-plot" viewBox="0 0 ${dimensions.width} ${dimensions.height}" role="group" aria-labelledby="${uid}-title ${uid}-desc">
      <title id="${uid}-title">不同距离下的武器 TTK 对比</title><desc id="${uid}-desc">横轴是距离，单位米；纵轴是击杀时间，单位毫秒。点击图表选择距离，聚焦图表后可用左右方向键调整。</desc>
      <defs><clipPath id="${uid}-clip"><rect x="${dimensions.left - 1}" y="${dimensions.top - 3}" width="${plotWidth + 2}" height="${plotHeight + 6}"/></clipPath></defs>
      ${grids}${xTicks}<text x="${dimensions.left}" y="13" class="ttk-unit-text">TTK / ms</text><text x="${dimensions.width - dimensions.right}" y="${dimensions.height - 2}" text-anchor="end" class="ttk-unit-text">距离 / m</text>
      <g clip-path="url(#${uid}-clip)">${paths}</g>
      <g class="ttk-crosshair" aria-hidden="true"><line class="ttk-cursor-line" x1="${x(selected)}" x2="${x(selected)}" y1="${dimensions.top}" y2="${dimensions.height - dimensions.bottom}"/>${prepared.map((item, index) => { const value = sample(item.allPoints, selected); return `<circle class="ttk-cursor-dot" data-series="${index}" cx="${x(selected)}" cy="${y(value?.ttk ?? 0)}"${value ? '' : ' visibility="hidden"'} r="4.5" fill="${item.color}"/>`; }).join('')}<rect class="ttk-cursor-tag-bg" x="${x(selected) - 29}" y="${dimensions.top - 19}" width="58" height="19" rx="3"/><text class="ttk-cursor-tag" x="${x(selected)}" y="${dimensions.top - 6}" text-anchor="middle">${number(selected, 1)} m</text></g>
      <rect class="ttk-interaction" x="${dimensions.left}" y="${dimensions.top}" width="${plotWidth}" height="${plotHeight}" fill="transparent" tabindex="0" role="slider" aria-label="查看距离" aria-valuemin="0" aria-valuemax="${maximumDistance}" aria-valuenow="${selected}" aria-valuetext="${number(selected, 1)} 米"/>
    </svg><div class="ttk-tooltip" hidden></div></div>
    <div class="ttk-chart-footer"><span>点击曲线区域选择距离</span><span>← → 调整距离</span></div><div class="ttk-chart-live sr-only" aria-live="polite"></div>
  </div>`;
  const svg = container.querySelector('.ttk-plot');
  const interaction = container.querySelector('.ttk-interaction');
  const tooltip = container.querySelector('.ttk-tooltip');
  const wrap = container.querySelector('.ttk-plot-wrap');
  const cursorLine = container.querySelector('.ttk-cursor-line');
  const tag = container.querySelector('.ttk-cursor-tag');
  const tagBackground = container.querySelector('.ttk-cursor-tag-bg');
  const dots = [...container.querySelectorAll('.ttk-cursor-dot')];
  let keyboardDistance = selected;
  const drawCursor = (distance) => {
    const position = x(distance);
    cursorLine.setAttribute('x1', position); cursorLine.setAttribute('x2', position);
    const tagPosition = clamp(position, dimensions.left + 29, dimensions.width - dimensions.right - 29);
    tag.setAttribute('x', tagPosition); tag.textContent = `${number(distance, 1)} m`;
    tagBackground.setAttribute('x', tagPosition - 29);
    const samples = prepared.map((item) => ({ ...item, value: sample(item.allPoints, distance) }));
    samples.forEach((item, index) => { dots[index].setAttribute('visibility', item.value ? 'visible' : 'hidden'); dots[index].setAttribute('cx', position); if (item.value) dots[index].setAttribute('cy', y(item.value.ttk)); });
    return samples;
  };
  const locate = (event) => {
    const rect = svg.getBoundingClientRect();
    const svgX = (event.clientX - rect.left) / rect.width * dimensions.width;
    return Math.round(clamp((svgX - dimensions.left) / plotWidth * maximumDistance, 0, maximumDistance) * 10) / 10;
  };
  const showTooltip = (distance, event) => {
    const samples = drawCursor(distance);
    tooltip.innerHTML = `<strong>${number(distance, 1)}<small> m</small></strong>${samples.map((item) => `<div class="ttk-tooltip-row"><i style="background:${item.color}"></i><span>${escapeHtml(item.name)}</span><b>${item.value ? `${number(item.value.ttk, 1)}<small> ms</small>` : '无法击杀'}</b>${finite(item.value?.btk) ? `<em>${number(item.value.btk, 2)} 发</em>` : ''}</div>`).join('')}`;
    tooltip.hidden = false;
    const rect = wrap.getBoundingClientRect();
    const desiredX = event ? event.clientX - rect.left + 15 : (x(distance) / dimensions.width * rect.width) + 15;
    const desiredY = event ? event.clientY - rect.top + 15 : rect.height * .35;
    tooltip.style.left = `${clamp(desiredX, 7, Math.max(7, rect.width - tooltip.offsetWidth - 7))}px`;
    tooltip.style.top = `${clamp(desiredY, 5, Math.max(5, rect.height - tooltip.offsetHeight - 5))}px`;
    return samples;
  };
  const commit = (distance) => {
    const hadFocus = document.activeElement === interaction;
    keyboardDistance = distance;
    interaction.setAttribute('aria-valuenow', distance);
    interaction.setAttribute('aria-valuetext', `${number(distance, 1)} 米`);
    const samples = drawCursor(distance);
    container.querySelector('.ttk-chart-live').textContent = `${number(distance, 1)} 米；${samples.map((item) => `${item.name} ${item.value ? `${number(item.value.ttk, 1)} 毫秒` : '无法击杀'}`).join('；')}`;
    if (typeof onDistance === 'function') onDistance(distance);
    restoreFocus(container, '.ttk-interaction', hadFocus);
  };
  interaction.addEventListener('pointermove', (event) => showTooltip(locate(event), event), { signal: controller.signal });
  interaction.addEventListener('pointerleave', () => { tooltip.hidden = true; drawCursor(keyboardDistance); }, { signal: controller.signal });
  interaction.addEventListener('click', (event) => commit(locate(event)), { signal: controller.signal });
  interaction.addEventListener('keydown', (event) => {
    const increment = event.shiftKey ? 5 : 1;
    let next;
    if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') next = keyboardDistance - increment;
    if (event.key === 'ArrowRight' || event.key === 'ArrowUp') next = keyboardDistance + increment;
    if (event.key === 'Home') next = 0;
    if (event.key === 'End') next = maximumDistance;
    if (next !== undefined) {
      event.preventDefault(); event.stopPropagation(); next = Math.round(clamp(next, 0, maximumDistance) * 10) / 10;
      showTooltip(next); commit(next);
    }
  }, { signal: controller.signal });
  interaction.addEventListener('blur', () => { tooltip.hidden = true; }, { signal: controller.signal });
  let nextCleanup;
  const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(() => {
    if (Math.abs(container.clientWidth - initialWidth) > 24) {
      const hadFocus = document.activeElement === interaction;
      observer.disconnect();
      controller.abort();
      nextCleanup = renderChart(container, { series, maxDistance, health, includeTravel, onDistance, selectedDistance: keyboardDistance });
      restoreFocus(container, '.ttk-interaction', hadFocus);
    }
  }) : null;
  if (observer) observer.observe(container);
  return () => { controller.abort(); observer?.disconnect(); nextCleanup?.(); };
}
