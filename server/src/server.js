import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import slugify from 'slugify';
import crypto from 'crypto';
import { z } from 'zod';
import {
  initDb,
  usersDb,
  restaurantsDb,
  coreDb,
  parseJson,
  jsonString,
  qlSettings,
  serializeAccount,
  serializeRestaurant
} from './db.js';

await initDb();

const app = express();
const PORT = process.env.PORT || 4000;
const JWT_SECRET = process.env.JWT_SECRET || 'quicklunch-dev-secret';
const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN || 'http://localhost:5173';

app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
app.use(cors({ origin: CLIENT_ORIGIN, credentials: true }));
app.use(express.json({ limit: '6mb' }));
app.use(morgan('dev'));

function sign(account) {
  return jwt.sign({ id: account.id, username: account.username, role: account.role, city: account.city, restaurant_id: account.restaurant_id }, JWT_SECRET, { expiresIn: '12h' });
}

function auth(requiredRoles = []) {
  return (req, res, next) => {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) return res.status(401).json({ message: 'Sesión requerida.' });
    try {
      const payload = jwt.verify(token, JWT_SECRET);
      const account = usersDb.prepare('SELECT * FROM accounts WHERE id = ?').get(payload.id);
      if (!account || account.status !== 'active') return res.status(401).json({ message: 'Cuenta inactiva o no encontrada.' });
      if (requiredRoles.length && !requiredRoles.includes(account.role)) return res.status(403).json({ message: 'No tienes permisos para esta acción.' });
      req.user = serializeAccount(account);
      next();
    } catch {
      return res.status(401).json({ message: 'Sesión vencida o inválida.' });
    }
  };
}

const appFee = (paymentMethod) => (paymentMethod === 'online' ? qlSettings().fees.online : qlSettings().fees.cash);
const code = (prefix = 'QL') => `${prefix}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
const toSlug = (value) => slugify(value || '', { lower: true, strict: true, locale: 'es' });

function requireCali(city) {
  if (!city || city === 'Cali') return true;
  return false;
}

app.get('/api/health', (_, res) => {
  res.json({ ok: true, name: 'QuickLunch API', city: 'Cali', time: new Date().toISOString() });
});

app.get('/api/settings', (_, res) => res.json(qlSettings()));

app.post('/api/auth/login', (req, res) => {
  const schema = z.object({ username: z.string().min(3), password: z.string().min(6), city: z.string().optional() });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: 'Datos incompletos.' });
  const { username, password, city } = parsed.data;
  if (!requireCali(city)) return res.status(403).json({ message: 'Ciudad próximamente disponible.' });
  const account = usersDb.prepare('SELECT * FROM accounts WHERE username = ? OR email = ?').get(username, username);
  if (!account || !bcrypt.compareSync(password, account.password_hash)) return res.status(401).json({ message: 'Usuario o contraseña incorrectos.' });
  if (account.status !== 'active') return res.status(403).json({ message: 'Cuenta bloqueada o inactiva.' });
  usersDb.prepare('INSERT INTO customer_activity (user_id, event_type, detail_json) VALUES (?, ?, ?)').run(account.id, 'login', jsonString({ city: city || 'Cali', role: account.role }));
  res.json({ token: sign(account), account: serializeAccount(account) });
});

app.post('/api/auth/register', (req, res) => {
  const schema = z.object({
    full_name: z.string().min(3), username: z.string().min(3), email: z.string().email(), phone: z.string().optional(), password: z.string().min(6), consent_analytics: z.boolean().default(false)
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: 'Revisa los datos del registro.' });
  const data = parsed.data;
  const hash = bcrypt.hashSync(data.password, 10);
  try {
    const info = usersDb.prepare(`INSERT INTO accounts (username,email,phone,password_hash,role,full_name,consent_analytics,city,preferences_json) VALUES (?,?,?,?, 'customer',?,?, 'Cali', '{}')`).run(data.username, data.email, data.phone || '', hash, data.full_name, data.consent_analytics ? 1 : 0);
    const account = usersDb.prepare('SELECT * FROM accounts WHERE id = ?').get(info.lastInsertRowid);
    res.status(201).json({ token: sign(account), account: serializeAccount(account) });
  } catch (error) {
    res.status(409).json({ message: 'Ese usuario o correo ya existe.' });
  }
});

app.get('/api/me', auth(), (req, res) => res.json(req.user));

app.post('/api/restaurants/apply', (req, res) => {
  const schema = z.object({
    name: z.string().min(2), owner_name: z.string().min(3), owner_document: z.string().min(5), legal_representative: z.string().optional(), nit: z.string().min(4),
    chamber_commerce: z.string().min(4), rut: z.string().min(3), sanitary_concept: z.string().optional(), firefighter_certificate: z.string().optional(),
    land_use_concept: z.string().optional(), police_opening_notice: z.string().optional(), food_handler_certificates: z.string().optional(),
    personal_data_policy_url: z.string().optional(), address: z.string().min(5), city: z.string().default('Cali'), phone: z.string().min(5), email: z.string().email(),
    manager_username: z.string().min(3), manager_password: z.string().min(6), manager_full_name: z.string().min(3)
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: 'Faltan datos legales o administrativos.' });
  if (!requireCali(parsed.data.city)) return res.status(403).json({ message: 'Ciudad próximamente disponible.' });
  const requested_slug = toSlug(parsed.data.name);
  restaurantsDb.prepare('INSERT INTO restaurant_applications (legal_json, requested_slug) VALUES (?, ?)').run(jsonString(parsed.data), requested_slug);
  res.status(201).json({ message: 'Solicitud enviada. QuickLunch revisará la documentación para aprobar o rechazar el restaurante.', requested_slug });
});

app.get('/api/restaurants/public', (req, res) => {
  const rows = restaurantsDb.prepare("SELECT * FROM restaurants WHERE status = 'active' ORDER BY created_at DESC").all().map(serializeRestaurant);
  res.json(rows);
});

app.get('/api/restaurants/:slug/public', (req, res) => {
  const restaurant = serializeRestaurant(restaurantsDb.prepare("SELECT * FROM restaurants WHERE slug = ? AND status = 'active'").get(req.params.slug));
  if (!restaurant) return res.status(404).json({ message: 'Restaurante no encontrado.' });
  const today = new Date().toISOString().slice(0, 10);
  const menu = restaurantsDb.prepare("SELECT * FROM daily_menus WHERE restaurant_id = ? AND menu_date = ? AND status = 'published' ORDER BY id DESC LIMIT 1").get(restaurant.id, today);
  const items = menu ? restaurantsDb.prepare('SELECT * FROM menu_items WHERE menu_id = ?').all(menu.id).map((x) => ({ ...x, plate: parseJson(x.plate_json) })) : [];
  res.json({ restaurant, menu: menu ? { ...menu, items } : null });
});

app.get('/api/restaurants/:id/slots', (req, res) => {
  const date = req.query.date || new Date().toISOString().slice(0, 10);
  const settings = qlSettings().pickup;
  const slots = [];
  const [startH, startM] = settings.start.split(':').map(Number);
  const [endH, endM] = settings.end.split(':').map(Number);
  const base = new Date(`${date}T00:00:00`);
  let cursor = new Date(base); cursor.setHours(startH, startM, 0, 0);
  const end = new Date(base); end.setHours(endH, endM, 0, 0);
  while (cursor <= end) {
    const slot = cursor.toTimeString().slice(0, 5);
    const dbSlot = coreDb.prepare('SELECT * FROM pickup_slots WHERE restaurant_id = ? AND slot_time = ?').get(req.params.id, `${date} ${slot}`);
    slots.push({ time: slot, capacity: dbSlot?.capacity || 10, reserved: dbSlot?.reserved || 0, available: (dbSlot?.capacity || 10) - (dbSlot?.reserved || 0) });
    cursor = new Date(cursor.getTime() + settings.intervalMinutes * 60000);
  }
  res.json(slots);
});

app.post('/api/orders', auth(['customer','admin']), (req, res) => {
  const schema = z.object({
    restaurant_id: z.number(), menu_id: z.number().optional().nullable(), pickup_date: z.string(), pickup_time: z.string(), payment_method: z.enum(['online','cash']), items: z.array(z.any()).min(1), notes: z.string().optional(), coupon_code: z.string().optional()
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: 'Pedido incompleto.' });
  const data = parsed.data;
  const restaurant = restaurantsDb.prepare('SELECT * FROM restaurants WHERE id = ?').get(data.restaurant_id);
  if (!restaurant) return res.status(404).json({ message: 'Restaurante no encontrado.' });
  const subtotal = data.items.reduce((sum, item) => sum + Number(item.price || item.price_delta || 0), 0) || 12000;
  let discount = 0;
  if (data.coupon_code) {
    const coupon = restaurantsDb.prepare('SELECT * FROM coupons WHERE code = ? AND active = 1').get(data.coupon_code.toUpperCase());
    if (coupon && (!coupon.restaurant_id || coupon.restaurant_id === data.restaurant_id) && coupon.current_uses < coupon.max_uses) {
      discount = coupon.discount_type === 'percent' ? Math.round(subtotal * coupon.discount_value / 100) : coupon.discount_value;
      restaurantsDb.prepare('UPDATE coupons SET current_uses = current_uses + 1 WHERE id = ?').run(coupon.id);
    }
  }
  const service_fee = appFee(data.payment_method);
  const total = Math.max(0, subtotal + service_fee - discount);
  const public_code = code('QL');
  const pickup_slot = `${data.pickup_date} ${data.pickup_time}`;
  const qr_payload = JSON.stringify({ public_code, restaurant_id: data.restaurant_id, pickup_slot, rule: 'NO_ENTREGA_SIN_ESCANEO' });
  const info = coreDb.prepare(`INSERT INTO orders (public_code,user_id,restaurant_id,restaurant_name,customer_name,menu_id,pickup_slot,payment_method,subtotal,service_fee,discount,total,qr_payload,items_json,notes) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(public_code, req.user.id, data.restaurant_id, restaurant.name, req.user.full_name || req.user.username, data.menu_id || null, pickup_slot, data.payment_method, subtotal, service_fee, discount, total, qr_payload, jsonString(data.items, []), data.notes || '');
  const existingSlot = coreDb.prepare('SELECT * FROM pickup_slots WHERE restaurant_id = ? AND slot_time = ?').get(data.restaurant_id, pickup_slot);
  if (existingSlot) coreDb.prepare('UPDATE pickup_slots SET reserved = reserved + 1 WHERE id = ?').run(existingSlot.id);
  else coreDb.prepare('INSERT INTO pickup_slots (restaurant_id, slot_time, capacity, reserved) VALUES (?, ?, 10, 1)').run(data.restaurant_id, pickup_slot);
  if (data.payment_method === 'online') {
    coreDb.prepare('INSERT INTO payments (order_id,gateway,method_detail,amount,status,transaction_ref) VALUES (?, ?, ?, ?, ?, ?)').run(info.lastInsertRowid, 'QuickLunch Demo Gateway', 'PSE/Nequi/Tarjeta demo', total, 'paid', code('PAY'));
  }
  usersDb.prepare('INSERT INTO customer_activity (user_id, event_type, detail_json) VALUES (?, ?, ?)').run(req.user.id, 'order_created', jsonString({ order_id: info.lastInsertRowid, restaurant_id: data.restaurant_id, total }));
  const order = coreDb.prepare('SELECT * FROM orders WHERE id = ?').get(info.lastInsertRowid);
  res.status(201).json({ ...order, items: parseJson(order.items_json, []), qr: parseJson(order.qr_payload, {}) });
});

app.get('/api/orders/mine', auth(), (req, res) => {
  const rows = req.user.role === 'customer'
    ? coreDb.prepare('SELECT * FROM orders WHERE user_id = ? ORDER BY created_at DESC').all(req.user.id)
    : coreDb.prepare('SELECT * FROM orders ORDER BY created_at DESC LIMIT 100').all();
  res.json(rows.map((o) => ({ ...o, items: parseJson(o.items_json, []) })));
});

app.post('/api/support/threads', auth(), (req, res) => {
  const { order_id, restaurant_id, subject, body } = req.body;
  const info = coreDb.prepare('INSERT INTO support_threads (order_id,user_id,restaurant_id,subject) VALUES (?, ?, ?, ?)').run(order_id || null, req.user.id, restaurant_id || null, subject || 'Soporte QuickLunch');
  coreDb.prepare('INSERT INTO support_messages (thread_id,sender_role,sender_name,body) VALUES (?, ?, ?, ?)').run(info.lastInsertRowid, req.user.role, req.user.full_name || req.user.username, body || 'Necesito soporte con mi pedido.');
  res.status(201).json({ id: info.lastInsertRowid });
});

app.get('/api/support/threads', auth(['admin','restaurant']), (req, res) => {
  const rows = req.user.role === 'restaurant'
    ? coreDb.prepare('SELECT * FROM support_threads WHERE restaurant_id = ? ORDER BY updated_at DESC').all(req.user.restaurant_id)
    : coreDb.prepare('SELECT * FROM support_threads ORDER BY updated_at DESC').all();
  res.json(rows);
});

app.post('/api/support/threads/:id/messages', auth(), (req, res) => {
  coreDb.prepare('INSERT INTO support_messages (thread_id,sender_role,sender_name,body) VALUES (?, ?, ?, ?)').run(req.params.id, req.user.role, req.user.full_name || req.user.username, req.body.body);
  coreDb.prepare('UPDATE support_threads SET updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(req.params.id);
  res.status(201).json({ ok: true });
});

// ADMIN
app.get('/api/admin/dashboard', auth(['admin']), (_, res) => {
  const users = usersDb.prepare('SELECT COUNT(*) count FROM accounts WHERE role = "customer"').get().count;
  const restaurants = restaurantsDb.prepare('SELECT COUNT(*) count FROM restaurants').get().count;
  const pending = restaurantsDb.prepare('SELECT COUNT(*) count FROM restaurant_applications WHERE status = "pending"').get().count;
  const orders = coreDb.prepare('SELECT COUNT(*) count, COALESCE(SUM(total),0) total FROM orders').get();
  const byStatus = coreDb.prepare('SELECT status, COUNT(*) count FROM orders GROUP BY status').all();
  const topRestaurants = coreDb.prepare('SELECT restaurant_name, COUNT(*) orders, COALESCE(SUM(total),0) sales FROM orders GROUP BY restaurant_id ORDER BY orders DESC LIMIT 8').all();
  res.json({ users, restaurants, pendingApplications: pending, orders: orders.count, revenue: orders.total, byStatus, topRestaurants, settings: qlSettings() });
});

app.get('/api/admin/users', auth(['admin']), (_, res) => {
  const rows = usersDb.prepare('SELECT * FROM accounts ORDER BY created_at DESC').all().map(serializeAccount);
  const reportMap = Object.fromEntries(usersDb.prepare('SELECT user_id, COUNT(*) reports, COALESCE(SUM(penalty_amount),0) penalties FROM customer_reports GROUP BY user_id').all().map((r) => [r.user_id, r]));
  const orders = coreDb.prepare('SELECT user_id, COUNT(*) orders, COALESCE(SUM(total),0) spent FROM orders GROUP BY user_id').all();
  const orderMap = Object.fromEntries(orders.map((r) => [r.user_id, r]));
  res.json(rows.map((u) => ({ ...u, metrics: { ...(reportMap[u.id] || { reports: 0, penalties: 0 }), ...(orderMap[u.id] || { orders: 0, spent: 0 }) } })));
});

app.patch('/api/admin/users/:id', auth(['admin']), (req, res) => {
  const allowed = ['status','wallet_balance','coupons_json','preferences_json'];
  const updates = [];
  const values = [];
  for (const key of allowed) {
    if (req.body[key] !== undefined) { updates.push(`${key} = ?`); values.push(typeof req.body[key] === 'object' ? jsonString(req.body[key]) : req.body[key]); }
  }
  if (!updates.length) return res.status(400).json({ message: 'No hay cambios.' });
  values.push(req.params.id);
  usersDb.prepare(`UPDATE accounts SET ${updates.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(...values);
  res.json(serializeAccount(usersDb.prepare('SELECT * FROM accounts WHERE id = ?').get(req.params.id)));
});

app.get('/api/admin/restaurants', auth(['admin']), (_, res) => {
  const rows = restaurantsDb.prepare('SELECT * FROM restaurants ORDER BY created_at DESC').all().map(serializeRestaurant);
  const orderStats = coreDb.prepare('SELECT restaurant_id, COUNT(*) orders, COALESCE(SUM(total),0) sales FROM orders GROUP BY restaurant_id').all();
  const map = Object.fromEntries(orderStats.map((s) => [s.restaurant_id, s]));
  res.json(rows.map((r) => ({ ...r, metrics: map[r.id] || { orders: 0, sales: 0 } })));
});

app.post('/api/admin/restaurants', auth(['admin']), (req, res) => {
  const body = req.body;
  const slug = toSlug(body.slug || body.name);
  try {
    const info = restaurantsDb.prepare(`INSERT INTO restaurants (name,slug,city,address,latitude,longitude,phone,email,owner_name,owner_document,legal_representative,nit,chamber_commerce,rut,sanitary_concept,firefighter_certificate,land_use_concept,police_opening_notice,food_handler_certificates,personal_data_policy_url,association_valid_until,profile_json,design_json,opening_hours_json,settings_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(body.name, slug, body.city || 'Cali', body.address || 'Cali', body.latitude || null, body.longitude || null, body.phone || '', body.email || '', body.owner_name || '', body.owner_document || '', body.legal_representative || '', body.nit || '', body.chamber_commerce || '', body.rut || '', body.sanitary_concept || '', body.firefighter_certificate || '', body.land_use_concept || '', body.police_opening_notice || '', body.food_handler_certificates || '', body.personal_data_policy_url || '', body.association_valid_until || '', jsonString(body.profile || { bio: 'Corrientazo aliado QuickLunch' }), jsonString(body.design || {}), jsonString(body.openingHours || {}), jsonString(body.settings || {}));
    if (body.manager_username && body.manager_password) {
      usersDb.prepare(`INSERT INTO accounts (username,email,password_hash,role,status,city,full_name,restaurant_id,consent_analytics) VALUES (?,?,?,?,?,?,?,?,1)`)
        .run(body.manager_username, body.manager_email || body.email || null, bcrypt.hashSync(body.manager_password, 10), 'restaurant', 'active', body.city || 'Cali', body.manager_full_name || body.owner_name || body.name, info.lastInsertRowid);
    }
    res.status(201).json(serializeRestaurant(restaurantsDb.prepare('SELECT * FROM restaurants WHERE id = ?').get(info.lastInsertRowid)));
  } catch (error) {
    res.status(409).json({ message: 'No se pudo crear. Revisa que el slug, NIT o usuario no estén repetidos.', detail: error.message });
  }
});

app.get('/api/admin/applications', auth(['admin']), (_, res) => {
  const rows = restaurantsDb.prepare('SELECT * FROM restaurant_applications ORDER BY created_at DESC').all().map((r) => ({ ...r, legal: parseJson(r.legal_json) }));
  res.json(rows);
});

app.post('/api/admin/applications/:id/review', auth(['admin']), (req, res) => {
  const { decision, notes } = req.body;
  const appRow = restaurantsDb.prepare('SELECT * FROM restaurant_applications WHERE id = ?').get(req.params.id);
  if (!appRow) return res.status(404).json({ message: 'Solicitud no encontrada.' });
  if (appRow.status !== 'pending') return res.status(409).json({ message: 'La solicitud ya fue revisada.' });
  const data = parseJson(appRow.legal_json);
  if (decision !== 'approved') {
    restaurantsDb.prepare('UPDATE restaurant_applications SET status = ?, reviewer_notes = ?, reviewed_at = CURRENT_TIMESTAMP WHERE id = ?').run('rejected', notes || '', req.params.id);
    return res.json({ message: 'Solicitud rechazada.' });
  }
  const slug = appRow.requested_slug || toSlug(data.name);
  const tx = restaurantsDb.transaction(() => {
    const info = restaurantsDb.prepare(`INSERT INTO restaurants (name,slug,city,address,phone,email,owner_name,owner_document,legal_representative,nit,chamber_commerce,rut,sanitary_concept,firefighter_certificate,land_use_concept,police_opening_notice,food_handler_certificates,personal_data_policy_url,association_valid_until,profile_json,design_json,opening_hours_json,settings_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(data.name, slug, 'Cali', data.address, data.phone, data.email, data.owner_name, data.owner_document, data.legal_representative || data.owner_name, data.nit, data.chamber_commerce, data.rut, data.sanitary_concept || '', data.firefighter_certificate || '', data.land_use_concept || '', data.police_opening_notice || '', data.food_handler_certificates || '', data.personal_data_policy_url || '', data.association_valid_until || '', jsonString({ bio: `${data.name} ahora recibe pedidos inteligentes con QuickLunch.` }), jsonString({ accent: '#ff7a1a' }), jsonString({ monday: '11:00-14:30' }), jsonString({ allowCustomization: true }));
    usersDb.prepare(`INSERT INTO accounts (username,email,password_hash,role,status,city,full_name,restaurant_id,consent_analytics) VALUES (?,?,?,?,?,?,?,?,1)`)
      .run(data.manager_username, data.email, bcrypt.hashSync(data.manager_password, 10), 'restaurant', 'active', 'Cali', data.manager_full_name, info.lastInsertRowid);
    restaurantsDb.prepare('UPDATE restaurant_applications SET status = ?, reviewer_notes = ?, reviewed_at = CURRENT_TIMESTAMP WHERE id = ?').run('approved', notes || 'Aprobado por QuickLunch.', req.params.id);
    return info.lastInsertRowid;
  });
  try {
    const restaurantId = tx();
    res.json({ message: 'Restaurante aprobado y cuenta gestora creada.', restaurant: serializeRestaurant(restaurantsDb.prepare('SELECT * FROM restaurants WHERE id = ?').get(restaurantId)) });
  } catch (error) {
    res.status(409).json({ message: 'No se pudo aprobar. Revisa usuario/slug repetido.', detail: error.message });
  }
});

app.get('/api/admin/analytics', auth(['admin']), (_, res) => {
  const salesByDay = coreDb.prepare("SELECT substr(created_at,1,10) day, COUNT(*) orders, COALESCE(SUM(total),0) sales FROM orders GROUP BY day ORDER BY day DESC LIMIT 15").all().reverse();
  const status = coreDb.prepare('SELECT status, COUNT(*) value FROM orders GROUP BY status').all();
  const payments = coreDb.prepare('SELECT payment_method name, COUNT(*) value FROM orders GROUP BY payment_method').all();
  res.json({ salesByDay, status, payments });
});

// RESTAURANT MANAGER

function getRestaurantId(req) {
  if (req.user?.role === 'restaurant') return req.user.restaurant_id;
  if (req.query?.restaurant_id) return Number(req.query.restaurant_id);
  if (req.body?.restaurant_id) return Number(req.body.restaurant_id);
  const first = restaurantsDb.prepare('SELECT id FROM restaurants ORDER BY id LIMIT 1').get();
  return first?.id || null;
}

function restaurantGuard(req, res, next) {
  if (req.user.role === 'admin') return next();
  if (req.user.role !== 'restaurant') return res.status(403).json({ message: 'Acceso de restaurante requerido.' });
  next();
}

app.get('/api/restaurant/me', auth(['restaurant','admin']), restaurantGuard, (req, res) => {
  const id = getRestaurantId(req);
  const restaurant = serializeRestaurant(restaurantsDb.prepare('SELECT * FROM restaurants WHERE id = ?').get(id));
  res.json({ restaurant });
});

app.put('/api/restaurant/profile', auth(['restaurant','admin']), restaurantGuard, (req, res) => {
  const id = getRestaurantId(req);
  const current = restaurantsDb.prepare('SELECT * FROM restaurants WHERE id = ?').get(id);
  if (!current) return res.status(404).json({ message: 'Restaurante no encontrado.' });
  restaurantsDb.prepare(`UPDATE restaurants SET profile_json = ?, design_json = ?, opening_hours_json = ?, settings_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
    .run(jsonString(req.body.profile || parseJson(current.profile_json)), jsonString(req.body.design || parseJson(current.design_json)), jsonString(req.body.openingHours || parseJson(current.opening_hours_json)), jsonString(req.body.settings || parseJson(current.settings_json)), id);
  res.json(serializeRestaurant(restaurantsDb.prepare('SELECT * FROM restaurants WHERE id = ?').get(id)));
});

app.get('/api/restaurant/inventory', auth(['restaurant','admin']), restaurantGuard, (req, res) => {
  const id = getRestaurantId(req);
  res.json(restaurantsDb.prepare('SELECT * FROM inventory_items WHERE restaurant_id = ? ORDER BY category, name').all(id));
});

app.post('/api/restaurant/inventory', auth(['restaurant','admin']), restaurantGuard, (req, res) => {
  const restaurant_id = getRestaurantId(req);
  const { category, name, description, cost, price } = req.body;
  const info = restaurantsDb.prepare('INSERT INTO inventory_items (restaurant_id,category,name,description,cost,price) VALUES (?,?,?,?,?,?)').run(restaurant_id, category, name, description || '', cost || 0, price || 0);
  res.status(201).json(restaurantsDb.prepare('SELECT * FROM inventory_items WHERE id = ?').get(info.lastInsertRowid));
});

app.patch('/api/restaurant/inventory/:id', auth(['restaurant','admin']), restaurantGuard, (req, res) => {
  const item = restaurantsDb.prepare('SELECT * FROM inventory_items WHERE id = ?').get(req.params.id);
  if (!item) return res.status(404).json({ message: 'Ítem no encontrado.' });
  if (req.user.role === 'restaurant' && item.restaurant_id !== req.user.restaurant_id) return res.status(403).json({ message: 'No autorizado.' });
  restaurantsDb.prepare('UPDATE inventory_items SET category=?, name=?, description=?, cost=?, price=?, active=? WHERE id=?').run(req.body.category || item.category, req.body.name || item.name, req.body.description ?? item.description, req.body.cost ?? item.cost, req.body.price ?? item.price, req.body.active ?? item.active, req.params.id);
  res.json(restaurantsDb.prepare('SELECT * FROM inventory_items WHERE id = ?').get(req.params.id));
});

app.get('/api/restaurant/menus', auth(['restaurant','admin']), restaurantGuard, (req, res) => {
  const id = getRestaurantId(req);
  const menus = restaurantsDb.prepare('SELECT * FROM daily_menus WHERE restaurant_id = ? ORDER BY menu_date DESC, id DESC').all(id);
  res.json(menus.map((menu) => ({ ...menu, items: restaurantsDb.prepare('SELECT * FROM menu_items WHERE menu_id = ?').all(menu.id).map((x) => ({ ...x, plate: parseJson(x.plate_json) })) })));
});

app.post('/api/restaurant/menus', auth(['restaurant','admin']), restaurantGuard, (req, res) => {
  const restaurant_id = getRestaurantId(req);
  const { menu_date, mode, title, notes, items } = req.body;
  const info = restaurantsDb.prepare('INSERT INTO daily_menus (restaurant_id,menu_date,mode,title,notes,status) VALUES (?,?,?,?,?,?)').run(restaurant_id, menu_date, mode || 'customizable', title || 'Menú del día', notes || '', req.body.status || 'published');
  const stmt = restaurantsDb.prepare('INSERT INTO menu_items (menu_id,inventory_item_id,category,name,stock,remaining,price_delta,plate_json) VALUES (?,?,?,?,?,?,?,?)');
  for (const item of items || []) stmt.run(info.lastInsertRowid, item.inventory_item_id || null, item.category || 'complete_plate', item.name, item.stock || 0, item.remaining ?? item.stock ?? 0, item.price_delta || item.price || 0, jsonString(item.plate || {}));
  res.status(201).json({ id: info.lastInsertRowid });
});

app.get('/api/restaurant/orders/live', auth(['restaurant','admin']), restaurantGuard, (req, res) => {
  const id = getRestaurantId(req);
  const rows = coreDb.prepare('SELECT * FROM orders WHERE restaurant_id = ? ORDER BY pickup_slot ASC, created_at ASC LIMIT 200').all(id).map((o) => ({ ...o, items: parseJson(o.items_json, []) }));
  res.json(rows);
});

app.patch('/api/restaurant/orders/:id/status', auth(['restaurant','admin']), restaurantGuard, (req, res) => {
  const order = coreDb.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
  if (!order) return res.status(404).json({ message: 'Pedido no encontrado.' });
  if (req.user.role === 'restaurant' && order.restaurant_id !== req.user.restaurant_id) return res.status(403).json({ message: 'No autorizado.' });
  coreDb.prepare('UPDATE orders SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(req.body.status, req.params.id);
  res.json(coreDb.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id));
});

app.get('/api/restaurant/analytics', auth(['restaurant','admin']), restaurantGuard, (req, res) => {
  const id = getRestaurantId(req);
  const summary = coreDb.prepare('SELECT COUNT(*) orders, COALESCE(SUM(total),0) sales, COALESCE(AVG(total),0) avg_ticket FROM orders WHERE restaurant_id = ?').get(id);
  const frequent = coreDb.prepare('SELECT customer_name, COUNT(*) visits, COALESCE(SUM(total),0) spent FROM orders WHERE restaurant_id = ? GROUP BY user_id ORDER BY visits DESC LIMIT 10').all(id);
  const menuPreferences = coreDb.prepare('SELECT items_json FROM orders WHERE restaurant_id = ?').all(id).flatMap((r) => parseJson(r.items_json, []).map((i) => i.name || i.category));
  const counts = Object.entries(menuPreferences.reduce((a, x) => ({ ...a, [x]: (a[x] || 0) + 1 }), {})).map(([name, value]) => ({ name, value })).sort((a,b) => b.value - a.value).slice(0, 8);
  res.json({ summary, frequent, preferences: counts, aiTips: [
    'Recomienda menú personalizable: aumenta la sensación de control del cliente y reduce fricción en recompra.',
    'Publica stock real antes de las 10:45 a.m. para que los cupos de 11:00 a 14:00 se llenen con anticipación.',
    'Activa cupones para clientes frecuentes con 3 o más pedidos en la semana.'
  ]});
});

app.post('/api/restaurant/coupons', auth(['restaurant','admin']), restaurantGuard, (req, res) => {
  const restaurant_id = getRestaurantId(req);
  const codeValue = (req.body.code || code('CUPON')).toUpperCase();
  const info = restaurantsDb.prepare('INSERT INTO coupons (restaurant_id,code,description,discount_type,discount_value,max_uses,expires_at,created_by) VALUES (?,?,?,?,?,?,?,?)')
    .run(restaurant_id, codeValue, req.body.description || 'Cupón QuickLunch', req.body.discount_type || 'fixed', req.body.discount_value || 1000, req.body.max_uses || 50, req.body.expires_at || null, req.user.role);
  res.status(201).json(restaurantsDb.prepare('SELECT * FROM coupons WHERE id = ?').get(info.lastInsertRowid));
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ message: 'Error interno de QuickLunch.', detail: err.message });
});

app.listen(PORT, () => console.log(`QuickLunch API corriendo en http://localhost:${PORT}`));
