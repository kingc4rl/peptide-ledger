(function(){
"use strict";

/* ===================== Utilities ===================== */
const IS_NATIVE = !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
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
/* Pop-ups are iOS-style sheets: they slide up from the bottom, have a grab handle, and close with a swipe down
   (on the handle or title bar, or anywhere once the sheet is scrolled to the top), a tap outside, or ✕. */
function openModal(title, bodyHTML, onMount){
  const root = $('#modalRoot');
  root.innerHTML = `<div class="modal-backdrop" id="mb"><div class="modal sheet" role="dialog" aria-modal="true" aria-label="${esc(title)}">
    <div class="sheet-grab" aria-hidden="true"></div>
    <div class="modal-head"><button type="button" class="icon-btn glass-btn" id="mbClose" aria-label="Close"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg></button><h3>${esc(title)}</h3><span class="mh-spacer"></span></div>
    <div id="mbBody">${bodyHTML}</div>
  </div></div>`;
  document.documentElement.classList.add('sheet-open');
  $('#mb').addEventListener('click', e=>{ if(e.target.id==='mb') closeModal(); });
  $('#mbClose').addEventListener('click', closeModal);
  bindSheetSwipe($('#mb .modal'));
  if(onMount) onMount($('#mbBody'));
}
function closeModal(){
  const mb = $('#mb');
  document.documentElement.classList.remove('sheet-open');
  if(!mb){ $('#modalRoot').innerHTML = ''; return; }
  mb.id = ''; mb.classList.add('closing');                 // a new sheet opened meanwhile replaces this one cleanly
  setTimeout(()=> mb.remove(), 230);
}
function bindSheetSwipe(sheet){
  if(!sheet) return;
  let y0 = null, dy = 0, t0 = 0;
  sheet.addEventListener('touchstart', e=>{
    const fromTop = e.target.closest('.sheet-grab, .modal-head');
    if(!fromTop && sheet.scrollTop > 0) return;
    if(e.target.closest('input, textarea, select, .lot-row, .week-strip, .serum-pan, .chart, .coa-viewer')) return;
    y0 = e.touches[0].clientY; dy = 0; t0 = Date.now();
  }, {passive:true});
  sheet.addEventListener('touchmove', e=>{
    if(y0==null) return;
    dy = e.touches[0].clientY - y0;
    if(dy <= 0 || sheet.scrollTop > 0){ sheet.style.transform = ''; return; }
    sheet.style.transition = 'none'; sheet.style.transform = `translateY(${dy}px)`;
    if(e.cancelable) e.preventDefault();
  }, {passive:false});
  sheet.addEventListener('touchend', ()=>{
    if(y0==null) return;
    const fast = dy > 60 && Date.now() - t0 < 250;
    sheet.style.transition = '';
    if(dy > 140 || fast) closeModal(); else sheet.style.transform = '';
    y0 = null;
  });
}
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
/* Reconstitution and dosing for a 3 mL vial or pen cartridge. Modes: Standard, Reverse (work backwards) and Blend.
   Devices: syringe, pen, nasal spray. Everything is plain arithmetic:
   concentration = mg ÷ mL of water, units on a U-100 syringe = mL × 100. */
const PEPTIDE_PRESETS = [
  {name:'BPC-157', vial:5, doseLow:250, doseHigh:500, doseUnit:'mcg', freq:'1×/day'},
  {name:'TB-500', vial:10, doseLow:2, doseHigh:2.5, doseUnit:'mg', freq:'2×/week'},
  {name:'Semaglutide', vial:5, doseLow:0.25, doseHigh:2.4, doseUnit:'mg', freq:'weekly'},
  {name:'Tirzepatide', vial:5, doseLow:2.5, doseHigh:15, doseUnit:'mg', freq:'weekly'},
  {name:'Retatrutide', vial:10, doseLow:1, doseHigh:12, doseUnit:'mg', freq:'weekly'},
  {name:'Cagrilintide', vial:5, doseLow:0.25, doseHigh:2.4, doseUnit:'mg', freq:'weekly'},
  {name:'CJC-1295 (No DAC)', vial:2, doseLow:100, doseHigh:300, doseUnit:'mcg', freq:'1×/day'},
  {name:'Ipamorelin', vial:5, doseLow:100, doseHigh:300, doseUnit:'mcg', freq:'2×/day'},
  {name:'GHK-Cu', vial:50, doseLow:1, doseHigh:2, doseUnit:'mg', freq:'1×/day'},
  {name:'Tesamorelin', vial:5, doseLow:1, doseHigh:2, doseUnit:'mg', freq:'1×/day'},
  {name:'PT-141', vial:10, doseLow:0.5, doseHigh:1.75, doseUnit:'mg', freq:'as needed'},
  {name:'MOTS-c', vial:10, doseLow:2.5, doseHigh:10, doseUnit:'mg', freq:'3×/week'},
  {name:'SS-31', vial:50, doseLow:10, doseHigh:40, doseUnit:'mg', freq:'1×/day'},
  {name:'5-Amino-1MQ', vial:50, doseLow:5, doseHigh:5, doseUnit:'mg', freq:'1×/day'},
  {name:'Sermorelin', vial:9, doseLow:200, doseHigh:300, doseUnit:'mcg', freq:'5 nights/week'},
  {name:'Selank', vial:10, doseLow:250, doseHigh:500, doseUnit:'mcg', freq:'1×/day'},
  {name:'Semax', vial:10, doseLow:300, doseHigh:600, doseUnit:'mcg', freq:'1×/day'},
  {name:'Epitalon', vial:10, doseLow:5, doseHigh:10, doseUnit:'mg', freq:'10–20 day course'},
  {name:'KPV', vial:10, doseLow:250, doseHigh:500, doseUnit:'mcg', freq:'1×/day'},
  {name:'AOD-9604', vial:5, doseLow:300, doseHigh:300, doseUnit:'mcg', freq:'1×/day'},
  {name:'NAD+', vial:500, doseLow:50, doseHigh:100, doseUnit:'mg', freq:'2–3×/week'},
  {name:'Thymosin Alpha-1', vial:10, doseLow:1.6, doseHigh:1.6, doseUnit:'mg', freq:'2×/week'},
];
const CALC_VIAL_ML = 3;                                    // the owner only uses 3 mL vials and cartridges
const CALC_MG_CHIPS = [2,5,10,15,20,30,50];
const CALC_WATER_CHIPS = [1,1.5,2,2.5,3];
const CALC_DOSE_CHIPS = [0.1,0.25,0.5,0.75,1,1.5,2,2.5,3,4,5,7.5,10,12.5,15,20,25,30,40,50];
const CALC_FILTERS = [{mm:4, ml:.07, note:'Single vials, least loss'}, {mm:13, ml:.28, note:'Most common'}, {mm:25, ml:.5, note:'Batches 10–100 mL'}, {mm:33, ml:.75, note:'Large batches'}];
const CALC_BUDS = [7,14,21,28,42,56];
const CALC_SCHEDULES = [
  {name:'Twice daily', sub:'2× per day', perDay:d=>2},
  {name:'Once daily', sub:'Every day', perDay:d=>1},
  {name:'6 days on, 1 off', sub:'6 on, 1 off', perDay:d=> d%7<6 ? 1 : 0},
  {name:'5 days on, 2 off', sub:'Weekdays', perDay:d=> d%7<5 ? 1 : 0},
  {name:'Every other day', sub:'Alternate days', perDay:d=> d%2===0 ? 1 : 0},
  {name:'Every 3 days', sub:'Every 3rd day', perDay:d=> d%3===0 ? 1 : 0},
  {name:'Twice weekly', sub:'e.g. Mon & Thu', perDay:d=> (d%7===0 || d%7===3) ? 1 : 0},
  {name:'Every 4 days', sub:'Every 4th day', perDay:d=> d%4===0 ? 1 : 0},
  {name:'Every 5 days', sub:'Every 5th day', perDay:d=> d%5===0 ? 1 : 0},
  {name:'Once weekly', sub:'Same day each week', perDay:d=> d%7===0 ? 1 : 0},
  {name:'Every 10 days', sub:'Every 10th day', perDay:d=> d%10===0 ? 1 : 0},
  {name:'Every 2 weeks', sub:'Every 14 days', perDay:d=> d%14===0 ? 1 : 0},
];
const CALC_DEFAULTS = {mode:'standard', device:'syringe', revTab:'units', name:'', vialMg:10, waterMl:2,
  blend:[{name:'',mg:''},{name:'',mg:''}], doseRef:-1, filter:{on:false, mm:13, lossMl:.28, mode:'reduce'},
  syrCap:100, rounding:'off', doseMg:0.5, doseUnit:'mg', penMax:60, penCarts:1, sprayMl:0.1,
  revUnits:'', revDoses:'', revDrawUnits:'', revDrawMg:'', budDays:28, labelSource:'', mixDate:''};
let C = (()=>{ try{ return {...CALC_DEFAULTS, ...JSON.parse(lsGet('ledger.calc','{}')||'{}')}; }catch(e){ return {...CALC_DEFAULTS}; } })();
C.filter = {...CALC_DEFAULTS.filter, ...(C.filter||{})};
if(!Array.isArray(C.blend) || !C.blend.length) C.blend = CALC_DEFAULTS.blend.map(x=>({...x}));
const saveCalc = ()=> lsSet('ledger.calc', JSON.stringify(C));
const trimNum = (n, dp)=> String(Math.round(n*Math.pow(10,dp))/Math.pow(10,dp));
const cfmt = (n, dp=2)=> Number.isFinite(n) ? trimNum(n, dp) : '—';
const cmg = mg=> !Number.isFinite(mg) ? '—' : mg>0 && mg<1 ? `${trimNum(mg*1000, 1)} mcg` : `${trimNum(mg, 3)} mg`;
const calcDoseInput = ()=> C.doseUnit==='mcg' ? num(C.doseMg,0)*1000 : num(C.doseMg,0);

/* Every number the screens need, from the current inputs. */
function calcMath(){
  const blend = C.mode==='blend' ? C.blend.filter(c=> num(c.mg,0)>0) : [];
  const totalMg = C.mode==='blend' ? blend.reduce((s,c)=> s+num(c.mg,0), 0) : num(C.vialMg,0);
  const water = num(C.waterMl,0);
  const loss = C.filter.on ? num(C.filter.lossMl,0) : 0;
  const extra = C.filter.on && C.filter.mode==='extra';
  const waterAdd = extra ? water + loss : water;            // what actually goes into the vial
  const conc = totalMg>0 && waterAdd>0 ? totalMg/waterAdd : 0;   // mg per mL
  const usableMl = Math.max(0, extra ? water : water - loss);
  const usableMg = conc*usableMl;
  // dose: a blend can be dosed by the whole blend or by one compound in it
  let doseMg = num(C.doseMg,0);
  if(C.mode==='blend' && C.doseRef>=0 && blend[C.doseRef]) doseMg = doseMg * totalMg / num(blend[C.doseRef].mg,1);
  const rawUnits = conc ? doseMg/conc*100 : 0;
  const step = {off:0, even:2, '5':5, '10':10}[C.rounding] || 0;
  const units = step && C.device==='syringe' ? Math.max(step, Math.round(rawUnits/step)*step) : Math.round(rawUnits*10)/10;
  const doseMl = units/100;
  const actualMg = doseMl*conc;
  const doses = doseMl>0 ? Math.floor(usableMl/doseMl + 1e-9) : 0;
  const leftMl = Math.max(0, usableMl - doseMl);
  return {blend, totalMg, water, loss, extra, waterAdd, conc, usableMl, usableMg, doseMg, rawUnits, units, doseMl, actualMg, doses, leftMl, step};
}
/* Wording for the two filter options, with the volumes for the current inputs. */
function calcLossText(m){
  const loss = num(C.filter.lossMl,0);
  return {
    reduce: `<strong>Accept the loss</strong> · add ${cfmt(m.water,2)} mL; you end with ${cfmt(Math.max(0, m.water-loss),2)} mL at the same strength, so a few fewer doses`,
    extra: `<strong>Add extra water</strong> · add ${cfmt(m.water+loss,2)} mL so you still end with ${cfmt(m.water,2)} mL. It's a little weaker, so the units go up; the peptide left in the filter is still lost`,
  };
}
/* Kept for the endotoxin check: the vial, water and dose the calculator is set to. */
function calcState(){
  const m = calcMath();
  return {vialMg:m.totalMg, bacMl:m.waterAdd, doseMg:m.actualMg||m.doseMg, doseUnit:C.doseUnit, doseVal: C.doseUnit==='mcg' ? (m.actualMg||m.doseMg)*1000 : (m.actualMg||m.doseMg)};
}

/* A clear U-100 insulin syringe drawn to scale: orange cap and hub, printed scale, black rubber stopper and a plunger
   that pulls out as the dose grows. */
let _csSeq = 0;
function calcSyringeSVG(units, cap){
  const id = 'cs'+(_csSeq++), over = units > cap, u = Math.max(0, Math.min(units, cap));
  const W = 600, H = 132, bx = 92, bw = 360, by = 52, bh = 34, my = by+bh/2;
  const fx = bx + bw*u/cap;                                   // stopper's front face
  const rodOut = 22 + (fx-bx)*0.28;                           // plunger shown slightly foreshortened so it fits
  const thumb = bx + bw + rodOut;
  const major = cap<=30 ? 5 : 10, mid = cap<=30 ? 1 : 5;
  let ticks = '';
  for(let k=0;k<=cap;k++){
    if(cap>50 && k%2) continue;
    const x = bx + bw*k/cap, isMaj = k%major===0, isMid = !isMaj && k%mid===0;
    const h = isMaj ? 14 : isMid ? 10 : 6;
    ticks += `<line x1="${x.toFixed(1)}" y1="${by+1}" x2="${x.toFixed(1)}" y2="${by+1+h}" stroke="#1d1d22" stroke-width="${isMaj?1.3:.8}" stroke-opacity="${isMaj?.85:.55}"/>`;
    if(isMaj) ticks += `<text x="${x.toFixed(1)}" y="${by-6}" font-size="11" font-weight="600" font-family="Inter,system-ui,sans-serif" text-anchor="${k===cap?'end':'middle'}" fill="#3a3a40">${k}</text>`;
  }
  const liq = over ? 'var(--warn)' : 'var(--accent-pep)';
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Syringe drawn to ${cfmt(units,1)} of ${cap} units">
  <defs>
    <linearGradient id="${id}g" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".95"/><stop offset=".18" stop-color="#eef3f7" stop-opacity=".55"/><stop offset=".55" stop-color="#fff" stop-opacity=".25"/><stop offset=".85" stop-color="#dfe7ee" stop-opacity=".55"/><stop offset="1" stop-color="#b9c6d1" stop-opacity=".8"/></linearGradient>
    <linearGradient id="${id}l" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="${liq}" stop-opacity=".28"/><stop offset=".5" stop-color="${liq}" stop-opacity=".5"/><stop offset="1" stop-color="${liq}" stop-opacity=".7"/></linearGradient>
    <linearGradient id="${id}r" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#55575e"/><stop offset=".35" stop-color="#1f2024"/><stop offset=".7" stop-color="#2c2d32"/><stop offset="1" stop-color="#101114"/></linearGradient>
    <linearGradient id="${id}p" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#fff"/><stop offset=".5" stop-color="#e9edf1"/><stop offset="1" stop-color="#c9d0d7"/></linearGradient>
    <linearGradient id="${id}o" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#ffb062"/><stop offset=".5" stop-color="#ff8a1e"/><stop offset="1" stop-color="#d9670a"/></linearGradient>
  </defs>
  <ellipse cx="${(bx+thumb)/2}" cy="${by+bh+22}" rx="${(thumb-24)/2}" ry="5" fill="#1c2533" fill-opacity=".1"/>
  <line x1="10" y1="${my}" x2="${bx-24}" y2="${my}" stroke="#9aa1a9" stroke-width="1.6"/><line x1="10" y1="${my-.5}" x2="${bx-24}" y2="${my-.5}" stroke="#fff" stroke-width=".5"/>
  <path d="M${bx-26} ${my-6} H${bx-2} V${my+6} H${bx-26} Z" fill="url(#${id}o)"/><rect x="${bx-26}" y="${my-6}" width="24" height="2.5" fill="#fff" fill-opacity=".35"/>
  <path d="M${bx} ${by+3} L${bx-4} ${by+7} V${by+bh-7} L${bx} ${by+bh-3}Z" fill="#cfd8df"/>
  <rect x="${bx}" y="${by}" width="${bw}" height="${bh}" rx="5" fill="url(#${id}g)" stroke="#7d8b97" stroke-opacity=".55" stroke-width="1"/>
  <rect x="${bx+1}" y="${by+2}" width="${Math.max(0,fx-bx-1).toFixed(1)}" height="${bh-4}" rx="3" fill="url(#${id}l)"/>
  <rect x="${fx.toFixed(1)}" y="${my-3}" width="${(thumb-fx).toFixed(1)}" height="6" fill="url(#${id}p)" stroke="#a9b2bb" stroke-width=".6"/>
  <rect x="${fx.toFixed(1)}" y="${by+2}" width="12" height="${bh-4}" rx="2.5" fill="url(#${id}r)"/>
  <rect x="${(fx+3).toFixed(1)}" y="${by+2}" width="1.2" height="${bh-4}" fill="#000" fill-opacity=".5"/><rect x="${(fx+7.5).toFixed(1)}" y="${by+2}" width="1.2" height="${bh-4}" fill="#000" fill-opacity=".5"/>
  ${ticks}
  <rect x="${bx+4}" y="${by+bh-9}" width="${bw-8}" height="2" rx="1" fill="#fff" fill-opacity=".7"/>
  <rect x="${bx+bw-3}" y="${by-12}" width="9" height="${bh+24}" rx="3" fill="url(#${id}p)" stroke="#a9b2bb" stroke-width=".8"/>
  <rect x="${thumb.toFixed(1)}" y="${by-4}" width="8" height="${bh+8}" rx="3" fill="url(#${id}p)" stroke="#a9b2bb" stroke-width=".8"/>
  <line x1="${fx.toFixed(1)}" y1="${by+bh+3}" x2="${fx.toFixed(1)}" y2="${by+bh+12}" stroke="${liq}" stroke-width="2" stroke-linecap="round"/>
  <text x="${Math.max(bx+14, fx).toFixed(1)}" y="${by+bh+28}" font-size="14" font-weight="700" font-family="Inter,system-ui,sans-serif" text-anchor="middle" fill="${over?'var(--warn)':'var(--accent-pep-strong)'}">${cfmt(units,1)}u</text>
</svg>`;
}

/* ---- UI ---- */
const chipRow = (vals, cur, attr, fmt, extra='')=> vals.map(v=> `<button type="button" class="chip-btn ${String(v)===String(cur)?'on':''}" data-${attr}="${v}" ${extra}>${fmt(v)}</button>`).join('');
const seg = (opts, cur, attr)=> `<div class="pc-seg" role="group">${opts.map(([k,l])=> `<button type="button" class="${k===cur?'on':''}" data-${attr}="${k}" aria-pressed="${k===cur}">${l}</button>`).join('')}</div>`;
function calcLoadOptions(){
  const ps = state.protocols.filter(p=> p.status!=='archived').sort((a,b)=> (a.compound||'').localeCompare(b.compound||''));
  const vs = state.vials.filter(v=> !isDepleted(v)).sort((a,b)=> (a.compound||'').localeCompare(b.compound||''));
  return `<option value="">Fill from my protocols or vials…</option>`
    + (ps.length ? `<optgroup label="Protocols">${ps.map(p=>`<option value="p:${p.id}">${esc(p.compound||'Untitled')}</option>`).join('')}</optgroup>` : '')
    + (vs.length ? `<optgroup label="Vials">${vs.map(v=>`<option value="v:${v.id}">${esc(vialLabel(v))}</option>`).join('')}</optgroup>` : '');
}
function renderCalc(){
  const root = $('#pcSetup'); if(!root) return;
  const m = calcMath(), spray = C.device==='spray', rev = C.mode==='reverse';
  const blendRows = C.blend.map((c,i)=> `<div class="pc-blend-row" data-bi="${i}">
      <input type="text" list="pcNames" data-bf="name" value="${esc(c.name)}" placeholder="Compound ${i+1}" aria-label="Compound ${i+1} name">
      <div class="pc-num sm"><input type="number" inputmode="decimal" min="0" step="any" data-bf="mg" value="${esc(c.mg)}" placeholder="0" aria-label="Compound ${i+1} mg"><span>mg</span></div>
      <button type="button" class="pc-x" data-brm="${i}" aria-label="Remove compound ${i+1}" ${C.blend.length<2?'disabled':''}>✕</button></div>`).join('');
  root.innerHTML = `
    <div class="pc-load"><select id="pcLoad" aria-label="Fill from a protocol or vial">${calcLoadOptions()}</select></div>
    ${seg([['standard','Standard'],['reverse','Reverse'],['blend','Blend']], C.mode, 'pc-mode')}
    <div class="pc-sec">
      <div class="pc-sec-h"><h4>${C.mode==='blend' ? 'Compounds in the vial' : 'Peptide in the vial'}</h4><span class="pc-badge">3 mL vial</span></div>
      ${C.mode==='blend' ? `
        <div class="chip-row pc-chips">${Object.keys(BLEND_PRESETS).map(k=>`<button type="button" class="chip-btn" data-pc-blend="${esc(k)}">${esc(k)}</button>`).join('')}</div>
        <div id="pcBlend">${blendRows}</div>
        <button type="button" class="btn btn-sm" id="pcBlendAdd" ${C.blend.length>=8?'disabled':''}>+ Compound (${C.blend.length}/8)</button>
        <div class="pc-total">Total <strong class="mono" id="pcBlendTotal">${cfmt(m.totalMg,3)} mg</strong></div>` : `
        <input type="text" id="pcName" list="pcNames" class="pc-name" value="${esc(C.name)}" placeholder="Peptide name (optional)" aria-label="Peptide name">
        <div class="chip-row pc-chips">${chipRow(CALC_MG_CHIPS, C.vialMg, 'pc-mg', v=>`${v} mg`)}</div>
        <div class="pc-stepper"><button type="button" data-step="vialMg" data-d="-1" aria-label="Less peptide">−</button><div class="pc-num"><input type="number" id="pcMg" inputmode="decimal" min="0" step="any" value="${esc(C.vialMg)}" aria-label="Peptide in vial (mg)"><span>mg</span></div><button type="button" data-step="vialMg" data-d="1" aria-label="More peptide">+</button></div>`}
    </div>
    <div class="pc-sec">
      <div class="pc-sec-h"><h4>${spray ? 'Sterile water or saline to add' : 'Bacteriostatic water to add'}</h4></div>
      ${spray ? `<p class="footnote pc-note">BAC water isn't recommended for nasal use.</p>` : ''}
      <div class="chip-row pc-chips">${chipRow(CALC_WATER_CHIPS, C.waterMl, 'pc-water', v=>`${v} mL`)}</div>
      <div class="pc-stepper"><button type="button" data-step="waterMl" data-d="-1" aria-label="Less water">−</button><div class="pc-num"><input type="number" id="pcWater" inputmode="decimal" min="0" max="3" step="any" value="${esc(C.waterMl)}" aria-label="Water (mL)"><span>mL</span></div><button type="button" data-step="waterMl" data-d="1" aria-label="More water">+</button></div>
      <label class="pc-toggle"><input type="checkbox" id="pcFilterOn" ${C.filter.on?'checked':''}><span>Filtering through a PES syringe filter?</span></label>
      ${C.filter.on ? `<div class="pc-filter">
        <div class="footnote">Filter size (some solution stays in the filter)</div>
        <div class="chip-row pc-chips">${CALC_FILTERS.map(f=>`<button type="button" class="chip-btn ${C.filter.mm===f.mm?'on':''}" data-pc-filter="${f.mm}" title="${esc(f.note)}">${f.mm} mm · ${f.ml} mL</button>`).join('')}</div>
        <div class="pc-inline"><span class="footnote">Loss</span><div class="pc-num sm"><input type="number" id="pcLoss" inputmode="decimal" min="0" step="any" value="${esc(C.filter.lossMl)}" aria-label="Filter loss (mL)"><span>mL</span></div></div>
        <label class="pc-radio"><input type="radio" name="pcLossMode" value="reduce" ${C.filter.mode!=='extra'?'checked':''}><span id="pcLossReduce">${calcLossText(m).reduce}</span></label>
        <label class="pc-radio"><input type="radio" name="pcLossMode" value="extra" ${C.filter.mode==='extra'?'checked':''}><span id="pcLossExtra">${calcLossText(m).extra}</span></label>
      </div>` : ''}
    </div>
    ${rev ? `<div class="pc-sec">
      <div class="pc-sec-h"><h4>Work backwards</h4></div>
      ${seg([['units','Units → mg'],['split','Split vial'],['water','Draw → water']], C.revTab, 'pc-rev')}
      ${C.revTab==='units' ? `<div class="pc-inline pc-big"><span>I'm drawing</span><div class="pc-num"><input type="number" id="pcRevUnits" inputmode="decimal" min="0" step="any" value="${esc(C.revUnits)}" placeholder="10"><span>units</span></div></div>`
      : C.revTab==='split' ? `<div class="pc-inline pc-big"><span>Split into</span><div class="pc-num"><input type="number" id="pcRevDoses" inputmode="numeric" min="1" step="1" value="${esc(C.revDoses)}" placeholder="20"><span>doses</span></div></div>`
      : `<div class="pc-inline pc-big"><span>I want to draw</span><div class="pc-num"><input type="number" id="pcRevDrawUnits" inputmode="decimal" min="0" step="any" value="${esc(C.revDrawUnits)}" placeholder="10"><span>units</span></div></div>
         <div class="pc-inline pc-big"><span>for a dose of</span><div class="pc-num"><input type="number" id="pcRevDrawMg" inputmode="decimal" min="0" step="any" value="${esc(C.revDrawMg)}" placeholder="0.5"><span>mg</span></div></div>`}
    </div>` : `<div class="pc-sec">
      <div class="pc-sec-h"><h4>Dose &amp; device</h4></div>
      ${seg([['syringe','Syringe'],['pen','Pen'],['spray','Spray']], C.device, 'pc-dev')}
      ${C.device==='syringe' ? `
        <div class="footnote pc-lbl">Syringe size</div><div class="chip-row pc-chips">${chipRow([30,50,100], C.syrCap, 'pc-syr', v=>`${v/100} mL · ${v}u`)}</div>
        <div class="footnote pc-lbl">Round the draw to</div><div class="chip-row pc-chips">${[['off','Off'],['even','Even'],['5','5u'],['10','10u']].map(([k,l])=>`<button type="button" class="chip-btn ${C.rounding===k?'on':''}" data-pc-round="${k}">${l}</button>`).join('')}</div>`
      : C.device==='pen' ? `
        <div class="footnote pc-lbl">3 mL cartridge · most a pen can give in one go</div><div class="chip-row pc-chips">${chipRow([60,80], C.penMax, 'pc-penmax', v=>`${v}u max`)}<div class="pc-num sm pc-chipnum"><input type="number" id="pcPenMax" inputmode="numeric" min="1" step="1" value="${esc(C.penMax)}" aria-label="Pen max units"><span>u</span></div></div>`
      : `<div class="footnote pc-lbl">Amount per spray or pump</div><div class="chip-row pc-chips">${[[0.05,'0.05 mL nasal'],[0.1,'0.1 mL pump'],[0.2,'0.2 mL pump']].map(([v,l])=>`<button type="button" class="chip-btn ${num(C.sprayMl)===v?'on':''}" data-pc-spray="${v}">${l}</button>`).join('')}<div class="pc-num sm pc-chipnum"><input type="number" id="pcSprayMl" inputmode="decimal" min="0" step="any" value="${esc(C.sprayMl)}" aria-label="mL per spray"><span>mL</span></div></div>`}
      ${C.mode==='blend' && m.blend.length ? `<div class="footnote pc-lbl">Dose is measured as</div><div class="chip-row pc-chips"><button type="button" class="chip-btn ${C.doseRef<0?'on':''}" data-pc-ref="-1">Whole blend</button>${m.blend.map((c,i)=>`<button type="button" class="chip-btn ${C.doseRef===i?'on':''}" data-pc-ref="${i}">${esc(c.name||`Compound ${i+1}`)}</button>`).join('')}</div>` : ''}
      <div class="footnote pc-lbl">Dose <span class="pc-of">of ${cfmt(m.totalMg,2)} mg in the vial</span></div>
      <div class="chip-row pc-chips" id="pcDoseChips">${CALC_DOSE_CHIPS.filter(v=> !m.totalMg || v<=m.totalMg).slice(0,12).map(v=>`<button type="button" class="chip-btn ${Math.abs(num(C.doseMg)-v)<1e-9?'on':''}" data-pc-dose="${v}">${cmg(v)}</button>`).join('')}</div>
      <div class="pc-stepper"><button type="button" data-step="doseMg" data-d="-1" aria-label="Smaller dose">−</button><div class="pc-num"><input type="number" id="pcDose" inputmode="decimal" min="0" step="any" value="${esc(trimNum(calcDoseInput(), C.doseUnit==='mcg'?1:4))}" aria-label="Dose"><select id="pcDoseUnit" aria-label="Dose unit"><option value="mg" ${C.doseUnit==='mg'?'selected':''}>mg</option><option value="mcg" ${C.doseUnit==='mcg'?'selected':''}>mcg</option></select></div><button type="button" data-step="doseMg" data-d="1" aria-label="Bigger dose">+</button></div>
    </div>`}
    <datalist id="pcNames">${PEPTIDE_PRESETS.map(p=>`<option value="${esc(p.name)}"></option>`).join('')}</datalist>`;
  renderCalcResult();
}
function renderCalcResult(){
  const el = $('#pcResult'); if(!el) return;
  const m = calcMath();
  const name = C.mode==='blend' ? (m.blend.map(c=>c.name).filter(Boolean).join(' + ') || 'Blend') : (C.name || 'Peptide');
  const warn = [];
  if(m.water > CALC_VIAL_ML) warn.push(`That's more water than a 3 mL vial holds.`);
  if(m.extra && m.waterAdd > CALC_VIAL_ML) warn.push(`With the extra ${cfmt(m.loss,2)} mL for the filter that's ${cfmt(m.waterAdd,2)} mL, more than a 3 mL vial holds.`);
  if(!(m.totalMg>0) || !(m.water>0)){ el.innerHTML = `<div class="pc-empty">Enter how much peptide is in the vial and how much water you're adding.</div>`; renderCalcNext(m); return; }
  const formula = (rows)=> `<div class="pc-formula">${rows.map(([l,v,hl])=>`<div class="${hl?'hl':''}"><span>${l}</span><strong class="mono">${v}</strong></div>`).join('')}</div>`;
  const vialPair = (afterMl, doseLbl)=> {
    const color = '#ff9f43', tag = `${cfmt(m.totalMg,2)} mg`;
    return `<div class="pc-vials">
      <figure>${vialSVG({color, pct: Math.min(1, m.usableMl/CALC_VIAL_ML), mgTag:tag, name, brand:'', lot:''}, 'pcb')}<figcaption><strong>${cfmt(m.usableMl,2)} mL</strong> before<span>${m.doses} dose${m.doses===1?'':'s'}${doseLbl}</span></figcaption></figure>
      <div class="pc-arrow">→</div>
      <figure>${vialSVG({color, pct: Math.min(1, afterMl/CALC_VIAL_ML), mgTag:tag, name, brand:'', lot:''}, 'pca')}<figcaption><strong>${cfmt(afterMl,2)} mL</strong> after one dose<span>${Math.max(0,m.doses-1)} left</span></figcaption></figure>
    </div>`;
  };
  const blendBreak = (doseMl)=> C.mode==='blend' && m.blend.length ? `<div class="pc-blendout"><div class="footnote">Each dose contains</div>${m.blend.map(c=>`<div><span>${esc(c.name||'Compound')}</span><strong class="mono">${cmg(num(c.mg,0)/m.waterAdd*doseMl)}</strong></div>`).join('')}</div>` : '';
  // With a filter, show what goes in, what stays in the filter and what's left to dose from.
  const filterLine = m.loss ? [['Left in filter', `−${cfmt(m.loss,2)} mL · ${cfmt(m.loss*m.conc,2)} mg`], ['You end with', `${cfmt(m.usableMl,2)} mL · ${cfmt(m.usableMg,2)} mg`]] : [];
  let html = '';
  if(C.mode==='reverse'){
    const base = [['Vial', `${cfmt(m.totalMg,2)} mg`], [m.loss ? 'Water to add' : 'Water', `${cfmt(m.waterAdd,2)} mL`], ...filterLine, ['Strength', `${cfmt(m.conc,3)} mg/mL`, true], ['1 unit', cmg(m.conc/100)]];
    if(C.revTab==='units'){
      const u = num(C.revUnits,0), mg = u/100*m.conc;
      html = u>0 ? `<div class="pc-hero"><div class="pc-hero-big">${cmg(mg)}</div><div class="pc-hero-sub">in ${cfmt(u,1)} units (${cfmt(u/100,3)} mL)</div><div class="pc-hero-meta">${Math.floor(m.usableMl/(u/100)+1e-9)} draws of ${cfmt(u,1)}u in the vial</div></div>` : `<div class="pc-empty">Enter the units you're drawing.</div>`;
      html += formula(base) + (u>0 ? `<div class="pc-syr">${calcSyringeSVG(u, u<=30?30:u<=50?50:100)}</div>` + blendBreak(u/100) : '');
    } else if(C.revTab==='split'){
      const n = Math.floor(num(C.revDoses,0));
      const ml = n>0 ? m.usableMl/n : 0, u = ml*100;
      html = n>0 ? `<div class="pc-hero"><div class="pc-hero-big">${cfmt(u,1)}u</div><div class="pc-hero-sub">each dose is ${cmg(m.usableMg/n)} (${cfmt(ml,3)} mL)</div><div class="pc-hero-meta">${n} equal doses from this vial</div></div>` : `<div class="pc-empty">Enter how many doses you want from the vial.</div>`;
      html += formula(base) + (n>0 ? `<div class="pc-syr">${calcSyringeSVG(u, u<=30?30:u<=50?50:100)}</div>` + blendBreak(ml) : '');
    } else {
      const u = num(C.revDrawUnits,0), d = num(C.revDrawMg,0);
      const need = u>0 && d>0 ? m.totalMg*(u/100)/d : 0, add = need + (m.loss && m.extra ? m.loss : 0);
      html = need>0 ? `<div class="pc-hero"><div class="pc-hero-big">${cfmt(add,2)} mL</div><div class="pc-hero-sub">of water so ${cfmt(u,1)} units = ${cmg(d)}</div><div class="pc-hero-meta">Concentration ${cfmt(d/(u/100),3)} mg/mL${m.loss && m.extra ? ` · includes ${cfmt(m.loss,2)} mL for the filter` : ''}</div>
        ${add>CALC_VIAL_ML ? `<div class="pc-warn">That's more than a 3 mL vial holds. Use a smaller dose per draw or draw more units.</div>` : `<button type="button" class="btn btn-sm btn-accent-pep" id="pcUseWater">Use ${cfmt(need,2)} mL in the calculator</button>`}</div>`
        : `<div class="pc-empty">Enter the units you'd like to draw and the dose they should equal.</div>`;
      html += need>0 ? formula([['Vial', `${cfmt(m.totalMg,2)} mg`], ['Draw', `${cfmt(u,1)} u = ${cfmt(u/100,3)} mL`], ['Dose', cmg(d)], ['Water', `${cfmt(need,3)} mL`, true]]) : '';
    }
  } else if(C.device==='syringe'){
    const over = m.units > C.syrCap, rounded = m.step && Math.abs(m.units - m.rawUnits) > 0.05;
    html = `<div class="pc-hero">
        <div class="pc-hero-big">${cfmt(m.units,1)}<small>u</small></div>
        <div class="pc-hero-sub">Pull the plunger to the <strong>${cfmt(m.units,1)} unit</strong> mark</div>
        <div class="pc-hero-meta">That's ${cmg(m.actualMg)}${rounded ? ` (rounded from ${cfmt(m.rawUnits,1)}u = ${cmg(m.doseMg)})` : ''}</div>
      </div>
      ${over ? `<div class="pc-warn">${cfmt(m.units,1)} units won't fit a ${C.syrCap}u syringe. Pick a bigger syringe or add less water.</div>` : ''}
      <div class="pc-syr">${calcSyringeSVG(m.units, C.syrCap)}</div>
      <div class="pc-stats"><div><strong>${m.doses}</strong><span>doses in the vial</span></div><div><strong>${m.usableMl ? Math.round(m.leftMl/m.usableMl*100) : 0}%</strong><span>left after one dose</span></div><div><strong>${cfmt(m.leftMl,2)}</strong><span>mL left</span></div></div>
      ${blendBreak(m.doseMl)}
      ${formula([['Vial', `${cfmt(m.totalMg,2)} mg`], [m.loss ? 'Water to add' : 'Water', `${cfmt(m.waterAdd,2)} mL`], ...filterLine, ['Dose', cmg(m.actualMg)], ['Strength', `${cfmt(m.conc,3)} mg/mL`, true], ['Per dose', `${cfmt(m.doseMl,3)} mL`], ['1 unit', cmg(m.conc/100)]])}
      ${vialPair(m.leftMl, ` @ ${cmg(m.actualMg)}`)}`;
  } else if(C.device==='pen'){
    const max = Math.max(1, num(C.penMax,60)), shots = Math.ceil(m.units/max - 1e-9);
    const carts = Math.max(1, Math.floor(num(C.penCarts,1)));
    const needCarts = Math.max(1, Math.ceil(m.usableMl/CALC_VIAL_ML - 1e-9));
    const per = m.usableMl / carts;
    html = `<div class="pc-hero">
        <div class="pc-hero-big">${cfmt(m.units,1)}<small>u</small></div>
        <div class="pc-hero-sub">Dial <strong>${cfmt(m.units,1)} units</strong> on the pen</div>
        <div class="pc-hero-meta">That's ${cmg(m.actualMg)} · ${cfmt(m.doseMl,3)} mL</div>
      </div>
      ${shots>1 ? `<div class="pc-warn">That's more than the pen's ${max}u maximum. Split it into ${shots} injections of about ${cfmt(m.units/shots,1)}u.</div>` : ''}
      <div class="pc-sec-h" style="margin-top:14px;"><h4>Plan your cartridges</h4></div>
      <div class="pc-inline"><span class="footnote">Cartridges to fill</span><div class="pc-stepper sm"><button type="button" data-cart="-1" aria-label="Fewer cartridges">−</button><strong class="mono">${carts}</strong><button type="button" data-cart="1" aria-label="More cartridges">+</button></div></div>
      ${per > CALC_VIAL_ML ? `<div class="pc-warn">${cfmt(m.usableMl,2)} mL won't fit in ${carts} cartridge${carts>1?'s':''}. You need at least ${needCarts}.</div>` : ''}
      <div class="pc-carts">${Array.from({length:carts}, (_,i)=>{ const ml = Math.min(per, CALC_VIAL_ML); return `<div class="pc-cart"><div class="pc-cart-bar"><i style="width:${Math.round(ml/CALC_VIAL_ML*100)}%"></i></div><div class="pc-cart-h">Cartridge ${i+1}<span>${Math.round(ml/CALC_VIAL_ML*100)}% full</span></div><div class="pc-cart-n"><span><strong class="mono">${cfmt(ml,2)}</strong> mL</span><span><strong class="mono">${cfmt(ml*m.conc,2)}</strong> mg</span><span><strong class="mono">${m.doseMl?Math.floor(ml/m.doseMl+1e-9):0}</strong> doses</span></div></div>`; }).join('')}</div>
      ${blendBreak(m.doseMl)}
      ${formula([['Vial', `${cfmt(m.totalMg,2)} mg`], [m.loss ? 'Water to add' : 'Water', `${cfmt(m.waterAdd,2)} mL`], ...filterLine, ['Strength', `${cfmt(m.conc,3)} mg/mL`, true], ['Per dose', `${cfmt(m.doseMl,3)} mL`], ['1 unit', cmg(m.conc/100)]])}`;
  } else {
    const per = num(C.sprayMl,0), mgPer = per*m.conc, sprays = mgPer ? m.doseMg/mgPer : 0, whole = Math.ceil(sprays - 1e-9);
    html = per>0 ? `<div class="pc-hero">
        <div class="pc-hero-big">${cfmt(sprays,1)}<small> spray${Math.abs(sprays-1)<0.05?'':'s'}</small></div>
        <div class="pc-hero-sub">for ${cmg(m.doseMg)}${Math.abs(sprays-whole)>0.05 ? ` · ${whole} sprays gives ${cmg(whole*mgPer)}` : ''}</div>
        <div class="pc-hero-meta">Each ${cfmt(per,3)} mL spray holds ${cmg(mgPer)}</div>
      </div>
      <div class="pc-stats"><div><strong>${Math.floor(m.usableMl/per+1e-9)}</strong><span>sprays in the bottle</span></div><div><strong>${whole ? Math.floor(m.usableMl/(whole*per)+1e-9) : 0}</strong><span>doses of ${whole}</span></div><div><strong>${cfmt(m.conc,2)}</strong><span>mg/mL</span></div></div>
      ${blendBreak(per)}
      ${formula([['Vial', `${cfmt(m.totalMg,2)} mg`], [m.loss ? 'Water/saline to add' : 'Water/saline', `${cfmt(m.waterAdd,2)} mL`], ...filterLine, ['Strength', `${cfmt(m.conc,3)} mg/mL`, true], ['Per spray', cmg(mgPer)]])}` : `<div class="pc-empty">Enter how much one spray or pump delivers.</div>`;
  }
  el.innerHTML = (warn.length ? `<div class="pc-warn">${warn.join(' ')}</div>` : '') + html;
  const lt = calcLossText(m), lr = $('#pcLossReduce'), le = $('#pcLossExtra');
  if(lr) lr.innerHTML = lt.reduce; if(le) le.innerHTML = lt.extra;
  const use = $('#pcUseWater', el);
  if(use) use.addEventListener('click', ()=>{ const u = num(C.revDrawUnits,0), d = num(C.revDrawMg,0); C.waterMl = +trimNum(m.totalMg*(u/100)/d, 3); C.doseMg = d; C.doseUnit = 'mg'; C.mode = C.mode==='reverse' ? 'standard' : C.mode; C.device = 'syringe'; saveCalc(); renderCalc(); });
  renderCalcNext(m);
  if(typeof runEndo==='function') runEndo();
}
/* Doses per vial for the optimizer: syringe and pen use the dose volume, spray uses whole sprays per dose. */
function calcDosesPerVial(m){
  if(C.mode==='reverse') return 0;
  if(C.device==='spray'){ const per = num(C.sprayMl,0), mgPer = per*m.conc, whole = mgPer ? Math.ceil(m.doseMg/mgPer - 1e-9) : 0; return whole ? Math.floor(m.usableMl/(whole*per)+1e-9) : 0; }
  return m.doses;
}
function calcScheduleDays(n, s){
  if(!(n>0)) return 0;
  let left = n, d = 0;
  for(; d<3650; d++){ left -= s.perDay(d); if(left<=0) return d+1; }
  return d;
}
let calcOpen = (()=>{ try{ return JSON.parse(lsGet('ledger.calcOpen','{}'))||{}; }catch(e){ return {}; } })();
function renderCalcNext(m){
  const el = $('#pcNext'); if(!el) return;
  const n = calcDosesPerVial(m), bud = C.budDays;
  const fits = CALC_SCHEDULES.map(s=> calcScheduleDays(n, s));
  const fitCount = fits.filter(d=> d>0 && d<=bud).length;
  const saved = calcSavedList();
  const today = todayISO(), mix = C.mixDate || today;
  const budDate = addDays(mix, bud);
  const optBody = !n ? `<p class="footnote">Set a dose above to see how long the vial lasts on each schedule.</p>` : `
      <div class="footnote pc-lbl">Beyond-use date (how long a mixed vial is good for)</div>
      <div class="chip-row pc-chips">${chipRow(CALC_BUDS, bud, 'pc-bud', v=> v%7===0 && v>28 ? `${v/7} weeks` : `${v} days`)}</div>
      <div class="pc-opt-sum"><span><strong>${n}</strong> doses</span><span><strong>${cmg(C.device==='spray' ? m.doseMg : m.actualMg)}</strong> each</span><span><strong>${fitCount}</strong> of ${CALC_SCHEDULES.length} schedules finish within ${bud} days</span></div>
      <div class="pc-opt-list">${CALC_SCHEDULES.map((s,i)=>{ const d = fits[i], ok = d<=bud, w = Math.min(100, d/Math.max(bud, ...fits)*100); return `<div class="pc-opt ${ok?'ok':'over'}">
        <div class="pc-opt-h"><strong>${s.name}</strong><span class="mono">${d} day${d===1?'':'s'}</span></div>
        <div class="pc-opt-bar"><i style="width:${w.toFixed(1)}%"></i><b style="left:${Math.min(100, bud/Math.max(bud, ...fits)*100).toFixed(1)}%"></b></div>
        <div class="footnote">${s.sub}${ok ? ' · finishes in time' : ` · ${d-bud} day${d-bud===1?'':'s'} past the ${bud}-day limit`}</div></div>`; }).join('')}</div>`;
  el.innerHTML = `
    <details class="pc-more" data-more="opt" ${calcOpen.opt?'open':''}><summary>Protocol optimizer</summary><div class="pc-more-b">${optBody}</div></details>
    <details class="pc-more" data-more="labels" ${calcOpen.labels?'open':''}><summary>Print labels</summary><div class="pc-more-b">
      <div class="field"><label for="pcLabelName">Peptide name</label><input type="text" id="pcLabelName" list="pcNames" value="${esc(C.mode==='blend' ? (m.blend.map(c=>c.name).filter(Boolean).join(' + ')) : C.name)}" placeholder="e.g. Retatrutide"></div>
      <div class="field"><label for="pcLabelSource">Source, vendor or batch (optional, up to 4 lines)</label><textarea id="pcLabelSource" rows="3" maxlength="160">${esc(C.labelSource)}</textarea></div>
      <div class="pc-two"><div class="field"><label for="pcMixDate">Mixed on</label><input type="date" id="pcMixDate" value="${esc(mix)}"></div>
      <div class="field"><label>Beyond-use date</label><div class="pc-budout mono">${esc(fmtDateShort(budDate))}</div></div></div>
      <p class="footnote">Uses the ${bud}-day limit picked in the optimizer.</p>
      <button type="button" class="btn btn-sm btn-accent-pep" id="pcMakeLabels">Make labels</button>
      <div id="pcLabelPreview"></div>
    </div></details>
    <details class="pc-more" data-more="save" ${calcOpen.save?'open':''}><summary>Save &amp; load calculations${saved.length?` <span class="pc-count">${saved.length}</span>`:''}</summary><div class="pc-more-b">
      <div class="pc-inline"><input type="text" id="pcSaveName" placeholder="Name, e.g. Reta 10 mg / 2 mL" value="${esc(C.mode==='blend' ? '' : C.name)}"><button type="button" class="btn btn-sm btn-accent-pep" id="pcSave">Save</button></div>
      ${saved.length ? `<div class="pc-saved">${saved.map(s=>`<div class="pc-saved-row"><button type="button" class="pc-saved-load" data-load="${s.id}"><strong>${esc(s.name)}</strong><span class="footnote">${esc(s.summary||'')}</span></button><button type="button" class="pc-x" data-del="${s.id}" aria-label="Delete ${esc(s.name)}">✕</button></div>`).join('')}</div>` : `<p class="footnote" style="margin-top:8px;">Nothing saved yet.</p>`}
      <p class="footnote" style="margin-top:8px;">Saved on this phone only. They aren't part of backups.</p>
    </div></details>`;
}
function calcSavedList(){ try{ const a = JSON.parse(lsGet('ledger.calcSaved','[]')); return Array.isArray(a) ? a : []; }catch(e){ return []; } }
function calcSummary(m){
  const what = C.mode==='blend' ? `${cfmt(m.totalMg,2)} mg blend` : `${cfmt(m.totalMg,2)} mg`;
  return `${what} · ${cfmt(m.water,2)} mL · ${C.mode==='reverse' ? 'reverse' : `${cmg(C.device==='syringe' ? m.actualMg : m.doseMg)} ${C.device}`}`;
}
function calcLabelsHTML(){
  const m = calcMath(), name = ($('#pcLabelName')||{}).value || C.name || 'Peptide';
  const src = String(C.labelSource||'').split('\n').slice(0,4).map(l=>esc(l)).join('<br>');
  const mix = C.mixDate || todayISO(), bud = addDays(mix, C.budDays);
  const dose = C.mode!=='reverse' && m.units ? `${cmg(C.device==='syringe'?m.actualMg:m.doseMg)} = ${cfmt(m.units,1)}u` : '';
  return `<div class="pl-sheet">
    <div class="pl-label"><div class="pl-band">BEFORE MIXING</div><div class="pl-name">${esc(name)}</div><div class="pl-mg">${cfmt(m.totalMg,2)} mg</div>${src?`<div class="pl-src">${src}</div>`:''}<div class="pl-foot">Lyophilized · store cold, dark</div></div>
    <div class="pl-label"><div class="pl-band pl-band2">RECONSTITUTED</div><div class="pl-name">${esc(name)}</div><div class="pl-mg">${cfmt(m.totalMg,2)} mg / ${cfmt(m.waterAdd,2)} mL · <strong>${cfmt(m.conc,2)} mg/mL</strong></div>${dose?`<div class="pl-dose">${dose}</div>`:''}<div class="pl-foot">Mixed ${esc(fmtDateShort(mix))} · <strong>Use by ${esc(fmtDateShort(bud))}</strong></div></div>
  </div>`;
}
function calcFillFrom(val){
  const [kind, id] = String(val).split(':');
  if(kind==='p'){
    const p = state.protocols.find(x=>x.id===id); if(!p) return;
    const d = doseAt(p, doseDayISO()), mg = doseToMg(d.dose, d.doseUnit);
    const vial = state.vials.find(v=> v.id===p.activeVialId) || state.vials.find(v=> !isDepleted(v) && (v.compound||'').toLowerCase()===(p.compound||'').toLowerCase());
    const parts = Array.isArray(p.blend) ? p.blend.filter(c=> (c.name||'').trim() && num(c.mg,0)>0) : [];
    if(parts.length){ C.mode = 'blend'; C.blend = parts.map(c=>({name:c.name, mg:String(c.mg)})); C.doseRef = -1; }
    else { if(C.mode==='blend') C.mode = 'standard'; C.name = p.compound||''; if(vial && num(vial.mgPerVial,0)) C.vialMg = num(vial.mgPerVial,0); }
    if(vial && num(vial.bacMl,0)) C.waterMl = num(vial.bacMl,0);
    if(mg) { C.doseMg = mg/splitCount(p); C.doseUnit = d.doseUnit==='mcg' ? 'mcg' : 'mg'; }
  } else if(kind==='v'){
    const v = state.vials.find(x=>x.id===id); if(!v) return;
    if(C.mode==='blend') C.mode = 'standard';
    C.name = v.compound||''; if(num(v.mgPerVial,0)) C.vialMg = num(v.mgPerVial,0);
    if(num(v.bacMl,0)) C.waterMl = num(v.bacMl,0);
  }
  saveCalc(); renderCalc();
}
/* One set of listeners on the card; the contents are redrawn freely. */
(function bindCalc(){
  const card = $('#pcCard'); if(!card) return;
  const redraw = ()=>{ saveCalc(); renderCalc(); };
  const refresh = ()=>{ saveCalc(); renderCalcResult(); };
  card.addEventListener('click', e=>{
    const t = e.target.closest('button'); if(!t) return;
    const d = t.dataset;
    if(d.pcMode){ C.mode = d.pcMode; if(C.mode==='reverse') C.device = 'syringe'; return redraw(); }
    if(d.pcDev){ C.device = d.pcDev; return redraw(); }
    if(d.pcRev){ C.revTab = d.pcRev; return redraw(); }
    if(d.pcMg){ C.vialMg = +d.pcMg; return redraw(); }
    if(d.pcWater){ C.waterMl = +d.pcWater; return redraw(); }
    if(d.pcFilter){ const f = CALC_FILTERS.find(x=>x.mm===+d.pcFilter); C.filter.mm = f.mm; C.filter.lossMl = f.ml; return redraw(); }
    if(d.pcSyr){ C.syrCap = +d.pcSyr; return redraw(); }
    if(d.pcRound){ C.rounding = d.pcRound; return redraw(); }
    if(d.pcPenmax){ C.penMax = +d.pcPenmax; return redraw(); }
    if(d.pcSpray){ C.sprayMl = +d.pcSpray; return redraw(); }
    if(d.pcRef){ C.doseRef = +d.pcRef; return redraw(); }
    if(d.pcDose){ C.doseMg = +d.pcDose; if(C.doseUnit==='mcg' && C.doseMg>=1) C.doseUnit = 'mg'; return redraw(); }
    if(d.pcBud){ C.budDays = +d.pcBud; return refresh(); }
    if(d.cart){ C.penCarts = Math.max(1, Math.min(12, num(C.penCarts,1) + +d.cart)); return refresh(); }
    if(d.step){
      const k = d.step, dir = +d.d, v = num(C[k],0);
      const inc = k==='waterMl' ? 0.1 : k==='vialMg' ? (v<10 ? 0.5 : 1) : C.doseUnit==='mcg' ? 0.025 : (v<1 ? 0.05 : v<5 ? 0.25 : 0.5);
      C[k] = Math.max(0, +trimNum(v + dir*inc, 4));
      if(k==='waterMl') C.waterMl = Math.min(CALC_VIAL_ML, C.waterMl);
      return redraw();
    }
    if(d.pcBlend){ C.blend = BLEND_PRESETS[d.pcBlend].map(c=>({name:c.name, mg:String(c.mg)})); C.doseRef = -1; return redraw(); }
    if(t.id==='pcBlendAdd'){ if(C.blend.length<8) C.blend.push({name:'',mg:''}); return redraw(); }
    if(d.brm!=null){ C.blend.splice(+d.brm,1); C.doseRef = -1; return redraw(); }
    if(t.id==='pcMakeLabels'){ $('#pcLabelPreview').innerHTML = calcLabelsHTML() + `<button type="button" class="btn btn-sm" id="pcPrint" style="margin-top:10px;">Print</button>`; return; }
    if(t.id==='pcPrint' && IS_NATIVE){
      const css = [...document.styleSheets].flatMap(sh=>{ try{ return [...sh.cssRules].map(r=>r.cssText).filter(x=> /\.pl-/.test(x)); }catch(e){ return []; } }).join('\n');
      nativeShareFile('pep-prep-labels.html', `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><style>body{margin:16px;font-family:-apple-system,sans-serif}${css}</style>${calcLabelsHTML()}`, 'Pep Prep labels').catch(e=> console.warn(e));
      return;
    }
    if(t.id==='pcPrint'){
      let area = $('#printArea'); if(!area){ area = document.createElement('div'); area.id = 'printArea'; document.body.appendChild(area); }
      area.innerHTML = calcLabelsHTML(); document.body.classList.add('printing-labels');
      setTimeout(()=>{ window.print(); setTimeout(()=> document.body.classList.remove('printing-labels'), 500); }, 50);
      return;
    }
    if(t.id==='pcSave'){
      const m = calcMath(), nm = ($('#pcSaveName').value||'').trim() || calcSummary(m);
      const list = calcSavedList(); const snap = JSON.parse(JSON.stringify(C));
      list.unshift({id: uid(), name: nm, summary: calcSummary(m), at: Date.now(), calc: snap});
      lsSet('ledger.calcSaved', JSON.stringify(list.slice(0,50))); calcOpen.save = true; return renderCalcResult();
    }
    if(d.load){ const s = calcSavedList().find(x=>x.id===d.load); if(s){ C = {...CALC_DEFAULTS, ...s.calc, filter:{...CALC_DEFAULTS.filter, ...(s.calc.filter||{})}}; redraw(); } return; }
    if(d.del){ lsSet('ledger.calcSaved', JSON.stringify(calcSavedList().filter(x=>x.id!==d.del))); return renderCalcResult(); }
  });
  card.addEventListener('input', e=>{
    const t = e.target;
    const numIds = {pcMg:'vialMg', pcWater:'waterMl', pcRevUnits:'revUnits', pcRevDoses:'revDoses', pcRevDrawUnits:'revDrawUnits', pcRevDrawMg:'revDrawMg', pcPenMax:'penMax', pcSprayMl:'sprayMl'};
    if(numIds[t.id]){
      C[numIds[t.id]] = t.value===''? '' : num(t.value,0);
      // keep the matching chip lit
      const attr = {pcMg:'pc-mg', pcWater:'pc-water', pcPenMax:'pc-penmax', pcSprayMl:'pc-spray'}[t.id];
      if(attr) $$(`[data-${attr}]`, card).forEach(b=> b.classList.toggle('on', num(b.getAttribute(`data-${attr}`))===num(t.value)));
      return refresh();
    }
    if(t.id==='pcDose'){ const v = num(t.value,0); C.doseMg = C.doseUnit==='mcg' ? v/1000 : v; $$('[data-pc-dose]',card).forEach(b=> b.classList.toggle('on', Math.abs(num(b.dataset.pcDose)-C.doseMg)<1e-9)); return refresh(); }
    if(t.id==='pcLoss'){ C.filter.lossMl = num(t.value,0); C.filter.mm = (CALC_FILTERS.find(f=> f.ml===C.filter.lossMl)||{}).mm || 0; $$('[data-pc-filter]',card).forEach(b=> b.classList.toggle('on', +b.dataset.pcFilter===C.filter.mm)); return refresh(); }
    if(t.id==='pcName'){ C.name = t.value; return refresh(); }
    if(t.dataset.bf){ const i = +t.closest('[data-bi]').dataset.bi; C.blend[i][t.dataset.bf] = t.value; const m = calcMath(); const tot = $('#pcBlendTotal',card); if(tot) tot.textContent = `${cfmt(m.totalMg,3)} mg`; return refresh(); }
    if(t.id==='pcLabelSource'){ C.labelSource = t.value; return saveCalc(); }
    if(t.id==='pcMixDate'){ C.mixDate = t.value; saveCalc(); return renderCalcResult(); }
  });
  card.addEventListener('change', e=>{
    const t = e.target;
    if(t.id==='pcLoad'){ if(t.value) calcFillFrom(t.value); return; }
    if(t.id==='pcDoseUnit'){ C.doseUnit = t.value; return redraw(); }
    if(t.id==='pcFilterOn'){ C.filter.on = t.checked; return redraw(); }
    if(t.name==='pcLossMode'){ C.filter.mode = t.value; return redraw(); }
    if(t.id==='pcName'){ const p = PEPTIDE_PRESETS.find(x=> x.name.toLowerCase()===t.value.trim().toLowerCase()); if(p){ C.vialMg = p.vial; C.doseMg = p.doseUnit==='mcg' ? p.doseLow/1000 : p.doseLow; C.doseUnit = p.doseUnit; redraw(); } return; }
    if(t.dataset.bf==='name' || t.dataset.bf==='mg'){ return redraw(); }
  });
  card.addEventListener('toggle', e=>{ const d = e.target.closest && e.target.closest('details[data-more]'); if(!d) return; calcOpen[d.dataset.more] = d.open; lsSet('ledger.calcOpen', JSON.stringify(calcOpen)); }, true);
  $('#calcReset').addEventListener('click', ()=>{ const keep = {budDays:C.budDays, labelSource:C.labelSource}; C = {...CALC_DEFAULTS, ...keep, filter:{...CALC_DEFAULTS.filter}, blend: CALC_DEFAULTS.blend.map(x=>({...x}))}; redraw(); });
})();
function runCalc(){ renderCalc(); }

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
  const cs = calcState(), vialMg = cs.vialMg, bac = cs.bacMl;
  const unit = cs.doseUnit, doseVal = +trimNum(cs.doseVal, 4), doseMg = cs.doseMg;
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
  ['endoWeight','endoRoute','endoEU','endoCompound','endoClick','endoPerDay','endoDays','endoWeeks'].forEach(id=>{
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
    C.doseUnit = row[2]==='mcg' ? 'mcg' : 'mg'; C.doseMg = row[2]==='mcg' ? row[1]/1000 : row[1]; saveCalc(); renderCalc();
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

/* Dose tab: one calendar for past and upcoming doses. Pick a day to see what was logged
   (or missed) on it, or what is scheduled for it. Filled dots = logged, rings = scheduled or missed. */
let calDay = null;
const CAL_BACK = 28, CAL_AHEAD = 21;
function dosesOnDay(iso){
  const today = doseDayISO(), colorMap = protocolColorMap(), out = [];
  state.protocols.filter(p=>p.status!=='archived').forEach(p=>{
    const color = colorMap.get(p.id) || 'var(--muted)';
    injectionEvents(p).filter(e=>e.day===iso).forEach(e=> out.push({kind:'taken', p, color, t:e.t, day:e.day, amt:fmtAmount(e.mg)}));
    if(!isActiveP(p) || (p.startDate && iso < p.startDate)) return;
    const sched = iso < today ? doseDatesInRange({...p, nextDose:null}, iso, iso) : doseDatesInRange(p, iso, iso);
    if(!sched.length) return;
    const n = splitCount(p), left = n - injectionsOn(p, iso);
    const d = doseAt(p, iso), units = unitsPerInjection(p, iso);
    const amt = fmtDose(num(d.dose)/n, d.doseUnit) + (units!=null ? ` · ${units}u` : '');
    const base = momentOn(iso, p.doseTime||'') || new Date(iso+'T12:00:00').getTime();
    for(let i=0;i<left;i++) out.push({kind: iso < today ? 'missed' : 'due', p, color, t: base + i*Math.min(8, 12/n)*HOUR, amt, timed: !!p.doseTime});
  });
  return out.sort((a,b)=> a.t-b.t);
}
function renderDoseCalendar(){
  const el = $('#doseCalendar'), list = $('#doseDayList');
  if(!el || !list) return;
  const today = doseDayISO();
  if(!calDay || daysBetween(calDay, today) > CAL_BACK || daysBetween(today, calDay) > CAL_AHEAD) calDay = today;
  const start = addDays(today, -CAL_BACK);
  let html = `<div class="week-strip cal-strip">`;
  for(let i=0;i<=CAL_BACK+CAL_AHEAD;i++){
    const iso = addDays(start, i), d = new Date(iso+'T00:00:00');
    const marks = dosesOnDay(iso).map(x=> x.kind==='taken'
      ? `<span style="background:${x.color};"></span>`
      : `<span style="border:1.5px solid ${x.color};${x.kind==='missed'?'opacity:.55;':''}"></span>`).join('');
    html += `<button type="button" class="day-chip ${iso===today?'today':''} ${iso===calDay?'sel':''} ${iso<today?'past':''}" data-cal-day="${iso}" aria-pressed="${iso===calDay}" aria-label="${esc(d.toLocaleDateString(undefined,{weekday:'long', month:'long', day:'numeric'}))}">
      <div class="dow">${d.toLocaleDateString(undefined,{weekday:'short'})}</div>
      <div class="num">${d.getDate()}</div>
      <div class="marks">${marks}</div>
    </button>`;
  }
  html += `</div><div class="cal-key"><span><i class="k-fill"></i>Logged</span><span><i class="k-ring"></i>Scheduled</span>${calDay!==today?`<button type="button" class="link-btn" data-cal-today>Back to today</button>`:''}</div>`;
  el.innerHTML = html;
  const strip = $('.cal-strip', el), sel = $('.day-chip.sel', el);
  if(sel) strip.scrollLeft = sel.offsetLeft - strip.offsetLeft - (strip.clientWidth - sel.offsetWidth)/2;
  $$('[data-cal-day]', el).forEach(b=> b.addEventListener('click', ()=>{
    const left = strip.scrollLeft;
    calDay = b.dataset.calDay; haptic('select'); renderDoseCalendar();
    const s2 = $('.cal-strip', el); if(s2) s2.scrollLeft = left;   // keep the strip where the finger left it
  }));
  const back = $('[data-cal-today]', el);
  if(back) back.addEventListener('click', ()=>{ calDay = today; renderDoseCalendar(); });

  const lbl = $('#doseDayLabel');
  const diff = daysBetween(today, calDay);
  const dayName = diff===0 ? 'Today' : diff===1 ? 'Tomorrow' : diff===-1 ? 'Yesterday' : new Date(calDay+'T00:00:00').toLocaleDateString(undefined,{weekday:'short', month:'short', day:'numeric'});
  if(lbl) lbl.textContent = dayName;
  const rows = dosesOnDay(calDay);
  if(!rows.length){
    list.innerHTML = `<p class="footnote cal-empty">${!state.protocols.some(isActiveP) && diff>=0 ? 'No active protocols. Add one under Protocols below.' : diff<0 ? `Nothing logged ${diff===-1?'yesterday':'on this day'}.` : `No doses scheduled ${diff===0?'today':diff===1?'tomorrow':'on this day'}.`}</p>`;
    return;
  }
  const pill = {taken:'<span class="pill pill-good">Taken</span>', due: diff===0 ? '<span class="pill pill-pep">Due</span>' : '<span class="pill pill-info">Scheduled</span>', missed:'<span class="pill pill-warn">Missed</span>'};
  list.innerHTML = rows.map((r,i)=>{
    const time = r.kind==='taken' || r.timed ? new Date(r.t).toLocaleTimeString(undefined,{hour:'numeric', minute:'2-digit'}) : '';
    return `<button type="button" class="dose-row" data-cal-row="${i}">
      <span class="what"><span class="serum-dot" style="display:inline-block;background:${r.color};margin-right:6px;"></span>${esc(r.p.compound||'Untitled')}${time?` <span class="footnote">${esc(time)}</span>`:''}</span>
      <span class="amt mono">${esc(r.amt)}</span>
      <span class="cal-pill">${pill[r.kind]}</span>
    </button>`;
  }).join('') + (diff<=0 ? `<p class="footnote" style="margin-top:6px;">Tap a logged dose to change its amount or time, or a missed one to backfill it.</p>` : '');
  $$('[data-cal-row]', list).forEach(b=> b.addEventListener('click', ()=>{
    const r = rows[+b.dataset.calRow], p = state.protocols.find(x=>x.id===r.p.id);
    if(!p) return;
    if(r.kind==='due' && diff===0) openDoseModal(p);
    else if(r.kind==='due') openProtocolModal(p);
    else if(r.kind==='taken') openEditDose(p, r.day, r.t);
    else openDoseHistoryModal(p);
  }));
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
  const el = $('#protocolList');
  const active = state.protocols.filter(isActiveP);
  const paused = state.protocols.filter(p=>p.status==='paused').sort((a,b)=> (a.compound||'').localeCompare(b.compound||''));
  const lbl = $('#doseTodayLabel');
  if(lbl){
    const day = doseDayISO();
    const sched = active.filter(p=> doseDatesInRange(p, day, day).length);
    const due = sched.filter(p=> injectionsOn(p, day) < splitCount(p)).length;
    const loggedToday = active.some(p=> injectionsOn(p, day) > 0);
    lbl.textContent = !active.length ? '' : due ? `${due} due today` : (sched.length || loggedToday) ? 'All done for today ✓' : 'No doses due today';
  }
  if(!active.length){
    el.innerHTML = `<div class="empty"><div class="glyph">💉</div><p>No active protocols. Add one to start logging doses.</p><button type="button" class="btn btn-sm" data-add-proto>+ Add protocol</button></div>`;
    $$('[data-add-proto]',el).forEach(b=> b.addEventListener('click', ()=> $('#addProtocolBtn').click()));
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
  // each pen gets a round button: orange ✓ opens a quick confirm sheet for today's dose, green ✓ means it's done
  const quick = p=>{
    if(p.startDate && p.startDate > day) return `<span class="pen-quick none"></span>`;
    const done = injectionsOn(p, day) >= splitCount(p), due = doseDatesInRange(p, day, day).length>0;
    if(done && injectionsOn(p, day)>0) return `<button type="button" class="pen-quick done" data-pen="${p.id}" aria-label="${esc(p.compound||'Dose')} logged today. Open details."><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg></button>`;
    if(!due) return `<span class="pen-quick none"></span>`;
    return `<button type="button" class="pen-quick" data-quick-log="${p.id}" aria-label="Log ${esc(p.compound||'dose')} now"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg></button>`;
  };
  el.innerHTML = `<div class="pen-list">${ordered.map((p,i)=> `<div class="pen-row">${penRowHTML(p, colorMap.get(p.id) || PROTOCOL_COLORS[0], day, i)}${quick(p)}</div>`).join('')}</div>`;
  $$('[data-pen]',el).forEach(b=> b.addEventListener('click', ()=> openDoseModal(state.protocols.find(x=>x.id===b.dataset.pen))));
  $$('[data-quick-log]',el).forEach(b=> b.addEventListener('click', ()=> openQuickLog(state.protocols.find(x=>x.id===b.dataset.quickLog))));
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
/* Concentration (mg/mL) a protocol draws at: the active vial's, else the protocol's own vial recipe. */
function protoConc(p){
  const v = p && p.activeVialId ? state.vials.find(x=> x.id===p.activeVialId) : null;
  if(v){
    if(num(v.concentration,0) > 0) return num(v.concentration);
    if(num(v.mgPerVial,0) > 0 && num(v.bacMl,0) > 0) return num(v.mgPerVial)/num(v.bacMl);
  }
  return num(p && p.vialMg,0) > 0 && num(p && p.bacMl,0) > 0 ? num(p.vialMg)/num(p.bacMl) : null;
}
/* Dose amount editor shared by the log and edit sheets: syringe units (when the vial's strength is known) and the
   amount in mg or mcg, kept in step with each other. */
function doseEditorHTML(conc, perMg, unit){
  const units0 = conc && perMg ? Math.round(perMg/conc*100*10)/10 : '';
  const shown = perMg ? Math.round((unit==='mcg' ? perMg*1000 : perMg)*1000)/1000 : '';
  const pill = `<div class="unit-pill" role="radiogroup" aria-label="Dose unit">${['mg','mcg'].map(u=> `<button type="button" data-qlu="${u}" class="${u===unit?'on':''}" role="radio" aria-checked="${u===unit}">${u}</button>`).join('')}</div>`;
  return conc ? `
      <div class="ql-k">Units</div>
      <div class="ql-step"><button type="button" data-ql-step="-1" aria-label="One unit less">−</button><input id="qlUnits" type="number" inputmode="decimal" step="any" min="0" value="${units0}" aria-label="Units"><button type="button" data-ql-step="1" aria-label="One unit more">+</button></div>
      <div class="ql-row ql-amt"><span class="ql-k">Amount</span><div class="ql-amt-in"><input id="qlDose" type="number" inputmode="decimal" step="any" min="0" value="${shown}" aria-label="Amount">${pill}</div></div>
      <div class="ql-eq" id="qlEq"></div>` : `
      <div class="ql-k">Dose</div>
      <div class="ql-step"><button type="button" data-ql-step="-1" aria-label="Less">−</button><input id="qlDose" type="number" inputmode="decimal" step="any" min="0" value="${shown}" aria-label="Dose"><button type="button" data-ql-step="1" aria-label="More">+</button></div>
      <div class="ql-unit-row">${pill}</div>
      <div class="ql-eq" id="qlEq">Add the vial's concentration to the protocol to log in units too.</div>`;
}
function bindDoseEditor(body, conc, unit0, onChange){
  const uIn = $('#qlUnits',body), dIn = $('#qlDose',body);
  let unit = unit0;
  const mg = ()=> unit==='mcg' ? num(dIn.value,0)/1000 : num(dIn.value,0);
  const setDose = m=>{ dIn.value = m>0 ? String(Math.round((unit==='mcg' ? m*1000 : m)*1000)/1000) : ''; };
  if(uIn){
    uIn.addEventListener('input', ()=>{ setDose(num(uIn.value,0)/100*conc); onChange(); });
    dIn.addEventListener('input', ()=>{ uIn.value = mg()>0 ? String(Math.round(mg()/conc*100*10)/10) : ''; onChange(); });
  } else dIn.addEventListener('input', onChange);
  $$('[data-qlu]',body).forEach(b=> b.addEventListener('click', ()=>{
    const m = mg(); unit = b.dataset.qlu;
    $$('[data-qlu]',body).forEach(x=>{ x.classList.toggle('on', x===b); x.setAttribute('aria-checked', x===b); });
    setDose(m); haptic('select'); onChange();
  }));
  $$('[data-ql-step]',body).forEach(b=> b.addEventListener('click', ()=>{
    const inp = uIn || dIn, st = uIn ? 1 : (unit==='mcg' ? 50 : 0.25);
    inp.value = String(Math.max(0, Math.round((num(inp.value,0) + st * +b.dataset.qlStep)*1000)/1000));
    inp.dispatchEvent(new Event('input')); haptic('select');
  }));
  return {mg, unit: ()=> unit};
}
/* Every logged injection with the amount actually taken written onto it, so a later change to the protocol's dose
   never rewrites history. */
function frozenTimes(p){ return injectionEvents(p).map(e=>({day:e.day, t:e.t, mg: Math.round(e.mg*1e6)/1e6})).slice(-400); }
/* Make perMg (one injection) the protocol's dose from the dose day `day` on: today's titration step if one is
   running, otherwise the base dose. Writes into upd. */
function setProtocolDose(cur, upd, perMg, unit, day){
  const n = splitCount(cur), d = doseAt(cur, day);
  const dayDose = String(Math.round((unit==='mcg' ? perMg*1000 : perMg)*n*1000)/1000);
  if(d.step>0){
    const steps = titrationSteps(cur).map(x=>({...x})), st = steps[d.step-1];
    if(st){ st.dose = dayDose; st.doseUnit = unit; upd.titration = steps; }
  } else { upd.dose = dayDose; upd.doseUnit = unit; }
  const conc = protoConc(cur);
  if(conc) upd.units = String(Math.round(perMg/conc*100*n*10)/10);
}
const doseChangeNote = (p, from, to)=> `${p.compound||'This protocol'}'s dose will change from ${from} to ${to} for this and future doses.`;
/* Quick log (the ✓ beside a pen): confirm today's injection, adjust the units or the amount if needed (which becomes
   the protocol's dose from now on), pick the time and, optionally, the injection site, then log it. */
function openQuickLog(p, hhmm){
  if(!p) return;
  const day = doseDayISO(), n = splitCount(p), d = doseAt(p, day);
  const conc = protoConc(p);
  const perMg = (doseToMg(d.dose, d.doseUnit) || 0) / n;
  const unit = d.doseUnit || 'mg';
  const now = new Date(), hh = String(now.getHours()).padStart(2,'0'), mm = String(now.getMinutes()).padStart(2,'0');
  const done = injectionsOn(p, day);
  const sst = {site:'', spot:''};
  openModal(p.compound || 'Log dose', `
    <div class="ql">
      ${n>1 ? `<div class="footnote ql-sub">Injection ${done+1} of ${n} today</div>` : ''}
      ${doseEditorHTML(conc, perMg, unit)}
      <div class="ql-change" id="qlChange" hidden></div>
      <div class="ql-row"><span class="ql-k">Time</span><input type="time" id="qlTime" value="${hhmm || `${hh}:${mm}`}"></div>
      <div class="ql-k" style="margin-top:14px;">Injection site <span class="ql-opt">optional</span></div>
      <div class="body-map ql-map" id="qlMap"></div>
      <div class="footnote ql-site" id="qlSite"></div>
    </div>
    <div class="form-actions"><button type="button" class="btn" id="qlCancel">Cancel</button><button type="button" class="btn btn-accent-pep" id="qlGo">${SYRINGE_ICON}<span>Log dose</span></button></div>
  `, body=>{
    let ed;
    const changed = ()=> Math.abs(ed.mg() - perMg) > 1e-6;
    const refresh = ()=>{
      const mg = ed.mg();
      if(conc && n>1) $('#qlEq',body).textContent = mg>0 ? `${fmtAmount(mg*n)} for the day` : '';
      const ch = $('#qlChange',body);
      ch.hidden = !changed() || !(mg>0);
      if(!ch.hidden) ch.textContent = doseChangeNote(p, fmtDose(d.dose, unit), fmtAmount(mg*n));
      $('#qlGo',body).disabled = !(mg>0);
    };
    ed = bindDoseEditor(body, conc, unit, refresh);
    const siteNote = ()=>{ $('#qlSite',body).innerHTML = sst.site ? `Logging <strong>${esc(sst.site)}</strong>. Tap the square again to clear.` : `Tap where you injected. Suggested next: <strong>${esc(suggestNextSite(p))}</strong>.`; };
    bindBodyMap($('#qlMap',body), p, sst, siteNote);
    $('#qlCancel',body).addEventListener('click', closeModal);
    $('#qlGo',body).addEventListener('click', async ()=>{
      const mg = ed.mg(); if(!(mg>0)) return;
      $('#qlGo',body).disabled = true;
      let cur = state.protocols.find(x=> x.id===p.id) || p;
      const upd = {...stripId(cur)};
      if(changed()){
        upd.doseTimes = frozenTimes(cur);            // earlier doses keep the amount they were logged at
        setProtocolDose(cur, upd, mg, ed.unit(), day);
      }
      if(sst.site){
        const log = siteLogOf(cur).filter(e=> e.date!==day).concat({date:day, site:sst.site, spot:sst.spot}).sort((a,b)=> (a.date||'').localeCompare(b.date||''));
        upd.siteLog = log.slice(-60);
      }
      if(changed() || sst.site){ await dbSet('protocols', cur.id, upd); cur = state.protocols.find(x=> x.id===p.id) || cur; }
      const time = $('#qlTime',body).value || nowHHMM();
      closeModal();
      await logInjection(cur, day, 1, time, mg);
      showToast(`Logged ${p.compound||'dose'} · ${fmtAmount(mg)}${sst.site ? ' · '+sst.site : ''}`);
      maybeCelebrate();
    });
    siteNote(); refresh();
  });
}
/* Edit a dose that's already logged: the amount taken and the time. Changing the amount of the most recent dose also
   makes it the protocol's dose from now on. Delete removes the injection and puts it back in the vial. */
function openEditDose(p, day, t){
  if(!p) return;
  const evs = frozenTimes(p);
  const idx = evs.findIndex(e=> e.day===day && e.t===t);
  if(idx<0) return openDoseHistoryModal(p);
  const ev = evs[idx], n = splitCount(p), conc = protoConc(p);
  const unit = doseAt(p, day).doseUnit || 'mg';
  const latest = evs.reduce((a,e)=> e.t > a.t ? e : a, evs[0]) === ev;
  const dt = new Date(ev.t), hh = String(dt.getHours()).padStart(2,'0'), mm = String(dt.getMinutes()).padStart(2,'0');
  const cur0 = doseAt(p, doseDayISO());
  openModal(`Edit dose`, `
    <div class="ql">
      <div class="footnote ql-sub">${esc(p.compound||'Dose')} · ${esc(new Date(day+'T00:00:00').toLocaleDateString(undefined,{weekday:'long', month:'long', day:'numeric'}))}</div>
      ${doseEditorHTML(conc, ev.mg, unit)}
      <div class="ql-change" id="qlChange" hidden></div>
      <div class="ql-row"><span class="ql-k">Time</span><input type="time" id="qlTime" value="${hh}:${mm}"></div>
    </div>
    <div class="form-actions"><button type="button" class="btn btn-danger" id="edDel">Delete</button><button type="button" class="btn" id="qlCancel">Cancel</button><button type="button" class="btn btn-accent-pep" id="edSave">Save</button></div>
  `, body=>{
    let ed;
    const changed = ()=> Math.abs(ed.mg() - ev.mg) > 1e-6;
    const refresh = ()=>{
      const mg = ed.mg();
      if(conc && n>1) $('#qlEq',body).textContent = '';
      const ch = $('#qlChange',body);
      ch.hidden = !(latest && changed() && mg>0);
      if(!ch.hidden) ch.textContent = doseChangeNote(p, fmtDose(cur0.dose, cur0.doseUnit), fmtAmount(mg*n));
      $('#edSave',body).disabled = !(mg>0);
    };
    ed = bindDoseEditor(body, conc, unit, refresh);
    $('#qlCancel',body).addEventListener('click', closeModal);
    $('#edDel',body).addEventListener('click', ()=> confirmAction(`Delete this ${p.compound||''} dose? It goes back into the active vial.`, async ()=>{
      const cur = state.protocols.find(x=> x.id===p.id) || p;
      // put the chosen injection last for its day so the usual removal takes exactly this one
      const times = frozenTimes(cur), k = times.findIndex(e=> e.day===day && e.t===t);
      if(k>-1){ const [x] = times.splice(k,1); times.push(x); }
      await dbSet('protocols', cur.id, {...stripId(cur), doseTimes: times});
      await logInjection(state.protocols.find(x=> x.id===p.id), day, -1);
      showToast('Dose deleted');
    }));
    $('#edSave',body).addEventListener('click', async ()=>{
      const mg = ed.mg(); if(!(mg>0)) return;
      $('#edSave',body).disabled = true;
      const cur = state.protocols.find(x=> x.id===p.id) || p;
      const times = frozenTimes(cur), k = times.findIndex(e=> e.day===day && e.t===t);
      if(k<0){ closeModal(); return; }
      const oldMg = times[k].mg;
      times[k] = {...times[k], mg: Math.round(mg*1e6)/1e6, t: momentOn(day, $('#qlTime',body).value) || times[k].t};
      const upd = {...stripId(cur), doseTimes: times};
      if(latest && changed()) setProtocolDose(cur, upd, mg, ed.unit(), doseDayISO());
      await dbSet('protocols', cur.id, upd);
      // the active vial gives or takes back the difference
      const vial = cur.activeVialId ? state.vials.find(v=> v.id===cur.activeVialId) : null;
      if(vial && vial.remainingMg!=null && Math.abs(mg-oldMg) > 1e-9){
        const rem = Math.max(0, Math.min(num(vial.mgPerVial, Infinity), round2(num(vial.remainingMg,0) - (mg-oldMg))));
        await dbSet('vials', vial.id, {...stripId(vial), remainingMg: rem});
      }
      closeModal(); showToast('Dose updated');
    });
    refresh();
  });
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
        <div class="log-acts"><button type="button" class="btn log-adj" id="doseAdj">Change amount</button><button type="button" class="btn btn-accent-pep log-go" id="doseGo">${SYRINGE_ICON}<span>Log dose</span></button></div>
      </div>`;
  openModal(p.compound || 'Dose', `
    <div class="pen-hero">${penRowHTML(p, color, day, 'm').replace('<button type="button" class="dose-pen"', '<div class="dose-pen static"').replace(/<\/button>$/, '</div>')}</div>
    ${box}
    ${doseCardHTML(p, color, day, serum, {bodyOnly:true})}
  `, body=>{
    bindDoseDetail(body, serum);
    const adj = $('#doseAdj',body);
    if(adj) adj.addEventListener('click', ()=>{ const t = $('#doseTime',body).value; closeModal(); setTimeout(()=> openQuickLog(state.protocols.find(x=> x.id===p.id) || p, t), 260); });
    const go = $('#doseGo',body);
    if(go) go.addEventListener('click', async ()=>{ go.disabled = true; await logInjection(p, day, 1, $('#doseTime',body).value); closeModal(); maybeCelebrate(); });
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
  const hubX = 26, holderX = 34, bodyX = 132, dialX = 316, chromeX = 332, end = 342;
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
    <linearGradient id="${id}hub" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#b9bec6" stop-opacity=".5"/><stop offset=".3" stop-color="#ffffff" stop-opacity=".75"/><stop offset=".6" stop-color="#eef0f3" stop-opacity=".35"/><stop offset="1" stop-color="#a7adb5" stop-opacity=".5"/></linearGradient>
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
  <rect x="${hubX-16}" y="${cy-.55}" width="16" height="1.1" fill="url(#${id}rod)"/>
  <path d="M${hubX} ${cy-8} H${holderX+1} V${cy+8} H${hubX} Q${hubX-3} ${cy+8} ${hubX-3} ${cy+5} V${cy-5} Q${hubX-3} ${cy-8} ${hubX} ${cy-8}Z" fill="url(#${id}hub)" stroke="#8b929b" stroke-opacity=".45" stroke-width=".6"/>
  ${Array.from({length:3},(_,i)=>`<rect x="${hubX+1.5+i*2.6}" y="${cy-8}" width=".7" height="16" fill="#6b7280" fill-opacity=".22"/>`).join('')}
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
   active vial in step. Works for today and for backfilled days. */
function momentOn(day, hhmm){
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm||''); if(!m) return null;
  const d = new Date(day+'T00:00:00'); d.setHours(+m[1], +m[2], 0, 0);
  if(+m[1] < 2) d.setDate(d.getDate()+1);   // 12–2am still belongs to the previous dose day
  return d.getTime();
}
async function logInjection(p, day, delta, hhmm, mgTaken){
  if(delta>0) haptic('success');
  if(!p) return;
  const n = splitCount(p);
  const log = Array.isArray(p.doseLog) ? p.doseLog.slice() : [];
  let times = Array.isArray(p.doseTimes) ? p.doseTimes.slice() : [];   // exact injection moments, for the serum chart
  const before = log.filter(x=>x===day).length;
  const dd = doseAt(p, day), planned = (doseToMg(dd.dose, dd.doseUnit)||0)/n;
  let moved = planned;   // mg taken from (or returned to) the active vial
  if(delta>0){
    if(before>=n) return;
    moved = mgTaken>0 ? mgTaken : planned;
    log.push(day); times.push({day, t: momentOn(day, hhmm) || (day===doseDayISO() ? Date.now() : new Date(day+'T12:00:00').getTime()), mg: Math.round(moved*1e6)/1e6});
  } else {
    const i = log.lastIndexOf(day); if(i<0) return; log.splice(i,1);
    for(let k=times.length-1;k>=0;k--) if(times[k].day===day){ if(num(times[k].mg,null)!=null) moved = num(times[k].mg); times.splice(k,1); break; }
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
  // Active vial: each injection draws its share of that day's dose.
  if(p.activeVialId){
    const vial = state.vials.find(v=>v.id===p.activeVialId);
    if(vial && vial.remainingMg!=null && moved){
      const change = -moved * (delta>0 ? 1 : -1);
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
    <p class="footnote" style="margin-bottom:10px;">Log a missed injection, or remove one logged by mistake. Each change also adjusts the active vial. The time below is used for doses you add here, so the serum chart is accurate.</p>
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
/* Protocols (bottom of Today): every non-archived protocol, tap to edit. */
function relDay(iso){
  const t = doseDayISO(), n = daysBetween(t, iso);
  if(n===0) return 'Today'; if(n===1) return 'Tomorrow'; if(n===-1) return 'Yesterday';
  if(n>1 && n<7) return new Date(iso+'T00:00:00').toLocaleDateString(undefined,{weekday:'long'});
  return fmtDateShort(iso);
}
function renderProtocolManager(){
  const el = $('#protocolManager');
  if(!el) return;
  const list = state.protocols.filter(p=>p.status!=='archived')
    .sort((a,b)=> (a.status==='paused') - (b.status==='paused') || (a.compound||'').localeCompare(b.compound||'', undefined, {sensitivity:'base'}));
  if(!list.length){ el.innerHTML = `<div class="empty"><div class="glyph">📋</div><p>No protocols yet. Add one to set its dose, schedule and vial.</p></div>`; return; }
  const colorMap = protocolColorMap();
  el.innerHTML = list.map((p,pi)=>{
    const day = doseDayISO();
    const d = doseAt(p, day);
    const u = unitsPerInjection(p, day);
    const paused = p.status==='paused';
    const notStarted = p.startDate && p.startDate > todayISO();
    const freq = num(p.frequencyDays,null);
    const sched = scheduleTag(p) || (freq ? (freq===1 ? 'Daily' : `Every ${freq} days`) : 'No schedule');
    const hl = halfLifeOf(p);
    const parts = blendParts(p);
    const color = colorMap.get(p.id) || 'var(--muted)';
    const vial = p.activeVialId ? state.vials.find(v=> v.id===p.activeVialId) : null;
    const pct = vial && vial.remainingMg!=null && num(vial.mgPerVial,0)>0 ? Math.max(0, Math.min(1, num(vial.remainingMg,0)/num(vial.mgPerVial,1))) : null;
    // next dose: today (if any injection is still to do), otherwise the protocol's next scheduled day
    let next = '';
    if(paused) next = 'Paused';
    else if(notStarted) next = `Starts ${relDay(p.startDate)}`;
    else {
      const todayLeft = doseDatesInRange(p, day, day).length && injectionsOn(p, day) < splitCount(p);
      const nd = todayLeft ? day : (p.nextDose && p.nextDose > day ? p.nextDose : (doseDatesInRange(p, addDays(day,1), addDays(day,60))[0] || ''));
      const t = fmtClock(p.doseTime);
      next = nd ? `${nd===day && p.nextDose && p.nextDose < day ? 'Overdue' : relDay(nd)}${t ? ' · '+t : ''}` : '';
    }
    const steps = titrationSteps(p), stepNow = steps.filter(s0=> s0.start <= day).length;
    const ring = steps.length ? (()=>{ const f = stepNow/steps.length, C2 = 2*Math.PI*15;
      return `<span class="pm-ring" title="Titration step ${stepNow} of ${steps.length}"><svg viewBox="0 0 36 36"><circle cx="18" cy="18" r="15" class="pm-ring-bg"/><circle cx="18" cy="18" r="15" class="pm-ring-fg" style="stroke:${color};stroke-dasharray:${(C2*f).toFixed(1)} ${C2.toFixed(1)}"/></svg><span>${stepNow}/${steps.length}</span></span>`; })() : '';
    const meta = [splitCount(p)>1 ? `${splitCount(p)}× a day` : '', parts ? parts.map(c=>c.name).join(' + ') : hl ? `t½ ${fmtHours(hl)}` : '', u!=null ? `${u} units` : ''].filter(Boolean).join(' · ');
    return `<div class="pm-row2 ${paused?'paused-row':''}" data-open-protocol="${p.id}" role="button" tabindex="0" style="--pc:${color}">
      <div class="pm-art">${vialSVG({color, pct: pct==null ? null : pct, mgTag:'', name: p.compound||'', brand:'', lot:''}, 'pm'+pi)}</div>
      <div class="pm-main">
        <div class="pm-top"><strong>${esc(p.compound||'Untitled compound')}</strong><span class="pill pill-pep">${esc(fmtDose(d.dose, d.doseUnit))}</span></div>
        <div class="pm-next ${paused?'is-paused':''}">${next ? esc(next) : esc(sched)}</div>
        <div class="pm-meta">${esc(sched)}${meta ? ' · '+esc(meta) : ''}</div>
      </div>
      ${paused ? `<button class="btn btn-sm" data-resume-protocol="${p.id}">▶ Resume</button>` : ring || '<span class="ios-chev" aria-hidden="true"></span>'}
    </div>`;
  }).join('');
  $$('[data-open-protocol]',el).forEach(c=> c.addEventListener('click', ()=> openProtocolModal(state.protocols.find(p=>p.id===c.dataset.openProtocol))));
  $$('[data-resume-protocol]',el).forEach(b=> b.addEventListener('click', e=>{ e.stopPropagation(); resumeProtocol(state.protocols.find(p=>p.id===b.dataset.resumeProtocol)); }));
}
function renderArchivedProtocols(){
  const el = $('#archivedProtocolList');
  if(!el) return;
  const archived = state.protocols.filter(p=>p.status==='archived').sort((a,b)=> (b.endedDate||'').localeCompare(a.endedDate||''));
  const card = el.closest('.card'); if(card) card.hidden = !archived.length;
  if(!archived.length){ el.innerHTML = ''; return; }
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

function activeVialOptions(compound, selectedId, isBlend){
  const c = (compound||'').trim().toLowerCase();
  const list = state.vials.filter(v=> !isDepleted(v) && ((c && (v.compound||'').trim().toLowerCase()===c) || (isBlend && isMixedBlend(v)) || v.id===selectedId));
  return `<option value="">${c && !list.length ? 'No vials of this compound in your stash' : 'None'}</option>` +
    list.map(v=>`<option value="${v.id}" ${selectedId===v.id?'selected':''}>${esc(vialLabel(v))}</option>`).join('');
}
function openProtocolModal(existing, prefill){
  const p = existing || prefill || {};
  const notStarted = p.startDate && p.startDate > todayISO();
  const curSyr = (p.syringeMl!=null && p.syringeMl!=='') ? parseFloat(p.syringeMl) : 1;
  const syrIsCustom = !SYRINGE_SIZES.some(s=> parseFloat(s.ml)===curSyr);
  const split = splitCount(p);
  openModal(existing? 'Edit protocol' : 'Add protocol', `
    <div class="form-grid">
      <div class="field span2"><label for="pCompound">Compound</label><input id="pCompound" type="text" value="${esc(p.compound||'')}" placeholder="e.g. BPC-157"></div>
      <div class="field span2"><label for="pDose">Dose</label>
        <div class="dose-in"><input id="pDose" type="number" inputmode="decimal" step="any" value="${esc(p.dose||'')}" placeholder="e.g. 2.5">
          ${(()=>{ const u = existing && p.doseUnit ? p.doseUnit : (p.doseUnit || 'mg'); return `<input type="hidden" id="pDoseUnit" value="${u}"><div class="unit-pill" role="radiogroup" aria-label="Dose unit"><button type="button" data-du="mg" class="${u==='mg'?'on':''}" role="radio" aria-checked="${u==='mg'}">mg</button><button type="button" data-du="mcg" class="${u==='mcg'?'on':''}" role="radio" aria-checked="${u==='mcg'}">mcg</button></div>`; })()}
        </div></div>
      <div class="field span2"><label for="pUnits">Units</label><input id="pUnits" type="number" inputmode="decimal" step="any" min="0" value="${esc(p.units||'')}" placeholder="Syringe units, e.g. 20">
        <div class="footnote" id="pUnitsOut" style="margin-top:4px;"></div></div>
      <div class="field span2"><label for="pSplit">Split each dose day into</label>
        <select id="pSplit">${[1,2,3,4].map(k=>`<option value="${k}" ${split===k?'selected':''}>${k===1?'1 injection (no split)':k+' injections'}</option>`).join('')}</select>
        <div class="footnote" id="pSplitOut" style="margin-top:4px;"></div>
      </div>
      <div class="field span2"><label for="pHalfLife">Half-life (hours) <span style="font-weight:400;color:var(--muted);">: drives the serum level chart</span></label>
        <input id="pHalfLife" type="number" inputmode="decimal" step="any" min="0" value="${esc(p.halfLifeHours||'')}" placeholder="">
        <div class="footnote" id="pHalfLifeHint" style="margin-top:4px;"></div>
      </div>
      <div class="field span2 module-box">
        <label class="endo-check" style="margin:0;color:var(--ink);"><input type="checkbox" id="pIsBlend" ${blendOf(p)?'checked':''}> This is a blend of several peptides</label>
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
          ${activeVialOptions(p.compound, p.activeVialId, !!blendOf(p))}
        </select>
      </div>
      <div class="field span2 module-box">
        <label style="margin-bottom:6px;display:block;">Reconstitution <span style="font-weight:400;color:var(--muted);">: lets Dose and Units fill each other in. Uses the active vial if left blank.</span></label>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
          <div><label for="pVialMg" class="footnote" style="display:block;margin-bottom:3px;">Vial size (mg)</label><input id="pVialMg" type="number" inputmode="decimal" step="any" min="0" value="${esc(p.vialMg||'')}" placeholder="e.g. 10"></div>
          <div><label for="pBacMl" class="footnote" style="display:block;margin-bottom:3px;">BAC water added (mL)</label><input id="pBacMl" type="number" inputmode="decimal" step="any" min="0" value="${esc(p.bacMl||'')}" placeholder="e.g. 2"></div>
        </div>
        <div class="footnote" id="pConcOut" style="margin-top:6px;min-height:14px;"></div>
      </div>
      <div class="field span2"><label for="pSyringeMl">Syringe size</label>
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
              ${SITE_NAMES.map(n=>`<option value="${esc(n)}">${esc(n)}</option>`).join('')}
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
      ${existing && isActiveP(p) && !notStarted? `<button class="btn" id="pPause" title="Pause: stops scheduling but keeps the vial link">⏸ Pause</button>` : ''}
      ${existing && p.status!=='archived' && !notStarted? `<button class="btn" id="pArchive" title="Archive: ends it but keeps the record">Archive</button>` : ''}
      <button class="btn" id="pCancel">Cancel</button>
      <button class="btn btn-accent-pep" id="pSave">Save</button>
    </div>
  `, body=>{
    // Dose ↔ Units: whichever you type fills in the other once a concentration is known
    // (the reconstitution fields, else the chosen active vial). Both are for the whole dose day.
    function concNow(){
      const vialMg = parseFloat($('#pVialMg',body).value), bacMl = parseFloat($('#pBacMl',body).value);
      if(isFinite(vialMg) && vialMg>0 && isFinite(bacMl) && bacMl>0) return vialMg/bacMl;
      const v = state.vials.find(x=> x.id===$('#pActiveVial',body).value);
      if(v){ if(num(v.concentration,0)>0) return num(v.concentration); if(num(v.mgPerVial,0)>0 && num(v.bacMl,0)>0) return num(v.mgPerVial)/num(v.bacMl); }
      return null;
    }
    function hints(){
      const n = parseInt($('#pSplit',body).value,10) || 1, conc = concNow();
      const dose = parseFloat($('#pDose',body).value), doseUnit = $('#pDoseUnit',body).value, units = parseFloat($('#pUnits',body).value);
      $('#pSplitOut',body).textContent = (n>1 && isFinite(dose) && dose>0) ? `${n} injections of ${fmtDose(dose/n, doseUnit)} each.` : '';
      $('#pConcOut',body).textContent = conc ? `${conc.toFixed(2)} mg/mL` : '';
      $('#pUnitsOut',body).textContent = conc
        ? (isFinite(units) && units>0 && n>1 ? `${Math.round(units/n*10)/10} units per injection` : '')
        : 'Add the vial size and BAC water (or pick an active vial) to fill this in from the dose.';
    }
    function recalc(){
      const conc = concNow(), dose = parseFloat($('#pDose',body).value), doseUnit = $('#pDoseUnit',body).value;
      if(conc && isFinite(dose) && dose>0){
        const doseMg = doseUnit==='mcg' ? dose/1000 : dose;
        $('#pUnits',body).value = Math.round(doseMg/conc*100*10)/10;
      }
      hints();
    }
    function fromUnits(){
      const conc = concNow(), units = parseFloat($('#pUnits',body).value);
      if(conc && isFinite(units) && units>0){
        const mg = units/100*conc, unit = $('#pDoseUnit',body).value;
        $('#pDose',body).value = String(Math.round((unit==='mcg' ? mg*1000 : mg)*1000)/1000);
      }
      hints();
    }
    $('#pUnits',body).addEventListener('input', fromUnits);
    $('#pActiveVial',body).addEventListener('change', recalc);
    $$('[data-du]',body).forEach(b=> b.addEventListener('click', ()=>{
      const from = $('#pDoseUnit',body).value, to = b.dataset.du;
      if(from===to) return;
      $('#pDoseUnit',body).value = to;
      $$('[data-du]',body).forEach(x=>{ const on = x===b; x.classList.toggle('on', on); x.setAttribute('aria-checked', String(on)); });
      // same amount, new unit: 0.5 mg becomes 500 mcg, and the units stay as they are
      const dIn = $('#pDose',body), v = parseFloat(dIn.value);
      if(isFinite(v)) dIn.value = String(Math.round((to==='mcg' ? v*1000 : v/1000)*1e6)/1e6);
      hints();
      $('#pDoseUnit',body).dispatchEvent(new Event('input'));    // blend and split read-outs follow; units come out the same
    }));
    // Active-vial choices follow the compound name as you type it.
    $('#pCompound',body).addEventListener('input', ()=>{
      const sel = $('#pActiveVial',body), keep = sel.value;
      sel.innerHTML = activeVialOptions($('#pCompound',body).value, keep, $('#pIsBlend',body).checked);
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
    const pst = {site:'', spot:''};
    const drawMap = bindBodyMap($('#pSiteMap',body), p, pst, ()=>{ $('#pSite',body).value = pst.site; });
    $('#pSite',body).addEventListener('change', ()=>{
      const v = $('#pSite',body).value;
      pst.site = (v && v!=='__undo') ? v : ''; pst.spot = '';
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
        siteLog.push({date:sd, site:siteSel, ...(pst.spot && pst.site===siteSel ? {spot:pst.spot} : {})});
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
  // rough estimates (little human data); edit the protocol to use your own
  [/ghk-?cu|copper peptide/i, 1], [/\bkpv\b/i, 1], [/tb-?500|thymosin beta/i, 48],
];
function defaultHalfLife(name){
  const s = String(name||'');
  for(const r of HALF_LIFE_RULES){ if(r[0].test(s) && !(r[2] && r[2].test(s))) return r[1]; }
  return typeof libHalfLife==='function' ? libHalfLife(s) : null;     // else the peptide library's figure, once loaded
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
    const e = k>-1 ? times.splice(k,1)[0] : null;
    const t = e ? e.t : new Date(day+'T12:00:00').getTime();
    const d = doseAt(p, day);
    // the amount actually taken is kept on the injection; older entries fall back to the protocol's dose for that day
    return {t, mg: e && num(e.mg,null)!=null ? num(e.mg) : (doseToMg(d.dose, d.doseUnit)||0)/n, day};
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
        if(!c.hl){ if(isActiveP(p)) missing.push(`${c.name} (in ${p.compound||'your blend'})`); return; }
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
const SV = {W:400, H:236, padL:2, padR:2, padT:20, padB:24};
let serumGid = 0;   // unique ids for the chart's gradient defs (main chart and the mini charts share this drawer)
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
  const gid = 'sg'+(++serumGid), base = (H-padB).toFixed(1);
  let defs = '';
  lines.forEach((l,i)=>{
    const c = l.c.s.color;
    defs += `<linearGradient id="${gid}p${i}" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="${c}" stop-opacity=".34"/><stop offset="1" stop-color="${c}" stop-opacity="0"/></linearGradient>`
         +  `<linearGradient id="${gid}f${i}" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="${c}" stop-opacity=".13"/><stop offset="1" stop-color="${c}" stop-opacity="0"/></linearGradient>`;
  });
  let g = `<defs>${defs}</defs><rect x="0" y="0" width="${W}" height="${H}" fill="transparent"/>`;
  // light dashed gridlines, values tucked inside the plot just above each line
  niceTicks(0, yMax, 4).ticks.filter(v=> v>0 && v<=yMax*1.001).forEach(v=>{
    const y = Y(v);
    g += `<line x1="${padL}" x2="${W-padR}" y1="${y.toFixed(1)}" y2="${y.toFixed(1)}" class="ch-grid ch-grid-soft"/><text x="${padL+4}" y="${(y-4).toFixed(1)}" class="ch-ylab ch-ylab-in">${esc(fmtY(v))}</text>`;
  });
  g += `<line x1="${padL}" x2="${W-padR}" y1="${base}" y2="${base}" class="ch-base"/>`;
  [[t0,'start',4],[(t0+t1)/2,'middle',0],[t1,'end',-4]].forEach(([t,anchor,dx])=>{
    g += `<text x="${(X(t)+dx).toFixed(1)}" y="${H-6}" class="ch-xlab" text-anchor="${anchor}">${esc(serumAxisLabel(t))}</text>`;
  });
  const toPath = (l,pts)=> pts.map(p=>`${X(p.t).toFixed(1)},${Y(val(l,p.y)).toFixed(1)}`).join(' ');
  lines.forEach((l,i)=>{
    if(l.past.length>1) g += `<polygon points="${X(l.past[0].t).toFixed(1)},${base} ${toPath(l,l.past)} ${X(l.past[l.past.length-1].t).toFixed(1)},${base}" fill="url(#${gid}p${i})"/>`;
    if(l.fut.length>1) g += `<polygon points="${X(l.fut[0].t).toFixed(1)},${base} ${toPath(l,l.fut)} ${X(l.fut[l.fut.length-1].t).toFixed(1)},${base}" fill="url(#${gid}f${i})"/>`;
  });
  if(now>=t0 && now<=t1){
    const x = X(now);
    g += `<line x1="${x.toFixed(1)}" x2="${x.toFixed(1)}" y1="${padT}" y2="${base}" class="ch-now"/>`;
    g += `<rect x="${(x-15).toFixed(1)}" y="${padT-16}" width="30" height="14" rx="7" class="ch-now-pill"/><text x="${x.toFixed(1)}" y="${padT-6}" text-anchor="middle" class="ch-now-lab">Now</text>`;
  }
  // dose markers on the baseline: filled = logged, hollow = scheduled
  const seen = new Set();
  lines.forEach(l=>{
    if(seen.has(l.c.s.p.id)) return; seen.add(l.c.s.p.id);
    l.c.all.filter(e=> e.t>=t0 && e.t<=t1).forEach(e=>{
      const logged = e.t<=now && l.c.s.evs.some(v=>v.t===e.t);
      g += `<circle cx="${X(e.t).toFixed(1)}" cy="${base}" r="3.2" style="fill:${logged?l.c.s.color:'var(--surface)'};stroke:${l.c.s.color};stroke-width:1.4"/>`;
    });
  });
  ctx.scale = {t0, t1, X, Y, val, yMax};
  lines.forEach(l=>{
    if(l.past.length>1) g += `<polyline points="${toPath(l,l.past)}" class="ch-line" style="stroke:${l.c.s.color}"/>`;
    if(l.fut.length>1) g += `<polyline points="${toPath(l,l.fut)}" class="ch-line ch-line-fut" style="stroke:${l.c.s.color}"/>`;
    if(now>=t0 && now<=t1){
      const cur = levelAt(l.c.s.evs, l.c.s.hl, now), cx = X(now).toFixed(1), cy = Y(val(l,cur)).toFixed(1);
      g += `<circle cx="${cx}" cy="${cy}" r="9" style="fill:${l.c.s.color};opacity:.18"/><circle cx="${cx}" cy="${cy}" r="4.5" class="ch-cur" style="fill:${l.c.s.color}"><title>${esc(l.c.s.label)}: ${esc(fmtAmount(cur))} now</title></circle>`;
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
  const miss = missing.length ? `<p class="footnote" style="margin-top:8px;">Not charted (no half-life yet): ${missing.map(m=>esc(m)).join(', ')}. Add one in the protocol to chart it.</p>` : '';
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
/* Stash carousel: free-floating vials on a ring, three in full view with faded previews either side, looping forever.
   The swipe is driven here rather than by native scrolling, so every vial's position, size and fade are set together
   in the same frame. Letting go glides on at the finger's own speed and slows exponentially (like iOS scrolling),
   tuned to stop exactly on a vial; tapping a vial spins it to the centre. A light haptic tick plays per vial. */
let shelfPos = 1;   // centre of the carousel, in vials (vial 1 centred = first three in view); kept across re-renders
function bindShelf(row, n){
  const tiles = $$('.vial-tile', row), T = tiles.length;
  const wrap = (a, m)=> ((a % m) + m) % m;
  let sel = row.classList.contains('has-sel');
  // swiping again puts an opened vial away: drop the selection and its details without rebuilding the row mid-gesture
  const deselect = ()=>{
    if(!sel) return;
    sel = false; stashSel = null; lotSel = null;
    row.classList.remove('has-sel');
    tiles.forEach(t=>{ t.classList.remove('on'); t.setAttribute('aria-expanded','false'); });
    const det = row.parentElement && row.parentElement.querySelector('.vial-detail'); if(det) det.remove();
  };
  let W = 1, CW = 1, pos = shelfPos, anim = null, raf = 0, lastTick = null;
  const measure = ()=>{ CW = row.clientWidth; W = tiles[0].offsetWidth || CW/3.5 || 1; };
  function paint(){
    for(let i=0;i<T;i++){
      const t = tiles[i], u = wrap(i - pos + T/2, T) - T/2, a = Math.abs(u);   // slot relative to the centre, in vials
      if(a > 3){ if(t.style.visibility!=='hidden') t.style.visibility = 'hidden'; continue; }
      const e = Math.min(1, Math.max(0, a - 1));                                // the three in view stay full; previews fade
      const f = Math.max(0, 1 - a); const fe = f*f*(3 - 2*f);                   // centre focus, eased: 1 in the middle, 0 a vial away
      const x = CW/2 - W/2 + u*W - Math.sign(u)*e*W*.22;                        // previews tuck in a little
      if(t.style.visibility) t.style.visibility = '';
      // the middle vial is magnified and lifted slightly; its neighbours sit a touch softer; previews shrink and fade
      t.style.transform = `translate3d(${x.toFixed(1)}px,${(-6*fe).toFixed(2)}px,0) scale(${(1 + .16*fe - e*.14).toFixed(4)})`;
      t.style.opacity = ((1 - .14*Math.min(1, a)) * (1 - e*.55) * (sel && !t.classList.contains('on') ? .5 : 1)).toFixed(3);
    }
    const real = wrap(Math.round(pos), T) % n;
    if(real !== lastTick){ if(lastTick!=null) haptic('select'); lastTick = real; }
  }
  // animations are pure functions of time, so every frame lands exactly where it should whatever the frame rate
  function frame(now){
    raf = 0;
    if(!anim) return;
    if(anim.t0==null) anim.t0 = now;
    const t = now - anim.t0;
    if(t >= anim.dur){ pos = wrap(anim.to, T); anim = null; }
    else pos = anim.from + (anim.to - anim.from) * anim.ease(t / anim.dur, t);
    shelfPos = pos; paint();
    if(anim) raf = requestAnimationFrame(frame);
  }
  const run = a=>{ anim = {...a, from: pos, t0: performance.now()}; if(!raf) raf = requestAnimationFrame(frame); };
  // glide: starts at velocity (to-from)/tau and decays exponentially; ends when within a hair of the target
  const TAU = 300;
  const glide = to=> run({kind:'glide', to, dur: TAU*6, ease: (_, t)=> Math.min(1, (1 - Math.exp(-t/TAU)) / (1 - Math.exp(-6)))});
  // spin (tap): smooth ease-in-out, longer for vials further away
  const spin = to=>{ const d = Math.abs(to - pos); run({to, dur: Math.min(900, 280 + 110*d), ease: q=> q<.5 ? 4*q*q*q : 1 - Math.pow(-2*q + 2, 3)/2}); };
  const stop = ()=>{ anim = null; if(raf){ cancelAnimationFrame(raf); raf = 0; } };
  // gestures: touch events on the phone (they arrive with no delay), pointer events for a mouse or pen.
  // Horizontal moves are ours; vertical ones are left to the page (touch-action: pan-y).
  let drag = null, moved = false, caught = false;
  const start = (x, y, t)=>{
    caught = !!anim && Math.abs(anim.to - pos) > .02;      // touching a moving row catches it right where it is
    stop(); measure();
    drag = {x0:x, y0:y, p0:pos, s:[{x, t}], lock:false};
    moved = caught;                                         // ...and that touch isn't a tap on a vial
  };
  const move = (x, y, t)=>{
    if(!drag) return false;
    if(!drag.lock){
      const dx = x - drag.x0, dy = y - drag.y0;
      if(Math.abs(dx) < 4 && Math.abs(dy) < 4) return false;
      if(Math.abs(dy) > Math.abs(dx)){ drag = null; if(caught) glide(Math.round(pos)); return false; }
      drag.lock = true; moved = true; deselect();
    }
    drag.s.push({x, t}); if(drag.s.length > 12) drag.s.shift();
    pos = drag.p0 - (x - drag.x0)/W; shelfPos = pos;       // the vials stay glued to the finger
    if(!raf) raf = requestAnimationFrame(()=>{ raf = 0; if(drag) paint(); });
    return true;
  };
  const end = t=>{
    const d = drag; drag = null;
    if(!d || !d.lock){ if(caught) glide(Math.round(pos)); return; }
    if(raf){ cancelAnimationFrame(raf); raf = 0; }
    paint();
    const b = d.s[d.s.length-1], a = d.s.find(q=> b.t - q.t <= 100) || b, dtm = b.t - a.t;
    const v = (t - b.t > 80 || dtm < 8) ? 0 : -(b.x - a.x) / dtm / W;                 // vials per ms over the last 0.1 s
    // glide on at the finger's speed to where it would naturally stop, rounded to a vial
    glide(Math.round(pos + Math.max(-12, Math.min(12, v*TAU))));
  };
  row.addEventListener('touchstart', e=>{ if(e.touches.length===1) start(e.touches[0].clientX, e.touches[0].clientY, e.timeStamp); else drag = null; }, {passive:true});
  row.addEventListener('touchmove', e=>{ const q = e.touches[0]; if(q && move(q.clientX, q.clientY, e.timeStamp) && e.cancelable) e.preventDefault(); }, {passive:false});
  row.addEventListener('touchend', e=>{ if(!e.touches.length) end(e.timeStamp); }, {passive:true});
  row.addEventListener('touchcancel', e=> end(e.timeStamp), {passive:true});
  row.addEventListener('pointerdown', e=>{ if(e.pointerType==='touch' || e.button!==0) return; start(e.clientX, e.clientY, e.timeStamp); });
  row.addEventListener('pointermove', e=>{ if(e.pointerType==='touch' || !drag) return; if(move(e.clientX, e.clientY, e.timeStamp)){ try{ row.setPointerCapture(e.pointerId); }catch(_){} } });
  const pEnd = e=>{ if(e.pointerType!=='touch') end(e.timeStamp); };
  row.addEventListener('pointerup', pEnd);
  row.addEventListener('pointercancel', pEnd);
  row.addEventListener('click', e=>{ if(moved){ e.stopPropagation(); e.preventDefault(); moved = false; } }, true);   // a swipe isn't a tap
  // trackpad / mouse wheel
  let wheelT = 0;
  row.addEventListener('wheel', e=>{
    if(Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return;
    e.preventDefault(); stop(); measure(); deselect();
    pos += e.deltaX / W; shelfPos = pos; paint();
    clearTimeout(wheelT); wheelT = setTimeout(()=> glide(Math.round(pos)), 120);
  }, {passive:false});
  // size (a stash drawn while its tab is hidden has none until it's shown)
  new ResizeObserver(()=>{ if(row.clientWidth){ measure(); paint(); } }).observe(row);
  if(row.clientWidth){ measure(); paint(); }
  // the picked vial (tap, scan) spins round to the centre by the shortest way
  const on = row.querySelector('.vial-tile.on');
  if(on){
    const want = +on.dataset.i;
    let best = null;
    for(let i=0;i<T;i++){ if(i % n !== want) continue; const u = wrap(i - pos + T/2, T) - T/2; if(best==null || Math.abs(u) < Math.abs(best)) best = u; }
    if(best!=null && Math.abs(best) > .01) spin(Math.round(pos + best));
  }
}
function renderVials(){
  const el = $('#vialList');
  if(!state.vials.some(v=>!isDepleted(v))){
    el.innerHTML = `<div class="empty"><div class="glyph">🧪</div><p>No vials logged. Add one to see how long your stash will last.</p></div>`;
    return;
  }
  const groups = {};
  const order = [];
  const q = (($('#stashSearch')||{}).value||'').trim().toLowerCase();
  state.vials.filter(v=>!isDepleted(v)).filter(v=> !q || [v.compound, v.pharmacy, v.lot].some(x=> (x||'').toLowerCase().includes(q))).forEach(v=>{
    const key = v.compound || 'Vial';
    if(!groups[key]){ groups[key] = []; order.push(key); }
    groups[key].push(v);
  });
  if(!order.length){ el.innerHTML = `<p class="footnote stash-none">No vials match “${esc(q)}”.</p>`; return; }
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
    const fill = lots.find(v=> v.remainingMg!=null && num(v.mgPerVial,0)>0);
    const pct = fill ? Math.max(0, Math.min(1, fill.remainingMg/num(fill.mgPerVial,1))) : null;
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
      const meta = [isMixedBlend(v) ? v.blend.map(c=> `${esc(c.name)} ${round2(num(c.mg,0))} mg`).join(' + ') : '', v.lot?`Lot ${esc(v.lot)}`:'', v.concentration?`${num(v.concentration)} mg/mL`:''].filter(Boolean).join(' · ');
      const total = qty+(isOpen?1:0);
      const tile = `<button type="button" class="lot-tile ${lotSel===v.id?'on':''}" data-lot="${v.id}" aria-expanded="${lotSel===v.id}" aria-label="${esc(`${v.pharmacy||'No vendor'} ${compound} lot, ${total} vial${total===1?'':'s'}`)}">
        ${vialSVG({color, pct, mgTag: mg?`${mg} mg`:'', name: compound, brand: v.pharmacy||'', lot: v.lot||''}, `l${gi}_${i}`)}${total>1?`<span class="lot-qty">×${total}</span>`:''}</button>`;
      const card = `<div class="lot-card" style="--vc:${color}">
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
        <button type="button" class="link-btn lot-edit" data-open-vial="${v.id}">Edit lot</button>
      </div>`;
      return {id: v.id, tile, card};
    });
    const sealed = lots.reduce((s,v)=> s+num(v.qty,1), 0);   // qty counts sealed vials; the open one is separate
    const meta = fill ? `${Math.round(fill.remainingMg*10)/10} of ${num(fill.mgPerVial,0)} mg${sealed>0?` · +${sealed} sealed`:''}`
      : `${totalQty} sealed${num(lots[0].mgPerVial,0)?` · ${num(lots[0].mgPerVial,0)} mg`:''}`;
    const mgTag = num(lots[0].mgPerVial,0) ? `${num(lots[0].mgPerVial,0)} mg` : '';
    const vendors = [...new Set(lots.map(v=> (v.pharmacy||'').trim()).filter(Boolean))];
    const openNow = lots.some(v=> v.remainingMg!=null);
    const allVials = totalQty + lots.filter(v=> v.remainingMg!=null).length;   // sealed plus open
    return {compound, name: compound, brand: vendors.length===1 ? vendors[0] : '', color, pct, low: totalLow, meta, totalQty, allVials, openNow, anyCalc, totalDays, rows, mgTag};
  });
  if(stashSel && !groups[stashSel]) stashSel = null;
  if(lotSel && !(stashSel && groups[stashSel].some(v=>v.id===lotSel))) lotSel = null;
  // more than three peptides loop endlessly round a ring of at least 8 tiles (copies of the vials when there are few)
  const loop = shelf.length > 3, copies = loop ? Math.ceil(8/shelf.length) : 1, midCopy = 0;
  const tilesHTML = c=> shelf.map((g,i)=>`
    <button type="button" class="vial-tile ${stashSel===g.compound?'on':''} ${g.low?'low':''}" data-vial-group="${esc(g.compound)}" data-i="${i}" aria-expanded="${stashSel===g.compound}" style="--vc:${g.color}"${c!==midCopy ? ' aria-hidden="true" tabindex="-1"' : ''}>
      <span class="vial-art">${g.openNow ? `<i class="vial-open-dot" title="A vial is open"></i>` : ''}${vialSVG({...g, pct:null}, c===midCopy ? i : `${i}c${c}`)}<span class="vial-count">×${g.allVials}</span></span>
      <span class="vial-label">${esc(g.compound)}</span>
      <span class="sr-only">${g.allVials} vial${g.allVials===1?'':'s'}${g.openNow ? ', one open' : ''}</span>
    </button>`).join('');
  el.innerHTML = `<div class="vial-shelf ${stashSel?'has-sel':''} ${loop?'loop':'static'}">${Array.from({length:copies},(_,c)=> tilesHTML(c)).join('')}</div>`;
  const grid = $('.vial-shelf', el);
  if(loop) bindShelf(grid, shelf.length);
  const selIdx = shelf.findIndex(g=> g.compound===stashSel);
  if(selIdx>=0){
    const g = shelf[selIdx];
    // the detail opens under the carousel for the tapped vial
    const rowEnd = grid;
    const det = document.createElement('div');
    det.className = 'vial-detail';
    det.style.setProperty('--vc', g.color);
    const pickedLot = g.rows.find(r=> r.id===lotSel);
    det.innerHTML = `<div class="vial-detail-h"><strong>${esc(g.compound)}</strong>
        <span class="pill pill-muted">${g.allVials} vial${g.allVials===1?'':'s'}</span>
        ${g.anyCalc ? `<span class="pill ${g.low?'pill-warn':'pill-good'}">${g.totalDays<=0?'Out':'~'+g.totalDays+'d left'}</span>` : ''}
        <button type="button" class="link-btn vial-add" data-add-vial="${esc(g.compound)}">+ Add vial</button></div>
      <div class="lot-row ${lotSel?'has-sel':''}">${g.rows.map(r=> r.tile).join('')}</div>
      ${pickedLot ? pickedLot.card : `<p class="footnote lot-hint">Tap a vial to see that lot.</p>`}`;
    rowEnd.after(det);
  }
  $$('[data-vial-group]',el).forEach(b=> b.addEventListener('click', ()=>{
    stashSel = stashSel===b.dataset.vialGroup ? null : b.dataset.vialGroup;
    lotSel = null;
    renderVials();
    const t = $(`.vial-detail`, el); if(t) t.scrollIntoView({behavior:'smooth', block:'nearest'});
  }));
  $$('[data-lot]',el).forEach(b=> b.addEventListener('click', ()=>{
    lotSel = lotSel===b.dataset.lot ? null : b.dataset.lot;
    const x = $('.lot-row', el) ? $('.lot-row', el).scrollLeft : 0;
    renderVials();
    const row = $('.lot-row', el); if(row) row.scrollLeft = x;
    const c = $('.lot-card', el); if(c) c.scrollIntoView({behavior:'smooth', block:'nearest'});
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
let stashSel = null;   // compound whose lots are shown under its vial
let lotSel = null;     // lot whose details card is open under the lot row
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
/* Thumbnail of a certificate: a tiny holographic trading card with a foil shimmer, the purity and a dot per assay. */
function coaMiniSVG(t, labelMg){
  const g = coaGrades(t, labelMg);
  const dot = k=> k==='ok' ? '#1fae5b' : k==='warn' ? '#e09a12' : k==='bad' ? '#e0443a' : '#b9bcc6';
  const big = g.pur!=null ? `${Math.floor(g.pur)}%` : g.mass!=null ? `${Math.round(g.mass)}` : '✓';
  return `<span class="hcm" data-finish="${coaFinish()}" aria-hidden="true"><span class="hcm-band"></span><span class="hcm-k">COA</span><b class="hcm-big">${esc(big)}</b>
    <span class="hcm-dots">${['massG','purG','endoG'].map(k=> `<i style="background:${dot(g[k])}"></i>`).join('')}</span><span class="hcm-bar"></span><span class="hcm-foil"></span></span>`;
}
/* Card finishes, from soft pastel to full rainbow foil. The choice is a per-device look, kept in localStorage. */
const COA_FINISHES = [
  ['aurora','Aurora','Soft pastel foil'], ['prism','Prism','Maximum rainbow'], ['prismsoft','Soft Prism','Gentler light rays'], ['galaxy','Galaxy','Deep space sparkle'],
  ['chrome','Chrome','Polished silver'], ['pearl','Pearl Chrome','Silver with a pastel sheen'], ['gold','Gold','Gold foil'], ['crystal','Crystal','Clear and minimal'],
];
const coaFinish = ()=>{ const f = lsGet('ledger.coaFinish','aurora'); return COA_FINISHES.some(x=> x[0]===f) ? f : 'aurora'; };
function coaFinishPicker(){
  const cur = coaFinish();
  return `<div class="hc-pick" role="radiogroup" aria-label="Card finish">${COA_FINISHES.map(([k,n,d])=> `<button type="button" role="radio" aria-checked="${k===cur}" class="${k===cur?'on':''}" data-finish-pick="${k}"><i class="hc-sw" data-finish="${k}"></i><b>${n}</b><span>${d}</span></button>`).join('')}</div>`;
}
/* A short reference code for a lab test, stable for the same lab, date and lot. */
function coaRef(v, t){
  const lab = t.lab || 'Independent laboratory';
  return `${(lab.replace(/[^A-Za-z]/g,'').slice(0,3)||'LAB').toUpperCase()}-${(t.date||'').replace(/-/g,'').slice(2) || '000000'}-${(v.lot||v.id||'').toString().replace(/[^A-Za-z0-9]/g,'').slice(-4).toUpperCase() || '0000'}`;
}
// Barcode bars drawn from the reference code (decorative, the same code always gives the same bars)
function coaBarcode(code){
  let h = 2166136261, x = 4, bars = '';
  for(let k=0; k<46; k++){
    h ^= code.charCodeAt(k % code.length) + k; h = Math.imul(h, 16777619) >>> 0;
    const w = 1 + (h % 3), gap = 1 + ((h >> 3) % 2);
    if(x + w > 176) break;
    bars += `<rect x="${x}" y="0" width="${w}" height="30"/>`; x += w + gap;
  }
  return `<svg class="hc-bars" viewBox="0 0 180 30" preserveAspectRatio="none" aria-hidden="true">${bars}</svg>`;
}
/* Full certificate as a holographic card, rebuilt from what the user entered for this vial's lab test. */
function coaDocHTML(v, t){
  const labelMg = num(v.mgPerVial,0);
  const g = coaGrades(t, labelMg);
  const fmt = (x,d=2)=> x==null ? '—' : String(Math.round(x*10**d)/10**d);
  const verdict = k=> k==='ok' ? 'Conforms' : k==='warn' ? 'Borderline' : k==='bad' ? 'Out of range' : 'Not tested';
  const lab = t.lab || 'Independent laboratory';
  const ref = coaRef(v, t);
  const coa = safeUrl(t.coaUrl);
  const color = colorFor(v.compound, 0);
  const all = [g.massG, g.purG, g.endoG].filter(Boolean);
  const perfect = all.length >= 2 && all.every(k=> k==='ok');
  const stat = (label, val, sub, k, wide)=> `<div class="hc-stat ${k||''} ${wide?'wide':''}"><span class="hc-k">${label}</span><i></i><strong class="mono">${val}</strong>${sub ? `<small class="mono">${sub}</small>` : ''}<em>${verdict(k)}</em></div>`;
  return `<div class="hc" data-hc data-finish="${coaFinish()}" style="--vc:${color}">
    <div class="hc-card">
      <div class="hc-face">
        <div class="hc-head"><span class="hc-logo"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4.2"/><circle cx="5" cy="8" r="2.6"/><circle cx="19" cy="7" r="2.4"/><circle cx="6" cy="17.5" r="2.8"/><circle cx="18" cy="17" r="3"/></svg></span>
          <span class="hc-brand"><b>Verified COA</b><span>Pep Prep</span></span><span class="hc-ref mono">#${esc(ref)}</span></div>
        <div class="hc-body">
          <span class="hc-k">Peptide</span>
          <div class="hc-name">${esc(v.compound || 'Peptide')}</div>
          <div class="hc-panel">
            <div class="hc-lab"><span class="hc-lab-ic">${esc(lab.slice(0,1).toUpperCase())}</span><div><span class="hc-k">Laboratory</span><strong>${esc(lab)}</strong></div>
              <span class="hc-vial">${vialSVG({color, pct:null, mgTag: labelMg?`${labelMg} mg`:'', name: v.compound||'', brand: v.pharmacy||'', lot: v.lot||''}, 'hc'+Math.random().toString(36).slice(2,7))}</span></div>
            <div class="hc-meta"><div><span class="hc-k">Supplier</span><b>${esc(v.pharmacy||'—')}</b></div><div><span class="hc-k">Lot</span><b class="mono">${esc(v.lot||'—')}</b></div><div><span class="hc-k">Tested</span><b>${t.date?esc(fmtDateShort(t.date)):'—'}</b></div></div>
          </div>
          <span class="hc-k hc-core">Core panel</span>
          <div class="hc-stats">
            ${stat('Purity', g.pur==null?'—':fmt(g.pur)+'%', 'HPLC · spec ≥ 98%', g.purG)}
            ${stat('Content', g.mass==null?'—':fmt(g.mass)+' mg', g.massPct!=null ? `${fmt(g.massPct,1)}% of ${labelMg} mg label` : labelMg ? `label ${labelMg} mg` : 'HPLC', g.massG)}
            ${stat('Endotoxin', g.endo==null?'—':fmt(g.endo,3)+' EU/mg', 'LAL · spec ≤ 1 EU/mg', g.endoG, true)}
          </div>
        </div>
        <div class="hc-foot">${coaBarcode(ref)}<span class="hc-date mono">${t.date?esc(fmtDate(t.date)).toUpperCase():''}</span>
          ${perfect ? `<span class="hc-seal"><b>✦</b><span>ALL<br>CLEAR</span></span>` : ''}</div>
      </div>
      <div class="hc-holo"></div><div class="hc-spark"></div><div class="hc-glare"></div>
    </div>
  </div>
  ${coa ? `<a class="btn btn-sm coa-orig" href="${esc(coa)}" target="_blank" rel="noopener">Open original report ↗</a>` : ''}`;
}
/* Makes holographic cards move: a slow idle sway, tilting toward your finger, and following the phone's tilt once
   motion access is allowed (asked on the first tap). The foil, sparkle and glare follow the same angle. */
function holoCards(root){
  const cards = $$('[data-hc]', root); if(!cards.length) return;
  const still = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
  const st = cards.map(el=> ({el, card: $('.hc-card', el), x:0, y:0, tx:0, ty:0, touchAt:0}));
  let gyro = null, base = null, raf = 0, t0 = performance.now();
  const set = (s, px, py)=>{ s.tx = Math.max(-1, Math.min(1, px)); s.ty = Math.max(-1, Math.min(1, py)); s.touchAt = performance.now(); };
  st.forEach(s=>{
    const from = e=>{ const r = s.card.getBoundingClientRect(); set(s, ((e.clientX - r.left)/r.width)*2-1, ((e.clientY - r.top)/r.height)*2-1); };
    s.card.addEventListener('pointermove', from, {passive:true});
    s.card.addEventListener('pointerdown', e=>{ from(e); askMotion(); }, {passive:true});
  });
  const onTilt = e=>{
    if(e.beta==null || e.gamma==null) return;
    if(!base) base = {b: e.beta, g: e.gamma};
    gyro = {x: (e.gamma - base.g)/22, y: (e.beta - base.b)/22};
  };
  function askMotion(){
    if(askMotion.done) return; askMotion.done = true;
    const D = window.DeviceOrientationEvent;
    if(D && typeof D.requestPermission === 'function') D.requestPermission().then(r=>{ if(r==='granted') window.addEventListener('deviceorientation', onTilt); }).catch(()=>{});
    else if(D) window.addEventListener('deviceorientation', onTilt);
  }
  const frame = now=>{
    if(!root.isConnected){ window.removeEventListener('deviceorientation', onTilt); return; }
    const t = (now - t0)/1000;
    st.forEach((s, k)=>{
      const idle = now - s.touchAt > 1400;
      let tx = s.tx, ty = s.ty;
      if(idle){
        if(gyro){ tx = Math.max(-1, Math.min(1, gyro.x)); ty = Math.max(-1, Math.min(1, gyro.y)); }
        else if(!still){ tx = Math.sin(t*0.8 + k)*0.55; ty = Math.sin(t*0.55 + k + 1)*0.35; }
        else { tx = 0; ty = 0; }
      }
      s.x += (tx - s.x)*0.12; s.y += (ty - s.y)*0.12;
      const c = s.card.style;
      c.transform = `rotateY(${(s.x*13).toFixed(2)}deg) rotateX(${(-s.y*11).toFixed(2)}deg)`;
      c.setProperty('--mx', `${(50 + s.x*42).toFixed(1)}%`); c.setProperty('--my', `${(50 + s.y*42).toFixed(1)}%`);
      c.setProperty('--fx', `${(50 + s.x*30).toFixed(1)}%`); c.setProperty('--fy', `${(50 + s.y*30).toFixed(1)}%`);
      c.setProperty('--hi', Math.min(1, .35 + Math.hypot(s.x, s.y)*.8).toFixed(3));
    });
    raf = requestAnimationFrame(frame);
  };
  raf = requestAnimationFrame(frame);
}
/* Certificates for a vial; several are laid side by side and swiped between, starting at index i. */
function openCoaModal(v, i){
  const tests = vialTests(v); if(!tests[i]) return;
  const many = tests.length > 1;
  openModal(many ? `Certificates of analysis` : 'Certificate of analysis', `
    ${many ? `<div class="coa-pager"><button type="button" class="coa-nav" id="coaPrev" aria-label="Previous certificate">‹</button><span id="coaCount" class="mono">1 / ${tests.length}</span><button type="button" class="coa-nav" id="coaNext" aria-label="Next certificate">›</button></div>` : ''}
    ${coaFinishPicker()}
    <div class="coa-track coa-viewer ${many?'many':''}" id="coaTrack">${tests.map(t=>`<div class="coa-slide">${coaDocHTML(v, t)}</div>`).join('')}</div>
    ${many ? `<div class="coa-dots" id="coaDots">${tests.map((_,k)=>`<i data-k="${k}"></i>`).join('')}</div>` : ''}
    <p class="footnote" style="margin-top:10px;">Rebuilt from the values you entered for this vial. Tilt your phone or drag across the card to catch the foil. Grades: content 90–110% of label, purity ≥ 98%, endotoxin ≤ 1 EU/mg.</p>
    <div class="form-actions"><button type="button" class="btn btn-accent-pep" id="coaEdit">Edit vial</button></div>
  `, body=>{
    $('#coaEdit',body).addEventListener('click', ()=>{ closeModal(); openVialModal(v); });
    holoCards(body);
    const pick = $('.hc-pick', body);
    if(pick) pick.addEventListener('click', e=>{
      const b = e.target.closest('[data-finish-pick]'); if(!b) return;
      const k = b.dataset.finishPick; lsSet('ledger.coaFinish', k); haptic('select');
      $$('[data-finish-pick]', pick).forEach(x=>{ x.classList.toggle('on', x===b); x.setAttribute('aria-checked', x===b); });
      $$('.hc', body).forEach(c=> c.dataset.finish = k);
      $$('.hcm').forEach(c=> c.dataset.finish = k);
    });
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
  // a home-mixed blend is replaced by mixing another batch from sealed vials, not by opening one
  if(isMixedBlend(cur)) return openBlendMixModal({p, finishing: cur.remainingMg!=null ? cur : null, recipe: cur.blend, bacMl: cur.bacMl});
  if(p && blendOf(p) && !cur && !preselect && !nextVialCandidates(p.compound, null).length) return openBlendMixModal({p, recipe: blendOf(p)});
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
/* ===== Mix a blend: combine sealed vials from the stash into one home-mixed vial =====
   The blend is stored as an ordinary open vial (compound = blend name, mgPerVial = total) with
   blend: [{name, mg, count, vialId}] recording what went in. Each source lot loses the sealed vials used
   (logged in its finishedLog with mixedInto) so counts and cost history stay right. A protocol linked to the
   blend draws each dose from it; finishing it offers to mix the next batch with the same recipe. */
function isMixedBlend(v){ return !!(v && Array.isArray(v.blend) && v.blend.length); }
function mixSources(){ return state.vials.filter(v=> !isDepleted(v) && !isMixedBlend(v) && num(v.qty,0)>=1); }
function canMixBlend(){ return new Set(mixSources().map(v=> (v.compound||'').trim().toLowerCase())).size >= 2; }
function openBlendMixModal({p=null, finishing=null, recipe=null, bacMl=null}={}){
  const BUD_MAX = '9999-12-31';
  const lotsOf = name=> mixSources().filter(v=> (v.compound||'').trim().toLowerCase()===(name||'').trim().toLowerCase())
    .sort((a,b)=> (a.bud||BUD_MAX).localeCompare(b.bud||BUD_MAX));
  // starting rows: the previous recipe, else the protocol's blend, else the two peptides you have most sealed vials of
  let rows = [];
  (recipe || []).forEach(c=>{
    const lots = lotsOf(c.name); const same = lots.find(v=> v.id===c.vialId);
    rows.push({vialId: (same || lots[0] || {}).id || '', count: Math.max(1, num(c.count,1)), name: c.name});
  });
  if(!rows.length){
    const tally = {};
    mixSources().forEach(v=>{ const k = (v.compound||'').trim(); tally[k] = (tally[k]||0) + num(v.qty,0); });
    Object.entries(tally).sort((a,b)=> b[1]-a[1]).slice(0,2).forEach(([k])=> rows.push({vialId: lotsOf(k)[0].id, count:1, name:k}));
  }
  const bacDefault = num(bacMl,0) || (p && num(p.bacMl,0)) || 3;
  const protos = state.protocols.filter(isActiveP);
  const pick = ()=> rows.map(r0=>({...r0, v: state.vials.find(v=> v.id===r0.vialId)})).filter(r0=> r0.v);
  const autoName = ()=> [...new Set(pick().map(r0=> (r0.v.compound||'').trim()))].join(' + ');
  const left = finishing ? round2(num(finishing.remainingMg,0)) : 0;
  openModal(finishing ? 'Finish & mix next batch' : 'Mix a blend', `
    ${finishing ? `<div class="swap-sec"><h4>Finishing</h4><p class="footnote">${esc(finishing.compound||'Blend')}${finishing.dateOpened?` · mixed ${esc(fmtDateShort(finishing.dateOpened))}`:''} · ${left>0.05 ? `${left} mg left, counted as discarded` : 'empty'}</p></div>` : ''}
    <div class="swap-sec"><h4>What goes in</h4>
      <div id="mixRows"></div>
      <button type="button" class="btn btn-sm" id="mixAdd" style="margin-top:8px;">+ Add peptide</button>
    </div>
    <div class="swap-sec"><h4>Reconstitute</h4>
      <div class="form-grid">
        <div class="field"><label for="mixBac">BAC water (mL)</label><input id="mixBac" type="number" inputmode="decimal" step="any" min="0" value="${esc(String(bacDefault))}"></div>
        <div class="field"><label for="mixDate">Date mixed</label><input id="mixDate" type="date" value="${todayISO()}" max="${todayISO()}"></div>
        <div class="field span2"><label for="mixName">Name</label><input id="mixName" type="text" value="${esc(p ? p.compound||'' : '')}" placeholder="e.g. KPV + GHK-Cu"></div>
      </div>
      <div class="mix-out" id="mixOut"></div>
    </div>
    <div class="swap-sec"><h4>Protocol</h4>
      ${p ? `<p class="footnote">This becomes the active vial for <strong>${esc(p.compound||'this protocol')}</strong>.</p>` : `
      <select id="mixLink">
        <option value="__new">Create a daily protocol for it</option>
        ${protos.map(x=>`<option value="${x.id}">Use for ${esc(x.compound||'protocol')}</option>`).join('')}
        <option value="">Don't link a protocol</option>
      </select>`}
    </div>
    <div class="form-actions"><button type="button" class="btn" id="mixCancel">Cancel</button><button type="button" class="btn btn-accent-pep" id="mixGo">Mix</button></div>
    <div class="footnote" id="mixErr" style="margin-top:6px;"></div>
  `, body=>{
    const nameIn = $('#mixName',body);
    let nameTyped = !!nameIn.value;
    const draw = ()=>{
      const src = mixSources();
      $('#mixRows',body).innerHTML = rows.map((r0,i)=>{
        const v = state.vials.find(x=> x.id===r0.vialId);
        const max = v ? num(v.qty,0) : 1;
        return `<div class="mix-row" data-i="${i}">
          <select data-mix-lot aria-label="Peptide ${i+1}">${r0.vialId ? '' : '<option value="">Choose a peptide…</option>'}${src.map(x=>`<option value="${x.id}" ${x.id===r0.vialId?'selected':''}>${esc(x.compound||'Vial')} · ${num(x.mgPerVial,0)} mg${x.pharmacy?` · ${esc(x.pharmacy)}`:''} (${num(x.qty,0)} sealed)</option>`).join('')}</select>
          <div class="mix-qty"><button type="button" data-mix-step="-1" aria-label="Fewer" ${r0.count<=1?'disabled':''}>−</button><span>${r0.count}</span><button type="button" data-mix-step="1" aria-label="More" ${r0.count>=max?'disabled':''}>+</button></div>
          <button type="button" class="icon-btn" data-mix-rm aria-label="Remove" ${rows.length<=1?'disabled':''}>✕</button>
        </div>`;
      }).join('');
      $('#mixAdd',body).disabled = rows.length >= src.length;
      out();
    };
    const out = ()=>{
      const list = pick(), bac = num($('#mixBac',body).value,0);
      if(!nameTyped) nameIn.value = autoName();
      const total = list.reduce((t,r0)=> t + num(r0.v.mgPerVial,0)*r0.count, 0);
      $('#mixOut',body).innerHTML = list.length ? `${list.map(r0=>{ const mg = num(r0.v.mgPerVial,0)*r0.count; return `<div><span>${esc(r0.v.compound)}</span><strong class="mono">${round2(mg)} mg${bac?` · ${round2(mg/bac)} mg/mL`:''}</strong></div>`; }).join('')}
        <div class="mix-tot"><span>Total</span><strong class="mono">${round2(total)} mg${bac?` · ${round2(total/bac)} mg/mL`:''}</strong></div>` : '';
      const ids = list.map(r0=> r0.vialId);
      $('#mixGo',body).disabled = list.length < 2 || new Set(ids).size !== ids.length || !bac;
      $('#mixErr',body).textContent = new Set(ids).size !== ids.length ? 'Each lot can only be listed once; use + to add more of it.' : list.length < 2 ? 'Pick at least two peptides.' : '';
    };
    $('#mixRows',body).addEventListener('change', e=>{
      const sel = e.target.closest('[data-mix-lot]'); if(!sel) return;
      const r0 = rows[+sel.closest('[data-i]').dataset.i]; r0.vialId = sel.value; r0.count = 1; draw();
    });
    $('#mixRows',body).addEventListener('click', e=>{
      const row = e.target.closest('[data-i]'); if(!row) return;
      const r0 = rows[+row.dataset.i];
      const st = e.target.closest('[data-mix-step]');
      if(st){ const v = state.vials.find(x=> x.id===r0.vialId); r0.count = Math.max(1, Math.min(v ? num(v.qty,0) : 1, r0.count + +st.dataset.mixStep)); return draw(); }
      if(e.target.closest('[data-mix-rm]')){ rows.splice(+row.dataset.i, 1); draw(); }
    });
    $('#mixAdd',body).addEventListener('click', ()=>{
      const used = new Set(rows.map(r0=> r0.vialId));
      const next = mixSources().find(v=> !used.has(v.id));
      rows.push({vialId: next ? next.id : '', count:1}); draw();
    });
    nameIn.addEventListener('input', ()=>{ nameTyped = nameIn.value.trim()!==''; });
    $('#mixBac',body).addEventListener('input', out);
    $('#mixCancel',body).addEventListener('click', closeModal);
    $('#mixGo',body).addEventListener('click', async ()=>{
      const list = pick(); if(list.length < 2) return;
      $('#mixGo',body).disabled = true;
      const date = $('#mixDate',body).value || todayISO();
      const bac = num($('#mixBac',body).value, 0);
      const name = nameIn.value.trim() || autoName();
      const recipeOut = list.map(r0=>({name: (r0.v.compound||'').trim(), mg: round2(num(r0.v.mgPerVial,0)*r0.count), count: r0.count, vialId: r0.v.id}));
      const total = round2(recipeOut.reduce((t,c)=> t + c.mg, 0));
      if(finishing){
        const fresh = state.vials.find(v=> v.id===finishing.id) || finishing;
        const log = (Array.isArray(fresh.finishedLog) ? fresh.finishedLog : []).concat({opened: fresh.dateOpened||'', finished: date, leftoverMg: round2(num(fresh.remainingMg,0))});
        await dbSet('vials', fresh.id, {...stripId(fresh), remainingMg:null, dateOpened:'', finishedLog:log, ...(num(fresh.qty,0)<=0 ? {depleted:true} : {})});
      }
      const budDays = num((typeof C!=='undefined' && C && C.budDays), 0);
      const newId = await dbAdd('vials', {compound: name, mgPerVial: String(total), qty: 0, remainingMg: total, dateOpened: date,
        bacMl: String(bac), concentration: String(round2(total/bac)), pharmacy: 'Home mix', blend: recipeOut,
        bud: budDays>0 ? addDays(date, budDays) : '', protocolId: p ? p.id : null});
      for(const c of recipeOut){
        const v = state.vials.find(x=> x.id===c.vialId); if(!v) continue;
        const qty = Math.max(0, num(v.qty,0) - c.count);
        const fl = (Array.isArray(v.finishedLog) ? v.finishedLog : []).concat(Array.from({length:c.count}, ()=>({opened: date, finished: date, leftoverMg: 0, mixedInto: newId})));
        await dbSet('vials', v.id, {...stripId(v), qty, finishedLog: fl, ...(qty<=0 && v.remainingMg==null ? {depleted:true} : {})});
      }
      // keep any half-lives the protocol already had for these peptides
      const withHl = old=> recipeOut.map(c=>{ const o = (old||[]).find(x=> (x.name||'').trim().toLowerCase()===c.name.toLowerCase()); return {name:c.name, mg:String(c.mg), halfLifeHours: o ? o.halfLifeHours||'' : ''}; });
      const link = p ? p.id : ($('#mixLink',body) ? $('#mixLink',body).value : '');
      closeModal();
      haptic('success'); showToast(`Mixed ${name}`);
      if(link==='__new'){
        setTimeout(()=> openProtocolModal(null, {compound: name, dose:'', doseUnit:'mcg', frequencyDays:'1', blend: withHl(null),
          activeVialId: newId, vialMg: String(total), bacMl: String(bac), startDate: todayISO(), nextDose: todayISO(), status:'active'}), 260);
      } else if(link){
        const fp = state.protocols.find(x=> x.id===link);
        if(fp) await dbSet('protocols', fp.id, {...stripId(fp), activeVialId: newId, vialMg: String(total), bacMl: String(bac), blend: withHl(blendOf(fp))});
      }
    });
    draw();
  });
}
function protocolForVial(v){
  const linked = state.protocols.find(p=> p.status!=='archived' && p.activeVialId===v.id);
  if(linked) return linked;
  const c = (v.compound||'').trim().toLowerCase();
  return state.protocols.find(p=> isActiveP(p) && (p.compound||'').trim().toLowerCase()===c) || null;
}
function openVialModal(existing, prefill){
  const v = existing || prefill || {};
  const protocolOptions = state.protocols.map(p=>`<option value="${p.id}" ${v.protocolId===p.id?'selected':''}>${esc(p.compound)}</option>`).join('');
  openModal(existing?'Edit vial':'Add vial', `
    <div class="form-grid">
      <div class="field span2"><label for="vCompound">Compound</label><input id="vCompound" type="text" value="${esc(v.compound||'')}"></div>
      <div class="field"><label for="vMg">mg per vial</label><input id="vMg" type="number" step="any" value="${esc(v.mgPerVial||'')}"></div>
      <div class="field"><label for="vQty">${v.remainingMg!=null ? 'Sealed vials <span style="font-weight:400;color:var(--muted);">(not counting the open one)</span>' : 'Qty (identical vials)'}</label><input id="vQty" type="number" step="1" min="0" value="${esc(String(v.qty ?? 1))}"></div>
      <div class="field"><label for="vConc">Concentration (mg/mL)</label><input id="vConc" type="number" step="any" value="${esc(v.concentration||'')}" placeholder="After reconstitution"></div>
      <div class="field"><label for="vPrice">Price paid ($, for this whole entry)</label><input id="vPrice" type="number" step="any" value="${esc(v.price||'')}" placeholder="e.g. 65"></div>
      <div class="field"><label for="vLot">Lot #</label><input id="vLot" type="text" value="${esc(v.lot||'')}"></div>
      ${(v.barcode || capPlugin('CapacitorBarcodeScanner')) ? `<div class="field"><label for="vBarcode">Barcode / QR</label><div class="scan-row"><input id="vBarcode" type="text" value="${esc(v.barcode||'')}">${capPlugin('CapacitorBarcodeScanner') ? `<button type="button" class="btn btn-sm" id="vScan">Scan</button>` : ''}</div></div>` : ''}
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
    const scanB = $('#vScan',body); if(scanB) scanB.addEventListener('click', async ()=>{ const c = await scanCode(); if(c) $('#vBarcode',body).value = c; });
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
      const data = {...stripId(v), compound, mgPerVial:$('#vMg',body).value, qty:($('#vQty',body).value==='' ? (v.remainingMg!=null ? 0 : 1) : $('#vQty',body).value), concentration:$('#vConc',body).value, price:$('#vPrice',body).value, lot:$('#vLot',body).value.trim(), barcode: $('#vBarcode',body) ? $('#vBarcode',body).value.trim() : (v.barcode||''), pharmacy:vendor,
        ...(()=>{ const ts = tests.map(t=>({...t, lab:(t.lab||'').trim(), coaUrl:(t.coaUrl||'').trim()})).filter(testFilled); const f = ts[0] || {};
          return {testLab:f.lab||'', testMassMg:f.massMg||'', testPurity:f.purity||'', testEndo:f.endo||'', testDate:f.date||'', coaUrl:f.coaUrl||'', extraTests: ts.slice(1)}; })(),
        dateOpened:$('#vOpened',body).value, bud:$('#vBud',body).value, protocolId:$('#vProtocol',body).value||null};
      if(existing) await dbSet('vials', existing.id, data); else await dbAdd('vials', data);
      closeModal();
    });
  });
}
$('#addVialBtn').addEventListener('click', ()=>{
  if(!canMixBlend()) return openVialModal(null);
  openModal('Add to your stash', `
    <div class="ios-list add-choice">
      <button type="button" class="ios-row" id="acVial"><span class="ac-ic">🧪</span><span class="ac-t"><strong>Add vials</strong><span>Log vials you bought</span></span></button>
      <button type="button" class="ios-row" id="acMix"><span class="ac-ic">⚗️</span><span class="ac-t"><strong>Mix a blend</strong><span>Combine sealed vials into one, e.g. KPV + GHK-Cu</span></span></button>
    </div>`, body=>{
    $('#acVial',body).addEventListener('click', ()=>{ closeModal(); setTimeout(()=> openVialModal(null), 240); });
    $('#acMix',body).addEventListener('click', ()=>{ closeModal(); setTimeout(()=> openBlendMixModal(), 240); });
  });
});

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
  const comp = Object.entries(byCompound).sort((a,b)=> b[1]-a[1]);
  const maxC = comp.length ? comp[0][1] : 1;
  const colorMap = new Map(comp.map(([k],i)=> [k, colorFor(k, i)]));
  const vend = Object.entries(byVendor).sort((a,b)=> b[1]-a[1]);
  el.innerHTML = `
    <div class="cost-hero">
      <div><span class="cost-k">Per month</span><strong class="cost-big">${monthly>0 ? '$'+Math.round(monthly).toLocaleString() : '—'}</strong><span class="cost-sub">${monthly>0 ? 'estimated, from your active protocols' : 'add prices to vials your protocols use'}</span></div>
      <div class="cost-side"><span class="cost-k">Total spent</span><strong>$${Math.round(total).toLocaleString()}</strong></div>
    </div>
    <div class="cost-bars">${comp.map(([k,v])=>`<div class="cost-bar"><span class="cost-bar-n">${esc(k)}</span><span class="cost-bar-t"><i style="width:${Math.max(4, v/maxC*100).toFixed(1)}%;background:${colorMap.get(k)}"></i></span><strong class="mono">$${Math.round(v).toLocaleString()}</strong></div>`).join('')}</div>
    ${vend.length>1 ? `<details class="cost-more"><summary>By vendor</summary>${rows(byVendor)}</details>` : ''}`;
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
// the areas on the map, used for rotation and the site list (older names such as upper abdomen or glutes stay valid in history)
const SITE_NAMES = ['Abdomen lower – R', 'Abdomen lower – L', 'Thigh – R', 'Thigh – L'];
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
/* ===== Injection site map =====
   A front view of the torso and legs (cropped at the chest, like an injection-site chart) with curved grids over the
   abdomen and the front of each thigh. Every grid square is a spot you can tap; it is saved as {site: area name (used
   for rotation), spot: square id}. Past injections show as red dots that fade over three weeks; the area to use next is
   tinted blue. Entries from before spots existed sit at the middle of their area. */
const BM_SKIN = '#f9e3c6', BM_LINE = '#3d3542';
const BM_OUTLINE = 'M126 0 C127 8 121 15 106 21 C88 27 66 30 56 40 C48 48 47 62 50 76 C52 86 56 94 62 100 C64 126 66 154 68 180 C69 196 71 208 71 220 C71 236 66 252 63 266 C60 282 58 302 59 324 C61 356 67 394 75 434 L134 434 C136 402 141 362 145 334 C146 326 147 321 150 319 C153 321 154 326 155 334 C159 362 164 402 166 434 L225 434 C233 394 239 356 241 324 C242 302 240 282 237 266 C234 252 229 236 229 220 C229 208 231 196 232 180 C234 154 236 126 238 100 C244 94 248 86 250 76 C253 62 252 48 244 40 C234 30 212 27 194 21 C179 15 173 8 174 0 Z';
function bmLerp(a, b, t){ return a + (b-a)*t; }
// A grid over a four-cornered patch (corners clockwise from top-left), optionally bowed: point(u,v) for u,v in 0..1.
function bmPatch(tl, tr, br, bl, bowTop=0, bowBot=0){
  return (u, v)=>{
    const x = bmLerp(bmLerp(tl[0], tr[0], u), bmLerp(bl[0], br[0], u), v);
    const yTop = bmLerp(tl[1], tr[1], u) - bowTop*Math.sin(Math.PI*u), yBot = bmLerp(bl[1], br[1], u) + bowBot*Math.sin(Math.PI*u);
    return [x, bmLerp(yTop, yBot, v)];
  };
}
/* Areas: name, the patch, grid size, and which squares belong (one abdomen grid is split into right and left). */
const BM_AREAS = (()=>{
  // abdomen from belly-button height down, reaching out toward the hips; squares touching the navel are left out
  const abd = bmPatch([70,208],[230,208],[226,252],[74,252], 0, 20);
  const out = [];
  const add = (name, pt, cols, rows, keep)=> out.push({name, pt, cols, rows, keep: keep || (()=>true)});
  const nearNavel = (c,r)=> (c===5||c===6) && r===0;
  add('Abdomen lower – R', abd, 12, 4, (c,r)=> c<6 && !nearNavel(c,r));
  add('Abdomen lower – L', abd, 12, 4, (c,r)=> c>=6 && !nearNavel(c,r));
  add('Thigh – R', bmPatch([66,284],[104,290],[128,426],[82,428]), 3, 7);
  add('Thigh – L', bmPatch([196,290],[234,284],[218,428],[172,426]), 3, 7);
  return out;
})();
// Every tappable square: {id, area, pts:[[x,y]x4], cx, cy}
const BM_CELLS = (()=>{
  const cells = [];
  BM_AREAS.forEach((a, ai)=>{
    for(let r=0; r<a.rows; r++) for(let c=0; c<a.cols; c++){
      if(!a.keep(c, r)) continue;
      const pts = [a.pt(c/a.cols, r/a.rows), a.pt((c+1)/a.cols, r/a.rows), a.pt((c+1)/a.cols, (r+1)/a.rows), a.pt(c/a.cols, (r+1)/a.rows)];
      const [cx, cy] = a.pt((c+.5)/a.cols, (r+.5)/a.rows);
      cells.push({id: `f${ai}:${c}:${r}`, area: a.name, pts, cx, cy});
    }
  });
  return cells;
})();
function bmAreaCentre(name){
  const cs = BM_CELLS.filter(c=> c.area===name); if(!cs.length) return null;
  return [cs.reduce((t,c)=> t+c.cx, 0)/cs.length, cs.reduce((t,c)=> t+c.cy, 0)/cs.length];
}
function bodyMapSVG(p, selected, spot){
  const log = siteLogOf(p), today = todayISO();
  const next = suggestNextSite(p);
  const poly = pts=> pts.map(([x,y])=> `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const grid = BM_CELLS.map(c=> `<polygon points="${poly(c.pts)}" class="bm-cell${c.area===next ? ' next' : ''}${c.id===spot ? ' sel' : ''}" data-site="${esc(c.area)}" data-spot="${c.id}"><title>${esc(c.area)}</title></polygon>`).join('');
  // history dots, newest on top, fading over three weeks
  const dots = log.slice().sort((a,b)=> (a.date||'').localeCompare(b.date||'')).map(e=>{
    const cell = e.spot ? BM_CELLS.find(c=> c.id===e.spot) : null;
    const at = cell ? [cell.cx, cell.cy] : bmAreaCentre(e.site); if(!at) return '';
    const age = Math.max(0, daysBetween(e.date, today)); if(age > 42) return '';
    const op = Math.max(.18, 1 - age/21*0.82);
    return `<circle cx="${at[0].toFixed(1)}" cy="${at[1].toFixed(1)}" r="5.4" class="bm-dot" style="opacity:${op.toFixed(2)}"><title>${esc(e.site)} · ${esc(fmtDateShort(e.date))}</title></circle>`;
  }).join('');
  const sel = spot ? BM_CELLS.find(c=> c.id===spot) : null;
  const selMark = sel ? `<circle cx="${sel.cx.toFixed(1)}" cy="${sel.cy.toFixed(1)}" r="7.2" class="bm-pick"/>` : '';
  const L = BM_LINE;
  return `<svg viewBox="0 84 300 352" role="img" aria-label="Injection site map. Tap a square to choose where you injected.">
    <defs>
      <linearGradient id="bmSkinG" x1="0" x2="1"><stop offset="0" stop-color="#ecc9a3"/><stop offset=".22" stop-color="#f7dcbd"/><stop offset=".5" stop-color="${BM_SKIN}"/><stop offset=".78" stop-color="#f7dcbd"/><stop offset="1" stop-color="#ecc9a3"/></linearGradient>
      <linearGradient id="bmFadeG" x1="0" x2="0" y1="84" y2="150" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#fff" stop-opacity="0"/><stop offset="1" stop-color="#fff"/></linearGradient>
      <mask id="bmFadeM" maskUnits="userSpaceOnUse" x="0" y="0" width="300" height="440"><rect width="300" height="440" fill="url(#bmFadeG)"/></mask>
    </defs>
    <g mask="url(#bmFadeM)">
      <path d="${BM_OUTLINE}" fill="url(#bmSkinG)" stroke="${L}" stroke-width="1.8" stroke-linejoin="round"/>
      <path d="M82 120 C90 138 104 148 124 150 M218 120 C210 138 196 148 176 150" fill="none" stroke="${L}" stroke-width="1.5" stroke-linecap="round"/>
    </g>
    <ellipse cx="150" cy="214" rx="7" ry="4" fill="none" stroke="${L}" stroke-width="1.3"/><circle cx="150" cy="214" r="2" fill="none" stroke="${L}" stroke-width="1"/>
    <path d="M138 312 Q150 322 162 312" fill="none" stroke="${L}" stroke-width="1.4" stroke-linecap="round"/>
    <g class="bm-grid">${grid}</g>
    <g pointer-events="none">${dots}${selMark}</g>
    <text x="24" y="104" class="bm-side">R</text><text x="276" y="104" class="bm-side">L</text>
  </svg>
  <div class="bm-legend"><span><i class="k-dot"></i>Recent</span><span><i class="k-old"></i>Older</span><span><i class="k-next"></i>Suggested next</span><span><i class="k-sel"></i>This dose</span></div>`;
}
/* Wire a map into a container. st = {site, spot}; onChange runs after a square is picked or cleared. */
function bindBodyMap(el, p, st, onChange){
  const draw = ()=>{ el.innerHTML = bodyMapSVG(p, st.site, st.spot); };
  el.addEventListener('click', e=>{
    const z = e.target.closest('[data-spot]'); if(!z) return;
    if(st.spot===z.dataset.spot){ st.site = ''; st.spot = ''; } else { st.site = z.dataset.site; st.spot = z.dataset.spot; }
    haptic('select'); draw(); onChange && onChange();
  });
  draw();
  return draw;
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
/* Past Claude conversations: grouped by when they were last used, a two-line preview, keyword search across
   every message, and swipe left on a row to delete it (iOS style). */
let researchQuery = '';
function chatTitle(r){
  let t = String(r.topic||'').trim();
  if(!t && Array.isArray(r.messages)){ const u = r.messages.find(m=> m.role==='user'); if(u) t = chatText(u).trim(); }
  if(!t) return 'Untitled chat';
  t = t.split(/\n/)[0].replace(/\s+/g,' ');
  const q = t.search(/[?.!](\s|$)/); if(q > 12) t = t.slice(0, q+1);
  if(t.length > 56){ t = t.slice(0, 55).replace(/\s+\S*$/, '') + '…'; }
  return t.charAt(0).toUpperCase() + t.slice(1);
}
function chatPlain(r){
  if(Array.isArray(r.messages)) return r.messages.map(m=> chatText(m)).join('\n');
  return [r.topic, r.answer, r.notes].filter(Boolean).join('\n');
}
function chatPreview(r){
  if(Array.isArray(r.messages)){ const a = r.messages.filter(m=> m.role==='assistant').pop(); if(a) return chatText(a); }
  return r.answer || r.notes || '';
}
const mdStrip = t=> String(t||'').replace(/```[\s\S]*?```/g,' ').replace(/[#*_>`|]+/g,' ').replace(/\[([^\]]+)\]\([^)]+\)/g,'$1').replace(/\s+/g,' ').trim();
function renderResearch(){
  const el = $('#researchList'); if(!el) return;
  const searchEl = $('#researchSearch');
  if(searchEl) searchEl.closest('.cv-search').hidden = state.research.length < 2 && !researchQuery;
  if(!state.research.length){
    el.innerHTML = `<div class="empty"><div class="glyph">💬</div><p>Your conversations with Claude will be saved here.</p></div>`;
    return;
  }
  const when = r=> new Date(r.updatedAt || ((r.createdAt||todayISO()) + 'T12:00:00')).getTime();
  const q = researchQuery.trim().toLowerCase();
  let list = state.research.slice().sort((a,b)=> when(b) - when(a));
  if(q) list = list.filter(r=> (chatTitle(r) + '\n' + chatPlain(r)).toLowerCase().includes(q));
  if(!list.length){ el.innerHTML = `<p class="footnote cv-none">No chats mention “${esc(researchQuery.trim())}”.</p>`; return; }
  const now = new Date(), startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime(), DAY = 86400000;
  const groupOf = t=> t >= startToday ? 'Today' : t >= startToday - DAY ? 'Yesterday' : t >= startToday - 7*DAY ? 'Previous 7 days' : t >= startToday - 30*DAY ? 'Previous 30 days'
    : new Date(t).toLocaleDateString(undefined, {month:'long', year:'numeric'});
  const stamp = t=> t >= startToday ? new Date(t).toLocaleTimeString(undefined,{hour:'numeric', minute:'2-digit'}) : t >= startToday - 7*DAY ? new Date(t).toLocaleDateString(undefined,{weekday:'short'}) : new Date(t).toLocaleDateString(undefined,{month:'short', day:'numeric'});
  const mark = (txt)=>{
    const e = esc(txt); if(!q) return e;
    const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g,'\\$&').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'), 'gi');
    return e.replace(re, m=> `<mark>${m}</mark>`);
  };
  let html = '', last = null;
  list.forEach(r=>{
    const t = when(r), g = groupOf(t);
    if(g!==last){ html += `${last ? '</div>' : ''}<div class="cv-group-h">${esc(g)}</div><div class="cv-group">`; last = g; }
    const isChat = Array.isArray(r.messages);
    let prev = mdStrip(chatPreview(r));
    if(q){ const all = mdStrip(chatPlain(r)), i = all.toLowerCase().indexOf(q); if(i>=0) prev = (i>40 ? '…' : '') + all.slice(Math.max(0, i-40), i+120); }
    const turns = isChat ? r.messages.filter(m=>m.role==='user').length : 0;
    html += `<div class="cv-row" data-row="${r.id}">
      <button type="button" class="cv-del" data-del-research="${r.id}">Delete</button>
      <div class="cv-main" data-open-chat="${r.id}" role="button" tabindex="0">
        <div class="cv-top"><strong>${mark(chatTitle(r))}</strong><span class="cv-when">${esc(stamp(t))}</span></div>
        <div class="cv-prev">${mark(prev.slice(0,180)) || '<em>No answer yet</em>'}</div>
        <div class="cv-meta">${isChat ? `${turns} question${turns===1?'':'s'}${r.costUsd ? ` · ≈ $${r.costUsd.toFixed(2)}` : ''}` : 'Pasted answer'}</div>
      </div>
    </div>`;
  });
  el.innerHTML = html + '</div>';
  $$('[data-del-research]',el).forEach(b=> b.addEventListener('click', e=>{ e.stopPropagation(); confirmAction('Delete this conversation?', ()=>{ if(askConv && askConv.id===b.dataset.delResearch) askConv = null; return dbDelete('research', b.dataset.delResearch); }); }));
  const open = id=>{
    const r = state.research.find(x=>x.id===id); if(!r) return;
    if(Array.isArray(r.messages)){ askConv = JSON.parse(JSON.stringify(r)); renderAsk(); window.scrollTo({top:0, behavior:'smooth'}); }
    else openModal(chatTitle(r), `<div class="research-md">${mdToHtml(r.answer||r.notes||'')}</div>`);
  };
  // swipe a row left to reveal Delete; tapping a revealed row closes it again
  let openRow = null;
  const shut = ()=>{ if(openRow){ openRow.querySelector('.cv-main').style.transform = ''; openRow.classList.remove('open'); openRow = null; } };
  $$('.cv-row',el).forEach(row=>{
    const main = row.querySelector('.cv-main');
    let x0 = 0, y0 = 0, dx = 0, mode = null, base = 0;
    main.addEventListener('touchstart', e=>{ const t = e.touches[0]; x0 = t.clientX; y0 = t.clientY; dx = 0; mode = null; base = row.classList.contains('open') ? -88 : 0; main.style.transition = 'none'; }, {passive:true});
    main.addEventListener('touchmove', e=>{
      const t = e.touches[0], mx = t.clientX - x0, my = t.clientY - y0;
      if(!mode){ if(Math.abs(mx) < 8 && Math.abs(my) < 8) return; mode = Math.abs(mx) > Math.abs(my) ? 'x' : 'y'; if(mode==='x' && openRow && openRow!==row) shut(); }
      if(mode!=='x') return;
      if(e.cancelable) e.preventDefault();
      dx = Math.min(0, Math.max(-120, base + mx)); main.style.transform = `translateX(${dx}px)`;
    }, {passive:false});
    main.addEventListener('touchend', ()=>{
      main.style.transition = '';
      if(mode!=='x') return;
      if(dx < -44){ main.style.transform = 'translateX(-88px)'; row.classList.add('open'); openRow = row; }
      else { main.style.transform = ''; row.classList.remove('open'); if(openRow===row) openRow = null; }
      main.dataset.swiped = '1'; setTimeout(()=> delete main.dataset.swiped, 50);
    });
    main.addEventListener('click', ()=>{
      if(main.dataset.swiped) return;
      if(row.classList.contains('open') || openRow){ shut(); return; }
      open(row.dataset.row);
    });
    main.addEventListener('keydown', e=>{ if(e.key==='Enter') open(row.dataset.row); if(e.key==='Delete' || e.key==='Backspace') row.querySelector('.cv-del').click(); });
  });
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
  // event labels: flip to the left of their line near the right edge, and stack into the first row where they fit
  const rowsUsed = [[],[],[]];
  (opts.markers||[]).filter(m=> m.x>=from && m.x<=to).forEach(m=>{
    const x = X(m.x);
    const label = m.label.length > 24 ? m.label.slice(0,23).trimEnd()+'…' : m.label;
    const w = label.length*5.9 + 6, right = x + 4 + w <= W - padR;
    const x0 = right ? x + 4 : x - 4 - w, x1 = x0 + w;
    let row = rowsUsed.findIndex(rw=> rw.every(([a,b])=> x1 < a || x0 > b));
    if(row < 0) row = rowsUsed.length - 1;
    rowsUsed[row].push([x0, x1]);
    g += `<line x1="${x.toFixed(1)}" x2="${x.toFixed(1)}" y1="${padT}" y2="${H-padB}" class="ch-marker" style="stroke:${m.color}"/>`;
    g += `<text x="${(right ? x+4 : x-4).toFixed(1)}" y="${padT+10+row*12}" class="ch-mlab" text-anchor="${right?'start':'end'}" style="fill:${m.color}"><title>${esc(m.label)}</title>${esc(label)}</text>`;
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
    exportWeightToHealth(date, num(weight));
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
/* Progress summary: first weigh-in → latest, the change, the last 30 days and a sparkline of every weigh-in. */
function renderProgressHero(){
  const el = $('#progHero'); if(!el) return;
  const ws = state.checkins.filter(c=> num(c.weight,null)!=null).map(c=>({d:c.date, w:Math.round(toUnit(c.weight, c.weightUnit||'lb','lb')*10)/10})).sort((a,b)=> a.d.localeCompare(b.d));
  el.hidden = ws.length < 2;
  if(ws.length < 2){ el.innerHTML = ''; return; }
  const first = ws[0], last = ws[ws.length-1], diff = Math.round((last.w - first.w)*10)/10;
  const ago = ws.filter(x=> x.d <= addDays(last.d, -30)).pop();
  const d30 = ago ? Math.round((last.w - ago.w)*10)/10 : null;
  const W = 320, H = 54, lo = Math.min(...ws.map(x=>x.w)), hi = Math.max(...ws.map(x=>x.w)), span = Math.max(1, daysBetween(first.d, last.d));
  const X = d=> 4 + (W-8)*daysBetween(first.d, d)/span, Y = w=> 6 + (H-12)*(1 - (w-lo)/((hi-lo)||1));
  const pts = ws.map(x=> `${X(x.d).toFixed(1)},${Y(x.w).toFixed(1)}`).join(' ');
  const col = diff<=0 ? 'var(--good)' : '#ff9500';
  const sign = v=> v>0 ? '+' : v<0 ? '−' : '±';
  el.innerHTML = `
    <div class="pgh-top">
      <div><div class="pgh-change ${diff<0?'down':diff>0?'up':''}">${sign(diff)}${Math.abs(diff)}<small>lb</small></div><div class="pgh-cap">since ${esc(fmtDateShort(first.d))} · ${daysBetween(first.d, last.d)} days</div></div>
      ${d30!=null ? `<span class="pgh-chip ${d30>0?'up':''}">${sign(d30)}${Math.abs(d30)} lb · 30 days</span>` : ''}
    </div>
    <svg class="pgh-spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">
      <defs><linearGradient id="phg" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="${col}" stop-opacity=".28"/><stop offset="1" stop-color="${col}" stop-opacity="0"/></linearGradient></defs>
      <polygon points="${X(first.d).toFixed(1)},${H} ${pts} ${X(last.d).toFixed(1)},${H}" fill="url(#phg)"/>
      <polyline points="${pts}" fill="none" stroke="${col}" stroke-width="2.4" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>
    </svg>
    <div class="pgh-ends">
      <div class="pgh-end"><span>Start</span><strong>${first.w} lb</strong></div>
      <span class="pgh-arrow">→</span>
      <div class="pgh-end r"><span>Now</span><strong>${last.w} lb</strong></div>
    </div>`;
}
function renderProgress(){
  renderProgressHero();
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
      <div class="field span2"><label for="phWeight">Weight (lb, optional)</label><input id="phWeight" type="number" inputmode="decimal" step="0.1" min="0" placeholder="e.g. 182.4">
        <label class="endo-check" id="phLogWrap" style="margin-top:6px;font-weight:500;"><input type="checkbox" id="phLog" checked> Also save to my weight log</label></div>
      <div class="field span2"><label for="phNote">Note (optional)</label><input id="phNote" type="text" maxlength="140" placeholder="e.g. week 6, morning, fasted"></div>
    </div>
    <p class="footnote" style="margin-top:10px;">Photos are shrunk to about 1600 px and saved only on this device. They are included in backups.</p>
    <div class="form-actions"><button class="btn" id="phCancel">Cancel</button><button class="btn btn-accent-pep" id="phSave" disabled>Save photo</button></div>
    <div class="footnote" id="phStatus" style="margin-top:8px;"></div>
  `, body=>{
    let loaded = null;
    bindPhotoWeight(body);
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
        const date = $('#phDate',body).value || todayISO();
        await dbSet('photos', id, {date, angle: $('#phAngle',body).value, note: $('#phNote',body).value.trim(), w: full.w, h: full.h, ...photoWeightField(body)});
        await logPhotoWeight(body, date);
        closeModal();
      }catch(e){
        $('#phSave',body).disabled = false;
        $('#phStatus',body).textContent = (e && e.name==='QuotaExceededError') ? 'Storage is full. Delete some older photos first.' : 'Couldn\'t save that photo. Try again.';
      }
    });
  });
}
/* Weight at the time of a photo: the weight typed with the photo, else that day's weight log entry. */
function photoWeight(p){
  if(num(p.weightLb,null)!=null) return num(p.weightLb);
  const c = checkinFor(p.date);
  return c && num(c.weight,null)!=null ? Math.round(toUnit(c.weight, c.weightUnit||'lb', 'lb')*10)/10 : null;
}
const fmtLb = w=> `${(Math.round(w*10)/10).toLocaleString()} lb`;
// The photo form's weight box follows the chosen date's logged weight until you type your own;
// "Also save to my weight log" only shows when that day has no weight yet.
function bindPhotoWeight(body, own){
  const wi = $('#phWeight',body), di = $('#phDate',body), wrap = $('#phLogWrap',body);
  let typed = own!=null;
  if(own!=null) wi.value = own;
  const sync = ()=>{
    const c = checkinFor(di.value);
    const lw = c && num(c.weight,null)!=null ? Math.round(toUnit(c.weight, c.weightUnit||'lb', 'lb')*10)/10 : null;
    if(!typed) wi.value = lw!=null ? lw : '';
    wrap.hidden = !!c || !wi.value;
  };
  wi.addEventListener('input', ()=>{ typed = wi.value!==''; sync(); });
  di.addEventListener('change', sync);
  sync();
}
function photoWeightField(body){ const w = num($('#phWeight',body).value, null); return {weightLb: w!=null && w>0 ? Math.round(w*10)/10 : null}; }
async function logPhotoWeight(body, date){
  const w = photoWeightField(body).weightLb;
  if(w==null || $('#phLogWrap',body).hidden || !$('#phLog',body).checked || checkinFor(date)) return;
  await dbAdd('checkins', {date, weight: w, weightUnit: 'lb'});
  exportWeightToHealth(date, w);
}
function openPhotoEdit(p, onDone){
  openModal('Edit photo details', `
    <div class="form-grid">
      <div class="field"><label for="phDate">Date</label><input id="phDate" type="date" value="${esc(p.date)}" max="${todayISO()}"></div>
      <div class="field"><label for="phAngle">Angle</label><select id="phAngle">${PHOTO_ANGLES.map(a=>`<option ${a===p.angle?'selected':''}>${a}</option>`).join('')}</select></div>
      <div class="field span2"><label for="phWeight">Weight (lb, optional)</label><input id="phWeight" type="number" inputmode="decimal" step="0.1" min="0" placeholder="e.g. 182.4">
        <label class="endo-check" id="phLogWrap" style="margin-top:6px;font-weight:500;"><input type="checkbox" id="phLog" checked> Also save to my weight log</label></div>
      <div class="field span2"><label for="phNote">Note (optional)</label><input id="phNote" type="text" maxlength="140" value="${esc(p.note||'')}"></div>
    </div>
    <div class="form-actions"><button class="btn" id="phCancel">Cancel</button><button class="btn btn-accent-pep" id="phSave">Save</button></div>
  `, body=>{
    bindPhotoWeight(body, num(p.weightLb,null));
    $('#phCancel',body).addEventListener('click', ()=>{ closeModal(); onDone && onDone(); });
    $('#phSave',body).addEventListener('click', async ()=>{
      const cur = state.photos.find(x=>x.id===p.id); if(!cur) return closeModal();
      const date = $('#phDate',body).value || cur.date;
      await dbSet('photos', cur.id, {...stripId(cur), date, angle: $('#phAngle',body).value, note: $('#phNote',body).value.trim(), ...photoWeightField(body)});
      await logPhotoWeight(body, date);
      closeModal(); onDone && onDone();
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
      <span class="ph-cap"><span>${fmtDateShort(p.date)}</span><span>${photoWeight(p)!=null ? fmtLb(photoWeight(p)) : esc(p.angle)}</span></span>
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
/* ===== Photo album: full-screen, swipe between photos (oldest on the left, like Photos), thumbnail strip,
   date / angle / weight with the change since the first photo in view. Follows the grid's angle filter. ===== */
async function openPhotoViewer(id){
  const list = state.photos.filter(p=> photoFilter==='All' || p.angle===photoFilter).sort((a,b)=> a.date.localeCompare(b.date) || String(a.id).localeCompare(String(b.id)));
  if(!list.some(p=>p.id===id)){ const p = state.photos.find(x=>x.id===id); if(!p) return; list.length = 0; list.push(p); }
  let idx = Math.max(0, list.findIndex(p=>p.id===id));
  const ov = openOverlay('Progress photos');
  const onKey = e=>{ if(e.key==='Escape') close(); if(e.key==='ArrowLeft') go(idx-1); if(e.key==='ArrowRight') go(idx+1); };
  document.addEventListener('keydown', onKey);
  const close = ()=>{ document.removeEventListener('keydown', onKey); closeOverlay(ov); };
  const firstW = list.find(p=> photoWeight(p)!=null);
  ov.innerHTML = `<div class="cmp-top"><h3 id="alTitle"></h3><span class="al-count" id="alCount"></span><button type="button" class="cmp-x" aria-label="Close photos">✕</button></div>
    <div class="al-track" id="alTrack">${list.map((p,i)=>`<div class="al-slide"><img data-al="${i}" alt="${esc(p.angle)} progress photo from ${esc(fmtDate(p.date))}"></div>`).join('')}</div>
    <div class="al-info" id="alInfo"></div>
    ${list.length>1 ? `<div class="al-strip" id="alStrip">${list.map((p,i)=>`<button type="button" data-al-go="${i}" aria-label="${esc(fmtDateShort(p.date))}"><img data-al-t="${i}" alt=""></button>`).join('')}</div>` : ''}
    <div class="al-actions"><button type="button" id="alEdit">✎ Edit</button><button type="button" id="alPts">📍 Points</button><button type="button" id="alDel" class="danger">Delete</button></div>`;
  const track = $('#alTrack',ov), strip = $('#alStrip',ov);
  const load = async i=>{
    const img = $(`[data-al="${i}"]`,ov); if(!img || img.dataset.done) return;
    img.dataset.done = '1';
    const p = list[i];
    const t = await blobUrl(p.id+'_t'); if(t && !img.src) img.src = t;   // thumbnail first, sharp version right after
    const u = await blobUrl(p.id); if(u) img.src = u; else if(!t) img.closest('.al-slide').classList.add('missing');
  };
  if(strip) $$('[data-al-t]',strip).forEach(async img=>{ const p = list[+img.dataset.alT]; const u = await blobUrl(p.id+'_t') || await blobUrl(p.id); if(u) img.src = u; });
  function show(){
    const p = list[idx], w = photoWeight(p);
    $('#alTitle',ov).textContent = `${p.angle} · ${fmtDate(p.date)}`;
    $('#alCount',ov).textContent = list.length>1 ? `${idx+1} of ${list.length}` : '';
    let delta = '';
    if(w!=null && firstW && firstW!==p){
      const d = Math.round((w - photoWeight(firstW))*10)/10;
      delta = `<span class="al-delta ${d<0?'down':d>0?'up':''}">${d>0?'+':d<0?'−':'±'}${Math.abs(d)} lb since ${esc(fmtDateShort(firstW.date))}</span>`;
    }
    const days = idx>0 ? daysBetween(list[0].date, p.date) : 0;
    $('#alInfo',ov).innerHTML = `<div class="al-line">${w!=null ? `<strong>${fmtLb(w)}</strong>` : '<span class="al-dim">No weight</span>'}${delta}${days>0 ? `<span class="al-dim">Day ${days+1}</span>` : ''}</div>${p.note ? `<div class="al-note">${esc(p.note)}</div>` : ''}`;
    $('#alPts',ov).textContent = `📍 ${p.landmarks ? 'Redo' : 'Set'} points`;
    [idx-1, idx, idx+1].forEach(i=>{ if(i>=0 && i<list.length) load(i); });
    if(strip){
      $$('[data-al-go]',strip).forEach(b=> b.classList.toggle('on', +b.dataset.alGo===idx));
      const b = $(`[data-al-go="${idx}"]`,strip);
      if(b) strip.scrollTo({left: b.offsetLeft - strip.clientWidth/2 + b.offsetWidth/2, behavior:'smooth'});
    }
  }
  function go(i, smooth=true){ if(i<0 || i>=list.length) return; track.scrollTo({left: i*track.clientWidth, behavior: smooth ? 'smooth' : 'auto'}); if(!smooth){ idx = i; show(); } }
  let raf = 0;
  track.addEventListener('scroll', ()=>{ cancelAnimationFrame(raf); raf = requestAnimationFrame(()=>{ const i = Math.round(track.scrollLeft / (track.clientWidth||1)); if(i!==idx && i>=0 && i<list.length){ idx = i; show(); } }); }, {passive:true});
  if(strip) strip.addEventListener('click', e=>{ const b = e.target.closest('[data-al-go]'); if(b) go(+b.dataset.alGo); });
  $('.cmp-x',ov).addEventListener('click', close);
  const reopen = pid=> ()=>{ if(state.photos.some(x=>x.id===pid)) openPhotoViewer(pid); };
  $('#alEdit',ov).addEventListener('click', ()=>{ const p = list[idx]; close(); openPhotoEdit(p, reopen(p.id)); });
  $('#alPts',ov).addEventListener('click', ()=>{ const p = list[idx]; close(); openPointPicker(p.id, ()=> openPhotoViewer(p.id)); });
  $('#alDel',ov).addEventListener('click', ()=>{
    const p = list[idx], next = list[idx+1] || list[idx-1];
    close();
    confirmAction('Delete this photo from this device?', async ()=>{
      [p.id, p.id+'_t'].forEach(k=>{ const u2 = blobUrlCache.get(k); if(u2){ URL.revokeObjectURL(u2); blobUrlCache.delete(k); } });
      try{ await delBlob(p.id); await delBlob(p.id+'_t'); }catch(e){}
      await dbDelete('photos', p.id);
      if(next) openPhotoViewer(next.id);
    });
  });
  requestAnimationFrame(()=> go(idx, false));
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
  const cap = i=>{ const w = photoWeight(ps[i]); return `${i===0?'Before':'After'} · ${fmtDateShort(ps[i].date)}${w!=null ? ' · '+fmtLb(w) : ''}`; };
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
  let counting = null, uwId = null, zoomCap = null;
  // back: '0.5' | '1'; front: 'wide' (the full 4:3 sensor, like the Camera app's zoomed-out selfie) | '1'
  const lensKey = ()=> facing==='user' ? 'ledger.camFrontLens' : 'ledger.camLens';
  let lens;
  const stop = ()=>{ if(stream){ stream.getTracks().forEach(t=> t.stop()); stream = null; } if(counting){ clearInterval(counting); counting = null; } };
  const close = ()=>{ stop(); closeOverlay(ov); };
  const lastOf = a=> state.photos.filter(p=> p.angle===a).sort((x,y)=> y.date.localeCompare(x.date))[0];
  async function render(){
    const last = lastOf(angle);
    const gu = last ? await blobUrl(last.id) : null;
    const mirror = facing==='user' ? 'transform:scaleX(-1);' : '';
    lens = lsGet(lensKey(), facing==='user' ? 'wide' : '1');
    ov.innerHTML = `<div class="cmp-top"><h3>Guided photo</h3><button type="button" class="cmp-x" aria-label="Close camera">✕</button></div>
      <div class="cmp-modes">${PHOTO_ANGLES.map(a=>`<button type="button" class="${a===angle?'on':''}" data-angle="${a}">${a}</button>`).join('')}</div>
      <div class="cmp-stage"><div class="cmp-box cam-box">
        <video id="camVideo" playsinline autoplay muted style="${mirror}"></video>
        ${gu ? `<img id="camGhost" src="${gu}" alt="" style="${mirror}opacity:${ghostOpacity/100}">` : ''}
        <div class="tune-grid"></div>
        <div class="cam-lens" id="camLens" hidden>${facing==='user'
          ? `<button type="button" data-lens="wide" aria-label="Wide selfie"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12h18M3 12l4-4M3 12l4 4M21 12l-4-4M21 12l-4 4"/></svg></button><button type="button" data-lens="1">1×</button>`
          : `<button type="button" data-lens="0.5">.5</button><button type="button" data-lens="1">1×</button>`}</div>
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
      const useUW = facing==='environment' && lens==='0.5' && uwId;
      // A square 1920 request gets a 16:9 feed, which crops the front sensor; asking for its full 4:3 frame gives the wide view.
      const size = facing==='user' && lens==='wide' ? {width:{ideal:4032}, height:{ideal:3024}} : {width:{ideal:1920}, height:{ideal:1920}};
      stream = await navigator.mediaDevices.getUserMedia({video:{...(useUW ? {deviceId:{exact:uwId}} : {facingMode: facing}), ...size}, audio:false});
      if(!ov.isConnected){ stop(); return; }
      video.srcObject = stream; await video.play().catch(()=>{});
      msg.hidden = true;
      await setupLens(useUW);
    }catch(e){
      msg.textContent = e && e.name==='NotAllowedError' ? 'Camera access was blocked. Allow camera access for this app in your phone\'s settings, then try again.' : 'Couldn\'t start the camera.';
    }
  }
  /* .5× / 1× like the Camera app. The back ultra-wide lens is its own camera (iPhone labels it "Back Ultra Wide Camera");
     where the browser instead exposes a zoom range that goes below 1, the same buttons set the zoom.
     Front: wide (full sensor, lowest zoom) or 1× (the standard 16:9 feed). */
  async function setupLens(usingUW){
    const box = $('#camLens',ov); if(!box || !stream) return;
    const track = stream.getVideoTracks()[0];
    try{ zoomCap = track && track.getCapabilities ? track.getCapabilities().zoom || null : null; }catch(e){ zoomCap = null; }
    if(facing==='environment' && !uwId){
      try{ const d = (await navigator.mediaDevices.enumerateDevices()).find(d=> d.kind==='videoinput' && /ultra ?wide/i.test(d.label)); uwId = d ? d.deviceId : null; }catch(e){}
      if(uwId && lens==='0.5' && !usingUW && !(zoomCap && zoomCap.min < 1)){ stop(); return render(); }
    }
    const zoomable = zoomCap && zoomCap.min < 1;
    if(facing==='user'){
      if(lens==='wide' && zoomCap && zoomCap.min < 1){ try{ await track.applyConstraints({advanced:[{zoom: zoomCap.min}]}); }catch(e){} }
    } else if(!(uwId || zoomable)){ box.hidden = true; return; }
    else if(zoomable && !usingUW){
      try{ await track.applyConstraints({advanced:[{zoom: lens==='0.5' ? Math.max(zoomCap.min, .5) : 1}]}); }catch(e){}
    }
    box.hidden = false;
    $$('[data-lens]',box).forEach(b=>{
      b.classList.toggle('on', b.dataset.lens===lens);
      b.addEventListener('click', async ()=>{
        if(b.dataset.lens===lens) return;
        lens = b.dataset.lens; lsSet(lensKey(), lens);
        $$('[data-lens]',box).forEach(x=> x.classList.toggle('on', x.dataset.lens===lens));
        if(facing==='user' || uwId){ stop(); render(); }
        else track.applyConstraints({advanced:[{zoom: lens==='0.5' ? Math.max(zoomCap.min, .5) : 1}]}).catch(()=>{});
      });
    });
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
  return `You are the assistant inside Pep Prep, the user's private app for tracking peptide protocols, doses, vials, vendors and weight. Today is ${fmtDate(todayISO())}.

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
/* POST to the Messages API. The iPhone app's web view only talks to its app-bound domain (the GitHub Pages site), so
   older builds block a direct fetch to api.anthropic.com. There the request goes through Capacitor's native HTTP
   instead: the whole streamed reply comes back at once and is wrapped in a Response, so the stream parser is unchanged. */
async function claudeFetch(signal, headers, body){
  const url = 'https://api.anthropic.com/v1/messages';
  const H = capPlugin('CapacitorHttp');
  if(!(H && claudeFetch.useNative)){
    try{ return await fetch(url, {method:'POST', signal, headers, body: JSON.stringify(body)}); }
    catch(e){ if(e && e.name==='AbortError' || !H) throw e; claudeFetch.useNative = true; }
  }
  const r = await H.request({url, method:'POST', headers, data: body, responseType:'text', connectTimeout: 30000, readTimeout: 600000});
  if(signal.aborted){ const e = new Error('Stopped'); e.name = 'AbortError'; throw e; }
  const text = typeof r.data==='string' ? r.data : JSON.stringify(r.data);
  return new Response(text, {status: r.status || 200, headers: {'content-type': (r.headers && (r.headers['Content-Type'] || r.headers['content-type'])) || 'text/event-stream'}});
}
async function sendAsk(){
  if(askBusy){ if(askAbort) askAbort.abort(); return; }
  const input = $('#askInput'); const text = input.value.trim(); if(!text) return;
  const key = claudeKey(); if(!key) return renderAsk();
  if(!askConv) askConv = {model: claudeModel(), system: askSystemPrompt(), messages: [], topic: chatTitle({topic:text}), createdAt: todayISO(), costUsd: 0};
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
      const res = await claudeFetch(askAbort.signal, {
          'content-type':'application/json',
          'x-api-key': key,
          'anthropic-version':'2023-06-01',
          'anthropic-dangerous-direct-browser-access':'true',
          'anthropic-beta':'server-side-fallback-2026-07-01',
        }, {
          model: askConv.model, max_tokens: 32000, stream: true,
          system: [{type:'text', text: askConv.system, cache_control:{type:'ephemeral'}}],
          messages: msgs,
          tools: [{type:'web_search_20260209', name:'web_search', max_uses: 6}],
          output_config: {effort: 'medium'},
          fallbacks: 'default',
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
  const rs = $('#researchSearch'); if(rs) rs.addEventListener('input', ()=>{ researchQuery = rs.value; renderResearch(); });
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

/* ===================== Peptide library =====================
   Reference pages for 150+ peptides from Peptide Schedule (peptideschedule.com), imported with their permission.
   library/index.json is a small searchable list; library/<slug>.json holds one peptide's page and is fetched when
   opened (the service worker keeps both for offline use). Pages show your own stash and protocols for that peptide
   and can start a protocol. The library also supplies half-lives for the serum chart when the app has none. */
let libIndex = null, libLoading = null, libCat = 'All', libQuery = '', libSlug = null;
const libPages = new Map();
const LIB_COLORS = {'Weight Loss':'#ff8a1e','Healing & Recovery':'#30b0c7','Growth Hormone':'#5e5ce6','Anti-Aging':'#bf5af2','Cognitive':'#0a84ff','Sexual Health':'#ff375f','Immune':'#34c759','Sleep':'#5856d6','Muscle Growth':'#ff453a','Skin & Hair':'#ff9f0a','Tanning':'#a2845e','Metabolic':'#64d2ff','Longevity':'#bf5af2','Mitochondrial':'#ffd60a','Hormonal':'#ff6482','Gut Health':'#32d74b'};
const libColor = c=> LIB_COLORS[c] || '#8e8e93';
const libKey = s=> String(s||'').toLowerCase().replace(/\(.*?\)/g,'').replace(/[^a-z0-9]/g,'');
function loadLibIndex(){
  if(libIndex) return Promise.resolve(libIndex);
  if(!libLoading) libLoading = fetch('library/index.json').then(r=> r.ok ? r.json() : null).then(j=>{ libIndex = j && j.items || []; return libIndex; }).catch(()=>{ libLoading = null; return []; });
  return libLoading;
}
function loadLibPage(slug){
  if(libPages.has(slug)) return Promise.resolve(libPages.get(slug));
  return fetch(`library/${slug}.json`).then(r=> r.ok ? r.json() : null).then(j=>{ if(j) libPages.set(slug, j); return j; }).catch(()=> null);
}
// The library entry for a compound name (matches the name or any alias, ignoring punctuation and case).
function libFind(name){
  if(!libIndex || !name) return null;
  const k = libKey(name); if(!k) return null;
  return libIndex.find(x=> libKey(x.n)===k || x.a.some(a=> libKey(a)===k)) || null;
}
function libHalfLife(name){ const e = libFind(name); return e && e.h > 0 ? e.h : null; }
// What you have of a peptide: protocols (including blends that contain it) and vials in the stash
function libMine(entry){
  const keys = new Set([entry.n].concat(entry.a).map(libKey));
  const hit = n=> keys.has(libKey(n));
  const protos = state.protocols.filter(p=> p.status!=='archived' && (hit(p.compound) || (blendOf(p)||[]).some(c=> hit(c.name))));
  const vials = state.vials.filter(v=> !isDepleted(v) && (hit(v.compound) || (isMixedBlend(v) && v.blend.some(c=> hit(c.name)))));
  return {protos, vials, count: vials.reduce((t,v)=> t + num(v.qty,0) + (v.remainingMg!=null ? 1 : 0), 0)};
}
async function renderLibrary(){
  const list = $('#libList'); if(!list) return;
  if(!libIndex){ list.innerHTML = `<p class="footnote lib-none">Loading the library…</p>`; await loadLibIndex(); }
  if(!libIndex.length){ list.innerHTML = `<p class="footnote lib-none">The library couldn't load. Check your connection and try again.</p>`; return; }
  $('#libSearch').placeholder = `Search ${libIndex.length} peptides`;
  const cats = ['All','In my stash'].concat([...new Set(libIndex.map(x=> x.c).filter(Boolean))].sort());
  $('#libCats').innerHTML = cats.map(c=>{ const k = c==='All' ? 'var(--ink)' : c==='In my stash' ? 'var(--accent-pep)' : libColor(c);
    return `<button type="button" data-lib-cat="${esc(c)}" class="${c===libCat?'on':''}" style="--c:${k}">${c==='All' ? '' : '<i></i>'}${esc(c)}</button>`; }).join('');
  const q = libKey(libQuery), words = libQuery.trim().toLowerCase().split(/\s+/).filter(Boolean);
  let items = libIndex.filter(x=>{
    if(libCat==='In my stash'){ if(!libMine(x).protos.length && !libMine(x).count) return false; }
    else if(libCat!=='All' && x.c!==libCat) return false;
    if(!q) return true;
    const hay = [x.n].concat(x.a, x.t, [x.c]).join(' ').toLowerCase();
    return libKey(x.n).includes(q) || x.a.some(a=> libKey(a).includes(q)) || words.every(w=> hay.includes(w));
  });
  if(!items.length){ list.innerHTML = `<p class="footnote lib-none">No peptides match “${esc(libQuery)}”.</p>`; return; }
  let html = '', letter = null;
  items.forEach(x=>{
    const L = /[a-z]/i.test(x.n[0]) ? x.n[0].toUpperCase() : '#';
    if(!q && libCat==='All' && L!==letter){ html += `${letter ? '</div>' : ''}<div class="lib-letter">${L}</div><div class="ios-list">`; letter = L; }
    else if(letter===null && html===''){ html += '<div class="ios-list">'; letter = ''; }
    const mine = libMine(x);
    html += `<button type="button" class="lib-row" data-lib="${esc(x.s)}"><span class="lib-ic">${libMolecule(libColor(x.c), 30)}</span>
      <span class="lib-rt"><strong>${esc(x.n)}${mine.protos.length || mine.count ? '<i class="lib-mine">Mine</i>' : ''}</strong><span><em style="color:${libColor(x.c)}">${esc(x.c||'')}</em></span></span>
      ${x.g ? `<span class="lib-grade g${esc(x.g[0])}" title="Safety grade ${esc(x.g)}">${esc(x.g)}</span>` : ''}<span class="ios-chev"></span></button>`;
  });
  list.innerHTML = html + '</div>';
  // the rest of the library downloads quietly for offline reading
  if(!renderLibrary.prefetched){ renderLibrary.prefetched = true; libPrefetch(); }
}
function libPrefetch(){
  const queue = libIndex.map(x=> x.s);
  const next = ()=>{ const s0 = queue.shift(); if(!s0) return; fetch(`library/${s0}.json`).catch(()=>{}).finally(()=> setTimeout(next, 120)); };
  setTimeout(next, 2500);
}
function openPeptide(slug){
  if(slug!==libSlug) libTab = 'overview';
  libSlug = slug;
  const e = libIndex && libIndex.find(x=> x.s===slug);
  TAB_META.peptide.title = e ? e.n : 'Peptide';
  setTab('peptide');
  renderPeptidePage();
}
// Inline text: **bold**, [links](url) and citation markers [n] that jump to the reference
function libInline(x){
  return esc(x).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
    .replace(/ ?\[(\d{1,2})\]/g, '<span class="lib-cite" data-cite="$1">$1</span>');
}
/* Small line icons (24px grid, drawn with stroke) used for section tiles and list markers. */
const LIB_IC = {
  info:'<circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/>',
  zap:'<path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z"/>',
  check:'<path d="M20 6 9 17l-5-5"/>',
  scale:'<path d="M12 3v18M7 21h10M5 7h14M5 7l-3 7a3.5 3.5 0 0 0 6 0L5 7zM19 7l-3 7a3.5 3.5 0 0 0 6 0l-3-7z"/>',
  syringe:'<path d="m18 2 4 4M17 7l3-3M19 9 8.7 19.3a1 1 0 0 1-1.4 0l-2.6-2.6a1 1 0 0 1 0-1.4L15 5M9 11l4 4M5 19l-3 3M14 4l6 6"/>',
  target:'<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/>',
  steps:'<path d="M10 6h11M10 12h11M10 18h11M4 6h1v4M4 10h2M6 18H4c0-1 2-2 2-3s-1-1.5-2-1"/>',
  layers:'<path d="m12 2 10 5-10 5L2 7l10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/>',
  dollar:'<path d="M12 1v22M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/>',
  alert:'<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0zM12 9v4M12 17h.01"/>',
  x:'<circle cx="12" cy="12" r="10"/><path d="m15 9-6 6M9 9l6 6"/>',
  pill:'<path d="m10.5 20.5 10-10a5 5 0 1 0-7-7l-10 10a5 5 0 1 0 7 7zM8.5 8.5l7 7"/>',
  shield:'<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="m9 12 2 2 4-4"/>',
  pulse:'<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
  clock:'<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
  bank:'<path d="M3 22h18M6 18v-7M10 18v-7M14 18v-7M18 18v-7M12 2l9 5H3l9-5z"/>',
  users:'<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM22 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8"/>',
  user:'<path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z"/>',
  snow:'<path d="M2 12h20M12 2v20M20 16l-4-4 4-4M4 8l4 4-4 4M16 4l-4 4-4-4M8 20l4-4 4 4"/>',
  bell:'<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10.3 21a2 2 0 0 0 3.4 0"/>',
  help:'<circle cx="12" cy="12" r="10"/><path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3M12 17h.01"/>',
  book:'<path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2V3zM22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7V3z"/>',
  flask:'<path d="M9 3h6M10 3v6L4.5 18.5A2 2 0 0 0 6.2 21h11.6a2 2 0 0 0 1.7-2.5L14 9V3M7 15h10"/>',
  vial:'<path d="M9 2h6M10 2v4M14 2v4M8 6h8v14a2 2 0 0 1-2 2h-4a2 2 0 0 1-2-2V6zM8 13h8"/>',
  drop:'<path d="M12 2.7s-6 6.4-6 11.3a6 6 0 0 0 12 0c0-4.9-6-11.3-6-11.3z"/>',
  chev:'<path d="m9 18 6-6-6-6"/>',
  note:'<path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/>',
};
const libIc = (k, cls='')=> `<svg class="lib-svg ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${LIB_IC[k]||''}</svg>`;
// Each section gets an icon and a colour, so pages read the same way every time.
const LIB_SEC = {
  'What is it?':['info','blue'], 'How it works':['zap','purple'], 'Benefits':['check','green'], 'Science vs community':['scale','indigo'],
  'Dosage Guide':['syringe','orange'], 'Protocols by goal':['target','orange'], 'How to Use it':['steps','teal'], 'How to Inject it':['steps','teal'],
  'Stacking Protocols':['layers','cyan'], 'Estimated Cost':['dollar','green'], 'Side Effects':['alert','amber'], 'Contraindications':['x','red'],
  'Drug Interactions':['pill','amber'], 'Product Quality':['shield','blue'], 'Recommended Monitoring':['pulse','pink'], 'Pharmacokinetics':['clock','purple'],
  'Is it legal?':['bank','grey'], 'Who Should Consider it':['users','blue'], 'Recent updates':['bell','indigo'], 'Storage & Stability':['snow','cyan'],
  'FAQ':['help','blue'], 'References':['book','grey'],
};
// The four tabs of a peptide page and which sections each holds
const LIB_TABS = [
  ['overview','Overview','info','blue', ['What is it?','How it works','Benefits','Who Should Consider it']],
  ['dosing','Dosing','syringe','orange', ['Dosage Guide','Protocols by goal','How to Use it','How to Inject it','Stacking Protocols','Storage & Stability','Estimated Cost']],
  ['safety','Safety','shield','red', ['Side Effects','Contraindications','Drug Interactions','Recommended Monitoring','Product Quality']],
  ['science','Science','flask','purple', ['Science vs community','Pharmacokinetics','Recent updates','Is it legal?','FAQ','References']],
];
let libTab = 'overview';
const libC = c=> `var(--lb-${c})`;
const libPill = (txt, c, ic)=> `<span class="lb-pill" style="--c:${libC(c)}">${ic ? libIc(ic) : ''}${esc(txt)}</span>`;
const LIB_STATUS = {'FDA Approved':'green', 'Phase 3':'blue', 'Phase 2':'blue', 'Phase 1':'blue', 'Preclinical':'amber', 'Research':'amber', 'Compounded':'purple', 'Cosmetic':'pink'};
const LIB_GRADE = {A:'green', B:'blue', C:'amber', D:'red', F:'red'};
const LIB_LEVEL = {beginner:'green', moderate:'amber', intermediate:'amber', aggressive:'red', advanced:'red'};
// A cluster of dots in the category colour, like a molecule, for the page header and related cards.
function libMolecule(color, size=44){
  const pts = [[12,12,4.2],[5,8,2.8],[19,7,2.6],[6,17.5,3],[18,17,3.2],[12,3.6,2],[12,20.6,2],[2.6,12.6,1.6],[21.4,12,1.6]];
  return `<svg class="lib-mol" width="${size}" height="${size}" viewBox="0 0 24 24" aria-hidden="true">${pts.map(([x,y,r],i)=> `<circle cx="${x}" cy="${y}" r="${r}" fill="${color}" fill-opacity="${[1,.55,.75,.8,.6,.45,.5,.35,.4][i]}"/>`).join('')}</svg>`;
}
// Long prose gets a "Read more" fold so each section opens with a glance-sized preview.
function libClamp(html, len){ return len > 520 ? `<div class="lb-clamp">${html}</div><button type="button" class="lb-more" data-more>Read more</button>` : html; }
const libTxtLen = blocks=> blocks.reduce((t,b)=> t + (b.x||'').length, 0);
// Generic block rendering (anything without a special layout)
function libBlocks(blocks, opt={}){
  let html = '', i = 0;
  while(i < blocks.length){
    const b = blocks[i];
    if(b.t==='li'){
      let ul = ''; while(i < blocks.length && blocks[i].t==='li') ul += `<li>${opt.ic ? `<span class="lb-li-ic">${libIc(opt.ic)}</span>` : '<span class="lb-dot"></span>'}<span>${libInline(blocks[i++].x)}</span></li>`;
      html += `<ul class="lb-list" style="--c:${libC(opt.c||'grey')}">${ul}</ul>`; continue;
    }
    if(b.t==='kv'){
      let dl = ''; while(i < blocks.length && blocks[i].t==='kv'){ const k = blocks[i].k, v = blocks[i].v; dl += `<div class="lb-tile"><span>${libInline(k)}</span><strong>${libInline(v)}</strong></div>`; i++; }
      html += `<div class="lb-tiles">${dl}</div>`; continue;
    }
    if(b.t==='step'){
      let ol = '', n = 0;
      while(i < blocks.length && blocks[i].t==='step'){
        const s = blocks[i++]; let h = s.h, x = s.x;
        if(!h){ const m = /^([^:.]{3,42}):\s+(.+)$/.exec(x); if(m){ h = m[1]; x = m[2]; } }
        ol += `<li class="lb-step"><span class="lb-num">${++n}</span><div>${h ? `<strong>${libInline(h)}</strong>` : ''}<p>${libInline(x)}</p></div></li>`;
      }
      html += `<ol class="lb-steps">${ol}</ol>`; continue;
    }
    if(b.t==='row'){
      const rows = []; while(i < blocks.length && blocks[i].t==='row') rows.push(blocks[i++].c);
      const head = rows.length > 1 && rows[0].every(c=> c.length < 30) ? rows.shift() : null;
      const n = Math.max(...rows.map(r0=> r0.length), head ? head.length : 0);
      html += `<div class="lib-tbl"><table>${head ? `<thead><tr>${head.map(c=>`<th>${libInline(c)}</th>`).join('')}</tr></thead>` : ''}<tbody>${rows.map(r0=>`<tr>${Array.from({length:n},(_,k)=>`<td>${libInline(r0[k]||'')}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
      continue;
    }
    html += b.t==='h' ? `<h4 class="lb-h">${libInline(b.x)}</h4>` : `<p>${libInline(b.x)}</p>`;
    i++;
  }
  return html;
}
// Split blocks into runs that start at each heading: [{h, b:[...]}]
function libSplit(blocks){
  const out = [{h:null, b:[]}];
  blocks.forEach(b=>{ if(b.t==='h') out.push({h:b.x, b:[]}); else out[out.length-1].b.push(b); });
  return out;
}
/* Section-specific layouts. Each falls back to the generic blocks when the content isn't the expected shape. */
function libSection(title, blocks, rec){
  switch(title){
    case 'What is it?': case 'How it works': return libClamp(libBlocks(blocks), libTxtLen(blocks));
    case 'Benefits': return libBlocks(blocks, {ic:'check', c:'green'});
    case 'Who Should Consider it': return libBlocks(blocks, {ic:'user', c:'blue'});
    case 'Contraindications': return `<div class="lb-box" style="--c:${libC('red')}">${libBlocks(blocks, {ic:'x', c:'red'})}</div>`;
    case 'Drug Interactions': return libBlocks(blocks, {ic:'alert', c:'amber'});
    case 'Science vs community': return libScience(blocks);
    case 'Dosage Guide': return libDosage(blocks);
    case 'Stacking Protocols': return libStacking(blocks);
    case 'Estimated Cost': return libCost(blocks);
    case 'Side Effects': return libSideEffects(blocks);
    case 'Product Quality': return libQuality(blocks);
    case 'Recommended Monitoring': return libMonitoring(blocks);
    case 'Pharmacokinetics': return libPK(blocks, rec);
    case 'Is it legal?': return libLegal(blocks);
    case 'Recent updates': return libUpdates(blocks);
    case 'Storage & Stability': return libStorage(blocks);
    default: return libBlocks(blocks, {c:'teal'});
  }
}
const LIB_VERDICT = {'aligned':'green', 'partially aligned':'amber', 'divergent':'red', 'science only':'blue'};
function libScience(blocks){
  const verdict = blocks[0] && blocks[0].t==='p' && LIB_VERDICT[blocks[0].x.toLowerCase()] ? blocks.shift().x : '';
  const vc = LIB_VERDICT[verdict.toLowerCase()] || 'grey';
  let sci = '', com = '', sum = '';
  libSplit(blocks).forEach(({h, b})=>{
    if(!h){ sum += libBlocks(b); return; }
    if(/^Scientific Evidence/.test(h)){
      const meta = b[0] && /^Based on/.test(b[0].x||'') ? b.shift().x : '';
      sci += `${meta ? `<div class="lb-meta">${libIc('shield')}${esc(meta)}</div>` : ''}${libBlocks(b)}`;
    } else if(/^(Key Study|Limitations)/.test(h)){
      sci += `<div class="lb-sub"><span class="lb-label">${esc(h)}</span>${libBlocks(b)}</div>`;
    } else if(/^Community Experience/.test(h)){
      com += libBlocks(b);
    } else if(/^What users report/.test(h)){
      com += `<div class="lb-sub"><span class="lb-label" style="color:${libC('green')}">${esc(h)}</span>${libBlocks(b.filter(x=> x.t==='li'), {ic:'check', c:'green'})}</div>`;
      sum += libBlocks(b.filter(x=> x.t!=='li'));
    } else if(/^Common issues/.test(h)){
      com += `<div class="lb-sub"><span class="lb-label" style="color:${libC('amber')}">${esc(h)}</span>${libBlocks(b.filter(x=> x.t==='li'), {ic:'alert', c:'amber'})}</div>`;
      sum += libBlocks(b.filter(x=> x.t!=='li'));
    } else sum += `<span class="lb-label">${esc(h)}</span>${libBlocks(b)}`;
  });
  return `${verdict ? `<div class="lb-row">${libPill(verdict, vc, 'scale')}</div>` : ''}
    ${sci ? `<div class="lb-card" style="--c:${libC('blue')}"><div class="lb-card-h">${libIc('flask')}<strong>Scientific evidence</strong></div>${sci}</div>` : ''}
    ${com ? `<div class="lb-card" style="--c:${libC('orange')}"><div class="lb-card-h">${libIc('users')}<strong>Community experience</strong></div>${com}</div>` : ''}
    ${sum ? `<div class="lb-box" style="--c:${libC(vc)}">${verdict ? `<span class="lb-label" style="color:${libC(vc)}">${esc(verdict)}</span>` : ''}${sum}</div>` : ''}`;
}
function libDosage(blocks){
  let html = '', i = 0;
  // the source line, e.g. "Community Community dosing consensus…" or "FDA Label Zepbound FDA Prescribing Information…"
  if(blocks[0] && blocks[0].t==='p'){
    const m = /^(Community|FDA Label|Clinical Trial|Clinical)\s+(.*)$/i.exec(blocks[0].x);
    if(m){ i = 1; const c = /fda/i.test(m[1]) ? 'green' : /clinical/i.test(m[1]) ? 'blue' : 'orange';
      html += `<div class="lb-src">${libPill(m[1].replace(/^FDA Label$/i,'FDA label'), c, /fda/i.test(m[1]) ? 'shield' : /clinical/i.test(m[1]) ? 'flask' : 'users')}<span>${libInline(m[2].replace(/^Community\s+/,''))}</span></div>`; }
  }
  const rows = []; while(i < blocks.length && blocks[i].t==='row') rows.push(blocks[i++].c);
  if(rows.length){
    const head = rows[0][0]==='Level' ? rows.shift() : ['Level','Dose','Frequency'];
    html += `<div class="lb-dose"><div class="lb-dose-h">${head.map(h=> `<span>${esc(h.replace(' / Injection',''))}</span>`).join('')}</div>${rows.map(r0=> `<div class="lb-dose-r"><span><i style="background:${libC(LIB_LEVEL[(r0[0]||'').toLowerCase()]||'grey')}"></i>${esc(r0[0]||'')}</span><strong class="mono">${esc(r0[1]||'')}</strong><span>${esc(r0[2]||'')}</span></div>`).join('')}</div>`;
  }
  const rest = blocks.slice(i);
  const runs = libSplit(rest);
  runs.forEach(({h, b}, k)=>{
    if(!h){ html += libClamp(libBlocks(b), libTxtLen(b)); return; }
    html += `<div class="lb-card" style="--c:${libC('orange')}"><div class="lb-card-h">${libIc(/cycl/i.test(h) ? 'clock' : 'syringe')}<strong>${esc(h)}</strong></div>${libBlocks(b, {ic:'alert', c:'amber'})}</div>`;
  });
  return html;
}
function libStacking(blocks){
  let html = '';
  libSplit(blocks).forEach(({h, b}, k, all)=>{
    if(!h && !b.length) return;
    if(h==='Works With' || h==='Avoid'){ html += `<div class="lb-label lb-label-ic" style="color:${libC(h==='Avoid'?'red':'green')}">${libIc(h==='Avoid'?'x':'check')}${h==='Avoid'?'Avoid with':'Works with'}</div>`; }
    if(h==='Avoid'){
      for(let j=0; j<b.length; j++){
        const name = b[j].x, why = b[j+1] && b[j+1].t==='p' ? b[++j].x : '';
        html += `<div class="lb-stack" style="--c:${libC('red')}"><strong>${libInline(name)}</strong>${why ? `<p>${libInline(why)}</p>` : ''}</div>`;
      }
      return;
    }
    if(!h || h==='Works With'){ if(b.length) html += libBlocks(b); return; }
    // a stacking partner: rationale, then the dosing line
    const e = libFind(h), proto = b.length > 1 ? b[b.length-1] : null, body = proto ? b.slice(0,-1) : b;
    html += `<div class="lb-stack" style="--c:${libC('green')}"><div class="lb-stack-h"><strong>${esc(h)}</strong>${e ? `<button type="button" class="lb-link" data-lib="${esc(e.s)}">Open ${libIc('chev')}</button>` : ''}</div>${libBlocks(body)}${proto ? `<div class="lb-code mono">${libInline(proto.x)}</div>` : ''}</div>`;
  });
  return html;
}
function libCost(blocks){
  let tiles = '', foot = '';
  libSplit(blocks).forEach(({h, b})=>{
    if(!h){ b.forEach(x=>{ if(/^Pricing updated/i.test(x.x||'')) foot = x.x; else tiles += `<p>${libInline(x.x||'')}</p>`; }); return; }
    const last = b[b.length-1]; if(last && /^Pricing updated/i.test(last.x||'')){ foot = last.x; b = b.slice(0,-1); }
    tiles += `<div class="lb-cost"><span class="lb-label">${esc(h)}</span>${libBlocks(b)}</div>`;
  });
  return tiles + (foot ? `<div class="lb-foot">${esc(foot)}</div>` : '');
}
function libSideEffects(blocks){
  let html = '';
  libSplit(blocks).forEach(({h, b})=>{
    if(h && /^Double-check/i.test(h)) return;
    if(!h){ html += libClamp(libBlocks(b), libTxtLen(b)); return; }
    if(/Common Issues/i.test(h)){
      html += `<div class="lb-label lb-label-ic" style="color:${libC('amber')}">${libIc('alert')}Common issues &amp; what to do</div><div class="lb-acc">${b.map(x=>{
        const m = /^([^:]{3,70}):\s+(.+)$/.exec(x.x||'');
        return m ? `<details><summary>${libInline(m[1])}</summary><p>${libInline(m[2])}</p></details>` : `<p>${libInline(x.x||'')}</p>`;
      }).join('')}</div>`;
      return;
    }
    html += `<span class="lb-label">${esc(h)}</span>${libBlocks(b, {ic:'alert', c:'amber'})}`;
  });
  return html;
}
function libQuality(blocks){
  let risk = '', i = 0;
  const m = blocks[0] && /Product Quality\s+(low|medium|moderate|high)\s+risk/i.exec(blocks[0].x||'');
  if(m){ risk = m[1].toLowerCase(); i = 1; }
  const rc = {low:'green', medium:'amber', moderate:'amber', high:'red'}[risk];
  return `${risk ? `<div class="lb-row">${libPill(`${risk[0].toUpperCase()+risk.slice(1)} quality risk`, rc, 'shield')}</div>` : ''}${libBlocks(blocks.slice(i), {ic:'check', c:'blue'})}`;
}
function libMonitoring(blocks){
  const rows = blocks.filter(b=> b.t==='row').map(b=> b.c);
  if(rows.length < 2) return libBlocks(blocks);
  const head = rows.shift().map(h=> h.toLowerCase());
  const col = k=> head.indexOf(k);
  const cells = new Set(rows.flat().map(c=> c.trim()));
  const extra = blocks.filter(b=> b.t!=='row' && !cells.has((b.x||'').trim()));
  return rows.map(r0=>{
    const g = k=> col(k) >= 0 ? r0[col(k)] || '' : '';
    return `<div class="lb-mon"><strong>${libInline(r0[0])}</strong>
      ${g('when') ? `<div class="lb-mon-k" style="--c:${libC('pink')}">${libIc('clock')}<span>${libInline(g('when'))}</span></div>` : ''}
      ${g('target') ? `<div class="lb-mon-k" style="--c:${libC('green')}">${libIc('target')}<span>${libInline(g('target'))}</span></div>` : ''}
      ${g('why') ? `<p>${libInline(g('why'))}</p>` : ''}</div>`;
  }).join('') + libBlocks(extra);
}
// A first-order decay curve: how much of a dose is left after 1, 2, 3 and 4 half-lives
function libDecaySVG(hl){
  const W = 320, H = 150, L = 34, R = 10, T = 12, B = 26, span = 4;
  const x = t=> L + (W-L-R)*t/span, y = f=> T + (H-T-B)*(1-f);
  let d = ''; for(let k=0;k<=80;k++){ const t = span*k/80; d += `${k?'L':'M'}${x(t).toFixed(1)} ${y(Math.pow(.5,t)).toFixed(1)}`; }
  const grid = [0,.25,.5,.75,1].map(f=> `<line x1="${L}" x2="${W-R}" y1="${y(f)}" y2="${y(f)}" class="lb-grid"/><text x="${L-6}" y="${y(f)+3.5}" text-anchor="end">${f*100}%</text>`).join('');
  const ticks = [0,1,2,3,4].map(t=> `<text x="${x(t)}" y="${H-8}" text-anchor="middle">${t ? fmtHours(hl*t) : '0'}</text>`).join('');
  const pts = [1,2,3].map(t=> `<circle cx="${x(t)}" cy="${y(Math.pow(.5,t))}" r="4" class="lb-pt"/><text x="${x(t)+6}" y="${y(Math.pow(.5,t))-7}" class="lb-pt-t">${[50,25,12.5][t-1]}%</text>`).join('');
  return `<svg class="lb-decay" viewBox="0 0 ${W} ${H}" role="img" aria-label="Amount remaining over four half-lives">${grid}<path d="${d} L${x(span)} ${y(0)} L${x(0)} ${y(0)} Z" class="lb-area"/><path d="${d}" class="lb-curve"/>${pts}${ticks}</svg>`;
}
function libPK(blocks, rec){
  const conf = blocks.find(b=> b.t==='kv' && /confidence/i.test(b.k));
  const rest = blocks.filter(b=> b!==conf);
  const cc = conf ? ({low:'red', moderate:'amber', medium:'amber', high:'green'}[conf.v.toLowerCase()] || 'grey') : null;
  const hl = num(rec.hlHours, 0);
  return `${conf ? `<div class="lb-row">${libPill(`${conf.v[0].toUpperCase()+conf.v.slice(1)} data confidence`, cc, 'flask')}</div>` : ''}
    ${hl > 0 ? `<div class="lb-chart"><div class="lb-chart-h"><strong>How much is left</strong><span>t½ ${esc(fmtHours(hl))}</span></div>${libDecaySVG(hl)}<div class="lb-foot">Simple first-order decay from the half-life. Real levels vary with route, dose and the person.</div></div>` : ''}
    ${libBlocks(rest)}`;
}
function libLegal(blocks){
  return blocks.map(b=>{
    const m = /^Evidence grade:\s*(.+)$/i.exec(b.x||'');
    return m ? `<div class="lb-row">${libPill('Evidence', 'indigo', 'flask')}<span class="lb-inline">${libInline(m[1])}</span></div>` : libBlocks([b]);
  }).join('');
}
const LIB_KIND = {Safety:'red', Regulatory:'blue', Evidence:'purple', Dosing:'orange', Committee:'indigo', Trial:'teal', Correction:'grey'};
function libUpdates(blocks){
  return `<ol class="lb-tl">${blocks.map(b=>{
    const m = /^(\w+) ([A-Z][a-z]{2} \d{1,2}, \d{4})(?: Effective [A-Z][a-z]{2} \d{1,2}, \d{4})? (.+)$/.exec(b.x||'');
    if(!m) return `<li><p>${libInline(b.x||'')}</p></li>`;
    const c = LIB_KIND[m[1]] || 'grey';
    // keep the source link but drop the "Saved copy / Archived snapshot" extras
    const [txt, src] = m[3].split(/ Source: /);
    const body = libInline(txt).replace(/(What this does not mean:|Before:|After:)/g, '<br><b>$1</b>');
    const s0 = src ? libInline(src.replace(/\s*·\s*\[?(Saved copy|Archived snapshot)(\]\([^)]*\))?/g, '').replace(/\s*·\s*Reported by .*$/, '')) : '';
    return `<li style="--c:${libC(c)}"><div class="lb-tl-h">${libPill(m[1], c)}<span>${esc(m[2])}</span></div><p>${body}</p>${s0 ? `<span class="lb-tl-src">Source: ${s0}</span>` : ''}</li>`;
  }).join('')}</ol>`;
}
function libStorage(blocks){
  const ic = k=> /before/i.test(k) ? 'vial' : /after/i.test(k) ? 'drop' : /temp/i.test(k) ? 'snow' : 'clock';
  const kv = blocks.filter(b=> b.t==='kv');
  return `<div class="lb-store">${kv.map(b=> `<div class="lb-store-r" style="--c:${libC('cyan')}">${libIc(ic(b.k))}<div><span>${esc(b.k)}</span><strong>${libInline(b.v)}</strong></div></div>`).join('')}</div>${libBlocks(blocks.filter(b=> b.t!=='kv'))}`;
}
function libProtocolsHTML(protos, sel){
  const p = protos[sel] || protos[0];
  const src = {'community-consensus':['Community','orange','users'], 'fda-label':['FDA label','green','shield'], 'clinical-trial':['Clinical trial','blue','flask']}[p.source] || [p.source,'grey',''];
  const phases = (p.phases||[]).map(ph=>{
    const off = /^0\b|none/i.test(String(ph.dose||'')) || /off/i.test(ph.name||'');
    const units = String(ph.syringeUnits||'').split('|').map(s=> s.trim()).filter(Boolean);
    return `<li class="${off?'off':''}"><div class="lb-ph-wk mono">Wk ${esc(ph.weeks||'')}</div><div class="lb-ph-b">
      <span class="lb-ph-n">${esc(ph.name||'')}</span>
      ${off ? `<div class="lb-ph-d">Off</div>` : `<div class="lb-ph-d"><strong class="mono">${esc(ph.dose||'')}</strong>${ph.frequency ? ` · ${esc(ph.frequency)}` : ''}</div>`}
      ${ph.route && !off ? `<div class="lb-ph-m">${esc(ph.route)}</div>` : ''}
      ${units.length ? `<div class="lb-ph-u mono">${units.map(u=> `<span>${esc(u)}</span>`).join('')}</div>` : ''}
      ${ph.timing ? `<div class="lb-ph-m">${libIc('clock')}${esc(ph.timing)}</div>` : ''}
      ${ph.notes ? `<p>${libInline(ph.notes)}</p>` : ''}</div></li>`;
  }).join('');
  return `<div class="lib-goals">${protos.map((x,i)=> `<button type="button" data-goal="${i}" class="${i===sel?'on':''}">${esc(x.goal)}</button>`).join('')}</div>
    <div class="lb-row">${p.level ? libPill(p.level[0].toUpperCase()+p.level.slice(1), LIB_LEVEL[p.level]||'grey') : ''}${libPill(src[0], src[1], src[2])}${p.duration ? libPill(p.duration.split(/;\s*/)[0], 'grey', 'clock') : ''}</div>
    <ol class="lb-phases">${phases}</ol>
    ${p.expected ? `<div class="lb-box" style="--c:${libC('green')}"><span class="lb-label" style="color:${libC('green')}">What to expect</span><p>${libInline(p.expected)}</p></div>` : ''}
    ${p.monitoringNotes ? `<div class="lb-box" style="--c:${libC('pink')}"><span class="lb-label" style="color:${libC('pink')}">Monitoring</span><p>${libInline(p.monitoringNotes)}</p></div>` : ''}
    ${p.notes ? `<p>${libInline(p.notes)}</p>` : ''}`;
}
async function renderPeptidePage(){
  const el = $('#pepPage'); if(!el) return;
  await loadLibIndex();
  const e = libIndex.find(x=> x.s===libSlug);
  if(!e){ el.innerHTML = `<p class="footnote lib-none">Peptide not found.</p>`; return; }
  if(!libPages.has(libSlug)) el.innerHTML = `<p class="footnote lib-none">Loading ${esc(e.n)}…</p>`;
  const rec = await loadLibPage(libSlug);
  if(!rec || libSlug!==e.s){ if(!rec) el.innerHTML = `<p class="footnote lib-none">This page isn't available offline yet. Connect once to download it.</p>`; return; }
  const f = rec.facts || {}, mine = libMine(e), col = libColor(rec.category);
  const notes = rec.notes || [];
  // sections in reading order, with Protocols by goal right after the dosage guide and FAQ/References last
  const secs = (rec.sections || []).map((x,i)=> ({id:'s'+i, title:x.title, b:x.b}));
  const di = secs.findIndex(x=> x.title==='Dosage Guide');
  if(rec.protocols && rec.protocols.length) secs.splice(di >= 0 ? di+1 : secs.length, 0, {id:'goals', title:'Protocols by goal'});
  if(rec.faqs && rec.faqs.length) secs.push({id:'faq', title:'FAQ'});
  if(rec.references && rec.references.length) secs.push({id:'refs', title:'References'});
  const facts = [['Starting dose', f.Dose || f.tier, 'syringe', 'orange'], ['Half-life', f.hl, 'clock', 'purple'], ['Vial sizes', f['Vial sizes'], 'vial', 'blue'], ['BAC water', f['BAC water'], 'drop', 'cyan']].filter(x=> x[1]);
  const grade = f.grade ? f.grade[0] : '';
  const body = s=>{
    if(s.id==='goals') return `<div id="ppGoals">${libProtocolsHTML(rec.protocols, 0)}</div>`;
    if(s.id==='faq') return `<div class="lb-acc">${rec.faqs.map(q=> `<details><summary>${libInline(q.q)}</summary><p>${libInline(q.a)}</p></details>`).join('')}</div>`;
    if(s.id==='refs') return `<ol class="lb-refs ${rec.references.length > 6 ? 'short' : ''}">${rec.references.map((x,i)=>{ const u = safeUrl(x.url), host = u ? (/pubmed|ncbi/.test(u) ? 'PubMed' : /fda\.gov/.test(u) ? 'FDA' : /doi\.org/.test(u) ? 'DOI' : /clinicaltrials/.test(u) ? 'ClinicalTrials.gov' : '') : '';
      return `<li id="ref${i+1}"><span class="lb-ref-n mono">${i+1}</span><div><a href="${esc(u)}" target="_blank" rel="noopener">${esc(x.title || x.url)}</a>${host ? `<span class="lb-tag">${host}</span>` : ''}</div></li>`; }).join('')}</ol>${rec.references.length > 6 ? `<button type="button" class="lb-more" data-refs>Show all ${rec.references.length}</button>` : ''}`;
    return libSection(s.title, s.b.slice(), rec);
  };
  // the page is split into four tabs so each screen stays short; anything unexpected lands in Science
  const tabOf = t=> LIB_TABS.find(x=> x[4].includes(t)) || LIB_TABS[3];
  const secHTML = s=>{
    const [ic, c] = LIB_SEC[s.title] || ['info', 'grey'];
    const ns = notes.filter(n=> n.section===s.title).map(n=> `<div class="lib-note">${libIc('note')}<div><b>Pep Prep note</b> ${libInline(n.text)}</div></div>`).join('');
    return `<section class="card lb-sec" id="${s.id}" style="--c:${libC(c)}"><h3 class="lb-sec-h"><span class="lb-sec-ic">${libIc(ic)}</span>${esc(s.title==='References' ? `References (${rec.references.length})` : s.title)}</h3><div class="lb-body">${ns}${body(s)}</div></section>`;
  };
  const glance = rec.summary || f.tier || (rec.tags||[]).length ? `<section class="card lb-sec lb-glance" style="--c:${libC('blue')}">
      ${rec.summary ? libClamp(`<p class="lb-lead">${libInline(rec.summary)}</p>`, rec.summary.length) : ''}
      ${f.tier ? `<div class="lb-hero-tier">${libIc('syringe')}<span><b>Beginner tier</b> ${esc(f.tier)}</span></div>` : ''}
      ${(rec.tags||[]).length ? `<div class="lb-tags">${rec.tags.map(t=> `<span><i style="background:${col}"></i>${esc(t)}</span>`).join('')}</div>` : ''}
    </section>` : '';
  const related = rec.related && rec.related.length ? `<section class="card lb-sec" style="--c:${libC('grey')}"><h3 class="lb-sec-h"><span class="lb-sec-ic">${libIc('layers')}</span>Related peptides</h3><div class="lb-rel">${rec.related.map(s0=>{ const r0 = libIndex.find(x=> x.s===s0); return r0 ? `<button type="button" data-lib="${esc(s0)}">${libMolecule(libColor(r0.c), 30)}<span><strong>${esc(r0.n)}</strong><small>${esc(r0.c||'')}</small></span>${libIc('chev')}</button>` : ''; }).join('')}</div></section>` : '';
  const verdict = f['Science vs community'];
  const mineLine = [mine.count ? `${mine.count} vial${mine.count===1?'':'s'} in your stash` : '', ...mine.protos.map(p=> `${p.compound} ${fmtDose(doseAt(p, doseDayISO()).dose, doseAt(p, doseDayISO()).doseUnit)}${p.status==='paused' ? ' (paused)' : ''}`)].filter(Boolean).join(' · ');
  if(!LIB_TABS.some(t=> t[0]===libTab)) libTab = 'overview';
  el.innerHTML = `
    <div class="card lb-hero" style="--lc:${col}">
      <div class="lb-hero-top">${libMolecule(col, 46)}<div class="lb-hero-t">${rec.category ? `<span class="lb-pill lb-cat" style="--c:${col}"><i></i>${esc(rec.category)}</span>` : ''}${rec.status ? libPill(rec.status, LIB_STATUS[rec.status]||'grey', rec.status==='FDA Approved' ? 'shield' : 'flask') : ''}${grade ? libPill(`Grade ${f.grade}`, LIB_GRADE[grade]||'grey') : ''}${verdict ? libPill(verdict, LIB_VERDICT[verdict.toLowerCase()]||'grey', 'scale') : ''}</div></div>
      ${rec.aliases && rec.aliases.filter(a=> a!==rec.name).length ? `<div class="lb-aka"><b>Also known as</b> ${esc(rec.aliases.filter(a=> a!==rec.name).slice(0,6).join(', '))}</div>` : ''}
      ${facts.length ? `<div class="lb-facts">${facts.map(([k,v,ic,c])=> `<div class="lb-fact" style="--c:${libC(c)}"><span>${libIc(ic)}${esc(k)}</span><strong class="mono">${esc(v)}</strong></div>`).join('')}</div>` : ''}
      <div class="lb-yours"><div class="lb-yours-t">${libIc('vial')}<span>${mineLine ? esc(mineLine) : `Not in your stash or protocols yet`}</span></div>
        <div class="pp-actions"><button type="button" class="btn btn-accent-pep btn-sm" id="ppStart">+ Start a protocol</button><button type="button" class="btn btn-sm" id="ppCalc">Calculator</button>${mine.count ? `<button type="button" class="btn btn-sm" id="ppStash">Show in stash</button>` : ''}</div></div>
    </div>
    <nav class="lb-tabs" role="tablist" aria-label="Peptide sections">${LIB_TABS.map(([k,n,ic,c])=> `<button type="button" role="tab" data-ltab="${k}" aria-selected="${k===libTab}" class="${k===libTab?'on':''}" style="--c:${libC(c)}">${libIc(ic)}<span>${n}</span></button>`).join('')}</nav>
    <div class="lb-panes">${LIB_TABS.map(([k], ti)=>{
      const mine = secs.filter(s=> tabOf(s.title)[0]===k);
      const next = LIB_TABS[(ti+1) % LIB_TABS.length];
      return `<div class="lb-pane" data-lpane="${k}" ${k===libTab?'':'hidden'}>${k==='overview' ? glance : ''}${mine.map(secHTML).join('')}${k==='overview' ? related : ''}
        <button type="button" class="lb-next" data-ltab="${next[0]}" style="--c:${libC(next[3])}">${ti===LIB_TABS.length-1 ? 'Back to' : 'Next:'} <b>${next[1]}</b> ${libIc('chev')}</button></div>`;
    }).join('')}</div>
    <p class="lib-src">From <a href="${esc(rec.source)}" target="_blank" rel="noopener">Peptide Schedule</a>, used with permission${rec.reviewed ? ` · reviewed ${esc(fmtDate(rec.reviewed))}` : ''}${rec.references ? ` · ${rec.references.length} references` : ''}.<br>For research and education, not medical advice.</p>`;
  // actions
  $('#ppStart',el).addEventListener('click', ()=>{
    const m = /([\d.]+)\s*(mcg|mg)/i.exec(f.tier || f.Dose || ''), freq = String(f.tier || f.Dose || '').toLowerCase();
    const fd = /week/.test(freq) ? (/2x|twice/.test(freq) ? '3.5' : '7') : /every other|eod/.test(freq) ? '2' : '1';
    openProtocolModal(null, {compound: rec.name, dose: m ? m[1] : '', doseUnit: m ? m[2].toLowerCase() : 'mg', frequencyDays: fd,
      dosesPerDay: /2x daily|twice daily/.test(freq) ? 2 : 1, halfLifeHours: defaultHalfLife(rec.name) ? '' : (rec.hlHours ? String(rec.hlHours) : ''), startDate: todayISO(), nextDose: todayISO(), status:'active'});
  });
  $('#ppCalc',el).addEventListener('click', ()=> setTab('tools'));
  const st = $('#ppStash',el); if(st) st.addEventListener('click', ()=>{ const v = mine.vials[0]; stashSel = v ? v.compound : null; lotSel = null; setTab('inventory'); renderVials(); });
  const goals = $('#ppGoals',el);
  if(goals) goals.addEventListener('click', ev=>{ const b = ev.target.closest('[data-goal]'); if(!b) return; goals.innerHTML = libProtocolsHTML(rec.protocols, +b.dataset.goal); haptic('light'); });
  const bar = $('.lb-tabs', el);
  // switching tabs keeps the tab bar where it is and starts the new tab at its top
  const show = (k, dir)=>{
    if(k===libTab) return;
    libTab = k;
    $$('[data-ltab]', bar).forEach(b=>{ b.classList.toggle('on', b.dataset.ltab===k); b.setAttribute('aria-selected', b.dataset.ltab===k); });
    $$('.lb-pane', el).forEach(p=>{ const on = p.dataset.lpane===k; p.hidden = !on; if(on && dir){ p.classList.remove('in-l','in-r'); void p.offsetWidth; p.classList.add(dir > 0 ? 'in-r' : 'in-l'); } });
    const top = parseFloat(getComputedStyle(bar).top) || 0;
    if(bar.getBoundingClientRect().top <= top + 1) window.scrollTo({top: bar.getBoundingClientRect().top + window.scrollY - top});
    haptic('select');
  };
  const idx = k=> LIB_TABS.findIndex(t=> t[0]===k);
  el.onclick = ev=>{
    const t = ev.target.closest('[data-ltab]');
    if(t){ show(t.dataset.ltab, idx(t.dataset.ltab) > idx(libTab) ? 1 : -1); return; }
    const mo = ev.target.closest('[data-more]');
    if(mo){ const c = mo.previousElementSibling; const open = c.classList.toggle('open'); mo.textContent = open ? 'Show less' : 'Read more'; return; }
    const rf = ev.target.closest('[data-refs]');
    if(rf){ const l = $('.lb-refs', el); l.classList.remove('short'); rf.remove(); return; }
    const lb = ev.target.closest('[data-lib]');
    if(lb){ libTab = 'overview'; openPeptide(lb.dataset.lib); window.scrollTo(0,0); return; }
    const c = ev.target.closest('[data-cite]'); if(!c) return;
    const l = $('.lb-refs', el); if(!l) return; l.classList.remove('short'); const rb = $('[data-refs]', el); if(rb) rb.remove();
    show(tabOf('References')[0], 1);
    const li = $('#ref'+c.dataset.cite, el); if(li){ li.scrollIntoView({behavior:'smooth', block:'center'}); li.classList.add('flash'); setTimeout(()=> li.classList.remove('flash'), 1600); }
  };
  // swipe left or right on the content to move between tabs (rows that scroll sideways keep their own swipe)
  const panes = $('.lb-panes', el); let sx = null, sy = 0;
  panes.addEventListener('touchstart', e=>{ sx = e.target.closest('.lib-goals, .lib-tbl') ? null : e.touches[0].clientX; sy = e.touches[0].clientY; }, {passive:true});
  panes.addEventListener('touchend', e=>{
    if(sx==null) return; const dx = e.changedTouches[0].clientX - sx, dy = e.changedTouches[0].clientY - sy; sx = null;
    if(Math.abs(dx) < 70 || Math.abs(dy) > Math.abs(dx)*0.6) return;
    const i = idx(libTab) + (dx < 0 ? 1 : -1);
    if(i >= 0 && i < LIB_TABS.length) show(LIB_TABS[i][0], dx < 0 ? 1 : -1);
  }, {passive:true});
}
function initLibrary(){
  const si = $('#libSearch'); if(!si) return;
  si.addEventListener('input', ()=>{ libQuery = si.value; renderLibrary(); });
  $('#libCats').addEventListener('click', e=>{ const b = e.target.closest('[data-lib-cat]'); if(!b) return; libCat = b.dataset.libCat; renderLibrary(); });
  $('#libList').addEventListener('click', e=>{ const b = e.target.closest('[data-lib]'); if(b) openPeptide(b.dataset.lib); });
  // half-lives from the library fill gaps in the serum chart once the list has loaded
  loadLibIndex().then(()=>{ if(state.protocols.some(p=> !halfLifeOf(p) || (blendParts(p)||[]).some(c=> !c.hl))) renderAll(); });
}

/* ===================== Navigation (bottom tab bar) ===================== */
const TABS = {dose:'#doseView', inventory:'#inventoryView', ask:'#askView', progress:'#progressView', tools:'#pepCalcView', endo:'#endoView', settings:'#settingsView', resources:'#resourcesView', library:'#libraryView', peptide:'#peptideView', more:'#moreView'};
/* iOS-style navigation: each screen has a large title, an optional subtitle and round glass buttons in the top corner.
   Tools and Resources live under More, so they show a back button and keep More highlighted. */
const NAV_ICONS = {
  plus:'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>',
  scan:'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 8V5.5A1.5 1.5 0 015.5 4H8M16 4h2.5A1.5 1.5 0 0120 5.5V8M20 16v2.5a1.5 1.5 0 01-1.5 1.5H16M8 20H5.5A1.5 1.5 0 014 18.5V16M7 12h10"/></svg>',
  search:'<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="M15.5 15.5L20 20"/></svg>',
  reset:'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12a8 8 0 1 0 2.4-5.7"/><path d="M4 4v4.5h4.5"/></svg>',
};
const TAB_META = {
  dose:{title:'Today', sub:()=>{ const d = new Date().toLocaleDateString(undefined,{weekday:'long', month:'long', day:'numeric'}); const l = ($('#doseTodayLabel')||{}).textContent||''; return l ? `${d} · ${l}` : d; }},
  inventory:{title:'Stash', sub:()=>{ const live = state.vials.filter(v=>!isDepleted(v)); const kinds = new Set(live.map(v=> (v.compound||'').trim().toLowerCase())).size;
    const n = live.reduce((t,v)=> t + num(v.qty,1) + (v.remainingMg!=null?1:0), 0); return live.length ? `${kinds} peptide${kinds===1?'':'s'} · ${n} vial${n===1?'':'s'}` : ''; },
    actions:[['scan','#scanVialBtn','Scan a vial'],['plus','#addVialBtn','Add vial'],['search','#stashSearchBtn','Search your stash']], noSync:true},
  ask:{title:'Claude', sub:()=> 'Ask about your protocols and data'},
  progress:{title:'Progress'},
  more:{title:'More'},
  tools:{title:'Calculator', back:'more', actions:[['reset','#calcReset','Reset calculator']]},
  endo:{title:'Endotoxin check', back:'more'},
  settings:{title:'Settings', back:'more'},
  resources:{title:'Resources', back:'more'},
  library:{title:'Library', sub:()=> libIndex ? `${libIndex.length} peptides · from Peptide Schedule` : ''},
  peptide:{title:'Peptide', back:'library'},
};
function updateNav(){
  const m = TAB_META[currentTab] || {title:''};
  $('#iosTitle').textContent = m.title; $('#iosTitle').classList.toggle('long', m.title.length > 11); $('#iosBarTitle').textContent = m.title;
  const sub = m.sub ? m.sub() : ''; $('#iosSub').textContent = sub; $('#iosSub').hidden = !sub;
  $('#navBack').hidden = !m.back;
  $('#syncPill').hidden = !!m.noSync;                     // the Stash puts its search button in the backup button's corner
  // proxy buttons: the real buttons stay in the page (hidden), so their existing handlers keep working
  $('#navActions').innerHTML = (m.actions||[]).filter(([,sel])=>{ const b = $(sel); return b && !(sel==='#scanVialBtn' && b.hidden); })
    .map(([ic,sel,label])=> `<button type="button" class="glass-btn" data-proxy="${sel}" aria-label="${esc(label)}">${NAV_ICONS[ic]}</button>`).join('');
  const sb = $('#moreBackupSub'); if(sb){ const last = lsGet('ledger.lastBackup',''); sb.textContent = last ? `Last backup ${fmtDateShort(last)}` : 'No backup yet'; }
}
let iosBarOn = false;
function updateIosBar(){
  const on = window.scrollY > 52;
  if(on!==iosBarOn){ iosBarOn = on; $('#iosBar').classList.toggle('on', on); }
}
let currentTab = 'dose';
function setTab(name, opts){
  // Protocols used to be its own tab; it now sits at the bottom of Today
  if(name==='protocols'){ setTab('dose', opts); const b = $('#protocolsBlock'); if(b) setTimeout(()=> b.scrollIntoView({behavior:'smooth', block:'start'}), 60); return; }
  if(!TABS[name]) name = 'dose';
  const prevTab = currentTab;
  currentTab = name;
  Object.entries(TABS).forEach(([k,sel])=>{ $(sel).hidden = k!==name; });
  let hl = name; while(TAB_META[hl] && TAB_META[hl].back) hl = TAB_META[hl].back;
  $$('.tabbar [data-tab], .claude-orb').forEach(b=>{ const on = b.dataset.tab===hl; b.classList.toggle('active', on); b.setAttribute('aria-current', on ? 'page' : 'false'); });
  updateNav();
  animateView(prevTab, name);
  lsSet('ledger.tab', name);
  if(name==='tools') runCalc();          // redraw the syringe now that it has a width
  if(name==='endo') runEndo();
  if(name==='settings'){ showAppVersion(); renderInstallCard(); renderThemeSeg(); }
  if(name==='library') renderLibrary().then(updateNav);
  if(name==='progress') renderProgress();
  if(name==='ask') renderAsk();
  if(!(opts && opts.keepScroll)) window.scrollTo(0,0);
  updateIosBar();
}
function initTabs(){
  $$('.tabbar [data-tab], .claude-orb').forEach(b=> b.addEventListener('click', ()=>{ haptic('select'); setTab(b.dataset.tab); }));
  $$('#moreView [data-goto]').forEach(b=> b.addEventListener('click', ()=> setTab(b.dataset.goto)));
  $('#moreBackup').addEventListener('click', ()=> openBackupModal());
  $('#moreWhatsNew').addEventListener('click', ()=> openWhatsNew(true));
  $('#navBack').addEventListener('click', ()=> setTab(TAB_META[currentTab].back || 'dose'));
  $('#navActions').addEventListener('click', e=>{ const b = e.target.closest('[data-proxy]'); if(b){ const real = $(b.dataset.proxy); if(real) real.click(); } });
  window.addEventListener('scroll', updateIosBar, {passive:true});
  $('#iosBar').addEventListener('click', ()=> window.scrollTo({top:0, behavior:'smooth'}));
}

/* ===================== Backup, restore, install ===================== */
function hasAnyData(){ return COLLECTIONS.some(k=> state[k].length); }
function renderBackupNudge(){
  const el = $('#backupNudge'); if(!el) return;
  const last = lsGet('ledger.lastBackup','');
  const stale = !last || daysBetween(last, todayISO()) >= 14;
  const snoozed = lsGet('ledger.nudgeSnooze','') === todayISO();
  // iPhone app with weekly automatic backups: back up now if one is due, and only nag if that fails
  if(IS_NATIVE && capPlugin('ICloudBackup') && nativeOn('autoBackup','1')){
    if(hasAnyData() && daysBetween(lsGet('ledger.autoBackupDate','2000-01-01'), todayISO()) >= 7) autoBackup(false);
    el.hidden = !(lsGet('ledger.autoBackupFailed','')==='1' && hasAnyData() && !snoozed);
    $('#backupNudgeText').textContent = 'The automatic backup to iCloud Drive didn\'t work. Back up by hand for now.';
    return;
  }
  el.hidden = !(hasAnyData() && stale && !snoozed && storageMode!=='memory');
  $('#backupNudgeText').textContent = last ? `Last backup ${fmtDate(last)}. Your data lives only on this device.` : 'No backup yet. Your data lives only on this device.';
}
function blobToDataURL(b){ return new Promise((res,rej)=>{ const r = new FileReader(); r.onload = ()=> res(r.result); r.onerror = ()=> rej(r.error); r.readAsDataURL(b); }); }
async function buildBackupPayload(){
  const blobs = {};
  for(const k of await allBlobKeys()){ const b = await getBlob(k); if(b) blobs[k] = await blobToDataURL(b); }
  const payload = {app:'peptide-ledger', format:1, exportedAt:new Date().toISOString(), collections:{}, blobs,
    settings:{weightUnit: weightUnit(), endoWeight: lsGet('ledger.endoWeight',''), urineStrip: lsGet('ledger.urineStrip','10')}};
  COLLECTIONS.forEach(k=> payload.collections[k] = state[k]);
  return payload;
}
async function exportBackup(){
  const payload = await buildBackupPayload();
  const name = `pep-prep-backup-${todayISO()}.json`;
  const file = new File([JSON.stringify(payload)], name, {type:'application/json'});
  const touch = matchMedia('(pointer: coarse)').matches;
  let done = false;
  if(IS_NATIVE){
    const r = await nativeShareFile(name, JSON.stringify(payload), 'Pep Prep backup');
    if(r==='cancel') return false;
    done = !!r;
  }
  if(!done && touch && navigator.canShare && navigator.canShare({files:[file]})){
    try{ await navigator.share({files:[file], title:'Pep Prep backup'}); done = true; }
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
  try{ data = JSON.parse(await file.text()); }catch(e){ throw new Error('That file isn\'t a Pep Prep backup.'); }
  if(!data || data.app!=='peptide-ledger' || !data.collections) throw new Error('That file isn\'t a Pep Prep backup.');
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
  // retired sections (supplies, labs, urine) only show if old records are still stored
  const counts = [['protocols','protocol'],['vials','vial'],['checkins','check-in'],['photos','photo'],['vendors','vendor'],['supplies','supply','supplies'],['labs','lab draw'],['urine','urine strip']]
    .filter(([k], i)=> i<5 || state[k].length)
    .map(([k,one,many])=>{ const n = state[k].length; return `<span class="pill pill-muted">${n} ${n===1 ? one : (many || one+'s')}</span>`; }).join('');
  const auto = IS_NATIVE && capPlugin('ICloudBackup') && nativeOn('autoBackup','1');
  const autoLast = lsGet('ledger.autoBackupDate',''), autoLocal = lsGet('ledger.autoBackupWhere','')==='local', autoWhere = autoLocal ? 'Files › On My iPhone › Pep Prep' : 'iCloud Drive › Pep Prep';
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
    <p style="font-size:14px;margin-bottom:8px;">${auto
      ? `Your data lives in this app on this phone. Nothing is sent to a server. A backup is saved automatically every week to <strong>${esc(autoWhere)}</strong> (the last 8 are kept)${autoLocal ? '. iCloud Drive looked switched off, so it stays on this phone: turn on iCloud Drive in Settings so it survives a lost phone.' : ', so it survives a lost phone or a deleted app.'}`
      : 'Everything you enter is saved only in this app on this device. Nothing is sent to a server. A backup file is the only copy that survives a lost phone, a deleted app or cleared browser data.'}</p>
    <div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px;">${counts}</div>
    <p class="footnote">${auto ? (autoLast ? `Last automatic backup: ${fmtDate(autoLast)}.` : 'The first automatic backup runs shortly.') : (last?`Last backup: ${fmtDate(last)}.`:'No backup yet.')} ${esc(usage)}</p>
    <div class="backup-actions">
      <button class="btn btn-accent-pep" id="bkExport">⬇ Export backup file</button>
      <label class="btn" for="bkFile" style="margin:0;color:var(--ink);font-size:13.5px;">⬆ Restore from file</label>
      <input type="file" id="bkFile" accept="application/json,.json" hidden>
    </div>
    <p class="footnote" style="margin-top:8px;">${auto ? 'Export saves an extra copy anywhere you like through the share sheet. To restore, pick a backup file, including one from iCloud Drive › Pep Prep.' : 'On iPhone, Export opens the share sheet. Choose "Save to Files" (iCloud Drive works well).'} Restoring replaces everything currently in the app.</p>
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
      try{ const ok = await exportBackup(); st.textContent = ok ? `Backup created: pep-prep-backup-${todayISO()}.json` : 'Export cancelled.'; }
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
      confirmAction('Erase all Pep Prep data from this device? This cannot be undone.', eraseAll, 'Erase everything');
    });
  });
}
/* ===== Appearance: Automatic (follows iOS), Light or Dark. Stored per device in ledger.theme. ===== */
function themePref(){ const t = lsGet('ledger.theme','auto'); return t==='light' || t==='dark' ? t : 'auto'; }
function isDark(){ const t = themePref(); return t==='dark' || (t==='auto' && matchMedia('(prefers-color-scheme: dark)').matches); }
function applyTheme(){
  const t = themePref();
  if(t==='auto') document.documentElement.removeAttribute('data-theme'); else document.documentElement.setAttribute('data-theme', t);
  const dark = isDark();
  document.documentElement.classList.toggle('dark', dark);
  const meta = document.querySelector('meta[name="theme-color"]'); if(meta) meta.setAttribute('content', dark ? '#000000' : '#f4f4f7');
}
function renderThemeSeg(){
  const t = themePref();
  $$('[data-theme-set]').forEach(b=>{ const on = b.dataset.themeSet===t; b.classList.toggle('on', on); b.setAttribute('aria-checked', String(on)); });
}
applyTheme();
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', ()=>{ applyTheme(); if(typeof renderAll==='function') renderAll(); });
document.addEventListener('click', e=>{
  const b = e.target.closest('[data-theme-set]'); if(!b) return;
  lsSet('ledger.theme', b.dataset.themeSet); applyTheme(); renderThemeSeg(); renderAll(); haptic('select');
});
let deferredInstall = null;
function isStandalone(){ return matchMedia('(display-mode: standalone)').matches || navigator.standalone===true; }
function renderInstallCard(){
  const el = $('#installInfo'); if(!el) return;
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform==='MacIntel' && navigator.maxTouchPoints>1);
  if(IS_NATIVE){ el.innerHTML = nativeSettingsHTML(); bindNativeSettings(el); return; }
  if(isStandalone()){ el.innerHTML = `<p class="footnote">Installed. You're running Pep Prep as an app.</p>`; return; }
  if(deferredInstall){ el.innerHTML = `<button class="btn btn-accent-pep btn-sm" id="installBtn">Install app</button>`; $('#installBtn').addEventListener('click', async ()=>{ deferredInstall.prompt(); await deferredInstall.userChoice.catch(()=>{}); deferredInstall = null; renderInstallCard(); }); return; }
  el.innerHTML = ios
    ? `<p class="footnote">In Safari, tap the Share button, then <strong>Add to Home Screen</strong>. Open the app from its icon so your data stays in one place.</p>`
    : `<p class="footnote">In Chrome, open the ⋮ menu and choose <strong>Install app</strong> or <strong>Add to Home screen</strong>.</p>`;
}
function showAppVersion(){
  const el = $('#appVersion'); if(!el) return;
  if(!('caches' in window)){ if(IS_NATIVE) el.textContent = `App version ${window.PEP_NATIVE_VERSION||''} · iPhone app`; return; }
  caches.keys().then(keys=>{
    const k = keys.filter(x=> x.startsWith('ledger-shell-')).sort().pop();
    el.textContent = k ? `App version ${k.replace('ledger-shell-','')}${IS_NATIVE?' · iPhone app':''}` : '';
  }).catch(()=>{});
}
function registerServiceWorker(){
  if(!('serviceWorker' in navigator) || location.protocol==='file:' || location.protocol==='capacitor:') return;
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

/* ===================== iPhone app (Capacitor build in native/) =====================
   The iPhone app loads this same site, so everything here runs only when IS_NATIVE and the plugin is in the
   installed build (an older build simply skips features it doesn't have). Settings live in localStorage:
   ledger.reminders, ledger.autoBackup, ledger.health ('1' = on). */
const capPlugin = name=>{
  if(!IS_NATIVE || !window.Capacitor.Plugins) return null;
  if(window.Capacitor.isPluginAvailable && !window.Capacitor.isPluginAvailable(name)) return null;
  return window.Capacitor.Plugins[name] || null;
};
const nativeOn = (key, dflt)=> lsGet('ledger.'+key, dflt)==='1';
let resolveDataReady; const dataReady = new Promise(r=> resolveDataReady = r);
function haptic(kind){
  const H = capPlugin('Haptics'); if(!H) return;
  try{
    if(kind==='success') H.notification({type:'SUCCESS'});
    else if(kind==='buzz') H.vibrate({duration: 120});
    else H.impact({style: kind==='medium' ? 'MEDIUM' : 'LIGHT'});   // 'select' and 'light': a light tap
  }catch(e){}
}
function nowHHMM(){ const d = new Date(); return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`; }

/* ---- Dose reminders: local notifications with "Log it" and "Snooze 15 min" buttons ---- */
const remindersOn = ()=> nativeOn('reminders','1');
let reminderTimer = null;
function reminderList(){
  const now = Date.now(), until = now + 14*24*HOUR, list = [];
  state.protocols.filter(isActiveP).forEach(p=>{
    scheduledEvents(p, now, until).forEach(e=>{
      const iso = isoFromDate(new Date(e.t - 2*HOUR));
      if(injectionsOn(p, iso) >= splitCount(p)) return;      // already logged for that dose day
      const d = doseAt(p, iso), u = unitsPerInjection(p, iso);
      list.push({t:e.t, pid:p.id, iso, title:`${p.compound||'Dose'} is due`, body:`${fmtDose(num(d.dose)/splitCount(p), d.doseUnit)}${u!=null?` · ${u} units`:''}`});
    });
  });
  return list.sort((a,b)=> a.t-b.t);
}
function scheduleDoseReminders(){
  const LN = capPlugin('LocalNotifications'); if(!LN) return;
  clearTimeout(reminderTimer);
  reminderTimer = setTimeout(async ()=>{
    try{
      const pending = await LN.getPending();
      const ours = (pending && pending.notifications || []).filter(n=> n.id>=1000 && n.id<2000);
      if(ours.length) await LN.cancel({notifications: ours.map(n=>({id:n.id}))});
      if(!remindersOn()) return;
      const perm = await LN.checkPermissions();
      if(perm.display!=='granted') return;
      // iOS keeps at most 64 pending notifications per app; leave room for snoozes
      const notifications = reminderList().slice(0, 56).map((x,i)=>({id: 1000+i, title:x.title, body:x.body,
        schedule:{at:new Date(x.t), allowWhileIdle:true}, actionTypeId:'DOSE', extra:{pid:x.pid, iso:x.iso}}));
      if(notifications.length) await LN.schedule({notifications});
    }catch(e){ console.warn('Reminder scheduling failed', e); }
  }, 800);
}
async function initNotificationActions(){
  const LN = capPlugin('LocalNotifications'); if(!LN) return;
  try{
    await LN.registerActionTypes({types:[{id:'DOSE', actions:[
      {id:'log', title:'Log it', foreground:true},
      {id:'snooze', title:'Snooze 15 min', foreground:true}]}]});
    LN.addListener('localNotificationActionPerformed', async ev=>{
      await dataReady;
      const n = ev.notification || {}, x = n.extra || {};
      const p = state.protocols.find(q=> q.id===x.pid);
      if(ev.actionId==='snooze'){
        await LN.schedule({notifications:[{id: 2000 + Math.floor(Math.random()*900), title:n.title, body:n.body,
          schedule:{at:new Date(Date.now()+15*60000), allowWhileIdle:true}, actionTypeId:'DOSE', extra:x}]});
        showToast('Snoozed for 15 minutes');
        return;
      }
      if(!p) return;
      setTab('dose');
      if(ev.actionId==='log'){
        const day = x.iso || doseDayISO();
        if(injectionsOn(p, day) < splitCount(p)){ await logInjection(p, day, 1, nowHHMM()); showToast(`Logged ${p.compound||'dose'}`); maybeCelebrate(); }
        else showToast(`${p.compound||'That dose'} is already logged`);
      } else openDoseModal(p);
    });
  }catch(e){ console.warn('Notification actions unavailable', e); }
}
async function setRemindersOn(on){
  lsSet('ledger.reminders', on ? '1' : '0');
  const LN = capPlugin('LocalNotifications');
  if(on && LN){ try{ const r = await LN.requestPermissions(); if(r.display!=='granted') lsSet('ledger.reminders','0'); }catch(e){} }
  renderInstallCard(); scheduleDoseReminders();
}

/* ---- Files: share sheet, and weekly automatic backups to iCloud Drive (Files > iCloud Drive > Pep Prep) ---- */
async function nativeShareFile(name, text, title){
  const FS = capPlugin('Filesystem'), SH = capPlugin('Share');
  if(!FS || !SH) return false;
  const w = await FS.writeFile({path:name, data:text, directory:'CACHE', encoding:'utf8'});
  try{ await SH.share({title, url:w.uri, dialogTitle:title}); }catch(e){ if(!/cancel/i.test(String(e && e.message))) throw e; return 'cancel'; }
  return true;
}
let autoBackupBusy = false;
async function autoBackup(force){
  const IB = capPlugin('ICloudBackup'); if(!IB || autoBackupBusy) return null;
  if(!force && (!nativeOn('autoBackup','1') || daysBetween(lsGet('ledger.autoBackupDate','2000-01-01'), todayISO()) < 7)) return null;
  if(!force && !(state.protocols.length || state.vials.length || state.checkins.length)) return null;   // nothing worth saving yet
  autoBackupBusy = true;
  try{
    const r = await IB.save({name:`pep-prep-auto-${todayISO()}.json`, text: JSON.stringify(await buildBackupPayload())});
    lsSet('ledger.autoBackupDate', todayISO()); lsSet('ledger.autoBackupWhere', r.location||''); lsSet('ledger.autoBackupFailed', '');
    lsSet('ledger.lastBackup', todayISO());
    return r;
  }catch(e){ console.warn('Automatic backup failed', e); lsSet('ledger.autoBackupFailed', '1'); return null; }
  finally{ autoBackupBusy = false; renderBackupNudge(); renderInstallCard(); }
}

/* ---- Apple Health: logged weights go to Health; weigh-ins from a scale come back as check-ins ---- */
async function setHealthOn(on){
  const HL = capPlugin('Health');
  if(on && HL){
    try{
      const a = await HL.isAvailable();
      if(a && a.available===false){ showToast('Apple Health isn\'t available on this phone'); on = false; }
      else await HL.requestAuthorization({read:['weight'], write:['weight']});
    }catch(e){ on = false; showToast('Couldn\'t connect to Apple Health'); }
  }
  lsSet('ledger.health', on ? '1' : '0');
  renderInstallCard();
  if(on) importHealthWeights(true);
}
async function exportWeightToHealth(date, lb){
  const HL = capPlugin('Health'); if(!HL || !nativeOn('health','0')) return;
  try{
    const at = date===todayISO() ? new Date() : new Date(date+'T08:00:00');
    await HL.saveSample({dataType:'weight', value: Math.round(lb*0.45359237*100)/100, unit:'kilogram', startDate: at.toISOString(), endDate: at.toISOString()});
  }catch(e){ console.warn('Health save failed', e); }
}
async function importHealthWeights(force){
  const HL = capPlugin('Health'); if(!HL || !nativeOn('health','0')) return;
  if(!force && lsGet('ledger.healthImport','')===todayISO()) return;
  try{
    const {samples} = await HL.readSamples({dataType:'weight', startDate: new Date(Date.now()-90*24*HOUR).toISOString(), endDate: new Date().toISOString(), limit: 500});
    const byDay = new Map();
    (samples||[]).forEach(s=>{
      if(/pep prep/i.test(s.sourceName||'')) return;          // our own entries
      const day = isoFromDate(new Date(s.startDate));
      const prev = byDay.get(day);
      if(!prev || s.startDate > prev.startDate) byDay.set(day, s);
    });
    let added = 0;
    for(const [day, s] of byDay){
      if(checkinFor(day)) continue;                             // never overwrite a weight you logged
      const kg = s.unit==='pound' ? s.value*0.45359237 : s.value;
      await dbAdd('checkins', {date: day, weight: Math.round(kg/0.45359237*10)/10, weightUnit:'lb', source:'health'});
      added++;
    }
    lsSet('ledger.healthImport', todayISO());
    if(added){ showToast(`Added ${added} weigh-in${added===1?'':'s'} from Apple Health`); if(currentTab==='progress') renderProgress(); }
  }catch(e){ console.warn('Health import failed', e); }
}

/* ---- Calendar: the next 8 weeks of doses as calendar events (replaced each time) ---- */
async function syncDoseCalendar(){
  const CAL = capPlugin('CapacitorCalendar'); if(!CAL) return;
  const st = $('#calSyncStatus');
  try{
    const r = await CAL.requestFullCalendarAccess();
    if(r && r.result && r.result!=='granted'){ if(st) st.textContent = 'Calendar access was not allowed. You can allow it in Settings › Pep Prep.'; return; }
    const old = (()=>{ try{ return JSON.parse(lsGet('ledger.calEvents','[]'))||[]; }catch(e){ return []; } })();
    for(const id of old){ try{ await CAL.deleteEvent({id}); }catch(e){} }
    const now = Date.now(), until = now + 56*24*HOUR, ids = [];
    const evs = [];
    state.protocols.filter(isActiveP).forEach(p=>{
      scheduledEvents(p, now, until).forEach(e=>{
        const iso = isoFromDate(new Date(e.t - 2*HOUR)), d = doseAt(p, iso), u = unitsPerInjection(p, iso);
        evs.push({t:e.t, title:`💉 ${p.compound||'Dose'} ${fmtDose(num(d.dose)/splitCount(p), d.doseUnit)}${u!=null?` (${u}u)`:''}`});
      });
    });
    for(const e of evs.slice(0, 200)){
      const res = await CAL.createEvent({title:e.title, startDate:e.t, endDate:e.t + 15*60000, description:'Added by Pep Prep'});
      if(res && res.id) ids.push(res.id);
    }
    lsSet('ledger.calEvents', JSON.stringify(ids)); lsSet('ledger.calSyncDate', todayISO());
    if(st) st.textContent = `Added ${ids.length} dose${ids.length===1?'':'s'} through ${fmtDateShort(isoFromDate(new Date(until)))}. Tap again after schedule changes.`;
    haptic('success');
  }catch(e){ console.warn('Calendar sync failed', e); if(st) st.textContent = 'Couldn\'t update the calendar.'; }
}

/* ---- Barcode scanning (vial labels, lot numbers) ---- */
async function scanCode(){
  const BS = capPlugin('CapacitorBarcodeScanner'); if(!BS) return null;
  // The raw native plugin (no npm wrapper here) needs every field: iOS rejects the call as "invalid parameters" without
  // scanText, cameraDirection (1 = back) and scanOrientation (1 = portrait).
  try{ const r = await BS.scanBarcode({hint:17, scanInstructions:'Point at the vial\'s barcode or QR code', scanButton:false, scanText:' ', cameraDirection:1, scanOrientation:1}); return r && r.ScanResult ? String(r.ScanResult).trim() : null; }
  catch(e){
    const code = String((e && e.code) || '');
    if(!/0006$/.test(code)) showToast(/0007$/.test(code) ? 'Camera access is off for Pep Prep. Turn it on in Settings › Pep Prep.' : 'Couldn\'t start the scanner. Try again.');
    return null;
  }
}
async function scanFindVial(){
  const code = await scanCode(); if(!code) return;
  const key = code.toLowerCase();
  const v = state.vials.find(x=> !isDepleted(x) && ((x.barcode||'').toLowerCase()===key || (x.lot||'').trim().toLowerCase()===key))
    || state.vials.find(x=> (x.barcode||'').toLowerCase()===key || (x.lot||'').trim().toLowerCase()===key);
  if(v && !isDepleted(v)){
    stashSel = v.compound || 'Vial'; lotSel = v.id; renderVials(); haptic('success');
    const el = $('.lot-card'); if(el) el.scrollIntoView({behavior:'smooth', block:'center'});
    return;
  }
  showToast(`New code ${code}: add it as a vial`);
  openVialModal(null, {barcode: code});
}

/* ---- Small toast for confirmations ---- */
function showToast(text){
  let t = $('#toast');
  if(!t){ t = document.createElement('div'); t.id = 'toast'; t.className = 'toast'; t.setAttribute('role','status'); document.body.appendChild(t); }
  t.textContent = text; t.classList.add('on');
  clearTimeout(t._h); t._h = setTimeout(()=> t.classList.remove('on'), 2600);
}

/* Settings shown in Tools › App & backup inside the iPhone app. */
function nativeSettingsHTML(){
  const has = n=> !!capPlugin(n);
  const where = lsGet('ledger.autoBackupWhere','')==='icloud' ? 'iCloud Drive › Pep Prep' : 'Files › On My iPhone › Pep Prep';
  const last = lsGet('ledger.autoBackupDate','');
  return `<p class="footnote">You're using the Pep Prep iPhone app.</p>
    <div class="nat-set">
      ${has('LocalNotifications') ? `<label class="pc-toggle"><input type="checkbox" id="remindToggle" ${remindersOn()?'checked':''}><span>Dose reminders at each dose time</span></label>` : ''}
      ${has('ICloudBackup') ? `<label class="pc-toggle"><input type="checkbox" id="autoBackupToggle" ${nativeOn('autoBackup','1')?'checked':''}><span>Weekly automatic backup</span></label>
        <div class="footnote nat-sub">${last ? `Last: ${esc(fmtDateShort(last))} in ${esc(where)}` : 'Saved to iCloud Drive › Pep Prep (keeps the last 8).'} <button type="button" class="link-btn" id="autoBackupNow">Back up now</button></div>` : ''}
      ${has('Health') ? `<label class="pc-toggle"><input type="checkbox" id="healthToggle" ${nativeOn('health','0')?'checked':''}><span>Sync weight with Apple Health</span></label>` : ''}
      ${has('Haptics') ? `<div class="nat-row hap-test"><span>Test vibration</span><button type="button" class="btn btn-sm" data-hap="light">Tick</button><button type="button" class="btn btn-sm" data-hap="success">Success</button><button type="button" class="btn btn-sm" data-hap="buzz">Buzz</button></div>
        <div class="footnote nat-sub">If Tick and Success do nothing but Buzz works, turn on Settings › Sounds &amp; Haptics › System Haptics.</div>` : ''}
      ${has('CapacitorCalendar') ? `<div class="nat-row"><button type="button" class="btn btn-sm" id="calSyncBtn">Add doses to Calendar</button></div><div class="footnote nat-sub" id="calSyncStatus">${lsGet('ledger.calSyncDate','') ? `Last added ${esc(fmtDateShort(lsGet('ledger.calSyncDate','')))}.` : 'Puts the next 8 weeks of doses in your calendar.'}</div>` : ''}
    </div>`;
}
function bindNativeSettings(el){
  const on = (id, fn)=>{ const x = $('#'+id, el); if(x) x.addEventListener(x.type==='checkbox' ? 'change' : 'click', fn); };
  on('remindToggle', e=> setRemindersOn(e.target.checked));
  on('autoBackupToggle', e=>{ lsSet('ledger.autoBackup', e.target.checked ? '1' : '0'); });
  on('autoBackupNow', async e=>{ e.target.disabled = true; const r = await autoBackup(true); showToast(r ? `Backed up to ${r.location==='icloud' ? 'iCloud Drive' : 'Files'}` : 'Backup failed'); renderInstallCard(); });
  on('healthToggle', e=> setHealthOn(e.target.checked));
  on('calSyncBtn', ()=> syncDoseCalendar());
  $$('[data-hap]', el).forEach(b=> b.addEventListener('click', ()=> haptic(b.dataset.hap)));
}
/* Runs once the data is loaded, and again each time the app comes back to the front. */
function nativeOnForeground(){
  if(!IS_NATIVE) return;
  autoBackup(false);
  importHealthWeights(false);
  scheduleDoseReminders();
}

/* ===================== Today: streak, this week, insights, celebration ===================== */
/* A day counts toward the streak when every dose scheduled that day was logged; days with nothing scheduled
   are skipped (they neither add to nor break the streak). Today counts once it is complete. */
function dayStatus(iso){
  const rows = dosesOnDay(iso);
  if(!rows.length) return 'none';
  if(rows.some(r=> r.kind==='missed')) return 'missed';
  if(rows.some(r=> r.kind==='due')) return 'open';
  return 'done';
}
/* Streak: consecutive scheduled days with at least one dose logged (split doses don't all have to be in).
   Today only adds to it once something is logged; it never breaks the streak while the day is still open. */
function doseStreak(){
  const today = doseDayISO();
  const took = iso=> dosesOnDay(iso).some(r=> r.kind==='taken');
  let n = took(today) ? 1 : 0, iso = addDays(today, -1);
  for(let i=0; i<400; i++, iso = addDays(iso, -1)){
    const rows = dosesOnDay(iso);
    if(!rows.length) continue;
    if(rows.some(r=> r.kind==='taken')) n++; else break;
  }
  return n;
}
function weekStats(){
  const today = doseDayISO();
  let taken = 0, missed = 0, due = 0;
  for(let i=0;i<7;i++){
    dosesOnDay(addDays(today, -i)).forEach(r=>{ if(r.kind==='taken') taken++; else if(r.kind==='missed') missed++; else due++; });
  }
  const pct = taken+missed ? Math.round(taken/(taken+missed)*100) : null;
  // weight change over the last 7 days: latest weigh-in vs the one closest to 7 days before it
  const ws = state.checkins.filter(c=> num(c.weight,null)!=null).map(c=>({d:c.date, w:toUnit(c.weight, c.weightUnit||'lb', 'lb')})).sort((a,b)=> a.d.localeCompare(b.d));
  let wChange = null;
  if(ws.length>=2){
    const last = ws[ws.length-1], target = addDays(last.d, -7);
    const prev = ws.filter(x=> x.d <= target).pop() || (daysBetween(ws[0].d, last.d) >= 3 ? ws[0] : null);
    if(prev && prev!==last) wChange = Math.round((last.w - prev.w)*10)/10;
  }
  return {taken, missed, due, pct, wChange};
}
function todayInsights(){
  const out = [], today = doseDayISO();
  const fmtDay = iso=> new Date(iso+'T00:00:00').toLocaleDateString(undefined,{weekday:'short'});
  state.protocols.filter(isActiveP).forEach(p=>{
    const v = state.vials.find(x=> x.id===p.activeVialId);
    if(!v || v.remainingMg==null) return;
    const d = doseAt(p, today), mg = doseToMg(d.dose, d.doseUnit), f = effectiveFreqDays(p);
    if(!mg || !f) return;
    const days = Math.floor(num(v.remainingMg,0)/mg * f);
    const sealed = state.vials.filter(x=> !isDepleted(x) && (x.compound||'').trim().toLowerCase()===(p.compound||'').trim().toLowerCase()).reduce((s,x)=> s+num(x.qty,0), 0);
    if(days <= 7) out.push({ic:'vial', tone: days<=2 ? 'warn' : 'pep',
      t: days<=0 ? `${p.compound} vial is about empty` : `${p.compound} vial runs out in ~${days} day${days===1?'':'s'} (${fmtDay(addDays(today, days))})`,
      s: sealed>0 ? `${sealed} sealed vial${sealed===1?'':'s'} ready to open` : 'No sealed vials left: time to reorder'});
  });
  state.vials.filter(v=> !isDepleted(v) && v.remainingMg!=null && v.bud).forEach(v=>{
    const left = daysBetween(today, v.bud);
    if(left>=0 && left<=5) out.push({ic:'clock', tone:'warn', t:`${v.compound} passes its beyond-use date ${left===0?'today':`in ${left} day${left===1?'':'s'}`}`, s:`Use by ${fmtDateShort(v.bud)}`});
  });
  // usual injection time, from logged times
  const timed = state.protocols.filter(isActiveP).map(p=>({p, ts:(Array.isArray(p.doseTimes)?p.doseTimes:[]).slice(-14).map(x=> new Date(x.t))})).filter(x=> x.ts.length>=5)
    .sort((a,b)=> b.ts.length-a.ts.length)[0];
  if(timed){
    const mins = timed.ts.map(d=> d.getHours()*60+d.getMinutes()).sort((a,b)=>a-b), m = mins[Math.floor(mins.length/2)];
    const hhmm = `${String(Math.floor(m/60)).padStart(2,'0')}:${String(Math.round(m%60/5)*5%60).padStart(2,'0')}`;
    out.push({ic:'time', tone:'info', t:`You usually take ${timed.p.compound} around ${fmtClock(hhmm)}`, s:`Based on your last ${timed.ts.length} logged doses`});
  }
  // weight since the earliest active protocol started
  const starts = state.protocols.filter(isActiveP).filter(p=> p.startDate).sort((a,b)=> a.startDate.localeCompare(b.startDate));
  const ws = state.checkins.filter(c=> num(c.weight,null)!=null).sort((a,b)=> a.date.localeCompare(b.date));
  if(starts.length && ws.length>=2){
    const p = starts[0], base = ws.filter(c=> c.date <= p.startDate).pop() || ws.find(c=> c.date >= p.startDate), last = ws[ws.length-1];
    if(base && last && base!==last){
      const diff = Math.round((toUnit(last.weight,last.weightUnit||'lb','lb') - toUnit(base.weight,base.weightUnit||'lb','lb'))*10)/10;
      if(Math.abs(diff) >= 0.5) out.push({ic:'trend', tone: diff<0 ? 'good' : 'info', t:`${diff<0?'Down':'Up'} ${Math.abs(diff)} lb since starting ${p.compound}`, s:`${fmtDateShort(base.date)} → ${fmtDateShort(last.date)}`});
    }
  }
  return out.slice(0, 4);
}
const INSIGHT_ICONS = {
  vial:'<path d="M9 3h6M10 3v4.5L6.5 18a2 2 0 001.9 2.7h7.2a2 2 0 001.9-2.7L14 7.5V3"/><path d="M7.5 14h9"/>',
  clock:'<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  time:'<path d="M12 3a9 9 0 100 18 9 9 0 000-18z"/><path d="M12 7v5l3.5 2"/>',
  trend:'<path d="M3 17l6-6 4 4 8-8"/><path d="M15 7h6v6"/>',
};
function renderTodaySummary(){
  const el = $('#todaySummary'); if(!el) return;
  if(!state.protocols.some(isActiveP)){ el.innerHTML = ''; el.hidden = true; return; }
  el.hidden = false;
  const streak = doseStreak(), w = weekStats(), ins = todayInsights();
  const ring = w.pct==null ? '' : `<svg class="wk-ring" viewBox="0 0 44 44" aria-hidden="true"><circle cx="22" cy="22" r="18" class="bg"/><circle cx="22" cy="22" r="18" class="fg" style="stroke-dasharray:${(w.pct/100*113.1).toFixed(1)} 113.1"/></svg>`;
  el.innerHTML = `<div class="card-block-head"><div class="card-h"><h3>This week</h3>${streak>=2 ? `<span class="streak-chip">🔥 ${streak}-day streak</span>` : ''}</div></div>
    <div class="card wk-card">
      <div class="wk-grid">
        <div class="wk-stat">${ring}<div><strong>${w.pct==null?'—':w.pct+'%'}</strong><span>on schedule</span></div></div>
        <div class="wk-stat"><div><strong>${w.taken}</strong><span>doses logged</span></div></div>
        <div class="wk-stat"><div><strong>${streak}</strong><span>day streak</span></div></div>
        <div class="wk-stat"><div><strong class="${w.wChange<0?'good':''}">${w.wChange==null?'—':(w.wChange>0?'+':'')+w.wChange+' lb'}</strong><span>weight, 7 days</span></div></div>
      </div>
      ${ins.length ? `<div class="insights">${ins.map(x=>`<div class="insight ${x.tone}"><span class="ins-ic"><svg viewBox="0 0 24 24" aria-hidden="true">${INSIGHT_ICONS[x.ic]}</svg></span><div><strong>${esc(x.t)}</strong><small>${esc(x.s)}</small></div></div>`).join('')}</div>` : ''}
    </div>`;
}
/* Confetti and a done ring the first time all of today's doses are logged. */
function maybeCelebrate(){
  const today = doseDayISO();
  if(dayStatus(today)!=='done' || lsGet('ledger.celebrated','')===today) return;
  lsSet('ledger.celebrated', today);
  haptic('success');
  const streak = doseStreak();
  const layer = document.createElement('div'); layer.className = 'celebrate'; layer.setAttribute('aria-hidden','true');
  const colors = ['#ff8a1e','#ffb469','#5aa9ff','#34c759','#ff375f','#ffd60a','#a78bfa'];
  let bits = '';
  for(let i=0;i<70;i++){
    const x = (Math.random()*2-1)*190, y = -(160 + Math.random()*260), r = Math.random()*720-360, d = .9 + Math.random()*.7;
    bits += `<i style="--x:${x.toFixed(0)}px;--y:${y.toFixed(0)}px;--r:${r.toFixed(0)}deg;--d:${d.toFixed(2)}s;background:${colors[i%colors.length]};${i%3?'':'border-radius:50%;'}"></i>`;
  }
  layer.innerHTML = `<div class="cel-burst">${bits}</div>
    <div class="cel-card"><svg viewBox="0 0 64 64" aria-hidden="true"><circle cx="32" cy="32" r="27" class="bg"/><circle cx="32" cy="32" r="27" class="fg"/><path d="M21 33l7.5 7.5L44 25" class="ck"/></svg>
      <strong>All done for today</strong><span>${streak>=2 ? `🔥 ${streak}-day streak` : 'Nice work. See you tomorrow.'}</span></div>`;
  document.body.appendChild(layer);
  layer.addEventListener('click', ()=> layer.remove());
  setTimeout(()=> layer.classList.add('out'), 2300);
  setTimeout(()=> layer.remove(), 2800);
}

/* ===================== Launch animation, screen transitions, What's new ===================== */
const APP_VERSION = '1.52.0';
const WHATS_NEW = [
  {v:'1.52.0', title:'Change any dose', items:[
    ['💉','When you log a dose, set the units or the amount (mg or mcg). Change one and the other follows, and the new amount becomes your protocol\'s dose from then on.'],
    ['✏️','Tap a logged dose in the Doses list to change its amount or time, or delete it. Editing your latest dose updates the protocol too.'],
    ['📈','Each dose keeps the amount you actually took, so changing your dose never rewrites past doses, the serum chart or what\'s left in the vial.'],
  ]},
  {v:'1.51.0', title:'A new tab bar', items:[
    ['📋','Protocols now live at the bottom of Today, with Add protocol and your past protocols right there.'],
    ['📚','The Peptide library has its own Library tab, between Progress and More.'],
  ]},
  {v:'1.50.0', title:'A roomier library', items:[
    ['🗂️','Peptide pages are split into four tabs (Overview, Dosing, Safety and Science) that stay pinned at the top. Tap one, or swipe left and right to move between them.'],
    ['🌿','More breathing room everywhere: a slimmer header with your stash and protocol buttons built in, wider spacing, and a Next button at the end of each tab.'],
    ['📋','The library list is simpler: each peptide shows its name, category and safety grade, and you can still search by alias.'],
  ]},
  {v:'1.49.0', title:'Two new COA finishes', items:[
    ['🪩','Pearl Chrome: polished silver with a soft pastel rainbow sheen that drifts as you tilt.'],
    ['🌈','Soft Prism: the full rainbow Prism foil with gentler, wider light rays.'],
  ]},
  {v:'1.48.0', title:'Choose your COA finish', items:[
    ['🃏','Six card finishes to pick from at the top of any certificate: Aurora, Prism, Galaxy, Chrome, Gold and Crystal.'],
    ['✨','They range from full rainbow foil and starfields to polished metal and clear glass. Your pick is remembered and the small COA cards on your stash match it.'],
  ]},
  {v:'1.47.0', title:'Holographic COAs', items:[
    ['✨','Certificates of analysis are now holographic cards: a rainbow foil, sparkles and a glare that move as the card gently sways.'],
    ['📱','Tilt your phone or drag across the card to catch the light. The first tap asks for motion access so the card can follow your phone.'],
    ['🏅','Cards where every test conforms get an "All clear" holo seal. The small COA on each lot is a mini foil card too.'],
  ]},
  {v:'1.46.0', title:'A more colourful library', items:[
    ['🧭','Peptide pages have a section bar that follows you down the page and lights up the section you\'re reading. Tap any chip to jump there.'],
    ['🎨','Every section has its own colour and icon: green checks for benefits, red for contraindications, amber for side effects and interactions.'],
    ['💉','Dose tiers show as a table with green, amber and red dots. Protocols by goal, how-to steps, stacks and monitoring are laid out as cards.'],
    ['📈','A half-life chart shows how much of a dose is left over time, and recent updates appear as a colour-coded timeline.'],
  ]},
  {v:'1.45.1', title:'Clearer filter math', items:[
    ['🧮','Calculator: with a syringe filter, the summary now shows the water to add, what stays in the filter and exactly what you end up with (mL and mg).'],
  ]},
  {v:'1.45.0', title:'Peptide library', items:[
    ['📚','More › Peptide library: 150 peptides from PeptideSchedule, searchable by name or alias, with dosing by goal, half-life, safety, FAQs and references.'],
    ['🧪','Each page shows your own vials and protocols for that peptide, plus a button to start a protocol from it.'],
    ['📝','Where we found something worth flagging, a Pep Prep note sits right in the section.'],
  ]},
  {v:'1.44.0', title:'A more realistic site map', items:[
    ['📍','The injection site map now shows a realistic front view, with grids on your lower abdomen (belly-button height down, out to the hips) and the front of your thighs.'],
  ]},
  {v:'1.43.0', title:'A new injection site map', items:[
    ['📍','An illustrated body with grids over your injection areas. Tap the exact square you used.'],
    ['🔴','Past injections show as red dots that fade over three weeks, so you can see where to rotate next.'],
  ]},
  {v:'1.42.0', title:'Confirm before logging', items:[
    ['✅','The ✓ beside a pen now opens a quick check: adjust the units (your protocol updates to match), set the time and tap where you injected, then log.'],
    ['✏️','Protocols: Dose has an mg/mcg switch, with Units right below it. Fill in either one and the other follows.'],
  ]},
  {v:'1.41.0', title:'Dark mode', items:[
    ['🌙','Pep Prep now has a dark theme. It follows your iPhone automatically, or pick Light or Dark in More › Settings.'],
  ]},
  {v:'1.40.0', title:'A tidier, clearer app', items:[
    ['📋','Protocols show a vial, your next dose and titration progress at a glance.'],
    ['📈','Progress opens with your total change and a trend line; Stash shows monthly spend as a chart.'],
    ['💬','Past Claude chats are grouped by date with previews and a search. Swipe a chat left to delete it.'],
    ['⚙️','More now has Calculator, Endotoxin check and Settings as separate pages.'],
  ]},
  {v:'1.39.0', title:'Mix your own blends', items:[
    ['⚗️','Stash › + › Mix a blend: combine sealed vials (e.g. KPV + GHK-Cu) into one vial. Your sealed counts drop automatically.'],
    ['🔗','The mixed vial links to its protocol, every dose comes off it, and Finish mixes the next batch.'],
  ]},
  {v:'1.37.0', title:'A swipeable stash', items:[
    ['🧪','Your vials now float in a single row, three at a time. Swipe left or right to see the rest.'],
  ]},
  {v:'1.36.0', title:'A real photo album', items:[
    ['🖼️','Tap a progress photo and swipe through them all, with a thumbnail strip to jump around.'],
    ['⚖️','Add your weight to a photo. Each photo shows its weight and the change since your first.'],
    ['🤳','The front camera opens in a wide view, like the zoomed-out selfie in the Camera app.'],
  ]},
  {v:'1.34.0', title:'Streaks, insights and a little celebration', items:[
    ['🔥','Streaks and a weekly summary on Today: how often you hit your schedule, doses logged and weight change.'],
    ['💡','Smart insights: when a vial will run out, beyond-use dates coming up, your usual dose time, and weight since you started.'],
    ['🎉','Log the last dose of the day and get a small celebration.'],
    ['✨','A launch animation and smooth transitions between screens.'],
  ]},
  {v:'1.32.0', title:'The Liquid Glass redesign', items:[
    ['📱','Large titles, a floating glass tab bar and Claude as its own button.'],
    ['✅','One-tap logging with the round button beside each pen.'],
    ['🧪','Stash as glass tiles with search.'],
  ]},
];
function openWhatsNew(all){
  const list = all ? WHATS_NEW : WHATS_NEW.slice(0,1);
  openModal("What's new", `${list.map((r,i)=>`<div class="wn-block">
      ${i===0 && !all ? `<div class="wn-hero"><img src="icons/icon-192.png" alt="" width="72" height="72"><div class="wn-ver">Version ${esc(r.v)}</div><h2>${esc(r.title)}</h2></div>` : `<h4 class="wn-h">${esc(r.v)} · ${esc(r.title)}</h4>`}
      ${r.items.map(([ic,t])=>`<div class="wn-item"><span>${ic}</span><p>${esc(t)}</p></div>`).join('')}</div>`).join('')}
    <button type="button" class="btn btn-accent-pep wn-go" id="wnGo">Continue</button>`, body=>{
    $('#wnGo',body).addEventListener('click', closeModal);
  });
}
function maybeShowWhatsNew(){
  const seen = lsGet('ledger.seenVersion','');
  lsSet('ledger.seenVersion', APP_VERSION);
  // only after an update, never on a first install with no data
  if(seen===APP_VERSION || (!seen && !hasAnyData())) return;
  if(WHATS_NEW[0].v!==APP_VERSION) return;
  setTimeout(()=> openWhatsNew(false), 900);
}
function hideLaunch(){
  const l = $('#launch'); if(!l) return;
  const wait = Math.max(0, 650 - (performance.now() - (window.__launchT||0)));
  setTimeout(()=>{ l.classList.add('out'); setTimeout(()=> l.remove(), 520); }, wait);
}
const TAB_ORDER = ['dose','inventory','progress','library','more','tools','resources','ask'];
function animateView(prev, next){
  const el = $(TABS[next]); if(!el || prev===next || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const dir = TAB_ORDER.indexOf(next) >= TAB_ORDER.indexOf(prev) ? 1 : -1;
  el.style.setProperty('--dir', dir);
  el.classList.remove('view-in'); void el.offsetWidth; el.classList.add('view-in');
  setTimeout(()=> el.classList.remove('view-in'), 400);
}

/* ===================== Render all ===================== */
function renderAll(){
  renderProtocols();
  renderDoseCalendar();
  renderProtocolManager();
  renderSerum();
  renderArchivedProtocols();
  renderVials();
  renderVendors();
  renderCostTracking();
  renderResearch();
  if(currentTab==='progress') renderProgress();
  renderBackupNudge();
  scheduleDoseReminders();
  renderTodaySummary();
  updateNav();
}

/* No pinch or double-tap zoom: iOS Safari ignores user-scalable=no, so cancel the gestures directly. */
(function blockZoom(){
  const stop = e=> e.preventDefault();
  ['gesturestart','gesturechange','gestureend'].forEach(ev=> document.addEventListener(ev, stop, {passive:false}));
  document.addEventListener('touchmove', e=>{ if(e.touches.length > 1) e.preventDefault(); }, {passive:false});
  // double-tap zoom is off through touch-action: manipulation in the CSS, which keeps quick repeated taps working
})();

/* ===================== Boot ===================== */
async function boot(){
  runCalc();
  initTabs();
  initAsk();
  initAskChat();
  initLibrary();
  initProgress();
  $('#syncPill').addEventListener('click', openBackupModal);
  $('#backupNudgeBtn').addEventListener('click', openBackupModal);
  $('#backupNudgeDismiss').addEventListener('click', ()=>{ lsSet('ledger.nudgeSnooze', todayISO()); renderBackupNudge(); });
  $('#openBackupBtn').addEventListener('click', openBackupModal);
  window.addEventListener('beforeinstallprompt', e=>{ e.preventDefault(); deferredInstall = e; renderInstallCard(); });
  window.addEventListener('appinstalled', ()=>{ deferredInstall = null; renderInstallCard(); });
  renderInstallCard();
  initNotificationActions();
  await loadAll();
  loadCheckinForm($('#ciDate').value || todayISO());   // the form was filled before records loaded
  renderStoragePill();
  setTab('dose', {keepScroll:true});   // the app always opens on Dose
  resolveDataReady();
  hideLaunch();
  maybeShowWhatsNew();
  if(IS_NATIVE && lsGet('ledger.remindAsked','')!=='1' && capPlugin('LocalNotifications')){ lsSet('ledger.remindAsked','1'); setRemindersOn(true); }
  nativeOnForeground();
  const scanBtn = $('#scanVialBtn'); if(scanBtn && capPlugin('CapacitorBarcodeScanner')){ scanBtn.hidden = false; scanBtn.addEventListener('click', scanFindVial); updateNav(); }
  const ss = $('#stashSearch'); if(ss) ss.addEventListener('input', ()=>{ stashSel = null; lotSel = null; renderVials(); });
  // the stash search stays tucked away until its button in the top corner is tapped
  const sRow = $('#stashSearchRow');
  const closeSearch = ()=>{ sRow.hidden = true; if(ss.value){ ss.value = ''; renderVials(); } ss.blur(); };
  $('#stashSearchBtn').addEventListener('click', ()=>{ if(!sRow.hidden && !ss.value) return closeSearch(); sRow.hidden = false; ss.focus(); });
  $('#stashSearchCancel').addEventListener('click', closeSearch);
  ss.addEventListener('keydown', e=>{ if(e.key==='Escape') closeSearch(); });
  ss.addEventListener('blur', ()=>{ if(!ss.value) setTimeout(()=>{ if(document.activeElement!==ss && !ss.value) sRow.hidden = true; }, 150); });
  renderAll();
  registerServiceWorker();
  showAppVersion();
  // Day boundaries: refresh "today" whenever the app comes back to the foreground.
  let lastDay = doseDayISO();
  document.addEventListener('visibilitychange', ()=>{
    if(document.hidden) return;
    if(doseDayISO()!==lastDay){ lastDay = doseDayISO(); $('#ciDate').max = todayISO(); }
    renderAll();
    nativeOnForeground();
  });
}
boot();

})();
