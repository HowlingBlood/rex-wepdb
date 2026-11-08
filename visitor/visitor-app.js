import {BODY_PARTS,calculate,rangeAt,deriveDamage,inferMultiplier,normalizeWeapon,validateWeapon,roundHalfUp,MULTIPLIER_DIGITS} from './engine.js?v=1.2.1';
import {renderBody,renderChart,getSeriesStyle} from './visuals.js?v=1.2.1';
import {loadCatalog,loadDatabase,sortVersions} from './data-core.js?v=1.2.1';
import {renderHistory} from './history-ui.js?v=1.2.1';

const $=(s,root=document)=>root.querySelector(s);
const $$=(s,root=document)=>[...root.querySelectorAll(s)];
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmt=(n,digits=1)=>Number.isFinite(n)?new Intl.NumberFormat('zh-CN',{maximumFractionDigits:digits}).format(n):n===Infinity?'∞':'—';
const num=value=>String(value??'').trim()===''?NaN:Number(value);
const rounded=(value,digits=0)=>{try{return roundHalfUp(value,digits);}catch{return value;}};
const bodyDamage=(base,multiplier)=>{try{return deriveDamage(base,multiplier);}catch{return NaN;}};
const multiplierValue=value=>Number.isFinite(value)?rounded(value,MULTIPLIER_DIGITS).toFixed(MULTIPLIER_DIGITS):'';
const TYPE_NAMES={auto:'全自动',semi:'半自动',bolt:'栓动 / 泵动',burst:'点射'};
const DEFAULT_PROBS={head:10,neck:5,chest:45,abdomen:20,upperArm:10,forearm:5,thigh:3,calf:2};
const DB_BASE=new URL('./weapon_db/',import.meta.url);
const EMPTY_DB={schemaVersion:1,name:'',updatedAt:'2026-11-08T00:00:00.000Z',weapons:[]};
const requestedMode=new URL(location.href).searchParams.get('mode');
const state={catalog:null,modeId:requestedMode,db:EMPTY_DB,loading:true,catalogLoading:true,error:null,catalogError:null,
  activeId:null,compare:new Set(),view:location.hash==='#history'?'history':location.hash==='#calculator'?'calculator':'analysis',
  health:100,distance:10,chartMax:100,includeTravel:false,part:'chest',mixed:false,probabilities:{...DEFAULT_PROBS},bodyView:'damage',modeIds:{},
  search:'',category:'',temp:null,tempActive:false,trialDraft:null,trialRef:0,trialPart:'head',
  beforeVersionId:null,afterVersionId:null,beforeDb:null,afterDb:null,historyLoading:false,historyError:null};
const main=$('#main-content');
let bodyCleanup=null,chartCleanup=null,historyCleanup=null,trialBodyCleanup=null;
let calculationCache=new Map(),catalogRequest=0,modeRequest=0,historyRequest=0;
let catalogController,modeController,historyController,toastTimer;
function toast(message,error=false){clearTimeout(toastTimer);const el=$('#toast');el.textContent=message;el.className=`toast show${error?' error':''}`;toastTimer=setTimeout(()=>el.classList.remove('show'),4200);}
function currentMode(){return state.catalog?.modes.find(m=>m.id===state.modeId);}
function currentVersion(){const mode=currentMode();return mode?.versions.find(v=>v.id===mode.currentVersion);}
function orderedVersions(){return sortVersions(currentMode()?.versions||[]);}
function activeWeapon(){return state.tempActive?state.temp:state.db.weapons.find(w=>w.id===state.activeId);}
function activeMode(w){return w.modes.find(m=>m.id===state.modeIds[w.id])||w.modes[0];}
function partLabel(id){return BODY_PARTS.find(p=>p.id===id)?.label||id;}
function modeRPM(mode){return mode.type==='bolt'?60000/mode.cycleMs:mode.rpm;}
function rangeLabel(w,i){return`${i?fmt(w.ranges[i-1].until):'0'}–${w.ranges[i].until===null?'∞':fmt(w.ranges[i].until)} m`;}
function cleanupVisuals(){bodyCleanup?.();chartCleanup?.();historyCleanup?.();trialBodyCleanup?.();bodyCleanup=chartCleanup=historyCleanup=trialBodyCleanup=null;}
function setView(view){state.view=view;history.replaceState(null,'',`?mode=${encodeURIComponent(state.modeId||'wz')}#${view}`);render();if(view==='history')ensureHistory();}
function updateSelectionButton(){const b=$('#clear-selection');b.disabled=state.compare.size===0;b.textContent=state.compare.size?`取消已选 (${state.compare.size})`:'取消已选';b.setAttribute('aria-label',`取消全部已选武器，当前已选 ${state.compare.size} 把`);}
function clearSelections(){state.compare.clear();$$('[data-compare]',$('#weapon-roster')).forEach(input=>input.checked=false);updateSelectionButton();if(state.view==='analysis'&&activeWeapon())updateAnalysis();toast('已取消全部多选武器。');}
function renderSidebar(){
  updateSelectionButton();$('#weapon-count').textContent=state.db.weapons.length;
  const category=$('#category-filter');category.innerHTML=`<option value="">全部类别</option>${[...new Set(state.db.weapons.map(w=>w.category).filter(Boolean))].map(c=>`<option value="${esc(c)}">${esc(c)}</option>`).join('')}`;category.value=state.category;category.disabled=state.loading;
  $('#weapon-search').value=state.search;
  const weapons=state.db.weapons.filter(w=>(!state.category||w.category===state.category)&&w.name.toLowerCase().includes(state.search.toLowerCase()));
  $('#weapon-roster').innerHTML=state.loading?'<p class="visitor-skeleton">正在读取模式数据…</p>':weapons.length?weapons.map(w=>`<div class="weapon-row${!state.tempActive&&w.id===state.activeId?' active':''}"><button class="weapon-select" data-weapon="${esc(w.id)}" aria-label="查看 ${esc(w.name)}"><strong>${esc(w.name)}</strong><small><span>${esc(w.category||'未分类')}</span><span>${esc(TYPE_NAMES[w.modes[0].type])}</span></small></button><input type="checkbox" data-compare="${esc(w.id)}" ${state.compare.has(w.id)?'checked':''} aria-label="将 ${esc(w.name)} 加入对比"></div>`).join(''):`<p class="no-results">${state.db.weapons.length?'没有匹配的武器':'该模式暂无武器数据'}</p>`;
}
function renderHeader(){
  $$('.main-nav button').forEach(b=>b.classList.toggle('active',b.dataset.view===state.view||(state.view==='calculator'&&b.dataset.view==='analysis')));
  $('#mode-buttons').innerHTML=state.catalog?state.catalog.modes.map(m=>`<button data-data-mode="${esc(m.id)}" class="${m.id===state.modeId?'active':''}" aria-pressed="${m.id===state.modeId}"${state.catalogLoading?' disabled':''}>${esc(m.label)}${m.available===false?'<small>待补充</small>':''}</button>`).join(''):`<span class="muted">${state.catalogError?'版本清单不可用':'正在读取…'}</span>`;
  const mode=currentMode(),version=currentVersion();
  $('#database-version').innerHTML=state.loading?'正在读取模式数据库…':state.catalogError?'版本清单读取失败':mode?.available===false?`${esc(mode.label)} · 待补充<small>可先使用自由试算</small>`:`<strong>${esc(mode?.label||'模式数据库')}</strong> · ${esc(version?.label||'未登记版本')}<small>${version?`数据日期 ${esc(version.effectiveAt)}`:''}${version?.notes?` · ${esc(version.notes)}`:''}</small>`;
  $('#refresh-data').disabled=state.loading;
}
function renderState(title,description,{error=false,loading=false}={}){
  main.innerHTML=`<div class="visitor-state"><span class="eyebrow">${loading?'LOADING DATABASE':error?'DATABASE UNAVAILABLE':'DATA COMING SOON'}</span><h1>${esc(title)}</h1><p>${esc(description)}</p><div class="state-actions">${error?'<button class="button" data-action="retry-data">重新读取</button>':''}<button class="button ghost" data-action="calculator">自由试算 ↗</button></div></div>`;
}
function render(){
  cleanupVisuals();renderHeader();renderSidebar();
  if(state.view==='calculator'){renderCalculator();return;}
  if(state.view==='analysis'&&state.tempActive&&state.temp){renderAnalysis();return;}
  if(state.catalogError){renderState('暂时无法读取版本清单',state.catalogError,{error:true});return;}
  if(state.view==='history'){
    historyCleanup=renderHistory(main,{mode:currentMode(),versions:orderedVersions(),beforeVersionId:state.beforeVersionId,afterVersionId:state.afterVersionId,beforeDb:state.beforeDb,afterDb:state.afterDb,loading:state.loading||state.historyLoading,error:state.historyError,onVersionsChange:(before,after)=>{state.beforeVersionId=before;state.afterVersionId=after;loadHistoryPair();},onRetry:()=>loadHistoryPair()});return;
  }
  if(state.loading){renderState('正在读取武器数据库','按照当前模式读取已发布的数据版本。',{loading:true});return;}
  if(state.error){renderState('当前模式数据读取失败',state.error,{error:true});return;}
  if(currentMode()?.available===false&&!state.tempActive){renderState(`${currentMode().label}数据待补充`,currentMode().description||'该模式尚未发布数据库，可以先使用自由试算。');return;}
  if(!activeWeapon()){renderState('当前模式暂无武器数据','发布对应的模式数据库后，武器列表会出现在这里。');return;}
  renderAnalysis();
}
async function start({refresh=false}={}){
  const request=++catalogRequest;catalogController?.abort();catalogController=new AbortController();
  modeController?.abort();historyController?.abort();++modeRequest;++historyRequest;
  state.loading=true;state.catalogLoading=true;state.historyLoading=false;state.catalogError=null;state.error=null;state.db=EMPTY_DB;render();
  try{
    const catalog=await loadCatalog(DB_BASE,{signal:catalogController.signal});if(request!==catalogRequest)return;
    state.catalog=catalog;state.catalogLoading=false;
    const mode=catalog.modes.find(m=>m.id===state.modeId)||catalog.modes.find(m=>m.id===catalog.defaultMode)||catalog.modes[0];
    await selectDataMode(mode.id,{preserve:refresh});
  }catch(e){if(request!==catalogRequest||e.name==='AbortError')return;state.loading=false;state.catalogLoading=false;state.catalogError=e.message;state.catalog=null;state.db=EMPTY_DB;state.activeId=null;state.compare.clear();state.beforeDb=state.afterDb=null;render();}
}
async function selectDataMode(id,{preserve=false}={}){
  const mode=state.catalog.modes.find(m=>m.id===id);if(!mode)return;
  const request=++modeRequest;modeController?.abort();modeController=new AbortController();historyController?.abort();++historyRequest;
  const previousId=state.activeId;
  state.modeId=id;state.db=EMPTY_DB;state.loading=true;state.error=null;state.catalogError=null;state.tempActive=false;state.beforeDb=state.afterDb=null;state.historyError=null;state.historyLoading=false;
  if(!preserve){state.compare.clear();state.category='';state.search='';}
  const versions=orderedVersions(),after=versions.find(v=>v.id===mode.currentVersion)||versions.at(-1);
  state.afterVersionId=after?.id||null;state.beforeVersionId=versions[Math.max(0,versions.findIndex(v=>v.id===after?.id)-1)]?.id||null;
  history.replaceState(null,'',`?mode=${encodeURIComponent(id)}#${state.view}`);render();
  if(mode.available===false){state.loading=false;render();return;}
  try{
    const db=await loadDatabase(DB_BASE,mode.latest,{revision:`${mode.currentVersion}-${state.catalog.updatedAt||''}`,signal:modeController.signal});
    if(request!==modeRequest)return;state.db=db;state.activeId=db.weapons.some(w=>w.id===previousId)?previousId:db.weapons[0]?.id;
    if(preserve)state.compare=new Set([...state.compare].filter(id=>db.weapons.some(w=>w.id===id)));
    if(!db.weapons.some(w=>w.category===state.category))state.category='';
    calculationCache.clear();
  }catch(e){if(request!==modeRequest||e.name==='AbortError')return;state.error=e.message;}
  if(request===modeRequest){state.loading=false;render();if(state.view==='history')ensureHistory();}
}
function ensureHistory(){if(orderedVersions().length<2||state.historyLoading||(state.beforeDb&&state.afterDb))return;loadHistoryPair();}
async function loadHistoryPair(){
  const mode=currentMode();if(!mode||orderedVersions().length<2){render();return;}
  const before=mode.versions.find(v=>v.id===state.beforeVersionId),after=mode.versions.find(v=>v.id===state.afterVersionId);if(!before||!after)return;
  const request=++historyRequest;historyController?.abort();historyController=new AbortController();state.historyLoading=true;state.historyError=null;state.beforeDb=state.afterDb=null;render();
  try{
    const options={signal:historyController.signal};
    const [beforeDb,afterDb]=await Promise.all([loadDatabase(DB_BASE,before.file,{...options,revision:before.id}),loadDatabase(DB_BASE,after.file,{...options,revision:after.id})]);
    if(request!==historyRequest)return;state.beforeDb=beforeDb;state.afterDb=afterDb;
  }catch(e){if(request!==historyRequest||e.name==='AbortError')return;state.historyError=e.message;}
  if(request===historyRequest){state.historyLoading=false;if(state.view==='history')render();}
}

function modeOptions(w) { return w.modes.map(m=>`<option value="${esc(m.id)}" ${activeMode(w).id===m.id?'selected':''}>${esc(m.name || TYPE_NAMES[m.type])}</option>`).join(''); }
function renderAnalysis() {
  const w = activeWeapon();
  main.innerHTML = `
    <div class="page-heading"><div><span class="eyebrow">ARMORY INTELLIGENCE / 武器分析</span><h1>${esc(w.name)}</h1><p>${esc(w.category||'未分类')} / ${state.tempActive?'临时试算参数':esc(currentMode()?.label||'')} · ${w.ranges.length} 个射程段</p></div><div class="heading-tools"><span class="tag outline">${state.tempActive?'自由试算':esc(currentVersion()?.label||'已发布数据')}</span>${state.tempActive?'<button class="button ghost compact" data-action="edit-trial">修改试算参数 ↗</button>':''}</div></div>

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
    ${w.notes?`<p class="visitor-data-note">数据备注：${esc(w.notes)}</p>`:''}
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

function newTrial(){return{id:'__trial__',name:'我的试算武器',category:'自由试算',notes:'',velocity:600,triggerDelayMs:0,ranges:[{until:20,damage:30},{until:null,damage:24}],multipliers:{head:1.5,neck:1.1,chest:1,abdomen:1,upperArm:.9,forearm:.9,thigh:.9,calf:.9},modes:[{id:'trial-mode',name:'全自动',type:'auto',rpm:720,cycleMs:1000,burstSize:3,gapMs:200}]};}
function openCalculator(){state.trialDraft??=structuredClone(state.temp||newTrial());setView('calculator');}
function renderCalculator(){
  state.trialDraft??=newTrial();const w=state.trialDraft,m=w.modes[0];state.trialRef=Math.min(state.trialRef,w.ranges.length-1);
  main.innerHTML=`<div class="page-heading"><div><span class="eyebrow">PERSONAL CALCULATOR / 自由试算</span><h1>构建一把试算武器</h1><p>直接填写参数，使用相同的伤害与 TTK 计算规则。</p></div><span class="tag outline">临时计算</span></div><div id="trial-errors"></div><form id="trial-form" novalidate><div class="calculator-layout"><div class="calculator-column"><section class="panel"><div class="panel-heading"><h2><span class="section-index">01</span> 射击参数</h2></div><div class="panel-body"><div class="form-grid"><label class="field wide"><span>武器名称</span><input data-trial-field="name" value="${esc(w.name)}" maxlength="100"></label><label class="field"><span>弹速 <small>m/s</small></span><input data-trial-field="velocity" type="number" min="0.001" step="any" value="${w.velocity}"></label><label class="field"><span>首发扳机延迟 <small>ms</small></span><input data-trial-field="triggerDelayMs" type="number" min="0" step="any" value="${w.triggerDelayMs}"></label><label class="field wide"><span>射击方式</span><select id="trial-type">${Object.entries(TYPE_NAMES).map(([key,label])=>`<option value="${key}"${key===m.type?' selected':''}>${label}</option>`).join('')}</select></label></div><div class="trial-mode-fields" style="margin-top:14px">${m.type==='bolt'?`<label class="field"><span>完整拉栓间隔 <small>ms</small></span><input data-trial-mode="cycleMs" type="number" min="0.001" step="any" value="${m.cycleMs}"></label>`:`<label class="field"><span>${m.type==='burst'?'组内射速':'射速'} <small>RPM</small></span><input data-trial-mode="rpm" type="number" min="0.001" step="any" value="${m.rpm}"></label>${m.type==='burst'?`<label class="field"><span>每组发数</span><input data-trial-mode="burstSize" type="number" min="1" max="100" step="1" value="${m.burstSize}"></label><label class="field"><span>组间间隔 <small>ms</small></span><input data-trial-mode="gapMs" type="number" min="0" step="any" value="${m.gapMs}"></label>`:''}`}</div><p class="calc-note">${m.type==='bolt'?'拉栓时间是本枪开火到下一枪可开火的完整周期。':m.type==='burst'?'组间间隔从上一组末发射出，计至下一组首发射出。':'按最快允许节奏连续射击，扳机延迟只计入首发。'}</p></div></section><section class="panel"><div class="panel-heading"><h2><span class="section-index">02</span> 射程与基础伤害</h2><button type="button" class="text-button" data-action="trial-add-range">＋ 添加射程段</button></div><div class="panel-body">${w.ranges.map((r,i)=>`<div class="range-edit-row"><span class="range-index">${String(i+1).padStart(2,'0')}</span><label class="field"><span>${i===w.ranges.length-1?'最后一段至':'结束距离'} <small>m</small></span><input data-trial-until="${i}"${i===w.ranges.length-1?' value="∞" disabled':` type="number" min="0.001" step="any" value="${r.until}"`}></label><label class="field"><span>基础伤害</span><input data-trial-base="${i}" type="number" min="1" step="1" value="${r.damage}"></label><button class="icon-button" type="button" data-trial-remove="${i}" aria-label="移除试算射程段 ${i+1}"${w.ranges.length===1?' disabled':''}>×</button></div>`).join('')}<p class="calc-note">边界使用下一段伤害，最后一段延伸至更远距离。</p></div></section></div><div class="calculator-column"><section class="panel"><div class="panel-heading"><h2><span class="section-index">03</span> 全程部位倍率</h2></div><div class="panel-body"><div class="calc-reference"><span>伤害换算参考段</span><select id="trial-reference" aria-label="试算伤害参考射程">${w.ranges.map((r,i)=>`<option value="${i}"${state.trialRef===i?' selected':''}>${rangeLabel(w,i)} · 基础 ${fmt(r.damage,0)}</option>`).join('')}</select></div><table class="damage-input-table"><thead><tr><th>部位</th><th>全程倍率 ×</th><th>参考段伤害</th></tr></thead><tbody>${BODY_PARTS.map(p=>`<tr data-trial-part="${p.id}"><td>${esc(p.label)}</td><td><input data-trial-multiplier="${p.id}" type="number" min="0" step="0.01" value="${multiplierValue(w.multipliers[p.id])}" aria-label="试算${esc(p.label)}倍率"></td><td><input data-trial-damage="${p.id}" type="number" min="0" step="1" value="${bodyDamage(w.ranges[state.trialRef].damage,w.multipliers[p.id])}" aria-label="试算${esc(p.label)}伤害"></td></tr>`).join('')}</tbody></table><p class="calc-note">倍率四舍五入保留 2 位，伤害四舍五入为整数。输入伤害会反推全程倍率，取整后的实际伤害可能与输入值不同。</p></div></section><section class="panel"><div class="panel-heading"><h2>部位伤害预览</h2><span id="trial-preview-range" class="muted"></span></div><div id="trial-body" class="body-diagram"></div></section></div></div><section class="panel trial-damage-overview"><div class="panel-heading"><h2>全射程伤害总览</h2></div><div id="trial-overview"></div></section><div class="trial-actions"><p>参数仅用于本次页面会话，模式数据库保持只读。</p><div><button type="button" class="button ghost" data-action="trial-reset">重置参数</button><button type="submit" class="button">计算这把武器 ↗</button></div></div></form>`;
  updateTrialPreview();
}
function readTrialForm(){
  if(!$('#trial-form'))return;const w=state.trialDraft;
  $$('[data-trial-field]').forEach(el=>w[el.dataset.trialField]=el.dataset.trialField==='name'?el.value:num(el.value));
  $$('[data-trial-base]').forEach(el=>w.ranges[Number(el.dataset.trialBase)].damage=rounded(num(el.value)));
  $$('[data-trial-until]').forEach(el=>w.ranges[Number(el.dataset.trialUntil)].until=el.disabled?null:num(el.value));
  $$('[data-trial-multiplier]').forEach(el=>w.multipliers[el.dataset.trialMultiplier]=rounded(num(el.value),MULTIPLIER_DIGITS));
  $$('[data-trial-mode]').forEach(el=>w.modes[0][el.dataset.trialMode]=num(el.value));
}
function updateTrialPreview(){
  const w=state.trialDraft;if(!w||!$('#trial-body'))return;const base=w.ranges[state.trialRef].damage;
  const values=Object.fromEntries(BODY_PARTS.map(p=>[p.id,bodyDamage(base,w.multipliers[p.id])]));
  trialBodyCleanup?.();trialBodyCleanup=renderBody($('#trial-body'),{values,selected:state.trialPart,view:'damage',onSelect:part=>{state.trialPart=part;updateTrialPreview();$(`[data-trial-multiplier="${part}"]`)?.focus({preventScroll:true});}});
  $('#trial-preview-range').textContent=rangeLabel(w,state.trialRef);
  $$('[data-trial-damage]').forEach(el=>{if(el!==document.activeElement)el.value=Number.isFinite(values[el.dataset.trialDamage])?values[el.dataset.trialDamage]:'';});
  $$('[data-trial-multiplier]').forEach(el=>{if(el!==document.activeElement)el.value=multiplierValue(w.multipliers[el.dataset.trialMultiplier]);});
  [...$('#trial-reference').options].forEach((o,i)=>o.textContent=`${rangeLabel(w,i)} · 基础 ${fmt(w.ranges[i].damage,0)}`);
  $('#trial-overview').innerHTML=`<table class="range-table"><thead><tr><th>距离区间</th><th>基础伤害</th>${BODY_PARTS.map(p=>`<th>${esc(p.label)}</th>`).join('')}</tr></thead><tbody>${w.ranges.map((r,i)=>`<tr${i===state.trialRef?' class="current"':''}><td>${rangeLabel(w,i)}</td><td>${fmt(r.damage,0)}</td>${BODY_PARTS.map(p=>`<td>${fmt(bodyDamage(r.damage,w.multipliers[p.id]),0)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
}
function commitTrial(){
  readTrialForm();const w=normalizeWeapon(state.trialDraft),errors=validateWeapon(w);
  $('#trial-errors').innerHTML=errors.length?`<div class="error-box">${errors.map(esc).join('\n')}</div>`:'';
  if(errors.length){$('#trial-errors').scrollIntoView({block:'center',behavior:'smooth'});toast('请修正试算参数。',true);return;}
  state.temp=w;state.tempActive=true;state.trialDraft=structuredClone(w);calculationCache.clear();setView('analysis');
}
function showMethod(){const d=$('#app-dialog');d.innerHTML=`<h2>计算口径</h2><p>从首次扣动扳机计时。基础伤害取整数，全程倍率保留 2 位，最终部位伤害四舍五入为整数后参与计算。</p><ul class="method-list"><li>普通连续射击：首发延迟 + (BTK − 1) × 60000 ÷ RPM。</li><li>栓动 / 泵动：以完整拉栓周期作为枪间隔。</li><li>点射：按组内射速和末发到下一组首发的间隔逐发计时。</li><li>计入弹速时，加上 距离 ÷ 弹速 × 1000 ms，假设弹速恒定、目标静止。</li><li>混合命中：每发独立按部位概率命中，默认全部命中；完整击杀发数分布按射击时间轴加权。期望 BTK 向上取整显示，不用取整后的 BTK 反算 TTK。</li><li>未计入换弹、反应、瞄准、网络延迟、穿透或弹丸散布。</li></ul><div class="dialog-actions"><button class="button" data-close-dialog>知道了</button></div>`;d.showModal();$('[data-close-dialog]',d).onclick=()=>d.close();}
main.addEventListener('submit',event=>{if(event.target.id==='trial-form'){event.preventDefault();commitTrial();}});
main.addEventListener('input',event=>{
  const el=event.target;
  if(el.id==='distance-slider'||el.id==='distance-value'){if(el.value!==''&&Number.isFinite(num(el.value))&&num(el.value)>=0)setDistance(el.value);return;}
  if(el.dataset.probability){state.probabilities[el.dataset.probability]=num(el.value);updateAnalysis();return;}
  if(!el.closest('#trial-form')||el.id==='trial-reference')return;
  readTrialForm();
  if(el.dataset.trialDamage){try{state.trialDraft.multipliers[el.dataset.trialDamage]=inferMultiplier(state.trialDraft.ranges[state.trialRef].damage,num(el.value));}catch{state.trialDraft.multipliers[el.dataset.trialDamage]=NaN;}}
  updateTrialPreview();
});
main.addEventListener('change',event=>{
  const el=event.target;
  if(el.id==='travel-toggle'){state.includeTravel=el.checked;updateAnalysis();}
  else if(el.id==='mixed-toggle'){state.mixed=el.checked;updateAnalysis();}
  else if(el.id==='analysis-mode'){state.modeIds[activeWeapon().id]=el.value;updateAnalysis();}
  else if(el.dataset.compareMode){state.modeIds[el.dataset.compareMode]=el.value;if(el.dataset.compareMode===activeWeapon().id)$('#analysis-mode').value=el.value;updateAnalysis();}
  else if(el.id==='chart-max'){state.chartMax=Number(el.value);state.distance=Math.min(state.distance,state.chartMax);renderAnalysis();}
  else if(el.id==='trial-reference'){state.trialRef=Number(el.value);updateTrialPreview();}
  else if(el.id==='trial-type'){readTrialForm();state.trialDraft.modes[0].type=el.value;state.trialDraft.modes[0].name=TYPE_NAMES[el.value];renderCalculator();}
  else if(el.dataset.trialMultiplier||el.dataset.trialDamage||el.dataset.trialBase!==undefined){
    const requested=num(el.value);readTrialForm();
    if(el.dataset.trialDamage){const part=el.dataset.trialDamage;try{state.trialDraft.multipliers[part]=inferMultiplier(state.trialDraft.ranges[state.trialRef].damage,requested);}catch{state.trialDraft.multipliers[part]=NaN;}const actual=bodyDamage(state.trialDraft.ranges[state.trialRef].damage,state.trialDraft.multipliers[part]);if(Number.isFinite(actual)){el.value=actual;if(actual!==rounded(requested))toast(`倍率取 2 位后，实际伤害为 ${actual}。`);}}
    else if(el.dataset.trialMultiplier)el.value=multiplierValue(state.trialDraft.multipliers[el.dataset.trialMultiplier]);
    else{const value=state.trialDraft.ranges[Number(el.dataset.trialBase)].damage;if(Number.isFinite(value))el.value=value;}
    updateTrialPreview();
  }
});
main.addEventListener('click',event=>{
  const button=event.target.closest('button');if(!button)return;
  if(button.dataset.health){state.health=Number(button.dataset.health);$$('[data-health]').forEach(b=>{b.classList.toggle('active',b===button);b.setAttribute('aria-pressed',String(b===button));});updateAnalysis();return;}
  if(button.dataset.bodyView){state.bodyView=button.dataset.bodyView;$$('[data-body-view]').forEach(b=>b.classList.toggle('active',b===button));updateAnalysis();return;}
  if(button.dataset.preset){state.probabilities=button.dataset.preset==='chest'?Object.fromEntries(BODY_PARTS.map(p=>[p.id,p.id==='chest'?100:0])):{...DEFAULT_PROBS};$$('[data-probability]').forEach(el=>el.value=state.probabilities[el.dataset.probability]);updateAnalysis();return;}
  if(button.dataset.trialRemove!==undefined){readTrialForm();state.trialDraft.ranges.splice(Number(button.dataset.trialRemove),1);state.trialDraft.ranges.at(-1).until=null;state.trialRef=Math.min(state.trialRef,state.trialDraft.ranges.length-1);renderCalculator();return;}
  const action=button.dataset.action;
  if(action==='calculator'||action==='edit-trial')openCalculator();
  if(action==='retry-data')start({refresh:true});
  if(action==='clear-compare')clearSelections();
  if(action==='trial-reset'){state.trialDraft=newTrial();state.trialRef=0;renderCalculator();}
  if(action==='trial-add-range'){readTrialForm();const ranges=state.trialDraft.ranges,last=ranges.at(-1);last.until=(ranges.length>1?ranges.at(-2).until:0)+15;ranges.push({until:null,damage:Math.max(1,Math.round(last.damage*.8))});renderCalculator();}
});
$('#weapon-roster').addEventListener('click',event=>{const b=event.target.closest('[data-weapon]');if(!b)return;state.activeId=b.dataset.weapon;state.tempActive=false;state.view='analysis';history.replaceState(null,'',`?mode=${encodeURIComponent(state.modeId)}#analysis`);render();});
$('#weapon-roster').addEventListener('change',event=>{const el=event.target;if(!el.dataset.compare)return;if(el.checked)state.compare.add(el.dataset.compare);else state.compare.delete(el.dataset.compare);updateSelectionButton();if(state.view==='analysis'&&activeWeapon())updateAnalysis();});
$('#weapon-search').oninput=event=>{state.search=event.target.value;renderSidebar();};
$('#category-filter').onchange=event=>{state.category=event.target.value;renderSidebar();};
$('#clear-selection').onclick=clearSelections;$('#free-calculator').onclick=openCalculator;
$('#mode-buttons').onclick=event=>{const b=event.target.closest('[data-data-mode]');if(!state.catalogLoading&&b&&b.dataset.dataMode!==state.modeId)selectDataMode(b.dataset.dataMode);};
$$('[data-view]').forEach(b=>b.onclick=()=>setView(b.dataset.view));
$('#refresh-data').onclick=()=>start({refresh:true});$('#method-button').onclick=showMethod;
window.addEventListener('hashchange',()=>{const view=location.hash==='#history'?'history':location.hash==='#calculator'?'calculator':'analysis';if(view!==state.view){state.view=view;render();if(view==='history')ensureHistory();}});
start();
