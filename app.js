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
// Dose and draw are the working pair: typing a draw recalculates the dose and vice versa.
// Editing vial or water keeps whichever field is currently calculated (a cleared field becomes calculated).
function calcEdited(f){
  let t = calcOrder[0];
  if(f==='draw') t = 'dose';
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
      <div class="field"><label>Additional compound ${i+1}</label><input type="text" list="endoCompounds" data-f="name" value="${esc(r.name)}" placeholder="Compound"></div>
      <div class="field"><label>Dose</label><div style="display:flex;gap:6px;"><input type="number" data-f="dose" inputmode="decimal" min="0" step="any" value="${esc(r.dose)}" style="flex:1;min-width:0;"><select data-f="unit" style="width:76px;"><option value="mcg" ${r.unit==='mcg'?'selected':''}>mcg</option><option value="mg" ${r.unit==='mg'?'selected':''}>mg</option></select></div></div>
      <div class="field"><label>EU/mg from your lab test</label><input type="number" data-f="eumg" inputmode="decimal" min="0" step="any" value="${esc(r.eumg)}"></div>
      <button class="btn btn-sm rm" type="button" data-rm="${i}">Remove</button>
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

$('#resourceLinks').innerHTML = `
  <a class="link-chip" href="https://peptidebenchmark.com" target="_blank" rel="noopener">📊 PeptideBenchmark</a>
  <a class="link-chip" href="https://www.peptidedeck.com/peptide-calculator" target="_blank" rel="noopener">🧮 PeptideDeck calculator</a>
  <a class="link-chip" href="https://peptidesafe.lovable.app/" target="_blank" rel="noopener">🧪 PeptideSafe endotoxin calculator</a>
  <a class="link-chip" href="https://www.peptidedeck.com/blog" target="_blank" rel="noopener">📚 PeptideDeck research blog</a>
  <a class="link-chip" href="https://stacked.health" target="_blank" rel="noopener">📦 Stacked</a>
`;
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
  el.innerHTML = ordered.map(p=> doseCardHTML(p, colorMap.get(p.id) || PROTOCOL_COLORS[0], day, serum)).join('');
  $$('[data-syr-units]',el).forEach(w=> renderSyringeInto(w, num(w.dataset.syrUnits,0), num(w.dataset.syrCap,100), {compact:true, color: w.dataset.syrColor||undefined}));
  $$('[data-card-toggle]',el).forEach(h=> h.addEventListener('click', ()=>{
    const id = h.dataset.cardToggle;
    if(expandedCards.has(id)) expandedCards.delete(id); else expandedCards.add(id);
    renderProtocols();
  }));
  $$('[data-card-toggle]',el).forEach(h=> h.addEventListener('keydown', e=>{ if(e.target===h && (e.key==='Enter'||e.key===' ')){ e.preventDefault(); h.click(); } }));
  $$('[data-mark-dose]',el).forEach(b=> b.addEventListener('click', e=>{
    e.stopPropagation();
    const p = state.protocols.find(x=>x.id===b.dataset.markDose);
    if(!p) return;
    if(injectionsOn(p, doseDayISO()) >= splitCount(p)) confirmAction(`Undo today's logged ${p.compound||''} dose?`, ()=> markDoseTaken(p), 'Undo dose');
    else markDoseTaken(p);
  }));
  $$('[data-dose-history]',el).forEach(b=> b.addEventListener('click', e=>{ e.stopPropagation(); openDoseHistoryModal(state.protocols.find(p=>p.id===b.dataset.doseHistory)); }));
  $$('[data-edit-protocol]',el).forEach(b=> b.addEventListener('click', e=>{ e.stopPropagation(); openProtocolModal(state.protocols.find(p=>p.id===b.dataset.editProtocol)); }));
  $$('[data-goto-checkin]',el).forEach(b=> b.addEventListener('click', e=>{ e.stopPropagation(); setTab('progress'); }));
  $$('[data-full-chart]',el).forEach(b=> b.addEventListener('click', e=>{
    e.stopPropagation();
    serumSel = b.dataset.fullChart; lsSet('ledger.serumSel', serumSel); renderSerum();
    const c = $('#serumCard'); if(c) c.scrollIntoView({behavior:'smooth', block:'start'});
  }));
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
function doseCardHTML(p, color, day, serum){
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
  const open = expandedCards.has(p.id);
  const logBtn = notStarted ? '' : `<button type="button" class="dc-log ${complete&&done>0?'done':''}" data-mark-dose="${p.id}" aria-label="${complete&&done>0?'Dose logged today. Tap to undo':'Log dose now'}" title="${complete&&done>0?'Logged. Tap to undo':'Log dose'}">${complete&&done>0 ? CHECK_ICON : SYRINGE_ICON}</button>`;
  const head = `<div class="dc-head" data-card-toggle="${p.id}" role="button" tabindex="0" aria-expanded="${open}">
      ${open ? `<div class="dc-ring" style="border-color:${color}"><span class="mono">${esc(amt)}</span>${u!=null?`<span class="mono dc-u">${u}u</span>`:''}</div>`
             : `<div class="dc-amt"><span class="mono">${esc(amt)}</span>${u!=null?`<span class="mono dc-u">${u}u</span>`:''}</div>`}
      <div class="dc-main">
        <div class="dc-title"><strong class="dc-name">${esc(p.compound||'Untitled')}</strong><span class="dc-chev" aria-hidden="true">${open?'▴':'▾'}</span></div>
        <div class="dc-tags"><span class="dc-tag info">${esc(scheduleTag(p))}</span><span class="dc-tag ${stCls}">${esc(status)}</span></div>
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
      <svg viewBox="0 0 ${SV.W} ${SV.H}" class="chart dc-mini" role="img" aria-label="Estimated level of ${esc(p.compound||'')} over the last week">${serumSvgInner(ctx, now + 2*24*HOUR, 7*24*HOUR)}</svg>
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
      <div class="dc-sec"><h4>Quick actions</h4>
        <div class="qa-grid">
          ${notStarted ? '' : `<button type="button" class="qa-btn primary" data-mark-dose="${p.id}">${complete&&done>0 ? CHECK_ICON+'<span>Undo dose</span>' : SYRINGE_ICON+'<span>Log dose</span>'}</button>`}
          <button type="button" class="qa-btn" data-dose-history="${p.id}"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="5" width="16" height="15" rx="2"/><path d="M8 3v4M16 3v4M4 10h16"/></svg><span>History &amp; backfill</span></button>
          <button type="button" class="qa-btn" data-goto-checkin><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 12h4l3-7 4 14 3-7h4"/></svg><span>Add check-in</span></button>
          <button type="button" class="qa-btn" data-edit-protocol="${p.id}"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="4" width="14" height="17" rx="2"/><path d="M9 4.5V3h6v1.5"/><path d="M8.5 10h7M8.5 14h7"/></svg><span>Protocol</span></button>
        </div>
      </div>
      ${comp}
      ${syr}
      <div class="dc-sec">${siteRowHTML(p).replace('class="site-row"','class="site-row" style="margin-top:0"')}</div>
      ${snap}
    </div>`;
  return `<div class="dc open" style="--pc:${color}">${head}${body}</div>`;
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
  const list = c ? state.vials.filter(v=> (v.compound||'').trim().toLowerCase()===c) : [];
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
let serumSel = lsGet('ledger.serumSel','all');
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
  const el = $('#serumBody');
  if(!el) return;
  const {series, missing} = serumSeries();
  const miss = missing.length ? `<p class="footnote" style="margin-top:8px;">No half-life for ${missing.map(m=>esc(m)).join(', ')}. Edit the protocol and enter one to chart it.</p>` : '';
  if(!series.length){
    el.innerHTML = `<div class="empty"><div class="glyph">📉</div><p>Add a protocol and log a dose to see the level of it in your body over time.</p></div>${miss}`;
    return;
  }
  if(serumSel!=='all' && !series.some(s=>s.p.id===serumSel)) serumSel = 'all';
  const now = Date.now();
  const shownS = serumSel==='all' ? series : series.filter(s=>s.p.id===serumSel);
  const ctx = serumCtx(shownS, now, serumSel==='all' && new Set(shownS.map(s=>s.p.id)).size>1);
  const earliest = Math.min(now, ...series.flatMap(s=> s.evs.map(e=>e.t)));
  const clampEnd = t1=> Math.max(earliest + serumWinMs()*0.25, Math.min(now + 30*24*HOUR, t1));
  let t1 = serumEnd==null ? serumFollowEnd(now) : clampEnd(serumEnd);
  const chipIds = [...new Map(series.map(s=>[s.p.id, s.p.compound||'Untitled'])).entries()];
  const chips = [['all','All']].concat(chipIds).map(([id,label])=>
    `<button type="button" class="chip-btn ${serumSel===id?'on':''}" data-serum-sel="${esc(id)}">${esc(label)}</button>`).join('');
  const wins = SERUM_WINDOWS.map(([k])=> `<button type="button" class="chip-btn ${serumWin===k?'on':''}" data-serum-win="${k}">${k}</button>`).join('');
  const rows = series.map(s=>{
    const cur = levelAt(s.evs, s.hl, now);
    const lastPeak = Math.max(0, ...s.evs.filter(e=>e.t<=now).map(e=>levelAt(s.evs, s.hl, e.t)));
    const last = s.evs.filter(e=>e.t<=now).sort((a,b)=>b.t-a.t)[0];
    return `<div class="serum-row"><span class="serum-dot" style="background:${s.color}"></span>
      <span class="serum-name"><strong>${esc(s.label)}</strong><span class="footnote">${s.sub?` · ${esc(s.sub)}`:''} · t½ ${esc(fmtHours(s.hl))}${last?'':' · no doses logged'}</span></span>
      <span class="mono serum-val">${esc(fmtAmount(cur))}${lastPeak>0?` <span class="footnote">${Math.round(cur/lastPeak*100)}% of peak</span>`:''}</span></div>`;
  }).join('');
  el.innerHTML = `
    <div class="chip-row" style="margin-bottom:8px;">${chips}</div>
    <div class="chip-row">${wins}</div>
    <div class="serum-pan">
      <svg viewBox="0 0 ${SV.W} ${SV.H}" class="chart" id="serumSvg" role="img" aria-label="Estimated serum level over time. Drag left or right to move through time.">${serumSvgInner(ctx, t1)}</svg>
    </div>
    <div class="serum-nav"><span class="footnote" id="serumRangeLbl"></span><button type="button" class="btn btn-sm" id="serumNow" ${serumEnd==null?'hidden':''}>↺ Back to now</button></div>
    ${rows}
    <p class="footnote" style="margin-top:8px;">Drag the chart left or right to see past and future levels. ${ctx.pct?'Compounds are shown as % of their own peak so they fit one scale. Pick one for actual amounts. ':''}Estimate of the amount in your body assuming each injection is fully absorbed at once and clears by its half-life. Solid line is logged doses; dashed line adds scheduled doses. Not a blood test.</p>${miss}`;
  const svg = $('#serumSvg',el), lbl = $('#serumRangeLbl',el), nowBtn = $('#serumNow',el);
  const rangeText = ()=>{
    const t0 = t1 - serumWinMs();
    const f = t=> new Date(t).toLocaleString(undefined, serumWinMs()<=24*HOUR ? {month:'short', day:'numeric', hour:'numeric', minute:'2-digit'} : {month:'short', day:'numeric'});
    lbl.textContent = `${f(t0)} – ${f(t1)}`;
  };
  rangeText();
  let raf = 0;
  const draw = ()=>{ raf = 0; svg.innerHTML = serumSvgInner(ctx, t1); rangeText(); nowBtn.hidden = serumEnd==null; };
  let drag = null;
  svg.addEventListener('pointerdown', e=>{
    drag = {x:e.clientX, t1, id:e.pointerId, moved:false};
    try{ svg.setPointerCapture(e.pointerId); }catch(_){}
  });
  svg.addEventListener('pointermove', e=>{
    if(!drag || e.pointerId!==drag.id) return;
    const r = svg.getBoundingClientRect();
    const plotPx = r.width * (SV.W-SV.padL-SV.padR)/SV.W;
    const dx = e.clientX - drag.x;
    if(Math.abs(dx) > 3) drag.moved = true;
    t1 = clampEnd(drag.t1 - dx/plotPx*serumWinMs());
    serumEnd = t1;
    if(!raf) raf = requestAnimationFrame(draw);
  });
  const endDrag = ()=>{ drag = null; };
  svg.addEventListener('pointerup', endDrag);
  svg.addEventListener('pointercancel', endDrag);
  nowBtn.addEventListener('click', ()=>{ serumEnd = null; t1 = serumFollowEnd(now); draw(); });
  $$('[data-serum-sel]',el).forEach(b=> b.addEventListener('click', ()=>{ serumSel = b.dataset.serumSel; lsSet('ledger.serumSel', serumSel); renderSerum(); }));
  $$('[data-serum-win]',el).forEach(b=> b.addEventListener('click', ()=>{
    // keep the same centre point when switching windows, unless following now
    const centre = serumEnd==null ? null : t1 - serumWinMs()/2;
    serumWin = b.dataset.serumWin; lsSet('ledger.serumWin', serumWin);
    if(centre!=null) serumEnd = centre + serumWinMs()/2;
    renderSerum();
  }));
}

/* ===================== Peptides: Stash ===================== */
function renderVials(){
  const el = $('#vialList');
  if(!state.vials.length){
    el.innerHTML = `<div class="empty"><div class="glyph">🧪</div><p>No vials logged. Add one to see how long your stash will last.</p></div>`;
    return;
  }
  const groups = {};
  const order = [];
  state.vials.forEach(v=>{
    const key = v.compound || 'Vial';
    if(!groups[key]){ groups[key] = []; order.push(key); }
    groups[key].push(v);
  });
  const BUD_MAX = 8640000000000000;
  order.sort((a,b)=> a.localeCompare(b, undefined, {sensitivity:'base'}));
  el.innerHTML = order.map(compound=>{
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
    const rows = lots.map((v,i)=>{
      const calc = calcs[i];
      const low = calc && calc.daysRemaining!=null && calc.daysRemaining<=7;
      const budDays = v.bud ? daysBetween(todayISO(), v.bud) : null;
      const budSoon = budDays!=null && budDays<=7;
      const activeFor = state.protocols.find(p=> p.status!=='archived' && p.activeVialId===v.id);
      const isOpen = v.remainingMg!=null;
      const pct = isOpen && num(v.mgPerVial,0)>0 ? Math.max(0,Math.min(100,(v.remainingMg/num(v.mgPerVial,1))*100)) : null;
      return `<div class="card-flat supply-item-card" data-open-vial="${v.id}" style="margin-bottom:6px;min-width:0;cursor:pointer;">
        <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;">
          ${v.pharmacy? `<span class="pill pill-tar">${esc(v.pharmacy)}</span>` : ''}
          ${v.concentration? `<span class="pill pill-muted">${num(v.concentration)} mg/mL</span>` : ''}
          ${num(v.qty,1)>1? `<span class="pill pill-muted">×${num(v.qty,1)} sealed</span>` : ''}
          ${v.bud? `<span class="pill ${budSoon?'pill-warn':'pill-info'}">BUD ${fmtDateShort(v.bud)}</span>` : ''}
          ${activeFor? `<span class="pill pill-pep">In use — ${esc(activeFor.compound||'protocol')}</span>` : ''}
        </div>
        ${isOpen ? `
        <div style="margin-top:8px;">
          <div style="display:flex;justify-content:space-between;font-size:11.5px;color:var(--muted);margin-bottom:3px;">
            <span>${Math.round(v.remainingMg*10)/10}mg left of ${num(v.mgPerVial,0)}mg</span>
            <span>${Math.round(pct)}%</span>
          </div>
          <div class="progress-track"><div class="progress-fill" style="width:${pct}%;background:${pct<=15?'var(--warn)':'var(--accent-pep)'};"></div></div>
        </div>` : `
        <div style="margin-top:6px;">
          ${calc && calc.daysRemaining!=null ? `<span class="pill ${low?'pill-warn':'pill-good'}">${calc.daysRemaining<=0?'Out':calc.daysRemaining+'d left'}</span>` : `<span class="pill pill-muted">Link a protocol</span>`}
        </div>`}
        ${labTestHTML(v)}
        <div class="footnote" style="margin-top:6px;overflow-wrap:anywhere;">${num(v.mgPerVial,0)}mg vial${v.dateOpened? ' · opened '+fmtDateShort(v.dateOpened) : ' · unopened'}${v.lot? ' · Lot '+esc(v.lot) : ''}${v.price? ' · $'+num(v.price).toFixed(2) : ''}</div>
      </div>`;
    }).join('');
    return `<div style="margin-bottom:14px;">
      <div style="margin-bottom:6px;">
        <strong>${esc(compound)}</strong>
        <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-top:4px;">
          <span class="pill pill-muted">${totalQty} vial${totalQty===1?'':'s'}</span>
          ${anyCalc ? `<span class="pill ${totalLow?'pill-warn':'pill-good'}">${totalDays<=0?'Out':'~'+totalDays+'d left'}</span>` : ''}
        </div>
      </div>
      ${rows}
    </div>`;
  }).join('');
  $$('[data-open-vial]',el).forEach(card=> card.addEventListener('click', e=>{ if(e.target.closest('[data-coa]')) return; openVialModal(state.vials.find(v=>v.id===card.dataset.openVial)); }));
}
/* Lab tests on a vial: the first lives in flat fields (testLab, testMassMg, …); more go in v.extraTests. */
function testFilled(t){ return !!(t && (t.lab || t.massMg || t.purity || t.endo || t.coaUrl)); }
function vialTests(v){
  const first = {lab:v.testLab||'', massMg:v.testMassMg||'', purity:v.testPurity||'', endo:v.testEndo||'', date:v.testDate||'', coaUrl:v.coaUrl||''};
  const extra = Array.isArray(v.extraTests) ? v.extraTests : [];
  return [first].concat(extra).filter(testFilled);
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
function openVialModal(existing){
  const v = existing || {};
  const protocolOptions = state.protocols.map(p=>`<option value="${p.id}" ${v.protocolId===p.id?'selected':''}>${esc(p.compound)}</option>`).join('');
  openModal(existing?'Edit vial':'Add vial', `
    <div class="form-grid">
      <div class="field span2"><label for="vCompound">Compound</label><input id="vCompound" type="text" value="${esc(v.compound||'')}"></div>
      <div class="field"><label for="vMg">mg per vial</label><input id="vMg" type="number" step="any" value="${esc(v.mgPerVial||'')}"></div>
      <div class="field"><label for="vQty">Qty (identical vials)</label><input id="vQty" type="number" step="1" min="1" value="${esc(v.qty||1)}"></div>
      <div class="field"><label for="vConc">Concentration (mg/mL)</label><input id="vConc" type="number" step="any" value="${esc(v.concentration||'')}" placeholder="After reconstitution"></div>
      <div class="field"><label for="vPrice">Price paid ($, for this whole entry)</label><input id="vPrice" type="number" step="any" value="${esc(v.price||'')}" placeholder="e.g. 65"></div>
      <div class="field"><label for="vLot">Lot #</label><input id="vLot" type="text" value="${esc(v.lot||'')}"></div>
      <div class="field"><label for="vPharmacy">Pharmacy</label><input id="vPharmacy" type="text" value="${esc(v.pharmacy||'')}" placeholder="e.g. BPI, Olympia"></div>
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
    if(existing){
      $('#vDelete',body).addEventListener('click', ()=>{ closeModal(); confirmAction('Delete this vial?', ()=> dbDelete('vials', existing.id)); });
    }
    $('#vCancel',body).addEventListener('click', closeModal);
    $('#vSave',body).addEventListener('click', async ()=>{
      const compound = $('#vCompound',body).value.trim();
      if(!compound) return;
      const data = {...stripId(v), compound, mgPerVial:$('#vMg',body).value, qty:$('#vQty',body).value||1, concentration:$('#vConc',body).value, price:$('#vPrice',body).value, lot:$('#vLot',body).value.trim(), pharmacy:$('#vPharmacy',body).value.trim(),
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
    const mgTotal = num(vial.mgPerVial,0)*(num(vial.qty,1) + (vial.remainingMg!=null ? 1 : 0));   // opening a vial moves one out of the sealed count
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
/* Small, safe-enough markdown -> HTML for LLM answers: bold, links, pipe tables, bullet lists, paragraphs.
   Escapes everything first, then re-introduces only the handful of tags it builds itself. */
function mdToHtml(md){
  const lines = (md||'').replace(/\r\n/g,'\n').split('\n');
  let html = '', i = 0, inList = false;
  const inline = (s)=> esc(s)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  function closeList(){ if(inList){ html += '</ul>'; inList=false; } }
  while(i<lines.length){
    const line = lines[i];
    if(/^\s*\|.*\|\s*$/.test(line) && lines[i+1] && /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i+1])){
      closeList();
      const header = line.trim().replace(/^\||\|$/g,'').split('|').map(c=>c.trim());
      let body = [];
      let j = i+2;
      while(j<lines.length && /^\s*\|.*\|\s*$/.test(lines[j])){
        body.push(lines[j].trim().replace(/^\||\|$/g,'').split('|').map(c=>c.trim()));
        j++;
      }
      html += `<table><thead><tr>${header.map(h=>`<th>${inline(h)}</th>`).join('')}</tr></thead><tbody>${
        body.map(r=>`<tr>${r.map(c=>`<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
      i = j; continue;
    }
    if(/^\s*[-*]\s+/.test(line)){
      if(!inList){ html += '<ul>'; inList=true; }
      html += `<li>${inline(line.replace(/^\s*[-*]\s+/,''))}</li>`;
      i++; continue;
    }
    closeList();
    if(line.trim()) html += `<p>${inline(line)}</p>`;
    i++;
  }
  closeList();
  return html || `<p>${inline(md||'')}</p>`;
}
function renderResearch(){
  const el = $('#researchList');
  if(!state.research.length){
    el.innerHTML = `<div class="empty"><div class="glyph">🔎</div><p>Ask a question above, or log findings from chat here for later reference.</p></div>`;
    return;
  }
  el.innerHTML = state.research.slice().reverse().map(r=>`
    <div class="research-item">
      <div style="display:flex;justify-content:space-between;gap:8px;">
        <div>
          <h4>${esc(r.topic||'Untitled')}</h4>
          <div class="meta">${fmtDate(r.createdAt||todayISO())}</div>
        </div>
        <button class="icon-btn" data-del-research="${r.id}">✕</button>
      </div>
      <div class="research-body research-md">${mdToHtml(r.answer||r.notes||'')}</div>
    </div>`).join('');
  $$('[data-del-research]',el).forEach(b=> b.addEventListener('click', ()=> dbDelete('research', b.dataset.delResearch)));
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
  return `<svg viewBox="0 0 ${W} ${H}" class="chart" role="img" aria-label="${esc(opts.label||'Chart')}">${g}</svg>`;
}

/* ===================== Progress: daily check-ins ===================== */
const ENERGY_LEVELS = [1,2,3,4,5];
function weightUnit(){ return lsGet('ledger.weightUnit','lb')==='kg' ? 'kg' : 'lb'; }
function toUnit(w, from, to){ const n = num(w,null); if(n==null) return null; if(from===to) return n; return to==='kg' ? n*0.45359237 : n/0.45359237; }
function checkinFor(iso){ return state.checkins.find(c=>c.date===iso) || null; }
let ciMood = null, ciEnergy = null;
function loadCheckinForm(iso){
  const c = checkinFor(iso);
  $('#ciDate').value = iso;
  const wu = weightUnit();
  $('#ciUnit').value = wu;
  const w = c ? toUnit(c.weight, c.weightUnit||wu, wu) : null;
  $('#ciWeight').value = w!=null ? Math.round(w*10)/10 : '';
  ciMood = c ? (c.mood||null) : null;
  ciEnergy = c ? (c.energy||null) : null;
  $('#ciNote').value = c ? (c.note||'') : '';
  $('#ciStatus').textContent = c ? `Editing the entry for ${fmtDateShort(iso)}.` : '';
  $('#ciDelete').hidden = !c;
  drawCheckinScales();
}
function drawCheckinScales(){
  $('#ciMood').innerHTML = MOOD_FACES.map(f=>`<button type="button" class="mood-btn ${ciMood===f.score?'on':''}" data-ci-mood="${f.score}" aria-label="Mood: ${f.label}" aria-pressed="${ciMood===f.score}">${f.face}</button>`).join('');
  $('#ciEnergy').innerHTML = ENERGY_LEVELS.map(n=>`<button type="button" class="energy-btn ${ciEnergy===n?'on':''}" data-ci-energy="${n}" aria-label="Energy ${n} of 5" aria-pressed="${ciEnergy===n}"><span class="bolts">${'⚡'.repeat(Math.min(n,3))}</span><span class="mono">${n}</span></button>`).join('');
}
function initCheckinForm(){
  const maxISO = todayISO();
  $('#ciDate').max = maxISO;
  loadCheckinForm(maxISO);
  $('#ciDate').addEventListener('change', ()=>{ const v = $('#ciDate').value; if(v) loadCheckinForm(v > maxISO ? maxISO : v); });
  $('#ciUnit').addEventListener('change', ()=>{ lsSet('ledger.weightUnit', $('#ciUnit').value); renderProgress(); });
  $('#ciMood').addEventListener('click', e=>{ const b = e.target.closest('[data-ci-mood]'); if(!b) return; const v = +b.dataset.ciMood; ciMood = ciMood===v ? null : v; drawCheckinScales(); });
  $('#ciEnergy').addEventListener('click', e=>{ const b = e.target.closest('[data-ci-energy]'); if(!b) return; const v = +b.dataset.ciEnergy; ciEnergy = ciEnergy===v ? null : v; drawCheckinScales(); });
  $('#ciSave').addEventListener('click', async ()=>{
    const date = $('#ciDate').value || todayISO();
    const weight = $('#ciWeight').value.trim();
    const note = $('#ciNote').value.trim();
    if(!weight && !ciMood && !ciEnergy && !note){ $('#ciStatus').textContent = 'Add a weight, mood, energy or note first.'; return; }
    const data = {date, weight: weight ? num(weight) : null, weightUnit: $('#ciUnit').value, mood: ciMood, energy: ciEnergy, note};
    const existing = checkinFor(date);
    if(existing) await dbSet('checkins', existing.id, data); else await dbAdd('checkins', data);
    $('#ciStatus').textContent = `Saved for ${fmtDateShort(date)}.`;
    $('#ciDelete').hidden = false;
  });
  $('#ciDelete').addEventListener('click', ()=>{
    const c = checkinFor($('#ciDate').value); if(!c) return;
    confirmAction(`Delete the check-in for ${fmtDateShort(c.date)}?`, async ()=>{ await dbDelete('checkins', c.id); loadCheckinForm(c.date); });
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
  const {from, to} = trendWindow();
  const wu = weightUnit();
  const cw = el.clientWidth || Math.min(640, window.innerWidth - 64);
  const inRange = state.checkins.filter(c=> c.date>=from && c.date<=to).sort((a,b)=> a.date.localeCompare(b.date));
  const wPts = inRange.filter(c=> num(c.weight,null)!=null).map(c=>({x:c.date, y: Math.round(toUnit(c.weight, c.weightUnit||wu, wu)*10)/10}));
  const mPts = inRange.filter(c=> c.mood).map(c=>({x:c.date, y:c.mood}));
  const ePts = inRange.filter(c=> c.energy).map(c=>({x:c.date, y:c.energy}));
  const markers = protocolMarkers();
  const avg = a => a.length ? (a.reduce((s,p)=>s+p.y,0)/a.length) : null;
  let html = '';
  // Weight
  html += `<div class="trend-block"><div class="trend-head"><h4>Weight</h4>`;
  if(wPts.length){
    const delta = wPts.length>1 ? Math.round((wPts[wPts.length-1].y - wPts[0].y)*10)/10 : null;
    html += `<div class="trend-stats"><span><strong class="mono">${wPts[wPts.length-1].y} ${wu}</strong> latest</span>${delta!=null?`<span class="pill ${delta<0?'pill-good':delta>0?'pill-pep':'pill-muted'}">${delta>0?'+':''}${delta} ${wu} in range</span>`:''}</div></div>`;
    html += lineChartSVG({series:[{name:'Weight', color:'var(--accent-pep)', points:wPts, unit:wu}], from, to, markers, width:cw, label:`Weight from ${fmtDateShort(from)} to ${fmtDateShort(to)}`, fmtY: v=> String(Math.round(v*10)/10)});
  } else html += `</div><div class="empty" style="padding:14px 8px;"><p>No weights logged in this range.</p></div>`;
  html += `</div>`;
  // Mood & energy
  html += `<div class="trend-block"><div class="trend-head"><h4>Mood &amp; energy</h4>`;
  if(mPts.length || ePts.length){
    const am = avg(mPts), ae = avg(ePts);
    html += `<div class="trend-stats">${am!=null?`<span><strong class="mono">${am.toFixed(1)}</strong> avg mood</span>`:''}${ae!=null?`<span><strong class="mono">${ae.toFixed(1)}</strong> avg energy</span>`:''}</div></div>`;
    html += lineChartSVG({series:[{name:'Mood', color:'var(--accent-pep)', points:mPts}, {name:'Energy', color:'var(--info)', points:ePts}], from, to, markers, width:cw, yFixed:[1,5], yTicks:[1,2,3,4,5], label:'Mood and energy, scored 1 to 5', labelLast:false, height:180});
    html += `<div class="chart-legend"><span><i style="background:var(--accent-pep)"></i>Mood (1 ${moodFace(1)} to 5 ${moodFace(5)})</span><span><i style="background:var(--info)"></i>Energy (1 to 5)</span></div>`;
  } else html += `</div><div class="empty" style="padding:14px 8px;"><p>No mood or energy scores in this range.</p></div>`;
  html += `</div>`;
  el.innerHTML = html;
  $('#trendRangeLabel').textContent = `${fmtDate(from)} to ${fmtDate(to)}`;
  renderCheckinList();
  renderPhotos();
}
function renderCheckinList(){
  const el = $('#checkinList'); if(!el) return;
  const list = state.checkins.slice().sort((a,b)=> b.date.localeCompare(a.date)).slice(0,14);
  if(!list.length){ el.innerHTML = `<div class="empty" style="padding:14px 8px;"><p>No check-ins yet. Log today's above. You can also pick an earlier date to fill in past days.</p></div>`; return; }
  const wu = weightUnit();
  el.innerHTML = list.map(c=>{
    const w = num(c.weight,null)!=null ? Math.round(toUnit(c.weight, c.weightUnit||wu, wu)*10)/10 : null;
    return `<button type="button" class="ci-row" data-edit-ci="${c.date}">
      <span class="ci-date"><strong>${fmtDateShort(c.date)}</strong></span>
      <span class="ci-vals">${w!=null?`<span class="mono">${w} ${wu}</span>`:''}${c.mood?`<span>${moodFace(c.mood)}</span>`:''}${c.energy?`<span class="mono">⚡${c.energy}</span>`:''}</span>
      ${c.note?`<span class="ci-note">${esc(c.note)}</span>`:''}
    </button>`;
  }).join('');
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
      <div class="field span2"><label for="phFile">Photo</label><input id="phFile" type="file" accept="image/*"></div>
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
    <div class="form-actions"><button class="btn btn-danger" id="phDel" style="margin-right:auto;">Delete</button><button class="btn btn-accent-pep" id="phClose">Close</button></div>
  `, body=>{
    $('#phClose',body).addEventListener('click', closeModal);
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
async function openCompareModal(ids){
  const ps = ids.map(id=> state.photos.find(x=>x.id===id)).filter(Boolean).sort((a,b)=> a.date.localeCompare(b.date));
  if(ps.length!==2) return;
  const urls = await Promise.all(ps.map(p=> blobUrl(p.id)));
  const gap = daysBetween(ps[0].date, ps[1].date);
  openModal(`Compare: ${gap} day${gap===1?'':'s'} apart`, `
    <div class="ph-compare">${ps.map((p,i)=>`<figure>${urls[i]?`<img src="${urls[i]}" alt="${esc(p.angle)} photo from ${fmtDate(p.date)}">`:''}<figcaption><strong>${i===0?'Before':'After'}</strong> · ${fmtDateShort(p.date)} · ${esc(p.angle)}</figcaption></figure>`).join('')}</div>
    <div class="form-actions"><button class="btn btn-accent-pep" id="cmpClose">Close</button></div>
  `, body=> $('#cmpClose',body).addEventListener('click', closeModal));
}
function initProgress(){
  initCheckinForm();
  initPhotos();
  $('#trendRange').addEventListener('click', e=>{
    const b = e.target.closest('[data-range]'); if(!b) return;
    trendRange = b.dataset.range; lsSet('ledger.trendRange', trendRange);
    if(trendRange==='Custom' && !$('#trendFrom').value){ $('#trendFrom').value = addDays(todayISO(),-89); $('#trendTo').value = todayISO(); }
    renderProgress();
  });
  ['#trendFrom','#trendTo','#trendMarkers'].forEach(s=> $(s).addEventListener('change', renderProgress));
  $('#checkinList').addEventListener('click', e=>{
    const b = e.target.closest('[data-edit-ci]'); if(!b) return;
    loadCheckinForm(b.dataset.editCi);
    $('#checkinCard').scrollIntoView({behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block:'start'});
  });
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
    vials: state.vials.map(v=>({compound:v.compound, mgPerVial:num(v.mgPerVial,null), qty:num(v.qty,1), price:v.price?num(v.price):null, pharmacy:v.pharmacy||null, concentration:v.concentration?num(v.concentration):null, remainingMg: v.remainingMg??null, bud: v.bud||null, labTests: vialTests(v).map(t=>({lab:t.lab||null, massMg:num(t.massMg,null), purityPct:num(t.purity,null), endotoxinEUperMg:num(t.endo,null), date:t.date||null, coa:safeUrl(t.coaUrl)||null}))})),
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

/* ===================== Navigation (bottom tab bar) ===================== */
const TABS = {dose:'#doseView', protocols:'#protocolsView', inventory:'#inventoryView', progress:'#progressView', tools:'#pepCalcView', resources:'#resourcesView'};
let currentTab = 'dose';
function setTab(name, opts){
  if(!TABS[name]) name = 'dose';
  currentTab = name;
  Object.entries(TABS).forEach(([k,sel])=>{ $(sel).hidden = k!==name; });
  $$('.tabbar [data-tab]').forEach(b=>{ const on = b.dataset.tab===name; b.classList.toggle('active', on); b.setAttribute('aria-current', on ? 'page' : 'false'); });
  lsSet('ledger.tab', name);
  if(name==='tools') runCalc();          // redraw the syringe now that it has a width
  if(name==='progress') renderProgress();
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
  if(currentTab==='progress') renderProgress(); else { renderCheckinList(); }
  renderBackupNudge();
}

/* ===================== Boot ===================== */
async function boot(){
  populatePresetSelect();
  runCalc();
  initTabs();
  initAsk();
  initProgress();
  $('#syncPill').addEventListener('click', openBackupModal);
  $('#backupNudgeBtn').addEventListener('click', openBackupModal);
  $('#backupNudgeDismiss').addEventListener('click', ()=>{ lsSet('ledger.nudgeSnooze', todayISO()); renderBackupNudge(); });
  $('#openBackupBtn').addEventListener('click', openBackupModal);
  window.addEventListener('beforeinstallprompt', e=>{ e.preventDefault(); deferredInstall = e; renderInstallCard(); });
  window.addEventListener('appinstalled', ()=>{ deferredInstall = null; renderInstallCard(); });
  renderInstallCard();
  await loadAll();
  renderStoragePill();
  setTab('dose', {keepScroll:true});   // the app always opens on Dose
  renderAll();
  registerServiceWorker();
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
