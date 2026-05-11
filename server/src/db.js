import initSqlJs from 'sql.js';
import bcrypt from 'bcryptjs';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dataDir = path.join(__dirname, '..', 'data');
fs.mkdirSync(dataDir, { recursive: true });

let SQL;
export let usersDb;
export let restaurantsDb;
export let coreDb;

function rowToObject(stmt) {
  const obj = stmt.getAsObject();
  return Object.keys(obj).length ? obj : undefined;
}

class PersistedSqliteDb {
  constructor(filename) {
    this.filename = filename;
    const file = path.join(dataDir, filename);
    this.filepath = file;
    if (fs.existsSync(file)) {
      const buffer = fs.readFileSync(file);
      this.db = new SQL.Database(buffer);
    } else {
      this.db = new SQL.Database();
      this.persist();
    }
  }
  persist() {
    fs.writeFileSync(this.filepath, Buffer.from(this.db.export()));
  }
  pragma() { return null; }
  exec(sql) { this.db.run(sql); this.persist(); }
  transaction(fn) {
    return (...args) => {
      this.db.run('BEGIN TRANSACTION');
      try {
        const result = fn(...args);
        this.db.run('COMMIT');
        this.persist();
        return result;
      } catch (err) {
        this.db.run('ROLLBACK');
        throw err;
      }
    };
  }
  prepare(sql) {
    const self = this;
    function params(args) { return Array.isArray(args[0]) ? args[0] : args; }
    return {
      run(...args) {
        const stmt = self.db.prepare(sql);
        stmt.bind(params(args));
        while (stmt.step()) {}
        stmt.free();
        const last = self.db.exec('SELECT last_insert_rowid() AS id');
        const lastInsertRowid = last?.[0]?.values?.[0]?.[0] ?? 0;
        const changes = self.db.getRowsModified();
        self.persist();
        return { lastInsertRowid, changes };
      },
      get(...args) {
        const stmt = self.db.prepare(sql);
        stmt.bind(params(args));
        const row = stmt.step() ? rowToObject(stmt) : undefined;
        stmt.free();
        return row;
      },
      all(...args) {
        const stmt = self.db.prepare(sql);
        stmt.bind(params(args));
        const rows = [];
        while (stmt.step()) rows.push(rowToObject(stmt));
        stmt.free();
        return rows.filter(Boolean);
      }
    };
  }
}

function json(value, fallback = {}) {
  if (value === undefined || value === null || value === '') return JSON.stringify(fallback);
  return typeof value === 'string' ? value : JSON.stringify(value);
}

export function parseJson(value, fallback = {}) {
  try {
    if (!value) return fallback;
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

export async function initDb() {
  if (!SQL) {
    SQL = await initSqlJs();
    usersDb = new PersistedSqliteDb('quicklunch_users.db');
    restaurantsDb = new PersistedSqliteDb('quicklunch_restaurants.db');
    coreDb = new PersistedSqliteDb('quicklunch_core.db');
  }

  usersDb.exec(`
    CREATE TABLE IF NOT EXISTS accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      email TEXT UNIQUE,
      phone TEXT,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('admin','restaurant','customer')),
      status TEXT NOT NULL DEFAULT 'active',
      city TEXT NOT NULL DEFAULT 'Cali',
      full_name TEXT,
      document_type TEXT,
      document_number TEXT,
      restaurant_id INTEGER,
      preferences_json TEXT DEFAULT '{}',
      consent_analytics INTEGER DEFAULT 0,
      wallet_balance INTEGER DEFAULT 0,
      coupons_json TEXT DEFAULT '[]',
      favorite_restaurants_json TEXT DEFAULT '[]',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS customer_activity (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      event_type TEXT NOT NULL,
      detail_json TEXT DEFAULT '{}',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS customer_reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      order_id INTEGER,
      report_type TEXT NOT NULL,
      description TEXT,
      penalty_amount INTEGER DEFAULT 0,
      status TEXT DEFAULT 'open',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
  `);

  restaurantsDb.exec(`
    CREATE TABLE IF NOT EXISTS restaurants (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      slug TEXT UNIQUE NOT NULL,
      city TEXT NOT NULL DEFAULT 'Cali',
      address TEXT NOT NULL,
      latitude REAL,
      longitude REAL,
      phone TEXT,
      email TEXT,
      owner_name TEXT,
      owner_document TEXT,
      legal_representative TEXT,
      nit TEXT,
      chamber_commerce TEXT,
      rut TEXT,
      sanitary_concept TEXT,
      firefighter_certificate TEXT,
      land_use_concept TEXT,
      police_opening_notice TEXT,
      food_handler_certificates TEXT,
      personal_data_policy_url TEXT,
      association_valid_until TEXT,
      status TEXT DEFAULT 'active',
      profile_json TEXT DEFAULT '{}',
      design_json TEXT DEFAULT '{}',
      opening_hours_json TEXT DEFAULT '{}',
      settings_json TEXT DEFAULT '{}',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS restaurant_applications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      status TEXT DEFAULT 'pending',
      legal_json TEXT NOT NULL,
      requested_slug TEXT,
      reviewer_notes TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      reviewed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS inventory_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      restaurant_id INTEGER NOT NULL,
      category TEXT NOT NULL CHECK(category IN ('protein','principle','side','drink','dessert','extra','complete_plate')),
      name TEXT NOT NULL,
      description TEXT,
      cost INTEGER DEFAULT 0,
      price INTEGER DEFAULT 0,
      stock INTEGER DEFAULT 0,
      is_special INTEGER DEFAULT 0,
      additional_cost INTEGER DEFAULT 0,
      active INTEGER DEFAULT 1,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS daily_menus (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      restaurant_id INTEGER NOT NULL,
      menu_date TEXT NOT NULL,
      mode TEXT DEFAULT 'customizable' CHECK(mode IN ('customizable','fixed_plates','mixed')),
      title TEXT,
      notes TEXT,
      status TEXT DEFAULT 'draft' CHECK(status IN ('draft','published','closed')),
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS menu_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      menu_id INTEGER NOT NULL,
      inventory_item_id INTEGER,
      category TEXT NOT NULL,
      name TEXT NOT NULL,
      stock INTEGER DEFAULT 0,
      remaining INTEGER DEFAULT 0,
      price_delta INTEGER DEFAULT 0,
      plate_json TEXT DEFAULT '{}'
    );

    CREATE TABLE IF NOT EXISTS coupons (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      restaurant_id INTEGER,
      code TEXT UNIQUE NOT NULL,
      description TEXT,
      discount_type TEXT DEFAULT 'fixed' CHECK(discount_type IN ('fixed','percent')),
      discount_value INTEGER DEFAULT 0,
      max_uses INTEGER DEFAULT 100,
      current_uses INTEGER DEFAULT 0,
      active INTEGER DEFAULT 1,
      expires_at TEXT,
      created_by TEXT DEFAULT 'admin',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
  `);



  function ensureColumn(db, table, column, definition) {
    const existing = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
    if (!existing.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
  ensureColumn(restaurantsDb, 'inventory_items', 'stock', 'INTEGER DEFAULT 0');
  ensureColumn(restaurantsDb, 'inventory_items', 'is_special', 'INTEGER DEFAULT 0');
  ensureColumn(restaurantsDb, 'inventory_items', 'additional_cost', 'INTEGER DEFAULT 0');

  coreDb.exec(`
    CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      public_code TEXT UNIQUE NOT NULL,
      user_id INTEGER NOT NULL,
      restaurant_id INTEGER NOT NULL,
      restaurant_name TEXT,
      customer_name TEXT,
      menu_id INTEGER,
      pickup_slot TEXT NOT NULL,
      payment_method TEXT NOT NULL CHECK(payment_method IN ('online','cash')),
      subtotal INTEGER NOT NULL,
      service_fee INTEGER NOT NULL,
      discount INTEGER DEFAULT 0,
      total INTEGER NOT NULL,
      qr_payload TEXT NOT NULL,
      status TEXT DEFAULT 'reserved' CHECK(status IN ('reserved','preparing','ready','claimed','delayed','cancelled','no_show')),
      items_json TEXT NOT NULL,
      notes TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS payments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER NOT NULL,
      gateway TEXT,
      method_detail TEXT,
      amount INTEGER NOT NULL,
      status TEXT DEFAULT 'pending',
      transaction_ref TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS support_threads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER,
      user_id INTEGER,
      restaurant_id INTEGER,
      subject TEXT,
      status TEXT DEFAULT 'open',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS support_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      thread_id INTEGER NOT NULL,
      sender_role TEXT NOT NULL,
      sender_name TEXT,
      body TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS pickup_slots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      restaurant_id INTEGER NOT NULL,
      slot_time TEXT NOT NULL,
      capacity INTEGER DEFAULT 10,
      reserved INTEGER DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value_json TEXT NOT NULL
    );
  `);

  const adminExists = usersDb.prepare('SELECT id FROM accounts WHERE username = ?').get('nicocr');
  if (!adminExists) {
    const password_hash = bcrypt.hashSync('quick2026', 10);
    usersDb.prepare(`
      INSERT INTO accounts (username, email, password_hash, role, status, city, full_name, consent_analytics, preferences_json)
      VALUES (?, ?, ?, 'admin', 'active', 'Cali', ?, 1, ?)
    `).run('nicocr', 'nicocr@quicklunch.local', password_hash, 'Nico - Administrador QuickLunch', json({ allAccess: true }));
  }

  const defaultSettings = {
    cities: { active: 'Cali', enabled: ['Cali'], comingSoon: ['Pasto', 'Bogotá'] },
    fees: { online: 500, cash: 1000, commissionPercent: 5 },
    pickup: { start: '11:00', end: '14:00', intervalMinutes: 10, maxWindowMinutes: 30, lateNoticeMinutes: 10 },
    legalChecklist: [
      'Matrícula mercantil vigente',
      'RUT/NIT',
      'Concepto sanitario o soporte de condiciones sanitarias',
      'Concepto de uso del suelo',
      'Certificado de seguridad humana y contraincendios/Bomberos',
      'Notificación de apertura a Policía cuando aplique',
      'Certificados o soportes de capacitación en manipulación de alimentos',
      'Política de tratamiento de datos personales'
    ]
  };
  coreDb.prepare('INSERT OR IGNORE INTO app_settings (key, value_json) VALUES (?, ?)').run('quicklunch', json(defaultSettings));
}

export const qlSettings = () => parseJson(coreDb.prepare('SELECT value_json FROM app_settings WHERE key = ?').get('quicklunch')?.value_json, {});
export const serializeRestaurant = (row) => row ? ({ ...row, profile: parseJson(row.profile_json), design: parseJson(row.design_json), openingHours: parseJson(row.opening_hours_json), settings: parseJson(row.settings_json) }) : null;
export const serializeAccount = (row) => row ? ({ ...row, password_hash: undefined, preferences: parseJson(row.preferences_json), coupons: parseJson(row.coupons_json, []), favoriteRestaurants: parseJson(row.favorite_restaurants_json, []) }) : null;
export const jsonString = json;
