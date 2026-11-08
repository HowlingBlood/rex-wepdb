import { BODY_PARTS, validateDatabase, validateWeapon, rangeAt, calculate, inferMultiplier, roundHalfUp, deriveDamage, normalizeWeapon, normalizeDatabase, MULTIPLIER_DIGITS } from './engine.js?v=1.2.1';
import { DEMO_DATABASE } from './demo-data.js?v=1.2.1';
import { renderBody, renderChart, getSeriesStyle } from './visuals.js?v=1.2.1';

const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const clone = value => structuredClone(value);
const uid = () => globalThis.crypto?.randomUUID?.() || `w-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
const fmt = (n, digits = 1) => Number.isFinite(n) ? new Intl.NumberFormat('zh-CN', { maximumFractionDigits: digits }).format(n) : n === Infinity ? '∞' : '—';
const num = v => String(v ?? '').trim() === '' ? NaN : Number(v);
const roundInput = (value,digits=0) => {try{return roundHalfUp(value,digits);}catch{return value;}};
const bodyDamage = (base,multiplier) => {try{return deriveDamage(base,multiplier);}catch{return NaN;}};
const multiplierValue = value => Number.isFinite(value) ? roundInput(value,MULTIPLIER_DIGITS).toFixed(MULTIPLIER_DIGITS) : '';
const STORE = 'weapon-atlas.database.v1';
const DRAFT = 'weapon-atlas.editor.v1';
const BACKUP = 'weapon-atlas.backup.v1';
const DEFAULT_PROBS = {head:10,neck:5,chest:45,abdomen:20,upperArm:10,forearm:5,thigh:3,calf:2};
const TYPE_NAMES = {auto:'全自动',semi:'半自动',bolt:'栓动 / 泵动',burst:'点射'};
let storageAvailable = true, databaseUnsaved = false;
function readStore(key) { try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch { return null; } }
function writeStore(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); storageAvailable = true; updateStorageStatus(); return true; }
  catch { storageAvailable = false; toast('浏览器无法保存草稿，请及时导出 JSON。', true); updateStorageStatus(); return false; }
}
const stored = readStore(STORE);
const db = normalizeDatabase(stored && validateDatabase(stored).valid ? stored : DEMO_DATABASE);
function usableDraft(draft) {
  const w=draft?.weapon;
  return w && typeof w.id==='string' && typeof w.name==='string' && w.multipliers &&
    BODY_PARTS.every(p=>Object.hasOwn(w.multipliers,p.id)) && Array.isArray(w.ranges) && w.ranges.length>0 &&
    w.ranges.every(r=>r&&typeof r==='object'&&Object.hasOwn(r,'damage')&&Object.hasOwn(r,'until')) &&
    Array.isArray(w.modes) && w.modes.length>0 && w.modes.every(m=>m&&typeof m.id==='string'&&typeof m.name==='string'&&['auto','semi','bolt','burst'].includes(m.type));
}
const rawDraft = readStore(DRAFT);
const savedDraft = usableDraft(rawDraft) ? {...rawDraft,weapon:normalizeWeapon(rawDraft.weapon)} : null;
const state = {
  db, activeId:db.weapons[0]?.id, compare:new Set(), view:location.hash === '#maintenance' ? 'maintain' : 'analysis',
  health:100, distance:10, chartMax:100, includeTravel:false, part:'chest', mixed:false,
  probabilities:{...DEFAULT_PROBS}, bodyView:'damage', modeIds:{},
  temp:null, tempActive:false, editor:savedDraft?.weapon || null, editorDirty:!!savedDraft?.weapon,
  editorTemporary:!!savedDraft?.temporary, refRange:0, editorPart:'head', search:'', category:'', errors:[],
};
let bodyCleanup = null, chartCleanup = null, editorBodyCleanup = null;
let calculationCache = new Map();
let toastTimer;
const main = $('#main-content');

function toast(message, error = false) {
  clearTimeout(toastTimer); const el = $('#toast'); el.textContent = message;
  el.className = `toast show${error ? ' error' : ''}`;
  toastTimer = setTimeout(() => el.classList.remove('show'), 4200);
}
function updateStorageStatus() {
  const el = $('#storage-status');
  if (el) el.innerHTML = `<i></i> ${storageAvailable&&!databaseUnsaved ? '本地数据就绪' : '请导出备份'}`;
}
function persistDatabase() { state.db=normalizeDatabase(state.db);state.db.updatedAt = new Date().toISOString(); const success=writeStore(STORE, state.db);databaseUnsaved=!success;updateStorageStatus();calculationCache.clear();return success; }
function persistEditor() {
  state.editorDirty = true;
  writeStore(DRAFT, {weapon:state.editor,temporary:state.editorTemporary});
  const badge = $('#editor-save-state'); if (badge) badge.textContent = '有未保存修改 · 已保留本地草稿';
}
function clearDraft() { state.editorDirty = false; try { localStorage.removeItem(DRAFT); } catch {} }
function activeWeapon() { return state.tempActive ? state.temp : state.db.weapons.find(w => w.id === state.activeId); }
function activeMode(w) { return w.modes.find(m => m.id === state.modeIds[w.id]) || w.modes[0]; }
function partLabel(part) { return BODY_PARTS.find(p => p.id === part)?.label || part; }
function rangeLabel(w, i) { return `${i ? fmt(w.ranges[i-1].until) : '0'}–${w.ranges[i].until === null ? '∞' : fmt(w.ranges[i].until)} m`; }
function isDemo(w) { return !!w?.notes?.includes('示例'); }
function modeRPM(mode) { return mode.type === 'bolt' ? 60000 / mode.cycleMs : mode.rpm; }
function updateSelectionButton() {
  const button=$('#clear-selection');button.disabled=state.compare.size===0;
  button.textContent=state.compare.size?`取消已选 (${state.compare.size})`:'取消已选';
  button.setAttribute('aria-label',`取消全部已选武器，当前已选 ${state.compare.size} 把`);
}
function clearSelections() {
  state.compare.clear();$$('[data-compare]',$('#weapon-roster')).forEach(input=>input.checked=false);
  updateSelectionButton();if(state.view==='analysis')updateAnalysis();toast('已取消全部多选武器。');
}
function showDialog({title,body,confirmText='确认',onConfirm,danger=false}) {
  const dialog = $('#app-dialog');
  if (dialog.open) dialog.close();
  dialog.innerHTML = `<h2>${esc(title)}</h2>${body}<div class="dialog-actions"><button class="button ghost" data-cancel>取消</button>${onConfirm ? `<button class="button${danger ? ' danger' : ''}" data-confirm>${esc(confirmText)}</button>` : '<button class="button" data-cancel>知道了</button>'}</div>`;
  $$('[data-cancel]', dialog).forEach(button=>button.onclick = () => dialog.close());
  const confirm = $('[data-confirm]', dialog);
  if (confirm) confirm.onclick = () => { const result = onConfirm(dialog); if (result !== false) dialog.close(); };
  dialog.showModal();
}
async function protectEditor(action) {
  if (state.editorDirty && state.editor) {
    showDialog({title:'保留当前编辑？',body:'<p>当前武器还有未保存的修改。你可以取消并先保存，或放弃这些修改后继续。</p>',confirmText:'放弃修改并继续',onConfirm:()=>{ clearDraft(); state.editor=null; action(); }});
  } else action();
}
function newWeapon() {
  return {id:uid(),name:'未命名武器',category:'自定义',notes:'',velocity:600,triggerDelayMs:0,
    ranges:[{until:20,damage:30},{until:null,damage:24}],
    multipliers:{head:1.5,neck:1.1,chest:1,abdomen:1,upperArm:.9,forearm:.9,thigh:.9,calf:.9},
    modes:[{id:uid(),name:'全自动',type:'auto',rpm:720,cycleMs:1000,burstSize:3,gapMs:200}]};
}
function renderSidebar() {
  updateSelectionButton();
  $('#weapon-count').textContent = state.db.weapons.length;
  const categorySelect = $('#category-filter');
  categorySelect.innerHTML = `<option value="">全部类别</option>${[...new Set(state.db.weapons.map(w=>w.category).filter(Boolean))].map(c=>`<option value="${esc(c)}">${esc(c)}</option>`).join('')}`;
  categorySelect.value = state.category;
  const weapons = state.db.weapons.filter(w => (!state.category || w.category === state.category) && w.name.toLowerCase().includes(state.search.toLowerCase()));
  $('#weapon-roster').innerHTML = weapons.length ? weapons.map((w,i)=>`<div class="weapon-row${!state.tempActive && w.id === state.activeId ? ' active' : ''}">
    <button class="weapon-select" data-weapon="${esc(w.id)}" aria-label="查看 ${esc(w.name)}"><strong>${esc(w.name)}</strong><small><span>${esc(w.category || '未分类')}</span><span>${esc(TYPE_NAMES[w.modes[0].type])}</span></small></button>
    <input type="checkbox" data-compare="${esc(w.id)}" ${state.compare.has(w.id)?'checked':''} aria-label="将 ${esc(w.name)} 加入对比" title="加入对比">
  </div>`).join('') : '<p class="no-results">没有匹配的武器</p>';
}
function cleanupVisuals() {
  bodyCleanup?.(); chartCleanup?.(); editorBodyCleanup?.(); bodyCleanup=chartCleanup=editorBodyCleanup=null;
}
function render() {
  cleanupVisuals();
  $$('.main-nav button').forEach(b=>b.classList.toggle('active',b.dataset.view === state.view));
  renderSidebar();
  if (state.view === 'maintain') renderEditor(); else renderAnalysis();
}
function modeOptions(w) { return w.modes.map(m=>`<option value="${esc(m.id)}" ${activeMode(w).id===m.id?'selected':''}>${esc(m.name || TYPE_NAMES[m.type])}</option>`).join(''); }
function renderAnalysis() {
  const w = activeWeapon();
  if (!w) {
    main.innerHTML = `<div class="empty-library"><span class="eyebrow">YOUR ARMORY STARTS HERE</span><h1>建立你的第一份武器数据</h1><p>导入 JSON 武器库，或从名称、伤害与射速开始，创建一把武器。也可以直接进入自由试算。</p><div class="heading-tools"><button class="button" data-action="new">＋ 新建武器</button><button class="button ghost" data-action="temp">自由试算 ↗</button></div></div>`;
    return;
  }
  main.innerHTML = `
    <div class="page-heading"><div><span class="eyebrow">ARMORY INTELLIGENCE / 武器分析</span><h1>${esc(w.name)}</h1><p>${esc(w.category || '未分类')} <span class="muted">/</span> ${state.tempActive?'临时数据 · 未写入武器库':`${w.ranges.length} 个射程段 · ${w.modes.length} 种射击模式`}</p></div><div class="heading-tools"><span class="tag${isDemo(w)?' demo':''}">${state.tempActive?'自由试算':isDemo(w)?'示例数据':'自建数据'}</span><button class="button ghost compact" data-action="edit-current">${state.tempActive?'返回编辑':'编辑武器'} ↗</button></div></div>
    ${state.editorDirty?'<div class="notice">有一份未保存的编辑草稿。<button class="text-button" data-action="resume-draft">继续编辑 ↗</button></div>':''}
    <div class="control-bar"><div class="control-group"><span>目标血量</span><div class="segmented" aria-label="目标血量">${[100,150,300].map(h=>`<button data-health="${h}" class="${state.health===h?'active':''}" aria-pressed="${state.health===h}">${h}</button>`).join('')}</div></div>
      <label class="switch-label"><input id="travel-toggle" type="checkbox" ${state.includeTravel?'checked':''}>计入子弹飞行时间</label>
      <div class="distance-control"><span class="control-label">距离</span><input id="distance-slider" type="range" min="0" max="${state.chartMax}" step="0.1" value="${state.distance}" aria-label="计算距离"><input id="distance-value" type="number" min="0" max="10000" step="0.1" value="${state.distance}" aria-label="距离（米）"><span class="unit">m</span></div>
    </div>
    <div class="stat-grid" id="stat-grid"></div>
    <div class="analysis-grid"><section class="panel"><div class="panel-heading"><h2><span class="section-index">01</span> 部位伤害分布</h2><span class="eyebrow" id="body-range-caption"></span></div><div class="body-toolbar"><span>点击部位切换命中区域</span><div class="segmented"><button data-body-view="damage" class="${state.bodyView==='damage'?'active':''}">伤害</button><button data-body-view="probability" class="${state.bodyView==='probability'?'active':''}">概率</button></div></div><div id="analysis-body" class="body-diagram"></div><div id="selected-part"></div></section>
      <div class="chart-column"><section class="panel"><div class="panel-heading"><h2><span class="section-index">02</span> 距离与 TTK</h2><div class="section-toolbar"><select id="analysis-mode" aria-label="当前武器射击模式">${modeOptions(w)}</select><select id="chart-max" aria-label="图表最大距离">${[50,100,200,300,500,...(![50,100,200,300,500].includes(state.chartMax)?[state.chartMax]:[])].sort((a,b)=>a-b).map(n=>`<option value="${n}"${state.chartMax===n?' selected':''}>${n} m</option>`).join('')}</select></div></div><div id="ttk-chart" class="chart-container"></div><div class="chart-bottom"><span>点击曲线区域选择距离</span><span id="chart-comparison-caption"></span></div></section>
      <section class="panel"><div class="panel-heading"><h2><span class="section-index">03</span> 射程分段</h2><span class="muted" id="range-table-caption"></span></div><div id="range-table"></div></section></div>
    </div>
    <div class="below-grid"><section class="panel"><div class="panel-heading"><h2><span class="section-index">04</span> 混合命中方案</h2><label class="switch-label"><input id="mixed-toggle" type="checkbox" ${state.mixed?'checked':''}>启用混合计算</label></div><div class="panel-body"><div class="probability-inputs">${BODY_PARTS.map(p=>`<label class="field"><span>${esc(p.label)}</span><div class="input-unit"><input type="number" min="0" max="100" step="0.1" value="${state.probabilities[p.id]||0}" data-probability="${p.id}" aria-label="${esc(p.label)}命中概率"><span>%</span></div></label>`).join('')}</div><div class="probability-footer"><span id="probability-total"></span><div><button class="text-button" data-preset="chest">全胸部</button><button class="text-button" data-preset="balanced">默认分布</button></div></div><p class="inline-note">各发独立按部位概率命中，默认全部命中。混合结果为概率加权的期望击杀时间。</p></div></section>
      <section class="panel"><div class="panel-heading"><h2><span class="section-index">05</span> 击杀发数分布</h2><span id="distribution-caption" class="muted"></span></div><div class="panel-body"><div id="distribution" class="distribution-list"></div><p class="inline-note" id="distribution-note"></p></div></section></div>
    <div id="comparison-panel"></div>
    ${isDemo(w)?'<p class="inline-note">＊ 当前为虚构示例武器，用于演示计算与页面交互，不代表任何游戏的实际平衡数据。</p>':''}
  `;
  updateAnalysis();
}
function probabilityTotal() { return Object.values(state.probabilities).reduce((a,b)=>a+b,0); }
function getResult(w, distance) {
  if (state.mixed && (Object.values(state.probabilities).some(p=>!Number.isFinite(p)||p<0||p>100) || Math.abs(probabilityTotal()-100)>1e-6)) throw new Error('命中概率必须为 0–100%，且合计为 100%。');
  const ri = rangeAt(w, distance).index;
  const mode = activeMode(w);
  const key = JSON.stringify([w,ri,mode.id,state.health,state.mixed?state.probabilities:state.part]);
  let result = calculationCache.get(key);
  if (!result) {
    result = calculate(w,{distance,health:state.health,part:state.part,modeId:mode.id,includeTravel:false,probabilities:state.mixed?state.probabilities:null});
    calculationCache.set(key,result);
  }
  const travel = state.includeTravel ? distance / w.velocity * 1000 : 0;
  return {...result,travelMs:travel,ttk:result.ttk+travel,distribution:result.distribution.map(d=>({...d,ttk:d.ttk+travel}))};
}
function updateAnalysis() {
  const w = activeWeapon(); if (!w || !$('#stat-grid')) return;
  bodyCleanup?.(); chartCleanup?.(); bodyCleanup=chartCleanup=null;
  const total=probabilityTotal();
  $('#probability-total').innerHTML = `概率合计 <strong class="${Math.abs(total-100)>1e-6?'invalid':'accent'}">${fmt(total,2)}%</strong>`;
  let result;
  try { result=getResult(w,state.distance); }
  catch (e) {
    $('#stat-grid').innerHTML = `<div class="error-box" style="grid-column:1/-1">${esc(e.message)}</div>`;
    $('#ttk-chart').innerHTML=`<div class="chart-error">${esc(e.message)}</div>`;
    $('#distribution').innerHTML='<span class="muted">调整参数后重新计算</span>';
    $('#distribution-note').textContent='';
    $('#comparison-panel').innerHTML='';
  }
  const currentRange=rangeAt(w,state.distance), base=currentRange.range.damage;
  const damageValues=Object.fromEntries(BODY_PARTS.map(p=>[p.id,bodyDamage(base,w.multipliers[p.id])]));
  bodyCleanup=renderBody($('#analysis-body'),{values:state.bodyView==='probability'?Object.fromEntries(BODY_PARTS.map(p=>[p.id,(state.probabilities[p.id]||0)/100])):damageValues,selected:state.part,view:state.bodyView,onSelect:part=>{state.part=part;updateAnalysis();}});
  $('#body-range-caption').textContent=rangeLabel(w,currentRange.index);
  $('#selected-part').innerHTML=`<div class="selected-part"><div><strong>${esc(partLabel(state.part))}</strong><small>全程倍率 ×${multiplierValue(w.multipliers[state.part])} · 当前距离 ${fmt(state.distance)} m</small></div><div class="selected-part-value">${fmt(damageValues[state.part],0)}<small>伤害</small></div></div>`;
  $('#range-table-caption').textContent=`${partLabel(state.part)} · ${state.health} HP`;
  $('#range-table').innerHTML=`<table class="range-table"><thead><tr><th>距离区间</th><th>基础伤害</th><th>${esc(partLabel(state.part))}伤害</th><th>BTK</th></tr></thead><tbody>${w.ranges.map((range,i)=>{
    let btk='—';try{btk=fmt(calculate(w,{distance:i?w.ranges[i-1].until:0,health:state.health,part:state.part,modeId:activeMode(w).id}).btk);}catch{}
    return `<tr class="${i===currentRange.index?'current':''}"><td>${i===currentRange.index?'<span class="range-dot"></span>':''}${rangeLabel(w,i)}</td><td>${fmt(range.damage,0)}</td><td>${fmt(bodyDamage(range.damage,w.multipliers[state.part]),0)}</td><td>${btk} 发</td></tr>`;
  }).join('')}</tbody></table>`;
  if (!result) return;
  const mode=activeMode(w);
  const stat=(label,english,value,unit,sub,primary=false)=>`<div class="stat-card${primary?' primary':''}"><div class="stat-label">${label}<span class="eyebrow">${english}</span></div><div class="stat-value">${value}<small>${unit}</small></div><div class="stat-sub">${sub}</div></div>`;
  $('#stat-grid').innerHTML=stat(state.mixed?'期望击杀时间':'击杀时间','TIME TO KILL',result.impossible?'无法击杀':fmt(result.ttk),result.impossible?'':'ms',`射击 ${fmt(result.shotMs)} + 扳机 ${fmt(result.triggerMs)} + 飞行 ${fmt(result.travelMs)} ms`,true)
    +stat(state.mixed?'期望击杀发数':'击杀所需发数','BULLETS TO KILL',fmt(result.displayBtk,0),'发',state.mixed?'向上取整显示；TTK 按完整分布计算':`${partLabel(state.part)}连续命中 · ${state.health} HP`)
    +stat(state.mixed?'平均单发伤害':'部位单发伤害','DAMAGE',fmt(result.damage,0),'',state.mixed?'仅作参考，TTK 按完整概率分布计算':`基础伤害 ${fmt(base,0)} × ${multiplierValue(w.multipliers[state.part])}`)
    +stat(mode.type==='burst'?'组内射速':'射击速度','FIRE RATE',fmt(modeRPM(mode)),'RPM',mode.type==='bolt'?`完整拉栓周期 ${fmt(mode.cycleMs)} ms`:mode.type==='burst'?`${mode.burstSize} 连发 · 组间 ${fmt(mode.gapMs)} ms`:`枪间隔 ${fmt(60000/mode.rpm)} ms`);
  $('#distribution-caption').textContent=state.mixed?'独立部位命中':'固定部位命中';
  const distribution=result.distribution.filter(d=>d.probability>=1e-7);
  $('#distribution').innerHTML=result.impossible?'<span class="muted">当前伤害无法击杀目标。</span>':distribution.slice(0,40).map(d=>`<div class="distribution-row"><span>${d.shots} 发</span><div class="prob-bar"><span style="width:${Math.min(100,d.probability*100)}%"></span></div><span>${fmt(d.probability*100,2)}%</span><span>${fmt(d.ttk)} ms</span></div>`).join('');
  $('#distribution-note').textContent=result.distributionTruncated||distribution.length>40?`仅展示主要分布，期望值使用完整计算。${result.distributionTailProbability?`未展开尾概率 ${fmt(result.distributionTailProbability*100,8)}%。`:''}`:state.mixed?'先计算击杀发数的概率，再按发射时间轴加权；跨点射组等待已计入。':'当前显示固定部位结果；开启混合计算可查看不同击杀发数的概率。';
  const ids=[...new Set([w.id,...state.compare])];
  const weapons=ids.map(id=>id===w.id?w:state.db.weapons.find(item=>item.id===id)).filter(Boolean);
  const series=[];const failures=[];
  weapons.forEach((weapon,i)=>{
    try {
      const points=[0,state.chartMax];
      weapon.ranges.forEach(r=>{if(r.until!==null&&r.until>0&&r.until<=state.chartMax){points.push(Math.max(0,r.until-0.000001),r.until);}});
      const unique=[...new Set(points)].sort((a,b)=>a-b);
      series.push({id:weapon.id,name:weapon.name,...getSeriesStyle(i),points:unique.map(distance=>{const r=getResult(weapon,distance);return{distance,ttk:r.ttk,btk:r.displayBtk};})});
    }catch(e){failures.push(`${weapon.name}：${e.message}`);}
  });
  if (series.some(s=>s.points.some(p=>Number.isFinite(p.ttk)))) chartCleanup=renderChart($('#ttk-chart'),{series,maxDistance:state.chartMax,health:state.health,includeTravel:state.includeTravel,selectedDistance:state.distance,onDistance:setDistance});
  else $('#ttk-chart').innerHTML='<div class="chart-error">当前条件无法形成有效的击杀曲线。</div>';
  $('#chart-comparison-caption').textContent=failures.length?`部分武器无法计算：${failures.join('；')}`:`${state.mixed?'混合命中':partLabel(state.part)} · ${weapons.length>1?`${weapons.length} 把武器对比`:'单武器分析'}`;
  $('#comparison-panel').innerHTML=weapons.length>1?`<section class="panel compare-table-wrap"><div class="panel-heading"><h2>武器横向对比 <span class="tag outline">${fmt(state.distance)} m · ${state.health} HP</span></h2><button class="text-button compare-clear" data-action="clear-compare">清空对比</button></div><table class="range-table"><thead><tr><th>武器</th><th>射击模式</th><th>${state.mixed?'期望 ':''}TTK</th><th>${state.mixed?'期望 ':''}BTK</th><th>弹速</th></tr></thead><tbody>${weapons.map((weapon,i)=>{
    let r;try{r=getResult(weapon,state.distance);}catch(e){return`<tr><td>${esc(weapon.name)}</td><td colspan="4">${esc(e.message)}</td></tr>`;}
    return`<tr><td><span class="weapon-key" style="background:${getSeriesStyle(i).color}"></span>${esc(weapon.name)}</td><td><select data-compare-mode="${esc(weapon.id)}" aria-label="${esc(weapon.name)}的对比射击模式">${modeOptions(weapon)}</select></td><td class="accent">${fmt(r.ttk)} ms</td><td>${fmt(r.displayBtk,0)} 发</td><td>${fmt(weapon.velocity)} m/s</td></tr>`;
  }).join('')}</tbody></table></section>`:'';
}
function setDistance(d) {
  if(!Number.isFinite(Number(d)))return;state.distance=Math.max(0,Math.min(10000,Math.round(Number(d)*10)/10));
  if(state.distance>state.chartMax){state.chartMax=Math.ceil(state.distance/50)*50;renderAnalysis();return;}
  const slider=$('#distance-slider'),input=$('#distance-value');
  if(slider)slider.value=state.distance;if(input&&document.activeElement!==input)input.value=state.distance;
  updateAnalysis();
}

function renderEditor() {
  if (!state.editor) { const w=activeWeapon();state.editor=w?clone(w):newWeapon();state.editorTemporary=state.tempActive;if(!w)persistEditor(); }
  const w=state.editor; state.refRange=Math.min(state.refRange,w.ranges.length-1);
  main.innerHTML=`<div class="page-heading"><div><span class="eyebrow">${state.editorTemporary?'SANDBOX / 自由试算':'DATABASE WORKSHOP / 数据维护'}</span><h1>${state.editorTemporary?'构建你的试算武器':'维护武器数据'}</h1><p>${state.editorTemporary?'手动填写参数，使用完整的伤害与 TTK 计算。':'每个射程独立设置基础伤害，所有射程共用部位倍率。'}</p></div><div class="heading-tools">${!state.editorTemporary?`<button class="button ghost compact" data-action="duplicate">复制武器</button>${state.db.weapons.some(item=>item.id===w.id)?'<button class="button ghost compact" data-action="delete">删除</button>':''}`:'<span class="tag">不写入武器库</span>'}</div></div>
    <div id="editor-errors">${state.errors.length?`<div class="error-box">${state.errors.map(esc).join('\n')}</div>`:''}</div>
    <form id="weapon-form" novalidate><div class="editor-grid"><div class="editor-column">
      <section class="panel"><div class="panel-heading"><h2><span class="section-index">01</span> 基础信息</h2><span class="eyebrow">IDENTITY</span></div><div class="panel-body form-grid"><label class="field"><span>武器名称</span><input data-field="name" value="${esc(w.name)}" maxlength="100" required></label><label class="field"><span>武器类别</span><input data-field="category" value="${esc(w.category)}" maxlength="60" placeholder="例如：突击步枪"></label><label class="field"><span>子弹速度 <small>m/s</small></span><input data-field="velocity" type="number" min="0.001" step="any" value="${w.velocity}" required></label><label class="field"><span>首发扳机延迟 <small>ms</small></span><input data-field="triggerDelayMs" type="number" min="0" step="any" value="${w.triggerDelayMs}" required></label><label class="field wide"><span>备注 / 数据来源</span><textarea data-field="notes" maxlength="2000" placeholder="记录数据来源、测量说明等">${esc(w.notes)}</textarea></label></div></section>
      <section class="panel"><div class="panel-heading"><h2><span class="section-index">02</span> 基础伤害与射程</h2><button type="button" class="text-button" data-action="add-range">＋ 添加射程段</button></div><div class="panel-body">${w.ranges.map((r,i)=>`<div class="range-edit-row" data-range-row="${i}"><span class="range-index">${String(i+1).padStart(2,'0')}</span><label class="field"><span>${i===w.ranges.length-1?'最后一段至':'结束距离'} <small>m</small></span><input data-range-until="${i}" ${i===w.ranges.length-1?'value="∞" disabled':`type="number" min="0.001" step="any" value="${r.until}"`}></label><label class="field"><span>基础伤害</span><input data-range-damage="${i}" type="number" min="1" step="1" value="${r.damage}"></label><button type="button" class="icon-button" data-remove-range="${i}" ${w.ranges.length===1?'disabled':''} aria-label="删除第 ${i+1} 个射程段">×</button></div>`).join('')}<p class="range-edit-help">每段从上一段结束距离开始；边界归入下一段，最后一段延伸至无限远。</p></div></section>
      <section class="panel"><div class="panel-heading"><h2><span class="section-index">03</span> 射击模式</h2><button type="button" class="text-button" data-action="add-mode">＋ 添加模式</button></div><div class="panel-body">${w.modes.map((m,i)=>`<div class="editor-mode" data-mode-row="${i}"><div class="mode-heading"><select data-mode-field="type" data-mode-index="${i}" aria-label="模式 ${i+1} 类型">${Object.entries(TYPE_NAMES).map(([key,name])=>`<option value="${key}" ${m.type===key?'selected':''}>${name}</option>`).join('')}</select><input data-mode-field="name" data-mode-index="${i}" value="${esc(m.name)}" maxlength="60" aria-label="模式 ${i+1} 名称"><button type="button" class="text-button" data-remove-mode="${i}" ${w.modes.length===1?'disabled':''}>移除</button></div><div class="mode-fields">${m.type==='bolt'?`<label class="field"><span>完整拉栓间隔 <small>ms</small></span><input type="number" min="0.001" step="any" data-mode-field="cycleMs" data-mode-index="${i}" value="${m.cycleMs??''}"></label><label class="field"><span>折算射速 <small>RPM</small></span><input value="${fmt(60000/(m.cycleMs??''),3)}" disabled data-bolt-rpm="${i}"></label>`:`<label class="field"><span>${m.type==='burst'?'组内射速':'射速'} <small>RPM</small></span><input type="number" min="0.001" step="any" data-mode-field="rpm" data-mode-index="${i}" value="${m.rpm??''}"></label>${m.type==='burst'?`<label class="field"><span>每组发数</span><input type="number" min="2" max="100" step="1" data-mode-field="burstSize" data-mode-index="${i}" value="${m.burstSize??''}"></label><label class="field"><span>组间间隔 <small>ms</small></span><input type="number" min="0" step="any" data-mode-field="gapMs" data-mode-index="${i}" value="${m.gapMs??200}"></label>`:''}`}</div><p class="inline-note">${m.type==='bolt'?'本枪开火到下一枪可开火的完整间隔，直接决定枪间隔。':m.type==='burst'?'组间间隔：上一组末发射出，到下一组首发射出的完整时间。':m.type==='semi'?'按允许的最快连续扣动扳机节奏计算。':'按固定射速连续射击，首发只计一次扳机延迟。'}</p></div>`).join('')}</div></section>
    </div><div class="editor-column"><section class="panel"><div class="panel-heading"><h2><span class="section-index">04</span> 全程部位倍率</h2><span class="tag outline">全射程联动</span></div><div class="panel-body"><div class="damage-editor-head"><span>参考射程</span><select id="reference-range" aria-label="伤害换算参考射程">${w.ranges.map((r,i)=>`<option value="${i}" ${i===state.refRange?'selected':''}>${rangeLabel(w,i)} · 基础 ${fmt(r.damage,0)}</option>`).join('')}</select></div><table class="damage-input-table"><thead><tr><th>部位</th><th>全程倍率 ×</th><th>参考段伤害</th></tr></thead><tbody>${BODY_PARTS.map(p=>`<tr data-part-row="${p.id}" class="${state.editorPart===p.id?'selected':''}"><td>${esc(p.label)}</td><td><input data-multiplier="${p.id}" type="number" min="0" step="0.01" value="${multiplierValue(w.multipliers[p.id])}" aria-label="${esc(p.label)}全程倍率"></td><td><input data-actual-damage="${p.id}" type="number" min="0" step="1" value="${bodyDamage(w.ranges[state.refRange].damage,w.multipliers[p.id])}" aria-label="${esc(p.label)}参考射程伤害"></td></tr>`).join('')}</tbody></table><p class="multiplier-note">倍率四舍五入保留 2 位，伤害四舍五入为整数。输入伤害用于反推全程倍率；取整后实际伤害可能与输入值略有不同，所有射程同步更新。</p></div></section>
    <section class="panel editor-preview"><div class="panel-heading"><h2><span class="section-index">05</span> 伤害预览</h2><span class="eyebrow" id="editor-preview-caption"></span></div><div class="body-toolbar"><span>点击人体部位定位输入项</span><span id="editor-selected-part" class="accent"></span></div><div id="editor-body" class="body-diagram"></div></section></div></div>
    <section class="panel maintenance-table" style="margin-top:18px"><div class="panel-heading"><h2>全射程伤害总览</h2><span class="muted">倍率保留 2 位，伤害四舍五入为整数后参与计算</span></div><div id="editor-damage-overview"></div></section>
    <div class="editor-actions"><span id="editor-save-state">${state.editorDirty?'有未保存修改 · 已保留本地草稿':'已保存到当前武器库'}</span><div>${readStore(BACKUP)?'<button type="button" class="button ghost compact" data-action="restore-backup">恢复导入前备份</button>':''}<button type="button" class="button ghost" data-action="preview-editor">${state.editorTemporary?'计算这把武器':'保存并查看分析'}</button>${!state.editorTemporary?'<button type="submit" class="button">保存到武器库</button>':''}</div></div></form>`;
  updateEditorPreview();
}
function syncEditorFromForm() {
  if(!state.editor||!$('#weapon-form'))return;
  const w=state.editor;
  $$('[data-field]').forEach(el=>{w[el.dataset.field]=['velocity','triggerDelayMs'].includes(el.dataset.field)?num(el.value):el.value;});
  $$('[data-range-damage]').forEach(el=>w.ranges[Number(el.dataset.rangeDamage)].damage=roundInput(num(el.value)));
  $$('[data-range-until]').forEach(el=>w.ranges[Number(el.dataset.rangeUntil)].until=el.disabled?null:num(el.value));
  $$('[data-mode-field]').forEach(el=>{const key=el.dataset.modeField;w.modes[Number(el.dataset.modeIndex)][key]=['name','type'].includes(key)?el.value:num(el.value);});
  $$('[data-multiplier]').forEach(el=>w.multipliers[el.dataset.multiplier]=roundInput(num(el.value),MULTIPLIER_DIGITS));
}
function updateEditorPreview() {
  if(!state.editor||!$('#editor-body'))return;
  const w=state.editor,base=w.ranges[state.refRange]?.damage;
  editorBodyCleanup?.();
  const values=Object.fromEntries(BODY_PARTS.map(p=>[p.id,bodyDamage(base,w.multipliers[p.id])]));
  editorBodyCleanup=renderBody($('#editor-body'),{values,selected:state.editorPart,view:'damage',onSelect:part=>{state.editorPart=part;$$('[data-part-row]').forEach(row=>row.classList.toggle('selected',row.dataset.partRow===part));updateEditorPreview();const input=$(`[data-multiplier="${part}"]`);input?.focus({preventScroll:true});}});
  $('#editor-preview-caption').textContent=rangeLabel(w,state.refRange);
  $('#editor-selected-part').textContent=partLabel(state.editorPart);
  $$('[data-actual-damage]').forEach(el=>{if(document.activeElement!==el){const value=values[el.dataset.actualDamage];el.value=Number.isFinite(value)?value:'';}});
  $$('[data-multiplier]').forEach(el=>{if(document.activeElement!==el)el.value=multiplierValue(w.multipliers[el.dataset.multiplier]);});
  $$('[data-bolt-rpm]').forEach(el=>el.value=fmt(60000/w.modes[Number(el.dataset.boltRpm)].cycleMs,3));
  const reference=$('#reference-range');
  [...reference.options].forEach((option,i)=>option.textContent=`${rangeLabel(w,i)} · 基础 ${fmt(w.ranges[i].damage,0)}`);
  $('#editor-damage-overview').innerHTML=`<table class="range-table"><thead><tr><th>距离区间</th><th>基础</th>${BODY_PARTS.map(p=>`<th>${esc(p.label)}</th>`).join('')}</tr></thead><tbody>${w.ranges.map((r,i)=>`<tr class="${i===state.refRange?'current':''}"><td>${rangeLabel(w,i)}</td><td>${fmt(r.damage,0)}</td>${BODY_PARTS.map(p=>`<td>${fmt(bodyDamage(r.damage,w.multipliers[p.id]),0)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
}
function validateEditor() {
  syncEditorFromForm();state.errors=validateWeapon(state.editor);
  $('#editor-errors').innerHTML=state.errors.length?`<div class="error-box">${state.errors.map(esc).join('\n')}</div>`:'';
  if(state.errors.length){$('#editor-errors').scrollIntoView({behavior:'smooth',block:'center'});toast('请先修正标出的数据。',true);return false;}return true;
}
function saveEditor(goAnalysis=false) {
  if(!validateEditor())return;
  const w=normalizeWeapon(state.editor);
  if(state.editorTemporary){state.temp=w;state.tempActive=true;clearDraft();state.view='analysis';location.hash='analysis';render();toast('已计算临时武器，未写入数据库。');return;}
  const index=state.db.weapons.findIndex(item=>item.id===w.id);
  if(index>=0)state.db.weapons[index]=w;else state.db.weapons.push(w);
  state.activeId=w.id;state.tempActive=false;
  if(!persistDatabase()){state.editorDirty=true;render();toast('更改仅保留在本次页面中，请立即导出 JSON 备份。',true);return;}
  clearDraft();
  if(goAnalysis){state.view='analysis';location.hash='analysis';}
  render();toast('武器数据已保存。');
}
function openEditor(w,temporary=false) {state.editor=normalizeWeapon(w);state.editorTemporary=temporary;state.errors=[];state.refRange=0;state.view='maintain';location.hash='maintenance';render();}
function createNew(temporary=false) {protectEditor(()=>{openEditor(newWeapon(),temporary);persistEditor();});}
function exportDatabase(confirmedSavedOnly=false) {
  if(state.editorDirty&&!confirmedSavedOnly){
    showDialog({title:'当前有未保存的编辑',body:'<p>导出内容仅包含已经保存的武器库，当前编辑草稿和临时试算不会包含在内。</p><p>需要包含当前修改时，请取消并先保存到武器库。</p>',confirmText:'仅导出已保存库',onConfirm:()=>exportDatabase(true)});return;
  }
  const report=validateDatabase(state.db);
  if(!report.valid){showDialog({title:'数据库未通过校验',body:`<ul class="error-list">${report.errors.map(e=>`<li>${esc(e)}</li>`).join('')}</ul>`});return;}
  const blob=new Blob([JSON.stringify(normalizeDatabase(state.db),null,2)],{type:'application/json;charset=utf-8'}),url=URL.createObjectURL(blob),a=document.createElement('a');
  const date=new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Shanghai'}).format(new Date());
  a.href=url;a.download=`weapon-atlas-${date}.json`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
  toast(state.editorDirty?'已导出已保存的数据库；未保存草稿不包含在内。':'数据库已导出。');
}
async function importFile(file) {
  if(!file)return;
  if(file.size>5*1024*1024){toast('JSON 文件不能超过 5 MB。',true);return;}
  let incoming;try{incoming=JSON.parse((await file.text()).replace(/^\uFEFF/,''));}catch{toast('无法解析 JSON，请检查文件内容。',true);return;}
  const report=validateDatabase(incoming);
  if(!report.valid){showDialog({title:'文件未通过校验',body:`<p>当前数据库保持原样。请修正以下问题后重新导入。</p><ul class="error-list">${report.errors.slice(0,30).map(e=>`<li>${esc(e)}</li>`).join('')}</ul>`});return;}
  const duplicate=incoming.weapons.filter(w=>state.db.weapons.some(old=>old.id===w.id)).length;
  showDialog({title:'导入武器数据库',body:`<p><strong>${esc(file.name)}</strong><br>${incoming.weapons.length} 把武器 · ${duplicate} 个 ID 与当前库相同。导入前将保留一份本地备份。</p>${state.editorDirty?'<p class="accent">导入后将清除当前未保存编辑，请先确认这些修改已保存或不再需要。</p>':''}<label class="dialog-choice"><input type="radio" name="import-mode" value="merge" checked><span>合并更新<small>保留现有武器，同 ID 的武器使用文件中的数据。</small></span></label><label class="dialog-choice"><input type="radio" name="import-mode" value="replace"><span>替换整个数据库<small>完整使用导入文件中的武器列表。</small></span></label>`,confirmText:'确认导入',onConfirm:dialog=>{
    const replace=$('[name="import-mode"]:checked',dialog).value==='replace';
    const next=normalizeDatabase(replace?incoming:{...state.db,weapons:[...state.db.weapons.filter(w=>!incoming.weapons.some(item=>item.id===w.id)),...incoming.weapons]});
    const valid=validateDatabase(next);if(!valid.valid){toast(valid.errors[0],true);return false;}
    if(!writeStore(BACKUP,state.db)){toast('无法保存导入前备份，已中止导入。请先导出当前库。',true);return false;}
    if(!writeStore(STORE,{...next,updatedAt:new Date().toISOString()})){toast('无法写入数据库，已中止导入；原数据库仍在。',true);return false;}
    state.db=next;state.activeId=next.weapons[0]?.id;state.compare.clear();state.tempActive=false;state.editor=null;state.errors=[];clearDraft();databaseUnsaved=false;calculationCache.clear();updateStorageStatus();render();toast(`已导入 ${incoming.weapons.length} 把武器。`);
  }});
}
function showMethod() {
  showDialog({title:'计算口径',body:`<p>从扣动扳机开始计时，以达到目标血量的那一发命中时刻为 TTK。</p><ul class="method-list"><li><span class="method-term">伤害</span>：当前射程基础伤害 × 全程部位倍率。倍率先四舍五入保留 2 位，基础伤害和最终部位伤害四舍五入为整数后计算。边界距离归入下一射程段。</li><li><span class="method-term">普通射击</span>：扳机延迟 + (BTK − 1) × 60000 ÷ RPM。半自动按最快允许节奏。</li><li><span class="method-term">栓动 / 泵动</span>：使用完整拉栓周期作为枪间隔，不再叠加 RPM 间隔。</li><li><span class="method-term">点射</span>：按组内射速、每组发数及组间间隔逐发安排时间；组间从末发射出到下一组首发射出。</li><li><span class="method-term">飞行时间</span>：开启时加入 距离 ÷ 弹速 × 1000 ms，假设弹速恒定、目标静止。</li><li><span class="method-term">混合命中</span>：每发独立按部位概率命中，默认不空枪。精确计算击杀发数分布，并按发射时间加权得到期望 TTK；期望 BTK 向上取整显示；混合 TTK 仍按完整概率分布计算。</li><li>未计入换弹、瞄准、反应、网络和服务器延迟。极端复杂的概率数据会给出计算限制提示。</li></ul>`});
}

main.addEventListener('submit',e=>{if(e.target.id==='weapon-form'){e.preventDefault();saveEditor();}});
main.addEventListener('input',e=>{
  const el=e.target;
  if(el.dataset.probability){state.probabilities[el.dataset.probability]=num(el.value);updateAnalysis();return;}
  if(el.id==='distance-slider'){setDistance(el.value);return;}
  if(el.id==='distance-value'){if(el.value!==''&&Number.isFinite(num(el.value))&&num(el.value)>=0)setDistance(el.value);return;}
  if(!el.closest('#weapon-form')||el.id==='reference-range')return;
  syncEditorFromForm();
  if(el.dataset.actualDamage){
    const base=state.editor.ranges[state.refRange].damage;
    try{state.editor.multipliers[el.dataset.actualDamage]=inferMultiplier(base,num(el.value));}catch{state.editor.multipliers[el.dataset.actualDamage]=NaN;}
  }
  state.errors=[];persistEditor();updateEditorPreview();
});
main.addEventListener('change',e=>{
  const el=e.target;
  if(el.dataset.actualDamage||el.dataset.multiplier||el.dataset.rangeDamage!==undefined){
    const requested=num(el.value);syncEditorFromForm();
    if(el.dataset.actualDamage){
      const part=el.dataset.actualDamage,base=state.editor.ranges[state.refRange].damage;
      try{state.editor.multipliers[part]=inferMultiplier(base,requested);}catch{state.editor.multipliers[part]=NaN;}
      const actual=bodyDamage(base,state.editor.multipliers[part]);
      if(Number.isFinite(actual)){el.value=actual;if(Number.isFinite(requested)&&actual!==roundInput(requested))toast(`倍率保留 2 位后，${partLabel(part)}实际伤害为 ${actual}。`);}
    }else if(el.dataset.multiplier){el.value=multiplierValue(state.editor.multipliers[el.dataset.multiplier]);}
    else {const value=state.editor.ranges[Number(el.dataset.rangeDamage)].damage;if(Number.isFinite(value))el.value=value;}
    persistEditor();updateEditorPreview();return;
  }
  if(el.id==='travel-toggle'){state.includeTravel=el.checked;updateAnalysis();}
  else if(el.id==='mixed-toggle'){state.mixed=el.checked;updateAnalysis();}
  else if(el.dataset.probability){state.probabilities[el.dataset.probability]=num(el.value);updateAnalysis();}
  else if(el.id==='analysis-mode'){state.modeIds[activeWeapon().id]=el.value;updateAnalysis();}
  else if(el.dataset.compareMode){state.modeIds[el.dataset.compareMode]=el.value;if(el.dataset.compareMode===activeWeapon().id)$('#analysis-mode').value=el.value;updateAnalysis();}
  else if(el.id==='chart-max'){state.chartMax=Number(el.value);state.distance=Math.min(state.distance,state.chartMax);renderAnalysis();}
  else if(el.id==='reference-range'){state.refRange=Number(el.value);updateEditorPreview();}
  else if(el.dataset.modeField==='type'){
    syncEditorFromForm();const mode=state.editor.modes[Number(el.dataset.modeIndex)];mode.name=TYPE_NAMES[mode.type];mode.rpm??=600;mode.cycleMs??=1000;mode.burstSize??=3;mode.gapMs??=200;persistEditor();renderEditor();
  }
});
main.addEventListener('click',e=>{
  const el=e.target.closest('button');if(!el)return;
  if(el.dataset.health){state.health=Number(el.dataset.health);$$('[data-health]').forEach(b=>b.classList.toggle('active',b===el));$$('[data-health]').forEach(b=>b.setAttribute('aria-pressed',String(b===el)));updateAnalysis();return;}
  if(el.dataset.bodyView){state.bodyView=el.dataset.bodyView;$$('[data-body-view]').forEach(b=>b.classList.toggle('active',b===el));updateAnalysis();return;}
  if(el.dataset.preset){state.probabilities=el.dataset.preset==='chest'?Object.fromEntries(BODY_PARTS.map(p=>[p.id,p.id==='chest'?100:0])):{...DEFAULT_PROBS};$$('[data-probability]').forEach(input=>input.value=state.probabilities[input.dataset.probability]);updateAnalysis();return;}
  if(el.dataset.removeRange!==undefined){syncEditorFromForm();const i=Number(el.dataset.removeRange);state.editor.ranges.splice(i,1);state.editor.ranges.at(-1).until=null;state.refRange=Math.min(state.refRange,state.editor.ranges.length-1);persistEditor();renderEditor();return;}
  if(el.dataset.removeMode!==undefined){syncEditorFromForm();state.editor.modes.splice(Number(el.dataset.removeMode),1);persistEditor();renderEditor();return;}
  const action=el.dataset.action;
  if(action==='new')createNew();
  if(action==='temp')createNew(true);
  if(action==='edit-current')protectEditor(()=>openEditor(activeWeapon(),state.tempActive));
  if(action==='resume-draft'){state.view='maintain';location.hash='maintenance';render();}
  if(action==='clear-compare')clearSelections();
  if(action==='add-range'){
    syncEditorFromForm();const ranges=state.editor.ranges,last=ranges.at(-1),previous=ranges.length>1?ranges.at(-2).until:0;
    last.until=(Number.isFinite(previous)?previous:0)+15;ranges.push({until:null,damage:Math.max(1,Math.round(last.damage*.8))});persistEditor();renderEditor();
  }
  if(action==='add-mode'){syncEditorFromForm();state.editor.modes.push({id:uid(),name:'新射击模式',type:'auto',rpm:600,cycleMs:1000,burstSize:3,gapMs:200});persistEditor();renderEditor();}
  if(action==='preview-editor')saveEditor(true);
  if(action==='duplicate'){
    syncEditorFromForm();state.editor.id=uid();state.editor.name+=' 副本';state.editor.modes.forEach(m=>m.id=uid());persistEditor();renderEditor();toast('已创建副本草稿，保存后加入武器库。');
  }
  if(action==='delete')showDialog({title:'删除这把武器？',body:`<p>将从当前武器库中删除“${esc(state.editor.name)}”。已导出的 JSON 文件保持不变。</p>`,confirmText:'删除武器',danger:true,onConfirm:()=>{
    const id=state.editor.id,next={...state.db,updatedAt:new Date().toISOString(),weapons:state.db.weapons.filter(w=>w.id!==id)};
    if(!writeStore(STORE,next)){toast('无法保存数据库，已中止删除。',true);return false;}
    state.db=next;state.compare.delete(id);state.activeId=state.db.weapons[0]?.id;state.editor=null;clearDraft();databaseUnsaved=false;calculationCache.clear();updateStorageStatus();state.view='analysis';location.hash='analysis';render();toast('武器已删除。');
  }});
  if(action==='restore-backup'){
    const backup=readStore(BACKUP);if(!backup||!validateDatabase(backup).valid){toast('本地备份无效或已不可用。',true);return;}
    showDialog({title:'恢复导入前的数据库？',body:`<p>使用备份中的 ${backup.weapons.length} 把武器替换当前库。当前编辑草稿也将清除。</p>`,confirmText:'恢复备份',onConfirm:()=>{const next=normalizeDatabase({...backup,updatedAt:new Date().toISOString()});if(!writeStore(STORE,next)){toast('无法保存数据库，已中止恢复。',true);return false;}state.db=next;state.activeId=backup.weapons[0]?.id;state.editor=null;state.compare.clear();state.tempActive=false;clearDraft();databaseUnsaved=false;calculationCache.clear();updateStorageStatus();render();toast('已恢复导入前的数据库。');}});
  }
});
$('#weapon-roster').addEventListener('click',e=>{
  const button=e.target.closest('[data-weapon]');if(!button)return;
  const select=()=>{state.activeId=button.dataset.weapon;state.tempActive=false;if(state.view==='maintain'||!state.editorDirty){state.editor=null;state.editorTemporary=false;state.errors=[];}render();};
  if(state.view==='maintain')protectEditor(select);else select();
});
$('#weapon-roster').addEventListener('change',e=>{if(!e.target.dataset.compare)return;const id=e.target.dataset.compare;if(e.target.checked)state.compare.add(id);else state.compare.delete(id);updateSelectionButton();if(state.view==='analysis')updateAnalysis();});
$('#clear-selection').onclick=clearSelections;
$('#weapon-search').addEventListener('input',e=>{state.search=e.target.value;renderSidebar();});
$('#category-filter').addEventListener('change',e=>{state.category=e.target.value;renderSidebar();});
$('#new-weapon').onclick=()=>createNew();
$('#temporary-weapon').onclick=()=>createNew(true);
$$('[data-view]').forEach(button=>button.onclick=()=>{
  const view=button.dataset.view;state.view=view;location.hash=view==='maintain'?'maintenance':'analysis';render();
});
$('#export-db').onclick=()=>exportDatabase();
$('#import-db').onclick=()=>$('#file-input').click();
$('#file-input').onchange=e=>{const file=e.target.files[0];e.target.value='';importFile(file);};
$('#method-button').onclick=showMethod;
window.addEventListener('hashchange',()=>{const view=location.hash==='#maintenance'?'maintain':'analysis';if(view!==state.view){state.view=view;render();}});
window.addEventListener('beforeunload',e=>{if(databaseUnsaved||(state.editorDirty&&!storageAvailable)){e.preventDefault();e.returnValue='';}});
render();updateStorageStatus();
if(stored&&!validateDatabase(stored).valid)toast('本地数据库未通过校验，已加载示例库；原始存储尚未覆盖。',true);
else if(rawDraft&&!savedDraft)toast('本地编辑草稿结构损坏，已忽略；已保存的数据库仍可使用。',true);


