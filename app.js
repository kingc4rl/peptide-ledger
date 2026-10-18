(function(){
"use strict";

/* ===================== Utilities ===================== */
const $ = (sel,root)=> (root||document).querySelector(sel);
const $$ = (sel,root)=> Array.from((root||document).querySelectorAll(sel));
const uid = ()=> Math.random().toString(36).slice(2,10)+Date.now().toString(36).slice(-4);
function isoFromDate(d){
  const y = d.getFullYear(), m = String(d.getMonth()+1).padStart(2,'0'), day = String(d.getDate()).padStart(2,'0');
  return `${y}-${m}-${day}`;
}
const todayISO = ()=> isoFromDate(new Date());
// "Dose day" rolls over at 2am, not midnight — so logging at 1:30am still counts as the previous day's dose.
function doseDayISO(){
  const d = new Date();
  d.setHours(d.getHours()-2);
  return isoFromDate(d);
}
function fmtDate(iso){
  if(!iso) return '—';
  const d = new Date(iso+'T00:00:00');
  if(isNaN(d)) return iso;
  return d.toLocaleDateString(undefined,{month:'short',day:'numeric',year:'numeric'});
}
function fmtDateShort(iso){
  if(!iso) return '—';
  const d = new Date(iso+'T00:00:00');
  if(isNaN(d)) return iso;
  return d.toLocaleDateString(undefined,{month:'short',day:'numeric'});
}
function daysBetween(aISO,bISO){
  const a = new Date(aISO+'T00:00:00'), b = new Date(bISO+'T00:00:00');
  return Math.round((b-a)/86400000);
}
function addDays(iso,n){
  const d = new Date(iso+'T00:00:00');
  d.setDate(d.getDate()+n);
  return isoFromDate(d);
}
function esc(s){
  return String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function num(v,fallback){ const n = parseFloat(v); return isFinite(n)? n : (fallback===undefined?0:fallback); }

/* ===================== State ===================== */
const COLLECTIONS = ['protocols','vials','vendors','research','supplies','supplyVendors','pepEquipment','checkins','photos','labs','urine'];
const state = {};
COLLECTIONS.forEach(k=> state[k] = []);
let storageMode = 'memory';   // 'idb' | 'local' | 'memory'
let storageError = null;

/* ===================== On-device storage (IndexedDB, localStorage fallback) ===================== */
// Everything lives on this device only. Each collection is stored as one array under its name;
// photo files live in a separate "blobs" store keyed by photo id.
const IDB_NAME = 'peptide-ledger', IDB_VERSION = 1;
let idb = null;
function idbOpen(){
  return new Promise((resolve,reject)=>{
    if(!('indexedDB' in window)) return reject(new Error('IndexedDB unavailable'));
    const r = indexedDB.open(IDB_NAME, IDB_VERSION);
    r.onupgradeneeded = ()=>{
      const d = r.result;
      if(!d.objectStoreNames.contains('collections')) d.createObjectStore('collections');
      if(!d.objectStoreNames.contains('blobs')) d.createObjectStore('blobs');
    };
    r.onsuccess = ()=> resolve(r.result);
    r.onerror = ()=> reject(r.error);
    r.onblocked = ()=> reject(new Error('Storage blocked by another open copy of the app'));
  });
}
function idbTx(store, mode, fn){
  return new Promise((resolve,reject)=>{
    const tx = idb.transaction(store, mode);
    const req = fn(tx.objectStore(store));
    tx.oncomplete = ()=> resolve(req ? req.result : undefined);
    tx.onerror = ()=> reject(tx.error);
    tx.onabort = ()=> reject(tx.error);
  });
}
const LS_PREFIX = 'ledger.col.';
async function loadAll(){
  try{
    idb = await idbOpen();
    storageMode = 'idb';
    for(const k of COLLECTIONS){
      const v = await idbTx('collections','readonly', st=> st.get(k));
      state[k] = Array.isArray(v) ? v : [];
    }
    try{ if(navigator.storage && navigator.storage.persist) await navigator.storage.persist(); }catch(e){}
  }catch(e){
    idb = null;
    try{
      COLLECTIONS.forEach(k=>{ const raw = localStorage.getItem(LS_PREFIX+k); state[k] = raw ? JSON.parse(raw) : []; });
      storageMode = 'local';
    }catch(e2){ storageMode = 'memory'; }
  }
}
async function persist(k){
  try{
    if(storageMode==='idb') await idbTx('collections','readwrite', st=> st.put(state[k], k));
    else if(storageMode==='local') localStorage.setItem(LS_PREFIX+k, JSON.stringify(state[k]));
    storageError = null;
  }catch(e){
    storageError = (e && e.name==='QuotaExceededError') ? 'Storage is full. Delete some photos, then back up.' : 'Couldn\'t save that change on this device.';
    console.warn('persist failed', k, e);
  }
  renderStoragePill();
}
async function putBlob(id, blob){ if(storageMode!=='idb') throw new Error('Photos need IndexedDB'); await idbTx('blobs','readwrite', st=> st.put(blob, id)); }
async function getBlob(id){ if(storageMode!=='idb') return null; return idbTx('blobs','readonly', st=> st.get(id)); }
async function delBlob(id){ if(storageMode!=='idb') return; await idbTx('blobs','readwrite', st=> st.delete(id)); }
async function allBlobKeys(){ if(storageMode!=='idb') return []; return idbTx('blobs','readonly', st=> st.getAllKeys()); }
async function clearBlobs(){ if(storageMode!=='idb') return; await idbTx('blobs','readwrite', st=> st.clear()); }
const blobUrlCache = new Map();
async function blobUrl(id){
  if(blobUrlCache.has(id)) return blobUrlCache.get(id);
  const b = await getBlob(id);
  if(!b) return null;
  const u = URL.createObjectURL(b);
  blobUrlCache.set(id, u);
  return u;
}

function lsGet(k, fallback){ try{ const v = localStorage.getItem(k); return v==null ? fallback : v; }catch(e){ return fallback; } }
function lsSet(k, v){ try{ localStorage.setItem(k, v); }catch(e){} }

function renderStoragePill(){
  const dot = $('#syncDot'), label = $('#syncLabel'), pill = $('#syncPill');
  if(!dot) return;
  let text, ok = true;
  if(storageError){ text = storageError; ok = false; }
  else if(storageMode==='idb') text = 'Saved on this device';
  else if(storageMode==='local') text = 'Saved on this device (no photos)';
  else { text = 'Not saving: private browsing?'; ok = false; }
  dot.classList.toggle('off', !ok);
  dot.classList.toggle('bad', !ok);
  label.textContent = text;
  pill.title = text + ' · tap for backup';
  renderBackupNudge();
}

/* ===================== Data layer ===================== */
async function dbAdd(path,data){
  const id = uid();
  state[path].push({id, ...data});
  renderAll();
  await persist(path);
  return id;
}
async function dbSet(path,id,data){
  const arr = state[path];
  const i = arr.findIndex(x=>x.id===id);
  if(i>-1) arr[i] = {id,...data}; else arr.push({id,...data});
  renderAll();
  await persist(path);
}
async function dbDelete(path,id){
  const arr = state[path];
  const i = arr.findIndex(x=>x.id===id);
  if(i>-1) arr.splice(i,1);
  renderAll();
  await persist(path);
}

/* ===================== Modal helper ===================== */
function openModal(title, bodyHTML, onMount){
  const root = $('#modalRoot');
  root.innerHTML = `<div class="modal-backdrop" id="mb"><div class="modal">
    <div class="modal-head"><h3>${esc(title)}</h3><button class="icon-btn" id="mbClose" aria-label="Close">✕</button></div>
    <div id="mbBody">${bodyHTML}</div>
  </div></div>`;
  $('#mb').addEventListener('click', e=>{ if(e.target.id==='mb') closeModal(); });
  $('#mbClose').addEventListener('click', closeModal);
  if(onMount) onMount($('#mbBody'));
}
function closeModal(){ $('#modalRoot').innerHTML = ''; }
function confirmAction(message, onConfirm, okLabel){
  openModal('Are you sure?', `
    <p style="font-size:13.5px;margin-bottom:16px;">${esc(message)}</p>
    <div class="form-actions"><button class="btn" id="cfCancel">Cancel</button><button class="btn btn-danger" id="cfOk">${esc(okLabel||'Delete')}</button></div>
  `, body=>{
    $('#cfCancel',body).addEventListener('click', closeModal);
    $('#cfOk',body).addEventListener('click', ()=>{ closeModal(); onConfirm(); });
  });
}

/* ===================== Shared protocol / stash helpers ===================== */

function cyclePosition(p){
  if(!p.cycleStart) return null;
  if(p.cycleStart > todayISO()) return null;
  const onDays = num(p.cycleOnWeeks,0)*7, offDays = num(p.cycleOffWeeks,0)*7;
  const total = onDays+offDays;
  if(total<=0) return null;
  let elapsed = daysBetween(p.cycleStart, todayISO()) % total;
  if(elapsed<0) elapsed += total;
  const phase = elapsed < onDays ? 'on' : 'off';
  const dayInPhase = phase==='on' ? elapsed+1 : elapsed-onDays+1;
  const phaseLen = phase==='on' ? onDays : offDays;
  const daysToSwitch = phaseLen - dayInPhase + 1;
  return {phase, dayInPhase, phaseLen, daysToSwitch, elapsed, total, onDays, offDays};
}

function stashCalc(v){
  const mgOne = num(v.mgPerVial,null);
  if(mgOne==null) return null;
  const mg = mgOne * num(v.qty,1);
  let doseMg = num(v.doseMgOverride, null);
  let freqDays = num(v.frequencyDaysOverride, null);
  if((doseMg==null || freqDays==null) && v.protocolId){
    const p = state.protocols.find(x=>x.id===v.protocolId);
    if(p){
      if(doseMg==null){ const d = doseAt(p, todayISO()); doseMg = doseToMg(d.dose, d.doseUnit); }
      if(freqDays==null) freqDays = effectiveFreqDays(p);
    }
  }
  if(!doseMg || !freqDays) return {daysRemaining:null};
  const dosesInVial = mg/doseMg;
  const daysTotal = dosesInVial*freqDays;
  let daysRemaining = daysTotal;
  if(v.dateOpened){
    const used = daysBetween(v.dateOpened, todayISO());
    daysRemaining = Math.round(daysTotal - used);
  } else {
    daysRemaining = Math.round(daysTotal);
  }
  return {dosesInVial: Math.round(dosesInVial*10)/10, daysTotal:Math.round(daysTotal), daysRemaining};
}
function doseToMg(dose, unit){
  const n = num(dose,null);
  if(n==null) return null;
  return unit==='mcg' ? n/1000 : n;
}
/* Titration / taper: steps [{start, dose, doseUnit}]. The base dose applies until the first step's date. */
function titrationSteps(p){
  return (Array.isArray(p && p.titration) ? p.titration : [])
    .filter(s=> s && s.start && num(s.dose,null)!=null)
    .slice().sort((a,b)=> a.start.localeCompare(b.start));
}
function doseAt(p, iso){
  let d = {dose:p.dose, doseUnit:p.doseUnit||'mcg', step:0};
  titrationSteps(p).forEach((s,i)=>{ if(s.start<=iso) d = {dose:s.dose, doseUnit:s.doseUnit||p.doseUnit||'mcg', step:i+1}; });
  return d;
}
function nextStepAfter(p, iso){ return titrationSteps(p).find(s=> s.start>iso) || null; }
/* Split dosing: one dose day's total is divided across N injections. */
function splitCount(p){ return Math.max(1, Math.min(6, Math.round(num(p && p.dosesPerDay,1)) || 1)); }
function injectionsOn(p, iso){ return (Array.isArray(p.doseLog)?p.doseLog:[]).filter(d=>d===iso).length; }
/* Syringe units per injection for the dose in effect on a date. Uses the vial recipe when present. */
function unitsPerInjection(p, iso){
  const d = doseAt(p, iso);
  const mg = doseToMg(d.dose, d.doseUnit);
  const vialMg = num(p.vialMg,0), bac = num(p.bacMl,0);
  const n = splitCount(p);
  if(vialMg>0 && bac>0 && mg) return Math.round((mg/(vialMg/bac))*100/n*10)/10;
  if(d.step===0 && num(p.units,null)!=null) return Math.round(num(p.units)/n*10)/10;
  return null;
}
function fmtDose(dose, unit){ const n = num(dose,null); return n==null ? '' : `${Math.round(n*1000)/1000} ${unit||''}`.trim(); }
function vialLabel(v){
  const bits = [];
  if(v.pharmacy) bits.push(v.pharmacy);
  if(v.lot) bits.push('Lot '+v.lot);
  if(v.mgPerVial) bits.push(`${num(v.mgPerVial)}mg`);
  bits.push(v.remainingMg!=null ? `${Math.round(v.remainingMg*10)/10}mg left` : 'unopened');
  if(v.bud) bits.push('BUD '+fmtDateShort(v.bud));
  return bits.join(' · ');
}

/* ===================== Peptides: Calculator ===================== */
const PEPTIDE_PRESETS = [
  {name:'BPC-157', vial:5, doseLow:250, doseHigh:500, doseUnit:'mcg', freq:'1×/day'},
  {name:'TB-500', vial:10, doseLow:2, doseHigh:2.5, doseUnit:'mg', freq:'2×/week'},
  {name:'Semaglutide', vial:5, doseLow:0.25, doseHigh:2.4, doseUnit:'mg', freq:'weekly'},
  {name:'Tirzepatide', vial:5, doseLow:2.5, doseHigh:15, doseUnit:'mg', freq:'weekly'},
  {name:'Retatrutide', vial:10, doseLow:1, doseHigh:12, doseUnit:'mg', freq:'weekly'},
  {name:'CJC-1295 (No DAC)', vial:2, doseLow:100, doseHigh:300, doseUnit:'mcg', freq:'1×/day'},
  {name:'Ipamorelin', vial:5, doseLow:100, doseHigh:300, doseUnit:'mcg', freq:'2×/day'},
  {name:'GHK-Cu', vial:50, doseLow:1, doseHigh:2, doseUnit:'mg', freq:'1×/day'},
  {name:'Tesamorelin', vial:5, doseLow:1, doseHigh:2, doseUnit:'mg', freq:'1×/day'},
  {name:'PT-141', vial:10, doseLow:0.5, doseHigh:1.75, doseUnit:'mg', freq:'as needed'},
  {name:'MOTS-c', vial:10, doseLow:2.5, doseHigh:10, doseUnit:'mg', freq:'3×/week'},
  {name:'SS-31', vial:50, doseLow:10, doseHigh:40, doseUnit:'mg', freq:'1×/day'},
  {name:'5-Amino-1MQ', vial:50, doseLow:5, doseHigh:5, doseUnit:'mg', freq:'1×/day, morning (8–12wk on / 4wk off)'},
  {name:'Sermorelin', vial:9, doseLow:200, doseHigh:300, doseUnit:'mcg', freq:'5 nights/week'},
];
function populatePresetSelect(){
  const sel = $('#calcPreset');
  sel.innerHTML = `<option value="">Custom — enter manually</option>` +
    PEPTIDE_PRESETS.map((p,i)=>`<option value="${i}">${esc(p.name)}</option>`).join('');
  sel.addEventListener('change', ()=>{
    const note = $('#calcPresetNote');
    if(sel.value===''){ note.textContent=''; return; }
    const p = PEPTIDE_PRESETS[+sel.value];
    $('#calcVial').value = p.vial;
    $('#calcDose').value = p.doseUnit==='mcg' ? Math.round(p.doseLow)/1000 : p.doseLow;   // the calculator works in mg by default
    $('#calcDoseUnit').value = 'mg';
    calcEdited('dose');
    note.textContent = `Typical range: ${p.doseLow}–${p.doseHigh} ${p.doseUnit}, ${p.freq}. Prefilled with the low end — adjust to your actual protocol.`;
    runCalc();
  });
}
/* ===================== Syringe graphic ===================== */
// Standard U-100 insulin syringe barrel sizes and the unit scale each one is
// printed with. Modeled on the three sizes PeptideDeck's calculator offers.
const SYRINGE_SIZES = [
  {cap:30,  ml:'0.3', tag:'Best for small doses',  note:'Widest tick spacing — easiest to read under ~10 units.'},
  {cap:50,  ml:'0.5', tag:'Most common',            note:'The default peptide syringe. Easy to read up to 50 units.'},
  {cap:100, ml:'1',   tag:'Large draws',             note:'For doses over ~50 units.'},
];
let _syrSeq = 0;
function syringeSVG(doseUnits, capacityUnits, opts){
  opts = opts || {};
  const compact = !!opts.compact;
  const cap = capacityUnits;
  const uid = 'syr'+(_syrSeq++);
  const overfill = doseUnits > cap;
  const clamped = Math.max(0, Math.min(doseUnits, cap));

  const W = 560, H = compact? 92 : 108;
  const barrelX = 54, barrelW = 420, barrelY = compact? 40 : 48, barrelH = compact? 26 : 30;
  const midY = barrelY + barrelH/2;
  const majorStep = cap<=30 ? 5 : 10;
  const fillColor = overfill ? 'var(--warn)' : (opts.color || 'var(--accent-pep)');

  let ticks = '';
  for(let u=0; u<=cap; u++){
    const x = barrelX + barrelW*(u/cap);
    const isMajor = u % majorStep === 0;
    const isMid = !isMajor && u % 5 === 0;
    const h = isMajor ? 15 : (isMid ? 10 : 6);
    ticks += `<line x1="${x.toFixed(1)}" y1="${barrelY}" x2="${x.toFixed(1)}" y2="${(barrelY-h).toFixed(1)}" stroke="var(--muted)" stroke-width="${isMajor?1.3:1}" opacity="${isMajor?0.95:0.5}"/>`;
    if(isMajor){
      ticks += `<text x="${x.toFixed(1)}" y="${(barrelY-h-4).toFixed(1)}" font-size="9" font-family="IBM Plex Mono, monospace" text-anchor="middle" fill="var(--muted)">${u}</text>`;
    }
  }

  const fillW = barrelW * (clamped/cap);
  const stopperX = barrelX + fillW;
  const rodEndX = barrelX + barrelW + 34;

  const svg = `
  <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Syringe filled to ${doseUnits} of ${cap} units">
    <!-- needle -->
    <line x1="10" y1="${midY}" x2="${barrelX+2}" y2="${midY}" stroke="var(--ink)" stroke-width="2" opacity="0.55"/>
    <!-- barrel fill -->
    <rect x="${barrelX}" y="${barrelY}" width="${fillW.toFixed(1)}" height="${barrelH}" fill="${fillColor}" opacity="0.32"/>
    <!-- barrel outline -->
    <rect x="${barrelX}" y="${barrelY}" width="${barrelW}" height="${barrelH}" rx="4" fill="none" stroke="var(--ink)" stroke-width="1.4" opacity="0.5"/>
    <!-- ticks -->
    ${ticks}
    <!-- plunger stopper -->
    <rect x="${(stopperX-4).toFixed(1)}" y="${barrelY-3}" width="8" height="${barrelH+6}" rx="2" fill="var(--ink)" opacity="0.82"/>
    <!-- plunger rod + flange -->
    <line x1="${stopperX.toFixed(1)}" y1="${midY}" x2="${rodEndX}" y2="${midY}" stroke="var(--ink)" stroke-width="3" opacity="0.35"/>
    <rect x="${rodEndX}" y="${barrelY-6}" width="7" height="${barrelH+12}" rx="2" fill="var(--ink)" opacity="0.35"/>
    <!-- dose callout -->
    <text x="${stopperX.toFixed(1)}" y="${(barrelY+barrelH+18).toFixed(1)}" font-size="10.5" font-weight="600" font-family="IBM Plex Mono, monospace" text-anchor="middle" fill="${fillColor}">${doseUnits.toFixed(1)}u</text>
  </svg>`;
  return svg;
}
function renderSyringeInto(el, doseUnits, capacityUnits, opts){
  if(!el) return;
  el.innerHTML = syringeSVG(doseUnits, capacityUnits, opts);
}

let calcSyringeCap = null; // user-picked override; null = auto
function bestSyringeCap(units){
  const fit = SYRINGE_SIZES.find(s=> units<=s.cap);
  return fit ? fit.cap : SYRINGE_SIZES[SYRINGE_SIZES.length-1].cap;
}
function renderCalcSyringeButtons(activeCap){
  const row = $('#calcSyringeSizeRow');
  if(!row) return;
  row.innerHTML = SYRINGE_SIZES.map(s=> `
    <button type="button" class="syr-size-btn ${s.cap===activeCap?'active':''}" data-cap="${s.cap}">
      <strong>${s.ml} mL <span class="syr-tag">U-100</span></strong>
      <span>${esc(s.tag)}</span>
    </button>`).join('');
  $$('.syr-size-btn', row).forEach(b=> b.addEventListener('click', ()=>{
    calcSyringeCap = +b.dataset.cap;
    runCalc();
  }));
}
function updateCalcSyringe(units){
  const auto = bestSyringeCap(units || 0);
  const activeCap = calcSyringeCap || auto;
  const sizeInfo = SYRINGE_SIZES.find(s=> s.cap===activeCap) || SYRINGE_SIZES[1];
  renderCalcSyringeButtons(activeCap);
  renderSyringeInto($('#calcSyringeGraphic'), units || 0, sizeInfo.cap);
  $('#calcSyringeCaption').textContent = `U-100 · ${sizeInfo.ml} mL barrel`;
  $('#calcSyringeUnitsLabel').textContent = units? `${units.toFixed(1)} of ${sizeInfo.cap} units` : '—';
  const warn = $('#calcSyringeWarn');
  if(units > sizeInfo.cap){
    warn.hidden = false;
    warn.textContent = `This dose exceeds the ${sizeInfo.ml} mL barrel (${sizeInfo.cap} units) — pick a larger syringe.`;
  } else {
    warn.hidden = true;
  }
}

/* Four linked fields: vial mg, BAC water, dose, syringe draw (units). units = dose / (vial / water) × 100.
   One field is calculated from the other three; see calcEdited for which. */
let calcBacUnit = 'ml';
let calcOrder = ['draw','vial','bac','dose'];   // [0] is the calculated field
const CALC_IDS = {vial:'#calcVial', bac:'#calcBac', dose:'#calcDose', draw:'#calcDraw'};
const trimNum = (n, dp)=> String(Math.round(n*Math.pow(10,dp))/Math.pow(10,dp));
function calcBacMl(){ const v = num($('#calcBac').value,0); return calcBacUnit==='units' ? v/100 : v; }
function calcDoseMg(){ const v = num($('#calcDose').value,0); return $('#calcDoseUnit').value==='mcg' ? v/1000 : v; }
// Typing a draw recalculates the BAC water (how much to add for that draw); typing a dose recalculates the draw.
// Editing vial or water keeps whichever field is currently calculated (a cleared field becomes calculated).
function calcEdited(f){
  let t = calcOrder[0];
  if(f==='draw') t = 'bac';
  else if(f==='dose') t = 'draw';
  else if(f===t) t = 'draw';
  calcOrder = [t].concat(['vial','bac','dose','draw'].filter(x=>x!==t));
}
function calcSolve(){
  const target = calcOrder[0];
  const vial = num($('#calcVial').value,0), bac = calcBacMl(), dose = calcDoseMg(), draw = num($('#calcDraw').value,0);
  let out = null;
  if(target==='draw' && vial>0 && bac>0 && dose>0) out = trimNum(dose*bac*100/vial, 2);
  if(target==='dose' && vial>0 && bac>0 && draw>0){ const mg = draw*vial/(bac*100); out = trimNum($('#calcDoseUnit').value==='mcg' ? mg*1000 : mg, $('#calcDoseUnit').value==='mcg' ? 1 : 4); }
  if(target==='bac' && vial>0 && dose>0 && draw>0){ const ml = draw*vial/(dose*100); out = trimNum(calcBacUnit==='units' ? ml*100 : ml, calcBacUnit==='units' ? 1 : 3); }
  if(target==='vial' && bac>0 && dose>0 && draw>0) out = trimNum(dose*bac*100/draw, 3);
  $(CALC_IDS[target]).value = out==null ? '' : out;
  $$('.cf').forEach(c=>{ const on = c.dataset.cf===target; c.classList.toggle('calc', on); $('.cf-badge',c).hidden = !on; });
}
function runCalc(){
  calcSolve();
  const vial = num($('#calcVial').value,0), bac = calcBacMl(), dose = calcDoseMg(), draw = num($('#calcDraw').value,0);
  const conc = vial>0 && bac>0 ? vial/bac : 0;
  const volMl = draw>0 ? draw/100 : 0;
  const f = (n,dp)=> trimNum(n, dp===undefined?2:dp);
  const mgTxt = mg=> mg>=1 ? `${f(mg,3)} mg` : `${f(mg*1000,1)} mcg (${f(mg,4)} mg)`;
  $('#calcVialConv').textContent = vial>0 && bac>0 ? `≈ ${f(bac,3)} mL · ${f(bac*100,1)} units (full vial)` : '';
  $('#calcBacConv').textContent = bac>0 ? `≈ ${calcBacUnit==='units' ? f(bac,3)+' mL' : f(bac*100,1)+' units'}${vial>0 ? ` · holds ${f(vial,3)} mg peptide` : ''}` : '';
  $('#calcDoseConv').textContent = dose>0 && conc>0 ? `≈ ${f(dose/conc,3)} mL · ${f(dose/conc*100,2)} units` : '';
  $('#calcDrawConv').textContent = draw>0 && conc>0 ? `≈ ${mgTxt(draw/100*conc)} · ${f(volMl,3)} mL` : '';
  $('#calcConc').textContent = conc ? f(conc,2) : '—';
  $('#calcMl').textContent = volMl ? f(volMl,3) : '—';
  $('#calcDosesPerVial').textContent = dose>0 && vial>0 ? f(vial/dose,1) : '—';
  $('#calcPerUnit').textContent = conc ? `1 unit = ${f(conc*10,2)} mcg (${f(conc/100,4)} mg)` : '';
  updateCalcSyringe(draw);
  if(typeof runEndo==='function') runEndo();
}
Object.entries(CALC_IDS).forEach(([k,sel])=> $(sel).addEventListener('input', ()=>{ calcEdited(k); runCalc(); }));
$('#calcDoseUnit').addEventListener('change', ()=>{
  // keep the same amount, just shown in the other unit
  const v = num($('#calcDose').value,null);
  if(v!=null && calcOrder[0]!=='dose') $('#calcDose').value = trimNum($('#calcDoseUnit').value==='mcg' ? v*1000 : v/1000, 4);
  runCalc();
});
$$('[data-bac-unit]').forEach(b=> b.addEventListener('click', ()=>{
  const u = b.dataset.bacUnit; if(u===calcBacUnit) return;
  const v = num($('#calcBac').value,null);
  calcBacUnit = u;
  if(v!=null) $('#calcBac').value = trimNum(u==='units' ? v*100 : v/100, u==='units' ? 1 : 3);
  $$('[data-bac-unit]').forEach(x=> x.classList.toggle('on', x.dataset.bacUnit===u));
  runCalc();
}));
$$('[data-clear]').forEach(b=> b.addEventListener('click', ()=>{
  const k = b.dataset.clear;
  $(CALC_IDS[k]).value = '';
  calcOrder = [k].concat(calcOrder.filter(x=>x!==k));   // a cleared field becomes the calculated one
  runCalc();
  $(CALC_IDS[k]).focus();
}));
$('#calcReset').addEventListener('click', ()=>{
  $('#calcVial').value = 5; $('#calcDose').value = 0.25; $('#calcDoseUnit').value = 'mg';
  calcBacUnit = 'ml'; $('#calcBac').value = 2; $$('[data-bac-unit]').forEach(x=> x.classList.toggle('on', x.dataset.bacUnit==='ml'));
  $('#calcPreset').value = ''; $('#calcPresetNote').textContent = '';
  calcOrder = ['draw','vial','bac','dose']; calcSyringeCap = null;
  runCalc();
});



/* Endotoxin check — modeled on PeptideSafe: 5 EU/kg per dose (IV/IM/SubQ), 0.2 EU/kg intrathecal. */
const ENDO_DATA = {"T":[["Semaglutide",0.25,"mg"],["Tirzepatide",2.5,"mg"],["Retatrutide",1,"mg"],["Liraglutide",0.6,"mg"],["Dulaglutide",0.75,"mg"],["Cagrilintide",0.3,"mg"],["Orforglipron",3,"mg"],["Eloralintide",1,"mg"],["Mazdutide",3,"mg"],["Cotadutide",0.6,"mg"],["Exenatide",2,"mg"],["Lixisenatide",0.02,"mg"],["Efinopegdutide",6,"mg"],["Ipamorelin",200,"mcg"],["CJC-1295 (no DAC)",100,"mcg"],["CJC-1295 (DAC)",1,"mg"],["GHRP-2",100,"mcg"],["GHRP-6",100,"mcg"],["Hexarelin",100,"mcg"],["Sermorelin",300,"mcg"],["Tesamorelin",1,"mg"],["MK-677 (Ibutamoren)",25,"mg"],["BPC-157",250,"mcg"],["TB-500 (Thymosin Beta-4)",2,"mg"],["KPV",500,"mcg"],["AOD-9604",300,"mcg"],["GHK-Cu",1,"mg"],["Thymosin Alpha-1",1.6,"mg"],["Thymosin Beta-4 (full length)",2,"mg"],["AHK-Cu",1,"mg"],["PNC-27",5,"mg"],["PNC-28",5,"mg"],["FGL Peptide",200,"mcg"],["PGP Peptide",100,"mcg"],["PT-141 (Bremelanotide)",1,"mg"],["Melanotan II",500,"mcg"],["Melanotan I (Afamelanotide)",16,"mg"],["Setmelanotide",3,"mg"],["Selank",250,"mcg"],["Semax",300,"mcg"],["Dihexa",100,"mcg"],["Cerebrolysin",5,"mg"],["NA-Selank (N-Acetyl Selank)",300,"mcg"],["NA-Semax (N-Acetyl Semax)",300,"mcg"],["Noopept",20,"mg"],["Epithalon",5,"mg"],["MOTS-c",5,"mg"],["SS-31 (Elamipretide)",1,"mg"],["Humanin",100,"mcg"],["SHLP-2",100,"mcg"],["SHLP-3",100,"mcg"],["SHLP-6",100,"mcg"],["MTP-131",1,"mg"],["Thymulin",200,"mcg"],["Tuftsin",100,"mcg"],["RP-182",500,"mcg"],["Gepon",200,"mcg"],["Adrenomedullin",50,"mcg"],["ANP (Atrial Natriuretic Peptide)",50,"mcg"],["BNP (B-type Natriuretic Peptide)",50,"mcg"],["CNP (C-type Natriuretic Peptide)",50,"mcg"],["NAD+",50,"mg"],["NMN",100,"mg"],["IGF-1 LR3",50,"mcg"],["MGF (Mechano Growth Factor)",200,"mcg"],["PEG-MGF",200,"mcg"],["Follistatin-344",100,"mcg"],["IGF-1 DES",50,"mcg"],["ACE-031",1,"mg"],["Myostatin Propeptide",1,"mg"],["Gonadorelin",100,"mcg"],["Kisspeptin-10",100,"mcg"],["Oxytocin",10,"mcg"],["Kisspeptin-54",1,"mg"],["5-Amino-1MQ",50,"mg"],["LL-37",100,"mcg"],["VIP (Vasoactive Intestinal Peptide)",50,"mcg"],["Delta Sleep-Inducing Peptide (DSIP)",200,"mcg"],["Pinealon",100,"mcg"],["Vilon",100,"mcg"],["KLOW Blend 80mg",500,"mcg"],["GLOW Blend 70mg",500,"mcg"]],"F":{"Semaglutide":[7.2,"mg"],"Tirzepatide":[15,"mg"],"Retatrutide":[12,"mg"],"Liraglutide":[3,"mg"],"Dulaglutide":[4.5,"mg"],"Cagrilintide":[2.4,"mg"],"Cagrisema (Cagrilintide + Semaglutide blend)":[2.4,"mg"],"Mezdutide (GLP-1/glucagon)":[3,"mg"],"Survodutide (GLP-1/glucagon dual agonist)":[6,"mg"],"Orforglipron":[36,"mg"],"GLP-2 (Glepaglutide)":[10,"mg"],"Ipamorelin":[500,"mcg"],"CJC-1295 (no DAC) / ModGRF 1-29":[300,"mcg"],"CJC-1295 (DAC)":[2,"mg"],"GHRH (Growth Hormone-Releasing Hormone)":[100,"mcg"],"GHRP-2":[300,"mcg"],"GHRP-6":[300,"mcg"],"Hexarelin":[200,"mcg"],"Sermorelin":[500,"mcg"],"Tesamorelin":[2,"mg"],"MK-677 (Ibutamoren)":[25,"mg"],"hGH Fragment 176-191 / AOD-9604":[500,"mcg"],"BPC-157":[1000,"mcg"],"TB-500 (Thymosin Beta-4)":[5,"mg"],"KPV (alpha-MSH fragment)":[1000,"mcg"],"GHK-Cu (Copper Peptide)":[10,"mg"],"GHK Basic (without copper)":[3,"mg"],"Thymosin Alpha-1":[3.2,"mg"],"ARA-290 (Cibinetide)":[4,"mg"],"B7-33 (relaxin fragment)":[500,"mcg"],"FOXO4-DRI (senolytic)":[10,"mg"],"Adipotide (FTPP)":[1,"mg"],"LL-37 (CAP-18)":[500,"mcg"],"Thymagen (dipeptide)":[200,"mcg"],"PT-141 (Bremelanotide)":[1.75,"mg"],"Melanotan II":[1000,"mcg"],"Kisspeptin-10":[300,"mcg"],"Triptorelin (GnRH analogue)":[3.75,"mg"],"Gonadorelin (GnRH)":[500,"mcg"],"Selank":[500,"mcg"],"N-Acetyl Selank Amidate":[300,"mcg"],"Semax":[600,"mcg"],"N-Acetyl Semax Amidate":[300,"mcg"],"Dihexa":[200,"mcg"],"Cerebrolysin":[50,"mg"],"SNAP-8 (cosmetic anti-wrinkle peptide)":[500,"mcg"],"VIP (Vasoactive Intestinal Peptide)":[200,"mcg"],"Epithalon (Epitalon)":[10,"mg"],"N-Acetyl Epithalon Amidate":[10,"mg"],"MOTS-c":[10,"mg"],"SS-31 (Elamipretide)":[40,"mg"],"Humanin":[500,"mcg"],"Pinealon":[200,"mcg"],"Vilon (dipeptide)":[400,"mcg"],"Follistatin-315":[100,"mcg"],"Follistatin-344":[100,"mcg"],"IGF-1 LR3":[100,"mcg"],"MGF (C-terminal / Mechano Growth Factor)":[300,"mcg"],"PEG-MGF (Pegylated MGF)":[400,"mcg"],"AICAR (AMPK activator)":[50,"mg"],"Oxytocin":[20,"mcg"],"NAD+":[100,"mg"],"NMN":[500,"mg"],"Glutathione":[600,"mg"],"Delta Sleep-Inducing Peptide (DSIP)":[500,"mcg"],"5-Amino-1MQ":[100,"mg"],"KLOW Blend 80mg":[500,"mcg"],"KLOW8 Blend":[500,"mcg"],"GLOW Blend 70mg":[500,"mcg"],"Tesa-Ipa Blend (Tesamorelin + Ipamorelin)":[1300,"mcg"]}};
const ENDO_LIMITS = {SubQ:5, IM:5, IV:5, IT:0.2};
const ENDO_TIERS = [
  {max:0.1, cls:'ok',   label:'Within FDA reference range', text:'This dose falls within the FDA reference endotoxin ceiling for this route. It does not mean the dose or product is safe, sterile or appropriate for any individual.'},
  {max:0.5, cls:'ok',   label:'Within FDA reference range', text:'Endotoxin load is within the FDA reference limit for this route. Make sure the EU values come from an independent lab test, not a vendor CoA.'},
  {max:1,   cls:'warn', label:'Approaching FDA ceiling', text:'This dose is within the reference limit but approaching the ceiling. Consider a lower dose or a higher-purity source, especially for frequent or repeated dosing.'},
  {max:2,   cls:'bad',  label:'Exceeds FDA reference limit', text:'This dose exceeds the FDA endotoxin reference threshold for this route. Do not treat this figure as guidance to proceed. Review your source and independent lab results.'},
  {max:Infinity, cls:'bad', label:'Significantly exceeds FDA reference limit', text:'Severely exceeds the FDA reference limits. High pyrogen risk. Do not use this product at this dose. Source independently tested material.'}
];
function endoMax(name, unit){
  const F = ENDO_DATA.F;
  let k = F[name] ? name : Object.keys(F).find(x=> x.toLowerCase().startsWith(name.toLowerCase()) || name.toLowerCase().startsWith(x.split(' (')[0].toLowerCase()));
  if(!k) return null;
  const [mx, u] = F[k];
  return u===unit ? mx : (u==='mg' && unit==='mcg') ? mx*1000 : (u==='mcg' && unit==='mg') ? mx/1000 : mx;
}
function endoFind(name){ return ENDO_DATA.T.find(r=> r[0].toLowerCase()===String(name||'').trim().toLowerCase()); }
let endoStack = [];
function renderEndoStack(){
  const box = $('#endoStack'); if(!box) return;
  box.innerHTML = endoStack.map((r,i)=>`
    <div class="endo-stackrow" data-i="${i}">
      <div class="field es-name"><label>Compound ${i+1}</label><div class="es-line"><input type="text" list="endoCompounds" data-f="name" value="${esc(r.name)}" placeholder="Name"><button class="es-rm rm" type="button" data-rm="${i}" aria-label="Remove compound ${i+1}">✕</button></div></div>
      <div class="field"><label>Dose</label><div class="es-line"><input type="number" data-f="dose" inputmode="decimal" min="0" step="any" value="${esc(r.dose)}"><select data-f="unit"><option value="mcg" ${r.unit==='mcg'?'selected':''}>mcg</option><option value="mg" ${r.unit==='mg'?'selected':''}>mg</option></select></div></div>
      <div class="field"><label>EU/mg (lab)</label><input type="number" data-f="eumg" inputmode="decimal" min="0" step="any" value="${esc(r.eumg)}"></div>
    </div>`).join('');
}
function runEndo(){
  const el = $('#endoResult'); if(!el) return;
  const kg = num($('#endoWeight').value,0), totalEU = num($('#endoEU').value,0), route = $('#endoRoute').value;
  const vialMg = num($('#calcVial').value,0), bac = calcBacMl();
  const unit = $('#calcDoseUnit').value;
  const doseVal = num($('#calcDose').value,0);
  const doseMg = unit==='mg' ? doseVal : doseVal/1000;
  const perKg = ENDO_LIMITS[route];
  try{ if(kg>0) localStorage.setItem('ledger.endoWeight', String(kg)); }catch(e){}
  $$('#endoTable tr[data-kg]').forEach(r=> r.classList.toggle('me', kg>0 && Math.abs(num(r.dataset.kg)-kg)<0.01));
  // compound hint
  const name = $('#endoCompound').value.trim(), row = endoFind(name), note = $('#endoCompoundNote');
  if(row){ const mx = endoMax(row[0], unit); note.innerHTML = `Typical dose ${row[1]} ${row[2]}${mx?`. Reference max ${mx} ${unit}.`:'.'} <a href="#" id="endoUseTypical">Use typical dose</a>`; }
  else note.textContent = '';
  const msg = t=>{ el.innerHTML = `<div class="footnote">${t}</div>`; };
  if(!(kg>0)) return msg('Enter your body weight and the vial\'s total EU to check this dose.');
  if(!(vialMg>0)) return msg('Enter a vial size in the calculator above.');
  if(!(doseMg>0)) return msg('Enter a dose in the calculator above.');
  if(!(totalEU>0)) return msg('Enter the total EU for your vial from an independent lab test.');
  if(doseMg>vialMg) return msg(`Dose (${doseMg} mg) exceeds vial content (${vialMg} mg). Reduce the dose or use a larger vial.`);
  const primary = totalEU/vialMg*doseMg;
  const parts = [{name:name||'Compound 1', dose:`${doseVal} ${unit}`, eu:primary}];
  let total = primary;
  for(let i=0;i<endoStack.length;i++){
    const r = endoStack[i], d = num(r.dose,0), e = num(r.eumg,0);
    if(!(d>0)) return msg(`Additional compound ${i+1}: enter a dose.`);
    if(!(e>0)) return msg(`Additional compound ${i+1}: enter EU/mg from your lab test.`);
    const eu = e*(r.unit==='mcg'? d/1000 : d);
    total += eu; parts.push({name:r.name||`Compound ${i+2}`, dose:`${d} ${r.unit}`, eu});
  }
  const perKgDose = total/kg, limit = perKg*kg, ratio = perKgDose/perKg;
  const tier = ENDO_TIERS.find(t=> ratio<=t.max), pct = ratio*100;
  const vialBand = totalEU>100 ? ['bad','Very high total vial endotoxin. Serious quality concern.'] : totalEU>10 ? ['warn','Elevated total vial endotoxin. Quality caution.'] : null;
  const volMl = bac>0 ? doseMg/(vialMg/bac) : 0;
  const doses = Math.floor(vialMg/doseMg);
  const pen = $('#endoPen').checked, ic = num($('#endoClick').value,1);
  const clicks = pen && volMl ? Math.round(volMl/(ic*0.01)) : null;
  let cycle = '';
  if($('#endoCycle').checked){
    const pd = num($('#endoPerDay').value,1), dw = num($('#endoDays').value,1), wk = num($('#endoWeeks').value,1);
    const n = pd*dw*wk;
    cycle = `<h4 style="margin:16px 0 8px;font-size:14px;">Cycle summary</h4><div class="endo-stats">
      <div class="endo-stat"><div class="v">${n}</div><div class="l">Total injections</div></div>
      <div class="endo-stat"><div class="v">${(total*n).toFixed(2)}</div><div class="l">Total EU, full cycle</div></div>
      <div class="endo-stat"><div class="v">${(total*pd/kg).toFixed(4)}</div><div class="l">Peak daily EU/kg</div></div>
      <div class="endo-stat"><div class="v">${(total*pd*dw).toFixed(2)}</div><div class="l">Weekly EU load</div></div></div>`;
  }
  const stackTbl = parts.length>1 ? `<div style="overflow-x:auto;margin-top:12px;"><table class="endo-tbl"><thead><tr><th>Compound</th><th>Dose</th><th>EU/dose</th><th>% of total</th></tr></thead><tbody>${parts.map(p=>`<tr><td>${esc(p.name)}</td><td>${esc(p.dose)}</td><td>${p.eu.toFixed(4)}</td><td>${(total>0?p.eu/total*100:0).toFixed(1)}%</td></tr>`).join('')}</tbody></table></div>` : '';
  const mx = row ? endoMax(row[0], unit) : null;
  const overMax = mx && doseVal>mx ? `<div class="endo-banner warn">The calculator dose (${doseVal} ${unit}) is above the reference maximum for ${esc(row[0])} (${mx} ${unit}).</div>` : '';
  el.innerHTML = `
    ${vialBand ? `<div class="endo-banner ${vialBand[0]}"><strong>${vialBand[1]}</strong> This vial holds ${totalEU.toFixed(1)} EU in total. Injectable products are typically made to under 5 to 10 EU per vial. A high vial total does not by itself put one dose over the per-kg limit, but every dose from it adds up. Independent LAL testing is strongly recommended.</div>` : ''}
    ${overMax}
    <div class="endo-banner ${tier.cls==='ok'?'':tier.cls}"><strong>${tier.label}.</strong> ${tier.text} Reference ceiling: ${perKg} EU/kg per dose for ${route==='IT'?'intrathecal/spinal':'IV/IM/SubQ'} routes (${round2(limit)} EU at ${kg} kg).</div>
    <div class="endo-stats">
      <div class="endo-stat"><div class="v">${total.toFixed(total<10?3:1)}</div><div class="l">EU per ${parts.length>1?'injection (stack)':'dose'}</div></div>
      <div class="endo-stat"><div class="v">${perKgDose.toFixed(3)}</div><div class="l">EU/kg</div></div>
      <div class="endo-stat"><div class="v">${pct<10?pct.toFixed(1):Math.round(pct)}%</div><div class="l">of ${perKg} EU/kg limit</div></div>
      <div class="endo-stat"><div class="v">${volMl?volMl.toFixed(3):'—'}</div><div class="l">mL drawn</div></div>
      ${clicks!=null?`<div class="endo-stat"><div class="v">${clicks}</div><div class="l">pen clicks (${ic} units each)</div></div>`:''}
      <div class="endo-stat"><div class="v">${doses}</div><div class="l">doses in vial</div></div>
    </div>
    <div class="endo-meter ${tier.cls==='ok'?'':tier.cls}"><i style="width:${Math.min(100,pct)}%"></i></div>
    ${stackTbl}${cycle}`;
}
(function initEndo(){
  const t = $('#endoTable'); if(!t) return;
  const kgs = [50,60,70,75,80,90,100,110,120];
  t.innerHTML = `<thead><tr><th>Body weight</th><th>Max EU/dose (IM, SubQ, IV)</th><th>Intrathecal max</th><th>Calculation</th></tr></thead><tbody>`+
    kgs.map(k=>`<tr data-kg="${k}"><td>${k} kg</td><td>${(k*5).toFixed(1)} EU</td><td>${(k*0.2).toFixed(1)} EU</td><td>${k} × 5 EU/kg</td></tr>`).join('')+`</tbody>`;
  $('#endoCompounds').innerHTML = ENDO_DATA.T.map(r=>`<option value="${esc(r[0])}"></option>`).join('');
  try{ const w = localStorage.getItem('ledger.endoWeight'); if(w) $('#endoWeight').value = w; }catch(e){}
  ['endoWeight','endoRoute','endoEU','endoCompound','endoClick','endoPerDay','endoDays','endoWeeks','calcVial','calcBac','calcDose','calcDoseUnit'].forEach(id=>{
    $('#'+id).addEventListener('input', runEndo); $('#'+id).addEventListener('change', runEndo); });
  $('#endoPen').addEventListener('change', ()=>{ $('#endoPenBox').hidden = !$('#endoPen').checked; runEndo(); });
  $('#endoCycle').addEventListener('change', ()=>{ $('#endoCycleBox').hidden = !$('#endoCycle').checked; runEndo(); });
  $('#endoAddBtn').addEventListener('click', ()=>{ endoStack.push({name:'',dose:'',unit:'mcg',eumg:''}); renderEndoStack(); runEndo(); });
  $('#endoStack').addEventListener('input', e=>{
    const rowEl = e.target.closest('[data-i]'); if(!rowEl) return;
    const r = endoStack[+rowEl.dataset.i]; const f = e.target.dataset.f; if(!r||!f) return;
    r[f] = e.target.value;
    if(f==='name'){ const m = endoFind(e.target.value); if(m && !r.dose){ r.dose = String(m[1]); r.unit = m[2]; renderEndoStack(); } }
    runEndo();
  });
  $('#endoStack').addEventListener('click', e=>{
    const b = e.target.closest('[data-rm]'); if(!b) return;
    endoStack.splice(+b.dataset.rm,1); renderEndoStack(); runEndo();
  });
  $('#endoCompoundNote').addEventListener('click', e=>{
    if(e.target.id!=='endoUseTypical') return; e.preventDefault();
    const row = endoFind($('#endoCompound').value); if(!row) return;
    $('#calcDose').value = row[1]; $('#calcDoseUnit').value = row[2]; calcEdited('dose'); runCalc();
  });
  runEndo();
})();

$('#resourceLinks').innerHTML = [
  ['https://www.peptideschedule.com','📅 Peptide Schedule'],
  ['https://peptidedosages.com','💉 Peptide Dosages'],
  ['https://voracious-headstand-97f.notion.site/Peptides-Database-0a5ceea6bb204083af1fee80797e14cd','🗂 Peptides Database (Notion)'],
  ['https://rtplabs.xyz/axis-plus/','🧪 RTP Labs: Axis Plus'],
  ['https://chat.peppys.org','💬 Peppys chat'],
  ['https://m-mps.com/product-codes/','🏷 MPS product codes'],
].map(([href,label])=>`<a class="link-chip" href="${href}" target="_blank" rel="noopener">${label}</a>`).join('');
(function(){
  const chip=(h,t)=>`<a class="link-chip" href="${h}" target="_blank" rel="noopener">${t}</a>`;
  $('#howtoLinks').innerHTML = [
    ['https://www.stairwaytogray.com/posts/testing/testing-101/#endotoxin','Testing 101 (incl. endotoxin)'],
    ['https://www.peprecon.com/research/bac-water-stability/','120-day Hospira BAC water stability'],
    ['https://bioplexpeptides.co.uk/pages/reconstitution-of-peptides','Reconstitution guide'],
    ['https://www.polybiotech.co/blogs/news/why-did-my-peptide-turn-cloudy-or-gel-after-reconstitution','Why a peptide goes cloudy or gels'],
    ['https://labeling.pfizer.com/ShowLabeling.aspx?id=4666','Pfizer BAC water label'],
    ['https://www.daropep.net/pen-comparison-v2/','Injection pen comparison'],
    ['https://www.thermofisher.com/order/catalog/product/A39553','Endotoxin test kit (Thermo)'],
    ['https://www.consumermedsafety.org/safety-articles/the-hidden-risk-of-reusing-pen-needles','Risk of reusing pen needles'],
    ['https://pep-pedia.org/','Pep-Pedia'],
    ['https://janoshik.com/','Janoshik (lab)']
  ].map(x=>chip(x[0],x[1])).join('');
})();

/* ===================== Peptides: Protocols ===================== */
const PROTOCOL_COLORS = ['#ff9f43','#5aa9ff','#4fb477','#e0574c','#8b6fe8','#16a394','#c25fd1','#d9b82e'];
/* Fixed color per compound, grouped by family so a color never shifts when protocols are reordered:
   metabolic = pink/green/orange, growth hormone = blues, calm & focus = violets, skin/gut/longevity = teal/coral/gold. */
// Optional pinned colors, keyed by lowercase compound name, e.g. {'bpc-157':'#2f9e5e','tb-500':'#5aa9f0'}.
// Left empty on purpose: unpinned compounds cycle through PROTOCOL_COLORS above.
const PROTOCOL_COLOR_OVERRIDES = {};
function protocolColor(p, i){
  const key = (p.compound||'').trim().toLowerCase();
  if(PROTOCOL_COLOR_OVERRIDES[key]) return PROTOCOL_COLOR_OVERRIDES[key];
  return PROTOCOL_COLORS[i % PROTOCOL_COLORS.length];
}
function syringeMl(p){ return num(p.syringeMl, 1); }
function syringeCapacityUnits(p){ return Math.round(syringeMl(p)*100); }
function isActiveP(p){ return !p.status || p.status==='active'; }
function protocolColorMap(){
  const list = state.protocols.filter(p=>p.status!=='archived').slice().sort((a,b)=> num(a.sortOrder,999)-num(b.sortOrder,999));
  const map = new Map();
  list.forEach((p,i)=> map.set(p.id, protocolColor(p,i)));
  return map;
}

/* Fixed weekdays (0=Sun..6=Sat) override "days between doses". Average days between doses, for usage and cost maths. */
function weekdaysOf(p){ return Array.isArray(p.activeWeekdays) && p.activeWeekdays.length ? p.activeWeekdays.map(Number) : null; }
function effectiveFreqDays(p){ const w = weekdaysOf(p); return w ? 7/w.length : num(p.frequencyDays,null); }
const DOW = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
function fmtClock(hhmm){
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm||''); if(!m) return '';
  const h = +m[1]; return `${((h+11)%12)+1}:${m[2]} ${h>=12?'PM':'AM'}`;
}
/* First scheduled dose date on or after fromISO for a weekday-based protocol. */
function nextScheduledDate(p, fromISO){
  const r = doseDatesInRange({...p, status:'active', nextDose:fromISO, frequencyDays:1}, fromISO, addDays(fromISO, 400));
  return r[0] || null;
}
function scheduleLabel(p){
  const w = weekdaysOf(p);
  const t = fmtClock(p.doseTime);
  if(w) return w.slice().sort((x,y)=>x-y).map(i=>DOW[i]).join(' · ') + (t?` · ${t}`:'');
  return t ? `Usually ${t}` : '';
}
function doseDatesInRange(p, startISO, endISO){
  if(!isActiveP(p)) return [];
  const freq = num(p.frequencyDays, null);
  const anchor = p.nextDose || p.startDate;
  if(!freq || freq<=0 || !anchor) return [];
  const onDays = num(p.cycleOnWeeks,0)*7, offDays = num(p.cycleOffWeeks,0)*7;
  const cycleTotal = onDays+offDays;
  const hasCycle = !!(p.cycleStart && cycleTotal>0);
  const weekdays = Array.isArray(p.activeWeekdays) && p.activeWeekdays.length ? p.activeWeekdays.map(Number) : null;
  const dates = [];
  const span = daysBetween(startISO, endISO);
  for(let i=0;i<=span;i++){
    const iso = addDays(startISO, i);
    const diff = daysBetween(anchor, iso);
    if(diff < 0) continue;
    if(diff % freq !== 0) continue;
    if(weekdays && !weekdays.includes(new Date(iso+'T00:00:00').getDay())) continue;
    if(hasCycle){
      let elapsed = daysBetween(p.cycleStart, iso) % cycleTotal;
      if(elapsed<0) elapsed += cycleTotal;
      if(elapsed>=onDays) continue; // off-cycle day, no dose
    }
    dates.push(iso);
  }
  return dates;
}

function renderProtocolCalendar(){
  const el = $('#protocolCalendar');
  if(!el) return;
  const activeProtocols = state.protocols.filter(isActiveP);
  if(!activeProtocols.length){ el.innerHTML=''; return; }
  const days = 14;
  const startISO = todayISO();
  const endISO = addDays(startISO, days-1);
  const colorMap = protocolColorMap();
  const perProtocol = activeProtocols.map((p)=> ({p, color: colorMap.get(p.id), dates: new Set(doseDatesInRange(p, startISO, endISO))}));
  let html = `<div class="footnote" style="margin-bottom:6px;">Next ${days} days</div><div class="week-strip">`;
  for(let i=0;i<days;i++){
    const iso = addDays(startISO, i);
    const d = new Date(iso+'T00:00:00');
    const hits = perProtocol.filter(x=> x.dates.has(iso));
    html += `<div class="day-chip ${i===0?'today':''}" style="cursor:default;" title="${hits.map(h=>esc(h.p.compound||'')).join(', ')}">
      <div class="dow">${d.toLocaleDateString(undefined,{weekday:'short'})}</div>
      <div class="num">${d.getDate()}</div>
      <div class="marks">${hits.map(h=>`<span style="background:${h.color};"></span>`).join('')}</div>
    </div>`;
  }
  html += `</div>`;
  html += `<div style="display:flex;gap:12px;flex-wrap:wrap;margin-top:8px;">${perProtocol.map(x=>`
    <span style="display:inline-flex;align-items:center;gap:5px;font-size:12px;color:var(--muted);">
      <span style="width:8px;height:8px;border-radius:50%;background:${x.color};display:inline-block;flex:none;"></span>${esc(x.p.compound||'Untitled')}
    </span>`).join('')}</div>`;
  el.innerHTML = html;
}

/* Dose-tab cards start minimised; expanded ones stay open until the app is reloaded. */
const expandedCards = new Set();
function fmtMoment(t, withTime){
  const d = new Date(t);
  const ds = d.toLocaleDateString(undefined,{weekday:'short', month:'short', day:'numeric'});
  return withTime===false ? ds : `${ds} · ${d.toLocaleTimeString(undefined,{hour:'numeric', minute:'2-digit'})}`;
}
/* The next scheduled injection not yet logged (ms), or the stored next-dose date at the usual time. */
function nextDoseMoment(p){
  if(p.startDate && p.startDate > todayISO()) return null;
  const now = Date.now();
  const n = splitCount(p);
  const ev = scheduledEvents(p, now - 20*HOUR, now + 120*24*HOUR).find(e=> injectionsOn(p, isoFromDate(new Date(e.t - 2*HOUR))) < n);
  if(ev) return ev.t;
  if(!p.nextDose) return null;
  return momentOn(p.nextDose, p.doseTime||'') || new Date(p.nextDose+'T12:00:00').getTime();
}
function renderProtocols(){
  renderProtocolCalendar();
  const el = $('#protocolList');
  const active = state.protocols.filter(isActiveP);
  const paused = state.protocols.filter(p=>p.status==='paused').sort((a,b)=> (a.compound||'').localeCompare(b.compound||''));
  const lbl = $('#doseTodayLabel');
  if(lbl){
    const day = doseDayISO();
    const sched = active.filter(p=> doseDatesInRange(p, day, day).length);
    const due = sched.filter(p=> injectionsOn(p, day) < splitCount(p)).length;
    lbl.textContent = !active.length ? '' : due ? `${due} due today` : sched.length ? "Today's doses done" : 'No doses due today';
  }
  if(!active.length){
    el.innerHTML = `<div class="empty"><div class="glyph">💉</div><p>No active protocols. Add one on the Protocols tab to start logging doses.</p><button type="button" class="btn btn-sm" data-goto-tab="protocols">Go to Protocols</button></div>`;
    $$('[data-goto-tab]',el).forEach(b=> b.addEventListener('click', ()=> setTab(b.dataset.gotoTab)));
    return;
  }
  // Active (started, not off-cycle) protocols A-Z first; then the rest by sortOrder.
  const isLive = p=>{
    if(p.startDate && p.startDate > todayISO()) return false;
    const c = (p.cycleStart && p.cycleOnWeeks!=null) ? cyclePosition(p) : null;
    return !(c && c.phase==='off');
  };
  const grp = p=> isLive(p) ? 1 : 2;
  const ordered = active.slice().sort((a,b)=>{
    const ga=grp(a), gb=grp(b);
    if(ga!==gb) return ga-gb;
    if(ga===1) return (a.compound||'').localeCompare(b.compound||'', undefined, {sensitivity:'base'});
    return num(a.sortOrder,999)-num(b.sortOrder,999);
  });
  const colorMap = protocolColorMap();
  const day = doseDayISO();
  const serum = serumSeries().series;
  el.innerHTML = `<div class="pen-list">${ordered.map((p,i)=> penRowHTML(p, colorMap.get(p.id) || PROTOCOL_COLORS[0], day, i)).join('')}</div>`;
  $$('[data-pen]',el).forEach(b=> b.addEventListener('click', ()=> openDoseModal(state.protocols.find(x=>x.id===b.dataset.pen))));
}
/* Buttons and widgets inside a protocol's dose details (now shown in the review screen). */
function bindDoseDetail(root, serum){
  $$('[data-syr-units]',root).forEach(w=> renderSyringeInto(w, num(w.dataset.syrUnits,0), num(w.dataset.syrCap,100), {compact:true, color: w.dataset.syrColor||undefined}));
  $$('[data-dose-history]',root).forEach(b=> b.addEventListener('click', e=>{ e.stopPropagation(); openDoseHistoryModal(state.protocols.find(p=>p.id===b.dataset.doseHistory)); }));
  $$('[data-edit-protocol]',root).forEach(b=> b.addEventListener('click', e=>{ e.stopPropagation(); openProtocolModal(state.protocols.find(p=>p.id===b.dataset.editProtocol)); }));
  $$('[data-vial-swap]',root).forEach(b=> b.addEventListener('click', e=>{
    e.stopPropagation();
    const p = state.protocols.find(x=>x.id===b.dataset.vialSwap); if(!p) return;
    const vs = vialState(p);
    openVialSwapModal({p, cur: vs.vial, preselect: vs.kind==='unopened' ? vs.vial : null});
  }));
  $$('[data-goto-checkin]',root).forEach(b=> b.addEventListener('click', e=>{ e.stopPropagation(); closeModal(); setTab('progress'); }));
  $$('[data-mini]',root).forEach(w=>{
    const now = Date.now();
    const ctx = serumCtx(serum.filter(s=>s.p.id===w.dataset.mini), now, false);
    serumSvgInner(ctx, now + 2*24*HOUR, 7*24*HOUR);   // sets ctx.scale to match the drawn chart
    attachSerumScrub(w, ctx);
  });
  $$('[data-full-chart]',root).forEach(b=> b.addEventListener('click', e=>{
    e.stopPropagation();
    const pid = b.dataset.fullChart;
    [...serumHidden].forEach(id=>{ if(id===pid || id.startsWith(pid+':')) serumHidden.delete(id); });
    saveSerumHidden(); closeModal(); renderSerum();
    const c = $('#serumCard'); if(c) c.scrollIntoView({behavior:'smooth', block:'start'});
  }));
}
/* One protocol as an injection pen; the whole pen is a button that opens the review screen. */
function penRowHTML(p, color, day, i){
  const m = doseCardHTML(p, color, day, null, {meta:true});
  const pct = m.vs.vial ? (m.vs.vial.remainingMg==null ? 1 : num(m.vs.vial.mgPerVial,0)>0 ? num(m.vs.vial.remainingMg,0)/num(m.vs.vial.mgPerVial,1) : null) : null;
  const status = m.vs.kind==='empty' ? 'Vial empty' : m.vs.kind==='low' && !m.complete ? `${m.status} · vial low` : m.status;
  const kind = m.vs.kind==='empty' ? 'bad' : m.stCls;
  const dose = m.amt.replace(/^([\d.]+)([a-z]+)$/i, '$1 $2');
  return `<button type="button" class="dose-pen" data-pen="${p.id}" aria-label="${esc(`${p.compound||'Protocol'}, ${dose}, ${status}. Tap to review and log.`)}">
    ${penSVG({color, name: p.compound||'Untitled', dose, units: m.u!=null ? m.u : '—', sched: scheduleTag(p), status, kind, pct}, 'pn'+i)}</button>`;
}
/* Review & log screen for a protocol: the pen, a confirm box with dose, units and time, then the full details. */
function openDoseModal(p){
  if(!p) return;
  const color = protocolColorMap().get(p.id) || PROTOCOL_COLORS[0];
  const day = doseDayISO(), serum = serumSeries().series;
  const m = doseCardHTML(p, color, day, serum, {meta:true});
  const now = new Date(), hh = String(now.getHours()).padStart(2,'0'), mm = String(now.getMinutes()).padStart(2,'0');
  const doneTimes = (Array.isArray(p.doseTimes) ? p.doseTimes : []).filter(x=> x && x.day===day).map(x=> new Date(x.t).toLocaleTimeString(undefined,{hour:'numeric', minute:'2-digit'}));
  const dose = m.amt.replace(/^([\d.]+)([a-z]+)$/i, '$1 $2');
  const box = m.notStarted
    ? `<div class="log-box muted"><strong>${esc(m.status)}</strong><span class="footnote">Logging opens on the start date.</span></div>`
    : m.complete && m.done>0
    ? `<div class="log-box done"><div><strong>✓ Logged today</strong><span class="footnote">${doneTimes.length ? 'at '+esc(doneTimes.join(', ')) : esc(fmtDateShort(day))}</span></div><button type="button" class="btn btn-sm" id="doseUndo">Undo</button></div>`
    : `<div class="log-box">
        <div class="log-row"><div><span class="dc-k">Dose</span><strong class="mono">${esc(dose)}${m.u!=null?` · ${m.u} units`:''}</strong>${m.n>1?`<span class="footnote">Injection ${m.done+1} of ${m.n} today</span>`:''}</div>
          <label class="log-time"><span class="dc-k">Time</span><input type="time" id="doseTime" value="${hh}:${mm}"></label></div>
        <button type="button" class="btn btn-accent-pep log-go" id="doseGo">${SYRINGE_ICON}<span>Log dose</span></button>
      </div>`;
  openModal(p.compound || 'Dose', `
    <div class="pen-hero">${penRowHTML(p, color, day, 'm').replace('<button type="button" class="dose-pen"', '<div class="dose-pen static"').replace(/<\/button>$/, '</div>')}</div>
    ${box}
    ${doseCardHTML(p, color, day, serum, {bodyOnly:true})}
  `, body=>{
    bindDoseDetail(body, serum);
    const go = $('#doseGo',body);
    if(go) go.addEventListener('click', async ()=>{ go.disabled = true; await logInjection(p, day, 1, $('#doseTime',body).value); closeModal(); });
    const undo = $('#doseUndo',body);
    if(undo) undo.addEventListener('click', async ()=>{ undo.disabled = true; await logInjection(p, day, -1); closeModal(); });
  });
}
/* ===================== Injection pen drawing ===================== */
/* A white reusable injection pen modelled on a real insulin pen, drawn horizontally: translucent ribbed needle hub,
   clear holder with a large printed scale (cartridge inside; the rubber plunger sits further toward the needle as the
   active vial empties), a glossy white body carrying the printed label, a recessed panel with a domed dose lens showing
   the number drum, a narrow dial ring with ribs running along the pen, and a short chrome button.
   o: {color, name, dose, units, sched, status, kind (good|due|bad|muted), pct (0-1 or null)} */
function penSVG(o, id){
  const A = o.color, W = 360, H = 66, cy = 30, R = 15, r = 12.5;
  const hubX = 18, holderX = 34, bodyX = 132, dialX = 316, chromeX = 332, end = 342;
  const cartL = holderX+13, cartR = bodyX-6;
  const lvl = o.pct==null ? 1 : Math.max(.03, Math.min(1, o.pct));
  const plX = cartL + (cartR - cartL - 9) * lvl;
  const panelL = dialX-64, panelR = dialX-6, lensX = dialX-22;
  const statusCol = {good:'#17844f', due:'#c25e00', bad:'#c0392b', muted:'#5b626b'}[o.kind] || '#5b626b';
  const tx = bodyX+12, room = panelL-6-tx;
  const holder = `M${holderX} ${cy-r+3} Q${holderX} ${cy-r} ${holderX+4} ${cy-r} H${bodyX+2} V${cy+r} H${holderX+4} Q${holderX} ${cy+r} ${holderX} ${cy+r-3}Z`;
  const body = `M${bodyX+5} ${cy-R} H${dialX} V${cy+R} H${bodyX+5} Q${bodyX} ${cy+R} ${bodyX} ${cy+R-5} V${cy-R+5} Q${bodyX} ${cy-R} ${bodyX+5} ${cy-R}Z`;
  const u = o.units, isNum = typeof u==='number';
  const fmtU = v=> String(Math.round(v*10)/10);
  const prev = isNum ? fmtU(Math.max(0, u - (u>=10?1:.5))) : '', next = isNum ? fmtU(u + (u>=10?1:.5)) : '';
  const sub = `${o.dose} · ${o.sched}`;
  return `<svg class="pen-svg" viewBox="0 0 ${W} ${H}" aria-hidden="true"><defs>
    <linearGradient id="${id}b" x1="0" x2="0" y1="0" y2="1">
      <stop offset="0" stop-color="#b9bcc3"/><stop offset=".07" stop-color="#e3e5e9"/><stop offset=".2" stop-color="#ffffff"/><stop offset=".3" stop-color="#fbfbfc"/>
      <stop offset=".46" stop-color="#eceef1"/><stop offset=".72" stop-color="#dfe1e5"/><stop offset=".88" stop-color="#c3c6cc"/><stop offset=".95" stop-color="#d8dade"/><stop offset="1" stop-color="#b3b6bd"/></linearGradient>
    <linearGradient id="${id}spec" x1="0" x2="1"><stop offset="0" stop-color="#fff" stop-opacity="0"/><stop offset=".08" stop-color="#fff" stop-opacity=".95"/><stop offset=".85" stop-color="#fff" stop-opacity=".9"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient>
    <linearGradient id="${id}pan" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#b8bbc2"/><stop offset=".18" stop-color="#d4d7dc"/><stop offset=".55" stop-color="#e4e6ea"/><stop offset=".9" stop-color="#f4f5f7"/><stop offset="1" stop-color="#ffffff"/></linearGradient>
    <linearGradient id="${id}kn" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#8f939b"/><stop offset=".18" stop-color="#d9dbe0"/><stop offset=".32" stop-color="#f3f4f6"/><stop offset=".55" stop-color="#c3c6cc"/><stop offset=".85" stop-color="#9da0a8"/><stop offset="1" stop-color="#b5b8be"/></linearGradient>
    <linearGradient id="${id}knx" x1="0" x2="1"><stop offset="0" stop-color="#000" stop-opacity=".18"/><stop offset=".2" stop-color="#000" stop-opacity="0"/><stop offset=".8" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity=".22"/></linearGradient>
    <linearGradient id="${id}cr" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#6e717a"/><stop offset=".16" stop-color="#e6e8ec"/><stop offset=".28" stop-color="#ffffff"/><stop offset=".42" stop-color="#9fa3ab"/><stop offset=".62" stop-color="#d9dce1"/><stop offset=".84" stop-color="#7c8089"/><stop offset="1" stop-color="#a9adb4"/></linearGradient>
    <linearGradient id="${id}crx" x1="0" x2="1"><stop offset="0" stop-color="#000" stop-opacity=".25"/><stop offset=".25" stop-color="#000" stop-opacity="0"/><stop offset=".7" stop-color="#fff" stop-opacity=".25"/><stop offset="1" stop-color="#000" stop-opacity=".2"/></linearGradient>
    <linearGradient id="${id}gl" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#8396a5" stop-opacity=".75"/><stop offset=".1" stop-color="#ffffff" stop-opacity=".6"/><stop offset=".22" stop-color="#ffffff" stop-opacity=".95"/><stop offset=".34" stop-color="#eef5f9" stop-opacity=".2"/><stop offset=".78" stop-color="#dce8f0" stop-opacity=".2"/><stop offset=".93" stop-color="#9fb3c2" stop-opacity=".5"/><stop offset="1" stop-color="#ffffff" stop-opacity=".7"/></linearGradient>
    <linearGradient id="${id}hub" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#8ea6c9" stop-opacity=".9"/><stop offset=".3" stop-color="#eef4fb" stop-opacity=".9"/><stop offset=".6" stop-color="#c3d3ea" stop-opacity=".85"/><stop offset="1" stop-color="#7f97bd" stop-opacity=".9"/></linearGradient>
    <linearGradient id="${id}lq" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="${shade(A,-.1)}" stop-opacity=".5"/><stop offset=".35" stop-color="${shade(A,.55)}" stop-opacity=".3"/><stop offset="1" stop-color="${shade(A,-.2)}" stop-opacity=".55"/></linearGradient>
    <linearGradient id="${id}rub" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#2a2c30"/><stop offset=".3" stop-color="#6b6e75"/><stop offset=".6" stop-color="#3a3c41"/><stop offset="1" stop-color="#1c1d20"/></linearGradient>
    <linearGradient id="${id}rod" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#8d9098"/><stop offset=".4" stop-color="#f1f2f4"/><stop offset="1" stop-color="#7a7d85"/></linearGradient>
    <radialGradient id="${id}lens" cx=".38" cy=".3" r=".75"><stop offset="0" stop-color="#fff" stop-opacity=".95"/><stop offset=".25" stop-color="#fff" stop-opacity=".35"/><stop offset=".6" stop-color="#fff" stop-opacity="0"/><stop offset=".92" stop-color="#5d6470" stop-opacity=".25"/><stop offset="1" stop-color="#3b414b" stop-opacity=".55"/></radialGradient>
    <radialGradient id="${id}sh" cx=".5" cy=".5" r=".5"><stop offset="0" stop-color="#1c2a3a" stop-opacity=".3"/><stop offset="1" stop-color="#1c2a3a" stop-opacity="0"/></radialGradient>
    <clipPath id="${id}cart"><rect x="${cartL}" y="${cy-8.5}" width="${cartR-cartL}" height="17" rx="3"/></clipPath>
    <clipPath id="${id}ln"><circle cx="${lensX}" cy="${cy}" r="8.6"/></clipPath>
  </defs>
  <ellipse cx="${W/2+8}" cy="${cy+R+8}" rx="${W/2-22}" ry="4.6" fill="url(#${id}sh)"/>
  <!-- needle + translucent ribbed hub -->
  <rect x="2" y="${cy-.55}" width="${hubX}" height="1.1" fill="url(#${id}rod)"/>
  <path d="M${hubX} ${cy-8} H${holderX+1} V${cy+8} H${hubX} Q${hubX-3} ${cy+8} ${hubX-3} ${cy+5} V${cy-5} Q${hubX-3} ${cy-8} ${hubX} ${cy-8}Z" fill="url(#${id}hub)"/>
  ${Array.from({length:6},(_,i)=>`<rect x="${hubX+1+i*2.4}" y="${cy-8}" width=".7" height="16" fill="#3e5a86" fill-opacity=".28"/>`).join('')}
  <rect x="${hubX-3}" y="${cy-6}" width="${holderX-hubX+4}" height="2" fill="#fff" fill-opacity=".6"/>
  <!-- clear holder, cartridge, large printed scale -->
  <path d="${holder}" fill="#eaf1f6" fill-opacity=".3"/>
  <g clip-path="url(#${id}cart)">
    <rect x="${cartL}" y="${cy-8.5}" width="${cartR-cartL}" height="17" fill="#f6fafc" fill-opacity=".45"/>
    ${o.pct==null ? '' : `<rect x="${cartL}" y="${cy-8.5}" width="${plX-cartL}" height="17" fill="url(#${id}lq)"/>`}
    <rect x="${plX+9}" y="${cy-1.6}" width="${cartR-plX}" height="3.2" fill="url(#${id}rod)"/>
    <rect x="${plX}" y="${cy-8.5}" width="9" height="17" rx="1.5" fill="url(#${id}rub)"/>
    <rect x="${plX+2.6}" y="${cy-8.5}" width=".6" height="17" fill="#000" fill-opacity=".45"/><rect x="${plX+5.6}" y="${cy-8.5}" width=".6" height="17" fill="#000" fill-opacity=".45"/>
  </g>
  <path d="M${cartL} ${cy-5} q-6 0 -8 3 v4 q2 3 8 3" fill="#f6fafc" fill-opacity=".6" stroke="#9fb2c0" stroke-opacity=".6" stroke-width=".5"/>
  ${Array.from({length:25},(_,i)=>{ const x = cartR - 5 - i*((cartR-cartL-10)/24), big = i%4===0, lab = i%4===0;
    return `<rect x="${x-.3}" y="${cy+2.2}" width=".6" height="${big?4.6:2.6}" fill="#1b1e24" fill-opacity=".8"/>${lab?`<text x="${x}" y="${cy+11.4}" text-anchor="middle" font-size="4.6" font-weight="700" font-family="system-ui,sans-serif" fill="#1b1e24" fill-opacity=".85">${(24-i)*10+20}</text>`:''}`; }).join('')}
  <path d="${holder}" fill="url(#${id}gl)"/>
  <path d="${holder}" fill="none" stroke="#7f93a2" stroke-opacity=".55" stroke-width=".6"/>
  <!-- glossy body -->
  <path d="${body}" fill="url(#${id}b)"/>
  <rect x="${bodyX}" y="${cy-R+3}" width="3" height="${2*R-6}" rx="1.5" fill="#9ea2a9"/>
  <rect x="${bodyX+3}" y="${cy-R+3}" width="1" height="${2*R-6}" fill="#fff" fill-opacity=".7"/>
  <rect x="${bodyX+6}" y="${cy-R+4.2}" width="${dialX-bodyX-8}" height="2.4" rx="1.2" fill="url(#${id}spec)"/>
  <rect x="${bodyX+10}" y="${cy+R-3.4}" width="${dialX-bodyX-16}" height="1" rx=".5" fill="#fff" fill-opacity=".55"/>
  <!-- printed label -->
  <text x="${tx}" y="${cy-1}" font-size="10.4" font-weight="800" font-family="system-ui,-apple-system,sans-serif" fill="#15181c"${String(o.name).length>13?` textLength="${room}" lengthAdjust="spacingAndGlyphs"`:''}>${esc(o.name)}</text>
  <text x="${tx}" y="${cy+8.6}" font-size="6.6" font-weight="600" font-family="system-ui,-apple-system,sans-serif" fill="#3b4149"${(sub.length+o.status.length+3)*3.3>room?` textLength="${room}" lengthAdjust="spacingAndGlyphs"`:''}>${esc(sub)} · <tspan font-weight="800" fill="${statusCol}">${esc(o.status.toUpperCase())}</tspan></text>
  <!-- recessed panel with domed dose lens -->
  <rect x="${panelL}" y="${cy-R+4.5}" width="${panelR-panelL}" height="${2*R-9}" rx="${R-4.5}" fill="url(#${id}pan)"/>
  <rect x="${panelL}" y="${cy-R+4.5}" width="${panelR-panelL}" height="${2*R-9}" rx="${R-4.5}" fill="none" stroke="#8e929a" stroke-opacity=".55" stroke-width=".5"/>
  <path d="M${panelL+6} ${cy+R-4.6} H${panelR-6}" stroke="#fff" stroke-opacity=".9" stroke-width=".7"/>
  <path d="M${lensX-13} ${cy} l4.5 -2.8 v5.6z" fill="#3b4149"/>
  <circle cx="${lensX}" cy="${cy}" r="9.6" fill="#7b808a"/>
  <circle cx="${lensX}" cy="${cy}" r="8.6" fill="#fbfbf8"/>
  <g clip-path="url(#${id}ln)">
    ${isNum ? `<text x="${lensX+1}" y="${cy-5.6}" text-anchor="middle" font-size="4.2" font-weight="700" font-family="system-ui,sans-serif" fill="#7d828b">${prev}</text>
    <text x="${lensX+1}" y="${cy+8.4}" text-anchor="middle" font-size="4.2" font-weight="700" font-family="system-ui,sans-serif" fill="#7d828b">${next}</text>` : ''}
    <rect x="${lensX-8.6}" y="${cy-4.4}" width="17.2" height="8.8" fill="#fff"/>
    <rect x="${lensX-8.6}" y="${cy-4.6}" width="17.2" height=".5" fill="#2b2f36" fill-opacity=".5"/><rect x="${lensX-8.6}" y="${cy+4.1}" width="17.2" height=".5" fill="#2b2f36" fill-opacity=".5"/>
    <text x="${lensX+1}" y="${cy+3.1}" text-anchor="middle" font-size="${String(u).length>3?6.4:String(u).length>2?7.4:8.6}" font-weight="900" font-family="system-ui,sans-serif" fill="#101216">${esc(String(u))}</text>
    <rect x="${lensX-8.6}" y="${cy-8.6}" width="3" height="17.2" fill="#000" fill-opacity=".08"/>
  </g>
  <circle cx="${lensX}" cy="${cy}" r="8.6" fill="url(#${id}lens)"/>
  <ellipse cx="${lensX-3}" cy="${cy-4.4}" rx="3.6" ry="1.8" fill="#fff" fill-opacity=".85" transform="rotate(-25 ${lensX-3} ${cy-4.4})"/>
  <circle cx="${lensX}" cy="${cy}" r="9.6" fill="none" stroke="#fff" stroke-opacity=".6" stroke-width=".5"/>
  <!-- dial: narrow ring with ribs running along the pen (seen side-on they bunch toward the edges), then a short chrome button a little lower than the dial -->
  ${(()=>{ const dW = 15, dR = R+2.2, dx = dialX, bx = dialX+dW, bR = R-2.4, bW = 9;
    const ribs = Array.from({length:17},(_,i)=>{ const th = -Math.PI/2 + (i+.5)*Math.PI/17, y = cy + Math.sin(th)*(dR-1), w = Math.max(.35, Math.cos(th)*1.1);
      return `<rect x="${dx+1.2}" y="${y-w/2}" width="${dW-2.4}" height="${w}" rx="${w/2}" fill="#000" fill-opacity="${.16+.18*(1-Math.cos(th))}"/><rect x="${dx+1.2}" y="${y+w/2}" width="${dW-2.4}" height="${Math.max(.25,w*.45)}" fill="#fff" fill-opacity="${.32*Math.cos(th)}"/>`; }).join('');
    return `<rect x="${dx-1.4}" y="${cy-R}" width="1.6" height="${2*R}" fill="${A}"/>
    <rect x="${dx}" y="${cy-dR}" width="${dW}" height="${2*dR}" rx="2.2" fill="url(#${id}kn)"/>
    ${ribs}
    <rect x="${dx}" y="${cy-dR}" width="${dW}" height="${2*dR}" rx="2.2" fill="url(#${id}knx)"/>
    <rect x="${bx-.4}" y="${cy-bR}" width="1.2" height="${2*bR}" fill="#3f434a" fill-opacity=".55"/>
    <path d="M${bx+.8} ${cy-bR} H${bx+bW-2.6} Q${bx+bW} ${cy-bR} ${bx+bW} ${cy-bR+3} V${cy+bR-3} Q${bx+bW} ${cy+bR} ${bx+bW-2.6} ${cy+bR} H${bx+.8}Z" fill="url(#${id}cr)"/>
    <path d="M${bx+.8} ${cy-bR} H${bx+bW-2.6} Q${bx+bW} ${cy-bR} ${bx+bW} ${cy-bR+3} V${cy+bR-3} Q${bx+bW} ${cy+bR} ${bx+bW-2.6} ${cy+bR} H${bx+.8}Z" fill="url(#${id}crx)"/>
    <path d="M${bx+bW-2.4} ${cy-bR+.6} Q${bx+bW-.6} ${cy-bR+.6} ${bx+bW-.6} ${cy-bR+3} V${cy+bR-3} Q${bx+bW-.6} ${cy+bR-.6} ${bx+bW-2.4} ${cy+bR-.6}" fill="none" stroke="#fff" stroke-opacity=".7" stroke-width=".6"/>`; })()}
  </svg>`;
}
const SYRINGE_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 2l4 4"/><path d="M17 7l3-3"/><path d="M19 9L8.7 19.3a2.4 2.4 0 0 1-3.4 0l-.6-.6a2.4 2.4 0 0 1 0-3.4L15 5"/><path d="M9 11l4 4"/><path d="M5 19l-3 3"/><path d="M14 4l6 6"/></svg>';
const CHECK_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';
function fmtShortMoment(t){
  const d = new Date(t);
  const ds = d.toLocaleDateString(undefined,{weekday:'short', month:'numeric', day:'numeric'});
  return `${ds}, ${d.toLocaleTimeString(undefined, d.getMinutes() ? {hour:'numeric', minute:'2-digit'} : {hour:'numeric'})}`;
}
function scheduleTag(p){
  const w = weekdaysOf(p);
  if(w) return w.length===7 ? 'Daily' : w.slice().sort((x,y)=>x-y).map(i=>DOW[i]).join('/');
  const f = num(p.frequencyDays,null);
  if(!f) return 'As needed';
  return f===1 ? 'Daily' : f===7 ? 'Weekly' : `Every ${f} days`;
}
/* One active protocol on the Dose tab: a compact header that always shows the dose,
   and an expandable body with due info, quick actions, composition, syringe and a mini level chart. */
function doseCardHTML(p, color, day, serum, opts={}){
  const n = splitCount(p);
  const done = injectionsOn(p, day);
  const complete = done >= n;
  const notStarted = p.startDate && p.startDate > todayISO();
  const d = doseAt(p, day);
  const perInj = num(d.dose,null)!=null ? num(d.dose)/n : null;
  const amt = perInj!=null ? fmtDose(Math.round(perInj*1000)/1000, d.doseUnit).replace(' ','') : '—';
  const u = unitsPerInjection(p, day);
  const time = fmtClock(p.doseTime);
  const scheduledToday = doseDatesInRange(p, day, day).length>0;
  const nextT = nextDoseMoment(p);
  let status, stCls;
  if(notStarted){ status = `Starts ${fmtDateShort(p.startDate)}`; stCls = 'muted'; }
  else if(complete && done>0){ status = n>1 ? `Done ${done}/${n}` : 'Done'; stCls = 'good'; }
  else if(scheduledToday){ status = n>1 ? `Due ${done}/${n}` : 'Due'; stCls = 'due'; }
  else if(p.nextDose && p.nextDose < day){ status = 'Overdue'; stCls = 'bad'; }
  else if(nextT){ status = 'Next ' + new Date(nextT).toLocaleDateString(undefined,{weekday:'short'}); stCls = 'muted'; }
  else { status = 'Not scheduled'; stCls = 'muted'; }
  const lastEv = injectionEvents(p).sort((x,y)=> y.t-x.t)[0];
  const vial = p.activeVialId ? state.vials.find(v=>v.id===p.activeVialId) : null;
  const vs = vialState(p);
  if(opts.meta) return {status, stCls, amt, u, n, done, complete, notStarted, vs, d};
  const vialTag = vs.kind==='empty' ? '<span class="dc-tag bad">Vial empty</span>' : vs.kind==='low' ? '<span class="dc-tag due">Vial low</span>' : '';
  const open = opts.bodyOnly || expandedCards.has(p.id);
  const logBtn = notStarted ? '' : `<button type="button" class="dc-log ${complete&&done>0?'done':''}" data-mark-dose="${p.id}" aria-label="${complete&&done>0?'Dose logged today. Tap to undo':'Log dose now'}" title="${complete&&done>0?'Logged. Tap to undo':'Log dose'}">${complete&&done>0 ? CHECK_ICON : SYRINGE_ICON}</button>`;
  const head = `<div class="dc-head" data-card-toggle="${p.id}" role="button" tabindex="0" aria-expanded="${open}">
      ${open ? `<div class="dc-ring" style="border-color:${color}"><span class="mono">${esc(amt)}</span>${u!=null?`<span class="mono dc-u">${u}u</span>`:''}</div>`
             : `<div class="dc-amt"><span class="mono">${esc(amt)}</span>${u!=null?`<span class="mono dc-u">${u}u</span>`:''}</div>`}
      <div class="dc-main">
        <div class="dc-title"><strong class="dc-name">${esc(p.compound||'Untitled')}</strong><span class="dc-chev" aria-hidden="true">${open?'▴':'▾'}</span></div>
        <div class="dc-tags"><span class="dc-tag info">${esc(scheduleTag(p))}</span><span class="dc-tag ${stCls}">${esc(status)}</span>${vialTag}</div>
        ${open ? `<div class="dc-sub">${[time, lastEv ? `Last ${fmtShortMoment(lastEv.t)}` : 'No doses yet'].filter(Boolean).map(esc).join(' · ')}</div>` : ''}
      </div>
      ${logBtn}
    </div>`;
  if(!open) return `<div class="dc" style="--pc:${color}">${head}</div>`;
  // ---- expanded body
  const dueText = notStarted ? `Starts ${fmtDateShort(p.startDate)}`
    : (complete && done>0) ? `Done today${nextT ? ` · next ${fmtMoment(nextT, !!p.doseTime)}` : ''}`
    : nextT ? `${fmtMoment(nextT, !!p.doseTime)} · ${scheduledToday ? 'Due' : 'Upcoming'}` : 'No schedule set';
  const remaining = vial ? (vial.remainingMg!=null ? `${round2(vial.remainingMg)} mg <span class="footnote">of ${num(vial.mgPerVial,0)} mg</span>` : `Unopened ${num(vial.mgPerVial,0)} mg vial`) : '<span class="footnote">No active vial set</span>';
  const parts = blendParts(p);
  const comp = parts ? `<div class="dc-sec"><h4>Dose composition</h4>${parts.map((c,i)=>`<div class="dc-comp"><span><i style="background:${serum.find(s=>s.id===`${p.id}:${i}`)?.color || color}"></i>${esc(c.name)}</span><span class="mono">${perInj!=null ? esc(fmtDose(Math.round(perInj*c.frac*1000)/1000, d.doseUnit)) : '—'}</span></div>`).join('')}</div>` : '';
  const syr = u!=null ? `<div class="dc-sec"><div class="dc-sec-h"><h4>Syringe guide</h4><span class="mono dc-small">Draw to the ${u} unit mark</span></div>
      <div class="syringe-wrap" data-syr-units="${u}" data-syr-color="${esc(color)}" data-syr-cap="${syringeCapacityUnits(p)}"></div>
      <div class="footnote mono" style="text-align:center;margin-top:2px;">${syringeMl(p)} mL U-100 syringe</div></div>` : '';
  // mini level chart for just this protocol
  const mine = serum.filter(s=>s.p.id===p.id);
  let snap = '';
  if(mine.length){
    const now = Date.now();
    const ctx = serumCtx(mine, now, false);
    snap = `<div class="dc-sec"><div class="dc-sec-h"><h4>Estimated level</h4><button type="button" class="link-btn" data-full-chart="${p.id}">Full chart ↗</button></div>
      <div class="serum-pan dc-mini-wrap" data-mini="${p.id}"><svg viewBox="0 0 ${SV.W} ${SV.H}" class="chart dc-mini" role="img" aria-label="Estimated level of ${esc(p.compound||'')} over the last week">${serumSvgInner(ctx, now + 2*24*HOUR, 7*24*HOUR)}</svg></div>
      <div class="dc-legend">${mine.map(s=>`<span><i style="background:${s.color}"></i><strong>${esc(s.label)}</strong> ${esc(fmtAmount(levelAt(s.evs, s.hl, now)))} · t½ ${esc(fmtHours(s.hl))}</span>`).join('')}</div>
      <p class="footnote" style="margin-top:4px;">Estimated from logged doses, not a measured level.</p></div>`;
  } else if(!halfLifeOf(p) && !parts){
    snap = `<div class="dc-sec"><p class="footnote">Add a half-life to this protocol to see its estimated level.</p></div>`;
  }
  const body = `<div class="dc-body">
      <div class="dc-grid">
        <div class="dc-cell"><span class="dc-k">Due</span><span class="dc-v">${dueText}</span></div>
        <div class="dc-cell"><span class="dc-k">Protocol</span><span class="dc-v">${esc(scheduleTag(p))}${n>1?` · ${n} injections`:''}</span></div>
        <div class="dc-cell"><span class="dc-k">Last dose</span><span class="dc-v">${lastEv ? `${esc(fmtMoment(lastEv.t))} · ${esc(fmtAmount(lastEv.mg))}` : 'None logged'}</span></div>
        <div class="dc-cell"><span class="dc-k">Remaining</span><span class="dc-v">${remaining}</span></div>
      </div>
      ${vialAlertHTML(p, vs)}
      <div class="dc-sec"><h4>Quick actions</h4>
        <div class="qa-grid">
          ${notStarted || opts.bodyOnly ? '' : `<button type="button" class="qa-btn primary" data-mark-dose="${p.id}">${complete&&done>0 ? CHECK_ICON+'<span>Undo dose</span>' : SYRINGE_ICON+'<span>Log dose</span>'}</button>`}
          <button type="button" class="qa-btn" data-dose-history="${p.id}"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="5" width="16" height="15" rx="2"/><path d="M8 3v4M16 3v4M4 10h16"/></svg><span>History &amp; backfill</span></button>
          <button type="button" class="qa-btn" data-goto-checkin><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 12h4l3-7 4 14 3-7h4"/></svg><span>Add check-in</span></button>
          ${vs.vial || nextVialCandidates(p.compound, null).length ? `<button type="button" class="qa-btn" data-vial-swap="${p.id}"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="2.5" width="8" height="3" rx="1"/><path d="M9 5.5v2.5M15 5.5v2.5"/><rect x="6.5" y="8" width="11" height="13.5" rx="2.5"/><path d="M6.5 15h11"/></svg><span>${vs.kind==='ok'||vs.kind==='low'||vs.kind==='empty' ? 'Finish vial' : 'Open vial'}</span></button>` : ''}
          <button type="button" class="qa-btn" data-edit-protocol="${p.id}"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="4" width="14" height="17" rx="2"/><path d="M9 4.5V3h6v1.5"/><path d="M8.5 10h7M8.5 14h7"/></svg><span>Protocol</span></button>
        </div>
      </div>
      ${comp}
      ${syr}
      <div class="dc-sec">${siteRowHTML(p).replace('class="site-row"','class="site-row" style="margin-top:0"')}</div>
      ${snap}
    </div>`;
  if(opts.bodyOnly) return body;
  return `<div class="dc open" style="--pc:${color}">${head}${body}</div>`;
}
/* Note on an expanded dose card when its vial needs attention. */
function vialAlertHTML(p, vs){
  const per = mgPerInjection(p);
  let msg = '', btn = '';
  if(vs.kind==='empty'){ msg = 'Your active vial is empty.'; btn = 'Finish & open next'; }
  else if(vs.kind==='low'){ msg = `Vial almost empty: ${round2(vs.left)} mg left, less than one ${fmtAmount(per)} dose.`; btn = 'Finish & open next'; }
  else if(vs.kind==='unopened'){ msg = 'Your active vial hasn\'t been opened yet.'; btn = 'Open vial'; }
  else if(vs.kind==='none' && nextVialCandidates(p.compound, null).length){ msg = 'No active vial. Open one from your stash to track what\'s left.'; btn = 'Open a vial'; }
  if(!msg) return '';
  return `<div class="dc-sec vial-alert ${vs.kind}"><span>${esc(msg)}</span><button type="button" class="btn btn-sm btn-accent-pep" data-vial-swap="${p.id}">${esc(btn)}</button></div>`;
}
const round2 = n => Math.round(n*100)/100;
/* The card button logs the next injection for today; once the day is complete it undoes the last one. */
function markDoseTaken(p){
  if(!p) return;
  const day = doseDayISO();
  return logInjection(p, day, injectionsOn(p, day) >= splitCount(p) ? -1 : 1);
}
/* Add (+1) or remove (-1) one injection on a given dose day. Keeps the dose counter, next-dose date,
   active vial and linked supplies in step. Works for today and for backfilled days. */
function momentOn(day, hhmm){
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm||''); if(!m) return null;
  const d = new Date(day+'T00:00:00'); d.setHours(+m[1], +m[2], 0, 0);
  if(+m[1] < 2) d.setDate(d.getDate()+1);   // 12–2am still belongs to the previous dose day
  return d.getTime();
}
async function logInjection(p, day, delta, hhmm){
  if(!p) return;
  const n = splitCount(p);
  const log = Array.isArray(p.doseLog) ? p.doseLog.slice() : [];
  let times = Array.isArray(p.doseTimes) ? p.doseTimes.slice() : [];   // exact injection moments, for the serum chart
  const before = log.filter(x=>x===day).length;
  if(delta>0){ if(before>=n) return; log.push(day); times.push({day, t: momentOn(day, hhmm) || (day===doseDayISO() ? Date.now() : new Date(day+'T12:00:00').getTime())}); }
  else {
    const i = log.lastIndexOf(day); if(i<0) return; log.splice(i,1);
    for(let k=times.length-1;k>=0;k--) if(times[k].day===day){ times.splice(k,1); break; }
  }
  log.sort();
  times = times.slice(-400);
  const after = before + (delta>0 ? 1 : -1);
  const freq = num(p.frequencyDays,0);
  let doseNumber = p.doseNumber, nextDose = p.nextDose;
  const hasCounter = doseNumber!=null && doseNumber!=='';
  if(delta>0 && after===n){
    if(hasCounter) doseNumber = num(doseNumber,0)+1;
    const cand = weekdaysOf(p) ? nextScheduledDate(p, addDays(day,1)) : (freq>0 ? addDays(day, freq) : null);
    if(cand && (!nextDose || cand>nextDose)) nextDose = cand;
  } else if(delta<0 && before===n){
    if(hasCounter) doseNumber = Math.max(0, num(doseNumber,0)-1);
    if(day===doseDayISO() && (!weekdaysOf(p) || weekdaysOf(p).includes(new Date(day+'T00:00:00').getDay()))) nextDose = day;   // today's dose is due again
  }
  await dbSet('protocols', p.id, {...stripId(p), doseLog:log, doseTimes:times, doseNumber, nextDose});
  // Linked supplies are consumed per injection: consume on log, restock on removal.
  const rules = Array.isArray(p.supplyUsage) ? p.supplyUsage : [];
  for(const r of rules){
    if(!r.supplyId) continue;
    const supply = state.supplies.find(s=>s.id===r.supplyId);
    if(!supply) continue;
    const perDoses = num(r.perDoses,1) || 1;
    const qty = num(r.qty,1) || 1;
    const change = -(qty/perDoses) * (delta>0 ? 1 : -1);
    const newCount = Math.max(0, round2(num(supply.count,0) + change));
    await dbSet('supplies', supply.id, {...stripId(supply), count:newCount});
  }
  // Active vial: each injection draws its share of that day's dose.
  if(p.activeVialId){
    const vial = state.vials.find(v=>v.id===p.activeVialId);
    const d = doseAt(p, day);
    const mg = doseToMg(d.dose, d.doseUnit);
    if(vial && vial.remainingMg!=null && mg){
      const change = -(mg/n) * (delta>0 ? 1 : -1);
      const cap = num(vial.mgPerVial, Infinity);
      const newRemaining = Math.max(0, Math.min(cap, round2(num(vial.remainingMg,0) + change)));
      await dbSet('vials', vial.id, {...stripId(vial), remainingMg:newRemaining});
    }
  }
}
function openDoseHistoryModal(p){
  if(!p) return;
  const rowsHTML = ()=>{
    const cur = state.protocols.find(x=>x.id===p.id) || p;
    const n = splitCount(cur);
    const day = doseDayISO();
    const sched = new Set(doseDatesInRange({...cur, nextDose:null}, addDays(day,-14), day));
    const log = Array.isArray(cur.doseLog) ? cur.doseLog : [];
    const older = log.filter(x=> x < addDays(day,-14)).length;
    let out = '';
    const tOf = iso=>{ const e = injectionEvents(cur).filter(x=>x.day===iso).map(x=>new Date(x.t).toLocaleTimeString(undefined,{hour:'numeric',minute:'2-digit'})); return e.length ? ` <span class="footnote">${e.join(', ')}</span>` : ''; };
    for(let i=0;i<=14;i++){
      const iso = addDays(day,-i);
      const cnt = injectionsOn(cur, iso);
      const wd = new Date(iso+'T00:00:00').toLocaleDateString(undefined,{weekday:'short'});
      out += `<div class="hist-row ${cnt>=n?'done':''}">
        <span class="hist-date"><strong>${i===0?'Today':fmtDateShort(iso)}</strong> <span class="footnote">${wd}</span>${tOf(iso)}${sched.has(iso)?' <span class="pill pill-info">scheduled</span>':''}</span>
        <span class="hist-ctrl">
          <button class="btn btn-sm" data-h="-1" data-d="${iso}" ${cnt?'':'disabled'} aria-label="Remove an injection on ${fmtDateShort(iso)}">−</button>
          <span class="mono hist-count">${cnt}/${n}</span>
          <button class="btn btn-sm" data-h="1" data-d="${iso}" ${cnt>=n?'disabled':''} aria-label="Log an injection on ${fmtDateShort(iso)}">+</button>
        </span>
      </div>`;
    }
    const oldDays = [...new Set(log.filter(x=> x < addDays(day,-14)))].sort().reverse();
    if(oldDays.length){
      out += `<div class="supply-group-h" style="margin-top:12px;">Older doses</div>` + oldDays.map(iso=>`<div class="hist-row done">
        <span class="hist-date"><strong>${fmtDateShort(iso)}</strong> <span class="footnote">${new Date(iso+'T00:00:00').toLocaleDateString(undefined,{weekday:'short'})}</span>${tOf(iso)}</span>
        <span class="hist-ctrl"><button class="btn btn-sm" data-h="-1" data-d="${iso}" aria-label="Remove an injection on ${fmtDateShort(iso)}">−</button><span class="mono hist-count">${injectionsOn(cur, iso)}/${n}</span></span></div>`).join('');
    }
    out += `<p class="footnote" style="margin-top:10px;">${log.length} injection${log.length===1?'':'s'} logged in total${older?`, ${older} of them more than 14 days ago`:''}.</p>`;
    return out;
  };
  openModal(`Dose history: ${p.compound||'protocol'}`, `
    <p class="footnote" style="margin-bottom:10px;">Log a missed injection, or remove one logged by mistake. Each change also adjusts the active vial and linked supplies. The time below is used for doses you add here, so the serum chart is accurate.</p>
    <div class="module-box" style="margin-bottom:12px;">
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
        <div><label for="hTime" class="footnote" style="display:block;margin-bottom:3px;">Time for added doses</label><input id="hTime" type="time" value="${esc(p.doseTime||'22:00')}"></div>
        <div><label for="hDate" class="footnote" style="display:block;margin-bottom:3px;">Add a dose on any date</label><input id="hDate" type="date" max="${esc(doseDayISO())}"></div>
      </div>
      <button type="button" class="btn btn-sm" id="hAddDate" style="margin-top:8px;">+ Add dose on that date</button>
      <div class="footnote" id="hMsg" style="margin-top:6px;"></div>
    </div>
    <div id="histRows"></div>
    <div class="form-actions"><button class="btn btn-accent-pep" id="hClose">Done</button></div>
  `, body=>{
    const draw = ()=>{ $('#histRows',body).innerHTML = rowsHTML(); };
    draw();
    $('#histRows',body).addEventListener('click', async e=>{
      const b = e.target.closest('[data-h]');
      if(!b || b.disabled) return;
      const cur = state.protocols.find(x=>x.id===p.id);
      await logInjection(cur, b.dataset.d, +b.dataset.h, $('#hTime',body).value);
      draw();
    });
    $('#hAddDate',body).addEventListener('click', async ()=>{
      const iso = $('#hDate',body).value, msg = $('#hMsg',body);
      if(!iso){ msg.textContent = 'Pick a date first.'; return; }
      const cur = state.protocols.find(x=>x.id===p.id);
      if(injectionsOn(cur, iso) >= splitCount(cur)){ msg.textContent = `${fmtDateShort(iso)} already has all its injections logged.`; return; }
      await logInjection(cur, iso, 1, $('#hTime',body).value);
      msg.textContent = `Added ${fmtDateShort(iso)}.`; draw();
    });
    $('#hClose',body).addEventListener('click', closeModal);
  });
}
async function pauseProtocol(p){
  if(!p) return;
  const log = Array.isArray(p.pauseLog) ? p.pauseLog.slice() : [];
  log.push({from: todayISO(), to: null});
  await dbSet('protocols', p.id, {...stripId(p), status:'paused', pausedDate: todayISO(), pauseLog: log});
}
async function resumeProtocol(p){
  if(!p) return;
  const log = Array.isArray(p.pauseLog) ? p.pauseLog.slice() : [];
  if(log.length && !log[log.length-1].to) log[log.length-1] = {...log[log.length-1], to: todayISO()};
  const day = doseDayISO();
  const nextDose = (!p.nextDose || p.nextDose < day) ? day : p.nextDose;
  await dbSet('protocols', p.id, {...stripId(p), status:'active', pausedDate:null, pauseLog: log, nextDose});
}
function stripId(obj){ const {id, ...rest} = obj; return rest; }
/* Dose tab: the next scheduled doses across active protocols, in time order. */
function renderUpcoming(){
  const el = $('#upcomingList');
  if(!el) return;
  const now = Date.now(), until = now + 21*24*HOUR;
  const colorMap = protocolColorMap();
  const evs = [];
  state.protocols.filter(isActiveP).forEach(p=>{
    const d = doseAt(p, doseDayISO());
    scheduledEvents(p, now - 20*HOUR, until).forEach(e=>{
      const iso = isoFromDate(new Date(e.t - 2*HOUR));
      if(injectionsOn(p, iso) >= splitCount(p)) return;        // already logged for that dose day
      const dd = doseAt(p, iso);
      evs.push({p, t:e.t, iso, dose: fmtDose(num(dd.dose)/splitCount(p), dd.doseUnit), units: unitsPerInjection(p, iso), color: colorMap.get(p.id)});
    });
  });
  evs.sort((x,y)=> x.t-y.t);
  if(!evs.length){ el.innerHTML = `<p class="footnote">No scheduled doses in the next 3 weeks. Set a schedule on the Protocols tab.</p>`; return; }
  const today = doseDayISO();
  el.innerHTML = evs.slice(0,8).map(e=>{
    const day = daysBetween(today, e.iso);
    const when = day<0 ? 'Overdue' : day===0 ? 'Today' : day===1 ? 'Tomorrow' : new Date(e.iso+'T00:00:00').toLocaleDateString(undefined,{weekday:'short', month:'short', day:'numeric'});
    const time = e.p.doseTime ? fmtClock(e.p.doseTime) : '';
    return `<button type="button" class="dose-row" data-hist-pid="${e.p.id}">
      <span class="when" style="${day<=0?'color:var(--accent-pep-strong)':''}">${esc(when)}</span>
      <span class="what"><span class="serum-dot" style="display:inline-block;background:${e.color};margin-right:6px;"></span>${esc(e.p.compound||'Untitled')}${time?` <span class="footnote">${esc(time)}</span>`:''}</span>
      <span class="amt mono">${esc(e.dose)}${e.units!=null?` <span class="footnote">${e.units}u</span>`:''}</span>
    </button>`;
  }).join('');
  $$('[data-hist-pid]',el).forEach(b=> b.addEventListener('click', ()=> openDoseHistoryModal(state.protocols.find(p=>p.id===b.dataset.histPid))));
}
/* Dose tab: every logged injection across protocols, newest first. */
function renderRecentDoses(){
  const el = $('#recentDoseList');
  if(!el) return;
  const colorMap = protocolColorMap();
  const all = [];
  state.protocols.filter(p=>p.status!=='archived').forEach(p=>{
    injectionEvents(p).forEach(e=> all.push({p, ...e}));
  });
  all.sort((x,y)=> y.t-x.t);
  if(!all.length){ el.innerHTML = `<p class="footnote">No doses logged yet. Tap Mark taken above when you inject.</p>`; return; }
  const show = all.slice(0, lsGet('ledger.histAll','')==='1' ? 200 : 10);
  el.innerHTML = show.map(e=>{
    const d = new Date(e.t);
    return `<button type="button" class="dose-row" data-hist-pid="${e.p.id}">
      <span class="when">${esc(d.toLocaleDateString(undefined,{weekday:'short', month:'short', day:'numeric'}))}</span>
      <span class="what"><span class="serum-dot" style="display:inline-block;background:${colorMap.get(e.p.id)||'var(--muted)'};margin-right:6px;"></span>${esc(e.p.compound||'Untitled')} <span class="footnote">${esc(d.toLocaleTimeString(undefined,{hour:'numeric', minute:'2-digit'}))}</span></span>
      <span class="amt mono">${esc(fmtAmount(e.mg))}</span>
    </button>`;
  }).join('') + (all.length>10 ? `<button type="button" class="btn btn-sm" id="histMore" style="margin-top:8px;">${lsGet('ledger.histAll','')==='1' ? 'Show fewer' : `Show all ${all.length}`}</button>` : '');
  $$('[data-hist-pid]',el).forEach(b=> b.addEventListener('click', ()=> openDoseHistoryModal(state.protocols.find(p=>p.id===b.dataset.histPid))));
  const more = $('#histMore',el);
  if(more) more.addEventListener('click', ()=>{ lsSet('ledger.histAll', lsGet('ledger.histAll','')==='1' ? '' : '1'); renderRecentDoses(); });
}
/* Protocols tab: every non-archived protocol, tap to edit. */
function renderProtocolManager(){
  const el = $('#protocolManager');
  if(!el) return;
  const list = state.protocols.filter(p=>p.status!=='archived')
    .sort((a,b)=> (a.status==='paused') - (b.status==='paused') || (a.compound||'').localeCompare(b.compound||'', undefined, {sensitivity:'base'}));
  if(!list.length){ el.innerHTML = `<div class="empty"><div class="glyph">📋</div><p>No protocols yet. Add one to set its dose, schedule and vial.</p></div>`; return; }
  const colorMap = protocolColorMap();
  el.innerHTML = list.map(p=>{
    const d = doseAt(p, doseDayISO());
    const u = unitsPerInjection(p, doseDayISO());
    const paused = p.status==='paused';
    const notStarted = p.startDate && p.startDate > todayISO();
    const freq = num(p.frequencyDays,null);
    const sched = scheduleLabel(p) || (freq ? (freq===1 ? 'Daily' : `Every ${freq} days`) : 'No schedule set');
    const hl = halfLifeOf(p);
    const parts = blendParts(p);
    return `<div class="card-flat pm-row ${paused?'paused-row':''}" data-open-protocol="${p.id}">
      <div style="min-width:0;">
        <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;">
          <span class="serum-dot" style="background:${colorMap.get(p.id)||'var(--muted)'}"></span>
          <strong>${esc(p.compound||'Untitled compound')}</strong>
          <span class="pill pill-pep">${esc(fmtDose(d.dose, d.doseUnit))}</span>
          ${u!=null?`<span class="pill pill-info">${u} units</span>`:''}
          ${paused?'<span class="pill pill-muted">Paused</span>':notStarted?'<span class="pill pill-muted">Not started</span>':''}
        </div>
        <div class="footnote" style="margin-top:4px;">${esc(sched)}${splitCount(p)>1?` · split ×${splitCount(p)}`:''}${parts ? ` · blend: ${esc(parts.map(c=>c.name).join(', '))}` : hl?` · t½ ${esc(fmtHours(hl))}`:''}${titrationSteps(p).length?` · ${titrationSteps(p).length} titration step${titrationSteps(p).length===1?'':'s'}`:''}</div>
      </div>
      ${paused ? `<button class="btn btn-sm" data-resume-protocol="${p.id}">▶ Resume</button>` : `<span class="footnote" aria-hidden="true">Edit ›</span>`}
    </div>`;
  }).join('');
  $$('[data-open-protocol]',el).forEach(c=> c.addEventListener('click', ()=> openProtocolModal(state.protocols.find(p=>p.id===c.dataset.openProtocol))));
  $$('[data-resume-protocol]',el).forEach(b=> b.addEventListener('click', e=>{ e.stopPropagation(); resumeProtocol(state.protocols.find(p=>p.id===b.dataset.resumeProtocol)); }));
}
function renderArchivedProtocols(){
  const el = $('#archivedProtocolList');
  if(!el) return;
  const archived = state.protocols.filter(p=>p.status==='archived').sort((a,b)=> (b.endedDate||'').localeCompare(a.endedDate||''));
  if(!archived.length){
    el.innerHTML = `<div class="empty" style="padding:14px 8px;"><p>Nothing archived yet. Archiving a protocol instead of deleting it keeps it here.</p></div>`;
    return;
  }
  el.innerHTML = archived.map(p=>`
    <div class="card-flat" style="margin-bottom:8px;">
      <div style="display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap;">
        <div>
          <strong>${esc(p.compound||'Untitled compound')}</strong>
          <span class="pill pill-muted" style="margin-left:6px;">${esc(p.dose||'')} ${esc(p.doseUnit||'')}</span>
          <div class="footnote" style="margin-top:3px;">${fmtDateShort(p.startDate)} → ${fmtDateShort(p.endedDate)}${p.history&&p.history.length? ` · ${p.history.length} log ${p.history.length===1?'entry':'entries'}`:''}${Array.isArray(p.doseLog)&&p.doseLog.length? ` · ${p.doseLog.length} injections`:''}</div>
        </div>
        <div class="card-actions">
          <button class="icon-btn" data-reactivate-protocol="${p.id}">Reactivate</button>
          <button class="icon-btn" data-del-archived="${p.id}" aria-label="Delete">✕</button>
        </div>
      </div>
    </div>`).join('');
  $$('[data-reactivate-protocol]',el).forEach(b=> b.addEventListener('click', async ()=>{
    const p = state.protocols.find(x=>x.id===b.dataset.reactivateProtocol);
    if(p) await dbSet('protocols', p.id, {...stripId(p), status:'active', endedDate:null});
  }));
  $$('[data-del-archived]',el).forEach(b=> b.addEventListener('click', ()=> confirmAction('Permanently delete this archived protocol?', ()=> dbDelete('protocols', b.dataset.delArchived))));
}

function activeVialOptions(compound, selectedId){
  const c = (compound||'').trim().toLowerCase();
  const list = c ? state.vials.filter(v=> !isDepleted(v) && (v.compound||'').trim().toLowerCase()===c) : [];
  return `<option value="">${c && !list.length ? 'No vials of this compound in your stash' : 'None'}</option>` +
    list.map(v=>`<option value="${v.id}" ${selectedId===v.id?'selected':''}>${esc(vialLabel(v))}</option>`).join('');
}
function openProtocolModal(existing){
  const p = existing || {};
  const notStarted = p.startDate && p.startDate > todayISO();
  const curSyr = (p.syringeMl!=null && p.syringeMl!=='') ? parseFloat(p.syringeMl) : 1;
  const syrIsCustom = !SYRINGE_SIZES.some(s=> parseFloat(s.ml)===curSyr);
  const split = splitCount(p);
  openModal(existing? 'Edit protocol' : 'Add protocol', `
    <div class="form-grid">
      <div class="field span2"><label for="pCompound">Compound</label><input id="pCompound" type="text" value="${esc(p.compound||'')}" placeholder="e.g. BPC-157"></div>
      <div class="field"><label for="pDose">Dose (whole dose day)</label><input id="pDose" type="number" inputmode="decimal" step="any" value="${esc(p.dose||'')}"></div>
      <div class="field"><label for="pDoseUnit">Unit</label><select id="pDoseUnit">${(()=>{ const u = p.doseUnit || (existing ? 'mcg' : 'mg'); return `<option value="mg" ${u==='mg'?'selected':''}>mg</option><option value="mcg" ${u==='mcg'?'selected':''}>mcg</option>`; })()}</select></div>
      <div class="field span2"><label for="pSplit">Split each dose day into</label>
        <select id="pSplit">${[1,2,3,4].map(k=>`<option value="${k}" ${split===k?'selected':''}>${k===1?'1 injection (no split)':k+' injections'}</option>`).join('')}</select>
        <div class="footnote" id="pSplitOut" style="margin-top:4px;"></div>
      </div>
      <div class="field span2"><label for="pHalfLife">Half-life (hours) <span style="font-weight:400;color:var(--muted);">: drives the serum level chart</span></label>
        <input id="pHalfLife" type="number" inputmode="decimal" step="any" min="0" value="${esc(p.halfLifeHours||'')}" placeholder="">
        <div class="footnote" id="pHalfLifeHint" style="margin-top:4px;"></div>
      </div>
      <div class="field span2 module-box">
        <label class="endo-check" style="margin:0;color:var(--ink);"><input type="checkbox" id="pIsBlend" ${blendOf(p)?'checked':''}> 🧬 This is a blend of several peptides</label>
        <div id="pBlendBox" ${blendOf(p)?'':'hidden'} style="margin-top:10px;">
          <div class="footnote" style="margin-bottom:8px;">Enter each peptide's amount per vial (from the label) and its half-life. Each dose is split by those amounts, and every peptide gets its own line on the serum chart. The dose above is the whole blend.</div>
          <div class="chip-row" style="margin-bottom:8px;">${Object.keys(BLEND_PRESETS).map(k=>`<button type="button" class="chip-btn" data-blend-preset="${esc(k)}">Fill ${esc(k)}</button>`).join('')}</div>
          <div class="blend-head"><span>Peptide</span><span>mg/vial</span><span>t½ (h)</span><span></span></div>
          <div id="pBlendRows"></div>
          <button type="button" class="btn btn-sm" id="pAddBlend" style="margin-top:6px;">+ Add peptide</button>
          <div class="footnote" id="pBlendOut" style="margin-top:8px;"></div>
        </div>
      </div>
      <div class="field span2"><label for="pActiveVial">Active vial <span style="font-weight:400;color:var(--muted);">: the one you're drawing from. Picking an unopened vial opens it and starts tracking what's left.</span></label>
        <select id="pActiveVial">
          ${activeVialOptions(p.compound, p.activeVialId)}
        </select>
      </div>
      <div class="field span2 module-box">
        <label style="margin-bottom:6px;display:block;">Reconstitution <span style="font-weight:400;color:var(--muted);">: fills in units below. Leave blank to enter units by hand.</span></label>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
          <div><label for="pVialMg" class="footnote" style="display:block;margin-bottom:3px;">Vial size (mg)</label><input id="pVialMg" type="number" inputmode="decimal" step="any" min="0" value="${esc(p.vialMg||'')}" placeholder="e.g. 10"></div>
          <div><label for="pBacMl" class="footnote" style="display:block;margin-bottom:3px;">BAC water added (mL)</label><input id="pBacMl" type="number" inputmode="decimal" step="any" min="0" value="${esc(p.bacMl||'')}" placeholder="e.g. 2"></div>
        </div>
        <div class="footnote" id="pConcOut" style="margin-top:6px;min-height:14px;"></div>
      </div>
      <div class="field"><label for="pUnits">Syringe units, whole dose</label><input id="pUnits" type="number" inputmode="decimal" step="any" value="${esc(p.units||'')}" placeholder="e.g. 20"></div>
      <div class="field"><label for="pSyringeMl">Syringe size</label>
        <select id="pSyringeMl">
          ${SYRINGE_SIZES.map(s=>`<option value="${s.ml}" ${parseFloat(s.ml)===curSyr?'selected':''}>${s.ml} mL (${s.cap} units): ${s.tag}</option>`).join('')}
          ${syrIsCustom? `<option value="${esc(p.syringeMl)}" selected>${esc(p.syringeMl)} mL (custom)</option>` : ''}
        </select>
      </div>
      <div class="field span2 module-box">
        <label style="margin-bottom:6px;display:block;">📈 Titration or taper steps <span style="font-weight:400;color:var(--muted);">: the dose above applies until the first step's date</span></label>
        <div id="pSteps"></div>
        <button type="button" class="btn btn-sm" id="pAddStep" style="margin-top:8px;">+ Add step</button>
      </div>
      <div class="field"><label for="pDoseNumber">Current dose #</label><input id="pDoseNumber" type="number" inputmode="numeric" step="1" value="${esc(p.doseNumber||'')}" placeholder="e.g. 11"></div>
      <div class="field span2 module-box">
        <label style="margin-bottom:6px;display:block;">📅 Dose days <span style="font-weight:400;color:var(--muted);">: pick fixed weekdays (e.g. Sun &amp; Wed), or leave empty and use days between doses</span></label>
        <div class="chip-row" id="pWeekdays">${DOW.map((n,i)=>`<button type="button" class="chip-btn ${(weekdaysOf(p)||[]).includes(i)?'on':''}" data-dow="${i}" aria-pressed="${(weekdaysOf(p)||[]).includes(i)}">${n}</button>`).join('')}</div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:10px;">
          <div><label for="pFreq" class="footnote" style="display:block;margin-bottom:3px;">Days between doses</label><input id="pFreq" type="number" inputmode="numeric" step="1" value="${esc(p.frequencyDays||'')}" placeholder="1 = daily"></div>
          <div><label for="pDoseTime" class="footnote" style="display:block;margin-bottom:3px;">Usual dose time</label><input id="pDoseTime" type="time" value="${esc(p.doseTime||'')}"></div>
        </div>
        <div class="footnote" id="pDowHint" style="margin-top:6px;"></div>
      </div>
      <div class="field"><label for="pSortOrder">Display order</label><input id="pSortOrder" type="number" inputmode="numeric" step="1" value="${esc(p.sortOrder||'')}" placeholder="Lower shows first"></div>
      <div class="field"><label for="pStart">First started</label><input id="pStart" type="date" value="${esc(p.startDate||'')}"></div>
      <div class="field"><label for="pNext">Next dose date</label><input id="pNext" type="date" value="${esc(p.nextDose||'')}"></div>
      <div class="field"><label for="pCycleStart">Cycle start date</label><input id="pCycleStart" type="date" value="${esc(p.cycleStart||'')}"></div>
      <div class="field"><label for="pOn">Weeks on</label><input id="pOn" type="number" inputmode="numeric" step="1" value="${esc(p.cycleOnWeeks||'')}"></div>
      <div class="field"><label for="pOff">Weeks off</label><input id="pOff" type="number" inputmode="numeric" step="1" value="${esc(p.cycleOffWeeks||'')}"></div>
      <div class="field span2 module-box">
        <label style="margin-bottom:6px;display:block;">📍 Injection site <span style="font-weight:400;color:var(--muted);">: tap the map to log where you injected</span></label>
        <div id="pSiteMap" class="body-map"></div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:8px;">
          <div><label for="pSiteDate" class="footnote" style="display:block;margin-bottom:3px;">Date</label><input id="pSiteDate" type="date" value="${esc(todayISO())}"></div>
          <div><label for="pSite" class="footnote" style="display:block;margin-bottom:3px;">Site used</label>
            <select id="pSite">
              <option value="">No change</option>
              ${INJECTION_SITES.map(s=>`<option value="${esc(s.name)}">${esc(s.name)}</option>`).join('')}
              ${lastSiteOf(p)? '<option value="__undo">↩ Remove latest entry</option>' : ''}
            </select>
          </div>
        </div>
        <div class="footnote" id="pSiteHint" style="margin-top:6px;"></div>
      </div>
      <div class="field span2"><label for="pNote">Log note (optional, adds to history)</label><input id="pNote" type="text" placeholder="e.g. increased dose, felt X"></div>
    </div>
    <div class="form-actions wrap">
      ${existing? `<button class="btn btn-danger" id="pDelete" style="margin-right:auto;">Delete</button>` : ''}
      ${existing && p.status==='paused'? `<button class="btn" id="pResume">▶ Resume</button>` : ''}
      ${existing && isActiveP(p) && !notStarted? `<button class="btn" id="pPause" title="Pause: stops scheduling but keeps vial and supply links">⏸ Pause</button>` : ''}
      ${existing && p.status!=='archived' && !notStarted? `<button class="btn" id="pArchive" title="Archive: ends it but keeps the record">Archive</button>` : ''}
      <button class="btn" id="pCancel">Cancel</button>
      <button class="btn btn-accent-pep" id="pSave">Save</button>
    </div>
  `, body=>{
    function recalc(){
      const vialMg = parseFloat($('#pVialMg',body).value);
      const bacMl = parseFloat($('#pBacMl',body).value);
      const dose = parseFloat($('#pDose',body).value);
      const doseUnit = $('#pDoseUnit',body).value;
      const n = parseInt($('#pSplit',body).value,10) || 1;
      const concOut = $('#pConcOut',body);
      const splitOut = $('#pSplitOut',body);
      splitOut.textContent = (n>1 && isFinite(dose) && dose>0) ? `${n} injections of ${fmtDose(dose/n, doseUnit)} each.` : '';
      const haveRecipe = isFinite(vialMg) && vialMg>0 && isFinite(bacMl) && bacMl>0;
      if(!haveRecipe){ concOut.textContent = ''; return; }
      const conc = vialMg/bacMl;
      if(isFinite(dose) && dose>0){
        const doseMg = doseUnit==='mcg' ? dose/1000 : dose;
        const units = (doseMg/conc)*100;
        $('#pUnits',body).value = Math.round(units*10)/10;
        concOut.textContent = `${conc.toFixed(2)} mg/mL → ${Math.round(units*10)/10} units for this dose${n>1?` (${Math.round(units/n*10)/10} per injection)`:''}`;
      } else {
        concOut.textContent = `${conc.toFixed(2)} mg/mL`;
      }
    }
    // Active-vial choices follow the compound name as you type it.
    $('#pCompound',body).addEventListener('input', ()=>{
      const sel = $('#pActiveVial',body), keep = sel.value;
      sel.innerHTML = activeVialOptions($('#pCompound',body).value, keep);
    });
    const dowSel = new Set(weekdaysOf(p)||[]);
    function dowHint(){
      $('#pFreq',body).disabled = dowSel.size>0;
      $('#pDowHint',body).textContent = dowSel.size ? `Doses on ${[...dowSel].sort((x,y)=>x-y).map(i=>DOW[i]).join(' and ')} each week. Days between doses is ignored.` : '';
    }
    $('#pWeekdays',body).addEventListener('click', e=>{
      const b = e.target.closest('[data-dow]'); if(!b) return;
      const i = +b.dataset.dow;
      if(dowSel.has(i)) dowSel.delete(i); else dowSel.add(i);
      b.classList.toggle('on', dowSel.has(i)); b.setAttribute('aria-pressed', dowSel.has(i));
      dowHint();
    });
    dowHint();
    let blendRows = (Array.isArray(p.blend) ? p.blend : []).map(c=>({...c}));
    function drawBlend(){
      $('#pBlendRows',body).innerHTML = blendRows.length ? blendRows.map((c,i)=>{
        const d = defaultHalfLife(c.name);
        return `<div class="blend-row" data-i="${i}">
          <input type="text" data-f="name" value="${esc(c.name||'')}" placeholder="e.g. BPC-157" aria-label="Peptide ${i+1} name">
          <input type="number" inputmode="decimal" step="any" min="0" data-f="mg" value="${esc(c.mg==null?'':c.mg)}" placeholder="mg" aria-label="Peptide ${i+1} mg per vial">
          <input type="number" inputmode="decimal" step="any" min="0" data-f="halfLifeHours" value="${esc(c.halfLifeHours==null?'':c.halfLifeHours)}" placeholder="${d?d:'hours'}" aria-label="Peptide ${i+1} half-life in hours">
          <button type="button" class="icon-btn" data-rm-blend="${i}" aria-label="Remove peptide ${i+1}">✕</button>
        </div>`; }).join('') : `<p class="footnote" style="margin:0;">No peptides yet. Add them, or fill a preset and check it against your vial's label.</p>`;
      blendOut();
    }
    function blendOut(){
      const parts = blendParts({blend: blendRows});
      const dose = parseFloat($('#pDose',body).value), unit = $('#pDoseUnit',body).value;
      const out = $('#pBlendOut',body);
      if(!parts){ out.textContent = ''; return; }
      const total = parts.reduce((s,c)=>s+c.mg,0);
      out.innerHTML = `Vial total ${Math.round(total*100)/100} mg.` + (isFinite(dose) && dose>0 ? ` Each ${esc(fmtDose(dose, unit))} dose: ` + parts.map(c=>`${esc(c.name)} ${esc(fmtDose(Math.round(dose*c.frac*1000)/1000, unit))}${c.hl?'':' <span style="color:var(--warn)">(needs half-life)</span>'}`).join(', ') + '.' : '');
    }
    drawBlend();
    $('#pIsBlend',body).addEventListener('change', ()=>{
      const on = $('#pIsBlend',body).checked;
      $('#pBlendBox',body).hidden = !on;
      $('#pHalfLife',body).closest('.field').hidden = on;
      if(on && !blendRows.length){ blendRows.push({name:'',mg:'',halfLifeHours:''}); drawBlend(); }
    });
    $('#pHalfLife',body).closest('.field').hidden = $('#pIsBlend',body).checked;
    const onBlendInput = e=>{
      const row = e.target.closest('[data-i]'); const f = e.target.dataset.f;
      if(!row || !f) return;
      blendRows[+row.dataset.i][f] = e.target.value;
      if(f==='name'){ const d = defaultHalfLife(e.target.value); row.querySelector('[data-f=halfLifeHours]').placeholder = d ? d : 'hours'; }
      blendOut();
    };
    $('#pBlendRows',body).addEventListener('input', onBlendInput);
    $('#pBlendRows',body).addEventListener('click', e=>{ const b = e.target.closest('[data-rm-blend]'); if(!b) return; blendRows.splice(+b.dataset.rmBlend,1); drawBlend(); });
    $('#pAddBlend',body).addEventListener('click', ()=>{ blendRows.push({name:'',mg:'',halfLifeHours:''}); drawBlend(); });
    $$('[data-blend-preset]',body).forEach(b=> b.addEventListener('click', ()=>{
      blendRows = BLEND_PRESETS[b.dataset.blendPreset].map(c=>({name:c.name, mg:c.mg, halfLifeHours:''}));
      if(!$('#pCompound',body).value.trim()) $('#pCompound',body).value = b.dataset.blendPreset.replace(/\s*\(.*\)/,'') + ' blend';
      const tot = blendRows.reduce((s,c)=>s+num(c.mg,0),0);
      if(!$('#pVialMg',body).value){ $('#pVialMg',body).value = tot; recalc(); }
      drawBlend();
    }));
    ['#pDose','#pDoseUnit'].forEach(s=> $(s,body).addEventListener('input', blendOut));
    function halfLifeHint(){
      const d = defaultHalfLife($('#pCompound',body).value);
      $('#pHalfLife',body).placeholder = d ? String(d) : 'e.g. 4';
      $('#pHalfLifeHint',body).textContent = d ? `Leave blank to use ${fmtHours(d)}, a typical published figure for this compound. Enter your own to override.` : 'No typical figure on file for this compound. Enter its half-life to see it on the chart.';
    }
    $('#pCompound',body).addEventListener('input', halfLifeHint);
    halfLifeHint();
    ['#pVialMg','#pBacMl','#pDose','#pDoseUnit','#pSplit'].forEach(sel=>{
      $(sel,body).addEventListener('input', recalc);
      $(sel,body).addEventListener('change', recalc);
    });
    recalc();

    // Titration steps
    let steps = titrationSteps(p).map(s=>({...s}));
    function drawSteps(){
      $('#pSteps',body).innerHTML = steps.length ? steps.map((s,i)=>`
        <div class="step-row" data-i="${i}">
          <input type="date" data-f="start" value="${esc(s.start||'')}" aria-label="Step ${i+1} start date">
          <input type="number" inputmode="decimal" step="any" data-f="dose" value="${esc(s.dose==null?'':s.dose)}" placeholder="Dose" aria-label="Step ${i+1} dose">
          <select data-f="doseUnit" aria-label="Step ${i+1} unit"><option value="mcg" ${s.doseUnit==='mcg'?'selected':''}>mcg</option><option value="mg" ${s.doseUnit==='mg'?'selected':''}>mg</option></select>
          <button type="button" class="icon-btn" data-rm-step="${i}" aria-label="Remove step ${i+1}">✕</button>
        </div>`).join('') : `<p class="footnote" style="margin:0;">No steps. The dose above applies on every dose day.</p>`;
    }
    drawSteps();
    $('#pSteps',body).addEventListener('input', e=>{
      const row = e.target.closest('[data-i]'); const f = e.target.dataset.f;
      if(row && f) steps[+row.dataset.i][f] = e.target.value;
    });
    $('#pSteps',body).addEventListener('change', e=>{
      const row = e.target.closest('[data-i]'); const f = e.target.dataset.f;
      if(row && f) steps[+row.dataset.i][f] = e.target.value;
    });
    $('#pSteps',body).addEventListener('click', e=>{
      const b = e.target.closest('[data-rm-step]'); if(!b) return;
      steps.splice(+b.dataset.rmStep,1); drawSteps();
    });
    $('#pAddStep',body).addEventListener('click', ()=>{
      const last = steps.filter(s=>s.start).map(s=>s.start).sort().pop();
      steps.push({start: addDays(last || todayISO(), last ? 28 : 0), dose:'', doseUnit: $('#pDoseUnit',body).value});
      drawSteps();
    });

    // Injection site: body map + select stay in sync
    let selSite = '';
    const drawMap = ()=>{ $('#pSiteMap',body).innerHTML = bodyMapSVG(p, selSite); };
    drawMap();
    $('#pSiteMap',body).addEventListener('click', e=>{
      const z = e.target.closest('[data-site]'); if(!z) return;
      selSite = selSite===z.dataset.site ? '' : z.dataset.site;
      $('#pSite',body).value = selSite;
      drawMap();
    });
    $('#pSiteMap',body).addEventListener('keydown', e=>{
      const z = e.target.closest('[data-site]'); if(!z || (e.key!=='Enter' && e.key!==' ')) return;
      e.preventDefault(); z.dispatchEvent(new MouseEvent('click',{bubbles:true}));
    });
    $('#pSite',body).addEventListener('change', ()=>{
      const v = $('#pSite',body).value;
      selSite = (v && v!=='__undo') ? v : '';
      drawMap();
    });
    (function(){
      const last = lastSiteOf(p), hint = $('#pSiteHint',body);
      hint.textContent = (last ? `Last: ${last.site} on ${fmtDateShort(last.date)}. ` : 'No site logged yet. ') + `Suggested next: ${suggestNextSite(p)}.`;
    })();

    if(existing){
      $('#pDelete',body).addEventListener('click', ()=>{
        closeModal();
        confirmAction('Permanently delete this protocol and its dose history? Archive it instead if you want to keep the record.', ()=> dbDelete('protocols', existing.id));
      });
      const archiveBtn = $('#pArchive',body);
      if(archiveBtn) archiveBtn.addEventListener('click', ()=>{
        closeModal();
        confirmAction('Archive this protocol? It moves to Past protocols with its full history kept.', async ()=>{
          await dbSet('protocols', existing.id, {...stripId(existing), status:'archived', endedDate: todayISO()});
        }, 'Archive');
      });
      const pauseBtn = $('#pPause',body);
      if(pauseBtn) pauseBtn.addEventListener('click', async ()=>{ closeModal(); await pauseProtocol(existing); });
      const resumeBtn = $('#pResume',body);
      if(resumeBtn) resumeBtn.addEventListener('click', async ()=>{ closeModal(); await resumeProtocol(existing); });
    }
    $('#pCancel',body).addEventListener('click', closeModal);
    $('#pSave',body).addEventListener('click', async ()=>{
      const compound = $('#pCompound',body).value.trim();
      if(!compound){ $('#pCompound',body).focus(); return; }
      const note = $('#pNote',body).value.trim();
      const history = Array.isArray(p.history)? p.history.slice() : [];
      if(note) history.push({date: todayISO(), note});
      const newActiveVialId = $('#pActiveVial',body).value || null;
      let siteLog = siteLogOf(p).slice();
      const siteSel = $('#pSite',body).value;
      if(siteSel === '__undo'){
        siteLog.sort((a,b)=> (a.date||'').localeCompare(b.date||'')); siteLog.pop();
      } else if(siteSel){
        const sd = $('#pSiteDate',body).value || todayISO();
        siteLog = siteLog.filter(e=>e.date!==sd);          // one entry per date; re-logging replaces it
        siteLog.push({date:sd, site:siteSel});
        siteLog.sort((a,b)=> (a.date||'').localeCompare(b.date||''));
      }
      const titration = steps
        .filter(s=> s.start && num(s.dose,null)!=null)
        .map(s=>({start:s.start, dose:s.dose, doseUnit:s.doseUnit||$('#pDoseUnit',body).value}))
        .sort((a,b)=> a.start.localeCompare(b.start));
      const data = {
        ...stripId(p),
        compound, dose:$('#pDose',body).value, doseUnit:$('#pDoseUnit',body).value,
        dosesPerDay: parseInt($('#pSplit',body).value,10) || 1,
        units:$('#pUnits',body).value, syringeMl:$('#pSyringeMl',body).value, doseNumber:$('#pDoseNumber',body).value, frequencyDays: dowSel.size ? '1' : $('#pFreq',body).value,
        activeWeekdays: [...dowSel].sort((x,y)=>x-y), doseTime:$('#pDoseTime',body).value,
        sortOrder:$('#pSortOrder',body).value,
        vialMg:$('#pVialMg',body).value, bacMl:$('#pBacMl',body).value,
        halfLifeHours:$('#pHalfLife',body).value,
        blend: $('#pIsBlend',body).checked ? blendRows.filter(c=> (c.name||'').trim()).map(c=>({name:c.name.trim(), mg:c.mg, halfLifeHours:c.halfLifeHours})) : [],
        activeVialId: newActiveVialId,
        startDate:$('#pStart',body).value, nextDose:$('#pNext',body).value,
        cycleStart:$('#pCycleStart',body).value, cycleOnWeeks:$('#pOn',body).value, cycleOffWeeks:$('#pOff',body).value,
        titration,
        history,
        siteLog: siteLog.slice(-40),
        status: p.status || 'active',
      };
      if(dowSel.size){
        const nd = data.nextDose;
        if(!nd || !dowSel.has(new Date(nd+'T00:00:00').getDay())){
          const from = (data.startDate && data.startDate > doseDayISO()) ? data.startDate : doseDayISO();
          data.nextDose = nextScheduledDate(data, from) || nd;
        }
      }
      // Assigning a vial that hasn't been opened yet opens it now: move one unit
      // from sealed stock into active use and start its remaining-amount tracker.
      if(newActiveVialId && newActiveVialId!==p.activeVialId){
        const vial = state.vials.find(v=>v.id===newActiveVialId);
        if(vial && vial.remainingMg==null){
          await dbSet('vials', vial.id, {
            ...stripId(vial),
            qty: Math.max(0, num(vial.qty,1)-1),
            dateOpened: vial.dateOpened || todayISO(),
            remainingMg: num(vial.mgPerVial,0),
          });
        }
      }
      if(existing) await dbSet('protocols', existing.id, data); else await dbAdd('protocols', data);
      closeModal();
    });
  });
}
$('#addProtocolBtn').addEventListener('click', ()=> openProtocolModal(null));

/* ===================== Serum level chart ===================== */
/* Approximate typical half-lives in hours (published / commonly cited figures; the protocol's own half-life field wins).
   First matching rule wins, so more specific names come first. */
const HALF_LIFE_RULES = [
  [/cjc-?1295.*dac/i, 192, /no\s*dac/i],
  [/cjc-?1295|mod\s*grf/i, 0.5],
  [/semaglutide/i, 168], [/tirzepatide/i, 120], [/retatrutide/i, 144], [/cagrilintide/i, 168],
  [/dulaglutide/i, 120], [/liraglutide/i, 13], [/exenatide/i, 2.4], [/lixisenatide/i, 3],
  [/ipamorelin/i, 2], [/sermorelin/i, 0.2], [/tesamorelin/i, 0.5], [/ghrp-?2/i, 0.5], [/ghrp-?6/i, 0.5],
  [/hexarelin/i, 1], [/mk-?677|ibutamoren/i, 24], [/pt-?141|bremelanotide/i, 2.7],
  [/thymosin alpha|tα1|ta1/i, 2], [/bpc-?157/i, 4],
];
function defaultHalfLife(name){
  const s = String(name||'');
  for(const r of HALF_LIFE_RULES){ if(r[0].test(s) && !(r[2] && r[2].test(s))) return r[1]; }
  return null;
}
function halfLifeOf(p){
  const own = num(p.halfLifeHours, null);
  return own>0 ? own : defaultHalfLife(p.compound);
}
/* Blends: p.blend = [{name, mg (amount per vial), halfLifeHours}]. Each injection splits by mg share. */
function blendOf(p){
  const b = Array.isArray(p && p.blend) ? p.blend.filter(c=> c && (c.name||'').trim() && num(c.mg,0)>0) : [];
  return b.length ? b : null;
}
function blendParts(p){
  const b = blendOf(p); if(!b) return null;
  const total = b.reduce((s,c)=> s+num(c.mg,0), 0);
  return b.map(c=>({name:c.name.trim(), frac:num(c.mg,0)/total, mg:num(c.mg,0), hl: num(c.halfLifeHours,null)>0 ? num(c.halfLifeHours) : defaultHalfLife(c.name)}));
}
const BLEND_PRESETS = {
  'KLOW (80 mg)': [{name:'GHK-Cu', mg:50}, {name:'TB-500', mg:10}, {name:'BPC-157', mg:10}, {name:'KPV', mg:10}],
  'GLOW (70 mg)': [{name:'GHK-Cu', mg:50}, {name:'TB-500', mg:10}, {name:'BPC-157', mg:10}],
};
function fmtHours(h){ return h>=48 ? `${Math.round(h/24*10)/10} days` : h<1 ? `${Math.round(h*60)} min` : `${Math.round(h*10)/10} h`; }
const HOUR = 3600000;
/* Every injection as {t (ms), mg}. Entries logged before timestamps existed (or backfilled) sit at noon. */
function injectionEvents(p){
  const log = Array.isArray(p.doseLog) ? p.doseLog : [];
  const times = Array.isArray(p.doseTimes) ? p.doseTimes.slice() : [];
  const n = splitCount(p);
  return log.map(day=>{
    const k = times.findIndex(x=>x.day===day);
    const t = k>-1 ? times.splice(k,1)[0].t : new Date(day+'T12:00:00').getTime();
    const d = doseAt(p, day);
    return {t, mg: (doseToMg(d.dose, d.doseUnit)||0)/n, day};
  });
}
/* Doses still to come from the schedule, at the usual time of day for this protocol. */
function scheduledEvents(p, nowMs, untilMs){
  const evs = injectionEvents(p).filter(e=> e.day);
  const hrs = evs.length ? evs.map(e=>{ const d = new Date(e.t); return d.getHours()+d.getMinutes()/60; }).sort((a,b)=>a-b) : [9];
  const tm = /^(\d{1,2}):(\d{2})$/.exec(p.doseTime||'');
  const hr = tm ? +tm[1]+(+tm[2])/60 : hrs[Math.floor(hrs.length/2)];
  const today = doseDayISO(), n = splitCount(p), out = [];
  const endISO = isoFromDate(new Date(untilMs));
  doseDatesInRange(p, today, endISO).forEach(iso=>{
    if(iso===today && injectionsOn(p, iso)>=n) return;
    const d = doseAt(p, iso), mg = (doseToMg(d.dose, d.doseUnit)||0)/n;
    const base = new Date(iso+'T00:00:00'); base.setMinutes(Math.round(hr*60));
    for(let i=0;i<n;i++){
      const t = base.getTime() + i*Math.min(8, 12/n)*HOUR;
      if(t>nowMs && t<=untilMs) out.push({t, mg});
    }
  });
  return out;
}
function levelAt(events, hl, t){
  let s = 0;
  for(const e of events){ if(e.t<=t) s += e.mg*Math.pow(0.5, (t-e.t)/(hl*HOUR)); }
  return s;
}
function fmtAmount(mg){
  if(!(mg>0)) return '0 mg';
  if(mg>=1) return `${Math.round(mg*100)/100} mg`;
  const mcg = mg*1000;
  return mcg>=10 ? `${Math.round(mcg)} mcg` : `${Math.round(mcg*100)/100} mcg`;
}
// Series ids hidden from the serum chart; everything shows unless tapped off in the list under it.
const serumHidden = new Set((()=>{ try{ return JSON.parse(lsGet('ledger.serumHidden','[]')) || []; }catch(e){ return []; } })());
const saveSerumHidden = ()=> lsSet('ledger.serumHidden', JSON.stringify([...serumHidden]));
function serumSeries(){
  const colorMap = protocolColorMap();
  const out = [], missing = [];
  state.protocols.filter(p=> p.status!=='archived').forEach(p=>{
    const evs = injectionEvents(p).filter(e=>e.mg>0);
    if(!evs.length && !isActiveP(p)) return;
    const base = colorMap.get(p.id)||PROTOCOL_COLORS[0];
    const parts = blendParts(p);
    if(parts){
      const bi = PROTOCOL_COLORS.indexOf(base);
      parts.forEach((c,i)=>{
        if(!c.hl){ if(isActiveP(p)) missing.push(`${p.compound||'Blend'}: ${c.name}`); return; }
        out.push({p, id:`${p.id}:${i}`, label:c.name, sub:p.compound||'Blend', frac:c.frac, hl:c.hl,
          evs: evs.map(e=>({...e, mg:e.mg*c.frac})),
          color: i===0 || bi<0 ? base : PROTOCOL_COLORS[(bi + i*3) % PROTOCOL_COLORS.length]});
      });
      return;
    }
    const hl = halfLifeOf(p);
    if(!hl){ if(isActiveP(p)) missing.push(p.compound||'Untitled'); return; }
    out.push({p, id:p.id, label:p.compound||'Untitled', sub:'', frac:1, hl, evs, color: base});
  });
  return {series:out, missing};
}
const SERUM_WINDOWS = [['1h',HOUR],['12h',12*HOUR],['24h',24*HOUR],['7d',7*24*HOUR],['30d',30*24*HOUR]];
let serumWin = SERUM_WINDOWS.some(w=>w[0]===lsGet('ledger.serumWin','')) ? lsGet('ledger.serumWin','') : '7d';
let serumEnd = null;   // right edge of the view in ms; null keeps "now" at 70% across
const serumWinMs = ()=> SERUM_WINDOWS.find(w=>w[0]===serumWin)[1];
const serumFollowEnd = now=> now + serumWinMs()*0.3;
function serumAxisLabel(t){
  const d = new Date(t), win = serumWinMs();
  if(win <= 24*HOUR) return d.toLocaleTimeString(undefined,{hour:'numeric', minute: win<=HOUR ? '2-digit' : undefined});
  return d.toLocaleDateString(undefined,{month:'short', day:'numeric'});
}
const SV = {W:360, H:220, padL:46, padR:12, padT:14, padB:28};
/* Draws the visible slice [t1 - window, t1]. ctx holds per-series event lists computed once per render. */
function serumSvgInner(ctx, t1, winMs){
  const {W,H,padL,padR,padT,padB} = SV;
  const now = ctx.now, t0 = t1 - (winMs || serumWinMs());
  const STEPS = 160;
  const lines = ctx.shown.map(c=>{
    const pts = [];
    for(let i=0;i<=STEPS;i++) pts.push(t0 + (t1-t0)*i/STEPS);
    c.all.filter(e=>e.t>=t0 && e.t<=t1).forEach(e=>{ pts.push(e.t-1, e.t); });
    if(now>=t0 && now<=t1) pts.push(now);
    pts.sort((x,y)=>x-y);
    const past = pts.filter(t=>t<=now).map(t=>({t, y:levelAt(c.s.evs, c.s.hl, t)}));
    const fut = pts.filter(t=>t>=now).map(t=>({t, y: t===now ? levelAt(c.s.evs, c.s.hl, t) : levelAt(c.all, c.s.hl, t)}));
    return {c, past, fut};
  });
  const val = (l,y)=> ctx.pct ? y/l.c.peak*100 : y;
  const vis = lines.flatMap(l=> l.past.concat(l.fut).map(p=>val(l,p.y)));
  const yMax = ctx.pct ? 100 : Math.max(1e-9, ...vis)*1.08;
  const X = t=> padL + (W-padL-padR)*(t-t0)/(t1-t0);
  const Y = v=> padT + (H-padT-padB)*(1 - v/yMax);
  const fmtY = ctx.pct ? (v=> `${Math.round(v)}%`) : (v=> v>0 ? fmtAmount(v).replace(' mg','mg').replace(' mcg','mcg') : '0');
  let g = `<rect x="0" y="0" width="${W}" height="${H}" fill="transparent"/>`;
  niceTicks(0, yMax, 4).ticks.filter(v=> v<=yMax*1.001).forEach(v=>{
    const y = Y(v).toFixed(1);
    g += `<line x1="${padL}" x2="${W-padR}" y1="${y}" y2="${y}" class="ch-grid"/><text x="${padL-6}" y="${(+y+4).toFixed(1)}" class="ch-ylab">${esc(fmtY(v))}</text>`;
  });
  [[t0,'start'],[(t0+t1)/2,'middle'],[t1,'end']].forEach(([t,anchor])=>{
    g += `<text x="${X(t).toFixed(1)}" y="${H-8}" class="ch-xlab" text-anchor="${anchor}">${esc(serumAxisLabel(t))}</text>`;
  });
  if(now>=t0 && now<=t1){
    g += `<line x1="${X(now).toFixed(1)}" x2="${X(now).toFixed(1)}" y1="${padT}" y2="${H-padB}" class="ch-marker" style="stroke:var(--muted)"/>`;
    g += `<text x="${(X(now)+4).toFixed(1)}" y="${padT+9}" class="ch-mlab" style="fill:var(--muted)">Now</text>`;
  }
  const toPath = (l,pts)=> pts.map(p=>`${X(p.t).toFixed(1)},${Y(val(l,p.y)).toFixed(1)}`).join(' ');
  const base = (H-padB).toFixed(1);
  lines.forEach(l=>{
    if(l.past.length>1) g += `<polygon points="${X(l.past[0].t).toFixed(1)},${base} ${toPath(l,l.past)} ${X(l.past[l.past.length-1].t).toFixed(1)},${base}" style="fill:${l.c.s.color};opacity:.13"/>`;
    if(l.fut.length>1) g += `<polygon points="${X(l.fut[0].t).toFixed(1)},${base} ${toPath(l,l.fut)} ${X(l.fut[l.fut.length-1].t).toFixed(1)},${base}" style="fill:${l.c.s.color};opacity:.06"/>`;
  });
  // dose markers along the bottom: filled = logged, hollow = scheduled
  const seen = new Set();
  lines.forEach(l=>{
    if(seen.has(l.c.s.p.id)) return; seen.add(l.c.s.p.id);
    l.c.all.filter(e=> e.t>=t0 && e.t<=t1).forEach(e=>{
      const x = X(e.t).toFixed(1), logged = e.t<=now && l.c.s.evs.some(v=>v.t===e.t);
      g += `<path d="M${x} ${(H-padB-1).toFixed(1)} l-4 7 h8 z" style="fill:${logged?l.c.s.color:'var(--surface)'};stroke:${l.c.s.color};stroke-width:1.2"/>`;
    });
  });
  ctx.scale = {t0, t1, X, Y, val, yMax};
  lines.forEach(l=>{
    if(l.past.length>1) g += `<polyline points="${toPath(l,l.past)}" class="ch-line" style="stroke:${l.c.s.color}"/>`;
    if(l.fut.length>1) g += `<polyline points="${toPath(l,l.fut)}" class="ch-line" style="stroke:${l.c.s.color};stroke-dasharray:5 4;opacity:.75"/>`;
    if(now>=t0 && now<=t1){
      const cur = levelAt(l.c.s.evs, l.c.s.hl, now);
      g += `<circle cx="${X(now).toFixed(1)}" cy="${Y(val(l,cur)).toFixed(1)}" r="4.5" style="fill:${l.c.s.color}"><title>${esc(l.c.s.label)}: ${esc(fmtAmount(cur))} now</title></circle>`;
    }
  });
  return g;
}
/* Chart scrubbing input. iPhone Safari is more reliable with touch events than pointer events on SVG,
   so touch devices use touch events: a sideways drag reads values, an up/down swipe scrolls the page. */
function bindScrub(el, onMove, onEnd){
  if('ontouchstart' in window){
    let start = null, mode = null;
    el.addEventListener('touchstart', e=>{ const t = e.touches[0]; start = {x:t.clientX, y:t.clientY}; mode = null; onMove(t.clientX); }, {passive:true});
    el.addEventListener('touchmove', e=>{
      if(!start) return;
      const t = e.touches[0], dx = Math.abs(t.clientX-start.x), dy = Math.abs(t.clientY-start.y);
      if(!mode && (dx>6 || dy>6)) mode = dy > dx*1.2 ? 'scroll' : 'scrub';
      if(mode==='scroll'){ onEnd(true); return; }
      e.preventDefault(); onMove(t.clientX);
    }, {passive:false});
    el.addEventListener('touchend', ()=>{ start = null; onEnd(false); });
    el.addEventListener('touchcancel', ()=>{ start = null; onEnd(true); });
    return;
  }
  let active = null;
  el.addEventListener('pointerdown', e=>{ active = e.pointerId; try{ el.setPointerCapture(e.pointerId); }catch(_){} onMove(e.clientX); });
  el.addEventListener('pointermove', e=>{ if(active===e.pointerId || e.pointerType==='mouse') onMove(e.clientX); });
  el.addEventListener('pointerup', ()=>{ active = null; onEnd(false); });
  el.addEventListener('pointercancel', ()=>{ active = null; onEnd(true); });
  el.addEventListener('pointerleave', e=>{ if(e.pointerType==='mouse') onEnd(true); });
}
/* Finger/mouse scrub: a crosshair with a readout of every line at the touched moment. */
function attachSerumScrub(wrap, ctx){
  const svg = $('svg', wrap);
  const cross = document.createElement('div'); cross.className = 'scrub-line'; cross.hidden = true;
  const tip = document.createElement('div'); tip.className = 'scrub-tip'; tip.hidden = true;
  wrap.append(cross, tip);
  let dots = [];
  const hide = ()=>{ cross.hidden = tip.hidden = true; dots.forEach(d=>d.remove()); dots = []; };
  const show = clientX=>{
    const sc = ctx.scale; if(!sc) return;
    const r = svg.getBoundingClientRect();
    const k = r.width / SV.W;
    const xv = Math.max(SV.padL, Math.min(SV.W-SV.padR, (clientX - r.left)/k));
    const t = sc.t0 + (xv-SV.padL)/(SV.W-SV.padL-SV.padR)*(sc.t1-sc.t0);
    cross.hidden = false; cross.style.left = (xv/SV.W*100)+'%';
    cross.style.top = (SV.padT/SV.H*100)+'%'; cross.style.height = ((SV.H-SV.padT-SV.padB)/SV.H*100)+'%';
    dots.forEach(d=>d.remove()); dots = [];
    const rows = ctx.shown.map(c=>{
      const y = t<=ctx.now ? levelAt(c.s.evs, c.s.hl, t) : levelAt(c.all, c.s.hl, t);
      const d = document.createElement('i'); d.className = 'scrub-dot';
      d.style.left = (xv/SV.W*100)+'%'; d.style.top = (sc.Y(ctx.pct ? y/c.peak*100 : y)/SV.H*100)+'%'; d.style.background = c.s.color;
      wrap.appendChild(d); dots.push(d);
      return `<div><i style="background:${c.s.color}"></i>${esc(c.s.label)}<b class="mono">${esc(fmtAmount(y))}${ctx.pct?` <span>${Math.round(y/c.peak*100)}%</span>`:''}</b></div>`;
    });
    const d = new Date(t);
    tip.innerHTML = `<div class="scrub-when">${esc(d.toLocaleDateString(undefined,{weekday:'short', month:'short', day:'numeric'}))} · ${esc(d.toLocaleTimeString(undefined,{hour:'numeric', minute:'2-digit'}))}${t>ctx.now?' <span>projected</span>':''}</div>${rows.join('')}`;
    tip.hidden = false;
    const left = xv/SV.W*r.width, w = tip.offsetWidth;
    tip.style.left = Math.max(0, Math.min(r.width - w, left - w/2)) + 'px';
  };
  bindScrub(wrap, show, ()=> hide());
  return {hide};
}
function serumCtx(shownS, now, pct){
  const horizon = now + 31*24*HOUR;
  return {now, pct, shown: shownS.map(s=>{
    const all = s.evs.concat(scheduledEvents(s.p, now, horizon).map(e=>({...e, mg:e.mg*s.frac})));
    // peak used for the % view: highest level right after any injection
    const peak = Math.max(1e-12, ...all.map(e=> levelAt(all, s.hl, e.t)));
    return {s, all, peak};
  })};
}
function renderSerum(){
  const el = $('#serumBody'), ctl = $('#serumControls');
  if(!el) return;
  if(ctl) ctl.innerHTML = '';
  const {series, missing} = serumSeries();
  const miss = missing.length ? `<p class="footnote" style="margin-top:8px;">No half-life for ${missing.map(m=>esc(m)).join(', ')}. Edit the protocol and enter one to chart it.</p>` : '';
  if(!series.length){
    el.innerHTML = `<div class="empty"><div class="glyph">📉</div><p>Add a protocol and log a dose to see the level of it in your body over time.</p></div>${miss}`;
    return;
  }
  const now = Date.now();
  const shownS = series.filter(s=> !serumHidden.has(s.id));
  const ctx = serumCtx(shownS, now, new Set(shownS.map(s=>s.p.id)).size>1);
  const earliest = Math.min(now, ...series.flatMap(s=> s.evs.map(e=>e.t)));
  const clampEnd = t1=> Math.max(earliest + serumWinMs()*0.25, Math.min(now + 30*24*HOUR, t1));
  let t1 = serumEnd==null ? serumFollowEnd(now) : clampEnd(serumEnd);
  const wins = SERUM_WINDOWS.map(([k])=> `<button type="button" class="chip-btn ${serumWin===k?'on':''}" data-serum-win="${k}">${k}</button>`).join('');
  const rows = series.map(s=>{
    const cur = levelAt(s.evs, s.hl, now);
    const lastPeak = Math.max(0, ...s.evs.filter(e=>e.t<=now).map(e=>levelAt(s.evs, s.hl, e.t)));
    const last = s.evs.filter(e=>e.t<=now).sort((a,b)=>b.t-a.t)[0];
    const off = serumHidden.has(s.id);
    return `<button type="button" class="serum-row ${off?'off':''}" data-serum-toggle="${esc(s.id)}" aria-pressed="${!off}"><span class="serum-dot" style="--c:${s.color}"></span>
      <span class="serum-name"><strong>${esc(s.label)}</strong><span class="footnote">${s.sub?` · ${esc(s.sub)}`:''} · t½ ${esc(fmtHours(s.hl))}${last?'':' · no doses logged'}</span></span>
      <span class="mono serum-val">${esc(fmtAmount(cur))}${lastPeak>0?` <span class="footnote">${Math.round(cur/lastPeak*100)}% of peak</span>`:''}</span></button>`;
  }).join('');
  if(ctl){
    ctl.innerHTML = `<div class="chip-row">${wins}</div>`;
    $$('[data-serum-win]',ctl).forEach(b=> b.addEventListener('click', ()=>{
      // keep the same centre point when switching windows, unless following now
      const centre = serumEnd==null ? null : t1 - serumWinMs()/2;
      serumWin = b.dataset.serumWin; lsSet('ledger.serumWin', serumWin);
      if(centre!=null) serumEnd = centre + serumWinMs()/2;
      renderSerum();
    }));
  }
  const hint = series.length>1 ? `<p class="footnote serum-hint">Tap a peptide to hide or show it on the chart.</p>` : '';
  if(!shownS.length){
    el.innerHTML = `<div class="empty serum-none"><p>All peptides are hidden. Tap one below to show it.</p></div>${hint}${rows}${miss}`;
    $$('[data-serum-toggle]',el).forEach(b=> b.addEventListener('click', ()=>{ serumHidden.delete(b.dataset.serumToggle); saveSerumHidden(); renderSerum(); }));
    return;
  }
  el.innerHTML = `
    <div class="serum-pan">
      <svg viewBox="0 0 ${SV.W} ${SV.H}" class="chart" id="serumSvg" role="img" aria-label="Estimated serum level over time. Touch and drag to read the level at any moment.">${serumSvgInner(ctx, t1)}</svg>
    </div>
    <div class="serum-nav"><button type="button" class="btn btn-sm nav-arrow" id="serumBack" aria-label="Earlier">‹</button><span class="footnote" id="serumRangeLbl"></span><button type="button" class="btn btn-sm nav-arrow" id="serumFwd" aria-label="Later">›</button></div>
    <div style="text-align:center;margin:-4px 0 8px;"><button type="button" class="link-btn" id="serumNow" ${serumEnd==null?'hidden':''}>↺ Back to now</button></div>
    ${hint}${rows}${miss}`;
  $$('[data-serum-toggle]',el).forEach(b=> b.addEventListener('click', ()=>{
    const id = b.dataset.serumToggle;
    if(serumHidden.has(id)) serumHidden.delete(id); else serumHidden.add(id);
    saveSerumHidden(); renderSerum();
  }));
  const svg = $('#serumSvg',el), lbl = $('#serumRangeLbl',el), nowBtn = $('#serumNow',el);
  const rangeText = ()=>{
    const t0 = t1 - serumWinMs();
    const f = t=> new Date(t).toLocaleString(undefined, serumWinMs()<=24*HOUR ? {month:'short', day:'numeric', hour:'numeric', minute:'2-digit'} : {month:'short', day:'numeric'});
    lbl.textContent = `${f(t0)} – ${f(t1)}`;
  };
  rangeText();
  const scrub = attachSerumScrub($('.serum-pan',el), ctx);
  const draw = ()=>{ scrub.hide(); svg.innerHTML = serumSvgInner(ctx, t1); rangeText(); nowBtn.hidden = serumEnd==null; };
  const step = dir=>{ t1 = clampEnd(t1 + dir*serumWinMs()/2); serumEnd = t1; draw(); };
  $('#serumBack',el).addEventListener('click', ()=> step(-1));
  $('#serumFwd',el).addEventListener('click', ()=> step(1));
  nowBtn.addEventListener('click', ()=>{ serumEnd = null; t1 = serumFollowEnd(now); draw(); });
}

/* ===================== Peptides: Stash ===================== */
function renderVials(){
  const el = $('#vialList');
  if(!state.vials.some(v=>!isDepleted(v))){
    el.innerHTML = `<div class="empty"><div class="glyph">🧪</div><p>No vials logged. Add one to see how long your stash will last.</p></div>`;
    return;
  }
  const groups = {};
  const order = [];
  state.vials.filter(v=>!isDepleted(v)).forEach(v=>{
    const key = v.compound || 'Vial';
    if(!groups[key]){ groups[key] = []; order.push(key); }
    groups[key].push(v);
  });
  const BUD_MAX = 8640000000000000;
  order.sort((a,b)=> a.localeCompare(b, undefined, {sensitivity:'base'}));
  const shelf = order.map((compound, gi)=>{
    const lots = groups[compound].slice().sort((a,b)=>{
      const ta = a.bud ? new Date(a.bud).getTime() : BUD_MAX;
      const tb = b.bud ? new Date(b.bud).getTime() : BUD_MAX;
      return ta - tb;
    });
    const totalQty = lots.reduce((s,v)=> s+num(v.qty,1), 0);
    const calcs = lots.map(v=> stashCalc(v));
    const anyCalc = calcs.some(c=> c && c.daysRemaining!=null);
    const totalDays = calcs.reduce((s,c)=> s + (c && c.daysRemaining!=null ? Math.max(c.daysRemaining,0) : 0), 0);
    const totalLow = anyCalc && totalDays<=7;
    const color = colorFor(compound, gi);
    const rows = lots.map((v,i)=>{
      const calc = calcs[i];
      const low = calc && calc.daysRemaining!=null && calc.daysRemaining<=7;
      const budDays = v.bud ? daysBetween(todayISO(), v.bud) : null;
      const budSoon = budDays!=null && budDays<=7;
      const activeFor = state.protocols.find(p=> p.status!=='archived' && p.activeVialId===v.id);
      const qty = num(v.qty,1), mg = num(v.mgPerVial,0);
      const isOpen = v.remainingMg!=null;
      const pct = isOpen && mg>0 ? Math.max(0,Math.min(1, v.remainingMg/mg)) : null;
      const status = isOpen
        ? `<span class="pill pill-pep">Opened${v.dateOpened?' '+esc(fmtDateShort(v.dateOpened)):''}</span><span class="lot-left mono">${Math.round(v.remainingMg*10)/10} / ${mg} mg</span>`
        : `<span class="pill pill-muted">Unopened</span>`;
      const tests = vialTests(v);
      const meta = [v.lot?`Lot ${esc(v.lot)}`:'', v.concentration?`${num(v.concentration)} mg/mL`:''].filter(Boolean).join(' · ');
      return `<div class="lot" data-open-vial="${v.id}" role="button" tabindex="0" aria-label="Edit ${esc(v.pharmacy||compound)} lot">
        <div class="lot-vial">${vialSVG({color, pct, mgTag: mg?`${mg} mg`:'', name: compound, brand: v.pharmacy||'', lot: v.lot||''}, `l${gi}_${i}`)}${qty+(isOpen?1:0)>1?`<span class="lot-qty">×${qty+(isOpen?1:0)}</span>`:''}</div>
        <div class="lot-info">
          <div class="lot-top"><span class="lot-name">${esc(v.pharmacy||'No vendor')}</span>${isOpen ? `<button type="button" class="lot-act" data-finish-vial="${v.id}">Finish</button>` : qty>=1 ? `<button type="button" class="lot-act" data-open-lot="${v.id}">Open</button>` : ''}</div>
          <div class="lot-pills">${status}
            ${activeFor? `<span class="pill pill-info">In use</span>` : ''}
            ${calc && calc.daysRemaining!=null ? `<span class="pill ${low?'pill-warn':'pill-good'}">${calc.daysRemaining<=0?'Out':calc.daysRemaining+'d left'}</span>` : ''}
            ${v.bud? `<span class="pill ${budSoon?'pill-warn':'pill-muted'}">BUD ${esc(fmtDateShort(v.bud))}</span>` : ''}
          </div>
          ${(()=>{ const bits = [meta, Array.isArray(v.finishedLog)&&v.finishedLog.length ? `${v.finishedLog.length} finished` : ''].filter(Boolean); return bits.length ? `<div class="lot-meta">${bits.join(' · ')}</div>` : ''; })()}
        </div>
        ${tests.length ? `<div class="lot-coas"><button type="button" class="coa-mini ${tests.length>1?'stack':''}" data-coa-vial="${v.id}" data-coa-i="0" aria-label="View ${tests.length>1 ? tests.length+' certificates of analysis' : 'certificate of analysis'+(tests[0].lab?' from '+esc(tests[0].lab):'')}">
          <span class="coa-fan">${tests.slice(0,3).map((t,k,a)=>`<span class="coa-sheet" style="--k:${k - (a.length-1)/2};z-index:${k}">${coaMiniSVG(t, mg)}</span>`).join('')}</span>
          <span class="coa-cap">${tests.length>1 ? `${tests.length} COAs` : 'COA'}</span></button></div>` : ''}
      </div>`;
    }).join('');
    const fill = lots.find(v=> v.remainingMg!=null && num(v.mgPerVial,0)>0);
    const pct = fill ? Math.max(0, Math.min(1, fill.remainingMg/num(fill.mgPerVial,1))) : null;
    const meta = `${totalQty} vial${totalQty===1?'':'s'}${anyCalc ? ` · ${totalDays<=0?'out':'~'+totalDays+'d'}` : ''}`;
    const mgTag = num(lots[0].mgPerVial,0) ? `${num(lots[0].mgPerVial,0)} mg` : '';
    const vendors = [...new Set(lots.map(v=> (v.pharmacy||'').trim()).filter(Boolean))];
    return {compound, name: compound, brand: vendors.length===1 ? vendors[0] : '', color, pct, low: totalLow, meta, totalQty, anyCalc, totalDays, rows, mgTag};
  });
  if(stashSel && !groups[stashSel]) stashSel = null;
  el.innerHTML = `<div class="vial-shelf">${shelf.map((g,i)=>`
    <button type="button" class="vial-tile ${stashSel===g.compound?'on':''} ${g.low?'low':''}" data-vial-group="${esc(g.compound)}" aria-expanded="${stashSel===g.compound}" style="--vc:${g.color}">
      ${vialSVG(g, i)}
      <span class="vial-label">${esc(g.compound)}</span>
      <span class="vial-meta">${esc(g.meta)}</span>
    </button>`).join('')}</div>`;
  const grid = $('.vial-shelf', el);
  const selIdx = shelf.findIndex(g=> g.compound===stashSel);
  if(selIdx>=0){
    const g = shelf[selIdx];
    // the detail opens directly under the row holding the tapped vial, with a caret pointing at it
    const cols = Math.max(1, getComputedStyle(grid).gridTemplateColumns.split(' ').filter(Boolean).length);
    const tiles = $$('.vial-tile', grid);
    const rowEnd = tiles[Math.min(tiles.length-1, Math.floor(selIdx/cols)*cols + cols-1)];
    const det = document.createElement('div');
    det.className = 'vial-detail';
    det.style.setProperty('--vc', g.color);
    det.style.setProperty('--caret', `${((selIdx%cols)+0.5)/cols*100}%`);
    det.innerHTML = `<div class="vial-detail-h"><strong>${esc(g.compound)}</strong>
        <span class="pill pill-muted">${g.totalQty} vial${g.totalQty===1?'':'s'}</span>
        ${g.anyCalc ? `<span class="pill ${g.low?'pill-warn':'pill-good'}">${g.totalDays<=0?'Out':'~'+g.totalDays+'d left'}</span>` : ''}
        <button type="button" class="link-btn vial-add" data-add-vial="${esc(g.compound)}">+ Add vial</button></div>
      ${g.rows}`;
    rowEnd.after(det);
  }
  $$('[data-vial-group]',el).forEach(b=> b.addEventListener('click', ()=>{
    stashSel = stashSel===b.dataset.vialGroup ? null : b.dataset.vialGroup;
    renderVials();
    const t = $(`.vial-detail`, el); if(t) t.scrollIntoView({behavior:'smooth', block:'nearest'});
  }));
  $$('[data-add-vial]',el).forEach(b=> b.addEventListener('click', ()=>{
    openVialModal(null);
    const f = $('#vCompound'); if(f) f.value = b.dataset.addVial;
  }));
  $$('[data-finish-vial]',el).forEach(b=> b.addEventListener('click', e=>{
    e.stopPropagation();
    const v = state.vials.find(x=>x.id===b.dataset.finishVial); if(!v) return;
    const p = protocolForVial(v);
    openVialSwapModal({p: p && (p.activeVialId===v.id || !p.activeVialId) ? p : null, cur:v});
  }));
  $$('[data-open-lot]',el).forEach(b=> b.addEventListener('click', e=>{
    e.stopPropagation();
    const v = state.vials.find(x=>x.id===b.dataset.openLot); if(!v) return;
    // opening from the stash only switches the protocol over; a vial still in use stays open until finished
    openVialSwapModal({p: protocolForVial(v), preselect:v});
  }));
  $$('[data-coa-vial]',el).forEach(b=> b.addEventListener('click', e=>{
    e.stopPropagation();
    const v = state.vials.find(x=>x.id===b.dataset.coaVial); if(v) openCoaModal(v, +b.dataset.coaI);
  }));
  $$('[data-open-vial]',el).forEach(card=>{
    const open = ()=> openVialModal(state.vials.find(v=>v.id===card.dataset.openVial));
    card.addEventListener('click', e=>{ if(e.target.closest('[data-coa],[data-coa-vial]')) return; open(); });
    card.addEventListener('keydown', e=>{ if((e.key==='Enter'||e.key===' ') && e.target===card){ e.preventDefault(); open(); } });
  });
}
let stashSel = null;   // compound whose stash detail is open under its vial
/* Colour for a compound's vial cap and liquid: its protocol's colour when there is one. */
function colorFor(compound, i){
  const cm = protocolColorMap(), key = (compound||'').trim().toLowerCase();
  const p = state.protocols.find(x=> x.status!=='archived' && (x.compound||'').trim().toLowerCase()===key);
  if(p && cm.get(p.id)) return cm.get(p.id);
  // unlinked compounds take colours no protocol is using, so two vials don't look alike
  const used = new Set(cm.values());
  const free = PROTOCOL_COLORS.filter(c=> !used.has(c));
  const pool = free.length ? free : PROTOCOL_COLORS;
  return pool[i % pool.length];
}
/* Lighten (k>0) or darken (k<0) a #rrggbb colour. */
function shade(hex, k){
  const n = parseInt(String(hex).slice(1),16); const r=n>>16, g=(n>>8)&255, b=n&255;
  const f = v=> Math.round(k>0 ? v+(255-v)*k : v*(1+k));
  return '#'+[f(r),f(g),f(b)].map(v=>Math.max(0,Math.min(255,v)).toString(16).padStart(2,'0')).join('');
}
/* A realistic serum vial: brushed silver cap and crimp, stopper in the neck, thick clear glass with refraction
   edges, liquid at the open vial's remaining level (or a powder cake while sealed), and a clinical pharmacy label.
   g: {color, pct (0-1 or null), mgTag, name, brand (vendor), lot}. */
function vialSVG(g, i){
  const id = 'vg'+i, W=80, H=156, bx=11, bw=58, by=46, bb=146, cx=40, c0 = g.color;
  const m = ['#7d8088','#c9ccd2','#f4f5f7','#a9acb3','#e6e8ec','#8a8d95'];
  const inner = {x:bx+2.8, w:bw-5.6, top:by+3, bot:bb-7};
  const ly = g.pct==null ? null : inner.bot - (inner.bot-inner.top-6)*Math.max(.03, g.pct);
  const body = `M${cx-19} 30 L${cx-19} 36 C${cx-19} 41 ${bx} 40 ${bx} ${by+5} V${bb-5} Q${bx} ${bb} ${bx+6} ${bb} H${bx+bw-6} Q${bx+bw} ${bb} ${bx+bw} ${bb-5} V${by+5} C${bx+bw} 40 ${cx+19} 41 ${cx+19} 36 L${cx+19} 30Z`;
  const powderTop = `M${inner.x} ${inner.bot-16} q6 -2.4 11 -.8 t11 -.6 t11 .9 t11 -.7 t${inner.w-44} .4`;
  return `<svg class="vial-svg" viewBox="0 0 ${W} ${H}" aria-hidden="true"><defs>
    <linearGradient id="${id}cap" x1="0" x2="1">${m.map((c,k)=>`<stop offset="${[0,.18,.34,.55,.78,1][k]}" stop-color="${c}"/>`).join('')}</linearGradient>
    <linearGradient id="${id}capT" x1="0" x2="1" y1="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".9"/><stop offset=".5" stop-color="${m[2]}"/><stop offset="1" stop-color="${m[3]}"/></linearGradient>
    <linearGradient id="${id}skirt" x1="0" x2="1"><stop offset="0" stop-color="#6d7078"/><stop offset=".3" stop-color="#d9dbe0"/><stop offset=".5" stop-color="#9da0a8"/><stop offset=".8" stop-color="#eceef1"/><stop offset="1" stop-color="#6a6d75"/></linearGradient>
    <linearGradient id="${id}glass" x1="0" x2="1"><stop offset="0" stop-color="#7f97a8" stop-opacity=".75"/><stop offset=".045" stop-color="#c9d8e2" stop-opacity=".45"/><stop offset=".12" stop-color="#f4f8fb" stop-opacity=".2"/><stop offset=".5" stop-color="#fff" stop-opacity=".1"/><stop offset=".88" stop-color="#f4f8fb" stop-opacity=".18"/><stop offset=".955" stop-color="#c3d3de" stop-opacity=".45"/><stop offset="1" stop-color="#6f879a" stop-opacity=".8"/></linearGradient>
    <linearGradient id="${id}liq" x1="0" x2="1"><stop offset="0" stop-color="${shade(c0,-.35)}" stop-opacity=".75"/><stop offset=".25" stop-color="${c0}" stop-opacity=".45"/><stop offset=".6" stop-color="${shade(c0,.35)}" stop-opacity=".35"/><stop offset="1" stop-color="${shade(c0,-.4)}" stop-opacity=".75"/></linearGradient>
    <linearGradient id="${id}pow" x1="0" x2="1"><stop offset="0" stop-color="#cfcbc4"/><stop offset=".3" stop-color="#f4f2ee"/><stop offset=".7" stop-color="#fbfaf8"/><stop offset="1" stop-color="#c8c4bc"/></linearGradient>
    <linearGradient id="${id}hl" x1="0" x2="1"><stop offset="0" stop-color="#fff" stop-opacity="0"/><stop offset=".45" stop-color="#fff" stop-opacity=".85"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient>
    <radialGradient id="${id}sh" cx=".5" cy=".5" r=".5"><stop offset="0" stop-color="#1c2a3a" stop-opacity=".35"/><stop offset="1" stop-color="#1c2a3a" stop-opacity="0"/></radialGradient>
    <clipPath id="${id}in"><rect x="${inner.x}" y="${inner.top}" width="${inner.w}" height="${inner.bot-inner.top}" rx="5"/></clipPath>
    <clipPath id="${id}bd"><path d="${body}"/></clipPath>
  </defs>
  <ellipse cx="${cx}" cy="${bb+3}" rx="34" ry="5" fill="url(#${id}sh)"/>
  <path d="${body}" fill="url(#${id}glass)"/>
  <rect x="${cx-17.5}" y="30" width="35" height="7" rx="1.5" fill="#4d5057"/><rect x="${cx-17.5}" y="35.5" width="35" height="1.5" fill="#2f3136" fill-opacity=".6"/>
  <g clip-path="url(#${id}in)">
    ${ly==null
      ? `<path d="${powderTop} V${inner.bot+2} H${inner.x}Z" fill="url(#${id}pow)"/><path d="${powderTop}" fill="none" stroke="#fff" stroke-opacity=".9" stroke-width=".8"/>`
      : `<rect x="${inner.x}" y="${ly}" width="${inner.w}" height="${inner.bot-ly+2}" fill="url(#${id}liq)"/>
         <ellipse cx="${cx}" cy="${ly}" rx="${inner.w/2}" ry="2.2" fill="${shade(c0,.45)}" fill-opacity=".55"/>
         <ellipse cx="${cx}" cy="${ly}" rx="${inner.w/2}" ry="2.2" fill="none" stroke="#fff" stroke-opacity=".7" stroke-width=".6"/>`}
  </g>
  <g clip-path="url(#${id}bd)">
    <rect x="${bx}" y="${bb-8}" width="${bw}" height="8" fill="#d3e2ec" fill-opacity=".6"/>
    <ellipse cx="${cx}" cy="${bb-7.5}" rx="${bw/2-3}" ry="2" fill="none" stroke="#fff" stroke-opacity=".8" stroke-width=".7"/>
    <rect x="${inner.x}" y="${inner.top-2}" width="${inner.w}" height="${inner.bot-inner.top+2}" rx="5" fill="none" stroke="#fff" stroke-opacity=".45" stroke-width=".6"/>
    <rect x="${bx+5}" y="${by+2}" width="6.5" height="${bb-by-12}" rx="3" fill="url(#${id}hl)"/>
    <rect x="${bx+bw-8}" y="${by+4}" width="2.2" height="${bb-by-18}" rx="1.1" fill="#fff" fill-opacity=".6"/>
    <rect x="${bx+bw-4.5}" y="${by}" width="1.4" height="${bb-by-6}" fill="#5f7382" fill-opacity=".25"/>
    <rect x="${bx+3}" y="${by}" width="1.2" height="${bb-by-6}" fill="#5f7382" fill-opacity=".22"/>
  </g>
  ${vialLabelSVG(id, g, bx, bw)}
  <path d="${body}" fill="none" stroke="#6d8292" stroke-opacity=".55" stroke-width=".9"/>
  <rect x="${cx-21}" y="25" width="42" height="6" rx="1.2" fill="url(#${id}skirt)"/>
  <rect x="${cx-21}" y="28.6" width="42" height=".7" fill="#000" fill-opacity=".2"/>
  <rect x="${cx-26}" y="8" width="52" height="19" rx="3" fill="url(#${id}cap)"/>
  <rect x="${cx-26}" y="13.7" width="52" height=".35" fill="#fff" fill-opacity=".2"/><rect x="${cx-26}" y="19.8" width="52" height=".35" fill="#fff" fill-opacity=".2"/>
  <ellipse cx="${cx}" cy="8.5" rx="26" ry="4" fill="url(#${id}capT)"/>
  <ellipse cx="${cx}" cy="8.5" rx="8" ry="1.5" fill="${m[0]}" fill-opacity=".5"/>
  <rect x="${cx-26}" y="25.6" width="52" height="1.4" rx=".7" fill="${m[0]}" fill-opacity=".65"/>
  </svg>`;
}
/* Clinical pharmacy label: matte white paper, a colour band with the vendor, the peptide name, mg, lot and a barcode,
   a round holographic security seal on the band, and a clear viewing window with ticks so the fill level shows. */
function vialLabelSVG(id, g, bx, bw){
  const LY = 64, LH = 46, tx = bx+4;
  const fit = (t, w, n)=> String(t).length > n ? ` textLength="${w}" lengthAdjust="spacingAndGlyphs"` : '';
  const wx = bx+bw-11, wy = LY+13, wh = LH-17;
  const ticks = Array.from({length:7},(_,k)=>{ const y = wy + wh*(k/6), long = k%2===0;
    return `<rect x="${wx-(long?4:2.4)}" y="${y-.25}" width="${long?4:2.4}" height=".5" fill="#3b3f46"/>`; }).join('');
  // long vendor names keep whole words (e.g. "Peptide Sciences Research Supply" -> "PEPTIDE SCIENCES")
  const words = String(g.brand || 'Research peptide').toUpperCase().trim().split(/\s+/);
  let brand = words[0].slice(0, 16);
  for(const w of words.slice(1)){ if((brand+' '+w).length > 16) break; brand += ' '+w; }
  const name = g.name || g.compound || '';
  const lotLine = g.lot ? `Lyophilized · Lot ${g.lot}` : 'Lyophilized · Research use';
  const bars = [0,1.2,2,3.4,4.2,5,6.6,7.4,8.8,9.6,10.4,12,12.8,14.2,15].map((d,k)=>`<rect x="${tx+d}" y="${LY+36.5}" width="${k%3?0.55:1.05}" height="6" fill="#22252b"/>`).join('');
  const sx = bx+bw-7.5, sy = LY+5.2;
  return `<defs>
      <mask id="${id}lm"><rect x="${bx}" y="${LY}" width="${bw}" height="${LH}" fill="#fff"/><rect x="${wx}" y="${wy}" width="7" height="${wh}" rx="3.5" fill="#000"/></mask>
      <linearGradient id="${id}lc" x1="0" x2="1"><stop offset="0" stop-color="#000" stop-opacity=".32"/><stop offset=".14" stop-color="#000" stop-opacity="0"/><stop offset=".24" stop-color="#fff" stop-opacity=".45"/><stop offset=".34" stop-color="#fff" stop-opacity="0"/><stop offset=".86" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity=".34"/></linearGradient>
      <radialGradient id="${id}hs" cx=".32" cy=".3" r=".85"><stop offset="0" stop-color="#ffffff"/><stop offset=".22" stop-color="#ffc6e0"/><stop offset=".42" stop-color="#ffe7a3"/><stop offset=".58" stop-color="#bff3d0"/><stop offset=".74" stop-color="#a9dcff"/><stop offset=".88" stop-color="#d9c8ff"/><stop offset="1" stop-color="#b9bbc4"/></radialGradient>
    </defs>
    <g mask="url(#${id}lm)">
      <rect x="${bx}" y="${LY}" width="${bw}" height="${LH}" fill="#fbfaf7"/>
      <rect x="${bx}" y="${LY}" width="${bw}" height="9" fill="${g.color}"/>
      <text x="${tx}" y="${LY+6.6}" font-size="5.4" font-weight="800" letter-spacing=".6" font-family="system-ui,sans-serif" fill="#fff"${fit(brand,34,10)}>${esc(brand)}</text>
      <text x="${tx}" y="${LY+19}" font-size="8.6" font-weight="800" font-family="system-ui,sans-serif" fill="#15181c"${fit(name,37,9)}>${esc(name)}</text>
      ${g.mgTag ? `<text x="${tx}" y="${LY+28}" font-size="8" font-weight="700" font-family="ui-monospace,Menlo,monospace" fill="#2b2f36">${esc(g.mgTag)}</text>` : ''}
      <text x="${tx}" y="${LY+34}" font-size="3.6" font-family="system-ui,sans-serif" fill="#7a7e86"${fit(lotLine,35,18)}>${esc(lotLine)}</text>
      ${bars}
      <g opacity=".7">${ticks}</g>
      <rect x="${bx}" y="${LY}" width="${bw}" height="${LH}" fill="url(#${id}lc)"/>
    </g>
    <rect x="${wx}" y="${wy}" width="7" height="${wh}" rx="3.5" fill="none" stroke="rgba(30,40,50,.35)" stroke-width=".5"/>
    <rect x="${bx}" y="${LY}" width="${bw}" height=".6" fill="#fff" fill-opacity=".7"/><rect x="${bx}" y="${LY+LH-.6}" width="${bw}" height=".6" fill="#000" fill-opacity=".18"/>
    <circle cx="${sx}" cy="${sy}" r="5.8" fill="url(#${id}hs)"/>
    <circle class="holo-glint" cx="${sx-1.6}" cy="${sy-1.8}" r="1.6" fill="#fff" fill-opacity=".8"/>
    <circle cx="${sx}" cy="${sy}" r="5.8" fill="none" stroke="#fff" stroke-width=".6"/>
    <circle cx="${sx}" cy="${sy}" r="3.9" fill="none" stroke="#8e9099" stroke-opacity=".5" stroke-width=".3"/>
    <text x="${sx}" y="${sy+1.3}" text-anchor="middle" font-size="3.4" font-weight="900" font-family="system-ui,sans-serif" fill="#5c5f68" fill-opacity=".85">✓</text>`;
}
/* Mass as a share of the label claim, and a traffic-light grade for each assay. */
function coaGrades(t, labelMg){
  const mass = num(t.massMg,null), pur = num(t.purity,null), endo = num(t.endo,null);
  const massPct = mass!=null && labelMg>0 ? mass/labelMg*100 : null;
  return {
    mass, pur, endo, massPct,
    massG: massPct==null ? null : massPct>=90 && massPct<=110 ? 'ok' : massPct>=80 && massPct<=120 ? 'warn' : 'bad',
    purG: pur==null ? null : pur>=98 ? 'ok' : pur>=95 ? 'warn' : 'bad',
    endoG: endo==null ? null : endo<=1 ? 'ok' : endo<=5 ? 'warn' : 'bad'
  };
}
/* Thumbnail of a certificate: paper sheet, header band, text lines, a results table and a seal. */
function coaMiniSVG(t, labelMg){
  const g = coaGrades(t, labelMg);
  const dot = k=> k==='ok' ? '#17844f' : k==='warn' ? '#c98a12' : k==='bad' ? '#cf3434' : '#c9c3ba';
  return `<svg viewBox="0 0 44 56" aria-hidden="true">
    <rect x="1" y="1" width="42" height="54" rx="2.5" fill="#fffdf9" stroke="rgba(60,50,40,.25)"/>
    <rect x="1" y="1" width="42" height="9" rx="2.5" fill="#2f4a6b"/><rect x="1" y="7" width="42" height="3" fill="#2f4a6b"/>
    <rect x="6" y="4" width="20" height="2.4" rx="1" fill="#fff" fill-opacity=".85"/>
    <rect x="6" y="14" width="26" height="2" rx="1" fill="#8d857b"/><rect x="6" y="18.5" width="18" height="2" rx="1" fill="#b8b0a5"/>
    ${[['massG',25],['purG',31],['endoG',37]].map(([k,y])=>`<rect x="6" y="${y}" width="22" height="2" rx="1" fill="#cfc8bd"/><circle cx="35" cy="${y+1}" r="2" fill="${dot(g[k])}"/>`).join('')}
    <circle cx="33" cy="47" r="6" fill="none" stroke="#b33a3a" stroke-width="1.2" stroke-opacity=".75"/><circle cx="33" cy="47" r="3.6" fill="none" stroke="#b33a3a" stroke-width=".7" stroke-opacity=".6"/>
    <rect x="6" y="46" width="14" height="1.4" fill="#8d857b"/>
  </svg>`;
}
/* Full certificate, rebuilt from what the user entered for this vial's lab test. */
/* One rebuilt certificate sheet for a lab test on a vial. */
function coaDocHTML(v, t){
  const labelMg = num(v.mgPerVial,0);
  const g = coaGrades(t, labelMg);
  const chip = k=> k ? `<span class="coa-res ${k}">${k==='ok'?'Conforms':k==='warn'?'Borderline':'Out of range'}</span>` : '<span class="coa-res">—</span>';
  const fmt = (x,d=2)=> x==null ? '—' : String(Math.round(x*10**d)/10**d);
  const lab = t.lab || 'Independent laboratory';
  const ref = `${(lab.replace(/[^A-Za-z]/g,'').slice(0,3)||'LAB').toUpperCase()}-${(t.date||'').replace(/-/g,'') || '000000'}-${(v.lot||v.id||'').toString().replace(/[^A-Za-z0-9]/g,'').slice(-5).toUpperCase() || '00000'}`;
  const coa = safeUrl(t.coaUrl);
  return `<div class="coa-doc">
      <div class="coa-band"><div class="coa-logo">${esc(lab.slice(0,1).toUpperCase())}</div><div><div class="coa-lab">${esc(lab)}</div><div class="coa-sub">Analytical testing report</div></div></div>
      <div class="coa-title">Certificate of Analysis</div>
      <div class="coa-ref mono">Ref ${esc(ref)}</div>
      <table class="coa-kv">
        <tr><th>Sample</th><td>${esc(v.compound||'—')}</td></tr>
        <tr><th>Supplier</th><td>${esc(v.pharmacy||'—')}</td></tr>
        <tr><th>Lot / batch</th><td class="mono">${esc(v.lot||'—')}</td></tr>
        <tr><th>Label claim</th><td class="mono">${labelMg?esc(labelMg+' mg / vial'):'—'}</td></tr>
        <tr><th>Test date</th><td>${t.date?esc(fmtDate(t.date)):'—'}</td></tr>
      </table>
      <table class="coa-res-t">
        <thead><tr><th>Test</th><th>Method</th><th>Result</th><th></th></tr></thead>
        <tbody>
          <tr><td>Content</td><td>HPLC</td><td class="mono">${g.mass==null?'—':esc(fmt(g.mass)+' mg')}${g.massPct!=null?`<small>${esc(fmt(g.massPct,1))}% of label</small>`:''}</td><td>${chip(g.massG)}</td></tr>
          <tr><td>Purity</td><td>HPLC</td><td class="mono">${g.pur==null?'—':esc(fmt(g.pur)+'%')}</td><td>${chip(g.purG)}</td></tr>
          <tr><td>Endotoxin</td><td>LAL</td><td class="mono">${g.endo==null?'—':esc(fmt(g.endo,3)+' EU/mg')}</td><td>${chip(g.endoG)}</td></tr>
        </tbody>
      </table>
      <div class="coa-foot">
        <div class="coa-sign"><div class="coa-sig-line"></div><span>Analyst</span></div>
        <div class="coa-seal"><span>${esc(lab.slice(0,12).toUpperCase())}</span><b>TESTED</b><span>${t.date?esc(fmtDateShort(t.date)):''}</span></div>
      </div>
    </div>
    ${coa ? `<a class="btn btn-sm coa-orig" href="${esc(coa)}" target="_blank" rel="noopener">Open original report ↗</a>` : ''}`;
}
/* Certificates for a vial; several are laid side by side and swiped between, starting at index i. */
function openCoaModal(v, i){
  const tests = vialTests(v); if(!tests[i]) return;
  const many = tests.length > 1;
  openModal(many ? `Certificates of analysis` : 'Certificate of analysis', `
    ${many ? `<div class="coa-pager"><button type="button" class="coa-nav" id="coaPrev" aria-label="Previous certificate">‹</button><span id="coaCount" class="mono">1 / ${tests.length}</span><button type="button" class="coa-nav" id="coaNext" aria-label="Next certificate">›</button></div>` : ''}
    <div class="coa-track ${many?'many':''}" id="coaTrack">${tests.map(t=>`<div class="coa-slide">${coaDocHTML(v, t)}</div>`).join('')}</div>
    ${many ? `<div class="coa-dots" id="coaDots">${tests.map((_,k)=>`<i data-k="${k}"></i>`).join('')}</div>` : ''}
    <p class="footnote" style="margin-top:10px;">Rebuilt from the values you entered for this vial. Grades: mass 90–110% of label, purity ≥ 98%, endotoxin ≤ 1 EU/mg.</p>
    <div class="form-actions"><button type="button" class="btn btn-accent-pep" id="coaEdit">Edit vial</button></div>
  `, body=>{
    $('#coaEdit',body).addEventListener('click', ()=>{ closeModal(); openVialModal(v); });
    if(!many) return;
    const track = $('#coaTrack',body), dots = $$('#coaDots i',body), count = $('#coaCount',body);
    const cur = ()=> Math.round(track.scrollLeft / Math.max(1, track.clientWidth));
    const go = k=> track.scrollTo({left: Math.max(0, Math.min(tests.length-1, k)) * track.clientWidth, behavior:'smooth'});
    const sync = ()=>{ const k = cur(); count.textContent = `${k+1} / ${tests.length}`; dots.forEach((d,j)=> d.classList.toggle('on', j===k)); $('#coaPrev',body).disabled = k===0; $('#coaNext',body).disabled = k===tests.length-1; };
    track.addEventListener('scroll', ()=> requestAnimationFrame(sync), {passive:true});
    $('#coaPrev',body).addEventListener('click', ()=> go(cur()-1));
    $('#coaNext',body).addEventListener('click', ()=> go(cur()+1));
    dots.forEach(d=> d.addEventListener('click', ()=> go(+d.dataset.k)));
    requestAnimationFrame(()=>{ track.scrollLeft = i * track.clientWidth; sync(); });
  });
}
/* Lab tests on a vial: the first lives in flat fields (testLab, testMassMg, …); more go in v.extraTests. */
function testFilled(t){ return !!(t && (t.lab || t.massMg || t.purity || t.endo || t.coaUrl)); }
function vialTests(v){
  const first = {lab:v.testLab||'', massMg:v.testMassMg||'', purity:v.testPurity||'', endo:v.testEndo||'', date:v.testDate||'', coaUrl:v.coaUrl||''};
  const extra = Array.isArray(v.extraTests) ? v.extraTests : [];
  return [first].concat(extra).filter(testFilled);
}
/* Vendor picker for a vial. The vial stores the vendor's name in its existing pharmacy field,
   so older entries, cost tracking and backups keep working. */
function vendorOptions(current){
  const names = state.vendors.map(x=> (x.name||'').trim()).filter(Boolean).sort((a,b)=> a.localeCompare(b, undefined, {sensitivity:'base'}));
  const cur = (current||'').trim();
  const known = names.some(n=> n.toLowerCase()===cur.toLowerCase());
  return `<option value="">— None —</option>` +
    names.map(n=>`<option value="${esc(n)}" ${known && n.toLowerCase()===cur.toLowerCase()?'selected':''}>${esc(n)}</option>`).join('') +
    (cur && !known ? `<option value="${esc(cur)}" selected>${esc(cur)} (not in vendor list)</option>` : '') +
    `<option value="__new">+ Add a different vendor…</option>`;
}
function hasLabTest(v){ return vialTests(v).length>0; }
function safeUrl(u){ return /^https?:\/\//i.test(String(u||'').trim()) ? String(u).trim() : ''; }
function labTestHTML(v){
  return vialTests(v).map(t=>{
    const bits = [];
    if(num(t.massMg,null)!=null) bits.push(`${num(t.massMg)} mg`);
    if(num(t.purity,null)!=null) bits.push(`${num(t.purity)}% pure`);
    if(num(t.endo,null)!=null) bits.push(`${num(t.endo)} EU/mg`);
    const coa = safeUrl(t.coaUrl);
    return `<div class="lab-test"><span class="pill pill-good">🔬 Tested${t.lab?` · ${esc(t.lab)}`:''}</span>${bits.length||t.date?`<span class="footnote">${esc(bits.join(' · '))}${t.date?`${bits.length?' · ':''}${esc(fmtDateShort(t.date))}`:''}</span>`:''}${coa?`<a href="${esc(coa)}" target="_blank" rel="noopener" data-coa>View COA ↗</a>`:''}</div>`;
  }).join('');
}
/* ===================== Peptides: finishing a vial and opening the next ===================== */
/* A vial record is a lot: qty sealed vials plus, while remainingMg is set, one open vial being drawn from.
   Finishing clears the open vial and logs it in finishedLog; a lot with nothing sealed or open is marked depleted
   (kept for cost history, hidden from the stash). */
function isDepleted(v){ return !!(v && v.depleted); }
function mgPerInjection(p){
  if(!p) return 0;
  const d = doseAt(p, todayISO());
  return (doseToMg(d.dose, d.doseUnit) || 0) / splitCount(p);
}
/* Where a protocol stands with its vial: none / unopened / ok / low (less than one injection left) / empty. */
function vialState(p){
  const vial = p.activeVialId ? state.vials.find(v=>v.id===p.activeVialId) : null;
  if(!vial || isDepleted(vial)) return {kind:'none', vial:null};
  if(vial.remainingMg==null) return {kind:'unopened', vial};
  const left = num(vial.remainingMg,0), per = mgPerInjection(p);
  if(left <= 0.001) return {kind:'empty', vial, left:0};
  if(per && left < per - 0.001) return {kind:'low', vial, left};
  return {kind:'ok', vial, left};
}
/* Vials that could be opened next for a compound: the lot being finished first, then soonest BUD.
   Already-open vials from other lots are offered as "switch to" without opening anything. */
function nextVialCandidates(compound, cur){
  const c = (compound||'').trim().toLowerCase();
  const BUD_MAX = '9999-12-31';
  return state.vials
    .filter(v=> !isDepleted(v) && (v.compound||'').trim().toLowerCase()===c)
    .filter(v=> (cur && v.id===cur.id) ? num(v.qty,0)>=1 : (v.remainingMg!=null ? num(v.remainingMg,0)>0.001 : num(v.qty,1)>=1))
    .sort((a,b)=>{
      if(cur && a.id===cur.id) return -1;
      if(cur && b.id===cur.id) return 1;
      return (a.bud||BUD_MAX).localeCompare(b.bud||BUD_MAX);
    });
}
function openVialSwapModal({p=null, cur=null, preselect=null}={}){
  const finishing = cur && cur.remainingMg!=null ? cur : null;
  const compound = (p && p.compound) || (cur && cur.compound) || (preselect && preselect.compound) || '';
  const color = colorFor(compound, 0);
  const cands = nextVialCandidates(compound, finishing);
  let chosen = preselect ? preselect.id : (cands[0] ? cands[0].id : '');
  const perInj = mgPerInjection(p);
  const bacDefault = (p && num(p.bacMl,0)) || num(cur && cur.bacMl,0) || 2;
  const vialBit = (v, pct, tag)=> `<div class="swap-vial">${vialSVG({color, pct, mgTag: num(v.mgPerVial,0)?`${num(v.mgPerVial,0)} mg`:'', name: compound, brand: v.pharmacy||'', lot: v.lot||''}, tag)}</div>`;
  const optMeta = v=>{
    if(finishing && v.id===finishing.id) return `Same lot · ${num(v.qty,0)} sealed${v.bud?` · BUD ${fmtDateShort(v.bud)}`:''}`;
    if(v.remainingMg!=null) return `Already open · ${round2(num(v.remainingMg,0))} mg left`;
    return `${num(v.qty,1)} sealed${v.bud?` · BUD ${fmtDateShort(v.bud)}`:''}${v.lot?` · Lot ${v.lot}`:''}`;
  };
  const left = finishing ? round2(num(finishing.remainingMg,0)) : 0;
  openModal(finishing ? 'Finish & open next' : 'Open a vial', `
    ${finishing ? `<div class="swap-sec"><h4>Finishing</h4>
      <div class="swap-row">${vialBit(finishing, num(finishing.mgPerVial,0)>0 ? left/num(finishing.mgPerVial,1) : 0, 'sw_f')}
        <div><strong>${esc(finishing.pharmacy||compound)}</strong><div class="footnote">${num(finishing.mgPerVial,0)} mg vial${finishing.dateOpened?` · opened ${esc(fmtDateShort(finishing.dateOpened))}`:''}</div>
        <div class="footnote">${left>0.05 ? `${left} mg left, counted as discarded` : 'Empty'}</div></div></div></div>` : ''}
    <div class="swap-sec"><h4>${finishing ? 'Open next' : 'Choose a vial'}</h4>
      ${cands.length ? `<div class="swap-opts">${cands.map((v,i)=>`
        <label class="swap-opt"><input type="radio" name="swapNext" value="${v.id}" ${chosen===v.id?'checked':''}>
          ${vialBit(v, v.remainingMg!=null && num(v.mgPerVial,0)>0 && !(finishing && v.id===finishing.id) ? num(v.remainingMg,0)/num(v.mgPerVial,1) : null, 'sw_'+i)}
          <span class="swap-opt-t"><strong>${esc(v.pharmacy||'No vendor')}${num(v.mgPerVial,0)?` · ${num(v.mgPerVial,0)} mg`:''}</strong><span class="footnote">${esc(optMeta(v))}</span></span></label>`).join('')}
        ${finishing ? `<label class="swap-opt swap-none"><input type="radio" name="swapNext" value="" ${chosen===''?'checked':''}><span class="swap-opt-t"><strong>Don't open another now</strong><span class="footnote">Just mark this vial finished</span></span></label>` : ''}
      </div>` : `<p class="footnote">No sealed ${esc(compound||'')} vials left in your stash.</p>`}
    </div>
    <div class="swap-sec" id="swapRecon">
      <h4>Reconstitute</h4>
      <div class="form-grid">
        <div class="field"><label for="swapBac">BAC water (mL)</label><input id="swapBac" type="number" inputmode="decimal" step="any" min="0" value="${esc(String(bacDefault))}"></div>
        <div class="field"><label for="swapDate">Date opened</label><input id="swapDate" type="date" value="${todayISO()}" max="${todayISO()}"></div>
      </div>
      <div class="swap-out mono" id="swapOut"></div>
    </div>
    ${p ? `<p class="footnote" id="swapLinkNote" style="margin-top:8px;"></p>` : ''}
    <div class="form-actions"><button type="button" class="btn" id="swapCancel">Cancel</button><button type="button" class="btn btn-accent-pep" id="swapGo"></button></div>
  `, body=>{
    const recon = $('#swapRecon',body), out = $('#swapOut',body), go = $('#swapGo',body), note = $('#swapLinkNote',body);
    const pick = ()=> state.vials.find(v=>v.id===chosen) || null;
    const refresh = ()=>{
      const v = pick();
      const opening = v && (v.remainingMg==null || (finishing && v.id===finishing.id));
      recon.hidden = !opening;
      if(opening){
        const mg = num(v.mgPerVial,0), bac = num($('#swapBac',body).value,0);
        const conc = mg && bac ? mg/bac : null;
        out.textContent = conc ? `${round2(conc)} mg/mL${perInj ? ` · ${fmtAmount(perInj)} dose = ${Math.round(perInj/conc*100*10)/10} units` : ''}` : 'Enter the BAC water to see the concentration.';
      }
      go.textContent = finishing ? (v ? (opening ? 'Finish & open' : 'Finish & switch') : 'Mark finished') : 'Open vial';
      go.disabled = !finishing && !v;
      if(note) note.textContent = v ? `This becomes the active vial for ${p.compound||'this protocol'}.` : finishing ? `${p.compound||'This protocol'} will have no active vial until you open one.` : '';
    };
    $$('input[name="swapNext"]',body).forEach(r=> r.addEventListener('change', ()=>{ chosen = r.value; refresh(); }));
    $('#swapBac',body).addEventListener('input', refresh);
    $('#swapCancel',body).addEventListener('click', closeModal);
    go.addEventListener('click', async ()=>{
      go.disabled = true;
      const today = todayISO();
      if(finishing){
        const fresh = state.vials.find(v=>v.id===finishing.id) || finishing;
        const log = (Array.isArray(fresh.finishedLog) ? fresh.finishedLog : []).concat({opened: fresh.dateOpened||'', finished: today, leftoverMg: round2(num(fresh.remainingMg,0))});
        const upd = {...stripId(fresh), remainingMg:null, dateOpened:'', finishedLog:log};
        if(num(fresh.qty,0) <= 0) upd.depleted = true;
        await dbSet('vials', fresh.id, upd);
      }
      const nv = chosen ? state.vials.find(v=>v.id===chosen) : null;
      let bac = null;
      if(nv && nv.remainingMg==null){
        bac = num($('#swapBac',body).value, null);
        const mg = num(nv.mgPerVial,0);
        await dbSet('vials', nv.id, {...stripId(nv),
          qty: Math.max(0, num(nv.qty,1)-1),
          dateOpened: $('#swapDate',body).value || today,
          remainingMg: mg,
          bacMl: bac!=null ? String(bac) : (nv.bacMl||''),
          concentration: mg && bac ? String(round2(mg/bac)) : (nv.concentration||''),
          protocolId: p ? p.id : (nv.protocolId||null)});
      }
      if(p){
        const fp = state.protocols.find(x=>x.id===p.id) || p;
        const pu = {...stripId(fp), activeVialId: nv ? nv.id : ''};
        if(nv && bac!=null){ pu.vialMg = String(num(nv.mgPerVial,0)); pu.bacMl = String(bac); }
        await dbSet('protocols', fp.id, pu);
      }
      closeModal();
    });
    refresh();
  });
}
/* The active protocol (if any) for a compound, used when opening or finishing from the stash. */
function protocolForVial(v){
  const linked = state.protocols.find(p=> p.status!=='archived' && p.activeVialId===v.id);
  if(linked) return linked;
  const c = (v.compound||'').trim().toLowerCase();
  return state.protocols.find(p=> isActiveP(p) && (p.compound||'').trim().toLowerCase()===c) || null;
}
function openVialModal(existing){
  const v = existing || {};
  const protocolOptions = state.protocols.map(p=>`<option value="${p.id}" ${v.protocolId===p.id?'selected':''}>${esc(p.compound)}</option>`).join('');
  openModal(existing?'Edit vial':'Add vial', `
    <div class="form-grid">
      <div class="field span2"><label for="vCompound">Compound</label><input id="vCompound" type="text" value="${esc(v.compound||'')}"></div>
      <div class="field"><label for="vMg">mg per vial</label><input id="vMg" type="number" step="any" value="${esc(v.mgPerVial||'')}"></div>
      <div class="field"><label for="vQty">${v.remainingMg!=null ? 'Sealed vials <span style="font-weight:400;color:var(--muted);">(not counting the open one)</span>' : 'Qty (identical vials)'}</label><input id="vQty" type="number" step="1" min="0" value="${esc(String(v.qty ?? 1))}"></div>
      <div class="field"><label for="vConc">Concentration (mg/mL)</label><input id="vConc" type="number" step="any" value="${esc(v.concentration||'')}" placeholder="After reconstitution"></div>
      <div class="field"><label for="vPrice">Price paid ($, for this whole entry)</label><input id="vPrice" type="number" step="any" value="${esc(v.price||'')}" placeholder="e.g. 65"></div>
      <div class="field"><label for="vLot">Lot #</label><input id="vLot" type="text" value="${esc(v.lot||'')}"></div>
      <div class="field span2"><label for="vVendor">Vendor</label>
        <select id="vVendor">${vendorOptions(v.pharmacy)}</select>
        <div id="vNewVendorBox" hidden style="margin-top:8px;">
          <input id="vNewVendor" type="text" placeholder="New vendor name" aria-label="New vendor name">
          <label class="endo-check" style="margin-top:6px;font-weight:500;"><input type="checkbox" id="vSaveVendor" checked> Also add to my peptide vendor list</label>
        </div>
      </div>
      <div class="field"><label for="vOpened">Date opened</label><input id="vOpened" type="date" value="${esc(v.dateOpened||'')}" placeholder="Leave blank if unopened"></div>
      <div class="field"><label for="vBud">BUD (beyond-use date)</label><input id="vBud" type="date" value="${esc(v.bud||'')}"></div>
      <div class="field span2"><label for="vProtocol">Linked protocol (for dose/frequency)</label><select id="vProtocol"><option value="">— none —</option>${protocolOptions}</select></div>
      <details class="field span2 module-box" ${hasLabTest(v)?'open':''}>
        <summary style="cursor:pointer;font-weight:600;font-size:13px;">🔬 Lab test results <span style="font-weight:400;color:var(--muted);">(optional, add one per test)</span></summary>
        <div id="vTests" style="margin-top:10px;"></div>
        <button type="button" class="btn btn-sm" id="vAddTest" style="margin-top:10px;">+ Add another test result</button>
      </details>
    </div>
    <div class="form-actions">
      ${existing? `<button class="btn btn-danger" id="vDelete" style="margin-right:auto;">Delete</button>` : ''}
      <button class="btn" id="vCancel">Cancel</button><button class="btn btn-accent-pep" id="vSave">Save</button>
    </div>
  `, body=>{
    let tests = vialTests(v).map(t=>({...t}));
    if(!tests.length) tests.push({lab:'',massMg:'',purity:'',endo:'',date:'',coaUrl:''});
    const drawTests = ()=>{
      $('#vTests',body).innerHTML = tests.map((t,i)=>`<div class="test-block" data-i="${i}">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;"><strong style="font-size:12.5px;">Test ${i+1}</strong>${tests.length>1?`<button type="button" class="icon-btn" data-rm-test="${i}" aria-label="Remove test ${i+1}">✕ Remove</button>`:''}</div>
        <div class="form-grid">
          <div class="field span2"><label>Lab name</label><input type="text" data-f="lab" value="${esc(t.lab)}" placeholder="e.g. Janoshik"></div>
          <div class="field"><label>Tested mass (mg)</label><input type="number" inputmode="decimal" step="any" min="0" data-f="massMg" value="${esc(t.massMg)}" placeholder="e.g. 20.4"></div>
          <div class="field"><label>Purity (%)</label><input type="number" inputmode="decimal" step="any" min="0" max="100" data-f="purity" value="${esc(t.purity)}" placeholder="e.g. 99.2"></div>
          <div class="field"><label>Endotoxin (EU/mg)</label><input type="number" inputmode="decimal" step="any" min="0" data-f="endo" value="${esc(t.endo)}" placeholder="e.g. 0.5"></div>
          <div class="field"><label>Test date</label><input type="date" data-f="date" value="${esc(t.date)}"></div>
          <div class="field span2"><label>COA / test link</label><input type="url" inputmode="url" data-f="coaUrl" value="${esc(t.coaUrl)}" placeholder="https://…"></div>
        </div>
      </div>`).join('');
    };
    drawTests();
    const onTest = e=>{ const r = e.target.closest('[data-i]'), f = e.target.dataset.f; if(r && f) tests[+r.dataset.i][f] = e.target.value; };
    $('#vTests',body).addEventListener('input', onTest);
    $('#vTests',body).addEventListener('change', onTest);
    $('#vTests',body).addEventListener('click', e=>{ const b = e.target.closest('[data-rm-test]'); if(!b) return; tests.splice(+b.dataset.rmTest,1); drawTests(); });
    $('#vAddTest',body).addEventListener('click', ()=>{ tests.push({lab:'',massMg:'',purity:'',endo:'',date:'',coaUrl:''}); drawTests(); });
    const vendSel = $('#vVendor',body);
    vendSel.addEventListener('change', ()=>{
      const isNew = vendSel.value==='__new';
      $('#vNewVendorBox',body).hidden = !isNew;
      if(isNew) $('#vNewVendor',body).focus();
    });
    if(existing){
      $('#vDelete',body).addEventListener('click', ()=>{ closeModal(); confirmAction('Delete this vial?', ()=> dbDelete('vials', existing.id)); });
    }
    $('#vCancel',body).addEventListener('click', closeModal);
    $('#vSave',body).addEventListener('click', async ()=>{
      const compound = $('#vCompound',body).value.trim();
      if(!compound) return;
      let vendor = vendSel.value;
      if(vendor==='__new'){
        vendor = $('#vNewVendor',body).value.trim();
        if(!vendor){ $('#vNewVendor',body).focus(); return; }
        const dup = state.vendors.some(x=> (x.name||'').trim().toLowerCase()===vendor.toLowerCase());
        if($('#vSaveVendor',body).checked && !dup) await dbAdd('vendors', {name:vendor, subtext:'', url:'', deal:'', notes:''});
      }
      const data = {...stripId(v), compound, mgPerVial:$('#vMg',body).value, qty:($('#vQty',body).value==='' ? (v.remainingMg!=null ? 0 : 1) : $('#vQty',body).value), concentration:$('#vConc',body).value, price:$('#vPrice',body).value, lot:$('#vLot',body).value.trim(), pharmacy:vendor,
        ...(()=>{ const ts = tests.map(t=>({...t, lab:(t.lab||'').trim(), coaUrl:(t.coaUrl||'').trim()})).filter(testFilled); const f = ts[0] || {};
          return {testLab:f.lab||'', testMassMg:f.massMg||'', testPurity:f.purity||'', testEndo:f.endo||'', testDate:f.date||'', coaUrl:f.coaUrl||'', extraTests: ts.slice(1)}; })(),
        dateOpened:$('#vOpened',body).value, bud:$('#vBud',body).value, protocolId:$('#vProtocol',body).value||null};
      if(existing) await dbSet('vials', existing.id, data); else await dbAdd('vials', data);
      closeModal();
    });
  });
}
$('#addVialBtn').addEventListener('click', ()=> openVialModal(null));

/* ===================== Peptides: Supplies ===================== */
const SUPPLY_CATEGORIES = [
  {key:'fixneedle', label:'Fixed-needle syringes', group:'sharps', fields:['ml','gauge','needleLen']},
  {key:'syringe', label:'Syringes', group:'sharps', fields:['ml','luerType']},
  {key:'needle', label:'Hypodermic needles', group:'sharps', fields:['gauge','needleLen']},
  {key:'alcohol', label:'Alcohol pads', group:'prep', fields:[]},
  {key:'bacwater', label:'Bac water', group:'prep', fields:['ml']},
  {key:'aceticacid', label:'Acetic Acid', group:'prep', fields:['ml']},
  {key:'reconsupply', label:'Reconstitution supplies', group:'prep', fields:['ml']},
  {key:'pen', label:'Pens', group:'pen', fields:['penType']},
  {key:'penneedle', label:'Pen needles', group:'pen', fields:['gauge','needleLen']},
  {key:'cartridge', label:'Cartridges', group:'pen', fields:[]},
  {key:'skincare', label:'Skincare', group:'skin', fields:['ml']},
];
const SUPPLY_GROUPS = [
  {key:'sharps', label:'Syringes & needles'},
  {key:'prep', label:'Prep supplies'},
  {key:'pen', label:'Pen system'},
  {key:'skin', label:'Skincare'},
];
const SUPPLY_TAGS = [
  {key:'reconstitution', label:'Reconstitution'},
  {key:'dosage', label:'Dosage'},
  {key:'general', label:'General / prep'},
];
const NEEDLE_LEN_FRACTIONS = {0.25:'1/4',0.3125:'5/16',0.375:'3/8',0.5:'1/2',0.625:'5/8',0.75:'3/4',1:'1',1.25:'1 1/4',1.5:'1 1/2'};
function fmtNeedleLen(v){ const n = parseFloat(v); if(!n) return ''; const inch = `${NEEDLE_LEN_FRACTIONS[n] || String(n)}"`; return n<1 ? `${inch} · ${Math.round(n*25.4)}mm` : inch; }
function supplyCat(key){ return SUPPLY_CATEGORIES.find(c=>c.key===key) || null; }
function supplyCatLabel(s){ const c = supplyCat(s.category); return c ? c.label : 'Supply'; }
function supplyCatGroup(s){ const c = supplyCat(s.category); return c ? c.group : ''; }
function supplyHasField(s, field){ const c = supplyCat(s.category); return !!(c && c.fields.indexOf(field)>-1); }
function supplySpecBits(s){
  const bits = [];
  if(supplyHasField(s,'ml') && s.ml) bits.push(`${num(s.ml)}mL`);
  if(supplyHasField(s,'gauge') && s.gauge) bits.push(`${num(s.gauge)}G`);
  if(supplyHasField(s,'needleLen') && s.needleLen) bits.push(fmtNeedleLen(s.needleLen));
  if(supplyHasField(s,'luerType') && s.luerType) bits.push(s.luerType==='lock'?'Luer-lock':'Luer-slip');
  if(supplyHasField(s,'penType') && s.penType) bits.push(s.penType==='automatic'?'Automatic':'Manual');
  return bits;
}
function supplyLabel(s){
  const bits = supplySpecBits(s);
  const name = s.name ? esc(s.name) + (s.category==='alcohol' && !/alcohol|pad/i.test(s.name) ? ' alcohol pads' : '') : supplyCatLabel(s);
  return bits.length ? `${name} (${esc(bits.join(', '))})` : name;
}
function dosesPerWeekFor(p){
  const w = weekdaysOf(p);
  if(w) return w.length;
  const freq = num(p.frequencyDays, null);
  return freq ? 7/freq : null;
}
function supplyWeeklyUsage(supplyId){
  let total = 0;
  state.protocols.filter(isActiveP).forEach(p=>{
    const rules = Array.isArray(p.supplyUsage) ? p.supplyUsage : [];
    rules.filter(r=>r.supplyId===supplyId).forEach(r=>{
      const dpw = dosesPerWeekFor(p) * splitCount(p);
      if(!dpw) return;
      const perDoses = num(r.perDoses,1) || 1;
      const qty = num(r.qty,1) || 1;
      total += (dpw/perDoses)*qty;
    });
  });
  return total;
}
function supplyDaysRemaining(s){
  const weekly = supplyWeeklyUsage(s.id);
  if(!weekly) return null;
  const daily = weekly/7;
  return daily>0 ? Math.round(num(s.count,0)/daily) : null;
}
function supplyPills(s){
  const days = supplyDaysRemaining(s);
  const low = num(s.count,0)<=num(s.lowThreshold,5);
  const tags = (Array.isArray(s.tags)?s.tags:[]).map(t=>{ const o = SUPPLY_TAGS.find(x=>x.key===t); return o ? o.label : t; });
  return `<div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-top:6px;">
    <span class="pill ${low?'pill-warn':'pill-muted'}">${num(s.count,0)} on hand</span>
    ${days!=null? `<span class="pill ${days<=14?'pill-warn':'pill-good'}">${days<=0?'Out':days+'d left'}</span>` : ''}
    ${tags.map(t=>`<span class="pill pill-info">${esc(t)}</span>`).join('')}
  </div>`;
}
function supplySoloParts(s){
  let title = supplyCatLabel(s), sub = [s.name].concat(supplySpecBits(s)).filter(Boolean).join(' · ');
  if(s.category==='penneedle'){
    title = [s.name, s.gauge? `${num(s.gauge)}G`:'', fmtNeedleLen(s.needleLen)].filter(Boolean).join(' · ') || title; sub = 'Pen needle';
  } else if(s.category==='fixneedle'){
    title = [s.name, s.gauge? `${num(s.gauge)}G`:'', s.ml? `${num(s.ml)}mL`:''].filter(Boolean).join(' · ') || title;
    sub = ['Fixed-needle syringe', fmtNeedleLen(s.needleLen)].filter(Boolean).join(' · ');
  }
  return {title, sub};
}
// Row label inside a grouped category card: the spec that matters most for that category leads.
function supplyRowParts(s){
  const g = s.gauge? `${num(s.gauge)}G`:'', len = fmtNeedleLen(s.needleLen), ml = s.ml? `${num(s.ml)}mL`:'';
  const luer = s.luerType==='lock'?'Luer-lock':(s.luerType==='slip'?'Luer-slip':'');
  const j = a=> a.filter(Boolean).join(' · ');
  switch(s.category){
    case 'alcohol':   return {title: s.name || 'Unbranded', sub:''};
    case 'needle':    return {title: j([g,len]) || (s.name||'Needle'), sub: s.name||''};
    case 'syringe':   return {title: j([ml,luer]) || (s.name||'Syringe'), sub: s.name||''};
    case 'fixneedle': return {title: j([s.name,g,ml]) || 'Fixed-needle syringe', sub: len};
    case 'penneedle': return {title: j([s.name,g,len]) || 'Pen needle', sub:''};
    case 'bacwater':
    case 'aceticacid':return {title: ml || (s.name||supplyCatLabel(s)), sub: s.name||''};
    case 'reconsupply':return {title: s.name||'Supply', sub: ml};
    default:          return {title: s.name || supplyCatLabel(s), sub: supplySpecBits(s).join(' · ')};
  }
}
function supplyRowSorter(cat){
  const n = (v)=> v===''||v==null? 0 : (parseFloat(v)||0);
  const nm = (a,b)=> (a.name||'').localeCompare(b.name||'');
  if(cat==='needle')    return (a,b)=> n(a.gauge)-n(b.gauge) || n(a.needleLen)-n(b.needleLen) || nm(a,b);
  if(cat==='syringe')   return (a,b)=> n(a.ml)-n(b.ml) || String(a.luerType).localeCompare(String(b.luerType)) || nm(a,b);
  if(cat==='fixneedle') return (a,b)=> nm(a,b) || n(a.gauge)-n(b.gauge) || n(a.ml)-n(b.ml);
  if(cat==='bacwater'||cat==='aceticacid') return (a,b)=> n(a.ml)-n(b.ml) || nm(a,b);
  return nm;
}
function renderSupplyGroups(){
  const el = $('#supplyGroups');
  if(!el) return;
  if(!state.supplies.length){
    el.innerHTML = `<div class="empty"><div class="glyph">🧰</div><p>No supplies logged yet. Add syringes, needles, pads, bac water or pen gear to start tracking counts.</p></div>`;
    return;
  }
  el.innerHTML = SUPPLY_GROUPS.map(g=>{
    const items = state.supplies.filter(s=> supplyCatGroup(s)===g.key)
      .sort((a,b)=> supplyCatLabel(a).localeCompare(supplyCatLabel(b)) || supplyLabel(a).localeCompare(supplyLabel(b)));
    if(!items.length) return '';
    const cats = [];
    items.forEach(s=>{ let c = cats.find(x=>x.key===s.category); if(!c){ c={key:s.category, label:supplyCatLabel(s), items:[]}; cats.push(c); } c.items.push(s); });
    const rows = cats.map(c=>{
      if(c.items.length===1){
        const s = c.items[0], pt = supplySoloParts(s);
        return `<div class="card-flat supply-item-card" data-open-supply="${s.id}" style="cursor:pointer;">
          <div><strong>${esc(pt.title)}</strong>${pt.sub? `<div class="footnote" style="margin-top:2px;">${esc(pt.sub)}</div>` : ''}</div>
          ${supplyPills(s)}
        </div>`;
      }
      const sorted = c.items.slice().sort(supplyRowSorter(c.key));
      const total = sorted.reduce((a,s)=> a+num(s.count,0), 0);
      return `<div class="card-flat supply-item-card supply-group-card">
        <div style="display:flex;justify-content:space-between;align-items:baseline;gap:8px;"><strong>${esc(c.label)}</strong><span class="footnote">${total} total</span></div>
        ${sorted.map(s=>{ const pt = supplyRowParts(s); return `<div class="supply-sub" data-open-supply="${s.id}">
          <div><div style="font-weight:600;font-size:13px;">${esc(pt.title)}</div>${pt.sub? `<div class="footnote">${esc(pt.sub)}</div>` : ''}</div>
          ${supplyPills(s)}
        </div>`; }).join('')}
      </div>`;
    }).join('');
    return `<div class="supply-group-h">${esc(g.label)}</div><div class="supply-item-grid">${rows}</div>`;
  }).join('');
  $$('[data-open-supply]',el).forEach(card=> card.addEventListener('click', ()=> openSupplyModal(state.supplies.find(s=>s.id===card.dataset.openSupply))));
}
function openSupplyModal(existing){
  const s = existing || {};
  const catOptions = SUPPLY_CATEGORIES.map(c=>`<option value="${c.key}" ${s.category===c.key?'selected':''}>${esc(c.label)}</option>`).join('');
  const tagChecks = SUPPLY_TAGS.map(t=>{
    const checked = Array.isArray(s.tags) && s.tags.indexOf(t.key)>-1;
    return `<label style="display:flex;align-items:center;gap:6px;font-size:13px;font-weight:400;"><input type="checkbox" class="supply-tag-check" value="${t.key}" ${checked?'checked':''}> ${esc(t.label)}</label>`;
  }).join('');
  openModal(existing?'Edit supply':'Add supply', `
    <div class="form-grid">
      <div class="field span2"><label for="sCategory">Category</label><select id="sCategory">${catOptions}</select></div>
      <div class="field span2"><label for="sName">Brand / label (optional)</label><input id="sName" type="text" value="${esc(s.name||'')}" placeholder="e.g. BD Ultra-Fine, Ozempic pen"></div>
      <div class="field"><label for="sCount">Count on hand</label><input id="sCount" type="number" step="1" min="0" value="${esc(s.count!=null?s.count:'')}"></div>
      <div class="field" data-show-for="fixneedle,syringe,bacwater,aceticacid,reconsupply,skincare"><label for="sMl">Size (mL)</label><input id="sMl" type="number" step="any" min="0" value="${esc(s.ml||'')}"></div>
      <div class="field" data-show-for="fixneedle,needle,penneedle,filter"><label for="sGauge">Gauge</label><input id="sGauge" type="number" step="any" min="0" value="${esc(s.gauge||'')}" placeholder="e.g. 29"></div>
      <div class="field" data-show-for="fixneedle,needle,penneedle,filter"><label for="sNeedleLen">Needle length (in)</label><input id="sNeedleLen" type="number" step="any" min="0" value="${esc(s.needleLen||'')}" placeholder="e.g. 0.5"></div>
      <div class="field" data-show-for="syringe"><label for="sLuer">Luer type</label><select id="sLuer"><option value="">—</option><option value="slip" ${s.luerType==='slip'?'selected':''}>Luer-slip</option><option value="lock" ${s.luerType==='lock'?'selected':''}>Luer-lock</option></select></div>
      <div class="field" data-show-for="pen"><label for="sPenType">Pen type</label><select id="sPenType"><option value="">—</option><option value="automatic" ${s.penType==='automatic'?'selected':''}>Automatic</option><option value="manual" ${s.penType==='manual'?'selected':''}>Manual</option></select></div>
      <div class="field span2"><label for="sLow">Low-stock warning at (optional, default 5)</label><input id="sLow" type="number" step="1" min="0" value="${esc(s.lowThreshold!=null?s.lowThreshold:'')}"></div>
      <div class="field span2">
        <label>Tag for</label>
        <div style="display:flex;gap:14px;flex-wrap:wrap;margin-top:4px;">${tagChecks}</div>
      </div>
    </div>
    <div class="form-actions">
      ${existing? `<button class="btn btn-danger" id="sDelete" style="margin-right:auto;">Delete</button>` : ''}
      <button class="btn" id="sCancel">Cancel</button><button class="btn btn-accent-pep" id="sSave">Save</button>
    </div>
  `, body=>{
    function applyVisibility(){
      const cat = $('#sCategory',body).value;
      $$('[data-show-for]',body).forEach(w=>{ w.hidden = w.dataset.showFor.split(',').indexOf(cat)===-1; });
    }
    $('#sCategory',body).addEventListener('change', applyVisibility);
    applyVisibility();
    if(existing){
      $('#sDelete',body).addEventListener('click', ()=>{ closeModal(); confirmAction('Delete this supply? Any protocol usage rules referencing it will stop counting toward depletion.', ()=> dbDelete('supplies', existing.id)); });
    }
    $('#sCancel',body).addEventListener('click', closeModal);
    $('#sSave',body).addEventListener('click', async ()=>{
      const category = $('#sCategory',body).value;
      const tags = $$('.supply-tag-check',body).filter(c=>c.checked).map(c=>c.value);
      const data = {
        category, name: $('#sName',body).value.trim(),
        count: $('#sCount',body).value || 0,
        ml: $('#sMl',body).value, gauge: $('#sGauge',body).value, needleLen: $('#sNeedleLen',body).value,
        luerType: $('#sLuer',body).value || null, penType: $('#sPenType',body).value || null,
        lowThreshold: $('#sLow',body).value || null,
        tags,
      };
      if(existing) await dbSet('supplies', existing.id, data); else await dbAdd('supplies', data);
      closeModal();
    });
  });
}
$('#addSupplyBtn').addEventListener('click', ()=> openSupplyModal(null));

function renderProtocolSupplyList(){
  const el = $('#protocolSupplyList');
  if(!el) return;
  const active = state.protocols.filter(p=>p.status!=='archived').slice().sort((a,b)=> num(a.sortOrder,999)-num(b.sortOrder,999));
  if(!active.length){
    el.innerHTML = `<div class="empty" style="padding:14px 8px;"><p>Add a protocol first, then come back here to assign its supplies.</p></div>`;
    return;
  }
  if(!state.supplies.length){
    el.innerHTML = `<div class="empty" style="padding:14px 8px;"><p>Add some supplies above first, then assign them here.</p></div>`;
    return;
  }
  el.innerHTML = active.map(p=>{
    const rules = Array.isArray(p.supplyUsage) ? p.supplyUsage : [];
    const rows = rules.map((r,i)=>{
      const s = state.supplies.find(x=>x.id===r.supplyId);
      const dpw = (dosesPerWeekFor(p)||0) * splitCount(p);
      const rate = (dpw && r.perDoses) ? ((dpw/num(r.perDoses,1))*num(r.qty,1)) : null;
      return `<div class="supply-rule-row">
        <span class="srr-main">${s ? supplyLabel(s) : '<em>(deleted supply)</em>'}</span>
        <span class="footnote">${num(r.qty,1)}× every ${num(r.perDoses,1)} dose${num(r.perDoses,1)===1?'':'s'}${rate!=null? ` · ~${rate.toFixed(1)}/wk`:''}</span>
        <button class="icon-btn" data-del-rule="${p.id}" data-rule-idx="${i}">✕</button>
      </div>`;
    }).join('');
    return `<div class="card-flat" style="margin-bottom:10px;">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap;">
        <strong>${esc(p.compound||'Untitled compound')}</strong>
        <select class="supply-method-select" data-protocol-method="${p.id}" style="width:auto;">
          <option value="">Method: not set</option>
          <option value="syringe" ${p.supplyMethod==='syringe'?'selected':''}>Method: Syringe</option>
          <option value="pen" ${p.supplyMethod==='pen'?'selected':''}>Method: Pen</option>
        </select>
      </div>
      <div style="margin-top:8px;">${rows || '<p class="footnote" style="margin:4px 0;">No supplies assigned yet.</p>'}</div>
      <button class="btn btn-sm" style="margin-top:8px;" data-add-rule="${p.id}">+ Add supply rule</button>
    </div>`;
  }).join('');
  $$('[data-protocol-method]',el).forEach(sel=> sel.addEventListener('change', async ()=>{
    const p = state.protocols.find(x=>x.id===sel.dataset.protocolMethod);
    if(p) await dbSet('protocols', p.id, {...stripId(p), supplyMethod: sel.value||null});
  }));
  $$('[data-del-rule]',el).forEach(b=> b.addEventListener('click', async ()=>{
    const p = state.protocols.find(x=>x.id===b.dataset.delRule);
    if(!p) return;
    const rules = (Array.isArray(p.supplyUsage)?p.supplyUsage:[]).slice();
    rules.splice(num(b.dataset.ruleIdx,0),1);
    await dbSet('protocols', p.id, {...stripId(p), supplyUsage: rules});
  }));
  $$('[data-add-rule]',el).forEach(b=> b.addEventListener('click', ()=> openSupplyRuleModal(state.protocols.find(p=>p.id===b.dataset.addRule))));
}
function openSupplyRuleModal(protocol){
  if(!protocol) return;
  const grouped = SUPPLY_GROUPS.map(g=>{
    const items = state.supplies.filter(s=> supplyCatGroup(s)===g.key);
    if(!items.length) return '';
    return `<optgroup label="${esc(g.label)}">${items.map(s=>`<option value="${s.id}">${supplyLabel(s)}</option>`).join('')}</optgroup>`;
  }).join('');
  openModal(`Add supply rule — ${esc(protocol.compound||'protocol')}`, `
    <div class="form-grid">
      <div class="field span2"><label for="ruSupply">Supply</label><select id="ruSupply">${grouped}</select></div>
      <div class="field"><label for="ruQty">Qty used per event</label><input id="ruQty" type="number" step="any" min="0" value="1"></div>
      <div class="field"><label for="ruPerDoses">Every N doses</label><input id="ruPerDoses" type="number" step="1" min="1" value="1"></div>
      <div class="field span2"><p class="footnote" style="margin:0;">Use 1 for something consumed every dose (a needle, an alcohol pad). Use the doses-per-vial count for a reconstitution item like bac water — e.g. 10 if a vial lasts 10 doses.</p></div>
    </div>
    <div class="form-actions"><button class="btn" id="ruCancel">Cancel</button><button class="btn btn-accent-pep" id="ruSave">Save</button></div>
  `, body=>{
    $('#ruCancel',body).addEventListener('click', closeModal);
    $('#ruSave',body).addEventListener('click', async ()=>{
      const supplyId = $('#ruSupply',body).value;
      if(!supplyId) return;
      const rules = (Array.isArray(protocol.supplyUsage)?protocol.supplyUsage:[]).slice();
      rules.push({supplyId, qty:num($('#ruQty',body).value,1), perDoses:num($('#ruPerDoses',body).value,1)});
      await dbSet('protocols', protocol.id, {...stripId(protocol), supplyUsage: rules});
      closeModal();
    });
  });
}
function renderSupplyDepletion(){
  const el = $('#supplyDepletion');
  if(!el) return;
  const linked = state.supplies.map(s=>({s, weekly: supplyWeeklyUsage(s.id), days: supplyDaysRemaining(s)})).filter(x=>x.weekly>0);
  const lowNoData = state.supplies.filter(s=> !linked.some(x=>x.s.id===s.id) && num(s.count,0)<=num(s.lowThreshold,5));
  if(!linked.length && !lowNoData.length){
    el.innerHTML = `<div class="empty" style="padding:14px 8px;"><p>Assign supplies to a protocol above to see depletion estimates here.</p></div>`;
    return;
  }
  linked.sort((a,b)=> (a.days==null?9e9:a.days) - (b.days==null?9e9:b.days));
  const rows = linked.map(x=>{
    const low = x.days!=null && x.days<=14;
    return `<div class="supply-rule-row">
      <span class="srr-main">${supplyLabel(x.s)}</span>
      <span class="footnote">${num(x.s.count,0)} on hand · ~${x.weekly.toFixed(1)}/wk</span>
      <span class="pill ${low?'pill-warn':'pill-good'}">${x.days<=0?'Out':x.days+'d left'}</span>
    </div>`;
  }).join('');
  const lowRows = lowNoData.map(s=> `<div class="supply-rule-row">
    <span class="srr-main">${supplyLabel(s)}</span>
    <span class="pill pill-warn">${num(s.count,0)} on hand</span>
  </div>`).join('');
  el.innerHTML = rows + (lowNoData.length? `<div class="supply-group-h">Low stock (not yet linked to a protocol)</div>${lowRows}` : '');
}

/* ===================== Peptides: Cost tracking ===================== */
function renderCostTracking(){
  const el = $('#costSummary');
  const priced = state.vials.filter(v=> num(v.price,0)>0);
  if(!priced.length){
    el.innerHTML = `<div class="empty" style="padding:14px 8px;"><p>No prices logged yet. Add a price when you log a vial to see spend here.</p></div>`;
    return;
  }
  const total = priced.reduce((s,v)=> s+num(v.price,0), 0);
  const byVendor = {};
  priced.forEach(v=>{ const k=v.pharmacy||'Unspecified'; byVendor[k]=(byVendor[k]||0)+num(v.price,0); });
  const byCompound = {};
  priced.forEach(v=>{ const k=v.compound||'Unspecified'; byCompound[k]=(byCompound[k]||0)+num(v.price,0); });
  const rows = (obj)=> Object.entries(obj).sort((a,b)=>b[1]-a[1]).map(([k,v])=>
    `<div class="cost-row"><span>${esc(k)}</span><strong class="mono">$${v.toFixed(2)}</strong></div>`).join('');
  // Rough monthly burn: for each active protocol with a linked (or name-matched) priced vial, estimate cost/day from that vial's cost-per-mg × dose × frequency.
  let monthly = 0;
  state.protocols.filter(isActiveP).forEach(p=>{
    const vial = priced.find(v=> v.protocolId===p.id) || priced.find(v=> (v.compound||'').toLowerCase()===(p.compound||'').toLowerCase());
    if(!vial) return;
    const used = Array.isArray(vial.finishedLog) ? vial.finishedLog.length : 0;
    const mgTotal = num(vial.mgPerVial,0)*(num(vial.qty,1) + (vial.remainingMg!=null ? 1 : 0) + used);   // opening a vial moves one out of the sealed count; finished ones were paid for too
    if(!mgTotal) return;
    const costPerMg = num(vial.price,0)/mgTotal;
    const dNow = doseAt(p, todayISO());
    const doseMg = doseToMg(dNow.dose, dNow.doseUnit) || 0;
    const freq = effectiveFreqDays(p) || 0;
    if(freq>0) monthly += costPerMg*doseMg*(30/freq);
  });
  el.innerHTML = `
    <div class="cost-total"><span>Total logged spend</span><strong class="mono">$${total.toFixed(2)}</strong></div>
    ${monthly>0? `<div class="cost-total" style="margin-top:2px;"><span>Est. monthly burn (active protocols)</span><strong class="mono">$${monthly.toFixed(2)}</strong></div>`:''}
    <div class="cost-cols">
      <div><div class="cost-col-h">By vendor</div>${rows(byVendor)}</div>
      <div><div class="cost-col-h">By compound</div>${rows(byCompound)}</div>
    </div>`;
}

/* ===================== Peptides: per-protocol injection site + daily satisfaction note ===================== */
// Each protocol stores its own `siteLog` ([{date, site}], oldest first) and `moodLog` ([{date, score 1-5, note}]).
// Sites are changed in the protocol's edit modal; the card just shows the latest site and a suggested next one.
// Front view shows the person facing you (their right is on your left); back view shows them from behind.
const INJECTION_SITES = [
  {name:'Abdomen upper – R', view:'front', cx:64,  cy:100, rx:9,  ry:11},
  {name:'Abdomen upper – L', view:'front', cx:86,  cy:100, rx:9,  ry:11},
  {name:'Abdomen lower – R', view:'front', cx:64,  cy:128, rx:9,  ry:11},
  {name:'Abdomen lower – L', view:'front', cx:86,  cy:128, rx:9,  ry:11},
  {name:'Thigh – R',         view:'front', cx:61,  cy:205, rx:9,  ry:24},
  {name:'Thigh – L',         view:'front', cx:89,  cy:205, rx:9,  ry:24},
  {name:'Upper arm – L',     view:'back',  cx:186, cy:88,  rx:7,  ry:17},
  {name:'Upper arm – R',     view:'back',  cx:264, cy:88,  rx:7,  ry:17},
  {name:'Flank – L',         view:'back',  cx:205, cy:126, rx:6,  ry:13},
  {name:'Flank – R',         view:'back',  cx:245, cy:126, rx:6,  ry:13},
  {name:'Glute – L',         view:'back',  cx:212, cy:162, rx:12, ry:12},
  {name:'Glute – R',         view:'back',  cx:238, cy:162, rx:12, ry:12},
];
const SITE_NAMES = INJECTION_SITES.map(s=>s.name);
function siteLogOf(p){ return Array.isArray(p && p.siteLog) ? p.siteLog.filter(e=>e && e.site) : []; }
function lastSiteOf(p){
  const log = siteLogOf(p).slice().sort((a,b)=> (a.date||'').localeCompare(b.date||''));
  return log.length ? log[log.length-1] : null;
}
function siteLastUsed(p){
  const lastUsed = {};
  siteLogOf(p).forEach(e=>{ if(!lastUsed[e.site] || e.date>lastUsed[e.site]) lastUsed[e.site]=e.date; });
  return lastUsed;
}
// Suggest the site this protocol has gone longest without (never-used sites come first, in map order).
function suggestNextSite(p){
  const lastUsed = siteLastUsed(p);
  return SITE_NAMES.slice().sort((a,b)=> (lastUsed[a]||'').localeCompare(lastUsed[b]||''))[0];
}
function bodyMapSVG(p, selected){
  const lastUsed = siteLastUsed(p);
  const last = lastSiteOf(p);
  const next = suggestNextSite(p);
  const figure = cx => `
    <circle cx="${cx}" cy="26" r="15" class="bm-body"/>
    <rect x="${cx-6}" y="39" width="12" height="10" class="bm-body"/>
    <rect x="${cx-27}" y="46" width="54" height="114" rx="16" class="bm-body"/>
    <rect x="${cx-47}" y="50" width="16" height="102" rx="8" class="bm-body"/>
    <rect x="${cx+31}" y="50" width="16" height="102" rx="8" class="bm-body"/>
    <rect x="${cx-25}" y="150" width="23" height="150" rx="10" class="bm-body"/>
    <rect x="${cx+2}" y="150" width="23" height="150" rx="10" class="bm-body"/>`;
  const zones = INJECTION_SITES.map(s=>{
    const used = lastUsed[s.name];
    const cls = ['bm-zone'];
    if(used) cls.push('used');
    if(last && last.site===s.name) cls.push('last');
    if(s.name===next) cls.push('next');
    if(s.name===selected) cls.push('sel');
    const ago = used ? daysBetween(used, todayISO()) : null;
    const title = `${s.name}: ${used ? (ago===0?'used today':`last used ${ago} day${ago===1?'':'s'} ago`) : 'not used yet'}${s.name===next?' (suggested next)':''}`;
    return `<ellipse cx="${s.cx}" cy="${s.cy}" rx="${s.rx}" ry="${s.ry}" class="${cls.join(' ')}" data-site="${esc(s.name)}" tabindex="0" role="button" aria-pressed="${s.name===selected}" aria-label="${esc(title)}"><title>${esc(title)}</title></ellipse>`;
  }).join('');
  return `<svg viewBox="0 0 300 330" role="group" aria-label="Injection site map">
    ${figure(75)}${figure(225)}
    <text x="75" y="322" class="bm-label">FRONT</text><text x="225" y="322" class="bm-label">BACK</text>
    <text x="22" y="40" class="bm-side">R</text><text x="128" y="40" class="bm-side">L</text>
    <text x="172" y="40" class="bm-side">L</text><text x="278" y="40" class="bm-side">R</text>
    ${zones}
  </svg>
  <div class="bm-legend"><span><i class="k-sel"></i>Selected</span><span><i class="k-last"></i>Last used</span><span><i class="k-next"></i>Suggested next</span><span><i class="k-used"></i>Used before</span></div>`;
}
function siteRowHTML(p){
  const last = lastSiteOf(p);
  const next = suggestNextSite(p);
  return `<div class="site-row">
    <span class="site-row-label">📍 Last site</span>
    ${last ? `<span class="site-pill current">${esc(last.site)} · ${fmtDateShort(last.date)}</span>` : `<span class="footnote">none logged</span>`}
    <span class="site-row-next">next → <strong>${esc(next)}</strong></span>
  </div>`;
}

const MOOD_FACES = [
  {score:1, face:'😞', label:'Poor'},
  {score:2, face:'🙁', label:'Meh'},
  {score:3, face:'😐', label:'Neutral'},
  {score:4, face:'🙂', label:'Good'},
  {score:5, face:'😄', label:'Great'},
];
function moodLogOf(p){ return Array.isArray(p && p.moodLog) ? p.moodLog.filter(e=>e && e.date) : []; }
function moodFace(score){ const m = MOOD_FACES.find(f=>f.score===score); return m ? m.face : ''; }
function moodBlockHTML(p){
  const log = moodLogOf(p);
  const today = todayISO();
  const cur = log.find(e=>e.date===today) || null;
  const days = [];
  for(let i=6;i>=0;i--){
    const d = new Date(); d.setDate(d.getDate()-i);
    const iso = d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');
    const e = log.find(x=>x.date===iso);
    days.push(`<span class="mood-day ${iso===today?'today':''}" title="${fmtDateShort(iso)}${e&&e.note?' · '+esc(e.note):''}">${e&&e.score? moodFace(e.score) : '·'}</span>`);
  }
  return `<div class="protocol-mood">
    <div class="mood-head"><span class="mood-title">How's it going today?</span><span class="mood-week" title="Last 7 days">${days.join('')}</span></div>
    <div class="mood-faces">
      ${MOOD_FACES.map(f=>`<button type="button" class="mood-btn ${cur&&cur.score===f.score?'on':''}" data-mood="${f.score}" data-mood-pid="${p.id}" title="${f.label}" aria-label="${f.label}" aria-pressed="${cur&&cur.score===f.score?'true':'false'}">${f.face}</button>`).join('')}
    </div>
    <input class="mood-note" type="text" maxlength="140" data-mood-note="${p.id}" placeholder="Quick note (optional)" value="${esc(cur&&cur.note||'')}">
  </div>`;
}
function moodLogHTML(p){
  const log = moodLogOf(p).slice().sort((a,b)=> b.date.localeCompare(a.date)).slice(0,8);
  if(!log.length) return `<span class="footnote">No daily notes yet. Use the faces on the protocol card.</span>`;
  return log.map(e=>`<div class="mood-log-row"><span>${moodFace(e.score)||'·'}</span><span class="footnote">${fmtDateShort(e.date)}</span><span style="min-width:0;overflow-wrap:anywhere;">${esc(e.note||'')}</span></div>`).join('');
}
async function saveDailyNote(p, patch){
  if(!p) return;
  const today = todayISO();
  const log = moodLogOf(p).filter(e=>e.date!==today);
  const prev = moodLogOf(p).find(e=>e.date===today) || {};
  const next = {date:today, score: ('score' in patch) ? patch.score : (prev.score||null), note: ('note' in patch) ? patch.note : (prev.note||'')};
  if(next.score || next.note) log.push(next);
  log.sort((a,b)=> a.date.localeCompare(b.date));
  await dbSet('protocols', p.id, {...stripId(p), moodLog: log.slice(-90)});
}
function bindProtocolExtras(el){
  $$('[data-mood]',el).forEach(b=> b.addEventListener('click', e=>{
    e.stopPropagation();
    const p = state.protocols.find(x=>x.id===b.dataset.moodPid);
    const score = parseInt(b.dataset.mood,10);
    const cur = moodLogOf(p).find(x=>x.date===todayISO());
    saveDailyNote(p, {score: cur && cur.score===score ? null : score});   // tap again to clear
  }));
  $$('[data-mood-note]',el).forEach(inp=>{
    inp.addEventListener('click', e=> e.stopPropagation());
    inp.addEventListener('keydown', e=>{ e.stopPropagation(); if(e.key==='Enter') inp.blur(); });
    inp.addEventListener('change', ()=> saveDailyNote(state.protocols.find(x=>x.id===inp.dataset.moodNote), {note: inp.value.trim()}));
  });
}


/* ===================== Peptides: Vendors ===================== */
function renderVendors(){
  const el = $('#vendorList');
  if(!el) return;
  if(!state.vendors.length){
    el.innerHTML = `<div class="empty" style="padding:14px 8px;"><p>No vendors logged yet.</p></div>`;
    return;
  }
  const sortedVendors = state.vendors.slice().sort((a,b)=> (a.name||'').localeCompare(b.name||'', undefined, {sensitivity:'base'}));
  el.innerHTML = sortedVendors.map(v=>`
    <div class="card-flat" style="margin-bottom:8px;">
      <div style="display:flex;justify-content:space-between;gap:8px;align-items:flex-start;">
        <div style="min-width:0;flex:1;">
          <div style="overflow-wrap:anywhere;">
            <strong>${v.url? `<a href="${esc(v.url)}" target="_blank" rel="noopener" style="color:var(--info);">${esc(v.name)}</a>` : esc(v.name)}</strong>
          </div>
          ${v.subtext? `<div class="footnote" style="margin-top:2px;">${esc(v.subtext)}</div>`:''}
          ${v.deal? `<div style="margin-top:4px;"><span class="pill pill-good">${esc(v.deal)}</span></div>`:''}
          ${v.notes? `<div class="footnote" style="margin-top:4px;overflow-wrap:anywhere;">${esc(v.notes)}</div>`:''}
        </div>
        <div class="card-actions" style="flex:none;">
          <button class="icon-btn" data-edit-vendor="${v.id}" title="Edit">✎</button>
          <button class="icon-btn" data-del-vendor="${v.id}" title="Delete">✕</button>
        </div>
      </div>
    </div>`).join('');
  $$('[data-edit-vendor]',el).forEach(b=> b.addEventListener('click', ()=> openVendorModal(state.vendors.find(v=>v.id===b.dataset.editVendor))));
  $$('[data-del-vendor]',el).forEach(b=> b.addEventListener('click', ()=> confirmAction('Delete this vendor?', ()=> dbDelete('vendors', b.dataset.delVendor))));
}

function openVendorModal(existing){
  const v = existing || {};
  openModal(existing && existing.id ? 'Edit vendor' : 'Add vendor', `
    <div class="form-grid">
      <div class="field span2"><label for="vdName">Name</label><input id="vdName" type="text" value="${esc(v.name||'')}"></div>
      <div class="field span2"><label for="vdSub">Subtext</label><input id="vdSub" type="text" value="${esc(v.subtext||'')}" placeholder="e.g. rep name, contact method"></div>
      <div class="field span2"><label for="vdUrl">Homepage URL</label><input id="vdUrl" type="url" value="${esc(v.url||'')}" placeholder="https://…"></div>
      <div class="field span2"><label for="vdDeal">Current deal / code</label><input id="vdDeal" type="text" value="${esc(v.deal||'')}"></div>
      <div class="field span2"><label for="vdNotes">Your notes / experience</label><textarea id="vdNotes" rows="3">${esc(v.notes||'')}</textarea></div>
    </div>
    <div class="form-actions"><button class="btn" id="vdCancel">Cancel</button><button class="btn btn-accent-pep" id="vdSave">Save</button></div>
  `, body=>{
    $('#vdCancel',body).addEventListener('click', closeModal);
    $('#vdSave',body).addEventListener('click', async ()=>{
      const name = $('#vdName',body).value.trim();
      if(!name) return;
      const data = {name, subtext:$('#vdSub',body).value.trim(), url:$('#vdUrl',body).value.trim(), deal:$('#vdDeal',body).value.trim(), notes:$('#vdNotes',body).value.trim()};
      if(existing && existing.id) await dbSet('vendors', existing.id, data); else await dbAdd('vendors', data);
      closeModal();
    });
  });
}
$('#addVendorBtn').addEventListener('click', ()=> openVendorModal(null));

/* ===================== Peptides: Supply vendors ===================== */
// Filter categories: each carried item is mapped to one or more standard categories by keyword,
// so the dropdown stays tidy even though vendors word their lists differently.
const VENDOR_CATEGORY_RULES = [
  {cat:'Pens & cartridges',                re:/adapter|replacement holders|gansulin/i, stop:true},
  {cat:'Storage & organization',           re:/case|box|storage|stashbook|stackable|vanisher|armorguard|holders?\b|hydra|insert|label|\bcaps?\b|applicator|sticker/i, stop:true},
  {cat:'Pens & cartridges',                re:/\bpens?\b(?! needle)|cartridge|wrap/i},
  {cat:'Recon supplies',                   re:/filter/i, stop:true},
  {cat:'Syringes, needles, & pen needles', re:/syringe|needle/i},
  {cat:'Sharps containers',                re:/sharps/i},
  {cat:'BAC water & solutions',            re:/bac water|bacteriostatic|sterile water|lidocaine|bicarbonate|glycerin|acetic/i},
  {cat:'Recon supplies',                   re:/recon|filter|alcohol|vial|spike/i},
];
const VENDOR_CANON = ['BAC water & solutions','Recon supplies','Syringes, needles, & pen needles','Sharps containers','Pens & cartridges','Storage & organization'];
function vendorCategories(v){
  const out = new Set();
  (Array.isArray(v.carries)?v.carries:[]).forEach(item=>{
    if(VENDOR_CANON.includes(item)){ out.add(item); return; }
    let hit = false;
    for(const r of VENDOR_CATEGORY_RULES){
      if(r.re.test(item)){ out.add(r.cat); hit = true; if(r.stop) break; }
    }
    if(!hit) out.add('Other');
  });
  return out;
}
let vendorFilter = new Set();
let vendorFilterOpen = false;
document.addEventListener('click', e=>{
  if(vendorFilterOpen && !e.target.closest('.vf-wrap')){ vendorFilterOpen = false; renderSupplyVendors(); }
});
function telegramLine(handle){
  const hdl = String(handle||'').trim();
  if(!hdl) return '';
  const user = hdl.replace(/^@/,'').replace(/^https?:\/\/t\.me\//,'');
  const label = hdl.startsWith('http') ? '@'+user : (hdl.startsWith('@')? hdl : '@'+hdl);
  return `<div class="vt-tg"><a href="https://t.me/${esc(user)}" target="_blank" rel="noopener" onclick="event.stopPropagation()">✈ ${esc(label)}</a></div>`;
}
function telegramGroupLine(url){
  const u = String(url||'').trim();
  if(!/^https?:\/\//.test(u)) return '';
  return `<div class="vt-tg"><a href="${esc(u)}" target="_blank" rel="noopener" onclick="event.stopPropagation()">✈ Telegram group</a></div>`;
}
function renderSupplyVendors(){
  const el = $('#supplyVendorList');
  if(!el) return;
  if(!state.supplyVendors.length){
    el.innerHTML = `<div class="empty" style="padding:14px 8px;"><p>No supply vendors logged yet.</p></div>`;
    return;
  }
  const all = state.supplyVendors.slice().sort((a,b)=> (a.name||'').localeCompare(b.name||''));
  const cats = new Map(all.map(v=>[v.id, vendorCategories(v)]));
  const counts = new Map();
  cats.forEach(s=> s.forEach(c=> counts.set(c,(counts.get(c)||0)+1)));
  // Drop any selected filter that no longer exists in the data.
  vendorFilter = new Set([...vendorFilter].filter(c=>counts.has(c)));
  const options = [...counts.keys()].sort((a,b)=> a==='Other'?1 : b==='Other'?-1 : a.localeCompare(b));
  const sel = [...vendorFilter];
  const sorted = sel.length ? all.filter(v=> sel.every(c=> cats.get(v.id).has(c))) : all;
  const btnLabel = sel.length ? `Filter: ${sel.length} selected` : 'Filter by supply';
  const filterBar = `<div class="vf-bar">
    <div class="vf-wrap">
      <button type="button" class="btn btn-sm vf-btn ${sel.length?'active':''}" id="vfToggle" aria-haspopup="true" aria-expanded="${vendorFilterOpen}">${btnLabel} ▾</button>
      ${vendorFilterOpen? `<div class="vf-panel" role="group" aria-label="Filter vendors by supply">
        ${options.map(c=>`<label class="vf-opt"><input type="checkbox" data-vf="${esc(c)}" ${vendorFilter.has(c)?'checked':''}><span>${esc(c)}</span><span class="vf-count">${counts.get(c)}</span></label>`).join('')}
      </div>` : ''}
    </div>
    ${sel.length? `<button type="button" class="icon-btn" id="vfClear">Clear</button>` : ''}
    <span class="footnote vf-summary">${sel.length? `${sorted.length} of ${all.length} vendors carry all selected` : `${all.length} vendors`}</span>
  </div>`;
  const rows = sorted.length ? sorted.map(v=>{
      const items = Array.isArray(v.carries) ? v.carries.filter(Boolean) : [];
      return `<tr data-open-supply-vendor="${v.id}" title="Tap to edit">
        <td class="vt-name">${v.url? `<a href="${esc(v.url)}" target="_blank" rel="noopener" onclick="event.stopPropagation()">${esc(v.name)}</a>` : esc(v.name)}${telegramLine(v.telegram)}${telegramGroupLine(v.telegramGroup)}${v.note? `<div class="footnote">${esc(v.note)}</div>`:''}</td>
        <td>${items.length? `<div class="vt-chips">${items.map(i=>`<span class="vt-chip">${esc(i)}</span>`).join('')}</div>` : `<span class="footnote">—</span>`}</td>
      </tr>`;
    }).join('') : `<tr><td colspan="2"><div class="empty" style="padding:14px 4px;"><p>No vendor carries all of those. Try removing a filter.</p></div></td></tr>`;
  el.innerHTML = `${filterBar}<div class="vendor-table-wrap"><table class="vendor-table">
    <thead><tr><th>Vendor</th><th>Supplies carried</th></tr></thead>
    <tbody>${rows}</tbody></table></div>`;
  $('#vfToggle',el).addEventListener('click', e=>{ e.stopPropagation(); vendorFilterOpen = !vendorFilterOpen; renderSupplyVendors(); });
  const clr = $('#vfClear',el); if(clr) clr.addEventListener('click', ()=>{ vendorFilter = new Set(); renderSupplyVendors(); });
  $$('[data-vf]',el).forEach(cb=> cb.addEventListener('change', ()=>{
    if(cb.checked) vendorFilter.add(cb.dataset.vf); else vendorFilter.delete(cb.dataset.vf);
    renderSupplyVendors();
  }));
  $$('[data-open-supply-vendor]',el).forEach(row=> row.addEventListener('click', ()=> openSupplyVendorModal(state.supplyVendors.find(v=>v.id===row.dataset.openSupplyVendor))));
}
function openSupplyVendorModal(existing){
  const v = existing || {};
  openModal(existing?'Edit supply vendor':'Add supply vendor', `
    <div class="form-grid">
      <div class="field span2"><label for="svName">Name</label><input id="svName" type="text" value="${esc(v.name||'')}"></div>
      <div class="field span2"><label for="svUrl">Homepage URL</label><input id="svUrl" type="url" value="${esc(v.url||'')}" placeholder="https://…"></div>
      <div class="field span2"><label for="svTelegram">Telegram handle (optional)</label><input id="svTelegram" type="text" value="${esc(v.telegram||'')}" placeholder="@handle"></div>
      <div class="field span2"><label for="svGroup">Telegram group link (optional)</label><input id="svGroup" type="url" value="${esc(v.telegramGroup||'')}" placeholder="https://t.me/+…"></div>
      <div class="field span2"><label>Supplies carried</label><div id="svCarries" style="display:grid;gap:6px;margin-top:4px;">${VENDOR_CANON.map(c=>`<label style="display:flex;gap:8px;align-items:center;font-weight:400;"><input type="checkbox" value="${esc(c)}" ${(v.carries||[]).includes(c)?'checked':''}> ${esc(c)}</label>`).join('')}</div></div>
      <div class="field span2"><label for="svNote">Note (optional)</label><input id="svNote" type="text" value="${esc(v.note||'')}" placeholder="e.g. Ships internationally"></div>
    </div>
    <div class="form-actions">
      ${existing? `<button class="btn btn-danger" id="svDelete" style="margin-right:auto;">Delete</button>` : ''}
      <button class="btn" id="svCancel">Cancel</button><button class="btn btn-accent-pep" id="svSave">Save</button>
    </div>
  `, body=>{
    if(existing){
      $('#svDelete',body).addEventListener('click', ()=>{ closeModal(); confirmAction('Delete this supply vendor?', ()=> dbDelete('supplyVendors', existing.id)); });
    }
    $('#svCancel',body).addEventListener('click', closeModal);
    $('#svSave',body).addEventListener('click', async ()=>{
      const name = $('#svName',body).value.trim();
      if(!name) return;
      const carries = $$('#svCarries input:checked',body).map(i=>i.value);
      const data = {...stripId(v), name, url:$('#svUrl',body).value.trim(), telegram:$('#svTelegram',body).value.trim(), telegramGroup:$('#svGroup',body).value.trim(), carries, note:$('#svNote',body).value.trim()};
      if(existing) await dbSet('supplyVendors', existing.id, data); else await dbAdd('supplyVendors', data);
      closeModal();
    });
  });
}
$('#addSupplyVendorBtn').addEventListener('click', ()=> openSupplyVendorModal(null));

/* ===================== Peptides: Equipment ===================== */
function renderPepEquipment(){
  const el = $('#pepEquipmentList');
  if(!el) return;
  if(!state.pepEquipment.length){
    el.innerHTML = `<div class="empty" style="padding:14px 8px;"><p>No equipment logged yet.</p></div>`;
    return;
  }
  const sorted = state.pepEquipment.slice().sort((a,b)=> (a.name||'').localeCompare(b.name||''));
  el.innerHTML = `<div class="supply-item-grid">${sorted.map(e=>`
    <div class="card-flat supply-item-card" data-open-pep-equipment="${e.id}" style="cursor:pointer;">
      <div>
        <strong>${esc(e.name)}</strong>
        ${e.details? `<div class="footnote" style="margin-top:2px;">${esc(e.details)}</div>` : ''}
      </div>
      ${num(e.count,1)>1? `<div style="margin-top:6px;"><span class="pill pill-muted">×${num(e.count,1)}</span></div>` : ''}
    </div>`).join('')}</div>`;
  $$('[data-open-pep-equipment]',el).forEach(card=> card.addEventListener('click', ()=> openPepEquipmentModal(state.pepEquipment.find(e=>e.id===card.dataset.openPepEquipment))));
}
function openPepEquipmentModal(existing){
  const e = existing || {};
  openModal(existing?'Edit equipment':'Add equipment', `
    <div class="form-grid">
      <div class="field span2"><label for="peName">Name</label><input id="peName" type="text" value="${esc(e.name||'')}" placeholder="e.g. Motorized Vial Roller Mixer"></div>
      <div class="field span2"><label for="peDetails">Subtitle (optional)</label><input id="peDetails" type="text" value="${esc(e.details||'')}" placeholder="e.g. USB-C, 72mm vials"></div>
      <div class="field"><label for="peCount">Count</label><input id="peCount" type="number" step="1" min="0" value="${esc(e.count!=null?e.count:1)}"></div>
    </div>
    <div class="form-actions">
      ${existing? `<button class="btn btn-danger" id="peDelete" style="margin-right:auto;">Delete</button>` : ''}
      <button class="btn" id="peCancel">Cancel</button><button class="btn btn-accent-pep" id="peSave">Save</button>
    </div>
  `, body=>{
    if(existing){
      $('#peDelete',body).addEventListener('click', ()=>{ closeModal(); confirmAction('Delete this equipment item?', ()=> dbDelete('pepEquipment', existing.id)); });
    }
    $('#peCancel',body).addEventListener('click', closeModal);
    $('#peSave',body).addEventListener('click', async ()=>{
      const name = $('#peName',body).value.trim();
      if(!name) return;
      const data = {name, details:$('#peDetails',body).value.trim(), count:$('#peCount',body).value||1};
      if(existing) await dbSet('pepEquipment', existing.id, data); else await dbAdd('pepEquipment', data);
      closeModal();
    });
  });
}

/* ===================== Peptides: Research ===================== */
/* Small, safe-enough markdown -> HTML for LLM answers: headings, bold/italic, inline code, links, pipe tables,
   bullet and numbered lists, quotes, rules, code blocks, paragraphs.
   Escapes everything first, then re-introduces only the handful of tags it builds itself. */
function mdToHtml(md){
  const lines = (md||'').replace(/\r\n/g,'\n').split('\n');
  let html = '', i = 0, list = null;
  const inline = (s)=> esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/__(.+?)__/g, '<strong>$1</strong>')
    .replace(/(^|[^*\w])\*(?!\s)([^*]+?)\*(?!\w)/g, '$1<em>$2</em>')
    .replace(/(^|[^_\w])_(?!\s)([^_]+?)_(?!\w)/g, '$1<em>$2</em>')
    .replace(/~~(.+?)~~/g, '<s>$1</s>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  function closeList(){ if(list){ html += `</${list}>`; list=null; } }
  function openList(tag){ if(list!==tag){ closeList(); html += `<${tag}>`; list=tag; } }
  while(i<lines.length){
    const line = lines[i];
    if(/^\s*```/.test(line)){
      closeList();
      let j = i+1, code = [];
      while(j<lines.length && !/^\s*```/.test(lines[j])){ code.push(lines[j]); j++; }
      html += `<pre><code>${esc(code.join('\n'))}</code></pre>`;
      i = j+1; continue;
    }
    if(/^\s*\|.*\|/.test(line) && lines[i+1] && /^\s*\|?\s*:?-{2,}[\s:|-]*$/.test(lines[i+1])){
      closeList();
      const cells = (row)=> row.trim().replace(/^\|/,'').replace(/\|$/,'').split('|').map(c=>c.trim());
      const header = cells(line);
      let body = [];
      let j = i+2;
      while(j<lines.length && /^\s*\|.*\|/.test(lines[j])){
        const r = cells(lines[j]);
        while(r.length < header.length) r.push('');
        body.push(r.slice(0, header.length));
        j++;
      }
      // A phone can't fit wide or wordy tables, so those become one card per row with each column labelled.
      const longest = Math.max(0, ...body.flat().map(c=>c.length));
      if(header.length > 3 || longest > 32){
        html += `<div class="md-cards">${body.map(r=>`<div class="md-card"><div class="md-card-h">${inline(r[0]) || '&nbsp;'}</div>${
          r.slice(1).map((c,k)=> c ? `<div class="md-card-row"><span>${inline(header[k+1])}</span><div>${inline(c)}</div></div>` : '').join('')}</div>`).join('')}</div>`;
      } else {
        html += `<div class="md-table"><table><thead><tr>${header.map(h=>`<th>${inline(h)}</th>`).join('')}</tr></thead><tbody>${
          body.map(r=>`<tr>${r.map(c=>`<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
      }
      i = j; continue;
    }
    const h = line.match(/^\s*(#{1,6})\s+(.*?)\s*#*\s*$/);
    if(h){
      closeList();
      const lvl = Math.min(6, h[1].length + 2); // # -> h3, ## -> h4, ### and deeper -> h5/h6
      html += `<h${lvl} class="md-h">${inline(h[2])}</h${lvl}>`;
      i++; continue;
    }
    if(/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)){ closeList(); html += '<hr>'; i++; continue; }
    if(/^\s*[-*+]\s+/.test(line)){
      openList('ul');
      const sub = /^\s{2,}/.test(line) ? ' class="md-sub"' : '';
      html += `<li${sub}>${inline(line.replace(/^\s*[-*+]\s+/,''))}</li>`;
      i++; continue;
    }
    if(/^\s*\d+[.)]\s+/.test(line)){
      openList('ol');
      html += `<li>${inline(line.replace(/^\s*\d+[.)]\s+/,''))}</li>`;
      i++; continue;
    }
    if(/^\s*>/.test(line)){
      closeList();
      html += `<blockquote>${inline(line.replace(/^\s*>\s?/,''))}</blockquote>`;
      i++; continue;
    }
    closeList();
    if(line.trim()) html += `<p>${inline(line)}</p>`;
    i++;
  }
  closeList();
  return html || `<p>${inline(md||'')}</p>`;
}
/* Text blocks split only by citations join directly; text after a web search (or a block that opens with a heading)
   starts a new paragraph, so a heading never gets glued onto the sentence before it. */
function chatText(m){
  let out = '', gap = false;
  for(const b of (m.content||[])){
    if(!b) continue;
    if(b.type==='text'){
      const t = b.text||'';
      // Citations split text mid-sentence and mid-table-row, so only a heading or code fence forces a new line here.
      const block = /^\s*(#{1,6}\s|```)/.test(t);
      out += ((gap || block) && out && !/\n\s*$/.test(out) ? '\n\n' : '') + t;
      gap = false;
    }
    else if(b.type!=='thinking' && b.type!=='redacted_thinking') gap = true;
  }
  return out;
}
function renderResearch(){
  const el = $('#researchList'); if(!el) return;
  if(!state.research.length){
    el.innerHTML = `<div class="empty"><div class="glyph">💬</div><p>Your conversations with Claude will be saved here.</p></div>`;
    return;
  }
  const list = state.research.slice().sort((a,b)=> String(b.updatedAt||b.createdAt||'').localeCompare(String(a.updatedAt||a.createdAt||'')));
  el.innerHTML = list.map(r=>{
    const isChat = Array.isArray(r.messages);
    const turns = isChat ? r.messages.filter(m=>m.role==='user').length : 0;
    return `<div class="research-item ${isChat?'chat-item':''}" ${isChat?`data-open-chat="${r.id}"`:''}>
      <div style="display:flex;justify-content:space-between;gap:8px;">
        <div style="min-width:0;">
          <h4>${esc(r.topic||'Untitled')}</h4>
          <div class="meta">${fmtDate(r.createdAt||todayISO())}${isChat ? ` · ${turns} question${turns===1?'':'s'}${r.costUsd ? ` · ≈ $${r.costUsd.toFixed(2)}` : ''}` : ' · pasted answer'}</div>
        </div>
        <button class="icon-btn" data-del-research="${r.id}" aria-label="Delete">✕</button>
      </div>
      ${isChat ? `<div class="research-body research-md" style="max-height:4.6em;overflow:hidden;">${mdToHtml(r.answer||'')}</div><button type="button" class="btn btn-sm ask-open">Continue chat ›</button>` : `<div class="research-body research-md">${mdToHtml(r.answer||r.notes||'')}</div>`}
    </div>`;
  }).join('');
  $$('[data-del-research]',el).forEach(b=> b.addEventListener('click', e=>{ e.stopPropagation(); confirmAction('Delete this conversation?', ()=>{ if(askConv && askConv.id===b.dataset.delResearch) askConv = null; return dbDelete('research', b.dataset.delResearch); }); }));
  $$('[data-open-chat]',el).forEach(c=> c.addEventListener('click', ()=>{
    const r = state.research.find(x=>x.id===c.dataset.openChat); if(!r) return;
    askConv = JSON.parse(JSON.stringify(r));
    renderAsk(); window.scrollTo({top:0, behavior:'smooth'});
  }));
}
/* ===================== Charts (shared by Progress and Labs) ===================== */
function niceTicks(min, max, count){
  if(min===max){ const pad = Math.abs(min)*0.05 || 1; min -= pad; max += pad; }
  const span = max-min;
  const raw = span/Math.max(1,count);
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1,2,2.5,5,10].map(m=>m*mag).find(s=> s>=raw) || raw;
  const lo = Math.floor(min/step)*step, hi = Math.ceil(max/step)*step;
  const ticks = [];
  for(let v=lo; v<=hi+step/2; v+=step) ticks.push(Math.round(v*1e6)/1e6);
  return {lo, hi, ticks};
}
/* series: [{name, color, points:[{x:'YYYY-MM-DD', y:number}]}]. from/to are ISO dates. */
function lineChartSVG(opts){
  const W = Math.round(Math.max(300, Math.min(720, opts.width || 640))), H = opts.height || 210, padL = 44, padR = 16, padT = 16, padB = 28;
  const from = opts.from, to = opts.to;
  const spanDays = Math.max(1, daysBetween(from, to));
  const pts = opts.series.flatMap(s=> s.points);
  let yMin, yMax, ticks;
  if(opts.yFixed){ yMin = opts.yFixed[0]; yMax = opts.yFixed[1]; ticks = opts.yTicks; }
  else {
    const ys = pts.map(p=>p.y).concat(opts.bands ? opts.bands.flatMap(b=>[b.lo,b.hi]).filter(v=>v!=null && isFinite(v)) : []);
    const t = niceTicks(Math.min(...ys), Math.max(...ys), 4);
    yMin = t.lo; yMax = t.hi; ticks = t.ticks;
  }
  const X = iso => padL + (W-padL-padR) * (daysBetween(from, iso)/spanDays);
  const Y = v => padT + (H-padT-padB) * (1 - (v-yMin)/((yMax-yMin)||1));
  const fmtY = opts.fmtY || (v=> String(Math.round(v*100)/100));
  let g = '';
  (opts.bands||[]).forEach(b=>{
    const lo = b.lo!=null && isFinite(b.lo) ? b.lo : yMin, hi = b.hi!=null && isFinite(b.hi) ? b.hi : yMax;
    g += `<rect x="${padL}" y="${Y(Math.min(hi,yMax)).toFixed(1)}" width="${W-padL-padR}" height="${Math.max(0, Y(Math.max(lo,yMin))-Y(Math.min(hi,yMax))).toFixed(1)}" class="ch-band"/>`;
  });
  ticks.forEach(t=>{
    const y = Y(t).toFixed(1);
    g += `<line x1="${padL}" x2="${W-padR}" y1="${y}" y2="${y}" class="ch-grid"/><text x="${padL-8}" y="${(+y+4).toFixed(1)}" class="ch-ylab">${esc(fmtY(t))}</text>`;
  });
  const mid = addDays(from, Math.round(spanDays/2));
  (W < 420 && spanDays < 3 ? [[from,'start'],[to,'end']] : [[from,'start'],[mid,'middle'],[to,'end']]).forEach(([iso,anchor])=>{
    g += `<text x="${X(iso).toFixed(1)}" y="${H-8}" class="ch-xlab" text-anchor="${anchor}">${esc(fmtDateShort(iso))}</text>`;
  });
  (opts.markers||[]).filter(m=> m.x>=from && m.x<=to).forEach((m,i)=>{
    const x = X(m.x).toFixed(1);
    g += `<line x1="${x}" x2="${x}" y1="${padT}" y2="${H-padB}" class="ch-marker" style="stroke:${m.color}"/>`;
    g += `<text x="${(+x+4).toFixed(1)}" y="${padT+10+(i%3)*12}" class="ch-mlab" style="fill:${m.color}">${esc(m.label)}</text>`;
  });
  opts.series.forEach(s=>{
    const sp = s.points.filter(p=> p.x>=from && p.x<=to).sort((a,b)=> a.x.localeCompare(b.x));
    if(!sp.length) return;
    if(sp.length>1) g += `<polyline points="${sp.map(p=>`${X(p.x).toFixed(1)},${Y(p.y).toFixed(1)}`).join(' ')}" class="ch-line" style="stroke:${s.color}"/>`;
    const showDots = sp.length <= 45;
    sp.forEach((p,i)=>{
      const last = i===sp.length-1;
      if(!showDots && !last) return;
      g += `<circle cx="${X(p.x).toFixed(1)}" cy="${Y(p.y).toFixed(1)}" r="${last?4.5:2.6}" style="fill:${p.flag?'var(--warn)':s.color}" class="${last?'ch-last':''}"><title>${esc(fmtDateShort(p.x))}: ${esc(fmtY(p.y))}${s.unit?' '+esc(s.unit):''}</title></circle>`;
    });
    if(opts.labelLast!==false){
      const lp = sp[sp.length-1];
      const lx = X(lp.x), anchor = lx > W-80 ? 'end' : 'start';
      g += `<text x="${(lx + (anchor==='end'?-8:8)).toFixed(1)}" y="${(Y(lp.y)-8).toFixed(1)}" class="ch-lastlab" text-anchor="${anchor}" style="fill:${s.color}">${esc(fmtY(lp.y))}</text>`;
    }
  });
  // remember the geometry so a finger drag can read values back (see attachLineScrub)
  const id = 'lc' + (++lineChartSeq);
  LINE_CHARTS.set(id, {W, H, padL, padR, padT, padB, from, to, spanDays, X, Y, fmtY,
    series: opts.series.map(s=>({name:s.name, color:s.color, unit:s.unit||'', points:s.points.filter(p=> p.x>=from && p.x<=to).sort((a,b)=> a.x.localeCompare(b.x))}))});
  return `<div class="lc-readout" data-lc-out="${id}">Touch and drag across the chart to read values</div><div class="lc-wrap" data-lc="${id}"><svg viewBox="0 0 ${W} ${H}" class="chart" role="img" aria-label="${esc(opts.label||'Chart')}. Touch and drag to read values.">${g}</svg></div>`;
}
const LINE_CHARTS = new Map();
let lineChartSeq = 0;
/* Drag across a date chart: snaps to the nearest logged day and shows each series' value there. */
function attachLineScrub(root){
  $$('[data-lc]', root).forEach(wrap=>{
    const c = LINE_CHARTS.get(wrap.dataset.lc); if(!c) return;
    const svg = $('svg', wrap);
    const cross = document.createElement('div'); cross.className = 'scrub-line'; cross.hidden = true;
    const out = root.querySelector(`[data-lc-out="${wrap.dataset.lc}"]`);
    const idle = out ? out.innerHTML : '';
    wrap.append(cross);
    let dots = [];
    const days = [...new Set(c.series.flatMap(s=> s.points.map(p=>p.x)))].sort();
    const hide = ()=>{ cross.hidden = true; dots.forEach(d=>d.remove()); dots = []; if(out){ out.innerHTML = idle; out.classList.remove('on'); } };
    const show = clientX=>{
      if(!days.length) return;
      const r = svg.getBoundingClientRect(), k = r.width / c.W;
      const xv = (clientX - r.left)/k;
      let best = days[0], bd = Infinity;
      days.forEach(d=>{ const dd = Math.abs(c.X(d) - xv); if(dd < bd){ bd = dd; best = d; } });
      const x = c.X(best);
      cross.hidden = false; cross.style.left = (x/c.W*100)+'%';
      cross.style.top = (c.padT/c.H*100)+'%'; cross.style.height = ((c.H-c.padT-c.padB)/c.H*100)+'%';
      dots.forEach(d=>d.remove()); dots = [];
      const rows = c.series.map(s=>{
        const i = s.points.findIndex(p=> p.x===best); if(i<0) return '';
        const p = s.points[i], prev = s.points[i-1];
        const d = document.createElement('i'); d.className = 'scrub-dot';
        d.style.left = (x/c.W*100)+'%'; d.style.top = (c.Y(p.y)/c.H*100)+'%'; d.style.background = s.color;
        wrap.appendChild(d); dots.push(d);
        const ch = prev ? Math.round((p.y - prev.y)*10)/10 : null;
        return `<span class="lc-val"><i style="background:${s.color}"></i>${c.series.length>1?esc(s.name)+' ':''}<b class="mono">${esc(c.fmtY(p.y))}${s.unit?' '+esc(s.unit):''}</b>${ch!=null && ch!==0 ? ` <em>${ch>0?'+':''}${ch}</em>` : ''}</span>`;
      }).join('');
      if(out){
        out.innerHTML = `<span class="lc-date">${esc(new Date(best+'T00:00:00').toLocaleDateString(undefined,{weekday:'short', month:'short', day:'numeric'}))}</span>${rows}`;
        out.classList.add('on');
      }
    };
    bindScrub(wrap, show, ()=> hide());
  });
}

/* ===================== Progress: daily check-ins ===================== */
function weightUnit(){ return 'lb'; }   // weight is tracked in pounds only; older kg entries are converted for display
function toUnit(w, from, to){ const n = num(w,null); if(n==null) return null; if(from===to) return n; return to==='kg' ? n*0.45359237 : n/0.45359237; }
function checkinFor(iso){ return state.checkins.find(c=>c.date===iso) || null; }
function loadCheckinForm(iso){
  const c = checkinFor(iso);
  $('#ciDate').value = iso;
  const wu = weightUnit();
  const w = c ? toUnit(c.weight, c.weightUnit||wu, wu) : null;
  $('#ciWeight').value = w!=null ? Math.round(w*10)/10 : '';
  $('#ciStatus').textContent = '';
  $('#ciDelete').hidden = !c;
  const today = todayISO();
  $('#ciDateLbl').textContent = iso===today ? 'Today' : iso===addDays(today,-1) ? 'Yesterday'
    : new Date(iso+'T12:00').toLocaleDateString(undefined, {weekday:'short', month:'short', day:'numeric'});
  $('#ciNext').disabled = iso >= today;
  $('#ciSave').textContent = c ? 'Update weight' : 'Save weight';
  updateCheckinDelta();
}
/* Change vs the most recent earlier entry, using whatever is typed in the box right now. */
function updateCheckinDelta(){
  const iso = $('#ciDate').value, el = $('#ciDelta');
  const wu = weightUnit();
  const prev = state.checkins.filter(c=> c.date < iso && c.weight!=null && c.weight!=='')
    .sort((a,b)=> b.date.localeCompare(a.date))[0];
  const cur = parseFloat($('#ciWeight').value);
  if(!prev){ el.textContent = ''; return; }
  const pw = Math.round(toUnit(prev.weight, prev.weightUnit||wu, wu)*10)/10;
  if(!(cur>0)){ el.innerHTML = `Last: <b>${esc(String(pw))} ${wu}</b> on ${esc(fmtDateShort(prev.date))}`; return; }
  const d = Math.round((cur - pw)*10)/10;
  el.innerHTML = d===0 ? `Same as ${esc(fmtDateShort(prev.date))}`
    : `<b class="${d<0?'down':'up'}">${d<0?'▼':'▲'} ${Math.abs(d)} ${wu}</b> since ${esc(fmtDateShort(prev.date))}`;
}
/* Card titles (plus any filter chips right under them) sit above their card, like the serum chart. Moving the
   nodes keeps their ids and listeners, so the render code that fills them is unaffected. */
function liftCardHeads(){
  $$('main .view .card').forEach(card=>{
    if(card.closest('.serum-block, .card-block, #askChat') || card.matches('#askSetup, details')) return;
    const head = card.firstElementChild;
    if(!head) return;
    const isTitle = head.classList.contains('card-h') || head.tagName==='H3'
      || (head.tagName==='DIV' && head.children.length<=3 && head.querySelector(':scope > h3'));
    if(!isTitle) return;
    if(head.tagName==='DIV'){ head.removeAttribute('style'); head.classList.add('card-h'); }
    else if(head.tagName==='H3') head.removeAttribute('style');
    const block = document.createElement('section'); block.className = 'card-block';
    const bh = document.createElement('div'); bh.className = 'card-block-head';
    card.before(block);
    bh.appendChild(head);
    const next = card.firstElementChild;
    if(next && next.classList.contains('chip-row')) bh.appendChild(next);
    block.append(bh, card);
  });
}
function initCheckinForm(){
  const maxISO = todayISO();
  $('#ciDate').max = maxISO;
  loadCheckinForm(maxISO);
  $('#ciDate').addEventListener('change', ()=>{ const v = $('#ciDate').value; if(v) loadCheckinForm(v > maxISO ? maxISO : v); });
  $('#ciPrev').addEventListener('click', ()=> loadCheckinForm(addDays($('#ciDate').value || maxISO, -1)));
  $('#ciNext').addEventListener('click', ()=>{ const v = addDays($('#ciDate').value || maxISO, 1); loadCheckinForm(v > maxISO ? maxISO : v); });
  $('#ciWeight').addEventListener('input', updateCheckinDelta);
  $('#ciWeight').addEventListener('keydown', e=>{ if(e.key==='Enter'){ e.preventDefault(); $('#ciSave').click(); } });
  $('#ciSave').addEventListener('click', async ()=>{
    const date = $('#ciDate').value || todayISO();
    const weight = $('#ciWeight').value.trim();
    if(!weight){ $('#ciStatus').textContent = 'Enter a weight first.'; $('#ciWeight').focus(); return; }
    const existing = checkinFor(date);
    // keep any mood, energy or note an older entry already has
    const data = {...(existing ? stripId(existing) : {}), date, weight: num(weight), weightUnit: 'lb'};
    if(existing) await dbSet('checkins', existing.id, data); else await dbAdd('checkins', data);
    $('#ciStatus').textContent = `✓ Saved for ${fmtDateShort(date)}`;
    $('#ciDelete').hidden = false;
    $('#ciSave').textContent = 'Update weight';
    $('#ciWeight').blur();
    updateCheckinDelta();
  });
  $('#ciDelete').addEventListener('click', ()=>{
    const c = checkinFor($('#ciDate').value); if(!c) return;
    confirmAction(`Delete the weight for ${fmtDateShort(c.date)}?`, async ()=>{ await dbDelete('checkins', c.id); loadCheckinForm(c.date); });
  });
}

let trendRange = lsGet('ledger.trendRange','1M');
const TREND_RANGES = [['2W',14],['1M',30],['3M',91],['6M',182],['1Y',365],['All',null],['Custom',-1]];
function trendWindow(){
  const to = todayISO();
  if(trendRange==='Custom'){
    const f = $('#trendFrom').value, t = $('#trendTo').value;
    if(f && t && f<=t) return {from:f, to:t};
    return {from: addDays(to,-29), to};
  }
  const r = TREND_RANGES.find(x=>x[0]===trendRange) || TREND_RANGES[1];
  if(r[1]==null){
    const dates = state.checkins.map(c=>c.date).concat(state.labs.map(l=>l.drawDate)).filter(Boolean).sort();
    return {from: dates.length ? (dates[0] < to ? dates[0] : addDays(to,-29)) : addDays(to,-29), to};
  }
  return {from: addDays(to, -(r[1]-1)), to};
}
function protocolMarkers(){
  if(!$('#trendMarkers') || !$('#trendMarkers').checked) return [];
  const cm = protocolColorMap();
  const out = [];
  state.protocols.forEach((p,i)=>{
    const color = cm.get(p.id) || PROTOCOL_COLORS[i % PROTOCOL_COLORS.length];
    if(p.startDate) out.push({x:p.startDate, label:`${p.compound||'Protocol'} start`, color});
    titrationSteps(p).forEach(s=> out.push({x:s.start, label:`${p.compound||''} → ${fmtDose(s.dose, s.doseUnit||p.doseUnit)}`, color}));
    if(p.endedDate) out.push({x:p.endedDate, label:`${p.compound||'Protocol'} end`, color});
  });
  return out;
}
function renderTrendControls(){
  const el = $('#trendRange'); if(!el) return;
  el.innerHTML = TREND_RANGES.map(r=>`<button type="button" class="chip-btn ${trendRange===r[0]?'on':''}" data-range="${r[0]}">${r[0]}</button>`).join('');
  $('#trendCustom').hidden = trendRange!=='Custom';
}
function renderProgress(){
  renderTrendControls();
  const el = $('#trendCharts'); if(!el) return;
  LINE_CHARTS.clear();
  const {from, to} = trendWindow();
  const wu = weightUnit();
  const cw = el.clientWidth || Math.min(640, window.innerWidth - 64);
  const inRange = state.checkins.filter(c=> c.date>=from && c.date<=to).sort((a,b)=> a.date.localeCompare(b.date));
  const wPts = inRange.filter(c=> num(c.weight,null)!=null).map(c=>({x:c.date, y: Math.round(toUnit(c.weight, c.weightUnit||wu, wu)*10)/10}));
  const markers = protocolMarkers();
  let html = '';
  // Weight
  html += `<div class="trend-block"><div class="trend-head"><h4>Weight</h4>`;
  if(wPts.length){
    const delta = wPts.length>1 ? Math.round((wPts[wPts.length-1].y - wPts[0].y)*10)/10 : null;
    html += `<div class="trend-stats"><span><strong class="mono">${wPts[wPts.length-1].y} ${wu}</strong> latest</span>${delta!=null?`<span class="pill ${delta<0?'pill-good':delta>0?'pill-pep':'pill-muted'}">${delta>0?'+':''}${delta} ${wu} in range</span>`:''}</div></div>`;
    html += lineChartSVG({series:[{name:'Weight', color:'var(--accent-pep)', points:wPts, unit:wu}], from, to, markers, width:cw, label:`Weight from ${fmtDateShort(from)} to ${fmtDateShort(to)}`, fmtY: v=> String(Math.round(v*10)/10)});
  } else html += `</div><div class="empty" style="padding:14px 8px;"><p>No weights logged in this range.</p></div>`;
  html += `</div>`;
  el.innerHTML = html;
  attachLineScrub(el);
  $('#trendRangeLabel').textContent = `${fmtDate(from)} to ${fmtDate(to)}`;
  renderPhotos();
}

/* ===================== Progress: photos ===================== */
const PHOTO_ANGLES = ['Front','Side','Back','Other'];
let photoFilter = 'All';
let photoSelect = new Set();
let photoSelectMode = false;
function loadImage(file){
  return new Promise((resolve,reject)=>{
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = ()=>{ resolve({img, url}); };
    img.onerror = ()=>{ URL.revokeObjectURL(url); reject(new Error('That file could not be read as an image.')); };
    img.src = url;
  });
}
function resizeToBlob(img, maxSide, quality){
  const scale = Math.min(1, maxSide/Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.max(1, Math.round(img.naturalWidth*scale)), h = Math.max(1, Math.round(img.naturalHeight*scale));
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  c.getContext('2d').drawImage(img, 0, 0, w, h);
  return new Promise(res=> c.toBlob(b=> res({blob:b, w, h}), 'image/jpeg', quality));
}
function openPhotoModal(){
  if(storageMode!=='idb'){ openModal('Photos unavailable', `<p class="footnote">This browser isn't letting the app use its photo storage (IndexedDB). Private browsing can cause this. Open the installed app normally to add photos.</p><div class="form-actions"><button class="btn" id="phX">OK</button></div>`, b=> $('#phX',b).addEventListener('click', closeModal)); return; }
  openModal('Add progress photo', `
    <div class="form-grid">
      <div class="field span2"><label for="phFile">Photo</label><input id="phFile" type="file" accept="image/*">
        <button type="button" class="btn btn-sm" id="phCam" style="margin-top:8px;align-self:flex-start;">📷 Take photo with guide</button>
        <div class="footnote" style="margin-top:4px;">Shows your last photo at this angle as a faded overlay so you can match your pose.</div></div>
      <div class="field span2"><div id="phPreview" class="ph-preview" hidden></div></div>
      <div class="field"><label for="phDate">Date</label><input id="phDate" type="date" value="${todayISO()}" max="${todayISO()}"></div>
      <div class="field"><label for="phAngle">Angle</label><select id="phAngle">${PHOTO_ANGLES.map(a=>`<option>${a}</option>`).join('')}</select></div>
      <div class="field span2"><label for="phNote">Note (optional)</label><input id="phNote" type="text" maxlength="140" placeholder="e.g. week 6, morning, fasted"></div>
    </div>
    <p class="footnote" style="margin-top:10px;">Photos are shrunk to about 1600 px and saved only on this device. They are included in backups.</p>
    <div class="form-actions"><button class="btn" id="phCancel">Cancel</button><button class="btn btn-accent-pep" id="phSave" disabled>Save photo</button></div>
    <div class="footnote" id="phStatus" style="margin-top:8px;"></div>
  `, body=>{
    let loaded = null;
    const useFile = async f=>{
      if(loaded){ URL.revokeObjectURL(loaded.url); loaded = null; }
      $('#phSave',body).disabled = true;
      if(!f) return;
      try{
        loaded = await loadImage(f);
        const pv = $('#phPreview',body); pv.hidden = false; pv.innerHTML = `<img src="${loaded.url}" alt="Selected photo preview">`;
        $('#phSave',body).disabled = false;
        $('#phStatus',body).textContent = '';
      }catch(e){ $('#phStatus',body).textContent = e.message; }
    };
    $('#phCam',body).addEventListener('click', ()=> openGhostCamera($('#phAngle',body).value, (blob, angle)=>{
      $('#phAngle',body).value = angle;
      useFile(new File([blob], 'progress.jpg', {type:'image/jpeg'}));
    }));
    $('#phFile',body).addEventListener('change', async ()=>{
      const f = $('#phFile',body).files[0];
      if(loaded){ URL.revokeObjectURL(loaded.url); loaded = null; }
      $('#phSave',body).disabled = true;
      if(!f) return;
      try{
        loaded = await loadImage(f);
        const pv = $('#phPreview',body); pv.hidden = false; pv.innerHTML = `<img src="${loaded.url}" alt="Selected photo preview">`;
        $('#phSave',body).disabled = false;
        $('#phStatus',body).textContent = '';
      }catch(e){ $('#phStatus',body).textContent = e.message; }
    });
    $('#phCancel',body).addEventListener('click', ()=>{ if(loaded) URL.revokeObjectURL(loaded.url); closeModal(); });
    $('#phSave',body).addEventListener('click', async ()=>{
      if(!loaded) return;
      $('#phSave',body).disabled = true; $('#phStatus',body).textContent = 'Saving…';
      try{
        const full = await resizeToBlob(loaded.img, 1600, 0.85);
        const thumb = await resizeToBlob(loaded.img, 420, 0.8);
        const id = uid();
        await putBlob(id, full.blob);
        await putBlob(id+'_t', thumb.blob);
        URL.revokeObjectURL(loaded.url);
        await dbSet('photos', id, {date: $('#phDate',body).value || todayISO(), angle: $('#phAngle',body).value, note: $('#phNote',body).value.trim(), w: full.w, h: full.h});
        closeModal();
      }catch(e){
        $('#phSave',body).disabled = false;
        $('#phStatus',body).textContent = (e && e.name==='QuotaExceededError') ? 'Storage is full. Delete some older photos first.' : 'Couldn\'t save that photo. Try again.';
      }
    });
  });
}
function renderPhotos(){
  const grid = $('#photoGrid'); if(!grid) return;
  const filters = ['All'].concat(PHOTO_ANGLES);
  $('#photoFilter').innerHTML = filters.map(f=>`<button type="button" class="chip-btn ${photoFilter===f?'on':''}" data-photo-filter="${f}">${f}</button>`).join('');
  const list = state.photos.filter(p=> photoFilter==='All' || p.angle===photoFilter).sort((a,b)=> b.date.localeCompare(a.date));
  photoSelect = new Set([...photoSelect].filter(id=> state.photos.some(p=>p.id===id)));
  $('#photoSelectBtn').textContent = photoSelectMode ? 'Cancel' : 'Compare two';
  $('#photoCompareBtn').hidden = !photoSelectMode;
  $('#photoCompareBtn').disabled = photoSelect.size!==2;
  $('#photoSelectHint').hidden = !photoSelectMode;
  if(!list.length){
    grid.innerHTML = `<div class="empty" style="grid-column:1/-1;padding:14px 8px;"><div class="glyph">📷</div><p>${state.photos.length ? 'No photos at this angle.' : 'No progress photos yet. Same angle, light and time of day makes them easier to compare.'}</p></div>`;
    return;
  }
  grid.innerHTML = list.map(p=>`
    <button type="button" class="ph-tile ${photoSelect.has(p.id)?'sel':''}" data-photo="${p.id}" aria-label="${esc(p.angle)} photo, ${fmtDateShort(p.date)}">
      <img data-photo-thumb="${p.id}" alt="">
      <span class="ph-cap"><span>${fmtDateShort(p.date)}</span><span>${esc(p.angle)}</span></span>
      ${photoSelectMode ? `<span class="ph-check">${photoSelect.has(p.id)?'✓':''}</span>` : ''}
    </button>`).join('');
  $$('[data-photo-thumb]',grid).forEach(async img=>{
    const u = await blobUrl(img.dataset.photoThumb+'_t') || await blobUrl(img.dataset.photoThumb);
    if(u) img.src = u; else img.closest('.ph-tile').classList.add('missing');
  });
}
function initPhotos(){
  $('#addPhotoBtn').addEventListener('click', openPhotoModal);
  $('#photoFilter').addEventListener('click', e=>{ const b = e.target.closest('[data-photo-filter]'); if(!b) return; photoFilter = b.dataset.photoFilter; renderPhotos(); });
  $('#photoSelectBtn').addEventListener('click', ()=>{ photoSelectMode = !photoSelectMode; photoSelect.clear(); renderPhotos(); });
  $('#photoCompareBtn').addEventListener('click', ()=>{ if(photoSelect.size===2) openCompareModal([...photoSelect]); });
  $('#photoGrid').addEventListener('click', e=>{
    const t = e.target.closest('[data-photo]'); if(!t) return;
    const id = t.dataset.photo;
    if(photoSelectMode){
      if(photoSelect.has(id)) photoSelect.delete(id);
      else { if(photoSelect.size>=2) photoSelect.delete([...photoSelect][0]); photoSelect.add(id); }
      renderPhotos();
    } else openPhotoViewer(id);
  });
}
async function openPhotoViewer(id){
  const p = state.photos.find(x=>x.id===id); if(!p) return;
  const u = await blobUrl(id);
  openModal(`${p.angle} · ${fmtDate(p.date)}`, `
    <div class="ph-full">${u?`<img src="${u}" alt="${esc(p.angle)} progress photo from ${fmtDate(p.date)}">`:'<p class="footnote">Image file missing.</p>'}</div>
    ${p.note?`<p style="margin-top:10px;font-size:14px;">${esc(p.note)}</p>`:''}
    <div class="form-actions wrap"><button class="btn btn-danger" id="phDel" style="margin-right:auto;">Delete</button><button class="btn" id="phPts">📍 ${p.landmarks ? 'Redo' : 'Set'} alignment points</button><button class="btn btn-accent-pep" id="phClose">Close</button></div>
  `, body=>{
    $('#phClose',body).addEventListener('click', closeModal);
    $('#phPts',body).addEventListener('click', ()=>{ closeModal(); openPointPicker(p.id, ()=> openPhotoViewer(p.id)); });
    $('#phDel',body).addEventListener('click', ()=>{
      closeModal();
      confirmAction('Delete this photo from this device?', async ()=>{
        [id, id+'_t'].forEach(k=>{ const u2 = blobUrlCache.get(k); if(u2){ URL.revokeObjectURL(u2); blobUrlCache.delete(k); } });
        try{ await delBlob(id); await delBlob(id+'_t'); }catch(e){}
        await dbDelete('photos', id);
      });
    });
  });
}
/* ===== Photo alignment =====
   Each photo can store two landmarks (photo.landmarks = {a:{x,y}, b:{x,y}}, as fractions of the image).
   Comparing two photos maps the newer photo onto the older one so those landmarks coincide, then applies an
   optional hand fine-tune stored on the newer photo: photo.alignTweaks[olderId] = {dx, dy, s, r}
   (dx/dy in widths of the older photo as shown, s = extra scale, r = extra rotation in radians). */
function landmarkNames(angle){
  if(angle==='Side') return ['top of your head', 'bottom of your belly'];
  if(angle==='Front' || angle==='Back') return ['top of the shoulder on the LEFT of the photo', 'top of the shoulder on the RIGHT of the photo'];
  return ['first reference point', 'second reference point'];
}
// keep point order stable so a and b always mean the same body part
function orderLandmarks(angle, a, b){
  if(angle==='Side') return a.y <= b.y ? {a, b} : {a:b, b:a};
  return a.x <= b.x ? {a, b} : {a:b, b:a};
}
function openOverlay(label){
  const ov = document.createElement('div');
  ov.className = 'cmp'; ov.setAttribute('role','dialog'); ov.setAttribute('aria-modal','true'); ov.setAttribute('aria-label', label);
  document.body.appendChild(ov); document.body.style.overflow = 'hidden';
  return ov;
}
function closeOverlay(ov){ ov.remove(); if(!$('.cmp')) document.body.style.overflow = ''; }
function waitImg(img){ return img.complete && img.naturalWidth ? Promise.resolve() : new Promise(r=>{ img.onload = img.onerror = ()=> r(); }); }
// contain-fit an image of size w×h into a box W×H: returns scale and offset
function fitBox(w, h, W, H){ const k = Math.min(W/w, H/h); return {k, ox:(W - w*k)/2, oy:(H - h*k)/2}; }
/* Matrix [a,b,c,d,e,f] (CSS matrix order) that draws the newer image (nw×nh) so its landmarks land on the
   older image's landmarks, with the older image contain-fitted in a box W×H. */
function alignMatrix(older, newer, ow, oh, nw, nh, W, H, tweak){
  const f0 = fitBox(ow, oh, W, H);
  let m;
  if(older.landmarks && newer.landmarks){
    const A0 = {x: f0.ox + older.landmarks.a.x*ow*f0.k, y: f0.oy + older.landmarks.a.y*oh*f0.k};
    const B0 = {x: f0.ox + older.landmarks.b.x*ow*f0.k, y: f0.oy + older.landmarks.b.y*oh*f0.k};
    const A1 = {x: newer.landmarks.a.x*nw, y: newer.landmarks.a.y*nh};
    const B1 = {x: newer.landmarks.b.x*nw, y: newer.landmarks.b.y*nh};
    const v0 = {x:B0.x-A0.x, y:B0.y-A0.y}, v1 = {x:B1.x-A1.x, y:B1.y-A1.y};
    const s = Math.hypot(v0.x,v0.y) / Math.max(1e-6, Math.hypot(v1.x,v1.y));
    const th = Math.atan2(v0.y,v0.x) - Math.atan2(v1.y,v1.x);
    const c = s*Math.cos(th), sn = s*Math.sin(th);
    m = [c, sn, -sn, c, A0.x - (c*A1.x - sn*A1.y), A0.y - (sn*A1.x + c*A1.y)];
  } else {
    const f1 = fitBox(nw, nh, W, H);
    m = [f1.k, 0, 0, f1.k, f1.ox, f1.oy];
  }
  const t = tweak || {};
  if(t.s || t.r || t.dx || t.dy){
    // extra scale/rotate about the older photo's centre, then shift
    const s2 = t.s || 1, r2 = t.r || 0, C = {x: W/2, y: H/2}, bw = ow*f0.k;
    const c = s2*Math.cos(r2), sn = s2*Math.sin(r2);
    const T = [c, sn, -sn, c, C.x - (c*C.x - sn*C.y) + (t.dx||0)*bw, C.y - (sn*C.x + c*C.y) + (t.dy||0)*bw];
    m = [T[0]*m[0]+T[2]*m[1], T[1]*m[0]+T[3]*m[1], T[0]*m[2]+T[2]*m[3], T[1]*m[2]+T[3]*m[3], T[0]*m[4]+T[2]*m[5]+T[4], T[1]*m[4]+T[3]*m[5]+T[5]];
  }
  return m;
}
function placeImg(img, m){
  img.style.width = img.naturalWidth+'px'; img.style.height = img.naturalHeight+'px';
  img.style.transform = `matrix(${m.map(v=> +v.toFixed(5)).join(',')})`;
}

/* Tap two landmarks on one photo, drag to adjust, save. */
async function openPointPicker(id, onDone){
  const p = state.photos.find(x=>x.id===id); if(!p) return;
  const u = await blobUrl(id); if(!u) return;
  const names = landmarkNames(p.angle);
  const ov = openOverlay('Set alignment points');
  let pts = p.landmarks ? [p.landmarks.a, p.landmarks.b].map(q=>({...q})) : [];
  ov.innerHTML = `<div class="cmp-top"><h3>Alignment points · ${esc(p.angle)} · ${esc(fmtDateShort(p.date))}</h3><button type="button" class="cmp-x" aria-label="Cancel">✕</button></div>
    <div class="pp-hint" id="ppHint"></div>
    <div class="cmp-stage"><div class="cmp-box pp-box" id="ppBox"><img class="cmp-abs" src="${u}" alt="Photo to mark"><i class="pp-dot" data-k="0" hidden>1</i><i class="pp-dot" data-k="1" hidden>2</i></div></div>
    <div class="cmp-ctrl"><div class="seg2"><button type="button" id="ppReset">Start over</button><button type="button" id="ppSave" class="on">Save points</button></div></div>`;
  const box = $('#ppBox',ov), img = $('img',box), dots = $$('.pp-dot',box);
  await waitImg(img);
  let fit;
  const layout = ()=>{
    const r = box.getBoundingClientRect();
    fit = fitBox(img.naturalWidth, img.naturalHeight, r.width, r.height);
    placeImg(img, [fit.k,0,0,fit.k,fit.ox,fit.oy]);
    dots.forEach((d,i)=>{
      d.hidden = !pts[i];
      if(pts[i]){ d.style.left = (fit.ox + pts[i].x*img.naturalWidth*fit.k)+'px'; d.style.top = (fit.oy + pts[i].y*img.naturalHeight*fit.k)+'px'; }
    });
    $('#ppHint',ov).innerHTML = pts.length<1 ? `Tap the <b>${esc(names[0])}</b>.` : pts.length<2 ? `Now tap the <b>${esc(names[1])}</b>.` : 'Drag a point to fine-tune it, then save.';
    $('#ppSave',ov).disabled = pts.length<2;
  };
  const toPt = (cx, cy)=>{
    const r = box.getBoundingClientRect();
    return {x: Math.max(0, Math.min(1, (cx - r.left - fit.ox)/(img.naturalWidth*fit.k))), y: Math.max(0, Math.min(1, (cy - r.top - fit.oy)/(img.naturalHeight*fit.k)))};
  };
  let drag = -1;
  box.addEventListener('pointerdown', e=>{
    e.preventDefault();
    const r = box.getBoundingClientRect();
    // grab the nearest existing point if close, otherwise place the next one
    let best = -1, bd = 36;
    pts.forEach((q,i)=>{ const x = r.left + fit.ox + q.x*img.naturalWidth*fit.k, y = r.top + fit.oy + q.y*img.naturalHeight*fit.k; const d = Math.hypot(e.clientX-x, e.clientY-y); if(d<bd){ bd = d; best = i; } });
    if(best<0 && pts.length<2){ pts.push(toPt(e.clientX, e.clientY)); best = pts.length-1; }
    drag = best;
    if(drag>=0) try{ box.setPointerCapture(e.pointerId); }catch(_){}
    layout();
  });
  box.addEventListener('pointermove', e=>{ if(drag<0) return; pts[drag] = toPt(e.clientX, e.clientY); layout(); });
  box.addEventListener('pointerup', ()=>{ drag = -1; });
  box.addEventListener('pointercancel', ()=>{ drag = -1; });
  const onResize = ()=> layout();
  window.addEventListener('resize', onResize);
  const close = ()=>{ window.removeEventListener('resize', onResize); closeOverlay(ov); };
  $('.cmp-x',ov).addEventListener('click', ()=>{ close(); if(onDone) onDone(false); });
  $('#ppReset',ov).addEventListener('click', ()=>{ pts = []; layout(); });
  $('#ppSave',ov).addEventListener('click', async ()=>{
    if(pts.length<2) return;
    const cur = state.photos.find(x=>x.id===id);
    await dbSet('photos', id, {...stripId(cur), landmarks: orderLandmarks(cur.angle, pts[0], pts[1])});
    close(); if(onDone) onDone(true);
  });
  layout();
}

/* Full-screen photo comparison: side by side, stacked (tap or slide to switch / fade), or a wipe slider.
   The newer photo is aligned to the older one using alignment points and any saved fine-tune. */
let cmpMode = lsGet('ledger.cmpMode','side');
async function openCompareModal(ids){
  const pick = ()=> ids.map(id=> state.photos.find(x=>x.id===id)).filter(Boolean).sort((a,b)=> a.date.localeCompare(b.date));
  let ps = pick();
  if(ps.length!==2) return;
  const urls = await Promise.all(ps.map(p=> blobUrl(p.id)));
  const gap = daysBetween(ps[0].date, ps[1].date);
  const cap = i=> `${i===0?'Before':'After'} · ${fmtDateShort(ps[i].date)}`;
  const ov = openOverlay('Compare photos');
  let fade = 100, wipe = 50, tuning = null;   // tuning holds the unsaved fine-tune while adjusting
  const tweakOf = ()=> tuning || ((ps[1].alignTweaks||{})[ps[0].id]) || null;
  const onKey = e=>{ if(e.key==='Escape') close(); if(cmpMode==='stack' && !tuning && (e.key==='ArrowLeft'||e.key==='ArrowRight')){ fade = fade>=50 ? 0 : 100; draw(); } };
  const onResize = ()=> layout();
  document.addEventListener('keydown', onKey); window.addEventListener('resize', onResize);
  const close = ()=>{ document.removeEventListener('keydown', onKey); window.removeEventListener('resize', onResize); closeOverlay(ov); };
  // place both photos in every box on screen
  function layout(){
    $$('.cmp-box',ov).forEach(box=>{
      const r = box.getBoundingClientRect(); if(!r.width) return;
      const i0 = $('img[data-i="0"]',box), i1 = $('img[data-i="1"]',box);
      const ow = (i0 && i0.naturalWidth) || ps[0].w || 1, oh = (i0 && i0.naturalHeight) || ps[0].h || 1;
      if(i0){ const f = fitBox(ow, oh, r.width, r.height); placeImg(i0, [f.k,0,0,f.k,f.ox,f.oy]); }
      if(i1 && i1.naturalWidth) placeImg(i1, alignMatrix(ps[0], ps[1], ow, oh, i1.naturalWidth, i1.naturalHeight, r.width, r.height, tweakOf()));
    });
  }
  async function draw(){
    const aligned = ps[0].landmarks && ps[1].landmarks;
    const tweaked = !!((ps[1].alignTweaks||{})[ps[0].id]);
    const im = (i)=> urls[i] ? `<img class="cmp-abs" data-i="${i}" src="${urls[i]}" alt="${esc(ps[i].angle)} photo from ${esc(fmtDate(ps[i].date))}">` : '';
    let stage = '', ctrl = '';
    if(tuning){
      stage = `<div class="cmp-stage"><div class="cmp-box tune" id="cmpTune">${im(0)}<div class="cmp-layer" style="opacity:.55">${im(1)}</div><div class="tune-grid"></div></div></div>`;
      ctrl = `<div class="cmp-ctrl"><div class="cmp-hint">Drag to move the newer photo. Pinch to resize, twist two fingers to rotate.</div>
        <div class="seg2"><button type="button" data-tune="reset">Reset</button><button type="button" data-tune="cancel">Cancel</button><button type="button" data-tune="save" class="on">Save</button></div></div>`;
    } else if(cmpMode==='side'){
      stage = `<div class="cmp-stage side">${[0,1].map(i=>`<figure><div class="cmp-box">${i===0 ? im(0) : im(1)}</div><figcaption>${esc(cap(i))}</figcaption></figure>`).join('')}</div>`;
    } else if(cmpMode==='stack'){
      stage = `<div class="cmp-stage"><div class="cmp-box" id="cmpStack">${im(0)}<div class="cmp-layer" style="opacity:${fade/100}">${im(1)}</div><span class="cmp-tag" style="left:8px;">${esc(fade>=50 ? cap(1) : cap(0))}</span></div></div>`;
      ctrl = `<div class="cmp-ctrl"><div class="seg2"><button type="button" data-show="0" class="${fade<50?'on':''}">Before · ${esc(fmtDateShort(ps[0].date))}</button><button type="button" data-show="1" class="${fade>=50?'on':''}">After · ${esc(fmtDateShort(ps[1].date))}</button></div>
        <input type="range" id="cmpFade" min="0" max="100" value="${fade}" aria-label="Fade between before and after">
        <div class="cmp-hint">Tap the photo to flip between them, or slide to fade one into the other.</div></div>`;
    } else {
      stage = `<div class="cmp-stage"><div class="cmp-box" id="cmpWipe">${im(0)}<div class="cmp-layer" style="clip-path:inset(0 0 0 ${wipe}%)">${im(1)}</div><div class="cmp-wipe-line" style="left:${wipe}%"></div><span class="cmp-tag" style="left:8px;">Before</span><span class="cmp-tag" style="right:8px;">After</span></div></div>`;
      ctrl = `<div class="cmp-ctrl"><div class="cmp-hint">Drag across the photo to wipe between ${esc(fmtDateShort(ps[0].date))} and ${esc(fmtDateShort(ps[1].date))}.</div></div>`;
    }
    const tools = tuning ? '' : `<div class="cmp-tools">
        <span class="cmp-status">${aligned ? '✓ Aligned by your points' : 'Not aligned yet'}${tweaked ? ' · fine-tuned' : ''}</span>
        <button type="button" data-align>📍 ${aligned ? 'Points' : 'Align'}</button>
        <button type="button" data-tune-start>✋ Fine-tune</button>
      </div>`;
    ov.innerHTML = `<div class="cmp-top"><h3>${gap} day${gap===1?'':'s'} apart · ${esc(ps[1].angle)}</h3><button type="button" class="cmp-x" aria-label="Close">✕</button></div>
      ${tuning ? '' : `<div class="cmp-modes" role="tablist">${[['side','Side by side'],['stack','Stack'],['wipe','Slider']].map(([k,l])=>`<button type="button" role="tab" aria-selected="${cmpMode===k}" class="${cmpMode===k?'on':''}" data-mode="${k}">${l}</button>`).join('')}</div>`}
      ${tools}${stage}${ctrl}`;
    $('.cmp-x',ov).addEventListener('click', close);
    $$('[data-mode]',ov).forEach(b=> b.addEventListener('click', ()=>{ cmpMode = b.dataset.mode; lsSet('ledger.cmpMode', cmpMode); draw(); }));
    const ab = $('[data-align]',ov);
    if(ab) ab.addEventListener('click', ()=> chooseAlign());
    const tb = $('[data-tune-start]',ov);
    if(tb) tb.addEventListener('click', ()=>{ tuning = {...({dx:0,dy:0,s:1,r:0}), ...(((ps[1].alignTweaks||{})[ps[0].id])||{})}; draw(); });
    await Promise.all($$('img.cmp-abs',ov).map(waitImg));
    layout();
    if(tuning) bindTune();
    if(cmpMode==='stack' && !tuning){
      const layer = $('#cmpStack .cmp-layer',ov), tag = $('#cmpStack .cmp-tag',ov), range = $('#cmpFade',ov);
      const apply = ()=>{ layer.style.opacity = fade/100; tag.textContent = fade>=50 ? cap(1) : cap(0); range.value = fade;
        $$('[data-show]',ov).forEach(b=> b.classList.toggle('on', (+b.dataset.show===1) === (fade>=50))); };
      $('#cmpStack',ov).addEventListener('click', ()=>{ fade = fade>=50 ? 0 : 100; apply(); });
      $$('[data-show]',ov).forEach(b=> b.addEventListener('click', ()=>{ fade = +b.dataset.show ? 100 : 0; apply(); }));
      range.addEventListener('input', ()=>{ fade = +range.value; apply(); });
    }
    if(cmpMode==='wipe' && !tuning){
      const box = $('#cmpWipe',ov), layer = $('#cmpWipe .cmp-layer',ov), line = $('.cmp-wipe-line',ov);
      bindScrub(box, x=>{
        const r = box.getBoundingClientRect();
        wipe = Math.max(0, Math.min(100, (x - r.left)/r.width*100));
        layer.style.clipPath = `inset(0 0 0 ${wipe}%)`; line.style.left = wipe+'%';
      }, ()=>{});
    }
  }
  // pick which photo's points to set (walks through any that are missing)
  function chooseAlign(){
    const missing = ps.filter(p=> !p.landmarks);
    const refresh = ()=>{ ps = pick(); draw(); };
    if(missing.length){
      const next = ()=>{ const m = ps.filter(p=> !p.landmarks)[0]; if(m) openPointPicker(m.id, ok=>{ ps = pick(); if(ok) next(); else draw(); }); else refresh(); };
      next(); return;
    }
    const sheet = document.createElement('div'); sheet.className = 'cmp-sheet';
    sheet.innerHTML = `<div class="cmp-sheet-in"><strong>Redo alignment points for…</strong>
      ${ps.map((p,i)=>`<button type="button" data-redo="${p.id}">${i===0?'Before':'After'} · ${esc(fmtDateShort(p.date))}</button>`).join('')}
      <button type="button" data-redo="">Cancel</button></div>`;
    ov.appendChild(sheet);
    $$('[data-redo]',sheet).forEach(b=> b.addEventListener('click', ()=>{ sheet.remove(); if(b.dataset.redo) openPointPicker(b.dataset.redo, ()=> refresh()); }));
  }
  // one finger moves, two fingers pinch/rotate; mouse drag moves, wheel resizes (shift+wheel rotates)
  function bindTune(){
    const box = $('#cmpTune',ov);
    const bw = ()=>{ const r = box.getBoundingClientRect(), i0 = $('img[data-i="0"]',box); return fitBox(i0.naturalWidth, i0.naturalHeight, r.width, r.height).k * i0.naturalWidth; };
    let g = null;
    const pts = e=> [...e.touches].map(t=>({x:t.clientX, y:t.clientY}));
    box.addEventListener('touchstart', e=>{ e.preventDefault(); g = {p: pts(e), t: {...tuning}}; }, {passive:false});
    box.addEventListener('touchmove', e=>{
      e.preventDefault(); if(!g) return;
      const p = pts(e), w = bw();
      if(p.length===1 && g.p.length===1){
        tuning.dx = g.t.dx + (p[0].x-g.p[0].x)/w; tuning.dy = g.t.dy + (p[0].y-g.p[0].y)/w;
      } else if(p.length>=2 && g.p.length>=2){
        const d0 = Math.hypot(g.p[1].x-g.p[0].x, g.p[1].y-g.p[0].y), d1 = Math.hypot(p[1].x-p[0].x, p[1].y-p[0].y);
        const a0 = Math.atan2(g.p[1].y-g.p[0].y, g.p[1].x-g.p[0].x), a1 = Math.atan2(p[1].y-p[0].y, p[1].x-p[0].x);
        const m0 = {x:(g.p[0].x+g.p[1].x)/2, y:(g.p[0].y+g.p[1].y)/2}, m1 = {x:(p[0].x+p[1].x)/2, y:(p[0].y+p[1].y)/2};
        tuning.s = Math.max(.3, Math.min(3, g.t.s * d1/Math.max(1,d0)));
        tuning.r = g.t.r + (a1-a0);
        tuning.dx = g.t.dx + (m1.x-m0.x)/w; tuning.dy = g.t.dy + (m1.y-m0.y)/w;
      } else g = {p, t:{...tuning}};   // finger count changed: restart from here
      layout();
    }, {passive:false});
    box.addEventListener('touchend', e=>{ g = e.touches.length ? {p: pts(e), t:{...tuning}} : null; });
    let md = null;
    box.addEventListener('mousedown', e=>{ md = {x:e.clientX, y:e.clientY, t:{...tuning}}; });
    window.addEventListener('mousemove', e=>{ if(!md || !tuning) return; const w = bw(); tuning.dx = md.t.dx + (e.clientX-md.x)/w; tuning.dy = md.t.dy + (e.clientY-md.y)/w; layout(); });
    window.addEventListener('mouseup', ()=>{ md = null; });
    box.addEventListener('wheel', e=>{ e.preventDefault(); if(e.shiftKey) tuning.r += e.deltaY*-0.002; else tuning.s = Math.max(.3, Math.min(3, tuning.s*(1 - e.deltaY*0.001))); layout(); }, {passive:false});
    $$('[data-tune]',ov).forEach(b=> b.addEventListener('click', async ()=>{
      const k = b.dataset.tune;
      if(k==='reset'){ tuning = {dx:0,dy:0,s:1,r:0}; layout(); return; }
      if(k==='save'){
        const cur = state.photos.find(x=>x.id===ps[1].id);
        const tw = {...(cur.alignTweaks||{})};
        const isZero = Math.abs(tuning.dx)<1e-4 && Math.abs(tuning.dy)<1e-4 && Math.abs(tuning.s-1)<1e-4 && Math.abs(tuning.r)<1e-4;
        if(isZero) delete tw[ps[0].id]; else tw[ps[0].id] = {dx:+tuning.dx.toFixed(5), dy:+tuning.dy.toFixed(5), s:+tuning.s.toFixed(5), r:+tuning.r.toFixed(5)};
        await dbSet('photos', cur.id, {...stripId(cur), alignTweaks: tw});
        ps = pick();
      }
      tuning = null; draw();
    }));
  }
  draw();
}

/* ===== Guided camera: live camera with your last photo at the chosen angle as a faded "ghost". ===== */
async function openGhostCamera(angle, onCapture){
  const ov = openOverlay('Take progress photo');
  let facing = lsGet('ledger.camFacing','user'), stream = null, timer = +lsGet('ledger.camTimer','0') || 0, ghostOpacity = +lsGet('ledger.ghostOpacity','40');
  let counting = null;
  const stop = ()=>{ if(stream){ stream.getTracks().forEach(t=> t.stop()); stream = null; } if(counting){ clearInterval(counting); counting = null; } };
  const close = ()=>{ stop(); closeOverlay(ov); };
  const lastOf = a=> state.photos.filter(p=> p.angle===a).sort((x,y)=> y.date.localeCompare(x.date))[0];
  async function render(){
    const last = lastOf(angle);
    const gu = last ? await blobUrl(last.id) : null;
    const mirror = facing==='user' ? 'transform:scaleX(-1);' : '';
    ov.innerHTML = `<div class="cmp-top"><h3>Guided photo</h3><button type="button" class="cmp-x" aria-label="Close camera">✕</button></div>
      <div class="cmp-modes">${PHOTO_ANGLES.map(a=>`<button type="button" class="${a===angle?'on':''}" data-angle="${a}">${a}</button>`).join('')}</div>
      <div class="cmp-stage"><div class="cmp-box cam-box">
        <video id="camVideo" playsinline autoplay muted style="${mirror}"></video>
        ${gu ? `<img id="camGhost" src="${gu}" alt="" style="${mirror}opacity:${ghostOpacity/100}">` : ''}
        <div class="tune-grid"></div>
        <div class="cam-count" id="camCount" hidden></div>
        <div class="cam-msg" id="camMsg">Starting camera…</div>
      </div></div>
      <div class="cmp-ctrl">
        ${gu ? `<label class="cam-row"><span>Guide</span><input type="range" id="camOpacity" min="0" max="80" value="${ghostOpacity}" aria-label="Guide opacity"><span class="mono">${esc(fmtDateShort(last.date))}</span></label>` : `<div class="cmp-hint">No earlier ${esc(angle.toLowerCase())} photo yet. This one will be the guide next time.</div>`}
        <div class="cam-bar">
          <button type="button" class="cam-side" id="camFlip" aria-label="Switch camera">🔄</button>
          <button type="button" class="cam-shutter" id="camShoot" aria-label="Take photo"></button>
          <button type="button" class="cam-side" id="camTimer" aria-label="Self-timer">⏱ ${timer ? timer+'s' : 'Off'}</button>
        </div>
      </div>`;
    $('.cmp-x',ov).addEventListener('click', close);
    $$('[data-angle]',ov).forEach(b=> b.addEventListener('click', ()=>{ angle = b.dataset.angle; stop(); render(); }));
    const op = $('#camOpacity',ov);
    if(op) op.addEventListener('input', ()=>{ ghostOpacity = +op.value; lsSet('ledger.ghostOpacity', String(ghostOpacity)); $('#camGhost',ov).style.opacity = ghostOpacity/100; });
    $('#camFlip',ov).addEventListener('click', ()=>{ facing = facing==='user' ? 'environment' : 'user'; lsSet('ledger.camFacing', facing); stop(); render(); });
    $('#camTimer',ov).addEventListener('click', ()=>{ timer = timer===0 ? 3 : timer===3 ? 10 : 0; lsSet('ledger.camTimer', String(timer)); $('#camTimer',ov).textContent = '⏱ ' + (timer ? timer+'s' : 'Off'); });
    $('#camShoot',ov).addEventListener('click', shoot);
    const video = $('#camVideo',ov), msg = $('#camMsg',ov);
    if(!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia){ msg.textContent = 'This browser can\'t open the camera. Use "Choose file" instead.'; return; }
    try{
      stream = await navigator.mediaDevices.getUserMedia({video:{facingMode: facing, width:{ideal:1920}, height:{ideal:1920}}, audio:false});
      if(!ov.isConnected){ stop(); return; }
      video.srcObject = stream; await video.play().catch(()=>{});
      msg.hidden = true;
    }catch(e){
      msg.textContent = e && e.name==='NotAllowedError' ? 'Camera access was blocked. Allow camera access for this app in your phone\'s settings, then try again.' : 'Couldn\'t start the camera.';
    }
  }
  function shoot(){
    const video = $('#camVideo',ov); if(!stream || !video || !video.videoWidth || counting) return;
    const go = ()=>{
      const c = document.createElement('canvas'); c.width = video.videoWidth; c.height = video.videoHeight;
      c.getContext('2d').drawImage(video, 0, 0);
      c.toBlob(b=>{ if(!b) return; const a = angle; close(); onCapture(b, a); }, 'image/jpeg', 0.92);
    };
    if(!timer) return go();
    let left = timer; const cnt = $('#camCount',ov); cnt.hidden = false; cnt.textContent = left;
    counting = setInterval(()=>{ left--; if(left<=0){ clearInterval(counting); counting = null; cnt.hidden = true; go(); } else cnt.textContent = left; }, 1000);
  }
  render();
}
function initProgress(){
  liftCardHeads();
  initCheckinForm();
  initPhotos();
  $('#trendRange').addEventListener('click', e=>{
    const b = e.target.closest('[data-range]'); if(!b) return;
    trendRange = b.dataset.range; lsSet('ledger.trendRange', trendRange);
    if(trendRange==='Custom' && !$('#trendFrom').value){ $('#trendFrom').value = addDays(todayISO(),-89); $('#trendTo').value = todayISO(); }
    renderProgress();
  });
  ['#trendFrom','#trendTo','#trendMarkers'].forEach(s=> $(s).addEventListener('change', renderProgress));
}

/* ===================== Labs: blood work ===================== */
// Presets only fill in marker names and common US units. Reference ranges differ by lab,
// so they come from your report (and are remembered per marker for the next draw).
const LAB_PANELS = [
  {key:'lipid', label:'Lipid panel', markers:[['Total cholesterol','mg/dL'],['LDL-C','mg/dL'],['HDL-C','mg/dL'],['Triglycerides','mg/dL'],['ApoB','mg/dL'],['Lp(a)','nmol/L']]},
  {key:'metabolic', label:'Glucose & insulin', markers:[['Fasting glucose','mg/dL'],['HbA1c','%'],['Fasting insulin','µIU/mL']]},
  {key:'cmp', label:'Comprehensive metabolic (CMP)', markers:[['Glucose','mg/dL'],['BUN','mg/dL'],['Creatinine','mg/dL'],['eGFR','mL/min/1.73m²'],['Sodium','mmol/L'],['Potassium','mmol/L'],['Chloride','mmol/L'],['CO2','mmol/L'],['Calcium','mg/dL'],['Total protein','g/dL'],['Albumin','g/dL'],['Bilirubin, total','mg/dL'],['Alkaline phosphatase','U/L'],['ALT','U/L'],['AST','U/L']]},
  {key:'cbc', label:'Complete blood count (CBC)', markers:[['WBC','x10³/µL'],['RBC','x10⁶/µL'],['Hemoglobin','g/dL'],['Hematocrit','%'],['Platelets','x10³/µL'],['MCV','fL']]},
  {key:'hormones', label:'Hormones', markers:[['Total testosterone','ng/dL'],['Free testosterone','pg/mL'],['Estradiol','pg/mL'],['SHBG','nmol/L'],['LH','mIU/mL'],['FSH','mIU/mL'],['Prolactin','ng/mL'],['IGF-1','ng/mL'],['DHEA-S','µg/dL']]},
  {key:'thyroid', label:'Thyroid', markers:[['TSH','µIU/mL'],['Free T4','ng/dL'],['Free T3','pg/mL']]},
  {key:'inflammation', label:'Inflammation', markers:[['hs-CRP','mg/L'],['Homocysteine','µmol/L']]},
  {key:'custom', label:'Other / custom', markers:[]},
];
function panelLabel(key){ const p = LAB_PANELS.find(x=>x.key===key); return p ? p.label : 'Other'; }
function labFlag(r){
  const v = num(r.value,null); if(v==null) return '';
  const lo = num(r.low,null), hi = num(r.high,null);
  if(hi!=null && v>hi) return 'hi';
  if(lo!=null && v<lo) return 'lo';
  return '';
}
/* One row per marker: [{date, value, unit, low, high, panel}] oldest first. Same-date draws merge. */
function labHistory(){
  const map = new Map();
  state.labs.slice().sort((a,b)=> (a.drawDate||'').localeCompare(b.drawDate||'')).forEach(d=>{
    (Array.isArray(d.results)?d.results:[]).forEach(r=>{
      if(!r || !r.marker || num(r.value,null)==null) return;
      const k = r.marker.trim();
      if(!map.has(k)) map.set(k, {marker:k, panel:d.panel||'custom', points:[]});
      const m = map.get(k);
      const i = m.points.findIndex(p=>p.date===d.drawDate);
      const pt = {date:d.drawDate, value:num(r.value), unit:r.unit||'', low:r.low, high:r.high, flag:labFlag(r)};
      if(i>-1) m.points[i] = pt; else m.points.push(pt);
    });
  });
  return map;
}
function lastRangeFor(marker){
  const h = labHistory().get(marker);
  if(!h) return null;
  for(let i=h.points.length-1;i>=0;i--){ const p = h.points[i]; if(p.low!==''&&p.low!=null || p.high!==''&&p.high!=null) return p; }
  return h.points[h.points.length-1];
}
function renderLabs(){
  const el = $('#labCompare'); if(!el) return;
  const hist = labHistory();
  const dates = [...new Set(state.labs.map(d=>d.drawDate).filter(Boolean))].sort().reverse();
  if(!dates.length){
    el.innerHTML = `<div class="empty"><div class="glyph">🩸</div><p>No lab results yet. Add a draw, pick a panel to fill in the marker names, then type the values and reference ranges from your report.</p></div>`;
  } else {
    const cols = dates.slice(0, 6);
    const panelOrder = LAB_PANELS.map(p=>p.key);
    const rows = [...hist.values()].filter(m=> m.points.some(p=> cols.includes(p.date)))
      .sort((a,b)=> (panelOrder.indexOf(a.panel)-panelOrder.indexOf(b.panel)) || a.marker.localeCompare(b.marker));
    let lastPanel = null;
    const body = rows.map(m=>{
      let head = '';
      if(m.panel!==lastPanel){ lastPanel = m.panel; head = `<tr class="lab-panel-row"><th colspan="${cols.length+1}" scope="colgroup">${esc(panelLabel(m.panel))}</th></tr>`; }
      const unit = (m.points[m.points.length-1]||{}).unit || '';
      const cells = cols.map((d,ci)=>{
        const p = m.points.find(x=>x.date===d);
        if(!p) return `<td class="lab-cell empty-cell">·</td>`;
        const prevDate = cols.slice(ci+1).find(dd=> m.points.some(x=>x.date===dd));
        const prev = prevDate ? m.points.find(x=>x.date===prevDate) : null;
        const arrow = prev ? (p.value>prev.value ? '↑' : p.value<prev.value ? '↓' : '→') : '';
        return `<td class="lab-cell ${p.flag}"><span class="mono">${esc(String(p.value))}</span>${p.flag?`<span class="lab-flag">${p.flag==='hi'?'H':'L'}</span>`:''}${arrow?`<span class="lab-arrow">${arrow}</span>`:''}</td>`;
      }).join('');
      return `${head}<tr class="lab-row" data-lab-marker="${esc(m.marker)}" tabindex="0"><th scope="row"><span class="lab-name">${esc(m.marker)}</span><span class="lab-unit">${esc(unit)}</span></th>${cells}</tr>`;
    }).join('');
    el.innerHTML = `<div class="lab-table-wrap"><table class="lab-table">
      <thead><tr><th scope="col">Marker</th>${cols.map(d=>`<th scope="col" class="mono">${esc(fmtDateShort(d))}<div class="lab-year">${d.slice(0,4)}</div></th>`).join('')}</tr></thead>
      <tbody>${body}</tbody></table></div>
      <p class="footnote" style="margin-top:8px;">Newest draw on the left. H and L mean outside the reference range you entered. Arrows compare with the previous draw. Tap a marker for its trend.${dates.length>6?` Showing the latest 6 of ${dates.length} draw dates.`:''}</p>`;
    $$('[data-lab-marker]',el).forEach(r=>{
      r.addEventListener('click', ()=> openMarkerTrend(r.dataset.labMarker));
      r.addEventListener('keydown', e=>{ if(e.key==='Enter'){ e.preventDefault(); openMarkerTrend(r.dataset.labMarker); } });
    });
  }
  const list = $('#labDraws');
  const draws = state.labs.slice().sort((a,b)=> (b.drawDate||'').localeCompare(a.drawDate||''));
  list.innerHTML = draws.length ? draws.map(d=>{
    const rs = (d.results||[]).filter(r=> r && r.marker && num(r.value,null)!=null);
    const flagged = rs.filter(r=> labFlag(r)).length;
    return `<button type="button" class="draw-row" data-edit-lab="${d.id}">
      <span><strong>${fmtDate(d.drawDate)}</strong><span class="footnote"> · ${esc(panelLabel(d.panel))}${d.lab?` · ${esc(d.lab)}`:''}</span></span>
      <span class="draw-pills"><span class="pill pill-muted">${rs.length} marker${rs.length===1?'':'s'}</span>${flagged?`<span class="pill pill-warn">${flagged} flagged</span>`:''}</span>
    </button>`;
  }).join('') : '';
  renderUrine();
}
function openMarkerTrend(marker){
  const m = labHistory().get(marker); if(!m) return;
  const pts = m.points;
  const last = pts[pts.length-1];
  const from = pts.length>1 ? pts[0].date : addDays(last.date,-30);
  const to = pts.length>1 ? last.date : addDays(last.date, 1);
  const band = (last.low!=null && last.low!=='') || (last.high!=null && last.high!=='') ? [{lo: num(last.low,null), hi: num(last.high,null)}] : [];
  openModal(`${marker}`, `
    <div class="footnote" style="margin-bottom:8px;">${esc(panelLabel(m.panel))}${last.unit?` · ${esc(last.unit)}`:''}${band.length?` · shaded band is your reference range (${last.low!==''&&last.low!=null?esc(String(last.low)):'—'} to ${last.high!==''&&last.high!=null?esc(String(last.high)):'—'})`:''}</div>
    ${lineChartSVG({series:[{name:marker, color:'var(--accent-pep)', points: pts.map(p=>({x:p.date, y:p.value, flag:p.flag})), unit:last.unit}], from, to, bands: band, width: Math.min(560, window.innerWidth - 80), label:`${marker} over time`, height:200})}
    <table class="lab-hist"><thead><tr><th>Date</th><th>Value</th><th>Range</th></tr></thead><tbody>
      ${pts.slice().reverse().map(p=>`<tr class="${p.flag}"><td>${fmtDate(p.date)}</td><td class="mono">${esc(String(p.value))} ${esc(p.unit)}${p.flag?` <span class="lab-flag">${p.flag==='hi'?'H':'L'}</span>`:''}</td><td class="mono">${p.low!=null&&p.low!==''?esc(String(p.low)):'—'} to ${p.high!=null&&p.high!==''?esc(String(p.high)):'—'}</td></tr>`).join('')}
    </tbody></table>
    <div class="form-actions"><button class="btn btn-accent-pep" id="mtClose">Close</button></div>
  `, body=> $('#mtClose',body).addEventListener('click', closeModal));
}
function openLabModal(existing){
  const d = existing || {};
  let rows = (Array.isArray(d.results) ? d.results : []).map(r=>({...r}));
  const knownMarkers = [...new Set(LAB_PANELS.flatMap(p=>p.markers.map(m=>m[0])).concat([...labHistory().keys()]))].sort();
  const knownLabs = [...new Set(state.labs.map(x=>x.lab).filter(Boolean))];
  openModal(existing ? 'Edit lab draw' : 'Add lab draw', `
    <div class="form-grid">
      <div class="field"><label for="lbDate">Draw date</label><input id="lbDate" type="date" value="${esc(d.drawDate||todayISO())}"></div>
      <div class="field"><label for="lbLab">Lab (optional)</label><input id="lbLab" type="text" list="lbLabs" value="${esc(d.lab||'')}" placeholder="e.g. Quest, Labcorp"><datalist id="lbLabs">${knownLabs.map(l=>`<option value="${esc(l)}"></option>`).join('')}</datalist></div>
      <div class="field span2"><label for="lbPanel">Panel</label><select id="lbPanel">${LAB_PANELS.map(p=>`<option value="${p.key}" ${(d.panel||'')===p.key?'selected':''}>${esc(p.label)}</option>`).join('')}</select>
        <div class="footnote" style="margin-top:4px;">Picking a panel adds its usual markers below. Leave a value blank to skip that marker.</div></div>
      <div class="field span2"><label>Results</label>
        <div class="lab-rows-head" aria-hidden="true"><span>Marker</span><span>Value</span><span>Unit</span><span>Low</span><span>High</span><span></span></div>
        <div id="lbRows"></div>
        <datalist id="lbMarkers">${knownMarkers.map(m=>`<option value="${esc(m)}"></option>`).join('')}</datalist>
        <button type="button" class="btn btn-sm" id="lbAddRow" style="margin-top:8px;">+ Add marker</button>
      </div>
      <div class="field span2"><label for="lbNote">Note (optional)</label><input id="lbNote" type="text" value="${esc(d.note||'')}" placeholder="e.g. fasted 12h, morning draw"></div>
    </div>
    <div class="form-actions">
      ${existing?`<button class="btn btn-danger" id="lbDelete" style="margin-right:auto;">Delete</button>`:''}
      <button class="btn" id="lbCancel">Cancel</button><button class="btn btn-accent-pep" id="lbSave">Save</button>
    </div>
  `, body=>{
    function addPreset(key){
      const p = LAB_PANELS.find(x=>x.key===key); if(!p) return;
      p.markers.forEach(([name,unit])=>{
        if(rows.some(r=> (r.marker||'').toLowerCase()===name.toLowerCase())) return;
        const prev = lastRangeFor(name);
        rows.push({marker:name, value:'', unit: prev && prev.unit || unit, low: prev ? (prev.low??'') : '', high: prev ? (prev.high??'') : ''});
      });
    }
    function draw(){
      $('#lbRows',body).innerHTML = rows.length ? rows.map((r,i)=>`
        <div class="lab-edit-row" data-i="${i}">
          <input type="text" list="lbMarkers" data-f="marker" value="${esc(r.marker||'')}" placeholder="Marker" aria-label="Marker ${i+1} name">
          <input type="number" inputmode="decimal" step="any" data-f="value" value="${esc(r.value??'')}" placeholder="—" aria-label="${esc(r.marker||'Marker')} value">
          <input type="text" data-f="unit" value="${esc(r.unit||'')}" placeholder="unit" aria-label="${esc(r.marker||'Marker')} unit">
          <input type="number" inputmode="decimal" step="any" data-f="low" value="${esc(r.low??'')}" placeholder="low" aria-label="${esc(r.marker||'Marker')} range low">
          <input type="number" inputmode="decimal" step="any" data-f="high" value="${esc(r.high??'')}" placeholder="high" aria-label="${esc(r.marker||'Marker')} range high">
          <button type="button" class="icon-btn" data-rm-row="${i}" aria-label="Remove ${esc(r.marker||'marker')}">✕</button>
        </div>`).join('') : `<p class="footnote" style="margin:4px 0;">No markers yet.</p>`;
    }
    if(!existing) addPreset($('#lbPanel',body).value);
    draw();
    $('#lbPanel',body).addEventListener('change', ()=>{ addPreset($('#lbPanel',body).value); draw(); });
    $('#lbRows',body).addEventListener('input', e=>{
      const row = e.target.closest('[data-i]'), f = e.target.dataset.f; if(!row||!f) return;
      rows[+row.dataset.i][f] = e.target.value;
      if(f==='marker'){
        const prev = lastRangeFor(e.target.value.trim());
        const r = rows[+row.dataset.i];
        if(prev && !r.unit && !r.low && !r.high){ r.unit = prev.unit||''; r.low = prev.low??''; r.high = prev.high??''; draw(); }
      }
    });
    $('#lbRows',body).addEventListener('click', e=>{ const b = e.target.closest('[data-rm-row]'); if(!b) return; rows.splice(+b.dataset.rmRow,1); draw(); });
    $('#lbAddRow',body).addEventListener('click', ()=>{ rows.push({marker:'', value:'', unit:'', low:'', high:''}); draw(); const ins = $$('#lbRows [data-f="marker"]',body); if(ins.length) ins[ins.length-1].focus(); });
    $('#lbCancel',body).addEventListener('click', closeModal);
    if(existing) $('#lbDelete',body).addEventListener('click', ()=>{ closeModal(); confirmAction('Delete this lab draw and its results?', ()=> dbDelete('labs', existing.id)); });
    $('#lbSave',body).addEventListener('click', async ()=>{
      const results = rows.filter(r=> (r.marker||'').trim() && String(r.value??'').trim()!=='')
        .map(r=>({marker:r.marker.trim(), value:num(r.value), unit:(r.unit||'').trim(), low: String(r.low??'').trim()===''?'':num(r.low), high: String(r.high??'').trim()===''?'':num(r.high)}));
      if(!results.length){ $('#lbRows',body).insertAdjacentHTML('afterbegin', '<p class="footnote" style="color:var(--warn);margin:0 0 6px;">Enter at least one value.</p>'); return; }
      const data = {drawDate: $('#lbDate',body).value || todayISO(), lab: $('#lbLab',body).value.trim(), panel: $('#lbPanel',body).value, note: $('#lbNote',body).value.trim(), results};
      if(existing) await dbSet('labs', existing.id, data); else await dbAdd('labs', data);
      closeModal();
    });
  });
}

/* ===================== Labs: urine test strips ===================== */
// Pad levels follow the common 10- and 14-parameter strip charts. "ok" marks the levels usually read as normal.
const URINE_PARAMS = [
  {key:'leu', label:'Leukocytes', levels:[['Negative',1],['Trace'],['Small +'],['Moderate ++'],['Large +++']]},
  {key:'nit', label:'Nitrite', levels:[['Negative',1],['Positive']]},
  {key:'uro', label:'Urobilinogen', levels:[['0.2 mg/dL',1],['1 mg/dL',1],['2 mg/dL'],['4 mg/dL'],['8 mg/dL']]},
  {key:'pro', label:'Protein', levels:[['Negative',1],['Trace'],['30 mg/dL +'],['100 mg/dL ++'],['300 mg/dL +++'],['2000 mg/dL ++++']]},
  {key:'ph',  label:'pH', levels:[['5.0',1],['6.0',1],['6.5',1],['7.0',1],['7.5',1],['8.0'],['8.5']]},
  {key:'bld', label:'Blood', levels:[['Negative',1],['Trace'],['Small +'],['Moderate ++'],['Large +++']]},
  {key:'sg',  label:'Specific gravity', levels:[['1.000'],['1.005',1],['1.010',1],['1.015',1],['1.020',1],['1.025',1],['1.030']]},
  {key:'ket', label:'Ketone', levels:[['Negative',1],['Trace 5 mg/dL'],['Small 15 mg/dL'],['Moderate 40 mg/dL'],['Large 80 mg/dL'],['Large 160 mg/dL']]},
  {key:'bil', label:'Bilirubin', levels:[['Negative',1],['Small +'],['Moderate ++'],['Large +++']]},
  {key:'glu', label:'Glucose', levels:[['Negative',1],['100 mg/dL'],['250 mg/dL'],['500 mg/dL'],['1000 mg/dL'],['2000+ mg/dL']]},
  {key:'asc', label:'Ascorbate', only14:true, levels:[['0 mg/dL',1],['10 mg/dL',1],['20 mg/dL'],['40 mg/dL']]},
  {key:'mal', label:'Microalbumin', only14:true, levels:[['10 mg/L',1],['30 mg/L'],['80 mg/L'],['150 mg/L']]},
  {key:'cre', label:'Creatinine', only14:true, levels:[['10 mg/dL',1],['50 mg/dL',1],['100 mg/dL',1],['200 mg/dL',1],['300 mg/dL',1]]},
  {key:'ca',  label:'Calcium', only14:true, levels:[['≤1.0 mmol/L',1],['2.5 mmol/L',1],['5.0 mmol/L'],['7.5 mmol/L'],['≥10 mmol/L']]},
];
function urineParamsFor(strip){ return URINE_PARAMS.filter(p=> strip==='14' || !p.only14); }
function urineAbnormal(u){
  return urineParamsFor(u.strip).filter(p=>{
    const v = (u.values||{})[p.key]; if(!v) return false;
    const lv = p.levels.find(l=>l[0]===v);
    return lv && !lv[1];
  }).map(p=>({label:p.label, value:u.values[p.key]}));
}
function renderUrine(){
  const el = $('#urineList'); if(!el) return;
  const list = state.urine.slice().sort((a,b)=> (b.date||'').localeCompare(a.date||'')).slice(0,12);
  if(!list.length){ el.innerHTML = `<div class="empty" style="padding:14px 8px;"><p>No strips logged. Read each pad against the chart on the bottle at the time it lists, then log it here.</p></div>`; return; }
  el.innerHTML = list.map(u=>{
    const ab = urineAbnormal(u);
    const filled = Object.values(u.values||{}).filter(Boolean).length;
    return `<button type="button" class="draw-row" data-edit-urine="${u.id}">
      <span><strong>${fmtDate(u.date)}</strong><span class="footnote"> · ${u.strip==='14'?'14':'10'}-parameter · ${filled} pads read</span>${u.note?`<span class="footnote" style="display:block;">${esc(u.note)}</span>`:''}</span>
      <span class="draw-pills">${ab.length ? ab.map(a=>`<span class="pill pill-warn">${esc(a.label)}: ${esc(a.value)}</span>`).join('') : `<span class="pill pill-good">All in normal band</span>`}</span>
    </button>`;
  }).join('');
}
function openUrineModal(existing){
  const u = existing || {};
  let strip = u.strip || lsGet('ledger.urineStrip','10');
  openModal(existing ? 'Edit urine strip' : 'Log urine strip', `
    <div class="form-grid">
      <div class="field"><label for="urDate">Date</label><input id="urDate" type="date" value="${esc(u.date||todayISO())}"></div>
      <div class="field"><label for="urStrip">Strip type</label><select id="urStrip"><option value="10" ${strip==='10'?'selected':''}>10-parameter</option><option value="14" ${strip==='14'?'selected':''}>14-parameter</option></select></div>
      <div class="field span2"><div id="urPads" class="ur-pads"></div></div>
      <div class="field span2"><label for="urNote">Note (optional)</label><input id="urNote" type="text" value="${esc(u.note||'')}" placeholder="e.g. first morning sample"></div>
    </div>
    <p class="footnote" style="margin-top:8px;">Flags are a rough guide based on the usual normal bands. Your strip's own chart is the reference.</p>
    <div class="form-actions">
      ${existing?`<button class="btn btn-danger" id="urDelete" style="margin-right:auto;">Delete</button>`:''}
      <button class="btn" id="urCancel">Cancel</button><button class="btn btn-accent-pep" id="urSave">Save</button>
    </div>
  `, body=>{
    const vals = {...(u.values||{})};
    const draw = ()=>{
      $('#urPads',body).innerHTML = urineParamsFor(strip).map(p=>`
        <div class="ur-pad"><label for="ur_${p.key}">${esc(p.label)}</label>
          <select id="ur_${p.key}" data-ur="${p.key}"><option value="">Not read</option>${p.levels.map(l=>`<option ${vals[p.key]===l[0]?'selected':''}>${esc(l[0])}</option>`).join('')}</select>
        </div>`).join('');
    };
    draw();
    $('#urStrip',body).addEventListener('change', ()=>{ strip = $('#urStrip',body).value; lsSet('ledger.urineStrip', strip); draw(); });
    $('#urPads',body).addEventListener('change', e=>{ const k = e.target.dataset.ur; if(k) vals[k] = e.target.value; });
    $('#urCancel',body).addEventListener('click', closeModal);
    if(existing) $('#urDelete',body).addEventListener('click', ()=>{ closeModal(); confirmAction('Delete this strip reading?', ()=> dbDelete('urine', existing.id)); });
    $('#urSave',body).addEventListener('click', async ()=>{
      const keep = {}; urineParamsFor(strip).forEach(p=>{ if(vals[p.key]) keep[p.key] = vals[p.key]; });
      const data = {date: $('#urDate',body).value || todayISO(), strip, values: keep, note: $('#urNote',body).value.trim()};
      if(existing) await dbSet('urine', existing.id, data); else await dbAdd('urine', data);
      closeModal();
    });
  });
}
function initLabs(){
  $('#addLabBtn').addEventListener('click', ()=> openLabModal(null));
  $('#addUrineBtn').addEventListener('click', ()=> openUrineModal(null));
  $('#labDraws').addEventListener('click', e=>{ const b = e.target.closest('[data-edit-lab]'); if(b) openLabModal(state.labs.find(x=>x.id===b.dataset.editLab)); });
  $('#urineList').addEventListener('click', e=>{ const b = e.target.closest('[data-edit-urine]'); if(b) openUrineModal(state.urine.find(x=>x.id===b.dataset.editUrine)); });
}

/* ===================== Ask Claude (copy your data into a Claude chat) ===================== */
function stackContextForAsk(){
  const wu = weightUnit();
  const day = doseDayISO();
  return {
    today: todayISO(),
    vendors: state.vendors.map(v=>({name:v.name, url:v.url||null, deal:v.deal||null, notes:v.notes||null})),
    vials: state.vials.filter(v=>!isDepleted(v)).map(v=>({compound:v.compound, mgPerVial:num(v.mgPerVial,null), qty:num(v.qty,1), price:v.price?num(v.price):null, vendor:v.pharmacy||null, concentration:v.concentration?num(v.concentration):null, remainingMg: v.remainingMg??null, bud: v.bud||null, labTests: vialTests(v).map(t=>({lab:t.lab||null, massMg:num(t.massMg,null), purityPct:num(t.purity,null), endotoxinEUperMg:num(t.endo,null), date:t.date||null, coa:safeUrl(t.coaUrl)||null}))})),
    protocols: state.protocols.filter(p=>p.status!=='archived').map(p=>{
      const d = doseAt(p, day);
      return {compound:p.compound, status:p.status||'active', currentDose: fmtDose(d.dose, d.doseUnit), splitInjections: splitCount(p), frequencyDays:p.frequencyDays, doseWeekdays:(weekdaysOf(p)||[]).map(i=>DOW[i]), usualDoseTime:p.doseTime||null, halfLifeHours:halfLifeOf(p), blend: blendParts(p) ? blendParts(p).map(c=>({peptide:c.name, mgPerVial:c.mg, share:Math.round(c.frac*1000)/1000, halfLifeHours:c.hl||null})) : null,
        startDate: p.startDate||null, titrationSteps: titrationSteps(p),
        injectionsLast30Days: (p.doseLog||[]).filter(x=> x>=addDays(day,-29)).length,
        lastSite: (lastSiteOf(p)||{}).site||null,
        dailySatisfaction: moodLogOf(p).slice(-30).map(e=>({date:e.date, score:e.score||null, note:e.note||null}))};
    }),
    checkins: state.checkins.slice().sort((a,b)=> a.date.localeCompare(b.date)).slice(-30).map(c=>({date:c.date, weight: num(c.weight,null)!=null ? Math.round(toUnit(c.weight, c.weightUnit||wu, wu)*10)/10 : null, weightUnit: wu, mood:c.mood||null, energy:c.energy||null, note:c.note||null})),
    labs: state.labs.slice().sort((a,b)=> (b.drawDate||'').localeCompare(a.drawDate||'')).slice(0,4).map(d=>({drawDate:d.drawDate, panel:panelLabel(d.panel), results:(d.results||[]).map(r=>({marker:r.marker, value:r.value, unit:r.unit, refLow:r.low===''?null:r.low, refHigh:r.high===''?null:r.high}))})),
  };
}
function buildClaudePrompt(question, pasted){
  return `I track my peptide protocols in a personal app. Below is my logged data as JSON: vendors, my vial stash with prices, my active and paused protocols (including daily satisfaction scores from 1 = poor to 5 = great), my recent check-ins (weight, mood, energy) and my recent lab results.

Answer using this data. If something you need isn't in the data, say so instead of guessing. Use a markdown table when comparing vendors, costs or options. Keep the answer under 250 words. Don't give me personal medical dosing advice.

My data:
${JSON.stringify(stackContextForAsk())}

Question: ${question}

Extra material (may be empty):
${pasted || '(none)'}`;
}
async function copyText(text){
  try{ await navigator.clipboard.writeText(text); return true; }
  catch(e){
    try{
      const ta = document.createElement('textarea');
      ta.value = text; ta.setAttribute('readonly',''); ta.style.position='fixed'; ta.style.opacity='0';
      document.body.appendChild(ta); ta.select(); ta.setSelectionRange(0, text.length);
      const ok = document.execCommand('copy'); ta.remove(); return ok;
    }catch(e2){ return false; }
  }
}
function initAsk(){
  $('#copyClaudeBtn').addEventListener('click', async ()=>{
    const q = $('#researchTopic').value.trim();
    const status = $('#researchStatus');
    if(!q){ status.textContent = 'Type a question first.'; $('#researchTopic').focus(); return; }
    const text = buildClaudePrompt(q, $('#researchInput').value.trim());
    const ok = await copyText(text);
    if(ok){
      status.textContent = 'Copied. Paste it into a Claude chat, then save the answer below.';
      $('#answerTopic').value = q;
    } else {
      status.textContent = 'Copy was blocked. Select all the text below and copy it yourself.';
      $('#copyFallback').hidden = false; $('#copyFallback').value = text; $('#copyFallback').select();
    }
  });
  $('#saveAnswerBtn').addEventListener('click', async ()=>{
    const topic = $('#answerTopic').value.trim() || $('#researchTopic').value.trim();
    const answer = $('#answerText').value.trim();
    const st = $('#answerStatus');
    if(!answer){ st.textContent = 'Paste the answer first.'; return; }
    await dbAdd('research', {topic: topic || 'Saved answer', answer, createdAt: todayISO()});
    $('#answerText').value=''; $('#answerTopic').value=''; $('#researchTopic').value=''; $('#researchInput').value='';
    $('#copyFallback').hidden = true;
    st.textContent = 'Saved.';
  });
}

/* ===================== Claude chat (in-app, the user's own API key) =====================
   Calls the Claude Messages API straight from the phone with the key the user pastes in (stored only in
   localStorage, never in backups). Each conversation keeps the system prompt (with a data snapshot) it
   started with and is only ever appended to, so replayed thinking blocks stay valid. */
const CLAUDE_MODELS = {
  'claude-opus-5-5':   {label:'Claude Opus 5.5', inp:4, out:20, cr:0.20, cw:5},
  'claude-sonnet-5-5': {label:'Claude Sonnet 5.5 (cheaper)', inp:2, out:10, cr:0.20, cw:2.5},
};
let askConv = null, askBusy = false, askAbort = null, askStream = null;
const claudeKey = ()=> lsGet('ledger.claudeKey','');
const claudeModel = ()=> CLAUDE_MODELS[lsGet('ledger.claudeModel','')] ? lsGet('ledger.claudeModel','') : 'claude-opus-5-5';
function askSystemPrompt(){
  return `You are the assistant inside Peptide Ledger, the user's private app for tracking peptide protocols, doses, vials, vendors and weight. Today is ${fmtDate(todayISO())}.

About the user:
- An adult who uses research and grey-market peptides, and who is a type 1 diabetic.
- Already understands the risks of using grey-market peptides. Peptide questions are never requests for medical advice. Do not add disclaimers, risk warnings, "consult a doctor" lines or sourcing cautions about peptides; they are never needed.

How to answer:
- Lead with what the medical and scientific evidence suggests. Say how strong it is (human trials, small studies, animal or cell work) and name key studies where you can.
- Then cover the anecdotal side: what users commonly report and what the public discussion online (forums, Reddit, peptide communities) tends to say. Label it clearly as anecdotal.
- You have a web search tool. Use it when it would improve the answer: recent studies, current discussion and user reports, or anything you're unsure of. Prefer primary sources (PubMed, journals, trial registries) for the evidence, and forums or community sites for the anecdotal side.
- Factor in type 1 diabetes whenever it changes the answer (for example effects on blood glucose, insulin needs or hypoglycaemia), stated plainly as part of the answer rather than as a warning.
- The user's logged data is below. Use it only when it actually affects the answer (for example interactions with peptides they take or took, timing, overlapping effects, or a question about their own records). Otherwise ignore it and don't mention it.
- Be direct and well organised. Use short headings or a markdown table when it helps. There is no length limit: give a complete answer and never leave out important information to keep it short.

<user_data>
${JSON.stringify(stackContextForAsk())}
</user_data>`;
}
const ASK_SUGGESTIONS = ['How is my current protocol going so far?', 'When will my active vials run out?', 'Summarize my weight trend since I started.', 'What questions should I bring to my doctor?'];
function renderAsk(){
  const setup = $('#askSetup'), chat = $('#askChat'); if(!setup) return;
  const hasKey = !!claudeKey();
  setup.hidden = hasKey; chat.hidden = !hasKey;
  if(!hasKey) return;
  $('#askModelLbl').textContent = (askConv && CLAUDE_MODELS[askConv.model] ? CLAUDE_MODELS[askConv.model] : CLAUDE_MODELS[claudeModel()]).label;
  const th = $('#askThread');
  const msgs = askConv ? askConv.messages : [];
  if(!msgs.length){
    th.innerHTML = `<div class="ask-suggest"><div class="hint">Ask anything about your protocols, doses, vials, vendors or weight.</div>${ASK_SUGGESTIONS.map(s=>`<button type="button" class="btn" data-suggest="${esc(s)}">${esc(s)}</button>`).join('')}</div>`;
    $$('[data-suggest]',th).forEach(b=> b.addEventListener('click', ()=>{ $('#askInput').value = b.dataset.suggest; sendAsk(); }));
  } else {
    th.innerHTML = msgs.map(m=>{
      if(m.role==='user') return `<div class="ask-msg user">${esc(chatText(m))}</div>`;
      const srcs = [], seen = new Set();
      (m.content||[]).forEach(b=> (b.citations||[]).forEach(c=>{ if(c && c.url && !seen.has(c.url) && safeUrl(c.url)){ seen.add(c.url); srcs.push(c); } }));
      return `<div class="ask-msg bot"><div class="research-md">${mdToHtml(chatText(m))}</div>${srcs.length ? `<div class="ask-srcs"><span>Sources</span>${srcs.slice(0,8).map((c,i)=>`<a href="${esc(safeUrl(c.url))}" target="_blank" rel="noopener">${i+1}. ${esc(c.title || new URL(c.url).hostname)}</a>`).join('')}</div>` : ''}</div>`;
    }).join('') + (askBusy ? `<div class="ask-msg bot" id="askLive"><span class="ask-typing"><i></i><i></i><i></i>&nbsp;Claude is thinking</span></div>` : '');
  }
  $('#askCost').textContent = askConv && askConv.costUsd ? `This chat ≈ $${askConv.costUsd.toFixed(3)} · ${CLAUDE_MODELS[askConv.model]?.label || ''}` : '';
  const send = $('#askSend');
  send.classList.toggle('stop', askBusy); send.textContent = askBusy ? '■' : '↑'; send.setAttribute('aria-label', askBusy ? 'Stop' : 'Send');
}
function askScrollEnd(){ const c = $('.ask-composer'); if(c) c.scrollIntoView({block:'end', behavior:'smooth'}); }
function cleanBlock(b){ const c = {...b}; delete c._json; return c; }
// Thinking/tool blocks before the last fallback marker came from a model that declined; don't echo them back.
function echoableContent(blocks){
  const cut = blocks.map(b=>b.type).lastIndexOf('fallback');
  return blocks.filter((b,i)=>{
    if(b.type==='fallback') return false;
    if(i < cut) return b.type==='text';
    return true;
  });
}
async function sendAsk(){
  if(askBusy){ if(askAbort) askAbort.abort(); return; }
  const input = $('#askInput'); const text = input.value.trim(); if(!text) return;
  const key = claudeKey(); if(!key) return renderAsk();
  if(!askConv) askConv = {model: claudeModel(), system: askSystemPrompt(), messages: [], topic: text.slice(0,90), createdAt: todayISO(), costUsd: 0};
  askConv.messages.push({role:'user', content:[{type:'text', text}]});
  input.value = ''; input.style.height = '';
  askBusy = true; renderAsk(); askScrollEnd();
  askAbort = new AbortController();
  let blocks = [], usage = {}, searches = 0;
  let stopReason = null, errMsg = null;
  const live = ()=> $('#askLive');
  const showLive = ()=>{
    const el = live(); if(!el) return;
    const txt = chatText({content:blocks});
    const searching = blocks.some(x=> x && x.type==='server_tool_use' && x.name==='web_search') && !txt;
    el.innerHTML = txt ? `<div class="research-md">${mdToHtml(txt)}</div>` : `<span class="ask-typing"><i></i><i></i><i></i>&nbsp;${searching ? 'Searching the web' : 'Claude is thinking'}</span>`;
  };
  try{
    // a long search can pause the turn; resend with the partial answer appended so the server picks it up
    for(let hop = 0; hop < 5; hop++){
      const hopStart = blocks.length;
      const msgs = hopStart ? askConv.messages.concat([{role:'assistant', content: blocks.filter(Boolean).map(cleanBlock)}]) : askConv.messages;
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method:'POST', signal: askAbort.signal,
        headers:{
          'content-type':'application/json',
          'x-api-key': key,
          'anthropic-version':'2023-06-01',
          'anthropic-dangerous-direct-browser-access':'true',
          'anthropic-beta':'server-side-fallback-2026-07-01',
        },
        body: JSON.stringify({
          model: askConv.model, max_tokens: 32000, stream: true,
          system: [{type:'text', text: askConv.system, cache_control:{type:'ephemeral'}}],
          messages: msgs,
          tools: [{type:'web_search_20260209', name:'web_search', max_uses: 6}],
          output_config: {effort: 'medium'},
          fallbacks: 'default',
        }),
      });
      if(!res.ok){
        let detail = ''; try{ const j = await res.json(); detail = (j.error && j.error.message) || ''; }catch(_){}
        errMsg = res.status===401 ? 'Your API key was not accepted. Check it in ⚙ settings.'
          : res.status===429 ? 'Too many requests right now. Wait a moment and try again.'
          : res.status===529 || res.status>=500 ? 'Claude is busy or unavailable right now. Try again shortly.'
          : /credit balance/i.test(detail) ? 'Your Anthropic credit balance is too low. Add credit at console.anthropic.com → Billing.'
          : (detail || `Request failed (${res.status}).`);
        break;
      }
      const reader = res.body.getReader(), dec = new TextDecoder();
      let buf = '', hopUsage = {};
      stopReason = null;
      for(;;){
        const {value, done} = await reader.read(); if(done) break;
        buf += dec.decode(value, {stream:true});
        let i;
        while((i = buf.indexOf('\n\n')) >= 0){
          const chunk = buf.slice(0, i); buf = buf.slice(i+2);
          const dataLine = chunk.split('\n').filter(l=> l.startsWith('data:')).map(l=> l.slice(5).trim()).join('');
          if(!dataLine) continue;
          let ev; try{ ev = JSON.parse(dataLine); }catch(_){ continue; }
          const at = ev.index!=null ? hopStart + ev.index : -1;
          if(ev.type==='message_start'){ Object.assign(hopUsage, ev.message && ev.message.usage || {}); }
          else if(ev.type==='content_block_start'){ blocks[at] = JSON.parse(JSON.stringify(ev.content_block)); showLive(); }
          else if(ev.type==='content_block_delta'){
            const b = blocks[at], d = ev.delta; if(!b || !d) continue;
            if(d.type==='text_delta'){ b.text = (b.text||'') + d.text; showLive(); }
            else if(d.type==='thinking_delta') b.thinking = (b.thinking||'') + d.thinking;
            else if(d.type==='signature_delta') b.signature = d.signature;
            else if(d.type==='input_json_delta') b._json = (b._json||'') + d.partial_json;
            else if(d.type==='citations_delta'){ (b.citations = b.citations||[]).push(d.citation); }
          }
          else if(ev.type==='content_block_stop'){
            const b = blocks[at];
            if(b && b._json!=null){ try{ b.input = JSON.parse(b._json || '{}'); }catch(_){} delete b._json; }
          }
          else if(ev.type==='message_delta'){ if(ev.delta && ev.delta.stop_reason) stopReason = ev.delta.stop_reason; if(ev.usage) Object.assign(hopUsage, ev.usage); }
          else if(ev.type==='error'){ errMsg = (ev.error && ev.error.message) || 'Claude ran into an error.'; }
        }
      }
      ['input_tokens','cache_creation_input_tokens','cache_read_input_tokens','output_tokens'].forEach(k=> usage[k] = (usage[k]||0) + (hopUsage[k]||0));
      searches += (hopUsage.server_tool_use && hopUsage.server_tool_use.web_search_requests) || 0;
      if(errMsg || stopReason!=='pause_turn') break;
    }
  }catch(e){
    errMsg = e && e.name==='AbortError' ? 'Stopped.' : 'Couldn\'t reach Claude. Check your connection and try again.';
  }
  askBusy = false; askAbort = null;
  const m = CLAUDE_MODELS[askConv.model] || CLAUDE_MODELS['claude-opus-5-5'];
  const cost = ((usage.input_tokens||0)*m.inp + (usage.cache_creation_input_tokens||0)*m.cw + (usage.cache_read_input_tokens||0)*m.cr + (usage.output_tokens||0)*m.out) / 1e6 + searches*0.01;
  askConv.costUsd = (askConv.costUsd||0) + cost;
  const content = blocks.filter(Boolean).map(cleanBlock);
  if(!errMsg && stopReason==='refusal'){ errMsg = 'Claude declined to answer this one. Try rewording the question.'; }
  if(errMsg){
    askConv.messages.pop();   // drop the unanswered question so the conversation stays valid
    renderAsk();
    $('#askThread').insertAdjacentHTML('beforeend', `<div class="ask-msg bot err">${esc(errMsg)}</div>`);
    $('#askInput').value = $('#askInput').value || text;
    if(!askConv.messages.length && !askConv.id) askConv = null;
    return;
  }
  askConv.messages.push({role:'assistant', content: echoableContent(content)});
  if(stopReason==='pause_turn' || stopReason==='max_tokens') askConv.messages[askConv.messages.length-1].truncated = true;
  askConv.answer = chatText(askConv.messages[askConv.messages.length-1]);
  askConv.updatedAt = new Date().toISOString();
  const rec = {...askConv}; delete rec.id;
  if(askConv.id) await dbSet('research', askConv.id, rec);
  else askConv.id = await dbAdd('research', rec);
  renderAsk(); askScrollEnd();
}
function openAskSettings(){
  const k = claudeKey();
  openModal('Claude settings', `
    <div class="form-grid">
      <div class="field span2"><label>API key</label><div class="mono" style="font-size:13px;">${k ? esc(k.slice(0,10)+'…'+k.slice(-4)) : 'Not set'}</div></div>
      <div class="field span2"><label for="askNewKey">Replace key</label><input id="askNewKey" type="password" placeholder="sk-ant-…" autocomplete="off" autocapitalize="off" spellcheck="false"></div>
      <div class="field span2"><label for="askModelSel">Model</label><select id="askModelSel">${Object.entries(CLAUDE_MODELS).map(([id,m])=>`<option value="${id}" ${claudeModel()===id?'selected':''}>${esc(m.label)} · $${m.inp}/$${m.out} per million tokens</option>`).join('')}</select>
        <div class="footnote" style="margin-top:4px;">Applies to new chats. A typical question with your data costs a few cents.</div></div>
    </div>
    <p class="footnote" style="margin-top:10px;">Manage keys, credit and spend limits at <a href="https://console.anthropic.com" target="_blank" rel="noopener">console.anthropic.com</a>.</p>
    <div class="form-actions wrap"><button class="btn btn-danger" id="askDelKey" style="margin-right:auto;">Remove key</button><button class="btn" id="askSetCancel">Cancel</button><button class="btn btn-accent-pep" id="askSetSave">Save</button></div>
  `, body=>{
    $('#askSetCancel',body).addEventListener('click', closeModal);
    $('#askDelKey',body).addEventListener('click', ()=>{ closeModal(); confirmAction('Remove your Claude API key from this phone? Your saved conversations stay.', ()=>{ lsSet('ledger.claudeKey',''); renderAsk(); }, 'Remove'); });
    $('#askSetSave',body).addEventListener('click', ()=>{
      const nk = $('#askNewKey',body).value.trim();
      if(nk) lsSet('ledger.claudeKey', nk);
      lsSet('ledger.claudeModel', $('#askModelSel',body).value);
      closeModal(); renderAsk();
    });
  });
}
function initAskChat(){
  $('#askKeySave').addEventListener('click', ()=>{
    const k = $('#askKeyInput').value.trim();
    if(!/^sk-ant-/.test(k)){ $('#askKeyInput').focus(); $('#askKeyInput').setCustomValidity('That doesn\'t look like an Anthropic API key (it starts with sk-ant-).'); $('#askKeyInput').reportValidity(); return; }
    $('#askKeyInput').setCustomValidity(''); lsSet('ledger.claudeKey', k); $('#askKeyInput').value = ''; renderAsk();
  });
  $('#askKeyInput').addEventListener('input', ()=> $('#askKeyInput').setCustomValidity(''));
  $('#askSend').addEventListener('click', sendAsk);
  $('#askNew').addEventListener('click', ()=>{ if(askBusy && askAbort) askAbort.abort(); askConv = null; renderAsk(); $('#askInput').focus(); });
  $('#askSettings').addEventListener('click', openAskSettings);
  const inp = $('#askInput');
  inp.addEventListener('input', ()=>{ inp.style.height = 'auto'; inp.style.height = Math.min(140, inp.scrollHeight)+'px'; });
  inp.addEventListener('keydown', e=>{ if(e.key==='Enter' && !e.shiftKey && !('ontouchstart' in window)){ e.preventDefault(); sendAsk(); } });
  renderAsk();
}

/* ===================== Navigation (bottom tab bar) ===================== */
const TABS = {dose:'#doseView', protocols:'#protocolsView', inventory:'#inventoryView', ask:'#askView', progress:'#progressView', tools:'#pepCalcView', resources:'#resourcesView'};
let currentTab = 'dose';
function setTab(name, opts){
  if(!TABS[name]) name = 'dose';
  currentTab = name;
  Object.entries(TABS).forEach(([k,sel])=>{ $(sel).hidden = k!==name; });
  $$('.tabbar [data-tab]').forEach(b=>{ const on = b.dataset.tab===name; b.classList.toggle('active', on); b.setAttribute('aria-current', on ? 'page' : 'false'); });
  lsSet('ledger.tab', name);
  if(name==='tools'){ runCalc(); showAppVersion(); }          // redraw the syringe now that it has a width
  if(name==='progress') renderProgress();
  if(name==='ask') renderAsk();
  if(!(opts && opts.keepScroll)) window.scrollTo(0,0);
}
function initTabs(){
  $$('.tabbar [data-tab]').forEach(b=> b.addEventListener('click', ()=> setTab(b.dataset.tab)));
}

/* ===================== Backup, restore, install ===================== */
function hasAnyData(){ return COLLECTIONS.some(k=> state[k].length); }
function renderBackupNudge(){
  const el = $('#backupNudge'); if(!el) return;
  const last = lsGet('ledger.lastBackup','');
  const stale = !last || daysBetween(last, todayISO()) >= 14;
  const snoozed = lsGet('ledger.nudgeSnooze','') === todayISO();
  el.hidden = !(hasAnyData() && stale && !snoozed && storageMode!=='memory');
  $('#backupNudgeText').textContent = last ? `Last backup ${fmtDate(last)}. Your data lives only on this device.` : 'No backup yet. Your data lives only on this device.';
}
function blobToDataURL(b){ return new Promise((res,rej)=>{ const r = new FileReader(); r.onload = ()=> res(r.result); r.onerror = ()=> rej(r.error); r.readAsDataURL(b); }); }
async function exportBackup(){
  const blobs = {};
  for(const k of await allBlobKeys()){ const b = await getBlob(k); if(b) blobs[k] = await blobToDataURL(b); }
  const payload = {app:'peptide-ledger', format:1, exportedAt:new Date().toISOString(), collections:{}, blobs,
    settings:{weightUnit: weightUnit(), endoWeight: lsGet('ledger.endoWeight',''), urineStrip: lsGet('ledger.urineStrip','10')}};
  COLLECTIONS.forEach(k=> payload.collections[k] = state[k]);
  const name = `peptide-ledger-backup-${todayISO()}.json`;
  const file = new File([JSON.stringify(payload)], name, {type:'application/json'});
  const touch = matchMedia('(pointer: coarse)').matches;
  let done = false;
  if(touch && navigator.canShare && navigator.canShare({files:[file]})){
    try{ await navigator.share({files:[file], title:'Peptide Ledger backup'}); done = true; }
    catch(e){ if(e && e.name==='AbortError') return false; }
  }
  if(!done){
    const url = URL.createObjectURL(file);
    const a = document.createElement('a'); a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(()=> URL.revokeObjectURL(url), 5000);
  }
  lsSet('ledger.lastBackup', todayISO());
  renderBackupNudge();
  return true;
}
async function importBackup(file){
  let data;
  try{ data = JSON.parse(await file.text()); }catch(e){ throw new Error('That file isn\'t a Peptide Ledger backup.'); }
  if(!data || data.app!=='peptide-ledger' || !data.collections) throw new Error('That file isn\'t a Peptide Ledger backup.');
  blobUrlCache.forEach(u=> URL.revokeObjectURL(u)); blobUrlCache.clear();
  await clearBlobs();
  for(const k of COLLECTIONS){ state[k] = Array.isArray(data.collections[k]) ? data.collections[k] : []; await persist(k); }
  let skipped = 0;
  for(const [id, dataUrl] of Object.entries(data.blobs||{})){
    try{ const b = await (await fetch(dataUrl)).blob(); await putBlob(id, b); }catch(e){ skipped++; }
  }
  const s = data.settings || {};
  if(s.weightUnit) lsSet('ledger.weightUnit', s.weightUnit);
  if(s.endoWeight) lsSet('ledger.endoWeight', s.endoWeight);
  if(s.urineStrip) lsSet('ledger.urineStrip', s.urineStrip);
  renderAll();
  return {skipped, exportedAt: data.exportedAt};
}
async function eraseAll(){
  blobUrlCache.forEach(u=> URL.revokeObjectURL(u)); blobUrlCache.clear();
  try{ await clearBlobs(); }catch(e){}
  for(const k of COLLECTIONS){ state[k] = []; await persist(k); }
  renderAll();
}
async function openBackupModal(){
  const counts = [['protocols','Protocols'],['vials','Vials'],['supplies','Supplies'],['checkins','Check-ins'],['photos','Photos'],['labs','Lab draws'],['urine','Urine strips'],['vendors','Vendors']]
    .map(([k,l])=>`<span class="pill pill-muted">${state[k].length} ${l.toLowerCase()}</span>`).join('');
  let usage = '';
  try{
    if(navigator.storage && navigator.storage.estimate){
      const e = await navigator.storage.estimate();
      if(e && e.usage!=null) usage = `About ${(e.usage/1048576).toFixed(1)} MB used on this device.`;
    }
    if(navigator.storage && navigator.storage.persisted){ const pz = await navigator.storage.persisted(); usage += pz ? ' Storage is marked as persistent.' : ''; }
  }catch(e){}
  const last = lsGet('ledger.lastBackup','');
  openModal('Backup & restore', `
    <p style="font-size:14px;margin-bottom:8px;">Everything you enter is saved only in this app on this device. Nothing is sent to a server. A backup file is the only copy that survives a lost phone, a deleted app or cleared browser data.</p>
    <div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px;">${counts}</div>
    <p class="footnote">${last?`Last backup: ${fmtDate(last)}.`:'No backup yet.'} ${esc(usage)}</p>
    <div class="backup-actions">
      <button class="btn btn-accent-pep" id="bkExport">⬇ Export backup file</button>
      <label class="btn" for="bkFile" style="margin:0;color:var(--ink);font-size:13.5px;">⬆ Restore from file</label>
      <input type="file" id="bkFile" accept="application/json,.json" hidden>
    </div>
    <p class="footnote" style="margin-top:8px;">On iPhone, Export opens the share sheet. Choose "Save to Files" (iCloud Drive works well). Restoring replaces everything currently in the app.</p>
    <div class="footnote" id="bkStatus" style="margin-top:8px;min-height:16px;"></div>
    <details style="margin-top:12px;"><summary class="footnote" style="cursor:pointer;">Erase all data</summary>
      <p class="footnote" style="margin:8px 0;">Deletes every protocol, vial, photo and lab result from this device. Export a backup first if you might want it back.</p>
      <button class="btn btn-danger btn-sm" id="bkErase">Erase everything</button>
    </details>
    <div class="form-actions"><button class="btn" id="bkClose">Close</button></div>
  `, body=>{
    const st = $('#bkStatus',body);
    $('#bkClose',body).addEventListener('click', closeModal);
    $('#bkExport',body).addEventListener('click', async ()=>{
      st.textContent = 'Preparing backup…';
      try{ const ok = await exportBackup(); st.textContent = ok ? `Backup created: peptide-ledger-backup-${todayISO()}.json` : 'Export cancelled.'; }
      catch(e){ st.textContent = 'Export failed. Try again.'; }
    });
    $('#bkFile',body).addEventListener('change', ()=>{
      const f = $('#bkFile',body).files[0]; if(!f) return;
      closeModal();
      confirmAction(`Restore from "${f.name}"? This replaces everything currently in the app.`, async ()=>{
        try{
          const r = await importBackup(f);
          openModal('Restored', `<p style="font-size:14px;">Your data was restored${r.exportedAt?` from the backup made ${fmtDate(r.exportedAt.slice(0,10))}`:''}.${r.skipped?` ${r.skipped} photo file(s) couldn't be restored.`:''}</p><div class="form-actions"><button class="btn btn-accent-pep" id="rsOk">OK</button></div>`, b=> $('#rsOk',b).addEventListener('click', closeModal));
        }catch(e){
          openModal('Restore failed', `<p style="font-size:14px;">${esc(e.message||'That file could not be read.')}</p><div class="form-actions"><button class="btn" id="rsOk">OK</button></div>`, b=> $('#rsOk',b).addEventListener('click', closeModal));
        }
      }, 'Replace my data');
    });
    $('#bkErase',body).addEventListener('click', ()=>{
      closeModal();
      confirmAction('Erase all Peptide Ledger data from this device? This cannot be undone.', eraseAll, 'Erase everything');
    });
  });
}
let deferredInstall = null;
function isStandalone(){ return matchMedia('(display-mode: standalone)').matches || navigator.standalone===true; }
function renderInstallCard(){
  const el = $('#installInfo'); if(!el) return;
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform==='MacIntel' && navigator.maxTouchPoints>1);
  if(isStandalone()){ el.innerHTML = `<p class="footnote">Installed. You're running Peptide Ledger as an app.</p>`; return; }
  if(deferredInstall){ el.innerHTML = `<button class="btn btn-accent-pep btn-sm" id="installBtn">Install app</button>`; $('#installBtn').addEventListener('click', async ()=>{ deferredInstall.prompt(); await deferredInstall.userChoice.catch(()=>{}); deferredInstall = null; renderInstallCard(); }); return; }
  el.innerHTML = ios
    ? `<p class="footnote">In Safari, tap the Share button, then <strong>Add to Home Screen</strong>. Open the app from its icon so your data stays in one place.</p>`
    : `<p class="footnote">In Chrome, open the ⋮ menu and choose <strong>Install app</strong> or <strong>Add to Home screen</strong>.</p>`;
}
function showAppVersion(){
  const el = $('#appVersion'); if(!el || !('caches' in window)) return;
  caches.keys().then(keys=>{
    const k = keys.filter(x=> x.startsWith('ledger-shell-')).sort().pop();
    el.textContent = k ? `App version ${k.replace('ledger-shell-','')}` : '';
  }).catch(()=>{});
}
function registerServiceWorker(){
  if(!('serviceWorker' in navigator) || location.protocol==='file:') return;
  navigator.serviceWorker.register('./sw.js').then(reg=>{
    const show = ()=>{ $('#updateBanner').hidden = false; };
    if(reg.waiting && navigator.serviceWorker.controller) show();
    reg.addEventListener('updatefound', ()=>{
      const w = reg.installing;
      if(w) w.addEventListener('statechange', ()=>{ if(w.state==='installed' && navigator.serviceWorker.controller) show(); });
    });
    $('#updateBtn').addEventListener('click', ()=>{ if(reg.waiting) reg.waiting.postMessage('skipWaiting'); else location.reload(); });
    document.addEventListener('visibilitychange', ()=>{ if(!document.hidden) reg.update().catch(()=>{}); });
  }).catch(e=> console.warn('Service worker registration failed', e));
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', ()=>{ if(reloading) return; reloading = true; location.reload(); });
}

/* ===================== Render all ===================== */
function renderAll(){
  renderProtocols();
  renderUpcoming();
  renderRecentDoses();
  renderProtocolManager();
  renderSerum();
  renderArchivedProtocols();
  renderVials();
  renderSupplyGroups();
  renderProtocolSupplyList();
  renderSupplyDepletion();
  renderVendors();
  renderSupplyVendors();
  renderCostTracking();
  renderResearch();
  if(currentTab==='progress') renderProgress();
  renderBackupNudge();
}

/* ===================== Boot ===================== */
async function boot(){
  populatePresetSelect();
  runCalc();
  initTabs();
  initAsk();
  initAskChat();
  initProgress();
  $('#syncPill').addEventListener('click', openBackupModal);
  $('#backupNudgeBtn').addEventListener('click', openBackupModal);
  $('#backupNudgeDismiss').addEventListener('click', ()=>{ lsSet('ledger.nudgeSnooze', todayISO()); renderBackupNudge(); });
  $('#openBackupBtn').addEventListener('click', openBackupModal);
  window.addEventListener('beforeinstallprompt', e=>{ e.preventDefault(); deferredInstall = e; renderInstallCard(); });
  window.addEventListener('appinstalled', ()=>{ deferredInstall = null; renderInstallCard(); });
  renderInstallCard();
  await loadAll();
  loadCheckinForm($('#ciDate').value || todayISO());   // the form was filled before records loaded
  renderStoragePill();
  setTab('dose', {keepScroll:true});   // the app always opens on Dose
  renderAll();
  registerServiceWorker();
  showAppVersion();
  // Day boundaries: refresh "today" whenever the app comes back to the foreground.
  let lastDay = doseDayISO();
  document.addEventListener('visibilitychange', ()=>{
    if(document.hidden) return;
    if(doseDayISO()!==lastDay){ lastDay = doseDayISO(); $('#ciDate').max = todayISO(); }
    renderAll();
  });
}
boot();

})();
