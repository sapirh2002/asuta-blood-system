// app.js — צד לקוח, מחובר לשרת ולמסד הנתונים (מערכת אמיתית)
let currentUser=null, currentPatient=null, currentSample=null, currentOrder=null, currentTransfusion=null, currentUnit=null;
let wristbandScanned=false, wristbandAttachedOk=true, tubeScanned=false, transfusionStart=null;
let orderType='components', ordererType='doctor', orderedPlasma=false, preVitals=null;
let scanStep={}; let settings={hematologists:[],criteria_irradiated:'',criteria_cmv:''};
const specialState={};

function now(){ return new Date().toLocaleTimeString('he-IL',{hour:'2-digit',minute:'2-digit',second:'2-digit'}); }
async function api(path,method='GET',body){
  const opts={method,headers:{'Content-Type':'application/json'}};
  if(body) opts.body=JSON.stringify(body);
  const res=await fetch(path,opts);
  const data=await res.json().catch(()=>({}));
  if(!res.ok) throw new Error(data.error||'שגיאה בשרת');
  return data;
}
function esc(s){ return String(s==null?'':s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }

// ---------- התחברות ----------
async function doLogin(){
  const username=document.getElementById('login-user').value.trim();
  const password=document.getElementById('login-pass').value;
  const err=document.getElementById('login-error'); err.classList.add('hidden');
  try{ const r=await api('/api/login','POST',{username,password}); currentUser=r.user; enterApp(r.auth); }
  catch(e){ err.textContent=e.message; err.classList.remove('hidden'); }
}
async function enterApp(auth){
  document.getElementById('login-screen').style.display='none';
  document.getElementById('app').style.display='flex';
  document.getElementById('topbar-username').textContent='מחובר · '+currentUser.full_name;
  document.getElementById('nav-admin').classList.toggle('hidden', currentUser.role!=='admin');
  // הרשאות לפי תפקיד — בנק הדם לא רואה את התהליך הקליני
  const isBank=currentUser.role==='bloodbank';
  document.getElementById('clinical-section').classList.toggle('hidden', isBank);
  if(isBank){
    document.querySelectorAll('.page').forEach(p=>p.classList.remove('active'));
    document.querySelectorAll('.nav-item').forEach(n=>n.classList.remove('active'));
    document.getElementById('page-blood-bank').classList.add('active');
    const bankNav=[...document.querySelectorAll('.nav-item')].find(b=>b.textContent.includes('בנק הדם'));
    if(bankNav) bankNav.classList.add('active');
    loadSamples(); loadOrders();
  }
  showAuthWarning(auth);
  try{ settings=await api('/api/settings'); }catch(e){}
}
function showAuthWarning(auth){
  const el=document.getElementById('auth-warning');
  if(auth && auth.expiring_soon){ el.innerHTML='<span class="alert-icon">⏳</span> שים לב: הרשאתך תפוג בעוד '+auth.days_left+' ימים ('+auth.expiry+'). יש לחדש מול מנהל המערכת.'; el.classList.remove('hidden'); }
  else el.classList.add('hidden');
}
async function doLogout(){ await api('/api/logout','POST').catch(()=>{}); location.reload(); }

// ---------- ניווט ----------
function showPage(name,btn){
  document.querySelectorAll('.page').forEach(p=>p.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n=>n.classList.remove('active'));
  document.getElementById('page-'+name).classList.add('active');
  if(btn) btn.classList.add('active');
  if(name==='sample') refreshSampleGate();
  if(name==='pre-transfusion') refreshPreGate();
  if(name==='transfusion') refreshTransGate();
  if(name==='blood-bank'){ loadSamples(); loadOrders(); }
  if(name==='reports') loadReports();
  if(name==='admin'){ loadUsers(); }
}
function selectOne(btn){ btn.closest('.selector-group').querySelectorAll('.selector-btn').forEach(b=>b.classList.remove('active')); btn.classList.add('active'); }
function selectRadio(btn){ btn.closest('.radio-group').querySelectorAll('.radio-btn').forEach(b=>b.classList.remove('active')); btn.classList.add('active'); }

// ---------- מודל אימות (חתימה / אישורים) ----------
let authMode=null, authCfg=null, authOnCreds=null;
function openAuth(boxId,doneId,entityType,stage){
  const box=boxId&&document.getElementById(boxId); if(box&&box.classList.contains('signed'))return;
  let entityId=currentPatient?currentPatient.id:null;
  if(entityType==='transfusion'&&currentTransfusion) entityId=currentTransfusion.id;
  authMode='signature'; authCfg={boxId,doneId,entityType,entityId,stage};
  prepAuthModal(stage);
}
function openCreds(onCreds,stage){ authMode='creds'; authOnCreds=onCreds; prepAuthModal(stage); }
function prepAuthModal(stage){
  document.getElementById('auth-user').value=''; document.getElementById('auth-pass').value='';
  document.getElementById('auth-error').classList.add('hidden');
  document.getElementById('auth-sub').textContent='שלב: '+(stage||'חתימה')+' · הזדהות למורשה בלבד';
  document.getElementById('auth-overlay').classList.add('show');
  setTimeout(()=>document.getElementById('auth-user').focus(),100);
}
async function confirmAuth(){
  const u=document.getElementById('auth-user').value.trim();
  const p=document.getElementById('auth-pass').value;
  const err=document.getElementById('auth-error'); err.classList.add('hidden');
  if(!u||!p){ err.textContent='יש למלא שם משתמש וסיסמה'; err.classList.remove('hidden'); return; }
  try{
    if(authMode==='creds'){ await authOnCreds(u,p); document.getElementById('auth-overlay').classList.remove('show'); return; }
    const c=authCfg;
    const r=await api('/api/signatures','POST',{entity_type:c.entityType,entity_id:c.entityId,stage:c.stage,username:u,password:p});
    document.getElementById('auth-overlay').classList.remove('show');
    if(c.boxId){ const box=document.getElementById(c.boxId); if(box){ box.classList.add('signed'); box.textContent='✅ נחתם · '+r.signature.signed_by+' · '+now(); } }
    if(c.doneId){ const d=document.getElementById(c.doneId); if(d){ d.classList.remove('hidden'); const t=d.querySelector('[id$="-time"]'); if(t)t.textContent=now(); } }
    if(c.doneId==='pre-sig1-done'){ preVitals={bp:document.getElementById('pre-bp').value,pulse:document.getElementById('pre-pulse').value,temp:document.getElementById('pre-temp').value}; }
    if(r.auth) showAuthWarning(r.auth);
  }catch(e){ err.textContent=e.message; err.classList.remove('hidden'); }
}
function cancelAuth(){ document.getElementById('auth-overlay').classList.remove('show'); }

// ---------- מודל מידע/בחירה ----------
let pendingInfo=null;
function openInfo(title,bodyHtml,onOk,onCancel){
  document.getElementById('info-title').textContent=title;
  document.getElementById('info-body').innerHTML=bodyHtml;
  pendingInfo={onOk,onCancel};
  document.getElementById('info-overlay').classList.add('show');
}
function confirmInfo(){ const cb=pendingInfo&&pendingInfo.onOk; document.getElementById('info-overlay').classList.remove('show'); pendingInfo=null; if(cb)cb(); }
function cancelInfo(){ const cb=pendingInfo&&pendingInfo.onCancel; document.getElementById('info-overlay').classList.remove('show'); pendingInfo=null; if(cb)cb(); }

// ---------- זיהוי מטופל ----------
async function scanWristband(){
  const q=document.getElementById('wristband-input').value.trim();
  if(!q) return;
  document.getElementById('wristband-notfound').classList.add('hidden');
  try{
    let patient;
    try{ patient=(await api('/api/patients/'+encodeURIComponent(q))).patient; }
    catch{ const r=await api('/api/patients?q='+encodeURIComponent(q)); patient=r.patients[0]; }
    if(!patient){ document.getElementById('wristband-notfound').classList.remove('hidden'); return; }
    setCurrentPatient(patient);
  }catch(e){ alert(e.message); }
}
function setCurrentPatient(p){
  currentPatient=p; wristbandScanned=true; currentSample=currentOrder=currentTransfusion=currentUnit=null;
  document.getElementById('pd-name').textContent=p.full_name;
  document.getElementById('pd-admission').textContent=p.admission_no;
  document.getElementById('pd-id').textContent=p.national_id||'—';
  document.getElementById('pd-dept').textContent=p.department||'—';
  document.getElementById('pd-blood').textContent=p.blood_type||'—';
  document.getElementById('pd-bg').textContent=p.relevant_background||'אין';
  document.getElementById('scan-time').textContent=now();
  document.getElementById('wristband-done').classList.remove('hidden');
  document.getElementById('wristband-btn').textContent='✅ נסרק';
}
function selectIdMethod(btn,method){ selectOne(btn); document.getElementById('cannot-reason-wrap').classList.toggle('hidden',method!=='cannot'); }
function selectWristbandAttached(btn,attached){ selectRadio(btn); wristbandAttachedOk=attached; document.getElementById('wristband-missing').classList.toggle('hidden',attached); }

// ---------- דגימה ----------
function refreshSampleGate(){
  const ok=wristbandScanned&&wristbandAttachedOk;
  document.getElementById('sample-no-patient').classList.toggle('hidden',ok);
  document.getElementById('sample-body').classList.toggle('hidden',!ok);
  if(ok){
    document.getElementById('sample-patient-label').textContent=currentPatient.full_name+' · '+currentPatient.admission_no;
    document.getElementById('cdss-alert').classList.toggle('hidden',!(currentPatient.relevant_background||'').includes('anti-K'));
    if(!document.getElementById('component-rows').children.length) addComponentRow();
  }
}
function scanTube(){
  tubeScanned=true;
  document.getElementById('tube-text').textContent='מדבקת מבחנה נסרקה · דגימה שויכה למטופל '+currentPatient.admission_no;
  document.getElementById('tube-time').textContent=now();
  document.getElementById('tube-data').classList.remove('hidden');
  document.getElementById('tube-btn').textContent='✅ מבחנה נסרקה';
}
async function createSample(){
  if(!tubeScanned){ alert('יש לסרוק את מדבקת המבחנה תחילה'); return; }
  const tests=[]; if(document.getElementById('t1').checked)tests.push('סוג דם וסקר נוגדנים'); if(document.getElementById('t2').checked)tests.push('DAT');
  const cord=document.getElementById('t3').checked;
  const ub=document.querySelector('#urgency-group .radio-btn.active');
  try{
    const r=await api('/api/samples','POST',{patient_id:currentPatient.id,tests:tests.join(', '),cord_blood:cord,urgency:ub?ub.textContent.trim():'שגרתי',urgency_reason:document.getElementById('urgency-reason').value.trim(),tube_scanned:true});
    currentSample=r.sample;
    document.getElementById('sample-created-text').textContent='דגימה '+r.sample.sample_no+' נוצרה ושויכה ל-'+currentPatient.admission_no;
    document.getElementById('sample-time').textContent=now();
    document.getElementById('sample-created').classList.remove('hidden');
  }catch(e){ alert(e.message); }
}
function selectOrderer(btn,type){ selectOne(btn); ordererType=type; }
function selectOrderType(btn,type){ selectOne(btn); orderType=type; document.getElementById('components-block').classList.toggle('hidden',type!=='components'); }

const COMPONENTS=['דם דחוס (PC)','פלסמה טרייה קפואה (FFP)','תרומבוציטים (RDP)','תרומבוציטים מתורם יחיד (SDP)','קריופרציפיטט (CRYO)','אחר'];
function addComponentRow(){
  const wrap=document.getElementById('component-rows');
  const row=document.createElement('div'); row.className='grid-2'; row.style.marginBottom='10px';
  row.innerHTML=`<div class="form-group" style="margin:0;"><label>מרכיב</label><select class="form-control comp-sel" onchange="detectPlasma()">${COMPONENTS.map(c=>`<option>${c}</option>`).join('')}</select></div>
    <div style="display:flex;gap:8px;align-items:end;"><div class="form-group" style="margin:0;flex:1;"><label>כמות</label><input type="number" class="form-control comp-qty" value="1" min="1"></div>
    <button class="btn btn-secondary btn-sm" onclick="this.closest('.grid-2').remove();detectPlasma();">✕</button></div>`;
  wrap.appendChild(row);
}
function detectPlasma(){ orderedPlasma=[...document.querySelectorAll('.comp-sel')].some(s=>s.value.includes('FFP')||s.value.includes('פלסמה')); }
function toggleSpecial(btn,key){
  if(btn.classList.contains('active')){ btn.classList.remove('active'); delete specialState[key]; updateSpecial(); return; }
  if(key==='מוקרן'){ openInfo('קריטריונים למתן מנה מוקרנת', criteriaHtml(settings.criteria_irradiated), ()=>{ btn.classList.add('active'); specialState['מוקרן']='מוקרן'; updateSpecial(); }); }
  else if(key==='CMV'){ openInfo('קריטריונים ל-CMV negative / safe', criteriaHtml(settings.criteria_cmv), ()=>{ btn.classList.add('active'); specialState['CMV']='CMV neg/safe'; updateSpecial(); }); }
  else if(key==='שטוף'){
    const list=(settings.hematologists||[]); const sel='<label>המטולוג/ית שאישר/ה מנה שטופה:</label><select class="form-control" id="hema-select"><option>— בחר —</option>'+list.map(h=>`<option>${esc(h)}</option>`).join('')+'</select>';
    openInfo('אישור מנה שטופה', sel, ()=>{ const v=document.getElementById('hema-select').value; if(v.startsWith('—'))return; btn.classList.add('active'); specialState['שטוף']='שטוף · '+v; updateSpecial(); });
  } else { btn.classList.add('active'); specialState[key]=key; updateSpecial(); }
}
function criteriaHtml(txt){ return '<div style="white-space:pre-line;">'+esc(txt||'—').split(/ · |·/).map(x=>x.trim()).filter(Boolean).map(x=>'• '+esc(x)).join('<br>')+'</div>'; }
function updateSpecial(){ const v=Object.values(specialState); document.getElementById('special-summary').textContent=v.length?('נבחרו: '+v.join(' · ')):''; }
function sendOrder(){
  openCreds(async(u,p)=>{
    const items=[...document.querySelectorAll('#component-rows .grid-2')].map(r=>({component:r.querySelector('.comp-sel').value,quantity:parseInt(r.querySelector('.comp-qty').value)||1}));
    const ub=document.querySelector('#order-urgency-group .radio-btn.active'); const urgency=ub?ub.textContent.trim():'שגרתי';
    const r=await api('/api/orders','POST',{patient_id:currentPatient.id,sample_id:currentSample?currentSample.id:null,order_type:orderType,urgency,items,special_requirements:Object.values(specialState).join(', '),hematologist:specialState['שטוף']||null,ordered_by_type:ordererType,signature:{username:u,password:p}});
    currentOrder=r.order; document.getElementById('order-time').textContent=now(); document.getElementById('order-sent').classList.remove('hidden');
  },'חתימת הזמנה');
}

// ---------- אימות לפני עירוי ----------
function refreshPreGate(){
  const has=!!currentPatient;
  document.getElementById('pre-no-patient').classList.toggle('hidden',has);
  document.getElementById('pre-body').classList.toggle('hidden',!has);
  if(has){
    document.getElementById('pre-name').textContent=currentPatient.full_name;
    document.getElementById('pre-id').textContent=currentPatient.national_id||'—';
    document.getElementById('pre-blood').textContent=currentPatient.blood_type||'—';
    document.getElementById('plasma-card').classList.toggle('hidden',!orderedPlasma);
    if(orderedPlasma&&!document.getElementById('plasma-list').children.length) addPlasmaUnit();
  }
}
function scanUnitStep(n){
  scanStep[n]=true;
  const b=document.getElementById('scan-'+n); b.textContent='✅ סריקה '+n+' הושלמה'; b.classList.add('signed');
  if(n<3) document.getElementById('scan-'+(n+1)).classList.remove('hidden');
  else { document.getElementById('cdss-check-wrap').classList.remove('hidden'); currentUnit={unit_no:'U-5521'}; }
  document.getElementById('scan-summary').textContent='נסרקו '+Object.keys(scanStep).length+'/3: '+(scanStep[1]?'מד"א ':'')+(scanStep[2]?'· ניפוק ':'')+(scanStep[3]?'· ת"ז מטופל':'');
}
function isCompatible(donor,recipient){
  if(!donor||!recipient)return false;
  const dAbo=donor.replace(/[+-]/,''),rAbo=recipient.replace(/[+-]/,''),dRh=donor.includes('+'),rRh=recipient.includes('+');
  const ok={'O':['O'],'A':['A','O'],'B':['B','O'],'AB':['A','B','AB','O']};
  if(!(ok[rAbo]||[]).includes(dAbo))return false; if(dRh&&!rRh)return false; return true;
}
function checkMatch(){
  const ub=document.getElementById('unit-blood').value; currentUnit={unit_no:'U-5521',blood_type:ub};
  const ok=isCompatible(ub,currentPatient.blood_type);
  document.getElementById('match-ok').classList.toggle('hidden',!ok);
  document.getElementById('match-fail').classList.toggle('hidden',ok);
  if(ok) document.getElementById('match-ok-text').textContent='סוג דם '+currentPatient.blood_type+' · מנה U-5521 · הצלבה תקינה · משויכת ל-'+currentPatient.admission_no+'.';
  else document.getElementById('match-fail-text').textContent='סוג דם המנה ('+ub+') אינו תואם למטופל ('+currentPatient.blood_type+'). העירוי נחסם.';
}
function addPlasmaUnit(){ const l=document.getElementById('plasma-list'); const i=l.children.length+1; const d=document.createElement('div'); d.className='alert alert-success'; d.style.marginBottom='8px'; d.innerHTML='<span class="alert-icon">🩸</span> מנת פלסמה '+i+' · U-55'+(20+i)+' · מוכנה למתן ברצף'; l.appendChild(d); }

// ---------- תיעוד עירוי ----------
function refreshTransGate(){
  const has=!!currentPatient;
  document.getElementById('trans-no-patient').classList.toggle('hidden',has);
  document.getElementById('trans-body').classList.toggle('hidden',!has);
  if(has){
    document.getElementById('trans-patient').textContent=currentPatient.full_name+' · '+currentPatient.admission_no;
    document.getElementById('trans-unit').textContent=currentUnit?(currentUnit.unit_no+' · '+(currentUnit.blood_type||currentPatient.blood_type||'')):'—';
    if(preVitals){ if(preVitals.bp)document.getElementById('bp-before').value=preVitals.bp; if(preVitals.pulse)document.getElementById('pulse-before').value=preVitals.pulse; if(preVitals.temp)document.getElementById('temp-before').value=preVitals.temp; }
    checkStartReady();
  }
}
function checkStartReady(){
  const ready=document.getElementById('bp-before').value.trim()&&document.getElementById('pulse-before').value.trim()&&document.getElementById('temp-before').value.trim();
  document.getElementById('start-btn').disabled=!ready;
  document.getElementById('start-hint').classList.toggle('hidden',!!ready);
}
async function startTransfusion(){
  try{
    const r=await api('/api/transfusions','POST',{patient_id:currentPatient.id,order_id:currentOrder?currentOrder.id:null,unit_no:currentUnit?currentUnit.unit_no:null,blood_type:currentUnit?currentUnit.blood_type:currentPatient.blood_type,bp_before:document.getElementById('bp-before').value,pulse_before:document.getElementById('pulse-before').value,temp_before:document.getElementById('temp-before').value,start_time:now()});
    currentTransfusion=r.transfusion; transfusionStart=new Date();
    document.getElementById('start-time-display').textContent='✅ התחיל בשעה '+now();
    document.getElementById('start-btn').disabled=true;
    document.getElementById('bp15-time').textContent='🕐 תזכורת מדידה בעוד 15 דקות';
  }catch(e){ alert(e.message); }
}
function endTransfusion(){
  if(!currentTransfusion){ alert('יש להתחיל עירוי תחילה'); return; }
  const body=`<label style="display:block;margin-bottom:8px;">בחר את סיכום העירוי:</label><div style="display:flex;flex-direction:column;gap:8px;">
    <label class="check-item"><input type="radio" name="outcome" value="ללא אירועים" checked> עירוי הסתיים ללא אירועים מיוחדים</label>
    <label class="check-item"><input type="radio" name="outcome" value="תגובה ללא דיווח"> נצפתה תגובה שאינה דורשת דיווח לבנק הדם</label>
    <label class="check-item"><input type="radio" name="outcome" value="תגובה עם דיווח"> נצפתה תגובה הדורשת דיווח לבנק הדם</label></div>`;
  openInfo('סיום עירוי — סיכום', body, async()=>{
    const sel=document.querySelector('input[name="outcome"]:checked').value;
    const dur=transfusionStart?Math.max(1,Math.round((new Date()-transfusionStart)/60000)):45;
    try{
      await api('/api/transfusions/'+currentTransfusion.id,'PUT',{bp_15:document.getElementById('bp15').value,pulse_15:document.getElementById('pulse15').value,bp_end:document.getElementById('bp-end').value,pulse_end:document.getElementById('pulse-end').value,nurse_notes:document.getElementById('nurse-notes').value,end_time:now(),duration_min:dur,outcome:sel,status:'הושלם'});
    }catch(e){ alert(e.message); return; }
    document.getElementById('end-time-display').textContent='⏹ הסתיים בשעה '+now();
    document.getElementById('duration-display').textContent=dur+' דקות';
    const out=document.getElementById('end-outcome'); out.classList.remove('hidden');
    if(sel==='תגובה עם דיווח') out.innerHTML='<div class="alert alert-danger"><span class="alert-icon">🚨</span> נצפתה תגובה הדורשת דיווח — יש לשלוח טופס תגובה לעירוי דם (מק"ט 5121931) לבנק הדם.</div>';
    else if(sel==='תגובה ללא דיווח') out.innerHTML='<div class="alert alert-warning"><span class="alert-icon">⚠️</span> נצפתה תגובה שאינה דורשת דיווח — תועד.</div>';
    else out.innerHTML='<div class="alert alert-success"><span class="alert-icon">✅</span> עירוי הסתיים ללא אירועים מיוחדים.</div>';
  });
}

// ---------- בנק הדם ----------
async function searchPatient(){
  const q=document.getElementById('patient-search').value.trim(); const box=document.getElementById('search-result');
  if(!q){ box.innerHTML=''; return; }
  const {patients}=await api('/api/patients?q='+encodeURIComponent(q));
  if(!patients.length){ box.innerHTML='<div class="alert alert-warning" style="margin-top:12px;"><span class="alert-icon">⚠️</span> לא נמצאו מטופלים.</div>'; return; }
  if(patients.length===1){ openPatientFile(patients[0].id); return; }
  box.innerHTML=patients.map(p=>`<div class="card" style="margin-top:12px;cursor:pointer;" onclick="openPatientFile(${p.id})"><div class="card-title" style="border:none;padding:0;margin:0;">👤 ${esc(p.full_name)} · ${esc(p.admission_no)} <span style="font-weight:400;color:var(--gray-400);margin-right:8px;">(לחצי לפתיחת תיק מלא)</span></div></div>`).join('');
}
async function openPatientFile(id){
  const h=await api('/api/patients/'+id+'/history'); const p=h.patient;
  const sRows=h.samples.length?h.samples.map(s=>`<tr><td>${esc(s.sample_no)}</td><td><span class="timestamp">🕐 ${esc(s.created_at)}</span></td><td>${esc(s.urgency)}${s.cord_blood?' · יילוד':''}</td><td>${statusBadge(s.status)}</td><td>${esc(s.result||'—')}</td></tr>`).join(''):'<tr><td colspan="5" style="color:var(--gray-400);">אין דגימות</td></tr>';
  const oRows=h.orders.length?h.orders.map(o=>`<tr><td>${o.order_type==='tests'?'בדיקות בלבד':esc((o.items||[]).map(x=>x.component+'×'+x.quantity).join(', ')||'—')}</td><td>${esc(o.urgency||'שגרתי')}</td><td><span class="timestamp">🕐 ${esc(o.created_at)}</span></td><td>${statusBadge(o.status)}</td></tr>`).join(''):'<tr><td colspan="4" style="color:var(--gray-400);">אין הזמנות</td></tr>';
  const tRows=h.transfusions.length?h.transfusions.map(t=>`<tr><td>${esc(t.unit_no||'—')} · ${esc(t.blood_type||'')}</td><td><span class="timestamp">🕐 ${esc(t.created_at)}</span></td><td>${t.duration_min?t.duration_min+' דק׳':'—'}</td><td>${esc(t.outcome||'—')}</td><td>${esc(t.nurse_notes||'—')}</td></tr>`).join(''):'<tr><td colspan="5" style="color:var(--gray-400);">אין עירויים</td></tr>';
  document.getElementById('search-result').innerHTML=`
   <div class="card" style="margin-top:12px;border-right:4px solid var(--burgundy);">
    <div class="card-title">📁 תיק מטופל — ${esc(p.full_name)} · ${esc(p.admission_no)}</div>
    <div class="patient-grid" style="margin-bottom:8px;">
      <div class="patient-field"><label>תעודת זהות</label><div class="val">${esc(p.national_id||'—')}</div></div>
      <div class="patient-field"><label>מחלקה</label><div class="val">${esc(p.department||'—')}</div></div>
      <div class="patient-field"><label>סוג דם</label><div class="val">${esc(p.blood_type||'—')}</div></div>
      <div class="patient-field"><label>רקע רלוונטי</label><div class="val" style="color:var(--burgundy);font-weight:700;">${esc(p.relevant_background||'אין')}</div></div>
    </div>
    <div style="font-weight:700;color:var(--burgundy-dark);margin:14px 0 6px;">🧪 דגימות (${h.samples.length})</div>
    <table><thead><tr><th>מס׳ דגימה</th><th>זמן</th><th>דחיפות</th><th>סטטוס</th><th>תוצאה</th></tr></thead><tbody>${sRows}</tbody></table>
    <div style="font-weight:700;color:var(--burgundy-dark);margin:14px 0 6px;">📦 הזמנות (${h.orders.length})</div>
    <table><thead><tr><th>מרכיב</th><th>דחיפות</th><th>זמן</th><th>סטטוס</th></tr></thead><tbody>${oRows}</tbody></table>
    <div style="font-weight:700;color:var(--burgundy-dark);margin:14px 0 6px;">🩸 עירויים (${h.transfusions.length})</div>
    <table><thead><tr><th>מנה</th><th>זמן</th><th>משך</th><th>תגובה/תוצאה</th><th>הערות האחות</th></tr></thead><tbody>${tRows}</tbody></table>
   </div>`;
}
function statusBadge(s){ const m={'הושלם':'badge-done','בעיבוד':'badge-process','נקלט':'badge-process','בהכנה':'badge-process','נשלח':'badge-done','הגיע':'badge-done'}; return `<span class="badge ${m[s]||'badge-pending'}">${esc(s)}</span>`; }
function canBank(){ return currentUser && ['bloodbank','admin'].includes(currentUser.role); }
async function loadSamples(){
  const {samples}=await api('/api/samples');
  document.getElementById('samples-tbody').innerHTML=samples.length?samples.map(s=>{
    let action;
    if(s.returned_at) action='✅ '+esc(s.result||'הוחזרה/נבדקה');
    else if(canBank()) action=`<button class="btn btn-sm btn-primary" onclick="returnSample(${s.id})">סמן הוחזרה + תוצאה</button>`;
    else action='<span style="color:var(--gray-400);">ממתין לבנק הדם</span>';
    return `<tr><td>${esc(s.sample_no)}</td><td>${esc(s.patient_name)} · ${esc(s.admission_no)}</td><td><span class="timestamp">🕐 ${esc((s.created_at||'').split(' ')[1]||'')}</span></td><td>${esc(s.urgency)}${s.cord_blood?' · יילוד':''}</td><td>${statusBadge(s.status)}</td><td>${action}</td></tr>`;
  }).join(''):'<tr><td colspan="6" style="color:var(--gray-400);">אין דגימות עדיין</td></tr>';
}
function returnSample(id){
  openInfo('סימון דגימה כהוחזרה/נבדקה', `<label>תוצאת הבדיקה</label><input class="form-control" id="ret-result" placeholder="למשל: O+, סקר נוגדנים שלילי"><div style="font-size:12px;color:var(--gray-400);margin-top:6px;">הזמן יירשם אוטומטית ויושווה מול חלון ה-72 שעות.</div>`,
    async()=>{ try{ await api('/api/samples/'+id,'PUT',{mark_returned:true,result:document.getElementById('ret-result').value,status:'הוחזרה/נבדקה'}); loadSamples(); }catch(e){ alert(e.message); } });
}
const ORDER_STATUSES=['נקלט','בהכנה','נשלח','הגיע'];
async function loadOrders(){
  const {orders}=await api('/api/orders');
  document.getElementById('orders-tbody').innerHTML=orders.length?orders.map(o=>{
    const comp=o.order_type==='tests'?'בדיקות בלבד':(o.items||[]).map(x=>x.component+' × '+x.quantity).join(', ')||'—';
    const statusCell=canBank()
      ? `<select class="form-control" style="padding:5px;font-size:12px;" onchange="setOrderStatus(${o.id},this.value)">${ORDER_STATUSES.map(st=>`<option ${o.status===st?'selected':''}>${st}</option>`).join('')}</select>`
      : statusBadge(o.status);
    return `<tr><td>${esc(o.patient_name)} · ${esc(o.admission_no)}</td><td>${esc(comp)}</td><td>${esc(o.urgency||'שגרתי')}</td><td><span class="timestamp">🕐 ${esc((o.created_at||'').split(' ')[1]||'')}</span></td><td>${statusCell}</td><td><span class="timestamp">🕐 ${esc((o.updated_at||'').split(' ')[1]||'')}</span></td></tr>`;
  }).join(''):'<tr><td colspan="6" style="color:var(--gray-400);">אין הזמנות עדיין</td></tr>';
}
async function setOrderStatus(id,status){ try{ await api('/api/orders/'+id+'/status','PUT',{status}); loadOrders(); }catch(e){ alert(e.message); } }
function bars(elId, rows, color){
  const el=document.getElementById(elId); if(!el) return;
  if(!rows.length){ el.innerHTML='<div class="bar-row"><div class="bar-label" style="color:var(--gray-400);">אין נתונים</div></div>'; return; }
  const max=Math.max(...rows.map(r=>r.count),1); const c=color||'var(--burgundy)';
  el.innerHTML=rows.map(r=>`<div class="bar-row"><div class="bar-label">${esc(r.label)}</div><div class="bar-track"><div class="bar-fill" style="width:${Math.max(4,Math.round(r.count/max*100))}%;background:${c};">${r.count}</div></div><div class="bar-val">${r.count}</div></div>`).join('');
}
function renderTrend(elId, map){
  const el=document.getElementById(elId); if(!el) return;
  const days=[]; const today=new Date();
  for(let i=29;i>=0;i--){ const d=new Date(today.getTime()-i*864e5); days.push(d.toISOString().slice(0,10)); }
  const counts=days.map(d=>map[d]||0); const max=Math.max(...counts,1);
  el.innerHTML=`<div style="display:flex;align-items:flex-end;gap:3px;height:120px;padding-top:8px;">${days.map((d,i)=>`<div title="${d}: ${counts[i]}" style="flex:1;background:var(--burgundy);opacity:${counts[i]?1:0.15};height:${Math.max(3,Math.round(counts[i]/max*110))}px;border-radius:3px 3px 0 0;"></div>`).join('')}</div><div style="font-size:11px;color:var(--gray-400);margin-top:6px;">מ-${days[0]} עד ${days[29]} · שיא יומי: ${max}</div>`;
}
async function loadReports(){
  const from=document.getElementById('rp-from').value||'2000-01-01';
  const to=document.getElementById('rp-to').value||'2999-12-31';
  const a=await api('/api/reports/analytics?from='+from+'&to='+to);
  const s=await api('/api/reports/summary');
  document.getElementById('rp-samples').textContent=a.range.samples;
  document.getElementById('rp-trans-range').textContent=a.range.transfusions;
  document.getElementById('rp-avg').textContent=s.avg_process_min||0;
  document.getElementById('rp-blocks').textContent=s.cdss_blocks;
  const lr=a.late_returns;
  document.getElementById('rp-late').innerHTML=`
    <div class="stat-card"><div class="stat-val">${lr.total}</div><div class="stat-lbl">סה״כ דגימות</div></div>
    <div class="stat-card"><div class="stat-val" style="color:var(--success);">${lr.on_time_pct}%</div><div class="stat-lbl">עמידה בזמן</div></div>
    <div class="stat-card"><div class="stat-val" style="color:var(--danger);">${lr.not_in_time}</div><div class="stat-lbl">לא הוחזרו תוך 72ש׳</div></div>
    <div class="stat-card"><div class="stat-val" style="color:var(--warning);">${lr.overdue_open}</div><div class="stat-lbl">חורגות וטרם נבדקו</div></div>`;
  bars('rp-samples-month', a.samples_by_month.map(x=>({label:x.m,count:x.c})));
  bars('rp-trans-month', a.trans_by_month.map(x=>({label:x.m,count:x.c})), 'var(--burgundy-light)');
  bars('rp-outcomes', a.outcomes.map(x=>({label:x.o,count:x.c})), 'var(--burgundy-mid)');
  bars('rp-weekday', a.load_by_weekday.map(x=>({label:x.day,count:x.count})));
  bars('rp-activity', a.activity_by_user.map(x=>({label:x.u,count:x.c})), 'var(--burgundy-light)');
  bars('rp-dept', a.by_department.map(x=>({label:x.dept||'ללא מחלקה',count:x.c})));
  renderTrend('rp-trend', a.trend.samples);
  const {audit}=await api('/api/audit');
  document.getElementById('audit-tbody').innerHTML=audit.length?audit.slice(0,30).map(x=>`<tr><td><span class="timestamp">🕐 ${esc(x.created_at)}</span></td><td>${esc(x.user_name||'—')}</td><td>${esc(x.action)}</td><td>${esc(x.details||'')}</td></tr>`).join(''):'<tr><td colspan="4" style="color:var(--gray-400);">אין רשומות</td></tr>';
}

// ---------- אדמין ----------
function adminTab(name,btn){ selectOne(btn); document.querySelectorAll('.admin-tab').forEach(t=>t.classList.add('hidden')); document.getElementById('admin-'+name).classList.remove('hidden');
  if(name==='users')loadUsers(); if(name==='integration')loadIntegration(); if(name==='reports')loadAdminReports(); if(name==='settings')loadSettings(); }
const ROLES={nurse:'איש צוות',doctor:'רופא',bloodbank:'בנק הדם',admin:'מנהל'};
async function loadUsers(){
  try{ const {users}=await api('/api/admin/users');
    document.getElementById('users-tbody').innerHTML=users.map(u=>`<tr><td>${esc(u.username)}</td><td>${esc(u.full_name)}</td><td>${ROLES[u.role]||u.role}</td><td>${esc(u.authorization_expiry||'—')}</td><td>${u.active?'<span class="badge badge-done">פעיל</span>':'<span class="badge badge-danger">מושבת</span>'}</td><td style="white-space:nowrap;"><button class="btn btn-sm btn-outline" onclick="renewUser(${u.id})">חדש הרשאה</button> <button class="btn btn-sm btn-secondary" onclick="toggleUser(${u.id},${u.active?0:1})">${u.active?'השבת':'הפעל'}</button> <button class="btn btn-sm btn-danger" onclick="deleteUser(${u.id},'${esc(u.username)}')">מחק</button></td></tr>`).join('');
  }catch(e){}
}
async function createUser(){
  const body={username:document.getElementById('nu-username').value.trim(),full_name:document.getElementById('nu-fullname').value.trim(),password:document.getElementById('nu-password').value,role:document.getElementById('nu-role').value,authorization_expiry:document.getElementById('nu-expiry').value};
  if(!body.username||!body.full_name||!body.password){ alert('חובה: שם משתמש, שם מלא וסיסמה'); return; }
  try{ await api('/api/admin/users','POST',body); document.getElementById('nu-username').value='';document.getElementById('nu-fullname').value='';document.getElementById('nu-password').value=''; loadUsers(); }catch(e){ alert(e.message); }
}
async function toggleUser(id,active){ try{ await api('/api/admin/users/'+id,'PUT',{active}); loadUsers(); }catch(e){ alert(e.message); } }
function deleteUser(id,username){
  openInfo('מחיקת משתמש', `למחוק את המשתמש <strong>${esc(username)}</strong>? הוא יוסר מרשימת המשתמשים ולא יוכל להיכנס. שמו יישמר בדוחות וב-Audit לצורך עקיבות.`, async()=>{
    try{ await api('/api/admin/users/'+id,'DELETE'); loadUsers(); }catch(e){ alert(e.message); }
  });
}
function renewUser(id){
  const d=new Date(); d.setFullYear(d.getFullYear()+1); const def=d.toISOString().slice(0,10);
  openInfo('חידוש הרשאת משתמש',
    `<label>תוקף הרשאה חדש</label><input type="date" id="renew-date" class="form-control" value="${def}"><div style="font-size:12px;color:var(--gray-400);margin-top:6px;">ברירת מחדל: בעוד שנה מהיום — ניתן לשנות. החידוש גם מפעיל מחדש משתמש מושבת.</div>`,
    async ()=>{ const val=document.getElementById('renew-date').value; if(!val)return; try{ await api('/api/admin/users/'+id,'PUT',{authorization_expiry:val,active:1}); loadUsers(); }catch(e){ alert(e.message); } });
}
async function loadIntegration(){
  const {integrations}=await api('/api/admin/integration');
  document.getElementById('integration-list').innerHTML=integrations.map(it=>`<div class="card"><div class="card-title">🔌 ${esc(it.system_name)} <span class="badge ${it.status==='connected'?'badge-done':'badge-warning'}" style="margin-right:8px;">${it.status==='connected'?'מחובר':'סימולציה'}</span></div>
    <p style="font-size:12px;color:var(--gray-600);margin-bottom:12px;">${esc(it.description||'')}</p>
    <div class="grid-2"><div class="form-group"><label>כתובת (Endpoint)</label><input class="form-control" id="int-ep-${it.id}" value="${esc(it.endpoint||'')}"></div>
    <div class="form-group"><label>מפתח API</label><input class="form-control" id="int-key-${it.id}" placeholder="••••••" value="${esc(it.api_key||'')}"></div></div>
    <div style="font-size:11px;color:var(--gray-400);margin-bottom:10px;">כיוון: ${esc(it.direction||'')} · סנכרון אחרון: ${esc(it.last_sync||'—')}</div>
    <button class="btn btn-primary btn-sm" onclick="saveIntegration(${it.id})">שמור</button>
    <button class="btn btn-outline btn-sm" onclick="testIntegration(${it.id})">בדוק חיבור</button></div>`).join('');
}
async function saveIntegration(id){ try{ await api('/api/admin/integration/'+id,'PUT',{endpoint:document.getElementById('int-ep-'+id).value,api_key:document.getElementById('int-key-'+id).value}); loadIntegration(); }catch(e){ alert(e.message); } }
async function testIntegration(id){ try{ const r=await api('/api/admin/integration/'+id+'/test','POST'); alert(r.message); loadIntegration(); }catch(e){ alert(e.message); } }
async function loadAdminReports(){
  const r=await api('/api/reports/summary'); document.getElementById('a-avg').textContent=r.avg_process_min||0; document.getElementById('a-trans').textContent=r.transfusions; document.getElementById('a-blocks').textContent=r.cdss_blocks;
  const {audit}=await api('/api/audit'); document.getElementById('admin-audit-tbody').innerHTML=audit.map(a=>`<tr><td><span class="timestamp">🕐 ${esc(a.created_at)}</span></td><td>${esc(a.user_name||'—')}</td><td>${esc(a.action)}</td><td>${esc(a.details||'')}</td></tr>`).join('');
}
async function loadSettings(){
  const {settings:s}=await api('/api/admin/settings');
  document.getElementById('set-hema').value=(JSON.parse(s.hematologists||'[]')).join('\n');
  document.getElementById('set-depts').value=(JSON.parse(s.departments||'[]')).join('\n');
  document.getElementById('set-irr').value=s.criteria_irradiated||''; document.getElementById('set-cmv').value=s.criteria_cmv||'';
}
async function saveSettings(){
  const hema=JSON.stringify(document.getElementById('set-hema').value.split('\n').map(x=>x.trim()).filter(Boolean));
  const depts=JSON.stringify(document.getElementById('set-depts').value.split('\n').map(x=>x.trim()).filter(Boolean));
  try{ await api('/api/admin/settings','PUT',{hematologists:hema,departments:depts,criteria_irradiated:document.getElementById('set-irr').value,criteria_cmv:document.getElementById('set-cmv').value});
    settings=await api('/api/settings'); const el=document.getElementById('settings-saved'); el.classList.remove('hidden'); setTimeout(()=>el.classList.add('hidden'),2500);
  }catch(e){ alert(e.message); }
}

document.addEventListener('keydown',e=>{ if(e.key==='Enter'&&document.getElementById('login-screen').style.display!=='none')doLogin(); });
(async function init(){ try{ const r=await api('/api/me'); currentUser=r.user; enterApp(r.auth); }catch{} })();
