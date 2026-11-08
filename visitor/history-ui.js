import { BODY_PARTS, calculate } from './engine.js';
import { renderChart, getSeriesStyle } from './visuals.js';
import { diffDatabases } from './data-core.js';

const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, character => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[character]));
const number = (value, digits = 1) => Number.isFinite(value) ? new Intl.NumberFormat('zh-CN', {maximumFractionDigits:digits}).format(value) : value === Infinity ? '∞' : '—';
const finite = value => typeof value === 'number' && Number.isFinite(value);
const storedViews = new WeakMap();
const STATUS = {added:'新增',removed:'移除',changed:'参数调整',unchanged:'未变化'};
const DIRECTION = {buff:'增强',nerf:'削弱',neutral:'调整',mixed:'综合调整'};
const TYPE_NAMES = {auto:'全自动',semi:'半自动',bolt:'栓动 / 泵动',burst:'点射'};
const partLabel = id => BODY_PARTS.find(part => part.id === id)?.label || id;
const unitFor = key => key === 'velocity' ? ' m/s' : /(?:triggerDelayMs|cycleMs|gapMs)$/.test(key) ? ' ms' : /\.rpm$/.test(key) ? ' RPM' : '';

function valueText(value, field = {}) {
  if(value === null || value === undefined || value === '') return '—';
  if(finite(value)) return field.key?.startsWith('multipliers.') ? `×${value.toFixed(1)}` : `${number(value,3)}${unitFor(field.key || '')}`;
  if(typeof value === 'string' || typeof value === 'boolean') return String(value);
  if(Array.isArray(value)) return value.map(item => typeof item === 'object' ? valueText(item) : String(item)).join(' / ');
  if(value.type && value.id) return `${value.name || TYPE_NAMES[value.type] || value.type}${finite(value.rpm) ? ` · ${number(value.rpm)} RPM` : ''}`;
  return Object.entries(value).map(([key,item]) => `${key}: ${valueText(item)}`).join(' / ');
}

function differenceText(field) {
  if(finite(field.before) && finite(field.after)) {
    const difference = Number((field.after - field.before).toPrecision(12));
    return `${difference > 0 ? '+' : ''}${number(difference,3)}${unitFor(field.key || '')}`;
  }
  if(field.before === null || field.before === undefined) return '新增';
  if(field.after === null || field.after === undefined) return '移除';
  return field.kind === 'range' ? '分段调整' : '内容变更';
}

function versionTitle(version) {
  if(!version) return '未选择版本';
  return `${version.label || version.id}${version.effectiveAt ? ` · ${String(version.effectiveAt).slice(0,10)}` : ''}`;
}

function firingModeTitle(mode) {
  const type=TYPE_NAMES[mode.type] || mode.type;
  return mode.name && mode.name!==type ? `${mode.name} · ${type}` : type;
}

function weaponSummary(weapon) {
  if(!weapon) return '';
  return `<dl class="hx-weapon-summary"><div><dt>类别</dt><dd>${escapeHtml(weapon.category || '未分类')}</dd></div><div><dt>弹速</dt><dd>${number(weapon.velocity)} m/s</dd></div><div><dt>首发扳机延迟</dt><dd>${number(weapon.triggerDelayMs)} ms</dd></div><div><dt>射击模式</dt><dd>${weapon.modes.map(mode => escapeHtml(mode.name || TYPE_NAMES[mode.type])).join(' / ')}</dd></div></dl>`;
}

/**
 * Render a same-mode history comparison. Data fetching belongs to the caller.
 * The returned cleanup aborts all view listeners and releases the chart.
 */
export function renderHistory(container, {
  mode, versions = [], beforeVersionId, afterVersionId,
  beforeDb, afterDb, loading = false, error = null,
  onVersionsChange, onRetry,
} = {}) {
  const controller = new AbortController();
  const previous = storedViews.get(container);
  const state = previous?.modeId === mode?.id ? previous : {
    modeId:mode?.id, query:'', onlyChanged:true, selectedId:null,
    health:100, part:'chest', includeTravel:false, distance:10, chartMax:100, modeIdForCurve:null,
  };
  storedViews.set(container,state);
  let chartCleanup = null, report = null;
  const $ = selector => container.querySelector(selector);
  const $$ = selector => [...container.querySelectorAll(selector)];
  const oldVersion = versions.find(version => version.id === beforeVersionId);
  const newVersion = versions.find(version => version.id === afterVersionId);
  const options = selected => versions.map(version => `<option value="${escapeHtml(version.id)}"${selected === version.id ? ' selected' : ''}>${escapeHtml(versionTitle(version))}</option>`).join('');
  const subtitle = mode?.label ? `${mode.label} · 选择同一模式的两个版本，查看武器数据变化。` : '选择同一模式的两个版本，查看武器数据变化。';

  container.innerHTML = `<div class="history-view">
    <div class="page-heading"><div><span class="eyebrow">BALANCE ARCHIVE / 历史对比</span><h1>每一次调整，都有迹可循</h1><p>${escapeHtml(subtitle)}</p></div><span class="tag outline">同模式版本对比</span></div>
    <section class="panel hx-version-panel"><div class="panel-body hx-version-grid">
      <label class="field"><span>旧版本</span><select data-history-version="before" aria-label="历史对比旧版本"${versions.length < 2 || loading ? ' disabled' : ''}>${versions.length ? options(beforeVersionId) : '<option>暂无历史版本</option>'}</select></label>
      <span class="hx-version-arrow" aria-hidden="true">→</span>
      <label class="field"><span>新版本</span><select data-history-version="after" aria-label="历史对比新版本"${versions.length < 2 || loading ? ' disabled' : ''}>${versions.length ? options(afterVersionId) : '<option>暂无历史版本</option>'}</select></label>
      <p class="hx-version-note">先查看字段差异，选择一把武器后再展开前后曲线。</p>
    </div></section>
    <div class="hx-state" aria-live="polite"></div><div class="hx-report"></div><div class="hx-details"></div>
  </div>`;

  const cleanup = () => { controller.abort();chartCleanup?.();chartCleanup=null; };
  $$('[data-history-version]').forEach(select => select.addEventListener('change', () => {
    const before = $('[data-history-version="before"]').value;
    const after = $('[data-history-version="after"]').value;
    onVersionsChange?.(before,after);
  }, {signal:controller.signal}));

  if(error) {
    $('.hx-state').innerHTML = `<div class="error-box">${escapeHtml(error.message || error)}</div>${onRetry ? '<button type="button" class="button ghost" data-history-retry>重新读取版本数据</button>' : ''}`;
    $('[data-history-retry]')?.addEventListener('click', () => onRetry(), {signal:controller.signal});
    return cleanup;
  }
  if(loading) { $('.hx-state').innerHTML = '<div class="hx-empty"><span class="eyebrow">LOADING SNAPSHOTS</span><p>正在读取历史数据库…</p></div>';return cleanup; }
  if(versions.length < 2) {
    $('.hx-state').innerHTML = `<div class="hx-empty"><span class="eyebrow">ARCHIVE STARTS HERE</span><h2>${versions.length ? '当前只有一个已发布版本' : '这个模式尚未发布历史数据'}</h2><p>${versions.length ? `当前版本：${escapeHtml(versionTitle(versions[0]))}。后续版本发布后，即可选择两版比较。` : '数据更新后，这里会显示可比较的历史版本。'}</p></div>`;
    return cleanup;
  }
  if(!beforeDb || !afterDb) { $('.hx-state').innerHTML='<div class="hx-empty"><p>选择旧版本和新版本，开始比较。</p></div>';return cleanup; }
  try { report=diffDatabases(beforeDb,afterDb); }
  catch(comparisonError) { $('.hx-state').innerHTML=`<div class="error-box">${escapeHtml(comparisonError.message || comparisonError)}</div>`;return cleanup; }

  const counts = report.counts;
  $('.hx-report').innerHTML = `
    <div class="hx-stats">${[['changed','参数调整'],['added','新增武器'],['removed','移除武器'],['unchanged','未变化']].map(([key,label])=>`<div class="stat-card${key==='changed'?' primary':''}"><div class="stat-label">${label}</div><div class="stat-value">${number(counts[key] || 0,0)}<small>把</small></div></div>`).join('')}</div>
    <section class="panel"><div class="panel-heading"><h2>武器变动列表 <span class="tag outline">${number(counts.total ?? report.changes.length,0)} 把武器</span></h2><div class="hx-list-controls"><input type="search" data-history-search placeholder="搜索武器名称或类别" aria-label="搜索历史对比武器" value="${escapeHtml(state.query)}"><label class="switch-label"><input type="checkbox" data-history-only-changed${state.onlyChanged?' checked':''}>仅看有变化</label></div></div><div class="hx-list"></div></section>
    <p class="inline-note">字段差异与推算的伤害、TTK 分开呈现，两个版本使用同一套计算规则。</p>`;
  if(beforeVersionId === afterVersionId) $('.hx-state').innerHTML='<div class="notice">当前选择的是同一版本，字段差异应为零。可在上方选择另一个历史版本。</div>';

  function renderList() {
    const query=state.query.trim().toLowerCase();
    const changes=report.changes.filter(change => (!state.onlyChanged || change.status!=='unchanged') && (!query || [change.before?.name,change.after?.name,change.before?.category,change.after?.category].filter(Boolean).some(value=>value.toLowerCase().includes(query))));
    $('.hx-list').innerHTML=changes.length ? `<div class="hx-table-scroll"><table class="range-table hx-change-table"><thead><tr><th>武器</th><th>状态</th><th>变动字段</th><th>详情</th></tr></thead><tbody>${changes.map(change=>`<tr class="${change.id===state.selectedId?'current':''}"><td><strong>${escapeHtml(change.after?.name || change.before?.name)}</strong>${change.before?.name && change.after?.name && change.before.name!==change.after.name ? `<small class="hx-old-name">原名称：${escapeHtml(change.before.name)}</small>` : ''}<small class="hx-category">${escapeHtml(change.after?.category || change.before?.category || '未分类')}</small></td><td><span class="hx-status hx-status-${change.status}">${STATUS[change.status]}</span></td><td>${change.status==='added'?'首次出现':change.status==='removed'?'新版不再包含':`${change.fields.length} 项`}</td><td><button type="button" class="button ghost compact" data-history-weapon="${escapeHtml(change.id)}" aria-expanded="${change.id===state.selectedId}">${change.id===state.selectedId?'收起详情':'查看差异'}</button></td></tr>`).join('')}</tbody></table></div>` : `<div class="hx-empty"><h3>${query?'没有匹配的武器':'这两个版本没有符合条件的变动'}</h3><p>${query?'可以换一个名称或类别搜索。':'关闭“仅看有变化”可以查看全部武器。'}</p></div>`;
  }

  function renderDetails() {
    chartCleanup?.();chartCleanup=null;
    const change=report.changes.find(item=>item.id===state.selectedId);
    if(!change) { $('.hx-details').innerHTML='';return; }
    const before=change.before,after=change.after;
    const sharedModes=before && after ? before.modes.filter(oldMode=>after.modes.some(newMode=>newMode.id===oldMode.id)) : [];
    const sharedModeTitle=oldMode=>{
      const newMode=after.modes.find(item=>item.id===oldMode.id);
      const oldTitle=firingModeTitle(oldMode),newTitle=firingModeTitle(newMode);
      return oldTitle===newTitle ? oldTitle : `${oldTitle} → ${newTitle}`;
    };
    if(!sharedModes.some(item=>item.id===state.modeIdForCurve)) state.modeIdForCurve=sharedModes[0]?.id || null;
    const title=after?.name || before?.name;
    const fields=change.fields || [];
    const snapshotNotice=change.status==='added' ? '这把武器仅出现在新版数据库中，当前没有对应旧版可绘制前后曲线。' : change.status==='removed' ? '这把武器仅出现在旧版数据库中，当前没有对应新版可绘制前后曲线。' : '';
    $('.hx-details').innerHTML=`<section class="panel hx-detail-panel"><div class="panel-heading"><div><span class="eyebrow">SELECTED WEAPON / 变动详情</span><h2 tabindex="-1" data-history-detail-title>${escapeHtml(title)}</h2></div><span class="hx-status hx-status-${change.status}">${STATUS[change.status]}</span></div>
      <div class="hx-snapshot-labels"><span><i style="background:${getSeriesStyle(0).color}"></i>旧版：${escapeHtml(versionTitle(oldVersion))}</span><span><i style="background:${getSeriesStyle(1).color}"></i>新版：${escapeHtml(versionTitle(newVersion))}</span></div>
      ${fields.length?`<div class="hx-table-scroll"><table class="range-table hx-field-table"><thead><tr><th>字段</th><th>旧值</th><th>新值</th><th>变化</th></tr></thead><tbody>${fields.map(field=>`<tr><td>${escapeHtml(field.label || field.key)}</td><td>${escapeHtml(valueText(field.before,field))}</td><td>${escapeHtml(valueText(field.after,field))}</td><td><span class="hx-direction hx-direction-${field.direction || 'neutral'}">${escapeHtml(DIRECTION[field.direction] || '调整')}</span><span class="hx-delta">${escapeHtml(differenceText(field))}</span></td></tr>`).join('')}</tbody></table></div>`:`<div class="panel-body"><p class="muted">${snapshotNotice || '这把武器的记录字段没有发生变化。'}</p>${snapshotNotice?weaponSummary(after || before):''}</div>`}
      ${change.rangeChanges?.length?`<div class="hx-derived-heading"><h3>推算出的分段伤害变化</h3><p class="inline-note">将两版射程断点合并后比较，展示实际参与计算的整数伤害。</p></div><div class="hx-table-scroll"><table class="range-table hx-range-change-table"><thead><tr><th>距离</th><th>基础伤害：旧 → 新</th><th>部位伤害：旧 → 新</th></tr></thead><tbody>${change.rangeChanges.map(range=>`<tr><td>${number(range.from)}–${range.to===null?'∞':number(range.to)} m</td><td>${number(range.beforeDamage,0)} → ${number(range.afterDamage,0)}</td><td><div class="hx-part-changes">${BODY_PARTS.filter(part=>range.beforeParts?.[part.id]!==range.afterParts?.[part.id]).map(part=>`<span>${escapeHtml(part.label)} <b>${number(range.beforeParts?.[part.id],0)} → ${number(range.afterParts?.[part.id],0)}</b></span>`).join('') || '<span>部位整数伤害未变化</span>'}</div></td></tr>`).join('')}</tbody></table></div>`:''}
    </section>
    ${before && after ? `<section class="panel hx-curve-panel"><div class="panel-heading"><h2>TTK 前后对照</h2><span class="tag outline">相同计算条件</span></div>${sharedModes.length?`<div class="panel-body hx-conditions"><label class="field"><span>目标血量</span><select data-history-condition="health" aria-label="历史曲线目标血量">${[100,150,300].map(value=>`<option value="${value}"${state.health===value?' selected':''}>${value} HP</option>`).join('')}</select></label><label class="field"><span>命中部位</span><select data-history-condition="part" aria-label="历史曲线命中部位">${BODY_PARTS.map(part=>`<option value="${part.id}"${state.part===part.id?' selected':''}>${escapeHtml(part.label)}</option>`).join('')}</select></label><label class="field"><span>共有射击模式</span><select data-history-condition="mode" aria-label="历史曲线射击模式">${sharedModes.map(mode=>`<option value="${escapeHtml(mode.id)}"${state.modeIdForCurve===mode.id?' selected':''}>${escapeHtml(sharedModeTitle(mode))}</option>`).join('')}</select></label><label class="field"><span>图表距离</span><select data-history-condition="max" aria-label="历史曲线最大距离">${[100,200,300,500].map(value=>`<option value="${value}"${state.chartMax===value?' selected':''}>${value} m</option>`).join('')}</select></label><label class="switch-label hx-travel"><input type="checkbox" data-history-condition="travel"${state.includeTravel?' checked':''}>计入子弹飞行时间</label><label class="field hx-distance"><span>查看距离（米）</span><input type="number" min="0" max="${state.chartMax}" step="0.1" value="${state.distance}" data-history-condition="distance" aria-label="历史曲线查看距离"></label></div><div class="hx-comparison-results"></div><div class="hx-curve-chart"></div><p class="inline-note hx-curve-note">固定部位连续命中。两版使用各自参数与相同计算口径；较低 TTK 表示在这些条件下更快击杀。</p>`:'<div class="hx-empty"><h3>两个版本没有可直接对应的射击模式</h3><p>这两个版本的射击方式无法对应，因此暂不绘制前后曲线；字段差异仍可查看。</p></div>'}</section>`:''}`;
    if(before && after && sharedModes.length) updateComparison(change);
  }

  function updateComparison(change) {
    chartCleanup?.();chartCleanup=null;
    const before=change.before,after=change.after;
    if(!before || !after || !$('.hx-curve-chart')) return;
    try {
      const parameters={health:state.health,part:state.part,modeId:state.modeIdForCurve,includeTravel:state.includeTravel};
      const results=[calculate(before,{...parameters,distance:state.distance}),calculate(after,{...parameters,distance:state.distance})];
      const delta=results[1].ttk-results[0].ttk;
      $('.hx-comparison-results').innerHTML=`${results.map((result,index)=>`<div class="hx-result"><span><i style="background:${getSeriesStyle(index).color}"></i>${index?'新版':'旧版'} · ${number(state.distance)} m</span><strong>${number(result.ttk)} <small>ms</small></strong><small>${number(result.displayBtk,0)} 发 · ${partLabel(state.part)}伤害 ${number(result.damage,0)}</small></div>`).join('')}<div class="hx-result hx-result-delta"><span>TTK 变化</span><strong class="${finite(delta)?delta<0?'hx-better':delta>0?'hx-worse':'':''}">${finite(delta)?`${delta>0?'+':''}${number(delta)}`:'—'} <small>ms</small></strong><small>${finite(delta)?delta<0?'新版击杀更快':delta>0?'新版击杀更慢':'当前距离击杀时间相同':'当前条件无法比较有限击杀时间'}</small></div>`;
      const points=[0,state.chartMax];
      [before,after].forEach(weapon=>weapon.ranges.forEach(range=>{if(range.until!==null&&range.until>0&&range.until<=state.chartMax)points.push(range.until,Math.max(0,range.until-.000001));}));
      const distances=[...new Set(points)].sort((a,b)=>a-b);
      const series=[before,after].map((weapon,index)=>({id:`${index}-${weapon.id}`,name:`${index?'新版':'旧版'} · ${index?(newVersion?.label || '所选版本'):(oldVersion?.label || '所选版本')}`,...getSeriesStyle(index),points:distances.map(distance=>{const result=calculate(weapon,{...parameters,distance});return{distance,ttk:result.ttk,btk:result.displayBtk};})}));
      chartCleanup=renderChart($('.hx-curve-chart'),{series,maxDistance:state.chartMax,health:state.health,includeTravel:state.includeTravel,selectedDistance:state.distance,onDistance:distance=>{
        state.distance=Math.min(state.chartMax,Math.max(0,Math.round(distance*10)/10));
        const input=$('[data-history-condition="distance"]');if(input)input.value=state.distance;
        updateComparison(change);
      }});
    }catch(calculationError) {
      $('.hx-comparison-results').innerHTML='';
      $('.hx-curve-chart').innerHTML=`<div class="error-box">${escapeHtml(calculationError.message || calculationError)}</div>`;
    }
  }

  container.addEventListener('click', event=>{
    const button=event.target.closest('[data-history-weapon]');
    if(!button || !container.contains(button)) return;
    state.selectedId=state.selectedId===button.dataset.historyWeapon?null:button.dataset.historyWeapon;
    renderList();renderDetails();
    if(state.selectedId) {
      const motion=window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
      $('.hx-details').scrollIntoView({behavior:motion,block:'start'});
      $('[data-history-detail-title]')?.focus({preventScroll:true});
    } else $$('[data-history-weapon]').find(item=>item.dataset.historyWeapon===button.dataset.historyWeapon)?.focus({preventScroll:true});
  }, {signal:controller.signal});
  container.addEventListener('input',event=>{
    if(event.target.matches('[data-history-search]')) {state.query=event.target.value;renderList();}
  }, {signal:controller.signal});
  container.addEventListener('change',event=>{
    const target=event.target;
    if(target.matches('[data-history-only-changed]')) {state.onlyChanged=target.checked;renderList();return;}
    const key=target.dataset.historyCondition;
    if(!key)return;
    if(key==='health')state.health=Number(target.value);
    else if(key==='part')state.part=target.value;
    else if(key==='mode')state.modeIdForCurve=target.value;
    else if(key==='travel')state.includeTravel=target.checked;
    else if(key==='distance') {
      const value=Number(target.value);if(target.value==='' || !finite(value)){target.value=state.distance;return;}
      state.distance=Math.max(0,Math.min(state.chartMax,value));target.value=state.distance;
    }else if(key==='max') {state.chartMax=Number(target.value);state.distance=Math.min(state.distance,state.chartMax);const input=$('[data-history-condition="distance"]');input.max=state.chartMax;input.value=state.distance;}
    const change=report.changes.find(item=>item.id===state.selectedId);if(change)updateComparison(change);
  }, {signal:controller.signal});
  renderList();renderDetails();
  return cleanup;
}
