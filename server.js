// server.js — השרת המלא של מערכת לקיחת דם ועירוי, אסותא אשדוד
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const path = require('path');
const { db, seed } = require('./db');
seed();

const app = express();
const PORT = process.env.PORT || 3000;
app.use(express.json());
app.use(session({
  secret: process.env.SESSION_SECRET || 'asuta-blood-system-secret-key',
  resave: false, saveUninitialized: false,
  cookie: { maxAge: 1000 * 60 * 60 * 8 }
}));

// ---------- עזרים ----------
function audit(req, action, entity_type, entity_id, details) {
  const u = req.session.user;
  db.prepare('INSERT INTO audit_log (user_id,user_name,action,entity_type,entity_id,details) VALUES (?,?,?,?,?,?)')
    .run(u?u.id:null, u?u.full_name:null, action, entity_type||null, entity_id||null, details||null);
}
function requireAuth(req,res,next){ if(!req.session.user) return res.status(401).json({error:'נדרשת התחברות'}); next(); }
function requireAdmin(req,res,next){ if(!req.session.user||req.session.user.role!=='admin') return res.status(403).json({error:'נדרשות הרשאות מנהל'}); next(); }
function daysUntil(dateStr){ if(!dateStr) return null; const d=new Date(dateStr+'T00:00:00'); return Math.ceil((d-new Date())/864e5); }
function authStatus(user){
  const days = daysUntil(user.authorization_expiry);
  return { expiry: user.authorization_expiry, days_left: days,
    expired: days!==null && days<0, expiring_soon: days!==null && days>=0 && days<=30 };
}
function setting(key){ const r=db.prepare('SELECT value FROM settings WHERE key=?').get(key); return r?r.value:null; }

// ---------- התחברות ----------
app.post('/api/login',(req,res)=>{
  const {username,password}=req.body;
  if(!username||!password) return res.status(400).json({error:'יש למלא שם משתמש וסיסמה'});
  const user=db.prepare('SELECT * FROM users WHERE username=?').get(username);
  if(!user||!bcrypt.compareSync(password,user.password_hash)) return res.status(401).json({error:'שם משתמש או סיסמה שגויים'});
  if(!user.active) return res.status(403).json({error:'המשתמש מושבת. פנה למנהל המערכת'});
  req.session.user={id:user.id,username:user.username,full_name:user.full_name,role:user.role};
  audit(req,'התחברות למערכת','user',user.id,null);
  res.json({user:req.session.user, auth:authStatus(user)});
});
app.post('/api/logout',(req,res)=>{ audit(req,'יציאה מהמערכת','user',req.session.user?.id,null); req.session.destroy(()=>res.json({ok:true})); });
app.get('/api/me',(req,res)=>{
  if(!req.session.user) return res.status(401).json({error:'לא מחובר'});
  const u=db.prepare('SELECT * FROM users WHERE id=?').get(req.session.user.id);
  res.json({user:req.session.user, auth:u?authStatus(u):null});
});
// אימות מחדש לפני חתימה — בודק גם הרשאה בתוקף
app.post('/api/auth/verify',requireAuth,(req,res)=>{
  const {username,password}=req.body;
  if(!username||!password) return res.status(400).json({error:'יש למלא שם משתמש וסיסמה'});
  const user=db.prepare('SELECT * FROM users WHERE username=?').get(username);
  if(!user||!bcrypt.compareSync(password,user.password_hash)) return res.status(401).json({error:'אימות נכשל — שם משתמש או סיסמה שגויים'});
  if(!user.active) return res.status(403).json({error:'המשתמש מושבת'});
  const st=authStatus(user);
  if(st.expired) return res.status(403).json({error:'הרשאת המשתמש פגה — לא ניתן לחתום. פנה למנהל'});
  res.json({ok:true, full_name:user.full_name, auth:st});
});

// ---------- מטופלים ----------
app.get('/api/patients',requireAuth,(req,res)=>{
  const q=(req.query.q||'').trim();
  if(!q) return res.json({patients:db.prepare('SELECT * FROM patients ORDER BY created_at DESC LIMIT 50').all()});
  const like=`%${q}%`;
  res.json({patients:db.prepare('SELECT * FROM patients WHERE admission_no LIKE ? OR national_id LIKE ? OR full_name LIKE ? ORDER BY full_name').all(like,like,like)});
});
app.get('/api/patients/:admission_no',requireAuth,(req,res)=>{
  const p=db.prepare('SELECT * FROM patients WHERE admission_no=?').get(req.params.admission_no);
  if(!p) return res.status(404).json({error:'מטופל לא נמצא'});
  res.json({patient:p});
});
app.post('/api/patients',requireAuth,(req,res)=>{
  const {admission_no,national_id,full_name,department,blood_type,relevant_background}=req.body;
  if(!admission_no||!full_name) return res.status(400).json({error:'חובה למלא מספר אשפוז ושם'});
  try{
    const i=db.prepare('INSERT INTO patients (admission_no,national_id,full_name,department,blood_type,relevant_background) VALUES (?,?,?,?,?,?)')
      .run(admission_no,national_id||null,full_name,department||null,blood_type||null,relevant_background||null);
    audit(req,'יצירת מטופל','patient',i.lastInsertRowid,admission_no);
    res.json({patient:db.prepare('SELECT * FROM patients WHERE id=?').get(i.lastInsertRowid)});
  }catch(e){ res.status(400).json({error:'מספר אשפוז כבר קיים'}); }
});

// ---------- דגימות ----------
app.get('/api/samples',requireAuth,(req,res)=>{
  res.json({samples:db.prepare(`SELECT s.*, p.admission_no, p.full_name AS patient_name FROM samples s JOIN patients p ON p.id=s.patient_id ORDER BY s.created_at DESC LIMIT 100`).all()});
});
app.post('/api/samples',requireAuth,(req,res)=>{
  const {patient_id,tests,cord_blood,urgency,urgency_reason,tube_scanned}=req.body;
  if(!patient_id) return res.status(400).json({error:'חובה לבחור מטופל'});
  if(!tube_scanned) return res.status(400).json({error:'יש לסרוק את מדבקת המבחנה'});
  const sample_no='S-'+new Date().getFullYear()+'-'+String(Math.floor(10000+Math.random()*89999));
  const i=db.prepare('INSERT INTO samples (sample_no,patient_id,tests,cord_blood,urgency,urgency_reason,tube_scanned,status,collected_by) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(sample_no,patient_id,tests||'',cord_blood?1:0,urgency||'שגרתי',urgency_reason||null,1,'בעיבוד',req.session.user.id);
  audit(req,'שיוך דגימה','sample',i.lastInsertRowid,sample_no);
  res.json({sample:db.prepare('SELECT * FROM samples WHERE id=?').get(i.lastInsertRowid)});
});

// ---------- הזמנות ----------
app.get('/api/orders',requireAuth,(req,res)=>{
  const orders=db.prepare(`SELECT o.*, p.admission_no, p.full_name AS patient_name FROM orders o JOIN patients p ON p.id=o.patient_id ORDER BY o.created_at DESC LIMIT 100`).all();
  for(const o of orders) o.items=db.prepare('SELECT component,quantity FROM order_items WHERE order_id=?').all(o.id);
  res.json({orders});
});
app.post('/api/orders',requireAuth,(req,res)=>{
  const {patient_id,sample_id,order_type,items,special_requirements,hematologist,ordered_by_type,signature}=req.body;
  if(!patient_id) return res.status(400).json({error:'חובה לבחור מטופל'});
  // חתימה עם סיסמה אחרי שליחת הזמנה
  if(!signature||!signature.username) return res.status(400).json({error:'נדרשת חתימה בסיסמה לשליחת ההזמנה'});
  const su=db.prepare('SELECT * FROM users WHERE username=?').get(signature.username);
  if(!su||!bcrypt.compareSync(signature.password||'',su.password_hash)) return res.status(401).json({error:'חתימה נכשלה — שם משתמש או סיסמה שגויים'});
  const i=db.prepare('INSERT INTO orders (patient_id,sample_id,order_type,special_requirements,hematologist,ordered_by_type,ordered_by,signed_by,status) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(patient_id,sample_id||null,order_type||'components',special_requirements||null,hematologist||null,ordered_by_type||'doctor',req.session.user.id,su.full_name,'נקלט');
  const oid=i.lastInsertRowid;
  if(order_type!=='tests' && Array.isArray(items)) for(const it of items) db.prepare('INSERT INTO order_items (order_id,component,quantity) VALUES (?,?,?)').run(oid,it.component,it.quantity||1);
  db.prepare('INSERT INTO signatures (entity_type,entity_id,stage,user_id,signed_by) VALUES (?,?,?,?,?)').run('order',oid,'חתימת הזמנה',su.id,su.full_name);
  audit(req,'הזמנה נשלחה ונחתמה','order',oid,order_type==='tests'?'בדיקות בלבד':(items||[]).map(x=>x.component+'×'+(x.quantity||1)).join(', '));
  res.json({order:db.prepare('SELECT * FROM orders WHERE id=?').get(oid)});
});
app.put('/api/orders/:id/status',requireAuth,(req,res)=>{
  db.prepare("UPDATE orders SET status=?, updated_at=datetime('now','localtime') WHERE id=?").run(req.body.status,req.params.id);
  audit(req,'עדכון סטטוס הזמנה','order',req.params.id,req.body.status);
  res.json({ok:true});
});

// ---------- עירויים ----------
app.post('/api/transfusions',requireAuth,(req,res)=>{
  const b=req.body;
  if(!b.patient_id) return res.status(400).json({error:'חובה לבחור מטופל'});
  if(!b.bp_before||!b.pulse_before||!b.temp_before) return res.status(400).json({error:'חובה להזין מדדים (ל.ד, דופק, חום) לפני התחלת עירוי'});
  const i=db.prepare(`INSERT INTO transfusions (patient_id,order_id,unit_no,unit_no_mda,unit_no_dispense,patient_id_scanned,blood_type,bp_before,pulse_before,temp_before,start_time,status) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(b.patient_id,b.order_id||null,b.unit_no||null,b.unit_no_mda||null,b.unit_no_dispense||null,b.patient_id_scanned||null,b.blood_type||null,b.bp_before,b.pulse_before,b.temp_before,b.start_time||null,'פתוח');
  audit(req,'התחלת עירוי','transfusion',i.lastInsertRowid,b.unit_no||'');
  res.json({transfusion:db.prepare('SELECT * FROM transfusions WHERE id=?').get(i.lastInsertRowid)});
});
app.put('/api/transfusions/:id',requireAuth,(req,res)=>{
  const fields=['unit_no','blood_type','bp_15','pulse_15','temp_15','bp_end','pulse_end','temp_end','end_time','duration_min','outcome','status','block_reason'];
  const sets=[],vals=[];
  for(const f of fields) if(req.body[f]!==undefined){ sets.push(`${f}=?`); vals.push(req.body[f]); }
  if(!sets.length) return res.json({ok:true});
  vals.push(req.params.id);
  db.prepare(`UPDATE transfusions SET ${sets.join(',')} WHERE id=?`).run(...vals);
  audit(req,'עדכון עירוי','transfusion',req.params.id,req.body.outcome||req.body.status||'');
  res.json({transfusion:db.prepare('SELECT * FROM transfusions WHERE id=?').get(req.params.id)});
});

// ---------- חתימות ----------
app.post('/api/signatures',requireAuth,(req,res)=>{
  const {entity_type,entity_id,stage,username,password}=req.body;
  if(!username||!password) return res.status(400).json({error:'נדרש אימות לפני חתימה'});
  const user=db.prepare('SELECT * FROM users WHERE username=?').get(username);
  if(!user||!bcrypt.compareSync(password,user.password_hash)) return res.status(401).json({error:'אימות נכשל — שם משתמש או סיסמה שגויים'});
  if(!user.active) return res.status(403).json({error:'המשתמש מושבת'});
  const st=authStatus(user);
  if(st.expired) return res.status(403).json({error:'הרשאת המשתמש פגה — לא ניתן לחתום'});
  const i=db.prepare('INSERT INTO signatures (entity_type,entity_id,stage,user_id,signed_by) VALUES (?,?,?,?,?)').run(entity_type||'general',entity_id||null,stage||'',user.id,user.full_name);
  audit(req,'חתימה דיגיטלית',entity_type,entity_id,stage);
  res.json({signature:{id:i.lastInsertRowid,signed_by:user.full_name,signed_at:new Date().toLocaleTimeString('he-IL')}, auth:st});
});

// ---------- דוחות / Audit / הגדרות ציבוריות ----------
app.get('/api/reports/summary',requireAuth,(req,res)=>{
  const transfusions=db.prepare("SELECT COUNT(*) AS c FROM transfusions WHERE status='הושלם'").get().c;
  const blocks=db.prepare("SELECT COUNT(*) AS c FROM transfusions WHERE status='נחסם'").get().c;
  const avgDur=db.prepare("SELECT ROUND(AVG(duration_min)) AS a FROM transfusions WHERE duration_min IS NOT NULL").get().a;
  const byDept=db.prepare(`SELECT p.department AS dept, COUNT(*) AS c FROM transfusions t JOIN patients p ON p.id=t.patient_id GROUP BY p.department ORDER BY c DESC`).all();
  res.json({avg_process_min:avgDur||0,transfusions,cdss_blocks:blocks,audit_coverage:100,by_department:byDept});
});
app.get('/api/audit',requireAuth,(req,res)=>{ res.json({audit:db.prepare('SELECT * FROM audit_log ORDER BY created_at DESC LIMIT 200').all()}); });
app.get('/api/settings',requireAuth,(req,res)=>{
  res.json({ hematologists:JSON.parse(setting('hematologists')||'[]'), departments:JSON.parse(setting('departments')||'[]'),
    criteria_irradiated:setting('criteria_irradiated'), criteria_cmv:setting('criteria_cmv') });
});

// ---------- אדמין: משתמשים ----------
app.get('/api/admin/users',requireAdmin,(req,res)=>{
  res.json({users:db.prepare('SELECT id,username,full_name,role,active,authorization_expiry,created_at FROM users ORDER BY id').all()});
});
app.post('/api/admin/users',requireAdmin,(req,res)=>{
  const {username,password,full_name,role,authorization_expiry}=req.body;
  if(!username||!password||!full_name) return res.status(400).json({error:'חובה: שם משתמש, סיסמה ושם מלא'});
  try{
    const i=db.prepare('INSERT INTO users (username,password_hash,full_name,role,authorization_expiry) VALUES (?,?,?,?,?)')
      .run(username,bcrypt.hashSync(password,10),full_name,role||'nurse',authorization_expiry||null);
    audit(req,'יצירת משתמש','user',i.lastInsertRowid,username);
    res.json({ok:true,id:i.lastInsertRowid});
  }catch(e){ res.status(400).json({error:'שם משתמש כבר קיים'}); }
});
app.put('/api/admin/users/:id',requireAdmin,(req,res)=>{
  const {full_name,role,active,authorization_expiry,password}=req.body;
  const sets=[],vals=[];
  if(full_name!==undefined){sets.push('full_name=?');vals.push(full_name);}
  if(role!==undefined){sets.push('role=?');vals.push(role);}
  if(active!==undefined){sets.push('active=?');vals.push(active?1:0);}
  if(authorization_expiry!==undefined){sets.push('authorization_expiry=?');vals.push(authorization_expiry||null);}
  if(password){sets.push('password_hash=?');vals.push(bcrypt.hashSync(password,10));}
  if(sets.length){ vals.push(req.params.id); db.prepare(`UPDATE users SET ${sets.join(',')} WHERE id=?`).run(...vals); }
  audit(req,'עדכון משתמש','user',req.params.id,full_name||'');
  res.json({ok:true});
});

// ---------- אדמין: אינטגרציה ----------
app.get('/api/admin/integration',requireAdmin,(req,res)=>{ res.json({integrations:db.prepare('SELECT * FROM integration_config ORDER BY id').all()}); });
app.put('/api/admin/integration/:id',requireAdmin,(req,res)=>{
  const {endpoint,api_key,enabled,status}=req.body;
  const sets=[],vals=[];
  if(endpoint!==undefined){sets.push('endpoint=?');vals.push(endpoint);}
  if(api_key!==undefined){sets.push('api_key=?');vals.push(api_key);}
  if(enabled!==undefined){sets.push('enabled=?');vals.push(enabled?1:0);}
  if(status!==undefined){sets.push('status=?');vals.push(status);}
  if(sets.length){ vals.push(req.params.id); db.prepare(`UPDATE integration_config SET ${sets.join(',')} WHERE id=?`).run(...vals); }
  audit(req,'עדכון אינטגרציה','integration',req.params.id,status||'');
  res.json({ok:true});
});
app.post('/api/admin/integration/:id/test',requireAdmin,(req,res)=>{
  // בדיקת חיבור מדומה (אין גישה אמיתית למערכות אסותא)
  const t=new Date().toLocaleString('he-IL');
  db.prepare("UPDATE integration_config SET status='simulated', last_sync=? WHERE id=?").run(t,req.params.id);
  audit(req,'בדיקת חיבור אינטגרציה','integration',req.params.id,'סימולציה');
  res.json({ok:true,status:'simulated',message:'בדיקת חיבור מדומה הצליחה. חיבור אמיתי דורש גישת API מאסותא.',last_sync:t});
});

// ---------- אדמין: הגדרות ----------
app.get('/api/admin/settings',requireAdmin,(req,res)=>{
  const all=db.prepare('SELECT key,value FROM settings').all();
  res.json({settings:Object.fromEntries(all.map(r=>[r.key,r.value]))});
});
app.put('/api/admin/settings',requireAdmin,(req,res)=>{
  for(const [k,v] of Object.entries(req.body||{})) db.prepare('INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=?').run(k,v,v);
  audit(req,'עדכון הגדרות מערכת','settings',null,Object.keys(req.body||{}).join(', '));
  res.json({ok:true});
});

app.use(express.static(path.join(__dirname,'public')));
app.listen(PORT,()=>console.log(`\n  מערכת אסותא אשדוד פועלת על: http://localhost:${PORT}\n`));
