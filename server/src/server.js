import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import slugify from 'slugify';
import crypto from 'crypto';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import QRCode from 'qrcode';
import { z } from 'zod';
import {
  initDb, usersDb, restaurantsDb, coreDb, parseJson, jsonString, qlSettings, saveQlSettings,
  serializeAccount, serializeRestaurant, uploadDir
} from './db.js';

await initDb();

const app = express();
const PORT = process.env.PORT || 4000;
const JWT_SECRET = process.env.JWT_SECRET || 'quicklunch-dev-secret';
const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN || 'http://localhost:5173';

app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
app.use(cors({ origin: CLIENT_ORIGIN, credentials: true }));
app.use(express.json({ limit: '12mb' }));
app.use(express.urlencoded({ extended: true, limit: '12mb' }));
app.use(morgan('dev'));
app.use('/uploads', express.static(uploadDir));

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const folder = path.join(uploadDir, 'quicklunch');
    fs.mkdirSync(folder, { recursive: true });
    cb(null, folder);
  },
  filename: (req, file, cb) => {
    const safe = slugify(path.parse(file.originalname).name || 'archivo', { lower: true, strict: true }) || 'archivo';
    cb(null, `${Date.now()}-${crypto.randomBytes(3).toString('hex')}-${safe}${path.extname(file.originalname).toLowerCase()}`);
  }
});
const upload = multer({ storage, limits: { fileSize: 5 * 1024 * 1024 }, fileFilter: (_, file, cb) => cb(null, file.mimetype.startsWith('image/')) });

const ROLE_LABELS = {
  owner: 'Owner QuickLunch', admin: 'Administrador QuickLunch', restaurant_owner: 'Dueño de restaurante', restaurant_staff: 'Operador restaurante', customer: 'Cliente'
};
const ADMIN_ROLES = ['owner', 'admin'];
const RESTAURANT_ROLES = ['owner', 'restaurant_owner', 'restaurant_staff'];
const FULL_RESTAURANT_ROLES = ['owner', 'restaurant_owner'];

const code = (prefix = 'QL') => `${prefix}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
const toSlug = (value) => slugify(value || '', { lower: true, strict: true, locale: 'es' });
const moneyInt = (v, fallback = 0) => Number.isFinite(Number(v)) ? Math.max(0, Math.round(Number(v))) : fallback;
const asArray = (v) => Array.isArray(v) ? v : [];
const getToday = () => new Date().toISOString().slice(0, 10);

function sign(account) {
  return jwt.sign({ id: account.id, username: account.username, role: account.role, restaurant_id: account.restaurant_id }, JWT_SECRET, { expiresIn: '12h' });
}

function canAccess(user, required = []) {
  if (!required.length) return true;
  if (user.role === 'owner') return true;
  return required.includes(user.role);
}

function auth(requiredRoles = []) {
  return (req, res, next) => {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : (req.query.token || null);
    if (!token) return res.status(401).json({ message: 'Sesión requerida.' });
    try {
      const payload = jwt.verify(token, JWT_SECRET);
      const account = usersDb.prepare('SELECT * FROM accounts WHERE id = ?').get(payload.id);
      if (!account || account.status !== 'active') return res.status(401).json({ message: 'Cuenta inactiva o no encontrada.' });
      const serialized = serializeAccount(account);
      if (!canAccess(serialized, requiredRoles)) return res.status(403).json({ message: 'No tienes permisos para esta acción.' });
      req.user = serialized;
      next();
    } catch {
      res.status(401).json({ message: 'Sesión vencida o inválida.' });
    }
  };
}

function requireOwner(req, res, next) {
  if (req.user.role !== 'owner') return res.status(403).json({ message: 'Solo un owner puede realizar esta acción.' });
  next();
}

function requireRestaurantFull(req, res, next) {
  if (!FULL_RESTAURANT_ROLES.includes(req.user.role)) return res.status(403).json({ message: 'Solo el dueño del restaurante puede acceder a esta sección.' });
  next();
}

function requireCali(city) {
  return !city || city === 'Cali';
}

function defaultRestaurantSettings(settings = qlSettings()) {
  return {
    baseLunchPrice: 15000,
    pickup: { ranges: [{ start: settings.pickup?.start || '11:00', end: settings.pickup?.end || '14:00', intervalMinutes: settings.pickup?.intervalMinutes || 10, capacity: settings.pickup?.capacity || 10 }], cancellationLimitMinutes: 60, delayCancelMinutes: 20 },
    allowCustomization: true,
    maxLunchesPerOrder: 10
  };
}

function defaultFees() {
  const s = qlSettings();
  return { online: moneyInt(s.fees?.online, 500), cash: moneyInt(s.fees?.cash, 1000), commissionPercent: moneyInt(s.fees?.commissionPercent, 5) };
}

function getRestaurantId(req) {
  if (req.user.role === 'owner') {
    if (req.query.slug) return Number(restaurantsDb.prepare('SELECT id FROM restaurants WHERE slug=?').get(req.query.slug)?.id || 0);
    if (req.query.restaurant_id || req.body.restaurant_id) return Number(req.query.restaurant_id || req.body.restaurant_id);
    return Number(restaurantsDb.prepare('SELECT id FROM restaurants ORDER BY id LIMIT 1').get()?.id || 0);
  }
  return Number(req.user.restaurant_id || req.query.restaurant_id || req.body.restaurant_id || 0);
}

function restaurantGuard(req, res, next) {
  if (req.user.role === 'owner') return next();
  if (!RESTAURANT_ROLES.includes(req.user.role)) return res.status(403).json({ message: 'Acceso de restaurante requerido.' });
  const restaurantId = getRestaurantId(req);
  if (!restaurantId || Number(req.user.restaurant_id) !== Number(restaurantId)) return res.status(403).json({ message: 'Este usuario no pertenece a ese restaurante.' });
  next();
}

function getRestaurantFees(restaurantId) {
  const r = restaurantsDb.prepare('SELECT fees_json FROM restaurants WHERE id = ?').get(restaurantId);
  return { ...defaultFees(), ...parseJson(r?.fees_json, {}) };
}

function calculateFee(paymentMethod, lunchCount, restaurantId) {
  const fees = getRestaurantFees(restaurantId);
  return moneyInt(fees[paymentMethod] || defaultFees()[paymentMethod]) * Math.max(1, moneyInt(lunchCount, 1));
}

function parseSlotDate(slot) {
  return new Date(slot.replace(' ', 'T'));
}

function canCustomerCancel(order) {
  const now = new Date();
  const pickup = parseSlotDate(order.pickup_slot);
  const diffMin = (pickup.getTime() - now.getTime()) / 60000;
  if (order.status === 'reserved' && diffMin >= 60) return { ok: true, reason: 'Cancelación permitida hasta 1 hora antes.' };
  if (order.status === 'delayed' && order.delayed_at) {
    const delayedMin = (now.getTime() - new Date(order.delayed_at.replace(' ', 'T')).getTime()) / 60000;
    if (delayedMin >= 20) return { ok: true, reason: 'Demora mayor a 20 minutos.' };
  }
  return { ok: false, reason: 'Este pedido ya no se puede cancelar desde la app.' };
}

function addRestaurantCredit(userId, restaurantId, amount) {
  const existing = usersDb.prepare('SELECT * FROM restaurant_credits WHERE user_id=? AND restaurant_id=?').get(userId, restaurantId);
  if (existing) usersDb.prepare('UPDATE restaurant_credits SET balance=balance+?, updated_at=CURRENT_TIMESTAMP WHERE id=?').run(amount, existing.id);
  else usersDb.prepare('INSERT INTO restaurant_credits (user_id,restaurant_id,balance) VALUES (?,?,?)').run(userId, restaurantId, amount);
}

function releaseSlot(order) {
  if (!order.pickup_slot) return;
  coreDb.prepare('UPDATE pickup_slots SET reserved = CASE WHEN reserved > 0 THEN reserved - ? ELSE 0 END WHERE restaurant_id=? AND slot_time=?')
    .run(Math.max(1, Number(order.lunch_count || 1)), order.restaurant_id, order.pickup_slot);
}

function applyPenalty(restaurantId, orderId, reason, points, taxPercent = 0) {
  const periodSales = coreDb.prepare("SELECT COALESCE(SUM(subtotal),0) total FROM orders WHERE restaurant_id=? AND status='claimed' AND substr(claimed_at,1,10) >= date('now','-7 day')").get(restaurantId).total || 0;
  const taxAmount = Math.round(periodSales * taxPercent / 100);
  restaurantsDb.prepare('INSERT INTO restaurant_penalties (restaurant_id,order_id,reason,points,tax_percent,tax_amount) VALUES (?,?,?,?,?,?)')
    .run(restaurantId, orderId || null, reason, points, taxPercent, taxAmount);
  restaurantsDb.prepare('UPDATE restaurants SET prestige_points = prestige_points + ?, updated_at=CURRENT_TIMESTAMP WHERE id=?').run(points, restaurantId);

  const continuousToday = restaurantsDb.prepare("SELECT COUNT(*) count FROM restaurant_penalties WHERE restaurant_id=? AND points < 0 AND substr(created_at,1,10)=date('now')").get(restaurantId).count;
  const weekly = restaurantsDb.prepare("SELECT COALESCE(SUM(points),0) points FROM restaurant_penalties WHERE restaurant_id=? AND points < 0 AND created_at >= datetime('now','-7 day')").get(restaurantId).points;
  if (continuousToday >= 5 || Math.abs(Number(weekly || 0)) >= 20) {
    const tax = Math.round(periodSales * 0.10);
    restaurantsDb.prepare('INSERT INTO restaurant_penalties (restaurant_id,order_id,reason,points,tax_percent,tax_amount) VALUES (?,?,?,?,?,?)')
      .run(restaurantId, null, continuousToday >= 5 ? 'Castigo por 5 incumplimientos continuos en el día' : 'Castigo por 20 puntos negativos semanales', 0, 10, tax);
    restaurantsDb.prepare('UPDATE restaurants SET penalty_count_month = penalty_count_month + 1 WHERE id=?').run(restaurantId);
  }
  const monthCount = restaurantsDb.prepare("SELECT penalty_count_month FROM restaurants WHERE id=?").get(restaurantId)?.penalty_count_month || 0;
  if (monthCount >= 3) restaurantsDb.prepare("UPDATE restaurants SET status='disabled' WHERE id=?").run(restaurantId);
}

function settleIfClaimed(orderId) {
  const o = coreDb.prepare('SELECT * FROM orders WHERE id=?').get(orderId);
  if (!o || o.status !== 'claimed' || o.commission_settled) return;
  coreDb.prepare('UPDATE orders SET commission_settled=1, settlement_amount=?, completed_at=CURRENT_TIMESTAMP WHERE id=?').run(o.subtotal, orderId);
}

function serializeOrder(row) {
  return row ? { ...row, items: parseJson(row.items_json, []), qr: parseJson(row.qr_payload, {}), deliveryValidation: parseJson(row.delivery_validation_json, {}) } : null;
}

function groupedOrders(rows) {
  return rows.reduce((acc, row) => {
    const key = row.pickup_slot;
    if (!acc[key]) acc[key] = [];
    acc[key].push(serializeOrder(row));
    return acc;
  }, {});
}

function couponActive(c) {
  const now = new Date();
  if (!c || !Number(c.active)) return false;
  if (c.starts_at && new Date(c.starts_at.replace(' ', 'T')) > now) return false;
  const end = c.ends_at || c.expires_at;
  if (end && new Date(end.replace(' ', 'T')) < now) return false;
  if (!Number(c.unlimited_uses) && Number(c.max_uses || 0) > 0 && Number(c.current_uses || 0) >= Number(c.max_uses || 0)) return false;
  return true;
}

function couponCanCover(c, restaurantId) {
  if (!c.restaurant_id && c.effect_scope === 'app') return true;
  if (Number(c.restaurant_id || 0) === Number(restaurantId)) return true;
  const group = parseJson(c.coverage_restaurants_json, []).map(Number);
  return group.includes(Number(restaurantId));
}

function couponLabel(c) {
  if (!c) return null;
  if (c.effect_type === 'credit_fixed') return 'Saldo GRATIS';
  if (c.effect_type === 'discount_fixed') return 'Saldo descontable';
  if (c.effect_type === 'discount_percent') return `Descuento ${c.effect_value || c.discount_value}%`;
  if (c.effect_type === 'service_free') return 'Servicio gratis';
  if (c.effect_type === 'service_percent') return 'Servicio descuento';
  return 'Promoción';
}

function couponWeight(c) {
  if (!c) return 0;
  if (c.effect_type === 'credit_fixed' && (c.effect_scope === 'app' || !c.restaurant_id)) return 60;
  if (c.effect_type === 'discount_fixed' && !parseJson(c.products_json, []).length) return 50;
  if (c.effect_type === 'credit_fixed') return 45;
  if (c.effect_type === 'discount_percent' && !parseJson(c.products_json, []).length) return 40;
  if (c.effect_type === 'discount_fixed') return 35;
  if (c.effect_type === 'discount_percent') return 30;
  if (c.effect_type === 'service_free') return 20;
  if (c.effect_type === 'service_percent') return 10;
  return 1;
}

function bestPromotion(restaurantId) {
  const rows = restaurantsDb.prepare('SELECT * FROM coupons WHERE active=1 AND is_promotion=1 ORDER BY created_at DESC').all()
    .filter((c) => couponActive(c) && couponCanCover(c, restaurantId));
  return rows.sort((a,b) => couponWeight(b) - couponWeight(a))[0] || null;
}

function serializeCoupon(row) {
  return row ? { ...row, coverageRestaurants: parseJson(row.coverage_restaurants_json, []), products: parseJson(row.products_json, []), promotionBadge: couponLabel(row) } : null;
}

function availableWalletCredits(userId, restaurantId) {
  return restaurantsDb.prepare('SELECT * FROM coupon_wallet WHERE user_id=? AND credit_balance>0 ORDER BY redeemed_at ASC').all(userId)
    .filter((w) => !w.restaurant_id || Number(w.restaurant_id) === Number(restaurantId));
}

function applyCouponCredits(userId, restaurantId, amount) {
  let remaining = amount;
  const used = [];
  for (const w of availableWalletCredits(userId, restaurantId)) {
    if (remaining <= 0) break;
    const take = Math.min(Number(w.credit_balance || 0), remaining);
    restaurantsDb.prepare('UPDATE coupon_wallet SET credit_balance=credit_balance-? WHERE id=?').run(take, w.id);
    remaining -= take;
    used.push({ code: w.code, amount: take });
  }
  return { discount: amount - remaining, used };
}

function automaticDiscounts(userId, restaurantId, subtotal, serviceFee, lunches) {
  const all = restaurantsDb.prepare('SELECT * FROM coupons WHERE active=1 AND is_redeemable=0').all()
    .filter((c) => couponActive(c) && couponCanCover(c, restaurantId));
  let discount = 0; let serviceDiscount = 0; const applied = [];
  const claimedCount = coreDb.prepare("SELECT COUNT(*) count FROM orders WHERE user_id=? AND restaurant_id=? AND status='claimed'").get(userId, restaurantId).count;
  for (const c of all) {
    if (subtotal < Number(c.min_purchase || 0)) continue;
    if (claimedCount < Number(c.previous_purchases_required || 0)) continue;
    let d = 0; let sd = 0;
    if (c.effect_type === 'discount_percent') d = Math.round(subtotal * Number(c.effect_value || c.discount_value || 0) / 100);
    if (c.effect_type === 'discount_fixed') d = Math.min(subtotal, Number(c.effect_value || c.discount_value || 0));
    if (c.effect_type === 'service_free') sd = serviceFee;
    if (c.effect_type === 'service_percent') sd = Math.round(serviceFee * Number(c.effect_value || c.discount_value || 0) / 100);
    if (d || sd) { discount += d; serviceDiscount += sd; applied.push({ code: c.code, name: c.name || c.description, discount: d, serviceDiscount: sd }); }
  }
  return { discount, serviceDiscount, applied };
}

function aiInsightsForSystem() {
  const settings = qlSettings();
  const orders = coreDb.prepare('SELECT status, payment_method, total, service_fee, restaurant_id, created_at FROM orders').all();
  const claimed = orders.filter(o => o.status === 'claimed');
  const delayed = orders.filter(o => o.status === 'delayed').length;
  const cancelled = orders.filter(o => o.status === 'cancelled').length;
  const freeRevenue = claimed.reduce((s,o) => s + Number(o.service_fee || 0), 0);
  const cashRatio = orders.length ? Math.round(orders.filter(o => o.payment_method === 'cash').length * 100 / orders.length) : 0;
  return [
    `Ingresos libres estimados de la app por servicios ya reclamados: ${freeRevenue.toLocaleString('es-CO')} COP.`,
    cashRatio > 50 ? 'Hay alta preferencia por pago en caja: conviene mostrar más fuerte el beneficio de prepago y menor comisión.' : 'El prepago se mantiene competitivo: prioriza restaurantes con buen cumplimiento para reforzar confianza.',
    delayed + cancelled > 0 ? `Se detectaron ${delayed + cancelled} incidencias operativas. Revisa restaurantes con demoras/cancelaciones antes de ampliar cupos.` : 'No hay incidencias críticas registradas: puedes activar campañas de crecimiento o cupones piloto.',
    `Comisiones actuales: prepago ${settings.fees?.online || 500}, caja ${settings.fees?.cash || 1000}. Puedes probar promociones sin tocar la tarifa base.`
  ];
}

function orderSupportOptions(order) {
  if (!order) return [];
  const pickup = parseSlotDate(order.pickup_slot);
  const diffMin = (pickup - new Date()) / 60000;
  if (order.status === 'reserved' && diffMin >= 60) return ['Cancelar pedido', 'Cambiar hora o contenido', 'Consultar cupos', 'Otro problema'];
  if (['preparing', 'ready'].includes(order.status)) return ['FAQ: espera y recogida', 'Pregunta general'];
  if (order.status === 'claimed') return ['Reporte de calidad', 'Producto incompleto', 'Diferencia con el pedido', 'Factura o pago'];
  if (order.status === 'delayed') return ['Consultar demora', 'Solicitar cancelación si supera 20 minutos', 'Apelar cobro'];
  return ['Soporte general'];
}

app.get('/api/health', (_, res) => res.json({ ok: true, name: 'QuickLunch API', version: '1.0.7', time: new Date().toISOString() }));
app.get('/api/settings', (_, res) => res.json(qlSettings()));

app.post('/api/auth/login', (req, res) => {
  const schema = z.object({ username: z.string().min(3), password: z.string().min(6), city: z.string().optional() });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: 'Datos incompletos.' });
  if (!requireCali(parsed.data.city)) return res.status(403).json({ message: 'Ciudad próximamente disponible.' });
  const account = usersDb.prepare('SELECT * FROM accounts WHERE username = ? OR email = ?').get(parsed.data.username, parsed.data.username);
  if (!account || !bcrypt.compareSync(parsed.data.password, account.password_hash)) return res.status(401).json({ message: 'Usuario o contraseña incorrectos.' });
  if (account.status !== 'active') return res.status(403).json({ message: 'Cuenta bloqueada o inactiva.' });
  usersDb.prepare('INSERT INTO customer_activity (user_id,event_type,detail_json) VALUES (?,?,?)').run(account.id, 'login', jsonString({ role: account.role, city: parsed.data.city || 'Cali' }));
  res.json({ token: sign(account), account: serializeAccount(account) });
});

app.post('/api/auth/register', (req, res) => {
  const schema = z.object({ full_name: z.string().min(3), username: z.string().min(3), email: z.string().email(), phone: z.string().optional(), password: z.string().min(6), consent_analytics: z.boolean().default(false) });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: 'Revisa los datos del registro.' });
  const d = parsed.data;
  try {
    const info = usersDb.prepare(`INSERT INTO accounts (username,email,phone,password_hash,password_plain,role,role_label,full_name,consent_analytics,city,preferences_json) VALUES (?,?,?,?,?,?,?,?,?, 'Cali', '{}')`)
      .run(d.username, d.email, d.phone || '', bcrypt.hashSync(d.password, 10), d.password, 'customer', ROLE_LABELS.customer, d.full_name, d.consent_analytics ? 1 : 0);
    const account = usersDb.prepare('SELECT * FROM accounts WHERE id=?').get(info.lastInsertRowid);
    res.status(201).json({ token: sign(account), account: serializeAccount(account) });
  } catch {
    res.status(409).json({ message: 'Ese usuario o correo ya existe.' });
  }
});


app.post('/api/auth/password-recovery', (req, res) => {
  const schema = z.object({ identifier: z.string().min(3) });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: 'Escribe únicamente el usuario.' });
  const account = usersDb.prepare('SELECT * FROM accounts WHERE username=?').get(parsed.data.identifier);
  if (!account) return res.status(404).json({ message: 'No encontramos una cuenta con ese usuario.' });
  const visiblePassword = account.password_plain || (account.username === 'nicocr' ? 'quick2026' : 'No disponible para cuentas antiguas. Cámbiala desde el panel admin.');
  usersDb.prepare('INSERT INTO customer_activity (user_id,event_type,detail_json) VALUES (?,?,?)').run(account.id, 'password_recovery_demo', jsonString({ shown: true }));
  res.json({
    message: 'Recuperación piloto activa. En esta versión demo se muestra la clave al ingresar el usuario, sin verificación adicional.',
    username: account.username,
    recovery_email: account.email || 'Sin correo registrado',
    visible_password: visiblePassword
  });
});

app.get('/api/me', auth(), (req, res) => res.json(req.user));

// PUBLIC RESTAURANTS
app.post('/api/restaurants/apply', (req, res) => {
  const schema = z.object({
    name: z.string().min(2), owner_name: z.string().min(3), owner_document: z.string().min(5), legal_representative: z.string().optional(), nit: z.string().min(4),
    chamber_commerce: z.string().min(4), rut: z.string().min(3), sanitary_concept: z.string().optional(), firefighter_certificate: z.string().optional(),
    land_use_concept: z.string().optional(), police_opening_notice: z.string().optional(), food_handler_certificates: z.string().optional(), personal_data_policy_url: z.string().optional(),
    address: z.string().min(5), city: z.string().default('Cali'), phone: z.string().min(5), email: z.string().email(), manager_username: z.string().min(3), manager_password: z.string().min(6), manager_full_name: z.string().min(3), manager_email: z.string().email().optional(), slug: z.string().optional()
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: 'Faltan datos legales o administrativos. Revisa los campos obligatorios.' });
  if (!requireCali(parsed.data.city)) return res.status(403).json({ message: 'Ciudad próximamente disponible.' });
  const requestedSlug = toSlug(parsed.data.slug || parsed.data.name);
  if (!requestedSlug) return res.status(400).json({ message: 'La dirección URL del restaurante no es válida.' });
  if (restaurantsDb.prepare('SELECT id FROM restaurants WHERE slug=?').get(requestedSlug)) return res.status(409).json({ message: 'Ya existe un restaurante con esa URL. Cambia la dirección URL.' });
  if (usersDb.prepare('SELECT id FROM accounts WHERE username=? OR email=? OR email=?').get(parsed.data.manager_username, parsed.data.manager_email || '', parsed.data.email)) return res.status(409).json({ message: 'El usuario o correo del gestor ya está registrado.' });
  const pending = restaurantsDb.prepare("SELECT id FROM restaurant_applications WHERE requested_slug=? AND status='pending'").get(requestedSlug);
  if (pending) return res.status(409).json({ message: 'Ya existe una solicitud pendiente para esa URL de restaurante.' });
  restaurantsDb.prepare('INSERT INTO restaurant_applications (legal_json,requested_slug) VALUES (?,?)').run(jsonString({ ...parsed.data, slug: requestedSlug }), requestedSlug);
  res.status(201).json({ message: 'Solicitud enviada. QuickLunch revisará la documentación.', requested_slug: requestedSlug });
});

app.get('/api/restaurants/public', (_, res) => {
  const rows = restaurantsDb.prepare("SELECT * FROM restaurants WHERE status='active' ORDER BY created_at DESC").all()
    .map((r) => {
      const promo = bestPromotion(r.id);
      return { ...serializeRestaurant(r), promotion: serializeCoupon(promo) };
    })
    .sort((a,b) => couponWeight(b.promotion) - couponWeight(a.promotion));
  res.json(rows);
});

app.get('/api/restaurants/:slug/public', (req, res) => {
  const restaurant = serializeRestaurant(restaurantsDb.prepare("SELECT * FROM restaurants WHERE slug=? AND status='active'").get(req.params.slug));
  if (!restaurant) return res.status(404).json({ message: 'Restaurante no encontrado.' });
  const date = req.query.date || getToday();
  const menu = restaurantsDb.prepare("SELECT * FROM daily_menus WHERE restaurant_id=? AND menu_date=? AND status='published' ORDER BY id DESC LIMIT 1").get(restaurant.id, date);
  const items = menu ? restaurantsDb.prepare('SELECT * FROM menu_items WHERE menu_id=?').all(menu.id).map((x) => ({ ...x, plate: parseJson(x.plate_json) })) : [];
  res.json({ restaurant: { ...restaurant, promotion: serializeCoupon(bestPromotion(restaurant.id)) }, menu: menu ? { ...menu, items } : null });
});

app.get('/api/restaurants/:id/slots', (req, res) => {
  const restaurant = restaurantsDb.prepare('SELECT * FROM restaurants WHERE id=?').get(req.params.id);
  if (!restaurant) return res.status(404).json({ message: 'Restaurante no encontrado.' });
  const date = req.query.date || getToday();
  const settings = { ...defaultRestaurantSettings(), ...parseJson(restaurant.settings_json, {}) };
  const lunchCount = Math.max(1, Number(req.query.lunch_count || 1));
  const slots = [];
  for (const range of settings.pickup?.ranges || defaultRestaurantSettings().pickup.ranges) {
    const interval = Number(range.intervalMinutes || 10);
    const capacity = Number(range.capacity || 10);
    const start = new Date(`${date}T${range.start}:00`);
    const end = new Date(`${date}T${range.end}:00`);
    for (let cursor = new Date(start); cursor <= end; cursor = new Date(cursor.getTime() + interval * 60000)) {
      const time = cursor.toTimeString().slice(0, 5);
      const slotTime = `${date} ${time}`;
      const dbSlot = coreDb.prepare('SELECT * FROM pickup_slots WHERE restaurant_id=? AND slot_time=?').get(req.params.id, slotTime);
      const reserved = Number(dbSlot?.reserved || 0);
      const available = capacity - reserved;
      if (available >= lunchCount) slots.push({ time, capacity, reserved, available, intervalMinutes: interval });
    }
  }
  res.json(slots);
});

// ORDERS
app.post('/api/orders', auth(['customer', 'owner']), (req, res) => {
  const schema = z.object({ restaurant_id: z.number(), menu_id: z.number().optional().nullable(), pickup_date: z.string(), pickup_time: z.string(), payment_method: z.enum(['online', 'cash']), lunches: z.array(z.any()).min(1).max(10), coupon_code: z.string().optional(), notes: z.string().optional() });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: 'Pedido incompleto o supera el máximo de 10 almuerzos.' });
  const d = parsed.data;
  const restaurant = restaurantsDb.prepare('SELECT * FROM restaurants WHERE id=? AND status="active"').get(d.restaurant_id);
  if (!restaurant) return res.status(404).json({ message: 'Restaurante no encontrado o no disponible.' });
  const lunchCount = d.lunches.length;
  const slotTime = `${d.pickup_date} ${d.pickup_time}`;
  const slots = (() => {
    const fakeReq = { params: { id: d.restaurant_id }, query: { date: d.pickup_date, lunch_count: lunchCount } };
    const rows = [];
    const settings = { ...defaultRestaurantSettings(), ...parseJson(restaurant.settings_json, {}) };
    for (const range of settings.pickup?.ranges || defaultRestaurantSettings().pickup.ranges) {
      const capacity = Number(range.capacity || 10); const interval = Number(range.intervalMinutes || 10);
      const start = new Date(`${d.pickup_date}T${range.start}:00`); const end = new Date(`${d.pickup_date}T${range.end}:00`);
      for (let cursor = new Date(start); cursor <= end; cursor = new Date(cursor.getTime() + interval * 60000)) {
        const time = cursor.toTimeString().slice(0, 5); const st = `${d.pickup_date} ${time}`;
        const existing = coreDb.prepare('SELECT * FROM pickup_slots WHERE restaurant_id=? AND slot_time=?').get(d.restaurant_id, st);
        rows.push({ slot: st, available: capacity - Number(existing?.reserved || 0), capacity });
      }
    }
    return rows;
  })();
  const chosen = slots.find((s) => s.slot === slotTime);
  if (!chosen || chosen.available < lunchCount) return res.status(409).json({ message: 'Ese horario ya no tiene cupos suficientes.' });

  const subtotal = d.lunches.reduce((sum, lunch) => sum + moneyInt(lunch.total, 0), 0);
  const serviceFee = calculateFee(d.payment_method, lunchCount, d.restaurant_id);
  let discount = 0;
  let couponUse = [];
  if (d.coupon_code) {
    const coupon = restaurantsDb.prepare('SELECT * FROM coupons WHERE code=? AND active=1').get(String(d.coupon_code).toUpperCase());
    if (coupon && couponActive(coupon) && couponCanCover(coupon, d.restaurant_id)) {
      if (coupon.effect_type === 'credit_fixed') {
        const wallet = restaurantsDb.prepare('SELECT * FROM coupon_wallet WHERE user_id=? AND coupon_id=? AND credit_balance>0').get(req.user.id, coupon.id);
        if (wallet) {
          const take = Math.min(subtotal + serviceFee, Number(wallet.credit_balance || 0));
          restaurantsDb.prepare('UPDATE coupon_wallet SET credit_balance=credit_balance-? WHERE id=?').run(take, wallet.id);
          discount += take; couponUse.push({ code: coupon.code, amount: take, source: 'crédito redimido' });
        }
      } else {
        const val = Number(coupon.effect_value || coupon.discount_value || 0);
        if (coupon.effect_type === 'discount_percent') discount += Math.round(subtotal * val / 100);
        else if (coupon.effect_type === 'service_free') discount += serviceFee;
        else if (coupon.effect_type === 'service_percent') discount += Math.round(serviceFee * val / 100);
        else discount += Math.min(subtotal, val);
        couponUse.push({ code: coupon.code, amount: discount, source: 'cupón directo' });
      }
      restaurantsDb.prepare('UPDATE coupons SET current_uses=current_uses+1 WHERE id=?').run(coupon.id);
    }
  }
  const auto = automaticDiscounts(req.user.id, d.restaurant_id, subtotal, serviceFee, d.lunches);
  discount += auto.discount + auto.serviceDiscount;
  couponUse.push(...auto.applied);
  const walletAuto = applyCouponCredits(req.user.id, d.restaurant_id, Math.max(0, subtotal + serviceFee - discount));
  discount += walletAuto.discount;
  couponUse.push(...walletAuto.used);
  const total = Math.max(0, subtotal + serviceFee - discount);
  const publicCode = code('QL');
  const qrPayload = { public_code: publicCode, order_id: null, restaurant_id: d.restaurant_id, url: `${CLIENT_ORIGIN}/confirmar/${publicCode}`, rule: 'NO_ENTREGA_SIN_ESCANEO' };
  const info = coreDb.prepare(`INSERT INTO orders (public_code,user_id,restaurant_id,restaurant_name,customer_name,menu_id,pickup_slot,payment_method,payment_status,subtotal,service_fee,discount,total,lunch_count,qr_payload,items_json,notes) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(publicCode, req.user.id, d.restaurant_id, restaurant.name, req.user.full_name || req.user.username, d.menu_id || null, slotTime, d.payment_method, d.payment_method === 'online' ? 'paid_held' : 'cash_pending', subtotal, serviceFee, discount, total, lunchCount, jsonString(qrPayload), jsonString(d.lunches, []), d.notes || '');
  qrPayload.order_id = info.lastInsertRowid;
  coreDb.prepare('UPDATE orders SET qr_payload=? WHERE id=?').run(jsonString(qrPayload), info.lastInsertRowid);
  const existingSlot = coreDb.prepare('SELECT * FROM pickup_slots WHERE restaurant_id=? AND slot_time=?').get(d.restaurant_id, slotTime);
  if (existingSlot) coreDb.prepare('UPDATE pickup_slots SET reserved=reserved+? WHERE id=?').run(lunchCount, existingSlot.id);
  else coreDb.prepare('INSERT INTO pickup_slots (restaurant_id,slot_time,capacity,reserved) VALUES (?,?,?,?)').run(d.restaurant_id, slotTime, chosen.capacity, lunchCount);
  if (d.payment_method === 'online') coreDb.prepare('INSERT INTO payments (order_id,gateway,method_detail,amount,status,transaction_ref) VALUES (?,?,?,?,?,?)').run(info.lastInsertRowid, 'QuickLunch Demo Gateway', 'Tarjeta / Nequi / PSE demo', total, 'paid_held', code('PAY'));
  usersDb.prepare('INSERT INTO customer_activity (user_id,event_type,detail_json) VALUES (?,?,?)').run(req.user.id, 'order_created', jsonString({ order_id: info.lastInsertRowid, restaurant_id: d.restaurant_id, total, lunchCount }));
  res.status(201).json(serializeOrder(coreDb.prepare('SELECT * FROM orders WHERE id=?').get(info.lastInsertRowid)));
});

app.get('/api/orders/mine', auth(), (req, res) => {
  const rows = req.user.role === 'customer'
    ? coreDb.prepare('SELECT * FROM orders WHERE user_id=? ORDER BY created_at DESC').all(req.user.id)
    : coreDb.prepare('SELECT * FROM orders ORDER BY created_at DESC LIMIT 150').all();
  res.json(rows.map(serializeOrder));
});

app.get('/api/orders/:id/qr', auth(), async (req, res) => {
  const order = coreDb.prepare('SELECT * FROM orders WHERE id=?').get(req.params.id);
  if (!order) return res.status(404).json({ message: 'Pedido no encontrado.' });
  if (req.user.role === 'customer' && order.user_id !== req.user.id) return res.status(403).json({ message: 'No autorizado.' });
  const text = `${CLIENT_ORIGIN}/confirmar/${order.public_code}`;
  const png = await QRCode.toBuffer(text, { errorCorrectionLevel: 'M', width: 360, margin: 2 });
  res.setHeader('Content-Type', 'image/png');
  res.send(png);
});

app.get('/api/orders/confirm/:code', (req, res) => {
  const order = coreDb.prepare('SELECT * FROM orders WHERE public_code=?').get(req.params.code);
  if (!order) return res.status(404).json({ message: 'QR no encontrado.' });
  res.json(serializeOrder(order));
});

app.post('/api/orders/:id/cancel', auth(['customer', 'owner']), (req, res) => {
  const order = coreDb.prepare('SELECT * FROM orders WHERE id=?').get(req.params.id);
  if (!order) return res.status(404).json({ message: 'Pedido no encontrado.' });
  if (req.user.role === 'customer' && order.user_id !== req.user.id) return res.status(403).json({ message: 'No autorizado.' });
  const can = canCustomerCancel(order);
  if (!can.ok) return res.status(409).json({ message: can.reason });
  coreDb.prepare("UPDATE orders SET status='cancelled', cancelled_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP, payment_status=? WHERE id=?")
    .run(order.payment_method === 'online' ? 'refunded_to_restaurant_credit' : 'cancelled_no_charge', order.id);
  releaseSlot(order);
  if (order.payment_method === 'online') addRestaurantCredit(order.user_id, order.restaurant_id, order.subtotal);
  res.json({ message: order.payment_method === 'online' ? 'Pedido cancelado. El valor del almuerzo fue devuelto a créditos del restaurante.' : 'Pedido cancelado sin cobro.', order: serializeOrder(coreDb.prepare('SELECT * FROM orders WHERE id=?').get(order.id)) });
});

app.patch('/api/orders/:id', auth(['customer', 'owner']), (req, res) => {
  const order = coreDb.prepare('SELECT * FROM orders WHERE id=?').get(req.params.id);
  if (!order) return res.status(404).json({ message: 'Pedido no encontrado.' });
  if (req.user.role === 'customer' && order.user_id !== req.user.id) return res.status(403).json({ message: 'No autorizado.' });
  const can = canCustomerCancel(order);
  if (!can.ok || order.status !== 'reserved') return res.status(409).json({ message: 'Solo puedes modificar pedidos reservados hasta 1 hora antes.' });
  const lunches = Array.isArray(req.body.lunches) && req.body.lunches.length ? req.body.lunches.slice(0, 10) : parseJson(order.items_json, []);
  const pickupSlot = req.body.pickup_date && req.body.pickup_time ? `${req.body.pickup_date} ${req.body.pickup_time}` : order.pickup_slot;
  const paymentMethod = req.body.payment_method || order.payment_method;
  releaseSlot(order);
  const subtotal = lunches.reduce((sum, lunch) => sum + moneyInt(lunch.total), 0);
  const lunchCount = lunches.length;
  const serviceFee = calculateFee(paymentMethod, lunchCount, order.restaurant_id);
  const total = subtotal + serviceFee - Number(order.discount || 0);
  const existingSlot = coreDb.prepare('SELECT * FROM pickup_slots WHERE restaurant_id=? AND slot_time=?').get(order.restaurant_id, pickupSlot);
  if (existingSlot) coreDb.prepare('UPDATE pickup_slots SET reserved=reserved+? WHERE id=?').run(lunchCount, existingSlot.id);
  else coreDb.prepare('INSERT INTO pickup_slots (restaurant_id,slot_time,capacity,reserved) VALUES (?,?,10,?)').run(order.restaurant_id, pickupSlot, lunchCount);
  coreDb.prepare('UPDATE orders SET pickup_slot=?, payment_method=?, subtotal=?, service_fee=?, total=?, lunch_count=?, items_json=?, notes=?, updated_at=CURRENT_TIMESTAMP WHERE id=?')
    .run(pickupSlot, paymentMethod, subtotal, serviceFee, total, lunchCount, jsonString(lunches), req.body.notes ?? order.notes, order.id);
  res.json(serializeOrder(coreDb.prepare('SELECT * FROM orders WHERE id=?').get(order.id)));
});

app.post('/api/orders/:id/rating', auth(['customer', 'owner']), (req, res) => {
  const order = coreDb.prepare('SELECT * FROM orders WHERE id=?').get(req.params.id);
  if (!order || order.status !== 'claimed') return res.status(409).json({ message: 'Solo puedes calificar pedidos reclamados.' });
  if (req.user.role === 'customer' && order.user_id !== req.user.id) return res.status(403).json({ message: 'No autorizado.' });
  const rating = Math.max(1, Math.min(5, Number(req.body.rating || 0)));
  const accumulated = coreDb.prepare("SELECT COUNT(*) count FROM orders WHERE restaurant_id=? AND status='claimed'").get(order.restaurant_id).count;
  let delta = 0;
  if (rating === 5) delta = 3;
  if (rating === 4) delta = 1;
  if (accumulated > 10 && rating === 1) delta = -3;
  if (accumulated > 10 && rating === 2) delta = -1;
  try {
    restaurantsDb.prepare('INSERT INTO restaurant_ratings (restaurant_id,order_id,user_id,rating,comment,points_delta) VALUES (?,?,?,?,?,?)').run(order.restaurant_id, order.id, order.user_id, rating, req.body.comment || '', delta);
    if (delta) restaurantsDb.prepare('UPDATE restaurants SET prestige_points=prestige_points+? WHERE id=?').run(delta, order.restaurant_id);
    res.status(201).json({ message: 'Calificación registrada.', points_delta: delta });
  } catch {
    res.status(409).json({ message: 'Este pedido ya fue calificado.' });
  }
});


app.get('/api/customer/credits', auth(['customer', 'owner']), (req, res) => {
  const restaurantCredits = usersDb.prepare('SELECT * FROM restaurant_credits WHERE user_id=? ORDER BY updated_at DESC').all(req.user.id)
    .map((c) => ({ ...c, balance: c.balance, source:'cancelación', restaurant_name: restaurantsDb.prepare('SELECT name FROM restaurants WHERE id=?').get(c.restaurant_id)?.name || `Restaurante ${c.restaurant_id}` }));
  const couponCredits = restaurantsDb.prepare('SELECT * FROM coupon_wallet WHERE user_id=? AND credit_balance>0 ORDER BY redeemed_at DESC').all(req.user.id)
    .map((c) => ({ ...c, balance: c.credit_balance, source:'cupón', restaurant_name: c.restaurant_id ? restaurantsDb.prepare('SELECT name FROM restaurants WHERE id=?').get(c.restaurant_id)?.name : 'Toda la app' }));
  res.json([...restaurantCredits, ...couponCredits]);
});

app.get('/api/customer/coupons', auth(['customer', 'owner']), (req, res) => {
  const rows = restaurantsDb.prepare('SELECT c.*, r.name restaurant_name FROM coupons c LEFT JOIN restaurants r ON r.id = c.restaurant_id WHERE c.active=1 ORDER BY c.created_at DESC').all()
    .filter(couponActive).map(serializeCoupon);
  const wallet = restaurantsDb.prepare('SELECT * FROM coupon_wallet WHERE user_id=? AND credit_balance>0 ORDER BY redeemed_at DESC').all(req.user.id);
  res.json({ available: rows, wallet });
});

// SUPPORT
app.get('/api/support/options/:orderId', auth(), (req, res) => {
  const order = coreDb.prepare('SELECT * FROM orders WHERE id=?').get(req.params.orderId);
  if (!order) return res.status(404).json({ message: 'Pedido no encontrado.' });
  res.json({ options: orderSupportOptions(order), faqs: qlSettings().faqs || {} });
});

app.post('/api/support/threads', auth(), (req, res) => {
  const { order_id, restaurant_id, subject, body, support_type, attachments } = req.body;
  let finalRestaurant = restaurant_id || null;
  if (order_id) finalRestaurant = coreDb.prepare('SELECT restaurant_id FROM orders WHERE id=?').get(order_id)?.restaurant_id || finalRestaurant;
  const info = coreDb.prepare('INSERT INTO support_threads (order_id,user_id,restaurant_id,support_type,subject,attachments_json,restaurant_involved) VALUES (?,?,?,?,?,?,0)')
    .run(order_id || null, req.user.id, finalRestaurant, support_type || 'Soporte general', subject || 'Soporte QuickLunch', jsonString(attachments || []));
  coreDb.prepare('INSERT INTO support_messages (thread_id,sender_role,sender_name,channel,body) VALUES (?,?,?,?,?)').run(info.lastInsertRowid, req.user.role, req.user.full_name || req.user.username, 'customer', body || 'Necesito soporte con mi pedido.');
  res.status(201).json({ id: info.lastInsertRowid, message: 'Caso creado. Administración QuickLunch mediará la situación.' });
});

app.get('/api/support/threads', auth(), (req, res) => {
  let rows;
  if (req.user.role === 'customer') rows = coreDb.prepare('SELECT * FROM support_threads WHERE user_id=? ORDER BY updated_at DESC').all(req.user.id);
  else if (RESTAURANT_ROLES.includes(req.user.role) && req.user.role !== 'owner') rows = coreDb.prepare('SELECT * FROM support_threads WHERE restaurant_id=? AND restaurant_involved=1 ORDER BY updated_at DESC').all(req.user.restaurant_id);
  else rows = coreDb.prepare('SELECT * FROM support_threads ORDER BY updated_at DESC').all();
  res.json(rows.map((t) => ({ ...t, attachments: parseJson(t.attachments_json, []), resolution: parseJson(t.resolution_json, {}), messages: coreDb.prepare('SELECT * FROM support_messages WHERE thread_id=? ORDER BY created_at ASC').all(t.id) })));
});

app.post('/api/support/threads/:id/messages', auth(), (req, res) => {
  const thread = coreDb.prepare('SELECT * FROM support_threads WHERE id=?').get(req.params.id);
  if (!thread) return res.status(404).json({ message: 'Caso no encontrado.' });
  const channel = req.body.channel || (req.user.role === 'customer' ? 'customer' : req.user.role.includes('restaurant') ? 'restaurant' : 'admin');
  if (channel === 'restaurant' && !thread.restaurant_involved && !ADMIN_ROLES.includes(req.user.role) && req.user.role !== 'owner') return res.status(403).json({ message: 'El restaurante todavía no fue implicado por QuickLunch.' });
  coreDb.prepare('INSERT INTO support_messages (thread_id,sender_role,sender_name,channel,body) VALUES (?,?,?,?,?)').run(req.params.id, req.user.role, req.user.full_name || req.user.username, channel, req.body.body || 'Mensaje de soporte');
  coreDb.prepare('UPDATE support_threads SET updated_at=CURRENT_TIMESTAMP WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

app.patch('/api/support/threads/:id/action', auth(ADMIN_ROLES), (req, res) => {
  const thread = coreDb.prepare('SELECT * FROM support_threads WHERE id=?').get(req.params.id);
  if (!thread) return res.status(404).json({ message: 'Caso no encontrado.' });
  const actions = parseJson(thread.resolution_json, { actions: [] });
  if (req.body.involve_restaurant) {
    coreDb.prepare('UPDATE support_threads SET restaurant_involved=1 WHERE id=?').run(thread.id);
    coreDb.prepare('INSERT INTO support_messages (thread_id,sender_role,sender_name,channel,body) VALUES (?,?,?,?,?)').run(thread.id, req.user.role, req.user.full_name || req.user.username, 'restaurant', 'QuickLunch implicó al restaurante en este caso para mediar la solución.');
    actions.actions.push({ type: 'implicar_restaurante', at: new Date().toISOString(), by: req.user.username });
  }
  if (req.body.reward_user && thread.user_id) {
    const amount = moneyInt(req.body.reward_amount, 0);
    if (amount > 0) usersDb.prepare('UPDATE accounts SET wallet_balance=wallet_balance+? WHERE id=?').run(amount, thread.user_id);
    actions.actions.push({ type: 'recompensar_usuario', amount, by: req.user.username, at: new Date().toISOString() });
  }
  if (req.body.sanction_restaurant && thread.restaurant_id) {
    const points = -Math.abs(moneyInt(req.body.penalty_points, 1));
    applyPenalty(thread.restaurant_id, thread.order_id, req.body.penalty_reason || 'Sanción aplicada desde soporte QuickLunch', points, moneyInt(req.body.tax_percent, 0));
    actions.actions.push({ type: 'sancionar_restaurante', points, by: req.user.username, at: new Date().toISOString() });
  }
  if (req.body.deny_request) actions.actions.push({ type: 'negar_solicitud_usuario', by: req.user.username, at: new Date().toISOString(), reason: req.body.reason || '' });
  if (req.body.resolve) coreDb.prepare("UPDATE support_threads SET status='resolved' WHERE id=?").run(thread.id);
  coreDb.prepare('UPDATE support_threads SET resolution_json=?, updated_at=CURRENT_TIMESTAMP WHERE id=?').run(jsonString(actions), thread.id);
  res.json({ ok: true, resolution: actions });
});

// ADMIN
app.get('/api/admin/dashboard', auth(ADMIN_ROLES), (_, res) => {
  const users = usersDb.prepare("SELECT COUNT(*) count FROM accounts WHERE role='customer'").get().count;
  const restaurants = restaurantsDb.prepare('SELECT COUNT(*) count FROM restaurants').get().count;
  const pending = restaurantsDb.prepare("SELECT COUNT(*) count FROM restaurant_applications WHERE status='pending'").get().count;
  const allOrders = coreDb.prepare('SELECT COUNT(*) count, COALESCE(SUM(total),0) total FROM orders').get();
  const claimed = coreDb.prepare("SELECT COUNT(*) count, COALESCE(SUM(subtotal),0) total FROM orders WHERE status='claimed'").get();
  const byStatus = coreDb.prepare('SELECT status, COUNT(*) count FROM orders GROUP BY status').all();
  const topRestaurants = coreDb.prepare("SELECT restaurant_name, COUNT(*) orders, COALESCE(SUM(CASE WHEN status='claimed' THEN subtotal ELSE 0 END),0) settled_sales FROM orders GROUP BY restaurant_id ORDER BY orders DESC LIMIT 8").all();
  const appFreeRevenue = coreDb.prepare("SELECT COALESCE(SUM(service_fee),0) total FROM orders WHERE status='claimed'").get().total || 0;
  res.json({ users, restaurants, pendingApplications: pending, orders: allOrders.count, revenue: allOrders.total, releasedToRestaurants: claimed.total, appFreeRevenue, claimedOrders: claimed.count, byStatus, topRestaurants, settings: qlSettings(), aiInsights: aiInsightsForSystem() });
});

app.get('/api/admin/users', auth(ADMIN_ROLES), (_, res) => {
  const rows = usersDb.prepare('SELECT * FROM accounts ORDER BY created_at DESC').all().map(serializeAccount);
  const orders = Object.fromEntries(coreDb.prepare('SELECT user_id, COUNT(*) orders, COALESCE(SUM(total),0) spent FROM orders GROUP BY user_id').all().map((r) => [r.user_id, r]));
  const reports = Object.fromEntries(usersDb.prepare('SELECT user_id, COUNT(*) reports FROM customer_reports GROUP BY user_id').all().map((r) => [r.user_id, r]));
  res.json(rows.map((u) => ({ ...u, metrics: { orders: orders[u.id]?.orders || 0, spent: orders[u.id]?.spent || 0, reports: reports[u.id]?.reports || 0 } })));
});

app.post('/api/admin/users', auth(ADMIN_ROLES), (req, res) => {
  const schema = z.object({
    full_name: z.string().min(3),
    username: z.string().min(3),
    email: z.string().email(),
    phone: z.string().optional(),
    password: z.string().min(6),
    role: z.enum(['owner','admin','restaurant_owner','restaurant_staff','customer']).default('customer'),
    role_label: z.string().optional(),
    status: z.enum(['active','banned','inactive']).default('active'),
    restaurant_id: z.union([z.number(), z.string()]).optional().nullable(),
    wallet_balance: z.union([z.number(), z.string()]).optional()
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: 'Revisa nombre, usuario, correo, contraseña y rol.' });
  const d = parsed.data;
  if (req.user.role !== 'owner' && ['owner','admin'].includes(d.role)) return res.status(403).json({ message: 'Un administrador no puede crear owners ni administradores.' });
  if (usersDb.prepare('SELECT id FROM accounts WHERE username=? OR email=?').get(d.username, d.email)) return res.status(409).json({ message: 'Ese usuario o correo ya existe. No se creó la cuenta.' });
  const restaurantId = d.restaurant_id ? Number(d.restaurant_id) : null;
  if (['restaurant_owner','restaurant_staff'].includes(d.role) && restaurantId && !restaurantsDb.prepare('SELECT id FROM restaurants WHERE id=?').get(restaurantId)) return res.status(404).json({ message: 'El restaurante asociado no existe.' });
  const info = usersDb.prepare(`INSERT INTO accounts (username,email,phone,password_hash,password_plain,role,role_label,status,city,full_name,restaurant_id,consent_analytics,wallet_balance,preferences_json,permissions_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(d.username, d.email, d.phone || '', bcrypt.hashSync(d.password, 10), d.password, d.role, d.role_label || ROLE_LABELS[d.role] || d.role, d.status, 'Cali', d.full_name, restaurantId, d.role === 'customer' ? 1 : 0, moneyInt(d.wallet_balance, 0), '{}', '{}');
  res.status(201).json(serializeAccount(usersDb.prepare('SELECT * FROM accounts WHERE id=?').get(info.lastInsertRowid)));
});

app.patch('/api/admin/users/:id', auth(ADMIN_ROLES), (req, res) => {
  const target = usersDb.prepare('SELECT * FROM accounts WHERE id=?').get(req.params.id);
  if (!target) return res.status(404).json({ message: 'Usuario no encontrado.' });
  const updates = []; const values = [];
  if (req.body.status !== undefined) { updates.push('status=?'); values.push(req.body.status); }
  if (req.body.wallet_balance !== undefined) { updates.push('wallet_balance=?'); values.push(moneyInt(req.body.wallet_balance)); }
  if (req.body.wallet_adjustment !== undefined) { updates.push('wallet_balance=wallet_balance+?'); values.push(Number(req.body.wallet_adjustment)); }
  if (req.body.role !== undefined || req.body.restaurant_id !== undefined || req.body.role_label !== undefined) {
    if (req.user.role !== 'owner') return res.status(403).json({ message: 'Solo el owner puede modificar roles.' });
    const role = req.body.role || target.role;
    updates.push('role=?'); values.push(role);
    updates.push('role_label=?'); values.push(req.body.role_label || ROLE_LABELS[role] || role);
    updates.push('restaurant_id=?'); values.push(req.body.restaurant_id || null);
  }
  if (!updates.length) return res.status(400).json({ message: 'No hay cambios.' });
  values.push(req.params.id);
  usersDb.prepare(`UPDATE accounts SET ${updates.join(', ')}, updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(...values);
  res.json(serializeAccount(usersDb.prepare('SELECT * FROM accounts WHERE id=?').get(req.params.id)));
});

app.get('/api/admin/restaurants', auth(ADMIN_ROLES), (_, res) => {
  const rows = restaurantsDb.prepare('SELECT * FROM restaurants ORDER BY created_at DESC').all().map(serializeRestaurant);
  const stats = Object.fromEntries(coreDb.prepare("SELECT restaurant_id, COUNT(*) orders, COALESCE(SUM(total),0) processed, COALESCE(SUM(CASE WHEN status='claimed' THEN subtotal ELSE 0 END),0) settled FROM orders GROUP BY restaurant_id").all().map((r) => [r.restaurant_id, r]));
  res.json(rows.map((r) => ({ ...r, metrics: stats[r.id] || { orders: 0, processed: 0, settled: 0 } })));
});

app.post('/api/admin/restaurants', auth(ADMIN_ROLES), (req, res) => {
  const b = req.body;
  const slug = toSlug(b.slug || b.name);
  if (!b.name || !slug) return res.status(400).json({ message: 'Escribe el nombre y la dirección URL del restaurante.' });
  if (restaurantsDb.prepare('SELECT id FROM restaurants WHERE slug=?').get(slug)) return res.status(409).json({ message: 'Ya existe un restaurante con esa URL. No se creó el restaurante.' });
  if (b.manager_username && usersDb.prepare('SELECT id FROM accounts WHERE username=? OR email=?').get(b.manager_username, b.manager_email || `${b.manager_username}@quicklunch.local`)) return res.status(409).json({ message: 'El usuario o correo del dueño gestor ya existe. No se creó el restaurante.' });
  try {
    const info = restaurantsDb.prepare(`INSERT INTO restaurants (name,slug,city,address,phone,email,owner_name,owner_document,legal_representative,nit,chamber_commerce,rut,sanitary_concept,firefighter_certificate,land_use_concept,police_opening_notice,food_handler_certificates,personal_data_policy_url,association_valid_until,status,profile_json,design_json,opening_hours_json,settings_json,fees_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(b.name, slug, 'Cali', b.address || 'Dirección pendiente', b.phone || '', b.email || '', b.owner_name || '', b.owner_document || '', b.legal_representative || b.owner_name || '', b.nit || '', b.chamber_commerce || '', b.rut || '', b.sanitary_concept || '', b.firefighter_certificate || '', b.land_use_concept || '', b.police_opening_notice || '', b.food_handler_certificates || '', b.personal_data_policy_url || '', b.association_valid_until || '', b.status || 'active', jsonString({ description: 'Corrientazo aliado a QuickLunch' }), jsonString({}), jsonString({}), jsonString(defaultRestaurantSettings()), jsonString(defaultFees()));
    if (b.manager_username && b.manager_password) {
      usersDb.prepare(`INSERT INTO accounts (username,email,password_hash,password_plain,role,role_label,status,city,full_name,restaurant_id,consent_analytics) VALUES (?,?,?,?,?,?,?,?,?,?,1)`)
        .run(b.manager_username, b.manager_email || `${b.manager_username}@quicklunch.local`, bcrypt.hashSync(b.manager_password, 10), b.manager_password, 'restaurant_owner', ROLE_LABELS.restaurant_owner, 'active', 'Cali', b.manager_full_name || b.owner_name || b.manager_username, info.lastInsertRowid);
    }
    res.status(201).json(serializeRestaurant(restaurantsDb.prepare('SELECT * FROM restaurants WHERE id=?').get(info.lastInsertRowid)));
  } catch (err) {
    res.status(409).json({ message: 'No se pudo crear. Revisa datos repetidos.', detail: err.message });
  }
});

app.patch('/api/admin/restaurants/:id', auth(ADMIN_ROLES), (req, res) => {
  const allowed = ['name','slug','address','phone','email','owner_name','owner_document','legal_representative','nit','chamber_commerce','rut','sanitary_concept','firefighter_certificate','land_use_concept','police_opening_notice','food_handler_certificates','personal_data_policy_url','association_valid_until','status','prestige_points'];
  const current = restaurantsDb.prepare('SELECT * FROM restaurants WHERE id=?').get(req.params.id);
  if (!current) return res.status(404).json({ message: 'Restaurante no encontrado.' });
  const updates = []; const values = [];
  for (const k of allowed) {
    if (req.body[k] !== undefined) {
      let value = req.body[k];
      if (k === 'slug') {
        value = toSlug(value);
        const duplicate = restaurantsDb.prepare('SELECT id FROM restaurants WHERE slug=? AND id<>?').get(value, req.params.id);
        if (duplicate) return res.status(409).json({ message: 'Ya existe otro restaurante con esa URL.' });
      }
      updates.push(`${k}=?`); values.push(value);
    }
  }
  if (!updates.length) return res.status(400).json({ message: 'No hay cambios.' });
  values.push(req.params.id);
  restaurantsDb.prepare(`UPDATE restaurants SET ${updates.join(', ')}, updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(...values);
  res.json(serializeRestaurant(restaurantsDb.prepare('SELECT * FROM restaurants WHERE id=?').get(req.params.id)));
});

app.delete('/api/admin/restaurants/:id', auth(ADMIN_ROLES), requireOwner, (req, res) => {
  const id = Number(req.params.id);
  restaurantsDb.prepare('DELETE FROM menu_items WHERE menu_id IN (SELECT id FROM daily_menus WHERE restaurant_id=?)').run(id);
  restaurantsDb.prepare('DELETE FROM daily_menus WHERE restaurant_id=?').run(id);
  restaurantsDb.prepare('DELETE FROM inventory_items WHERE restaurant_id=?').run(id);
  restaurantsDb.prepare('DELETE FROM coupons WHERE restaurant_id=?').run(id);
  restaurantsDb.prepare('DELETE FROM restaurant_penalties WHERE restaurant_id=?').run(id);
  restaurantsDb.prepare('DELETE FROM restaurant_ratings WHERE restaurant_id=?').run(id);
  restaurantsDb.prepare('DELETE FROM restaurants WHERE id=?').run(id);
  usersDb.prepare("UPDATE accounts SET status='inactive', restaurant_id=NULL WHERE restaurant_id=?").run(id);
  coreDb.prepare('DELETE FROM pickup_slots WHERE restaurant_id=?').run(id);
  coreDb.prepare('UPDATE orders SET status="cancelled", updated_at=CURRENT_TIMESTAMP WHERE restaurant_id=? AND status NOT IN ("claimed","cancelled")').run(id);
  res.json({ ok: true, message: 'Restaurante eliminado y gestores desactivados.' });
});

app.patch('/api/admin/restaurants/:id/fees', auth(ADMIN_ROLES), requireOwner, (req, res) => {
  const fees = { ...getRestaurantFees(req.params.id), online: moneyInt(req.body.online, undefined), cash: moneyInt(req.body.cash, undefined), commissionPercent: moneyInt(req.body.commissionPercent, undefined) };
  restaurantsDb.prepare('UPDATE restaurants SET fees_json=?, updated_at=CURRENT_TIMESTAMP WHERE id=?').run(jsonString(fees), req.params.id);
  res.json({ fees });
});

app.get('/api/admin/applications', auth(ADMIN_ROLES), (_, res) => {
  const apps = restaurantsDb.prepare('SELECT * FROM restaurant_applications ORDER BY created_at DESC').all().map((a) => ({ ...a, legal: parseJson(a.legal_json) }));
  res.json(apps);
});

app.patch('/api/admin/applications/:id', auth(ADMIN_ROLES), (req, res) => {
  const appRow = restaurantsDb.prepare('SELECT * FROM restaurant_applications WHERE id=?').get(req.params.id);
  if (!appRow) return res.status(404).json({ message: 'Solicitud no encontrada.' });
  const status = req.body.status;
  const legal = parseJson(appRow.legal_json);
  if (status === 'rejected') {
    restaurantsDb.prepare('UPDATE restaurant_applications SET status=?, reviewer_notes=?, reviewed_at=CURRENT_TIMESTAMP WHERE id=?').run('rejected', req.body.reviewer_notes || 'Solicitud rechazada.', req.params.id);
    return res.json({ ok: true });
  }
  if (status !== 'approved') return res.status(400).json({ message: 'Estado inválido.' });
  const createReq = { body: legal, user: req.user };
  try {
    const slug = toSlug(appRow.requested_slug || legal.name);
    const info = restaurantsDb.prepare(`INSERT INTO restaurants (name,slug,city,address,phone,email,owner_name,owner_document,legal_representative,nit,chamber_commerce,rut,sanitary_concept,firefighter_certificate,land_use_concept,police_opening_notice,food_handler_certificates,personal_data_policy_url,status,profile_json,design_json,opening_hours_json,settings_json,fees_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(legal.name, slug, 'Cali', legal.address, legal.phone, legal.email, legal.owner_name, legal.owner_document, legal.legal_representative || legal.owner_name, legal.nit, legal.chamber_commerce, legal.rut, legal.sanitary_concept || '', legal.firefighter_certificate || '', legal.land_use_concept || '', legal.police_opening_notice || '', legal.food_handler_certificates || '', legal.personal_data_policy_url || '', 'active', jsonString({ description: 'Restaurante aprobado por QuickLunch' }), jsonString({}), jsonString({}), jsonString(defaultRestaurantSettings()), jsonString(defaultFees()));
    usersDb.prepare(`INSERT INTO accounts (username,email,password_hash,password_plain,role,role_label,status,city,full_name,restaurant_id,consent_analytics) VALUES (?,?,?,?,?,?,?,?,?,?,1)`)
      .run(legal.manager_username, legal.manager_email || `${legal.manager_username}@quicklunch.local`, bcrypt.hashSync(legal.manager_password, 10), legal.manager_password, 'restaurant_owner', ROLE_LABELS.restaurant_owner, 'active', 'Cali', legal.manager_full_name || legal.owner_name, info.lastInsertRowid);
    restaurantsDb.prepare('UPDATE restaurant_applications SET status=?, reviewer_notes=?, reviewed_at=CURRENT_TIMESTAMP WHERE id=?').run('approved', req.body.reviewer_notes || 'Aprobado.', req.params.id);
    res.json({ message: 'Restaurante aprobado.', restaurant: serializeRestaurant(restaurantsDb.prepare('SELECT * FROM restaurants WHERE id=?').get(info.lastInsertRowid)) });
  } catch (err) {
    res.status(409).json({ message: 'No se pudo aprobar. Revisa usuario/slug repetido.', detail: err.message });
  }
});

app.get('/api/admin/analytics', auth(ADMIN_ROLES), (_, res) => {
  const salesByDay = coreDb.prepare("SELECT substr(created_at,1,10) day, COUNT(*) orders, COALESCE(SUM(total),0) sales FROM orders GROUP BY day ORDER BY day DESC LIMIT 15").all().reverse();
  const status = coreDb.prepare('SELECT status, COUNT(*) value FROM orders GROUP BY status').all();
  const payments = coreDb.prepare('SELECT payment_method name, COUNT(*) value FROM orders GROUP BY payment_method').all();
  const appFreeRevenue = coreDb.prepare("SELECT COALESCE(SUM(service_fee),0) total FROM orders WHERE status='claimed'").get().total || 0;
  const held = coreDb.prepare("SELECT COALESCE(SUM(total),0) total FROM orders WHERE payment_method='online' AND status NOT IN ('claimed','cancelled')").get().total || 0;
  res.json({ salesByDay, status, payments, appFreeRevenue, held, aiInsights: aiInsightsForSystem() });
});


app.get('/api/ai/insights', auth(), (req, res) => {
  if (ADMIN_ROLES.includes(req.user.role) || req.user.role === 'owner') return res.json({ scope: 'sistema', insights: aiInsightsForSystem() });
  if (RESTAURANT_ROLES.includes(req.user.role)) {
    const id = getRestaurantId(req);
    const summary = coreDb.prepare("SELECT COUNT(*) orders, SUM(CASE WHEN status='delayed' THEN 1 ELSE 0 END) delayed, SUM(CASE WHEN status='cancelled' THEN 1 ELSE 0 END) cancelled, COALESCE(SUM(CASE WHEN status='claimed' THEN subtotal ELSE 0 END),0) released FROM orders WHERE restaurant_id=?").get(id);
    return res.json({ scope: 'restaurante', insights: [
      `Pedidos totales monitoreados: ${summary.orders || 0}.`,
      `Dinero liberado por QR reclamado: ${Number(summary.released || 0).toLocaleString('es-CO')} COP.`,
      Number(summary.delayed || 0) + Number(summary.cancelled || 0) > 0 ? 'Hay incidencias: ajusta cupos por franja antes de publicar más promociones.' : 'Operación estable: puedes activar cupones o resaltar platos de mayor margen.'
    ]});
  }
  const favorites = coreDb.prepare('SELECT restaurant_name, COUNT(*) c FROM orders WHERE user_id=? GROUP BY restaurant_id ORDER BY c DESC LIMIT 3').all(req.user.id);
  res.json({ scope: 'usuario', insights: favorites.length ? favorites.map(f => `Sueles pedir en ${f.restaurant_name}. Revisa sus promociones antes de confirmar.`) : ['Haz tu primer pedido para activar recomendaciones personalizadas.'] });
});

app.patch('/api/admin/settings', auth(ADMIN_ROLES), requireOwner, (req, res) => {
  const settings = qlSettings();
  if (req.body.fees) settings.fees = { ...settings.fees, ...req.body.fees };
  if (req.body.pickup) settings.pickup = { ...settings.pickup, ...req.body.pickup };
  saveQlSettings(settings);
  res.json(settings);
});


app.get('/api/admin/coupons', auth(ADMIN_ROLES), (req, res) => {
  const rows = restaurantsDb.prepare('SELECT c.*, r.name restaurant_name FROM coupons c LEFT JOIN restaurants r ON r.id=c.restaurant_id ORDER BY c.created_at DESC').all();
  res.json(rows.map(serializeCoupon));
});

app.post('/api/admin/coupons', auth(ADMIN_ROLES), (req, res) => {
  const codeValue = String(req.body.code || req.body.name || code('CUPON')).trim().toUpperCase();
  if (!codeValue) return res.status(400).json({ message: 'Escribe ID/nombre del cupón.' });
  if (restaurantsDb.prepare('SELECT id FROM coupons WHERE code=?').get(codeValue)) return res.status(409).json({ message: 'Ese ID de cupón ya existe.' });
  const coverageRestaurants = Array.isArray(req.body.coverage_restaurants) ? req.body.coverage_restaurants.map(Number) : [];
  const restaurantId = req.body.effect_scope === 'restaurant' && coverageRestaurants.length === 1 ? coverageRestaurants[0] : null;
  const info = restaurantsDb.prepare(`INSERT INTO coupons (restaurant_id,code,name,description,starts_at,ends_at,discount_type,discount_value,effect_type,effect_value,effect_scope,coverage_restaurants_json,products_json,min_purchase,previous_purchases_required,max_uses,unlimited_uses,auto_apply,is_redeemable,is_promotion,active,created_by,creator_role,creator_user_id,creator_restaurant_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(restaurantId, codeValue, req.body.name || codeValue, req.body.description || '', req.body.starts_at || null, req.body.ends_at || req.body.expires_at || null, req.body.discount_type || 'fixed', moneyInt(req.body.effect_value || req.body.discount_value, 0), req.body.effect_type || 'credit_fixed', moneyInt(req.body.effect_value || req.body.discount_value, 0), req.body.effect_scope || 'app', jsonString(coverageRestaurants), jsonString(req.body.products || []), moneyInt(req.body.min_purchase, 0), moneyInt(req.body.previous_purchases_required, 0), moneyInt(req.body.max_uses, 100), req.body.unlimited_uses ? 1 : 0, req.body.auto_apply ? 1 : 0, 1, req.body.is_promotion ? 1 : 0, 1, req.user.username, req.user.role, req.user.id, null);
  const coupon = restaurantsDb.prepare('SELECT * FROM coupons WHERE id=?').get(info.lastInsertRowid);
  if (req.body.auto_apply) {
    const users = req.body.all_users ? usersDb.prepare("SELECT id FROM accounts WHERE role='customer' AND status='active'").all() : asArray(req.body.user_ids).map((id) => ({ id }));
    for (const u of users) restaurantsDb.prepare('INSERT OR IGNORE INTO coupon_wallet (user_id,coupon_id,restaurant_id,code,effect_scope,credit_balance) VALUES (?,?,?,?,?,?)').run(u.id, coupon.id, restaurantId, coupon.code, coupon.effect_scope, moneyInt(coupon.effect_value, 0));
  }
  res.status(201).json(serializeCoupon(coupon));
});

app.post('/api/customer/coupons/redeem', auth(['customer','owner']), (req, res) => {
  const codeValue = String(req.body.code || '').trim().toUpperCase();
  const coupon = restaurantsDb.prepare('SELECT * FROM coupons WHERE code=? AND active=1').get(codeValue);
  if (!coupon || !couponActive(coupon) || !Number(coupon.is_redeemable)) return res.status(404).json({ message: 'Cupón no válido, vencido o no redimible.' });
  if (!Number(coupon.unlimited_uses) && Number(coupon.current_uses || 0) >= Number(coupon.max_uses || 0)) return res.status(409).json({ message: 'El cupón ya no tiene usos disponibles.' });
  if (coupon.effect_type !== 'credit_fixed') return res.status(400).json({ message: 'Este beneficio se aplica automáticamente en factura; no necesita redención.' });
  restaurantsDb.prepare('INSERT OR IGNORE INTO coupon_wallet (user_id,coupon_id,restaurant_id,code,effect_scope,credit_balance) VALUES (?,?,?,?,?,?)').run(req.user.id, coupon.id, coupon.restaurant_id || null, coupon.code, coupon.effect_scope, moneyInt(coupon.effect_value || coupon.discount_value, 0));
  restaurantsDb.prepare('UPDATE coupons SET current_uses=current_uses+1 WHERE id=?').run(coupon.id);
  res.json({ message: 'Cupón redimido. El crédito quedó disponible para tu próxima compra.', coupon: serializeCoupon(coupon) });
});


// RESTAURANT PANEL
app.get('/api/restaurant/me', auth(RESTAURANT_ROLES), restaurantGuard, (req, res) => {
  const id = getRestaurantId(req);
  const restaurant = serializeRestaurant(restaurantsDb.prepare('SELECT * FROM restaurants WHERE id=?').get(id));
  const accessible = req.user.role === 'owner' ? restaurantsDb.prepare('SELECT id,name,slug FROM restaurants ORDER BY name').all() : [];
  res.json({ restaurant, accessibleRestaurants: accessible, role: req.user.role });
});

app.put('/api/restaurant/profile', auth(RESTAURANT_ROLES), restaurantGuard, requireRestaurantFull, (req, res) => {
  const id = getRestaurantId(req);
  const current = restaurantsDb.prepare('SELECT * FROM restaurants WHERE id=?').get(id);
  if (!current) return res.status(404).json({ message: 'Restaurante no encontrado.' });
  const settings = { ...defaultRestaurantSettings(), ...parseJson(current.settings_json, {}), ...(req.body.settings || {}) };
  restaurantsDb.prepare('UPDATE restaurants SET profile_json=?, design_json=?, opening_hours_json=?, settings_json=?, updated_at=CURRENT_TIMESTAMP WHERE id=?')
    .run(jsonString(req.body.profile || parseJson(current.profile_json)), jsonString(req.body.design || parseJson(current.design_json)), jsonString(req.body.openingHours || parseJson(current.opening_hours_json)), jsonString(settings), id);
  res.json(serializeRestaurant(restaurantsDb.prepare('SELECT * FROM restaurants WHERE id=?').get(id)));
});

app.post('/api/restaurant/upload', auth(RESTAURANT_ROLES), restaurantGuard, upload.single('image'), (req, res) => {
  if (!req.file) return res.status(400).json({ message: 'Sube una imagen válida.' });
  res.status(201).json({ url: `/uploads/quicklunch/${req.file.filename}`, filename: req.file.filename });
});

app.get('/api/images/suggest', auth(RESTAURANT_ROLES), async (req, res) => {
  const query = String(req.query.q || 'almuerzo colombiano').trim();
  const description = String(req.query.description || '').trim();
  const search = `${query} ${description} comida plato restaurante`;
  const results = [];
  try {
    const url = `https://commons.wikimedia.org/w/api.php?action=query&generator=search&gsrsearch=${encodeURIComponent(search)}&gsrnamespace=6&gsrlimit=12&prop=imageinfo&iiprop=url|mime&iiurlwidth=640&format=json&origin=*`;
    const response = await fetch(url, { headers: { 'User-Agent': 'QuickLunchDemo/1.0' } });
    const data = await response.json();
    const pages = Object.values(data.query?.pages || {});
    for (const page of pages) {
      const info = page.imageinfo?.[0];
      const imageUrl = info?.thumburl || info?.url;
      if (imageUrl && /^image\//.test(info.mime || 'image/')) results.push({ label: page.title.replace(/^File:/, ''), url: imageUrl, source: 'Wikimedia Commons' });
      if (results.length >= 5) break;
    }
  } catch (err) {
    console.warn('No se pudo consultar Wikimedia Commons:', err.message);
  }
  while (results.length < 5) {
    const sig = results.length + 11;
    results.push({ label: `Búsqueda web ${results.length + 1}: ${query}`, url: `https://loremflickr.com/640/480/${encodeURIComponent(query.replace(/\s+/g,','))},food?lock=${sig}`, source: 'internet' });
  }
  res.json(results.slice(0, 5));
});

app.get('/api/restaurant/staff', auth(RESTAURANT_ROLES), restaurantGuard, requireRestaurantFull, (req, res) => {
  const id = getRestaurantId(req);
  res.json(usersDb.prepare('SELECT * FROM accounts WHERE restaurant_id=? ORDER BY role, full_name').all(id).map(serializeAccount));
});

app.post('/api/restaurant/staff', auth(RESTAURANT_ROLES), restaurantGuard, requireRestaurantFull, (req, res) => {
  const id = getRestaurantId(req);
  const role = req.body.role === 'restaurant_owner' ? 'restaurant_owner' : 'restaurant_staff';
  try {
    const info = usersDb.prepare(`INSERT INTO accounts (username,email,password_hash,password_plain,role,role_label,status,city,full_name,restaurant_id) VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run(req.body.username, req.body.email || `${req.body.username}@quicklunch.local`, bcrypt.hashSync(req.body.password || 'quick2026', 10), req.body.password || 'quick2026', role, req.body.role_label || (role === 'restaurant_owner' ? 'Dueño asociado' : 'Cajero / Operador de reservas'), 'active', 'Cali', req.body.full_name || req.body.username, id);
    res.status(201).json(serializeAccount(usersDb.prepare('SELECT * FROM accounts WHERE id=?').get(info.lastInsertRowid)));
  } catch {
    res.status(409).json({ message: 'Ese usuario o correo ya existe.' });
  }
});

app.patch('/api/restaurant/staff/:id', auth(RESTAURANT_ROLES), restaurantGuard, requireRestaurantFull, (req, res) => {
  const id = getRestaurantId(req);
  const acc = usersDb.prepare('SELECT * FROM accounts WHERE id=? AND restaurant_id=?').get(req.params.id, id);
  if (!acc) return res.status(404).json({ message: 'Colaborador no encontrado.' });
  usersDb.prepare('UPDATE accounts SET role_label=?, status=?, updated_at=CURRENT_TIMESTAMP WHERE id=?').run(req.body.role_label || acc.role_label, req.body.status || acc.status, acc.id);
  res.json(serializeAccount(usersDb.prepare('SELECT * FROM accounts WHERE id=?').get(acc.id)));
});

app.get('/api/restaurant/inventory', auth(RESTAURANT_ROLES), restaurantGuard, (req, res) => {
  const id = getRestaurantId(req);
  res.json(restaurantsDb.prepare('SELECT * FROM inventory_items WHERE restaurant_id=? ORDER BY category, name').all(id));
});

app.post('/api/restaurant/inventory', auth(RESTAURANT_ROLES), restaurantGuard, (req, res) => {
  const restaurantId = getRestaurantId(req);
  const category = req.body.category;
  const name = String(req.body.name || '').trim();
  if (!category || !name) return res.status(400).json({ message: 'Selecciona una categoría y escribe un nombre.' });
  const duplicate = restaurantsDb.prepare('SELECT id FROM inventory_items WHERE restaurant_id=? AND category=? AND lower(name)=lower(?) AND active=1').get(restaurantId, category, name);
  if (duplicate) return res.status(409).json({ message: 'Ese alimento ya existe en esa categoría. No se guardó duplicado.' });
  const isCompletePlate = category === 'complete_plate';
  const isSpecial = isCompletePlate ? 0 : (req.body.is_special ? 1 : 0);
  const price = isCompletePlate ? moneyInt(req.body.price) : 0;
  if (isCompletePlate && price <= 0) return res.status(400).json({ message: 'Un plato armado debe tener precio propio.' });
  const additionalCost = isSpecial ? moneyInt(req.body.additional_cost) : 0;
  const info = restaurantsDb.prepare('INSERT INTO inventory_items (restaurant_id,category,name,description,cost,price,stock,is_special,additional_cost,image_url,image_source) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
    .run(restaurantId, category, name, req.body.description || '', 0, price, moneyInt(req.body.stock), isSpecial, additionalCost, req.body.image_url || '', req.body.image_source || (req.body.image_url ? 'internet/manual' : 'none'));
  res.status(201).json(restaurantsDb.prepare('SELECT * FROM inventory_items WHERE id=?').get(info.lastInsertRowid));
});

app.patch('/api/restaurant/inventory/:id', auth(RESTAURANT_ROLES), restaurantGuard, (req, res) => {
  const item = restaurantsDb.prepare('SELECT * FROM inventory_items WHERE id=?').get(req.params.id);
  if (!item) return res.status(404).json({ message: 'Ítem no encontrado.' });
  const restaurantId = getRestaurantId(req);
  if (Number(item.restaurant_id) !== Number(restaurantId)) return res.status(403).json({ message: 'No autorizado.' });
  const category = req.body.category || item.category;
  const isCompletePlate = category === 'complete_plate';
  const isSpecial = isCompletePlate ? 0 : (req.body.is_special ?? item.is_special ? 1 : 0);
  const price = isCompletePlate ? moneyInt(req.body.price ?? item.price) : 0;
  const additionalCost = isSpecial ? moneyInt(req.body.additional_cost ?? item.additional_cost) : 0;
  restaurantsDb.prepare('UPDATE inventory_items SET category=?, name=?, description=?, cost=0, price=?, stock=?, is_special=?, additional_cost=?, image_url=?, image_source=?, active=?, updated_at=CURRENT_TIMESTAMP WHERE id=?')
    .run(category, req.body.name || item.name, req.body.description ?? item.description, price, moneyInt(req.body.stock ?? item.stock), isSpecial, additionalCost, req.body.image_url ?? item.image_url, req.body.image_source ?? item.image_source, req.body.active ?? item.active, item.id);
  res.json(restaurantsDb.prepare('SELECT * FROM inventory_items WHERE id=?').get(item.id));
});

app.get('/api/restaurant/menus', auth(RESTAURANT_ROLES), restaurantGuard, (req, res) => {
  const id = getRestaurantId(req);
  const menus = restaurantsDb.prepare('SELECT * FROM daily_menus WHERE restaurant_id=? ORDER BY menu_date DESC, id DESC').all(id);
  res.json(menus.map((m) => ({ ...m, items: restaurantsDb.prepare('SELECT * FROM menu_items WHERE menu_id=?').all(m.id).map((x) => ({ ...x, plate: parseJson(x.plate_json) })) })));
});

app.post('/api/restaurant/menus', auth(RESTAURANT_ROLES), restaurantGuard, (req, res) => {
  const restaurantId = getRestaurantId(req);
  const d = req.body;
  const info = restaurantsDb.prepare('INSERT INTO daily_menus (restaurant_id,menu_date,mode,title,notes,base_price,sell_soup_separately,soup_price,sell_tray_separately,tray_price,max_lunches_per_order,status) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(restaurantId, d.menu_date || getToday(), d.mode || 'mixed', d.title || 'Menú del día', d.notes || '', moneyInt(d.base_price, 15000), d.sell_soup_separately ? 1 : 0, moneyInt(d.soup_price, 6000), d.sell_tray_separately ? 1 : 0, moneyInt(d.tray_price, 13000), Math.min(10, moneyInt(d.max_lunches_per_order, 10)), d.status || 'published');
  const stmt = restaurantsDb.prepare('INSERT INTO menu_items (menu_id,inventory_item_id,category,name,stock,remaining,price_delta,price,is_special,image_url,plate_json) VALUES (?,?,?,?,?,?,?,?,?,?,?)');
  for (const item of d.items || []) {
    const inv = item.inventory_item_id ? restaurantsDb.prepare('SELECT * FROM inventory_items WHERE id=?').get(item.inventory_item_id) : null;
    const category = item.category || inv?.category || 'complete_plate';
    const isComplete = category === 'complete_plate';
    stmt.run(info.lastInsertRowid, item.inventory_item_id || null, category, item.name || inv?.name, moneyInt(item.stock ?? inv?.stock), moneyInt(item.remaining ?? item.stock ?? inv?.stock), isComplete ? 0 : moneyInt(item.price_delta ?? inv?.additional_cost), isComplete ? moneyInt(item.price ?? inv?.price) : 0, isComplete ? 0 : moneyInt(item.is_special ?? inv?.is_special), item.image_url || inv?.image_url || '', jsonString(item.plate || {}));
  }
  res.status(201).json({ id: info.lastInsertRowid });
});

app.get('/api/restaurant/orders/live', auth(RESTAURANT_ROLES), restaurantGuard, (req, res) => {
  const id = getRestaurantId(req);
  const date = req.query.date || getToday();
  const rows = coreDb.prepare("SELECT * FROM orders WHERE restaurant_id=? AND substr(pickup_slot,1,10)=? ORDER BY pickup_slot ASC, created_at ASC").all(id, date);
  res.json({ groups: groupedOrders(rows), rows: rows.map(serializeOrder) });
});

app.patch('/api/restaurant/orders/:id/status', auth(RESTAURANT_ROLES), restaurantGuard, (req, res) => {
  const order = coreDb.prepare('SELECT * FROM orders WHERE id=?').get(req.params.id);
  if (!order) return res.status(404).json({ message: 'Pedido no encontrado.' });
  if (Number(order.restaurant_id) !== Number(getRestaurantId(req))) return res.status(403).json({ message: 'No autorizado.' });
  if (order.status === 'claimed') return res.status(409).json({ message: 'Este pedido ya fue reclamado por QR. No se puede modificar.' });
  const status = req.body.status;
  if (!['preparing','ready','delayed','cancelled'].includes(status)) return res.status(400).json({ message: 'Estado inválido para esta acción.' });
  let extra = '';
  if (status === 'delayed') { extra = ', delayed_at=CURRENT_TIMESTAMP'; applyPenalty(order.restaurant_id, order.id, 'Pedido marcado en demora', -1, 0); }
  if (status === 'cancelled') { extra = ', cancelled_at=CURRENT_TIMESTAMP, payment_status=?'; applyPenalty(order.restaurant_id, order.id, 'Restaurante canceló el pedido', -3, 8); releaseSlot(order); }
  if (status === 'cancelled') coreDb.prepare(`UPDATE orders SET status=?, updated_at=CURRENT_TIMESTAMP ${extra} WHERE id=?`).run(status, order.payment_method === 'online' ? 'refund_pending_or_credit' : 'cancelled_no_charge', order.id);
  else coreDb.prepare(`UPDATE orders SET status=?, updated_at=CURRENT_TIMESTAMP ${extra} WHERE id=?`).run(status, order.id);
  res.json(serializeOrder(coreDb.prepare('SELECT * FROM orders WHERE id=?').get(order.id)));
});

app.post('/api/restaurant/orders/scan', auth(RESTAURANT_ROLES), restaurantGuard, (req, res) => {
  const text = String(req.body.qr_text || '').trim();
  const codeMatch = text.match(/QL-[A-F0-9]{8}/i);
  const publicCode = codeMatch?.[0]?.toUpperCase() || text.toUpperCase();
  const order = coreDb.prepare('SELECT * FROM orders WHERE public_code=?').get(publicCode);
  if (!order) return res.status(404).json({ message: 'QR inválido o pedido no encontrado.' });
  if (Number(order.restaurant_id) !== Number(getRestaurantId(req))) return res.status(403).json({ message: 'Este QR pertenece a otro restaurante.' });
  if (order.status === 'claimed') return res.status(409).json({ message: 'Este QR ya fue usado y dejó de tener validez.' });
  if (['cancelled','no_show'].includes(order.status)) return res.status(409).json({ message: 'Este pedido no puede reclamarse.' });
  const paymentStatus = order.payment_method === 'cash' ? 'cash_collected_at_counter' : 'paid_released';
  coreDb.prepare("UPDATE orders SET status='claimed', claimed_at=CURRENT_TIMESTAMP, completed_at=CURRENT_TIMESTAMP, payment_status=?, commission_settled=1, settlement_amount=?, delivery_validation_json=?, updated_at=CURRENT_TIMESTAMP WHERE id=?")
    .run(paymentStatus, order.subtotal, jsonString({ scanned_by: req.user.username, scanned_at: new Date().toISOString(), qr_text: text }), order.id);
  res.json({ message: 'QR validado. Pedido entregado y dinero liberado al restaurante.', order: serializeOrder(coreDb.prepare('SELECT * FROM orders WHERE id=?').get(order.id)) });
});

app.get('/api/restaurant/analytics', auth(RESTAURANT_ROLES), restaurantGuard, requireRestaurantFull, (req, res) => {
  const id = getRestaurantId(req);
  const summary = coreDb.prepare("SELECT COUNT(*) orders, COALESCE(SUM(total),0) processed, COALESCE(SUM(CASE WHEN status='claimed' THEN subtotal ELSE 0 END),0) released, COALESCE(AVG(total),0) avg_ticket FROM orders WHERE restaurant_id=?").get(id);
  const pendingHeld = coreDb.prepare("SELECT COALESCE(SUM(total),0) held FROM orders WHERE restaurant_id=? AND payment_method='online' AND status NOT IN ('claimed','cancelled')").get(id).held;
  const frequent = coreDb.prepare('SELECT customer_name, COUNT(*) visits, COALESCE(SUM(total),0) spent FROM orders WHERE restaurant_id=? GROUP BY user_id ORDER BY visits DESC LIMIT 10').all(id);
  const items = coreDb.prepare('SELECT items_json FROM orders WHERE restaurant_id=?').all(id).flatMap((r) => parseJson(r.items_json, []).flatMap((l) => [l.type, ...(l.components || []).map((c) => c.name), ...(l.extras || []).map((c) => c.name)].filter(Boolean)));
  const preferences = Object.entries(items.reduce((a, x) => ({ ...a, [x]: (a[x] || 0) + 1 }), {})).map(([name, value]) => ({ name, value })).sort((a,b) => b.value - a.value).slice(0, 8);
  const restaurant = serializeRestaurant(restaurantsDb.prepare('SELECT * FROM restaurants WHERE id=?').get(id));
  const penalties = restaurantsDb.prepare('SELECT * FROM restaurant_penalties WHERE restaurant_id=? ORDER BY created_at DESC LIMIT 20').all(id);
  res.json({ summary, pendingHeld, frequent, preferences, restaurant, penalties, aiTips: [
    'Activa platos personalizables: el cliente entiende mejor el valor del corrientazo base y los especiales.',
    'Configura cupos reales por franja. Evita demoras y protege los puntos de acreditación.',
    'Los pagos en línea quedan retenidos hasta QR reclamado: prioriza preparar primero los pedidos con hora más cercana.'
  ]});
});

app.post('/api/restaurant/coupons', auth(RESTAURANT_ROLES), restaurantGuard, requireRestaurantFull, (req, res) => {
  const restaurantId = getRestaurantId(req);
  const codeValue = String(req.body.code || req.body.name || code('PROMO')).trim().toUpperCase();
  if (!codeValue) return res.status(400).json({ message: 'Escribe ID/nombre del cupón o promoción.' });
  if (restaurantsDb.prepare('SELECT id FROM coupons WHERE code=?').get(codeValue)) return res.status(409).json({ message: 'Ese código ya existe.' });
  const isRedeemable = req.body.kind === 'coupon' ? 1 : 0;
  const info = restaurantsDb.prepare(`INSERT INTO coupons (restaurant_id,code,name,description,starts_at,ends_at,discount_type,discount_value,effect_type,effect_value,effect_scope,coverage_restaurants_json,products_json,min_purchase,previous_purchases_required,max_uses,unlimited_uses,auto_apply,is_redeemable,is_promotion,active,created_by,creator_role,creator_user_id,creator_restaurant_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(restaurantId, codeValue, req.body.name || codeValue, req.body.description || '', req.body.starts_at || null, req.body.ends_at || req.body.expires_at || null, req.body.discount_type || 'fixed', moneyInt(req.body.effect_value || req.body.discount_value, 0), req.body.effect_type || 'discount_percent', moneyInt(req.body.effect_value || req.body.discount_value, 0), 'restaurant', jsonString([restaurantId]), jsonString(req.body.products || []), moneyInt(req.body.min_purchase, 0), moneyInt(req.body.previous_purchases_required, 0), moneyInt(req.body.max_uses, 100), req.body.unlimited_uses ? 1 : 0, 0, isRedeemable, 1, 1, req.user.username, req.user.role, req.user.id, restaurantId);
  res.status(201).json(serializeCoupon(restaurantsDb.prepare('SELECT * FROM coupons WHERE id=?').get(info.lastInsertRowid)));
});

app.get('/api/restaurant/coupons', auth(RESTAURANT_ROLES), restaurantGuard, (req, res) => {
  res.json(restaurantsDb.prepare('SELECT * FROM coupons WHERE restaurant_id=? ORDER BY created_at DESC').all(getRestaurantId(req)).map(serializeCoupon));
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ message: 'Error interno de QuickLunch.', detail: err.message });
});

app.listen(PORT, () => console.log(`QuickLunch API corriendo en http://localhost:${PORT}`));
