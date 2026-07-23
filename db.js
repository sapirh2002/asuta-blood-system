// db.js — מסד הנתונים (SQLite מובנה של Node). שומר לקובץ data/asuta.db
const { DatabaseSync } = require('node:sqlite');
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, 'asuta.db'));
db.exec('PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  full_name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'nurse',           -- nurse | bloodbank | admin | doctor
  active INTEGER NOT NULL DEFAULT 1,
  authorization_expiry TEXT,                     -- תאריך תפוגת הרשאה (YYYY-MM-DD)
  permissions TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS patients (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  admission_no TEXT UNIQUE NOT NULL,
  national_id TEXT, full_name TEXT NOT NULL,
  department TEXT, blood_type TEXT, relevant_background TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS samples (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sample_no TEXT UNIQUE NOT NULL,
  patient_id INTEGER NOT NULL REFERENCES patients(id),
  tests TEXT, cord_blood INTEGER DEFAULT 0,
  urgency TEXT DEFAULT 'שגרתי', urgency_reason TEXT,
  tube_scanned INTEGER DEFAULT 0,
  status TEXT DEFAULT 'בעיבוד',
  collected_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  expires_at TEXT NOT NULL DEFAULT (datetime('now','localtime','+72 hours'))
);

CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id INTEGER NOT NULL REFERENCES patients(id),
  sample_id INTEGER REFERENCES samples(id),
  order_type TEXT DEFAULT 'components',          -- components | tests
  special_requirements TEXT, hematologist TEXT,
  ordered_by_type TEXT DEFAULT 'doctor',
  ordered_by INTEGER REFERENCES users(id),
  signed_by TEXT,
  status TEXT DEFAULT 'נקלט',
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS order_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id),
  component TEXT NOT NULL, quantity INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS transfusions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id INTEGER NOT NULL REFERENCES patients(id),
  order_id INTEGER REFERENCES orders(id),
  unit_no TEXT, unit_no_mda TEXT, unit_no_dispense TEXT, patient_id_scanned TEXT,
  blood_type TEXT,
  bp_before TEXT, pulse_before TEXT, temp_before TEXT,
  bp_15 TEXT, pulse_15 TEXT, temp_15 TEXT,
  bp_end TEXT, pulse_end TEXT, temp_end TEXT,
  start_time TEXT, end_time TEXT, duration_min INTEGER,
  outcome TEXT, status TEXT DEFAULT 'פתוח', block_reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS signatures (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_type TEXT NOT NULL, entity_id INTEGER, stage TEXT NOT NULL,
  user_id INTEGER NOT NULL REFERENCES users(id), signed_by TEXT NOT NULL,
  signed_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id), user_name TEXT,
  action TEXT NOT NULL, entity_type TEXT, entity_id INTEGER, details TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS integration_config (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  system_name TEXT UNIQUE NOT NULL, description TEXT,
  endpoint TEXT, api_key TEXT, direction TEXT,
  enabled INTEGER DEFAULT 1, status TEXT DEFAULT 'simulated',
  last_sync TEXT
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY, value TEXT
);
`);

function seed() {
  if (db.prepare('SELECT COUNT(*) AS c FROM users').get().c === 0) {
    console.log('זורע נתוני התחלה...');
    const insUser = db.prepare('INSERT INTO users (username,password_hash,full_name,role,authorization_expiry) VALUES (?,?,?,?,?)');
    const today = new Date();
    const plus = d => new Date(today.getTime() + d*864e5).toISOString().slice(0,10);
    insUser.run('admin', bcrypt.hashSync('admin123',10), 'מנהל/ת מערכת', 'admin', plus(365));
    insUser.run('levi',  bcrypt.hashSync('asuta123',10), 'מלמ. לוי · איש צוות מורשה', 'nurse', plus(18)); // תוקף בעוד 18 יום -> התראה
    insUser.run('cohen', bcrypt.hashSync('asuta123',10), 'ד״ר כהן מירב', 'doctor', plus(200));
    insUser.run('bank',  bcrypt.hashSync('asuta123',10), 'רכזת בנק הדם', 'bloodbank', plus(120));

    const insP = db.prepare('INSERT INTO patients (admission_no,national_id,full_name,department,blood_type,relevant_background) VALUES (?,?,?,?,?,?)');
    insP.run('A-48217','123456789','ישראל ישראלי','פנימית ב׳','O+','נוגדן anti-K מתועד');
    insP.run('A-48220','234567891','חנה כהן','טיפול נמרץ','A+',null);
    insP.run('A-48231','345678912','משה לוי','חדר ניתוח','B+',null);
  }
  if (db.prepare('SELECT COUNT(*) AS c FROM integration_config').get().c === 0) {
    const insI = db.prepare('INSERT INTO integration_config (system_name,description,endpoint,direction,enabled,status) VALUES (?,?,?,?,?,?)');
    insI.run('קמיליון (Chameleon)','שליפת פרטי מטופל, קיום הוראת רופא, תיעוד זמנים','https://chameleon.asuta.local/api','דו-כיווני',1,'simulated');
    insI.run('אוטופיוזן (Autofusion)','הזמנות, קליטת דגימה, סטטוס מנה ותוצאות CDSS','https://autofusion.asuta.local/api','דו-כיווני',1,'simulated');
  }
  const setDefault = (k,v)=>{ if(!db.prepare('SELECT 1 FROM settings WHERE key=?').get(k)) db.prepare('INSERT INTO settings (key,value) VALUES (?,?)').run(k,v); };
  setDefault('hematologists', JSON.stringify(['ד״ר (שם המטולוג) 1 — לעדכון','ד״ר (שם המטולוג) 2 — לעדכון','ד״ר (שם המטולוג) 3 — לעדכון']));
  setDefault('departments', JSON.stringify(['פנימית ב׳','טיפול נמרץ','חדר ניתוח','אונקולוגיה','חדר לידה']));
  setDefault('criteria_irradiated', 'השתלת מח עצם/רקמה/איבר · כשל חיסוני מולד · כשל חיסוני נרכש (SCID) · מחלה המטואונקולוגית · טיפול אימונוסופרסיבי · עובר/פג/וילוד · דם מקרובי משפחה וטרומבוציטים תורם זהה ב-HLA · כל עירוי גרנולוציטים');
  setDefault('criteria_cmv', 'עירוי תוך-רחמי · פגים ויילודים במשקל נמוך · הריון עם CMV שלילי · מושתלי מח עצם CMV-שליליים · מדוכאי חיסון קשה. (ברירת מחדל — לעדכון ע"י אסותא)');
  console.log('זריעה הושלמה. אדמין: admin/admin123 · צוות: levi/asuta123 · בנק דם: bank/asuta123 · רופא: cohen/asuta123');
}

if (process.argv.includes('--seed')) seed();
module.exports = { db, seed };
