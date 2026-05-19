import initSqlJs from 'sql.js';
import bcrypt from 'bcryptjs';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const dataDir = path.join(__dirname, '..', 'data');
export const uploadDir = path.join(__dirname, '..', 'uploads');
fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(uploadDir, { recursive: true });

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
    this.filepath = path.join(dataDir, filename);
    if (fs.existsSync(this.filepath)) {
      this.db = new SQL.Database(fs.readFileSync(this.filepath));
    } else {
      this.db = new SQL.Database();
      this.persist();
    }
  }
  persist() { fs.writeFileSync(this.filepath, Buffer.from(this.db.export())); }
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
    const params = (args) => Array.isArray(args[0]) ? args[0] : args;
    return {
      run(...args) {
        const stmt = self.db.prepare(sql);
        stmt.bind(params(args));
        while (stmt.step()) {}
        stmt.free();
        const rows = self.db.exec('SELECT last_insert_rowid() AS id');
        const lastInsertRowid = rows?.[0]?.values?.[0]?.[0] ?? 0;
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

export function parseJson(value, fallback = {}) {
  try {
    if (value === undefined || value === null || value === '') return fallback;
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

export function jsonString(value, fallback = {}) {
  if (value === undefined || value === null || value === '') return JSON.stringify(fallback);
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function ensureColumn(db, table, column, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}



function tableSql(db, table) {
  return db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table)?.sql || '';
}

function tableColumns(db, table) {
  try { return db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name); }
  catch { return []; }
}

function pick(row, key, fallback = null) {
  return Object.prototype.hasOwnProperty.call(row, key) && row[key] !== undefined ? row[key] : fallback;
}

function mapLegacyRole(role) {
  if (role === 'restaurant') return 'restaurant_owner';
  if (['owner','admin','restaurant_owner','restaurant_staff','customer'].includes(role)) return role;
  return 'customer';
}

function createModernAccountsTable(db) {
  db.exec(`
    CREATE TABLE accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      email TEXT UNIQUE,
      phone TEXT,
      password_hash TEXT NOT NULL,
      password_plain TEXT,
      role TEXT NOT NULL DEFAULT 'customer',
      role_label TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      city TEXT NOT NULL DEFAULT 'Cali',
      full_name TEXT,
      document_type TEXT,
      document_number TEXT,
      restaurant_id INTEGER,
      preferences_json TEXT DEFAULT '{}',
      permissions_json TEXT DEFAULT '{}',
      consent_analytics INTEGER DEFAULT 0,
      wallet_balance INTEGER DEFAULT 0,
      coupons_json TEXT DEFAULT '[]',
      favorite_restaurants_json TEXT DEFAULT '[]',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
  `);
}

function createModernInventoryTable(db) {
  db.exec(`
    CREATE TABLE inventory_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      restaurant_id INTEGER NOT NULL,
      category TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      cost INTEGER DEFAULT 0,
      price INTEGER DEFAULT 0,
      stock INTEGER DEFAULT 0,
      is_special INTEGER DEFAULT 0,
      additional_cost INTEGER DEFAULT 0,
      image_url TEXT,
      image_source TEXT DEFAULT 'none',
      active INTEGER DEFAULT 1,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
  `);
}

function migrateLegacySchemas() {
  // v1.0.2 had a SQLite CHECK constraint that only allowed admin/restaurant/customer.
  // When files are replaced through GitHub, server/data can remain with the old schema.
  const accountSql = tableSql(usersDb, 'accounts');
  if (accountSql && /role\s+[^,]*CHECK\s*\(\s*role\s+IN/i.test(accountSql)) {
    console.warn('[QuickLunch] Migrando tabla accounts antigua para soportar roles owner/admin/restaurante/cliente...');
    const rows = usersDb.prepare('SELECT * FROM accounts').all();
    usersDb.exec('DROP TABLE accounts');
    createModernAccountsTable(usersDb);
    const insert = usersDb.prepare(`
      INSERT OR IGNORE INTO accounts
      (id, username, email, phone, password_hash, role, role_label, status, city, full_name, document_type, document_number, restaurant_id, preferences_json, permissions_json, consent_analytics, wallet_balance, coupons_json, favorite_restaurants_json, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `);
    for (const r of rows) {
      const role = mapLegacyRole(pick(r, 'role', 'customer'));
      insert.run(
        pick(r, 'id'), pick(r, 'username'), pick(r, 'email'), pick(r, 'phone'), pick(r, 'password_hash'), role,
        pick(r, 'role_label') || (role === 'restaurant_owner' ? 'Dueño de restaurante' : role),
        pick(r, 'status', 'active'), pick(r, 'city', 'Cali'), pick(r, 'full_name'), pick(r, 'document_type'), pick(r, 'document_number'), pick(r, 'restaurant_id'),
        pick(r, 'preferences_json', '{}'), pick(r, 'permissions_json', '{}'), pick(r, 'consent_analytics', 0), pick(r, 'wallet_balance', 0),
        pick(r, 'coupons_json', '[]'), pick(r, 'favorite_restaurants_json', '[]'), pick(r, 'created_at'), pick(r, 'updated_at')
      );
    }
  }

  // v1.0.2 inventory blocked the new category soup through CHECK(category IN ...).
  const inventorySql = tableSql(restaurantsDb, 'inventory_items');
  if (inventorySql && /category\s+[^,]*CHECK\s*\(\s*category\s+IN/i.test(inventorySql)) {
    console.warn('[QuickLunch] Migrando inventario antiguo para permitir sopas, especiales, imágenes y adicionales...');
    const rows = restaurantsDb.prepare('SELECT * FROM inventory_items').all();
    restaurantsDb.exec('DROP TABLE inventory_items');
    createModernInventoryTable(restaurantsDb);
    const insert = restaurantsDb.prepare(`
      INSERT OR IGNORE INTO inventory_items
      (id, restaurant_id, category, name, description, cost, price, stock, is_special, additional_cost, image_url, image_source, active, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `);
    for (const r of rows) {
      insert.run(
        pick(r, 'id'), pick(r, 'restaurant_id'), pick(r, 'category', 'protein'), pick(r, 'name'), pick(r, 'description'),
        pick(r, 'cost', 0), pick(r, 'price', 0), pick(r, 'stock', 0), pick(r, 'is_special', 0), pick(r, 'additional_cost', 0),
        pick(r, 'image_url'), pick(r, 'image_source', 'none'), pick(r, 'active', 1), pick(r, 'created_at'), pick(r, 'updated_at')
      );
    }
  }
}

function ensureTables() {
  usersDb.exec(`
    CREATE TABLE IF NOT EXISTS accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      email TEXT UNIQUE,
      phone TEXT,
      password_hash TEXT NOT NULL,
      password_plain TEXT,
      role TEXT NOT NULL DEFAULT 'customer',
      role_label TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      city TEXT NOT NULL DEFAULT 'Cali',
      full_name TEXT,
      document_type TEXT,
      document_number TEXT,
      restaurant_id INTEGER,
      preferences_json TEXT DEFAULT '{}',
      permissions_json TEXT DEFAULT '{}',
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

    CREATE TABLE IF NOT EXISTS restaurant_credits (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      restaurant_id INTEGER NOT NULL,
      balance INTEGER DEFAULT 0,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(user_id, restaurant_id)
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
      prestige_points INTEGER DEFAULT 0,
      penalty_count_month INTEGER DEFAULT 0,
      profile_json TEXT DEFAULT '{}',
      design_json TEXT DEFAULT '{}',
      opening_hours_json TEXT DEFAULT '{}',
      settings_json TEXT DEFAULT '{}',
      fees_json TEXT DEFAULT '{}',
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
      category TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      cost INTEGER DEFAULT 0,
      price INTEGER DEFAULT 0,
      stock INTEGER DEFAULT 0,
      is_special INTEGER DEFAULT 0,
      additional_cost INTEGER DEFAULT 0,
      image_url TEXT,
      image_source TEXT DEFAULT 'none',
      active INTEGER DEFAULT 1,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS daily_menus (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      restaurant_id INTEGER NOT NULL,
      menu_date TEXT NOT NULL,
      mode TEXT DEFAULT 'customizable',
      title TEXT,
      notes TEXT,
      base_price INTEGER DEFAULT 15000,
      sell_soup_separately INTEGER DEFAULT 0,
      soup_price INTEGER DEFAULT 6000,
      sell_tray_separately INTEGER DEFAULT 0,
      tray_price INTEGER DEFAULT 13000,
      max_lunches_per_order INTEGER DEFAULT 10,
      status TEXT DEFAULT 'draft',
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
      price INTEGER DEFAULT 0,
      is_special INTEGER DEFAULT 0,
      image_url TEXT,
      plate_json TEXT DEFAULT '{}'
    );

    CREATE TABLE IF NOT EXISTS coupons (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      restaurant_id INTEGER,
      code TEXT UNIQUE NOT NULL,
      name TEXT,
      description TEXT,
      starts_at TEXT,
      ends_at TEXT,
      discount_type TEXT DEFAULT 'fixed',
      discount_value INTEGER DEFAULT 0,
      effect_type TEXT DEFAULT 'discount_fixed',
      effect_value INTEGER DEFAULT 0,
      effect_scope TEXT DEFAULT 'restaurant',
      coverage_restaurants_json TEXT DEFAULT '[]',
      products_json TEXT DEFAULT '[]',
      min_purchase INTEGER DEFAULT 0,
      previous_purchases_required INTEGER DEFAULT 0,
      service_effect_type TEXT,
      service_effect_value INTEGER DEFAULT 0,
      max_uses INTEGER DEFAULT 100,
      unlimited_uses INTEGER DEFAULT 0,
      current_uses INTEGER DEFAULT 0,
      auto_apply INTEGER DEFAULT 0,
      is_redeemable INTEGER DEFAULT 1,
      is_promotion INTEGER DEFAULT 0,
      active INTEGER DEFAULT 1,
      expires_at TEXT,
      created_by TEXT DEFAULT 'admin',
      creator_role TEXT,
      creator_user_id INTEGER,
      creator_restaurant_id INTEGER,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS coupon_wallet (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      coupon_id INTEGER NOT NULL,
      restaurant_id INTEGER,
      code TEXT NOT NULL,
      effect_scope TEXT DEFAULT 'restaurant',
      credit_balance INTEGER DEFAULT 0,
      redeemed_at TEXT DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(user_id, coupon_id)
    );

    CREATE TABLE IF NOT EXISTS restaurant_penalties (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      restaurant_id INTEGER NOT NULL,
      order_id INTEGER,
      reason TEXT NOT NULL,
      points INTEGER DEFAULT 0,
      tax_percent INTEGER DEFAULT 0,
      tax_amount INTEGER DEFAULT 0,
      appealed INTEGER DEFAULT 0,
      appeal_text TEXT,
      status TEXT DEFAULT 'applied',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS restaurant_ratings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      restaurant_id INTEGER NOT NULL,
      order_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      rating INTEGER NOT NULL,
      comment TEXT,
      points_delta INTEGER DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(order_id, user_id)
    );
  `);

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
      payment_method TEXT NOT NULL,
      payment_status TEXT DEFAULT 'pending',
      subtotal INTEGER NOT NULL,
      service_fee INTEGER NOT NULL,
      discount INTEGER DEFAULT 0,
      total INTEGER NOT NULL,
      lunch_count INTEGER DEFAULT 1,
      qr_payload TEXT NOT NULL,
      status TEXT DEFAULT 'reserved',
      items_json TEXT NOT NULL,
      notes TEXT,
      claimed_at TEXT,
      cancelled_at TEXT,
      completed_at TEXT,
      delayed_at TEXT,
      commission_settled INTEGER DEFAULT 0,
      settlement_amount INTEGER DEFAULT 0,
      delivery_validation_json TEXT DEFAULT '{}',
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
      support_type TEXT,
      subject TEXT,
      status TEXT DEFAULT 'open',
      attachments_json TEXT DEFAULT '[]',
      restaurant_involved INTEGER DEFAULT 0,
      resolution_json TEXT DEFAULT '{}',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS support_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      thread_id INTEGER NOT NULL,
      sender_role TEXT NOT NULL,
      sender_name TEXT,
      channel TEXT DEFAULT 'customer',
      body TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS pickup_slots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      restaurant_id INTEGER NOT NULL,
      slot_time TEXT NOT NULL,
      capacity INTEGER DEFAULT 10,
      reserved INTEGER DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(restaurant_id, slot_time)
    );

    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value_json TEXT NOT NULL
    );
  `);

  // Safe migrations from earlier project versions.
  [
    ['accounts', 'role_label', 'TEXT'], ['accounts', 'permissions_json', "TEXT DEFAULT '{}'"], ['accounts','password_plain','TEXT'],
  ].forEach(([table, col, def]) => ensureColumn(usersDb, table, col, def));
  [
    ['restaurants','prestige_points','INTEGER DEFAULT 0'], ['restaurants','penalty_count_month','INTEGER DEFAULT 0'], ['restaurants','fees_json',"TEXT DEFAULT '{}'"],
    ['inventory_items','image_url','TEXT'], ['inventory_items','image_source',"TEXT DEFAULT 'none'"], ['inventory_items','updated_at','TEXT'],
    ['daily_menus','base_price','INTEGER DEFAULT 15000'], ['daily_menus','sell_soup_separately','INTEGER DEFAULT 0'], ['daily_menus','soup_price','INTEGER DEFAULT 6000'],
    ['daily_menus','sell_tray_separately','INTEGER DEFAULT 0'], ['daily_menus','tray_price','INTEGER DEFAULT 13000'], ['daily_menus','max_lunches_per_order','INTEGER DEFAULT 10'],
    ['menu_items','price','INTEGER DEFAULT 0'], ['menu_items','is_special','INTEGER DEFAULT 0'], ['menu_items','image_url','TEXT'],
    ['coupons','name','TEXT'], ['coupons','starts_at','TEXT'], ['coupons','ends_at','TEXT'], ['coupons','effect_type',"TEXT DEFAULT 'discount_fixed'"], ['coupons','effect_value','INTEGER DEFAULT 0'],
    ['coupons','effect_scope',"TEXT DEFAULT 'restaurant'"], ['coupons','coverage_restaurants_json',"TEXT DEFAULT '[]'"], ['coupons','products_json',"TEXT DEFAULT '[]'"], ['coupons','min_purchase','INTEGER DEFAULT 0'], ['coupons','previous_purchases_required','INTEGER DEFAULT 0'],
    ['coupons','service_effect_type','TEXT'], ['coupons','service_effect_value','INTEGER DEFAULT 0'], ['coupons','unlimited_uses','INTEGER DEFAULT 0'], ['coupons','auto_apply','INTEGER DEFAULT 0'], ['coupons','is_redeemable','INTEGER DEFAULT 1'], ['coupons','is_promotion','INTEGER DEFAULT 0'],
    ['coupons','creator_role','TEXT'], ['coupons','creator_user_id','INTEGER'], ['coupons','creator_restaurant_id','INTEGER']
  ].forEach(([table, col, def]) => ensureColumn(restaurantsDb, table, col, def));
  [
    ['orders','payment_status',"TEXT DEFAULT 'pending'"], ['orders','lunch_count','INTEGER DEFAULT 1'], ['orders','claimed_at','TEXT'], ['orders','cancelled_at','TEXT'], ['orders','completed_at','TEXT'], ['orders','delayed_at','TEXT'],
    ['orders','commission_settled','INTEGER DEFAULT 0'], ['orders','settlement_amount','INTEGER DEFAULT 0'], ['orders','delivery_validation_json',"TEXT DEFAULT '{}'"],
    ['support_threads','support_type','TEXT'], ['support_threads','attachments_json',"TEXT DEFAULT '[]'"], ['support_threads','restaurant_involved','INTEGER DEFAULT 0'], ['support_threads','resolution_json',"TEXT DEFAULT '{}'"], ['support_messages','channel',"TEXT DEFAULT 'customer'"]
  ].forEach(([table, col, def]) => ensureColumn(coreDb, table, col, def));
}

function ensureSeedData() {
  const passwordHash = bcrypt.hashSync('quick2026', 10);
  const current = usersDb.prepare('SELECT * FROM accounts WHERE username = ?').get('nicocr');
  if (!current) {
    usersDb.prepare(`
      INSERT INTO accounts (username,email,password_hash,password_plain,role,role_label,status,city,full_name,consent_analytics,preferences_json,permissions_json)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
    `).run('nicocr', 'nicocr@quicklunch.local', passwordHash, 'quick2026', 'owner', 'Owner QuickLunch', 'active', 'Cali', 'Nico - Owner QuickLunch', 1, jsonString({ allAccess: true }), jsonString({ allAccess: true }));
  } else {
    usersDb.prepare(`UPDATE accounts SET role='owner', role_label='Owner QuickLunch', password_hash=?, password_plain='quick2026', permissions_json=?, status='active' WHERE username='nicocr'`)
      .run(passwordHash, jsonString({ allAccess: true }));
  }

  const defaultSettings = {
    cities: { active: 'Cali', enabled: ['Cali'], comingSoon: ['Pasto', 'Bogotá'] },
    fees: { online: 500, cash: 1000, commissionPercent: 5 },
    pickup: { start: '11:00', end: '14:00', intervalMinutes: 10, capacity: 10, maxWindowMinutes: 30, cancellationLimitMinutes: 60, delayCancelMinutes: 20 },
    roles: {
      owner: 'Acceso total a administradores, usuarios, restaurantes, roles y comisiones.',
      admin: 'Acceso al panel administrativo, usuarios y restaurantes, sin poder crear roles administrativos ni usar panel de restaurante.',
      restaurant_owner: 'Dueño del restaurante con acceso total al panel de su restaurante.',
      restaurant_staff: 'Cajero/operador: menús, pedidos y QR, sin ingresos ni estadísticas.',
      customer: 'Cliente final: restaurantes, pedidos, cupones, soporte e historial.'
    },
    legalChecklist: [
      'Matrícula mercantil vigente / Registro en Cámara de Comercio',
      'RUT/NIT actualizado',
      'Concepto sanitario o soporte de condiciones sanitarias',
      'Concepto de uso del suelo',
      'Certificado de Bomberos / seguridad humana',
      'Aviso de apertura a autoridad cuando aplique',
      'Certificados o soportes de manipulación de alimentos',
      'Política de tratamiento de datos personales'
    ],
    faqs: {
      preparing: ['Tu pedido ya entró a cocina. En esta etapa no se puede cancelar porque el restaurante ya inició la preparación.', 'Acércate a la hora reservada y espera el aviso de listo o la notificación de QR.'],
      ready: ['Tu pedido está listo. Dirígete al restaurante y presenta el QR.', 'Si pagas en caja, paga antes de que el cajero escanee el QR.'],
      claimed: ['Puedes reportar calidad, producto incompleto o diferencia con lo pedido.', 'Adjunta una foto clara si necesitas revisión de soporte.']
    }
  };
  coreDb.prepare('INSERT OR IGNORE INTO app_settings (key,value_json) VALUES (?,?)').run('quicklunch', jsonString(defaultSettings));
}

export async function initDb() {
  if (!SQL) {
    SQL = await initSqlJs();
    usersDb = new PersistedSqliteDb('quicklunch_users.db');
    restaurantsDb = new PersistedSqliteDb('quicklunch_restaurants.db');
    coreDb = new PersistedSqliteDb('quicklunch_core.db');
  }
  migrateLegacySchemas();
  ensureTables();
  ensureSeedData();
}

export const qlSettings = () => parseJson(coreDb.prepare('SELECT value_json FROM app_settings WHERE key = ?').get('quicklunch')?.value_json, {});
export const saveQlSettings = (settings) => coreDb.prepare('INSERT OR REPLACE INTO app_settings (key,value_json) VALUES (?,?)').run('quicklunch', jsonString(settings));

export const serializeRestaurant = (row) => row ? ({
  ...row,
  profile: parseJson(row.profile_json),
  design: parseJson(row.design_json),
  openingHours: parseJson(row.opening_hours_json),
  settings: parseJson(row.settings_json),
  fees: parseJson(row.fees_json)
}) : null;

export const serializeAccount = (row) => row ? ({
  ...row,
  password_hash: undefined,
  password_plain: undefined,
  preferences: parseJson(row.preferences_json),
  permissions: parseJson(row.permissions_json),
  coupons: parseJson(row.coupons_json, []),
  favoriteRestaurants: parseJson(row.favorite_restaurants_json, [])
}) : null;
