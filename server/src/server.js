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
import os from 'os';
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
const ALLOWED_ORIGINS = (process.env.CLIENT_ORIGINS || CLIENT_ORIGIN)
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);
function isLanOrigin(origin = '') {
  return /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[0-1])\.\d+\.\d+)(:\d+)?$/.test(origin);
}

app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
app.use(cors({
  credentials: true,
  origin(origin, cb) {
    if (!origin || ALLOWED_ORIGINS.includes(origin) || isLanOrigin(origin)) return cb(null, true);
    return cb(new Error('Origen no permitido por QuickLunch. Agrega la URL a CLIENT_ORIGINS.'));
  }
}));
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
const deliveryCode = () => `${crypto.randomInt(0, 1000).toString().padStart(3, '0')}-${crypto.randomInt(0, 1000).toString().padStart(3, '0')}`;
const toSlug = (value) => slugify(value || '', { lower: true, strict: true, locale: 'es' });
const moneyInt = (v, fallback = 0) => Number.isFinite(Number(v)) ? Math.max(0, Math.round(Number(v))) : fallback;
const asArray = (v) => Array.isArray(v) ? v : [];
const getToday = () => new Date().toISOString().slice(0, 10);

const BAD_WORDS = [
  'porno','pornografia','pornografía','sexo','desnudo','desnuda','nude','xxx','droga','cocaina','cocaína','marihuana','weed',
  'arma','pistola','rifle','sangre','gore','odio','nazi','terrorismo','matar','asesinar'
];
function cleanUser(value = '') {
  return String(value || '').trim();
}
function hasBadWords(value = '') {
  const normalized = String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9ñ\s_-]/g, ' ');
  return BAD_WORDS.some((word) => normalized.includes(word.normalize('NFD').replace(/[\u0300-\u036f]/g, '')));
}


function normalizeFoodText(value = '') {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9ñ\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const FOOD_IMAGE_DICTIONARY = [
  { keys: ['tilapia', 'pescado', 'mojarra'], terms: ['tilapia frita servida en plato', 'pescado frito plato restaurante', 'mojarra frita almuerzo colombiano'] },
  { keys: ['chuleta cerdo', 'chuleta de cerdo', 'cerdo', 'puerco'], terms: ['chuleta de cerdo apanada plato', 'chuleta de cerdo almuerzo restaurante', 'cerdo frito servido en plato'] },
  { keys: ['chuleta res', 'chuleta de res', 'carne res', 'res', 'bistec'], terms: ['chuleta de res plato restaurante', 'bistec de res servido en plato', 'carne de res almuerzo colombiano'] },
  { keys: ['pollo', 'pechuga'], terms: ['pollo asado servido en plato', 'pechuga de pollo almuerzo restaurante', 'pollo a la plancha plato comida'] },
  { keys: ['costilla', 'bbq'], terms: ['costilla bbq servida en plato', 'costillas bbq restaurante comida', 'costilla de cerdo plato almuerzo'] },
  { keys: ['frijol', 'frijoles'], terms: ['frijoles servidos en plato colombiano', 'frijoles caseros almuerzo colombiano', 'frijoles con arroz plato'] },
  { keys: ['lenteja', 'lentejas'], terms: ['lentejas servidas en plato', 'lentejas caseras almuerzo', 'lentejas con arroz comida casera'] },
  { keys: ['pasta', 'espagueti', 'spaghetti'], terms: ['pasta servida en plato restaurante', 'espagueti plato comida', 'pasta como acompañamiento almuerzo'] },
  { keys: ['arroz'], terms: ['arroz blanco servido en plato', 'arroz acompañamiento comida', 'arroz plato almuerzo'] },
  { keys: ['ensalada'], terms: ['ensalada fresca servida en plato', 'ensalada acompañamiento almuerzo', 'ensalada restaurante comida'] },
  { keys: ['papa cocida', 'papa salada'], terms: ['papa cocida servida en plato', 'papas cocidas acompañamiento', 'papa salada almuerzo colombiano'] },
  { keys: ['papa frita', 'papas fritas'], terms: ['papas fritas servidas en plato', 'papas fritas restaurante comida', 'french fries plate food'] },
  { keys: ['patacon', 'toston'], terms: ['patacon frito plato colombiano', 'tostones servidos en plato', 'patacon acompañamiento comida'] },
  { keys: ['sopa arroz'], terms: ['sopa de arroz plato hondo', 'sopa de arroz casera', 'sopa de arroz comida colombiana'] },
  { keys: ['sopa maiz', 'sopa de maiz'], terms: ['sopa de maiz plato hondo', 'sopa de maiz casera', 'corn soup bowl'] },
  { keys: ['sopa pasta', 'sopa de pasta'], terms: ['sopa de pasta plato hondo', 'sopa de fideos casera', 'noodle soup bowl'] },
  { keys: ['sopa'], terms: ['sopa casera plato hondo', 'sopa colombiana servida en plato', 'soup bowl food photography'] },
  { keys: ['mora'], terms: ['jugo de mora vaso', 'bebida de mora restaurante', 'blackberry juice glass'] },
  { keys: ['pina', 'piña'], terms: ['jugo de piña vaso', 'bebida de piña restaurante', 'pineapple juice glass'] },
  { keys: ['guayaba'], terms: ['jugo de guayaba vaso', 'bebida de guayaba restaurante', 'guava juice glass'] },
  { keys: ['hamburguesa', 'burger'], terms: ['hamburguesa servida con papas', 'combo hamburguesa restaurante', 'burger meal restaurant'] }
];

function foodDictionaryMatches(query = '', description = '') {
  const base = normalizeFoodText(`${query} ${description}`);
  return FOOD_IMAGE_DICTIONARY.filter((row) => row.keys.some((key) => base.includes(normalizeFoodText(key))));
}

function imageSearchTerms(query = '', description = '') {
  const rawName = String(query || '').trim();
  const rawDescription = String(description || '').trim();
  const matches = foodDictionaryMatches(rawName, rawDescription);
  const negative = '-logo -icono -vector -dibujo -clipart -caricatura -emoji -menu -menú -plantilla -ilustracion -ilustración';
  const baseQueries = [];
  if (rawName && rawDescription) baseQueries.push(`${rawName} ${rawDescription} comida real servida en plato foto ${negative}`);
  if (rawName) baseQueries.push(`${rawName} plato restaurante foto real ${negative}`);
  if (rawName) baseQueries.push(`${rawName} almuerzo colombiano servido foto ${negative}`);
  for (const match of matches) for (const term of match.terms) baseQueries.push(`${term} foto real alta calidad ${negative}`);
  if (rawName) baseQueries.push(`${rawName} food photography plated dish ${negative}`);
  if (rawName) baseQueries.push(`${rawName} restaurant dish real photo ${negative}`);
  return [...new Set(baseQueries.map((item) => item.replace(/\s+/g, ' ').trim()).filter(Boolean))].slice(0, 10);
}

function productWantedWords(originalQuery = '', description = '') {
  const exact = normalizeFoodText(`${originalQuery} ${description}`).split(' ').filter((word) => word.length > 2);
  const dictionaryWords = foodDictionaryMatches(originalQuery, description).flatMap((row) => row.terms.join(' ').split(' '));
  const generic = ['plato','comida','restaurante','almuerzo','servido','foto','real','dish','food','restaurant','plate','served'];
  return [...new Set([...exact, ...dictionaryWords, ...generic].map(normalizeFoodText).filter((word) => word.length > 2))];
}

function imageScore(item, originalQuery = '', description = '') {
  const haystack = normalizeFoodText(`${item.label || ''} ${item.context || ''} ${item.source || ''}`);
  const wanted = productWantedWords(originalQuery, description);
  const primary = normalizeFoodText(originalQuery).split(' ').filter((word) => word.length > 2);
  const badVisual = ['logo','icono','vector','clipart','dibujo','caricatura','emoji','menu','menú','plantilla','ilustracion','ilustración','receta escrita'];
  let score = 0;
  for (const word of wanted) if (haystack.includes(word)) score += 4;
  for (const word of primary) if (haystack.includes(word)) score += 10;
  for (const word of badVisual) if (haystack.includes(normalizeFoodText(word))) score -= 30;
  if (/Openverse/i.test(item.source || '')) score += 24;
  if (/Wikimedia/i.test(item.source || '')) score += 12;
  if (/Flickr|WordPress|Commons/i.test(item.source || '')) score += 8;
  return score;
}

function hostFromUrl(url = '') {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}

function isProbablyImageUrl(url = '') {
  return /^https?:\/\//i.test(url) && !/\.(svg|gif)(\?|$)/i.test(url);
}

function inferImageExtension(contentType = '', url = '') {
  if (/png/i.test(contentType) || /\.png(\?|$)/i.test(url)) return '.png';
  if (/webp/i.test(contentType) || /\.webp(\?|$)/i.test(url)) return '.webp';
  return '.jpg';
}

async function downloadImageToUploads(remoteUrl, label = 'imagen') {
  const url = new URL(remoteUrl);
  if (!['https:', 'http:'].includes(url.protocol)) throw new Error('URL de imagen no válida.');
  const response = await fetch(url, { headers: { 'User-Agent': 'QuickLunchDemo/1.0 image importer' } });
  if (!response.ok) throw new Error('No se pudo descargar la imagen seleccionada.');
  const contentType = response.headers.get('content-type') || '';
  if (!contentType.startsWith('image/')) throw new Error('El enlace no corresponde a una imagen.');
  const arrayBuffer = await response.arrayBuffer();
  if (arrayBuffer.byteLength > 5 * 1024 * 1024) throw new Error('La imagen supera el tamaño permitido de 5MB.');
  const folder = path.join(uploadDir, 'quicklunch', 'suggested');
  fs.mkdirSync(folder, { recursive: true });
  const ext = inferImageExtension(contentType, remoteUrl);
  const filename = `${toSlug(label || 'imagen') || 'imagen'}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}${ext}`;
  fs.writeFileSync(path.join(folder, filename), Buffer.from(arrayBuffer));
  return `/uploads/quicklunch/suggested/${filename}`;
}

function hashInt(value = '') {
  return crypto.createHash('md5').update(String(value)).digest().readUInt32BE(0);
}


const GOOGLE_CSE_API_KEY = process.env.GOOGLE_CSE_API_KEY || '';
const GOOGLE_CSE_ID = process.env.GOOGLE_CSE_ID || '';
const IMAGE_SEARCH_DOMAINS = (process.env.QL_IMAGE_SEARCH_DOMAINS || [
  // Recetas y cocina colombiana/latina
  'misrecetascolombia.com',
  'elrinconcolombiano.com',
  'recetas123.net',
  'mycolombianrecipes.com',
  'sweetysalado.com',
  'antojandoando.com',
  'colombia.com',
  'comidascolombianas.com',
  'recetinas.com',
  'recetasgratis.net',
  'cookpad.com',
  'kiwilimon.com',
  'quericavida.com',
  'goya.com',
  'comedera.com',
  'paulinacocina.net',
  'directoalpaladar.com',
  'bonviveur.es',
  'hogarmania.com',
  'cocinatis.com',
  'recetasdecocina.elmundo.es',
  '196flavors.com',
  'allrecipes.com',
  'blogspot.com',
  'comida.com',
  'gastronomia.com',
  'platos.com',
  'cocina.com',

  // Supermercados y productos industriales/bebidas
  'exito.com',
  'carulla.com',
  'jumbo.com.co',
  'olimpica.com',
  'tiendasd1.com',
  'alkosto.com',
  'makro.com.co',
  'pricesmart.com.co',
  'farmatodo.com.co',
  'merqueo.com',
  'rappi.com.co',
  'mercadolibre.com.co',
  'nutresa.com',
  'postobon.com',
  'coca-cola.com',
  'alpina.com'
].join(','))
  .split(',')
  .map((domain) => domain.trim().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '').toLowerCase())
  .filter(Boolean);

const GENERIC_IMAGE_WORDS = new Set([
  'plato','platos','comida','comidas','restaurante','restaurantes','almuerzo','corrientazo','corrientazos','servido','servida','servir','foto','real','alta','calidad','casera','casero','colombiano','colombiana','con','para','del','de','la','el','los','las','una','uno','un','y','en','por','al','dish','food','plate','restaurant','served','photo','meal','lunch',
  'frito','frita','asado','asada','apanado','apanada','crocante','especial','porcion','porción','receta','acompanamiento','acompañamiento'
]);

function allowedImageDomain(url = '', displayLink = '') {
  const host = hostFromUrl(url || displayLink).toLowerCase();
  const display = String(displayLink || '').replace(/^www\./, '').toLowerCase();
  return IMAGE_SEARCH_DOMAINS.some((domain) => host === domain || host.endsWith(`.${domain}`) || display === domain || display.endsWith(`.${domain}`));
}

function coreFoodWords(query = '', description = '') {
  const direct = normalizeFoodText(`${query} ${description}`).split(' ')
    .filter((word) => word.length > 2 && !GENERIC_IMAGE_WORDS.has(word));
  const dictionary = foodDictionaryMatches(query, description)
    .flatMap((row) => row.keys)
    .flatMap((key) => normalizeFoodText(key).split(' '))
    .filter((word) => word.length > 2 && !GENERIC_IMAGE_WORDS.has(word));
  return [...new Set([...direct, ...dictionary])].slice(0, 8);
}

function googleImageScore(item = {}, query = '', description = '') {
  const title = item.title || '';
  const snippet = item.snippet || '';
  const contextLink = item.image?.contextLink || '';
  const displayLink = item.displayLink || '';
  const imageUrl = item.link || '';
  const haystack = normalizeFoodText(`${title} ${snippet} ${contextLink} ${displayLink} ${imageUrl}`);
  const words = coreFoodWords(query, description);
  const badVisual = ['logo','icono','vector','clipart','dibujo','caricatura','emoji','menu','menú','plantilla','ilustracion','ilustración','pdf','mapa','banner','poster','collage','infografia','infografía'];
  let score = 0;
  for (const word of words) if (haystack.includes(word)) score += 18;
  for (const word of normalizeFoodText(query).split(' ').filter(w => w.length > 2)) if (haystack.includes(word)) score += 10;
  for (const bad of badVisual) if (haystack.includes(normalizeFoodText(bad))) score -= 50;
  if (allowedImageDomain(contextLink || imageUrl, displayLink)) score += 35;
  const width = Number(item.image?.width || 0);
  const height = Number(item.image?.height || 0);
  if (width >= 500 && height >= 350) score += 8;
  if (width && height && (width < 250 || height < 180)) score -= 30;
  if (/googleusercontent|gstatic/i.test(item.image?.thumbnailLink || '')) score += 4;
  return score;
}

function googleItemToCandidate(item = {}, query = '', description = '') {
  const thumbnail = item.image?.thumbnailLink || item.link;
  const url = item.link || thumbnail;
  const context = item.image?.contextLink || item.formattedUrl || item.displayLink || '';
  return {
    label: item.title || realFoodLabel(query, detectRealFoodProfile(query, description)),
    url,
    thumbnail,
    source: `Google CSE · ${item.displayLink || hostFromUrl(context || url) || 'sitio de referencia'}`,
    context,
    attribution: 'Imagen sugerida desde fuentes de cocina, recetas, supermercados o productos configurados en Google Programmable Search.'
  };
}

async function fetchGoogleCseCandidates(query = '', description = '') {
  if (!GOOGLE_CSE_API_KEY || !GOOGLE_CSE_ID) return [];
  const terms = realFoodTerms(query, description).slice(0, 3);
  const candidates = [];
  const baseParams = {
    key: GOOGLE_CSE_API_KEY,
    cx: GOOGLE_CSE_ID,
    searchType: 'image',
    safe: 'active',
    imgType: 'photo',
    imgSize: 'large',
    hl: 'es',
    gl: 'co',
    num: '10'
  };
  const requests = [];

  // Primero se consulta el motor configurado directamente con el nombre + descripción.
  // Luego se refuerza por grupos de dominios para incluir recetas, supermercados y productos industriales.
  for (const term of terms) {
    requests.push({ q: term });
  }

  const domainChunks = [];
  for (let i = 0; i < IMAGE_SEARCH_DOMAINS.length; i += 8) {
    domainChunks.push(IMAGE_SEARCH_DOMAINS.slice(i, i + 8));
  }
  for (const term of terms.slice(0, 2)) {
    for (const chunk of domainChunks.slice(0, 5)) {
      requests.push({ q: `${term} (${chunk.map((d) => `site:${d}`).join(' OR ')})` });
    }
  }

  const industrialHints = ['jugo', 'bebida', 'gaseosa', 'agua', 'producto', 'industrial', 'empaque', 'botella', 'lata', 'snack', 'postre'];
  const normalizedSearch = normalizeFoodText(`${query} ${description}`);
  const shouldPrioritizeMarkets = industrialHints.some((hint) => normalizedSearch.includes(hint));
  const domainPriority = shouldPrioritizeMarkets
    ? IMAGE_SEARCH_DOMAINS.filter((d) => /exito|carulla|jumbo|olimpica|tiendasd1|alkosto|makro|pricesmart|farmatodo|merqueo|rappi|mercadolibre|nutresa|postobon|coca-cola|alpina/.test(d)).concat(IMAGE_SEARCH_DOMAINS)
    : IMAGE_SEARCH_DOMAINS;

  for (const domain of [...new Set(domainPriority)].slice(0, 18)) {
    requests.push({ q: `${terms[0] || query}`, siteSearch: domain, siteSearchFilter: 'i' });
  }

  for (const request of requests.slice(0, 24)) {
    const params = new URLSearchParams({ ...baseParams, ...request });
    const json = await fetchJsonSafe(`https://www.googleapis.com/customsearch/v1?${params.toString()}`, { timeout: 6500 });
    const items = Array.isArray(json?.items) ? json.items : [];
    const ranked = items
      .filter((item) => item?.link && item?.image?.thumbnailLink)
      .filter((item) => allowedImageDomain(item.image?.contextLink || item.link, item.displayLink))
      .map((item) => ({ item, score: googleImageScore(item, query, description) }))
      .filter(({ score }) => score >= 15)
      .sort((a, b) => b.score - a.score)
      .map(({ item }) => googleItemToCandidate(item, query, description));
    for (const item of ranked) addRealPhotoCandidate(candidates, item, query, description);
    if (candidates.length >= 5) break;
  }
  return candidates.slice(0, 5);
}

function sign(account) {
  return jwt.sign({ id: account.id, username: account.username, role: account.role, restaurant_id: account.restaurant_id }, JWT_SECRET, { expiresIn: '12h' });
}

function isCustomerAccessRole(role) { return ['customer','gold','platinum'].includes(String(role || '').toLowerCase()); }
function canAccess(user, required = []) {
  if (!required.length) return true;
  if (user.role === 'owner') return true;
  if (required.includes('customer') && isCustomerAccessRole(user.role)) return true;
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
  const online = moneyInt(s.fees?.online, 1500);
  return { online: online === 500 ? 1500 : online, cash: moneyInt(s.fees?.cash, 1000), commissionPercent: moneyInt(s.fees?.commissionPercent, 5), platinumPrice: moneyInt(s.fees?.platinumPrice, 16900), goldDiscountPercent: moneyInt(s.fees?.goldDiscountPercent, 30) };
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

const MEMBERSHIP_PLANS = {
  gold: {
    label: 'Gold', color: 'oro', restaurantRequired: true, ticketCounts: { 15: 15, 30: 30 }, discounts: { 15: 0.30, 30: 0.30 }, serviceFeeExempt: true,
    benefits: ['Tiquetera sin vencimiento: 15 o 30 almuerzos en el restaurante elegido', 'El saldo se vence únicamente cuando se agota', 'Tarifa de servicio exonerada al usar la tiquetera Gold']
  },
  platinum: {
    label: 'Platinum', color: 'platino', prices: { 15: defaultFees().platinumPrice, 30: defaultFees().platinumPrice }, restaurantRequired: false,
    benefits: ['Precio fijo de 16.900 COP', '50% de descuento en tarifa de servicio en toda la app', 'Interfaz Platinum premium y recomendaciones V2 globales']
  }
};
function restaurantBaseLunchPrice(restaurantId) {
  const todayMenu = restaurantsDb.prepare("SELECT base_price FROM daily_menus WHERE restaurant_id=? AND status='published' ORDER BY menu_date DESC, id DESC LIMIT 1").get(restaurantId);
  if (todayMenu?.base_price) return moneyInt(todayMenu.base_price, 15000);
  const r = restaurantsDb.prepare('SELECT settings_json FROM restaurants WHERE id=?').get(restaurantId);
  const settings = parseJson(r?.settings_json, {});
  return moneyInt(settings?.baseLunchPrice || settings?.base_lunch_price || 15000, 15000);
}
function goldMembershipQuote(restaurantId, duration) {
  const basePrice = restaurantBaseLunchPrice(restaurantId);
  const tickets = MEMBERSHIP_PLANS.gold.ticketCounts[duration] || 0;
  const creditValue = basePrice * tickets;
  const fees = getRestaurantFees(restaurantId);
  const feePerLunch = moneyInt(fees.cash || defaultFees().cash, 1000);
  const normalValue = (basePrice + feePerLunch) * tickets;
  const discountRate = Math.max(0, Math.min(80, Number(fees.goldDiscountPercent ?? defaultFees().goldDiscountPercent ?? 30))) / 100;
  const price = Math.round(normalValue * (1 - discountRate));
  const serviceFeeSavings = feePerLunch * tickets;
  return { basePrice, tickets, creditValue, price, savings: normalValue - price, normalValue, serviceFeeSavings, discountRate, feePerLunch, goldDiscountPercent: Math.round(discountRate * 100) };
}
function membershipActive(account = {}) {
  if (!account || !['gold','platinum'].includes(String(account.membership_type || '').toLowerCase())) return false;
  if (!['active','cancelled'].includes(String(account.membership_status || '').toLowerCase())) return false;
  if (!account.membership_ends_at) return true;
  return new Date(String(account.membership_ends_at).replace(' ', 'T')).getTime() >= Date.now();
}
function membershipDiscount(account = {}, restaurantId = null) {
  if (!membershipActive(account)) return { percent: 0, label: 'Sin membresía activa' };
  const type = String(account.membership_type).toLowerCase();
  if (type === 'platinum') return { percent: 50, label: 'Platinum: 50% de descuento en tarifa de servicio en toda la app' };
  if (type === 'gold' && Number(account.membership_restaurant_id || 0) === Number(restaurantId || 0)) return { percent: 100, label: 'Gold: tarifa de servicio exonerada al usar tu tiquetera en este restaurante' };
  return { percent: 0, label: 'Gold activo en otro restaurante' };
}
function calculateFee(paymentMethod, lunchCount, restaurantId, account = null) {
  const fees = getRestaurantFees(restaurantId);
  const raw = moneyInt(fees[paymentMethod] || defaultFees()[paymentMethod]) * Math.max(1, moneyInt(lunchCount, 1));
  const benefit = membershipDiscount(account, restaurantId);
  return Math.max(0, raw - Math.round(raw * Number(benefit.percent || 0) / 100));
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
    .run(1, order.restaurant_id, order.pickup_slot);
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

function restaurantRatingSummary(restaurantId) {
  const row = restaurantsDb.prepare('SELECT COUNT(*) count, COALESCE(AVG(rating),0) avg FROM restaurant_ratings WHERE restaurant_id=?').get(restaurantId);
  const average = Number(row?.avg || 0);
  return {
    average: Number(average.toFixed(2)),
    count: Number(row?.count || 0),
    display: Math.floor(average * 2) / 2
  };
}

function generateRestaurantDeliveryCode(restaurantId) {
  for (let i = 0; i < 80; i++) {
    const value = deliveryCode();
    const existing = coreDb.prepare("SELECT id FROM orders WHERE restaurant_id=? AND public_code=? AND status NOT IN ('claimed','cancelled','no_show')").get(restaurantId, value);
    if (!existing) return value;
  }
  throw new Error('No se pudo generar un código de entrega único para este restaurante. Intenta nuevamente.');
}

function decrementMenuStockForOrder(order) {
  const items = parseJson(order.items_json, []);
  const touched = new Map();
  const add = (id, qty = 1) => {
    const numeric = Number(id || 0);
    if (!numeric) return;
    touched.set(numeric, (touched.get(numeric) || 0) + qty);
  };
  for (const lunch of items) {
    if (lunch.complete_plate?.id) add(lunch.complete_plate.id);
    for (const comp of asArray(lunch.components)) if (!comp.skipped) add(comp.id);
    for (const extra of asArray(lunch.extras)) add(extra.id);
  }
  for (const [id, qty] of touched.entries()) {
    restaurantsDb.prepare('UPDATE menu_items SET remaining=CASE WHEN remaining >= ? THEN remaining-? ELSE 0 END WHERE id=?').run(qty, qty, id);
  }
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

function normalizeDateTime(value) {
  if (!value) return '';
  const raw = String(value).trim();
  if (!raw) return '';
  const normalized = raw.replace('T', ' ').slice(0, 16);
  return /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(normalized) ? normalized : normalized;
}

function visibleBenefitName(c = {}) {
  return couponLabel(c);
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
    used.push({ code: w.code, amount: take, source: 'cupón redimido' });
  }
  const restaurantCredits = usersDb.prepare('SELECT * FROM restaurant_credits WHERE user_id=? AND restaurant_id=? AND balance>0 ORDER BY updated_at ASC').all(userId, restaurantId);
  for (const c of restaurantCredits) {
    if (remaining <= 0) break;
    const take = Math.min(Number(c.balance || 0), remaining);
    usersDb.prepare('UPDATE restaurant_credits SET balance=balance-?, updated_at=CURRENT_TIMESTAMP WHERE id=?').run(take, c.id);
    remaining -= take;
    used.push({ code: 'CRÉDITO RESTAURANTE', amount: take, source: 'saldo por cancelación' });
  }
  const account = usersDb.prepare('SELECT wallet_balance FROM accounts WHERE id=?').get(userId);
  if (remaining > 0 && Number(account?.wallet_balance || 0) > 0) {
    const take = Math.min(Number(account.wallet_balance || 0), remaining);
    usersDb.prepare('UPDATE accounts SET wallet_balance=wallet_balance-? WHERE id=?').run(take, userId);
    remaining -= take;
    used.push({ code: 'SALDO GENERAL', amount: take, source: 'saldo general QuickLunch' });
  }
  return { discount: amount - remaining, used };
}

function automaticDiscounts(userId, restaurantId, subtotal, serviceFee, lunches = []) {
  const all = restaurantsDb.prepare('SELECT * FROM coupons WHERE active=1 AND is_redeemable=0').all()
    .filter((c) => couponActive(c) && couponCanCover(c, restaurantId));
  let discount = 0; let serviceDiscount = 0; const applied = [];
  const claimedCount = coreDb.prepare("SELECT COUNT(*) count FROM orders WHERE user_id=? AND restaurant_id=? AND status='claimed'").get(userId, restaurantId).count;
  const lunchText = JSON.stringify(lunches).toLowerCase();
  for (const c of all) {
    if (subtotal < Number(c.min_purchase || 0)) continue;
    if (claimedCount < Number(c.previous_purchases_required || 0)) continue;
    const products = parseJson(c.products_json, []);
    let eligibleBase = subtotal;
    if (products.length) {
      const productTokens = products.map((p) => String(p).toLowerCase());
      const matches = productTokens.some((p) => lunchText.includes(`"id":${p}`) || lunchText.includes(p));
      if (!matches) continue;
      eligibleBase = lunches.filter((l) => productTokens.some((p) => JSON.stringify(l).toLowerCase().includes(p))).reduce((sum, l) => sum + Number(l.total || 0), 0) || subtotal;
    }
    let d = 0; let sd = 0;
    if (c.effect_type === 'discount_percent') d = Math.round(eligibleBase * Number(c.effect_value || c.discount_value || 0) / 100);
    if (c.effect_type === 'discount_fixed') d = Math.min(eligibleBase, Number(c.effect_value || c.discount_value || 0));
    if (c.effect_type === 'credit_fixed') d = Math.min(eligibleBase, Number(c.effect_value || c.discount_value || 0));
    if (c.effect_type === 'service_free') sd = serviceFee;
    if (c.effect_type === 'service_percent') sd = Math.round(serviceFee * Number(c.effect_value || c.discount_value || 0) / 100);
    if (d || sd) { discount += d; serviceDiscount += sd; applied.push({ coupon_id: c.id, code: c.code, name: c.name || c.description, discount: d, serviceDiscount: sd, amount: d + sd }); }
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
    `Tarifas actuales: pago digital ${settings.fees?.online || 1500}, pago en caja ${settings.fees?.cash || 1000}. Las membresías aplican descuentos automáticos sobre la tarifa de servicio.`
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

app.get('/api/health', (_, res) => res.json({ ok: true, name: 'QuickLunch API', version: '1.0.34', time: new Date().toISOString() }));
app.get('/api/network-info', (_, res) => {
  const addresses = [];
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const item of entries || []) {
      if (item.family === 'IPv4' && !item.internal) addresses.push(item.address);
    }
  }
  res.json({ ok: true, port: PORT, clientPort: 5173, addresses, urls: addresses.map((ip) => ({ frontend: `http://${ip}:5173`, backend: `http://${ip}:${PORT}/api/health` })) });
});
app.get('/api/settings', (_, res) => res.json(qlSettings()));

app.post('/api/auth/login', (req, res) => {
  const schema = z.object({ username: z.string().min(3), password: z.string().min(6), city: z.string().optional() });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: 'Datos incompletos.' });
  if (!requireCali(parsed.data.city)) return res.status(403).json({ message: 'Ciudad próximamente disponible.' });
  const account = usersDb.prepare('SELECT * FROM accounts WHERE lower(username) = lower(?) OR lower(email) = lower(?)').get(parsed.data.username, parsed.data.username);
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
  const account = usersDb.prepare('SELECT * FROM accounts WHERE lower(username)=lower(?)').get(parsed.data.identifier);
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
  const todayDate = getToday();
  const rows = restaurantsDb.prepare("SELECT * FROM restaurants WHERE status='active' ORDER BY created_at DESC").all()
    .map((r) => {
      const promo = bestPromotion(r.id);
      const todayMenu = restaurantsDb.prepare("SELECT id,menu_date,title,status FROM daily_menus WHERE restaurant_id=? AND menu_date=? AND status='published' ORDER BY id DESC LIMIT 1").get(r.id, todayDate);
      const latestMenu = restaurantsDb.prepare("SELECT id,menu_date,title,status FROM daily_menus WHERE restaurant_id=? AND status='published' ORDER BY menu_date DESC, id DESC LIMIT 1").get(r.id);
      return { ...serializeRestaurant(r), rating: restaurantRatingSummary(r.id), menuPublished: !!todayMenu, todayMenu, latestMenu, promotion: serializeCoupon(promo) };
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
  res.json({ restaurant: { ...restaurant, rating: restaurantRatingSummary(restaurant.id), promotion: serializeCoupon(bestPromotion(restaurant.id)) }, menu: menu ? { ...menu, items } : null });
});

app.get('/api/restaurants/:id/slots', (req, res) => {
  const restaurant = restaurantsDb.prepare('SELECT * FROM restaurants WHERE id=?').get(req.params.id);
  if (!restaurant) return res.status(404).json({ message: 'Restaurante no encontrado.' });
  const date = req.query.date || getToday();
  const settings = { ...defaultRestaurantSettings(), ...parseJson(restaurant.settings_json, {}) };
  const lunchCount = 1; // Los cupos son por pedido, no por cantidad de almuerzos dentro del pedido.
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
      if (available >= 1) slots.push({ time, capacity, reserved, available, intervalMinutes: interval });
    }
  }
  res.json(slots);
});

// ORDERS
app.post('/api/orders', auth(['customer', 'owner']), (req, res) => {
  const schema = z.object({ restaurant_id: z.number(), menu_id: z.number().optional().nullable(), pickup_date: z.string(), pickup_time: z.string(), payment_method: z.enum(['online', 'cash']), lunches: z.array(z.any()).min(1).max(10), coupon_code: z.string().optional(), notes: z.string().optional(), use_credits: z.boolean().default(false) });
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
  if (!chosen || chosen.available < 1) return res.status(409).json({ message: 'Ese horario ya no tiene cupos disponibles.' });

  const subtotal = d.lunches.reduce((sum, lunch) => sum + moneyInt(lunch.total, 0), 0);
  const serviceFee = calculateFee(d.payment_method, lunchCount, d.restaurant_id, req.user);
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
          discount += take; couponUse.push({ coupon_id: coupon.id, code: coupon.code, amount: take, source: 'crédito redimido' });
        }
      } else {
        const val = Number(coupon.effect_value || coupon.discount_value || 0);
        if (coupon.effect_type === 'discount_percent') discount += Math.round(subtotal * val / 100);
        else if (coupon.effect_type === 'service_free') discount += serviceFee;
        else if (coupon.effect_type === 'service_percent') discount += Math.round(serviceFee * val / 100);
        else discount += Math.min(subtotal, val);
        couponUse.push({ coupon_id: coupon.id, code: coupon.code, amount: discount, source: 'cupón directo' });
      }
      restaurantsDb.prepare('UPDATE coupons SET current_uses=current_uses+1 WHERE id=?').run(coupon.id);
    }
  }
  const auto = automaticDiscounts(req.user.id, d.restaurant_id, subtotal, serviceFee, d.lunches);
  discount += auto.discount + auto.serviceDiscount;
  couponUse.push(...auto.applied);
  const walletAuto = d.use_credits ? applyCouponCredits(req.user.id, d.restaurant_id, Math.max(0, subtotal + serviceFee - discount)) : { discount: 0, used: [] };
  discount += walletAuto.discount;
  couponUse.push(...walletAuto.used.map((x) => ({ ...x, source: 'créditos usados por decisión del cliente' })));
  const total = Math.max(0, subtotal + serviceFee - discount);
  const publicCode = generateRestaurantDeliveryCode(d.restaurant_id);
  const qrPayload = { public_code: publicCode, order_id: null, restaurant_id: d.restaurant_id, url: `${CLIENT_ORIGIN}/confirmar/${publicCode}`, rule: 'VALIDACION_CON_CODIGO_DE_6_DIGITOS' };
  const info = coreDb.prepare(`INSERT INTO orders (public_code,user_id,restaurant_id,restaurant_name,customer_name,menu_id,pickup_slot,payment_method,payment_status,subtotal,service_fee,discount,total,lunch_count,qr_payload,items_json,notes) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(publicCode, req.user.id, d.restaurant_id, restaurant.name, req.user.full_name || req.user.username, d.menu_id || null, slotTime, d.payment_method, d.payment_method === 'online' ? 'paid_held' : 'cash_pending', subtotal, serviceFee, discount, total, lunchCount, jsonString(qrPayload), jsonString(d.lunches, []), d.notes || '');
  qrPayload.order_id = info.lastInsertRowid;
  coreDb.prepare('UPDATE orders SET qr_payload=? WHERE id=?').run(jsonString(qrPayload), info.lastInsertRowid);
  const existingSlot = coreDb.prepare('SELECT * FROM pickup_slots WHERE restaurant_id=? AND slot_time=?').get(d.restaurant_id, slotTime);
  if (existingSlot) coreDb.prepare('UPDATE pickup_slots SET reserved=reserved+1 WHERE id=?').run(existingSlot.id);
  else coreDb.prepare('INSERT INTO pickup_slots (restaurant_id,slot_time,capacity,reserved) VALUES (?,?,?,1)').run(d.restaurant_id, slotTime, chosen.capacity);
  if (d.payment_method === 'online') coreDb.prepare('INSERT INTO payments (order_id,gateway,method_detail,amount,status,transaction_ref) VALUES (?,?,?,?,?,?)').run(info.lastInsertRowid, 'QuickLunch Demo Gateway', 'Tarjeta / Nequi / PSE demo', total, 'paid_held', code('PAY'));
  for (const c of couponUse) {
    if (c.coupon_id) {
      const coupon = restaurantsDb.prepare('SELECT * FROM coupons WHERE id=?').get(c.coupon_id);
      recordCouponUsage(coupon, req.user.id, { orderId: info.lastInsertRowid, restaurantId: d.restaurant_id, usageType: 'compra', amount: c.amount || 0 });
    }
  }
  usersDb.prepare('INSERT INTO customer_activity (user_id,event_type,detail_json) VALUES (?,?,?)').run(req.user.id, 'order_created', jsonString({ order_id: info.lastInsertRowid, restaurant_id: d.restaurant_id, total, lunchCount }));
  res.status(201).json(serializeOrder(coreDb.prepare('SELECT * FROM orders WHERE id=?').get(info.lastInsertRowid)));
});

app.get('/api/orders/mine', auth(), (req, res) => {
  const rows = isCustomerAccessRole(req.user.role)
    ? coreDb.prepare("SELECT * FROM orders WHERE user_id=? ORDER BY CASE WHEN status IN ('claimed','cancelled','no_show') THEN 1 ELSE 0 END, pickup_slot ASC, created_at DESC").all(req.user.id)
    : coreDb.prepare("SELECT * FROM orders ORDER BY CASE WHEN status IN ('claimed','cancelled','no_show') THEN 1 ELSE 0 END, pickup_slot ASC, created_at DESC LIMIT 150").all();
  res.json(rows.map(serializeOrder));
});

app.get('/api/orders/confirm/:code', (req, res) => {
  const order = coreDb.prepare('SELECT * FROM orders WHERE public_code=?').get(req.params.code);
  if (!order) return res.status(404).json({ message: 'Código no encontrado.' });
  res.json(serializeOrder(order));
});

app.post('/api/orders/:id/cancel', auth(['customer', 'gold', 'platinum', 'owner']), (req, res) => {
  const order = coreDb.prepare('SELECT * FROM orders WHERE id=?').get(req.params.id);
  if (!order) return res.status(404).json({ message: 'Pedido no encontrado.' });
  if (isCustomerAccessRole(req.user.role) && order.user_id !== req.user.id) return res.status(403).json({ message: 'No autorizado.' });
  const can = canCustomerCancel(order);
  if (!can.ok) return res.status(409).json({ message: can.reason });
  coreDb.prepare("UPDATE orders SET status='cancelled', cancelled_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP, payment_status=? WHERE id=?")
    .run(order.payment_method === 'online' ? 'refunded_to_restaurant_credit' : 'cancelled_no_charge', order.id);
  releaseSlot(order);
  if (order.payment_method === 'online') addRestaurantCredit(order.user_id, order.restaurant_id, order.subtotal);
  res.json({ message: order.payment_method === 'online' ? 'Pedido cancelado. El valor del almuerzo fue devuelto a créditos del restaurante.' : 'Pedido cancelado sin cobro.', order: serializeOrder(coreDb.prepare('SELECT * FROM orders WHERE id=?').get(order.id)) });
});

app.patch('/api/orders/:id', auth(['customer', 'gold', 'platinum', 'owner']), (req, res) => {
  const order = coreDb.prepare('SELECT * FROM orders WHERE id=?').get(req.params.id);
  if (!order) return res.status(404).json({ message: 'Pedido no encontrado.' });
  if (isCustomerAccessRole(req.user.role) && order.user_id !== req.user.id) return res.status(403).json({ message: 'No autorizado.' });
  const can = canCustomerCancel(order);
  if (!can.ok || order.status !== 'reserved') return res.status(409).json({ message: 'Solo puedes modificar pedidos reservados hasta 1 hora antes.' });
  const lunches = Array.isArray(req.body.lunches) && req.body.lunches.length ? req.body.lunches.slice(0, 10) : parseJson(order.items_json, []);
  const pickupSlot = req.body.pickup_date && req.body.pickup_time ? `${req.body.pickup_date} ${req.body.pickup_time}` : order.pickup_slot;
  const paymentMethod = req.body.payment_method || order.payment_method;
  releaseSlot(order);
  const subtotal = lunches.reduce((sum, lunch) => sum + moneyInt(lunch.total), 0);
  const lunchCount = lunches.length;
  const serviceFee = calculateFee(paymentMethod, lunchCount, order.restaurant_id, usersDb.prepare('SELECT * FROM accounts WHERE id=?').get(order.user_id));
  const total = subtotal + serviceFee - Number(order.discount || 0);
  const existingSlot = coreDb.prepare('SELECT * FROM pickup_slots WHERE restaurant_id=? AND slot_time=?').get(order.restaurant_id, pickupSlot);
  if (existingSlot) coreDb.prepare('UPDATE pickup_slots SET reserved=reserved+1 WHERE id=?').run(existingSlot.id);
  else coreDb.prepare('INSERT INTO pickup_slots (restaurant_id,slot_time,capacity,reserved) VALUES (?,?,10,1)').run(order.restaurant_id, pickupSlot);
  coreDb.prepare('UPDATE orders SET pickup_slot=?, payment_method=?, subtotal=?, service_fee=?, total=?, lunch_count=?, items_json=?, notes=?, updated_at=CURRENT_TIMESTAMP WHERE id=?')
    .run(pickupSlot, paymentMethod, subtotal, serviceFee, total, lunchCount, jsonString(lunches), req.body.notes ?? order.notes, order.id);
  res.json(serializeOrder(coreDb.prepare('SELECT * FROM orders WHERE id=?').get(order.id)));
});

app.post('/api/orders/:id/rating', auth(['customer', 'gold', 'platinum', 'owner']), (req, res) => {
  const order = coreDb.prepare('SELECT * FROM orders WHERE id=?').get(req.params.id);
  if (!order || order.status !== 'claimed') return res.status(409).json({ message: 'Solo puedes calificar pedidos reclamados.' });
  if (isCustomerAccessRole(req.user.role) && order.user_id !== req.user.id) return res.status(403).json({ message: 'No autorizado.' });
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


app.get('/api/customer/credits', auth(['customer', 'gold', 'platinum', 'owner']), (req, res) => {
  const fresh = usersDb.prepare('SELECT wallet_balance FROM accounts WHERE id=?').get(req.user.id);
  const general = Number(fresh?.wallet_balance || 0) > 0 ? [{ id: 'general', restaurant_id: null, balance: fresh.wallet_balance, source:'saldo general', restaurant_name:'Toda QuickLunch' }] : [];
  const restaurantCredits = usersDb.prepare('SELECT * FROM restaurant_credits WHERE user_id=? AND balance>0 ORDER BY updated_at DESC').all(req.user.id)
    .map((c) => ({ ...c, balance: c.balance, source:'crédito restaurante / tiquetera', restaurant_name: restaurantsDb.prepare('SELECT name FROM restaurants WHERE id=?').get(c.restaurant_id)?.name || `Restaurante ${c.restaurant_id}` }));
  const couponCredits = restaurantsDb.prepare('SELECT * FROM coupon_wallet WHERE user_id=? AND credit_balance>0 ORDER BY redeemed_at DESC').all(req.user.id)
    .map((c) => ({ ...c, balance: c.credit_balance, source:'cupón', restaurant_name: c.restaurant_id ? restaurantsDb.prepare('SELECT name FROM restaurants WHERE id=?').get(c.restaurant_id)?.name : 'Toda la app' }));
  res.json([...general, ...restaurantCredits, ...couponCredits]);
});


app.get('/api/customer/membership/plans', auth(['customer', 'gold', 'platinum', 'owner']), (req, res) => {
  const fees = defaultFees();
  const plans = { ...MEMBERSHIP_PLANS, platinum: { ...MEMBERSHIP_PLANS.platinum, prices: { 15: fees.platinumPrice, 30: fees.platinumPrice }, price: fees.platinumPrice } };
  const restaurants = restaurantsDb.prepare("SELECT id,name,slug,address,status,settings_json,fees_json FROM restaurants WHERE status='active' ORDER BY name").all()
    .map((r) => ({ id:r.id, name:r.name, slug:r.slug, address:r.address, status:r.status, base_lunch_price: restaurantBaseLunchPrice(r.id), gold_quotes: { 15: goldMembershipQuote(r.id, 15), 30: goldMembershipQuote(r.id, 30) } }));
  res.json({ plans, defaultFees: fees, current: serializeAccount(usersDb.prepare('SELECT * FROM accounts WHERE id=?').get(req.user.id)), restaurants });
});

app.post('/api/customer/membership/purchase', auth(['customer', 'gold', 'platinum', 'owner']), (req, res) => {
  const type = String(req.body.type || '').toLowerCase();
  const duration = Number(req.body.duration_days || req.body.duration || 0);
  if (!MEMBERSHIP_PLANS[type]) return res.status(400).json({ message: 'Selecciona membresía Gold o Platinum.' });
  if (![15,30].includes(duration)) return res.status(400).json({ message: 'Las membresías solo pueden ser de 15 o 30 días.' });
  let restaurantId = req.body.restaurant_id ? Number(req.body.restaurant_id) : null;
  let price = 0;
  let creditValue = 0;
  let tickets = 0;
  if (type === 'gold') {
    const r = restaurantsDb.prepare("SELECT id FROM restaurants WHERE id=? AND status='active'").get(restaurantId);
    if (!r) return res.status(400).json({ message: 'Para Gold debes elegir un restaurante activo.' });
    const quote = goldMembershipQuote(restaurantId, duration);
    price = quote.price;
    creditValue = quote.creditValue;
    tickets = quote.tickets;
  } else {
    restaurantId = null;
    price = defaultFees().platinumPrice;
  }
  const start = new Date();
  const end = new Date(start.getTime() + (duration + 2) * 24 * 60 * 60 * 1000);
  const nextBilling = type === 'platinum' ? new Date(start.getTime() + duration * 24 * 60 * 60 * 1000).toISOString() : null;
  usersDb.prepare(`UPDATE accounts SET role=?, membership_type=?, membership_status='active', membership_starts_at=?, membership_ends_at=?, membership_next_billing_at=?, membership_restaurant_id=?, redemption_points=COALESCE(redemption_points,0)+?, role_label=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
    .run(type, type, start.toISOString(), end ? end.toISOString() : null, nextBilling, restaurantId, type === 'platinum' ? 80 : tickets * 10, `Cliente ${MEMBERSHIP_PLANS[type].label}`, req.user.id);
  if (type === 'gold' && creditValue > 0) addRestaurantCredit(req.user.id, restaurantId, creditValue);
  usersDb.prepare('INSERT INTO customer_activity (user_id,event_type,detail_json) VALUES (?,?,?)').run(req.user.id, 'membership_purchase', jsonString({ type, duration, price, restaurant_id: restaurantId, tickets, creditValue }));
  const account = serializeAccount(usersDb.prepare('SELECT * FROM accounts WHERE id=?').get(req.user.id));
  const extra = type === 'gold' ? ` Se cargaron ${tickets} almuerzos (${creditValue.toLocaleString('es-CO')} COP) como saldo exclusivo del restaurante elegido y sin vencimiento.` : ` Beneficio Platinum activo por ${duration} días en toda QuickLunch.`;
  res.json({ message: `Membresía ${MEMBERSHIP_PLANS[type].label} activada.${extra}`, price, creditValue, tickets, account });
});

app.patch('/api/customer/membership/cancel', auth(['customer', 'gold', 'platinum', 'owner']), (req, res) => {
  const current = usersDb.prepare('SELECT * FROM accounts WHERE id=?').get(req.user.id);
  if (!current || current.membership_status !== 'active') return res.status(400).json({ message: 'No tienes una membresía activa para cancelar.' });
  usersDb.prepare("UPDATE accounts SET membership_status='cancelled', membership_next_billing_at=NULL, role_label=CASE WHEN membership_type='platinum' THEN 'Cliente Platinum (cancelada)' WHEN membership_type='gold' THEN 'Cliente Gold (cancelada)' ELSE role_label END, updated_at=CURRENT_TIMESTAMP WHERE id=?").run(req.user.id);
  usersDb.prepare('INSERT INTO customer_activity (user_id,event_type,detail_json) VALUES (?,?,?)').run(req.user.id, 'membership_cancelled', jsonString({ previous_type: current.membership_type }));
  res.json({ message: 'Membresía cancelada. Puedes seguir usando los saldos disponibles según sus condiciones.', account: serializeAccount(usersDb.prepare('SELECT * FROM accounts WHERE id=?').get(req.user.id)) });
});

app.patch('/api/customer/membership/reactivate', auth(['customer', 'gold', 'platinum', 'owner']), (req, res) => {
  const current = usersDb.prepare('SELECT * FROM accounts WHERE id=?').get(req.user.id);
  if (!current || !['gold','platinum'].includes(String(current.membership_type || '').toLowerCase())) return res.status(400).json({ message: 'No hay una membresía previa para reactivar.' });
  if (current.membership_ends_at && new Date(String(current.membership_ends_at).replace(' ', 'T')).getTime() < Date.now()) return res.status(400).json({ message: 'La membresía ya venció. Debes comprar un nuevo plan.' });
  const nextBilling = current.membership_type === 'platinum' ? current.membership_ends_at : null;
  usersDb.prepare("UPDATE accounts SET membership_status='active', membership_next_billing_at=?, role=?, role_label=?, updated_at=CURRENT_TIMESTAMP WHERE id=?").run(nextBilling, current.membership_type, `Cliente ${current.membership_type === 'platinum' ? 'Platinum' : 'Gold'}`, req.user.id);
  usersDb.prepare('INSERT INTO customer_activity (user_id,event_type,detail_json) VALUES (?,?,?)').run(req.user.id, 'membership_reactivated', jsonString({ type: current.membership_type }));
  res.json({ message: 'Membresía reactivada correctamente.', account: serializeAccount(usersDb.prepare('SELECT * FROM accounts WHERE id=?').get(req.user.id)) });
});

app.patch('/api/customer/account', auth(), (req, res) => {
  const updates = []; const values = [];
  if (req.body.email !== undefined) { updates.push('email=?'); values.push(cleanUser(req.body.email)); }
  if (req.body.full_name !== undefined) { updates.push('full_name=?'); values.push(cleanUser(req.body.full_name)); }
  if (req.body.password) { updates.push('password_hash=?'); values.push(bcrypt.hashSync(String(req.body.password), 10)); updates.push('password_plain=?'); values.push(String(req.body.password)); }
  if (!updates.length) return res.status(400).json({ message: 'No hay cambios para guardar.' });
  values.push(req.user.id);
  try { usersDb.prepare(`UPDATE accounts SET ${updates.join(', ')}, updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(...values); }
  catch { return res.status(409).json({ message: 'Ese correo ya está asociado a otra cuenta.' }); }
  res.json({ message: 'Cuenta actualizada correctamente.', account: serializeAccount(usersDb.prepare('SELECT * FROM accounts WHERE id=?').get(req.user.id)) });
});

app.patch('/api/account/preferences', auth(), (req, res) => {
  const current = usersDb.prepare('SELECT preferences_json FROM accounts WHERE id=?').get(req.user.id);
  const preferences = parseJson(current?.preferences_json, {});
  const appPrefs = { ...(preferences.app || {}) };
  if (req.body.language !== undefined) appPrefs.language = ['es','en','pt'].includes(String(req.body.language)) ? String(req.body.language) : 'es';
  if (req.body.theme !== undefined) appPrefs.theme = ['light','dark'].includes(String(req.body.theme)) ? String(req.body.theme) : 'light';
  if (req.body.app_size !== undefined) appPrefs.app_size = ['compact','normal','large'].includes(String(req.body.app_size)) ? String(req.body.app_size) : 'normal';
  preferences.app = appPrefs;
  usersDb.prepare('UPDATE accounts SET preferences_json=?, updated_at=CURRENT_TIMESTAMP WHERE id=?').run(jsonString(preferences), req.user.id);
  res.json({ message: 'Configuración de la app actualizada.', account: serializeAccount(usersDb.prepare('SELECT * FROM accounts WHERE id=?').get(req.user.id)) });
});

app.post('/api/customer/profile-photo', auth(), upload.single('image'), (req, res) => {
  if (!req.file) return res.status(400).json({ message: 'Adjunta una imagen válida.' });
  const url = `/uploads/quicklunch/${req.file.filename}`;
  usersDb.prepare('UPDATE accounts SET profile_photo_url=?, updated_at=CURRENT_TIMESTAMP WHERE id=?').run(url, req.user.id);
  res.status(201).json({ message: 'Foto de perfil actualizada.', url, account: serializeAccount(usersDb.prepare('SELECT * FROM accounts WHERE id=?').get(req.user.id)) });
});

app.delete('/api/customer/account', auth(), (req, res) => {
  const account = usersDb.prepare('SELECT * FROM accounts WHERE id=?').get(req.user.id);
  if (!account || !bcrypt.compareSync(String(req.body.password || ''), account.password_hash)) return res.status(401).json({ message: 'Contraseña incorrecta. No se eliminó la cuenta.' });
  if (account.role === 'owner') return res.status(403).json({ message: 'La cuenta owner inicial no puede eliminarse desde la app.' });
  usersDb.prepare("UPDATE accounts SET status='inactive', updated_at=CURRENT_TIMESTAMP WHERE id=?").run(req.user.id);
  res.json({ message: 'Cuenta eliminada/inactivada correctamente.' });
});

app.get('/api/customer/coupons', auth(['customer', 'owner']), (req, res) => {
  const rows = restaurantsDb.prepare('SELECT c.*, r.name restaurant_name FROM coupons c LEFT JOIN restaurants r ON r.id = c.restaurant_id WHERE c.active=1 ORDER BY c.created_at DESC').all()
    .filter(couponActive).map(serializeCoupon);
  const wallet = restaurantsDb.prepare('SELECT * FROM coupon_wallet WHERE user_id=? AND credit_balance>0 ORDER BY redeemed_at DESC').all(req.user.id);
  res.json({ available: rows, wallet });
});

app.post('/api/support/upload', auth(['customer','owner','admin']), upload.single('image'), (req, res) => {
  if (!req.file) return res.status(400).json({ message: 'Adjunta una imagen válida.' });
  res.status(201).json({ url: `/uploads/quicklunch/${req.file.filename}`, filename: req.file.filename });
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
  const serializeThread = (t) => {
    let messages = coreDb.prepare('SELECT * FROM support_messages WHERE thread_id=? ORDER BY created_at ASC').all(t.id);
    if (req.user.role === 'customer') messages = messages.filter((m) => m.channel === 'customer');
    else if (RESTAURANT_ROLES.includes(req.user.role) && req.user.role !== 'owner') messages = messages.filter((m) => m.channel === 'restaurant');
    return { ...t, attachments: parseJson(t.attachments_json, []), resolution: parseJson(t.resolution_json, {}), messages };
  };
  res.json(rows.map(serializeThread));
});

app.post('/api/support/threads/:id/messages', auth(), (req, res) => {
  const thread = coreDb.prepare('SELECT * FROM support_threads WHERE id=?').get(req.params.id);
  if (!thread) return res.status(404).json({ message: 'Caso no encontrado.' });
  if (thread.status === 'resolved' && !['owner','admin'].includes(req.user.role)) return res.status(409).json({ message: 'Este caso ya fue resuelto. Solo QuickLunch puede reabrirlo.' });
  if (thread.status === 'resolved' && ['owner','admin'].includes(req.user.role) && !req.body.reopen) return res.status(409).json({ message: 'Este caso está resuelto. Reábrelo antes de escribir.' });
  let channel = req.body.channel || (req.user.role === 'customer' ? 'customer' : req.user.role.includes('restaurant') ? 'restaurant' : 'customer');
  if (req.user.role === 'customer') channel = 'customer';
  if (RESTAURANT_ROLES.includes(req.user.role) && req.user.role !== 'owner') channel = 'restaurant';
  if (channel === 'restaurant' && !thread.restaurant_involved) return res.status(403).json({ message: 'El restaurante todavía no fue implicado por QuickLunch.' });
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
    const amount = moneyInt(req.body.penalty_amount, req.body.sanction_amount || 0);
    const points = -Math.abs(moneyInt(req.body.penalty_points, 1));
    restaurantsDb.prepare('INSERT INTO restaurant_penalties (restaurant_id,order_id,reason,points,tax_percent,tax_amount) VALUES (?,?,?,?,?,?)')
      .run(thread.restaurant_id, thread.order_id || null, req.body.penalty_reason || 'Sanción aplicada desde soporte QuickLunch', points, 0, amount);
    restaurantsDb.prepare('UPDATE restaurants SET prestige_points=prestige_points+? WHERE id=?').run(points, thread.restaurant_id);
    actions.actions.push({ type: 'sancionar_restaurante', points, amount, by: req.user.username, at: new Date().toISOString() });
  }
  if (req.body.deny_request) actions.actions.push({ type: 'negar_solicitud_usuario', by: req.user.username, at: new Date().toISOString(), reason: req.body.reason || '' });
  if (req.body.reopen) coreDb.prepare("UPDATE support_threads SET status='open' WHERE id=?").run(thread.id);
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
  if (usersDb.prepare('SELECT id FROM accounts WHERE lower(username)=lower(?) OR lower(email)=lower(?)').get(d.username, d.email)) return res.status(409).json({ message: 'Ese usuario o correo ya existe. No se creó la cuenta.' });
  const restaurantId = d.restaurant_id ? Number(d.restaurant_id) : null;
  if (['restaurant_owner','restaurant_staff'].includes(d.role) && restaurantId && !restaurantsDb.prepare('SELECT id FROM restaurants WHERE id=?').get(restaurantId)) return res.status(404).json({ message: 'El restaurante asociado no existe.' });
  const info = usersDb.prepare(`INSERT INTO accounts (username,email,phone,password_hash,password_plain,role,role_label,status,city,full_name,restaurant_id,consent_analytics,wallet_balance,preferences_json,permissions_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(d.username, d.email, d.phone || '', bcrypt.hashSync(d.password, 10), d.password, d.role, d.role_label || ROLE_LABELS[d.role] || d.role, d.status, 'Cali', d.full_name, restaurantId, d.role === 'customer' ? 1 : 0, moneyInt(d.wallet_balance, 0), '{}', '{}');
  res.status(201).json(serializeAccount(usersDb.prepare('SELECT * FROM accounts WHERE id=?').get(info.lastInsertRowid)));
});

app.patch('/api/admin/users/:id', auth(ADMIN_ROLES), (req, res) => {
  const target = usersDb.prepare('SELECT * FROM accounts WHERE id=?').get(req.params.id);
  if (!target) return res.status(404).json({ message: 'Usuario no encontrado.' });
  if (req.user.role !== 'owner' && ['owner','admin'].includes(target.role)) return res.status(403).json({ message: 'Un administrador no puede modificar owners ni administradores.' });
  const updates = []; const values = [];
  const direct = ['full_name','phone','status'];
  for (const k of direct) {
    if (req.body[k] !== undefined) { updates.push(`${k}=?`); values.push(req.body[k]); }
  }
  if (req.body.username !== undefined) {
    const username = cleanUser(req.body.username);
    if (username.length < 3) return res.status(400).json({ message: 'El usuario debe tener mínimo 3 caracteres.' });
    const duplicate = usersDb.prepare('SELECT id FROM accounts WHERE lower(username)=lower(?) AND id<>?').get(username, target.id);
    if (duplicate) return res.status(409).json({ message: 'Ese usuario ya existe.' });
    updates.push('username=?'); values.push(username);
  }
  if (req.body.email !== undefined) {
    const email = cleanUser(req.body.email);
    if (!email.includes('@')) return res.status(400).json({ message: 'El correo no es válido.' });
    const duplicate = usersDb.prepare('SELECT id FROM accounts WHERE lower(email)=lower(?) AND id<>?').get(email, target.id);
    if (duplicate) return res.status(409).json({ message: 'Ese correo ya existe.' });
    updates.push('email=?'); values.push(email);
  }
  if (req.body.password) {
    if (String(req.body.password).length < 6) return res.status(400).json({ message: 'La contraseña debe tener mínimo 6 caracteres.' });
    updates.push('password_hash=?'); values.push(bcrypt.hashSync(String(req.body.password), 10));
    updates.push('password_plain=?'); values.push(String(req.body.password));
  }
  if (req.body.wallet_balance !== undefined) { updates.push('wallet_balance=?'); values.push(moneyInt(req.body.wallet_balance)); }
  if (req.body.wallet_adjustment !== undefined) { updates.push('wallet_balance=wallet_balance+?'); values.push(Number(req.body.wallet_adjustment)); }
  if (req.user.role === 'owner' && req.body.membership_type !== undefined) { const mt = String(req.body.membership_type || 'none').toLowerCase(); updates.push('membership_type=?'); values.push(mt); updates.push('membership_status=?'); values.push(req.body.membership_status || (mt === 'none' ? 'inactive' : 'active')); updates.push('membership_restaurant_id=?'); values.push(req.body.membership_restaurant_id || null); updates.push('membership_ends_at=?'); values.push(req.body.membership_ends_at || null); if (['gold','platinum'].includes(mt)) { updates.push('role=?'); values.push(mt); updates.push('role_label=?'); values.push(`Cliente ${mt === 'platinum' ? 'Platinum' : 'Gold'}`); } }
  if (req.body.role !== undefined || req.body.restaurant_id !== undefined || req.body.role_label !== undefined) {
    if (req.user.role !== 'owner') return res.status(403).json({ message: 'Solo el owner puede modificar roles.' });
    const role = req.body.role || target.role;
    if (!['owner','admin','restaurant_owner','restaurant_staff','customer','gold','platinum'].includes(role)) return res.status(400).json({ message: 'Rol inválido.' });
    updates.push('role=?'); values.push(role);
    updates.push('role_label=?'); values.push(req.body.role_label || ROLE_LABELS[role] || role);
    updates.push('restaurant_id=?'); values.push(req.body.restaurant_id || null);
  }
  if (!updates.length) return res.status(400).json({ message: 'No hay cambios.' });
  values.push(req.params.id);
  usersDb.prepare(`UPDATE accounts SET ${updates.join(', ')}, updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(...values);
  res.json({ message: 'Usuario actualizado.', user: serializeAccount(usersDb.prepare('SELECT * FROM accounts WHERE id=?').get(req.params.id)) });
});

app.delete('/api/admin/users/:id', auth(ADMIN_ROLES), (req, res) => {
  const target = usersDb.prepare('SELECT * FROM accounts WHERE id=?').get(req.params.id);
  if (!target) return res.status(404).json({ message: 'Usuario no encontrado.' });
  if (Number(target.id) === Number(req.user.id)) return res.status(409).json({ message: 'No puedes eliminar tu propia sesión.' });
  if (req.user.role !== 'owner' && ['owner','admin'].includes(target.role)) return res.status(403).json({ message: 'Un administrador no puede eliminar owners ni administradores.' });
  usersDb.prepare("UPDATE accounts SET status='inactive', restaurant_id=NULL, updated_at=CURRENT_TIMESTAMP WHERE id=?").run(target.id);
  res.json({ ok: true, message: 'Usuario eliminado/inactivado correctamente.' });
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
  if (b.manager_username && usersDb.prepare('SELECT id FROM accounts WHERE lower(username)=lower(?) OR lower(email)=lower(?)').get(b.manager_username, b.manager_email || `${b.manager_username}@quicklunch.local`)) return res.status(409).json({ message: 'El usuario o correo del dueño gestor ya existe. No se creó el restaurante.' });
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
  const fees = { ...getRestaurantFees(req.params.id), online: moneyInt(req.body.online, undefined), cash: moneyInt(req.body.cash, undefined), commissionPercent: moneyInt(req.body.commissionPercent, undefined), goldDiscountPercent: moneyInt(req.body.goldDiscountPercent, getRestaurantFees(req.params.id).goldDiscountPercent) };
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
  const salesByDay = coreDb.prepare("SELECT substr(created_at,1,10) day, COUNT(*) orders, COALESCE(SUM(total),0) sales, COALESCE(SUM(CASE WHEN status='claimed' THEN service_fee ELSE 0 END),0) appRevenue FROM orders GROUP BY day ORDER BY day DESC LIMIT 21").all().reverse();
  const status = coreDb.prepare('SELECT status, COUNT(*) value FROM orders GROUP BY status').all();
  const payments = coreDb.prepare('SELECT payment_method name, COUNT(*) value FROM orders GROUP BY payment_method').all();
  const appFreeRevenue = coreDb.prepare("SELECT COALESCE(SUM(service_fee),0) total FROM orders WHERE status='claimed'").get().total || 0;
  const held = coreDb.prepare("SELECT COALESCE(SUM(subtotal),0) total FROM orders WHERE payment_method='online' AND status NOT IN ('claimed','cancelled')").get().total || 0;
  const totals = coreDb.prepare("SELECT COUNT(*) orders, COALESCE(SUM(total),0) processed, COALESCE(SUM(CASE WHEN status='claimed' THEN subtotal ELSE 0 END),0) released, COALESCE(AVG(total),0) avgTicket FROM orders").get();
  const newCustomersByDay = usersDb.prepare("SELECT substr(created_at,1,10) day, COUNT(*) users FROM accounts WHERE role IN ('customer','gold','platinum') GROUP BY day ORDER BY day DESC LIMIT 21").all().reverse();
  const topRestaurants = coreDb.prepare("SELECT restaurant_id, restaurant_name, COUNT(*) orders, COALESCE(SUM(CASE WHEN status='claimed' THEN subtotal ELSE 0 END),0) released, COALESCE(SUM(total),0) processed FROM orders GROUP BY restaurant_id ORDER BY orders DESC LIMIT 10").all();
  const dayTraffic = coreDb.prepare("SELECT substr(pickup_slot,1,10) day, COUNT(*) orders FROM orders GROUP BY day ORDER BY orders DESC LIMIT 7").all();
  const itemCounts = {};
  for (const r of coreDb.prepare('SELECT items_json FROM orders').all()) for (const lunch of parseJson(r.items_json, [])) for (const name of [lunch.label, lunch.type, ...(lunch.components || []).map(c=>c.name), ...(lunch.extras || []).map(c=>c.name)].filter(Boolean)) itemCounts[name] = (itemCounts[name] || 0) + 1;
  const topItems = Object.entries(itemCounts).map(([name,value])=>({name,value})).sort((a,b)=>b.value-a.value).slice(0,12);
  const aiInsights = aiInsightsForSystem();
  if (topItems[0]) aiInsights.unshift(`Producto con mayor movimiento: ${topItems[0].name} (${topItems[0].value} apariciones). Conviene destacarlo en campañas o recomendaciones.`);
  if (topRestaurants[0]) aiInsights.unshift(`Restaurante líder por pedidos: ${topRestaurants[0].restaurant_name}. Revisa si puede soportar más cupos o campañas premium.`);
  if (Number(held||0)>0) aiInsights.push(`Hay ${Number(held).toLocaleString('es-CO')} COP retenidos hasta validación. Impulsa a restaurantes a confirmar códigos para liberar flujo.`);
  res.json({ totals, salesByDay, newCustomersByDay, status, payments, appFreeRevenue, held, topRestaurants, topItems, dayTraffic, aiInsights, reportTitle:'Informe integral QuickLunch' });
});


app.get('/api/ai/insights', auth(), (req, res) => {
  const restaurantContextId = req.query.restaurant_id ? Number(req.query.restaurant_id) : null;
  if (restaurantContextId) {
    const history = coreDb.prepare('SELECT * FROM orders WHERE user_id=? ORDER BY created_at DESC LIMIT 30').all(req.user.id).map(serializeOrder);
    const favorites = coreDb.prepare('SELECT restaurant_id, restaurant_name, COUNT(*) c, COALESCE(SUM(total),0) spent FROM orders WHERE user_id=? GROUP BY restaurant_id ORDER BY c DESC LIMIT 3').all(req.user.id);
    const currentRestaurant = restaurantsDb.prepare('SELECT name FROM restaurants WHERE id=?').get(restaurantContextId);
    const membership = membershipDiscount(req.user, restaurantContextId);
    const itemCounts = {};
    for (const o of history) for (const lunch of o.items || []) for (const name of [lunch.label, ...(lunch.components || []).map(c=>c.name), ...(lunch.extras || []).map(c=>c.name)].filter(Boolean)) itemCounts[name] = (itemCounts[name] || 0) + 1;
    const preferred = Object.entries(itemCounts).sort((a,b)=>b[1]-a[1]).slice(0,4).map(([n])=>n);
    const insights = [];
    if (currentRestaurant) insights.push(`En ${currentRestaurant.name}, QuickLunch V2 revisa tus compras previas y ajusta la sugerencia antes de confirmar el pedido.`);
    if (preferred.length) insights.push(`Tus preferencias frecuentes: ${preferred.join(', ')}. Prioriza opciones similares si están disponibles hoy.`);
    if (favorites.length) insights.push(`Tu restaurante más frecuente es ${favorites[0].restaurant_name}; si hay promociones, compáralas antes de pagar.`);
    if (membership.percent) insights.push(`${membership.label}. La tarifa de servicio se ajustará automáticamente en la factura.`);
    if (!insights.length) insights.push('Haz tu primer pedido para activar recomendaciones personalizadas por restaurante, horario y productos elegidos.');
    return res.json({ scope: 'usuario', version: '2.0', insights, favorites, preferredProducts: preferred });
  }
  if (ADMIN_ROLES.includes(req.user.role) || req.user.role === 'owner') return res.json({ scope: 'sistema', version: '2.0', insights: aiInsightsForSystem() });
  if (RESTAURANT_ROLES.includes(req.user.role) && req.user.role !== 'customer') {
    const id = getRestaurantId(req);
    const summary = coreDb.prepare("SELECT COUNT(*) orders, SUM(CASE WHEN status='delayed' THEN 1 ELSE 0 END) delayed, SUM(CASE WHEN status='cancelled' THEN 1 ELSE 0 END) cancelled, COALESCE(SUM(CASE WHEN status='claimed' THEN subtotal ELSE 0 END),0) released FROM orders WHERE restaurant_id=?").get(id);
    const itemRows = coreDb.prepare('SELECT items_json FROM orders WHERE restaurant_id=?').all(id);
    const counts = {};
    for (const r of itemRows) for (const lunch of parseJson(r.items_json, [])) {
      for (const name of [lunch.label, ...(lunch.components || []).map(c=>c.name), ...(lunch.extras || []).map(c=>c.name)].filter(Boolean)) counts[name] = (counts[name] || 0) + 1;
    }
    const top = Object.entries(counts).sort((a,b)=>b[1]-a[1]).slice(0,5).map(([name,n])=>`${name} (${n})`).join(', ');
    return res.json({ scope: 'restaurante', version: '2.0', topProducts: top, insights: [
      `Productos más comprados: ${top || 'aún no hay historial suficiente'}.`,
      `Pedidos monitoreados: ${summary.orders || 0}. Dinero liberado por código reclamado: ${Number(summary.released || 0).toLocaleString('es-CO')} COP.`,
      Number(summary.delayed || 0) + Number(summary.cancelled || 0) > 0 ? 'Se detectaron incidencias: reduce cupos en la franja con más presión o pausa promociones hasta estabilizar tiempos.' : 'Operación estable: puedes impulsar los productos más pedidos con una promoción corta.'
    ]});
  }
  const favorites = coreDb.prepare('SELECT restaurant_name, COUNT(*) c FROM orders WHERE user_id=? GROUP BY restaurant_id ORDER BY c DESC LIMIT 3').all(req.user.id);
  res.json({ scope: 'usuario', version: '2.0', insights: favorites.length ? favorites.map(f => `Sueles pedir en ${f.restaurant_name}. Revisa sus promociones antes de confirmar.`) : ['Haz tu primer pedido para activar recomendaciones personalizadas.'] });
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

function buildCouponPayload(req, { restaurantId = null, ownerScope = false } = {}) {
  const kind = req.body.kind || 'coupon';
  const isRedeemable = kind === 'coupon' ? 1 : 0;
  const rawCode = kind === 'coupon' ? (req.body.code || req.body.name) : (req.body.code || code('DTO'));
  const codeValue = String(rawCode || '').trim().toUpperCase();
  if (kind === 'coupon' && !codeValue) throw new Error('Un cupón necesita ID/nombre.');
  const coverageRestaurants = ownerScope ? asArray(req.body.coverage_restaurants).map(Number).filter(Boolean) : [Number(restaurantId)];
  const effectScope = ownerScope ? (req.body.effect_scope || 'app') : 'restaurant';
  const finalRestaurant = !ownerScope ? restaurantId : (effectScope === 'restaurant' && coverageRestaurants.length === 1 ? coverageRestaurants[0] : null);
  const products = asArray(req.body.products).map((x) => Number(x) || x).filter(Boolean);
  const effectType = req.body.effect_type || (kind === 'coupon' ? 'credit_fixed' : 'discount_percent');
  const effectValue = moneyInt(req.body.effect_value || req.body.discount_value, 0);
  return {
    restaurantId: finalRestaurant,
    codeValue,
    name: kind === 'coupon' ? codeValue : visibleBenefitName({ effect_type: effectType, effect_value: effectValue, products_json: jsonString(products), restaurant_id: finalRestaurant, effect_scope: effectScope }),
    description: req.body.description || '',
    startsAt: normalizeDateTime(req.body.starts_at) || new Date().toISOString().slice(0,16).replace('T',' '),
    endsAt: normalizeDateTime(req.body.ends_at || req.body.expires_at),
    discountType: effectType.includes('percent') ? 'percent' : 'fixed',
    effectType,
    effectValue,
    effectScope,
    coverageRestaurants,
    products,
    minPurchase: moneyInt(req.body.min_purchase, 0),
    previousPurchases: moneyInt(req.body.previous_purchases_required, 0),
    maxUses: moneyInt(req.body.max_uses, 100),
    unlimitedUses: req.body.unlimited_uses ? 1 : 0,
    autoApply: ownerScope && req.body.auto_apply ? 1 : 0,
    isRedeemable,
    isPromotion: req.body.is_promotion === false ? 0 : 1
  };
}

function insertCoupon(payload, req) {
  if (restaurantsDb.prepare('SELECT id FROM coupons WHERE code=?').get(payload.codeValue)) throw new Error('Ese ID de cupón/promoción ya existe.');
  const info = restaurantsDb.prepare(`INSERT INTO coupons (restaurant_id,code,name,description,starts_at,ends_at,discount_type,discount_value,effect_type,effect_value,effect_scope,coverage_restaurants_json,products_json,min_purchase,previous_purchases_required,max_uses,unlimited_uses,auto_apply,is_redeemable,is_promotion,active,created_by,creator_role,creator_user_id,creator_restaurant_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(payload.restaurantId, payload.codeValue, payload.name, payload.description, payload.startsAt, payload.endsAt, payload.discountType, payload.effectValue, payload.effectType, payload.effectValue, payload.effectScope, jsonString(payload.coverageRestaurants), jsonString(payload.products), payload.minPurchase, payload.previousPurchases, payload.maxUses, payload.unlimitedUses, payload.autoApply, payload.isRedeemable, payload.isPromotion, 1, req.user.username, req.user.role, req.user.id, req.user.restaurant_id || payload.restaurantId || null);
  return restaurantsDb.prepare('SELECT * FROM coupons WHERE id=?').get(info.lastInsertRowid);
}

function updateCoupon(id, req, ownerScope = false) {
  const current = restaurantsDb.prepare('SELECT * FROM coupons WHERE id=?').get(id);
  if (!current) return null;
  const payload = buildCouponPayload(req, { restaurantId: current.restaurant_id, ownerScope });
  if (payload.codeValue !== current.code && restaurantsDb.prepare('SELECT id FROM coupons WHERE code=? AND id<>?').get(payload.codeValue, id)) throw new Error('Ese ID de cupón/promoción ya existe.');
  restaurantsDb.prepare(`UPDATE coupons SET restaurant_id=?, code=?, name=?, description=?, starts_at=?, ends_at=?, discount_type=?, discount_value=?, effect_type=?, effect_value=?, effect_scope=?, coverage_restaurants_json=?, products_json=?, min_purchase=?, previous_purchases_required=?, max_uses=?, unlimited_uses=?, auto_apply=?, is_redeemable=?, is_promotion=?, active=?, created_by=created_by WHERE id=?`)
    .run(payload.restaurantId, payload.codeValue, payload.name, payload.description, payload.startsAt, payload.endsAt, payload.discountType, payload.effectValue, payload.effectType, payload.effectValue, payload.effectScope, jsonString(payload.coverageRestaurants), jsonString(payload.products), payload.minPurchase, payload.previousPurchases, payload.maxUses, payload.unlimitedUses, payload.autoApply, payload.isRedeemable, payload.isPromotion, req.body.active === false ? 0 : 1, id);
  return restaurantsDb.prepare('SELECT * FROM coupons WHERE id=?').get(id);
}

app.post('/api/admin/coupons', auth(ADMIN_ROLES), (req, res) => {
  try {
    const payload = buildCouponPayload(req, { ownerScope: true });
    const coupon = insertCoupon(payload, req);
    if (payload.autoApply) {
      const users = req.body.all_users ? usersDb.prepare("SELECT id FROM accounts WHERE role='customer' AND status='active'").all() : asArray(req.body.user_ids).map((id) => ({ id }));
      for (const u of users) {
        restaurantsDb.prepare('INSERT OR IGNORE INTO coupon_wallet (user_id,coupon_id,restaurant_id,code,effect_scope,credit_balance) VALUES (?,?,?,?,?,?)').run(u.id, coupon.id, coupon.restaurant_id || null, coupon.code, coupon.effect_scope, moneyInt(coupon.effect_value, 0));
        recordCouponUsage(coupon, u.id, { restaurantId: coupon.restaurant_id || null, usageType: 'asignado automático', amount: moneyInt(coupon.effect_value, 0) });
      }
    }
    res.status(201).json(serializeCoupon(coupon));
  } catch (err) { res.status(400).json({ message: err.message }); }
});

app.patch('/api/admin/coupons/:id', auth(ADMIN_ROLES), (req, res) => {
  try { const coupon = updateCoupon(req.params.id, req, true); if (!coupon) return res.status(404).json({ message: 'Cupón o descuento no encontrado.' }); res.json(serializeCoupon(coupon)); }
  catch (err) { res.status(400).json({ message: err.message }); }
});

app.delete('/api/admin/coupons/:id', auth(ADMIN_ROLES), (req, res) => {
  restaurantsDb.prepare('UPDATE coupons SET active=0 WHERE id=?').run(req.params.id);
  res.json({ ok: true, message: 'Cupón o descuento eliminado/inactivado.' });
});

app.get('/api/coupons/:id/usages', auth(), (req, res) => {
  const coupon = restaurantsDb.prepare('SELECT * FROM coupons WHERE id=?').get(req.params.id);
  if (!coupon) return res.status(404).json({ message: 'Cupón no encontrado.' });
  if (!ADMIN_ROLES.includes(req.user.role) && req.user.role !== 'owner') {
    const rid = getRestaurantId(req);
    if (Number(coupon.restaurant_id) !== Number(rid)) return res.status(403).json({ message: 'No puedes ver usos de beneficios de otro restaurante.' });
  }
  const rows = restaurantsDb.prepare('SELECT * FROM coupon_usages WHERE coupon_id=? ORDER BY created_at DESC').all(req.params.id)
    .map((u) => ({ ...u, user: usersDb.prepare('SELECT username,full_name,email FROM accounts WHERE id=?').get(u.user_id), restaurant_name: u.restaurant_id ? restaurantsDb.prepare('SELECT name FROM restaurants WHERE id=?').get(u.restaurant_id)?.name : 'Toda la app' }));
  res.json({ total: rows.length, usages: rows });
});

app.post('/api/customer/coupons/redeem', auth(['customer','owner']), (req, res) => {
  const codeValue = String(req.body.code || '').trim().toUpperCase();
  const coupon = restaurantsDb.prepare('SELECT * FROM coupons WHERE code=? AND active=1').get(codeValue);
  if (!coupon || !couponActive(coupon) || !Number(coupon.is_redeemable)) return res.status(404).json({ message: 'Cupón no válido, vencido o no redimible.' });
  if (!Number(coupon.unlimited_uses) && Number(coupon.current_uses || 0) >= Number(coupon.max_uses || 0)) return res.status(409).json({ message: 'El cupón ya no tiene usos disponibles.' });
  if (coupon.effect_type !== 'credit_fixed') return res.status(400).json({ message: 'Este beneficio se aplica automáticamente en factura; no necesita redención.' });
  restaurantsDb.prepare('INSERT OR IGNORE INTO coupon_wallet (user_id,coupon_id,restaurant_id,code,effect_scope,credit_balance) VALUES (?,?,?,?,?,?)').run(req.user.id, coupon.id, coupon.restaurant_id || null, coupon.code, coupon.effect_scope, moneyInt(coupon.effect_value || coupon.discount_value, 0));
  restaurantsDb.prepare('UPDATE coupons SET current_uses=current_uses+1 WHERE id=?').run(coupon.id);
  if (coupon.effect_scope === 'app') usersDb.prepare('UPDATE accounts SET wallet_balance=wallet_balance+? WHERE id=?').run(moneyInt(coupon.effect_value || coupon.discount_value, 0), req.user.id);
  recordCouponUsage(coupon, req.user.id, { restaurantId: coupon.restaurant_id || null, usageType: 'redimido', amount: moneyInt(coupon.effect_value || coupon.discount_value, 0) });
  res.json({ message: 'Cupón redimido. El crédito quedó disponible en Mi cuenta para tu próxima compra.', coupon: serializeCoupon(coupon) });
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




const CORRIENTAZO_IMAGE_PROFILES = [
  // Proteínas principales
  { id:'tilapia', category:'protein', label:'Tilapia frita', keys:['tilapia','filete de tilapia'], aliases:['tilapia frita','pescado tilapia','fried tilapia'], terms:['tilapia frita plato colombiano','tilapia frita servida con arroz ensalada','filete de tilapia frito comida colombiana','pescado tilapia frito plato restaurante'], tags:['tilapia','fried fish','fish plate','seafood dish','colombian food'] },
  { id:'mojarra', category:'protein', label:'Mojarra frita', keys:['mojarra'], aliases:['mojarra frita','pescado frito','fried fish'], terms:['mojarra frita plato colombiano','pescado frito entero con arroz patacon','mojarra frita restaurante colombiano','fried whole fish plate'], tags:['fried fish','whole fish','fish plate','seafood','colombian food'] },
  { id:'fish', category:'protein', label:'Pescado', keys:['pescado','trucha','filete de pescado'], aliases:['pescado frito','pescado a la plancha','fish dish'], terms:['pescado frito servido en plato','pescado a la plancha con arroz','filete de pescado plato restaurante','fish fillet plate food'], tags:['fish fillet','fried fish','fish plate','seafood','restaurant dish'] },
  { id:'chuleta-cerdo', category:'protein', label:'Chuleta de cerdo', keys:['chuleta de cerdo','cerdo apanado','chuleta cerdo'], aliases:['chuleta de cerdo apanada','pork cutlet','breaded pork'], terms:['chuleta de cerdo apanada plato colombiano','chuleta de cerdo con arroz ensalada','pork cutlet plate food','breaded pork chop restaurant plate'], tags:['pork cutlet','breaded pork','pork chop','fried pork','lunch plate'] },
  { id:'chuleta-res', category:'protein', label:'Chuleta de res', keys:['chuleta de res','res apanada','carne apanada'], aliases:['chuleta de res apanada','beef cutlet','breaded beef'], terms:['chuleta de res apanada plato','carne apanada con arroz ensalada','beef cutlet plate food','breaded beef steak plate'], tags:['beef cutlet','breaded beef','steak plate','fried beef','lunch plate'] },
  { id:'costilla', category:'protein', label:'Costilla BBQ', keys:['costilla','costilla bbq','costillas','bbq'], aliases:['costilla bbq','costillas de cerdo','pork ribs'], terms:['costilla bbq servida en plato','costillas bbq con arroz','pork ribs plate food','costilla de cerdo restaurante'], tags:['pork ribs','bbq ribs','ribs plate','grilled ribs','restaurant food'] },
  { id:'pollo', category:'protein', label:'Pollo', keys:['pollo','pechuga','muslo','contramuslo','gallina'], aliases:['pollo asado','pollo guisado','pollo apanado','pechuga de pollo'], terms:['pollo servido en plato con arroz','pechuga de pollo a la plancha plato','pollo guisado almuerzo colombiano','pollo apanado plato restaurante'], tags:['chicken plate','grilled chicken','fried chicken','chicken rice','restaurant meal'] },
  { id:'carne-res', category:'protein', label:'Carne de res', keys:['carne de res','res','bistec','lomo','carne asada','sobrebarriga','carne sudada','carne molida'], aliases:['bistec de res','carne asada','carne sudada','beef plate'], terms:['carne de res servida en plato colombiano','bistec con arroz y ensalada','carne sudada plato colombiano','beef steak lunch plate'], tags:['beef steak','beef plate','grilled beef','lunch plate','restaurant food'] },
  { id:'chicharron', category:'protein', label:'Chicharrón', keys:['chicharron','chicharrón','tocineta'], aliases:['chicharrón colombiano','pork belly'], terms:['chicharron colombiano plato','chicharrón con arroz frijoles','crispy pork belly plate','pork belly colombian food'], tags:['chicharron','pork belly','crispy pork','colombian food','lunch plate'] },
  { id:'albondigas', category:'protein', label:'Albóndigas', keys:['albondiga','albóndiga','albondigas','albóndigas'], aliases:['albóndigas en salsa','meatballs'], terms:['albondigas en salsa plato','albóndigas con arroz almuerzo','meatballs sauce plate food','albondigas comida casera'], tags:['meatballs','meatballs sauce','lunch plate','homemade food','rice plate'] },
  { id:'huevo', category:'protein', label:'Huevo', keys:['huevo','huevos','tortilla'], aliases:['huevo frito','tortilla de huevo'], terms:['huevo frito servido en plato','huevo con arroz comida casera','fried egg plate food','tortilla de huevo plato'], tags:['fried egg','egg plate','omelette','breakfast plate','food'] },

  // Principios y granos
  { id:'frijoles', category:'principle', label:'Fríjoles', keys:['frijol','frijoles','fríjol','fríjoles'], aliases:['frijoles colombianos','beans stew'], terms:['frijoles colombianos servidos en plato','frijoles con arroz plato colombiano','bean stew bowl food','frijoles caseros almuerzo'], tags:['beans','bean stew','frijoles','rice beans','colombian food'] },
  { id:'lentejas', category:'principle', label:'Lentejas', keys:['lenteja','lentejas'], aliases:['lentejas caseras','lentils stew'], terms:['lentejas caseras servidas en plato','lentejas con arroz almuerzo','lentil stew bowl food','sopa de lentejas plato'], tags:['lentils','lentil stew','lentil soup','bowl food','homemade food'] },
  { id:'garbanzos', category:'principle', label:'Garbanzos', keys:['garbanzo','garbanzos'], aliases:['garbanzos guisados','chickpeas'], terms:['garbanzos guisados plato','garbanzos con arroz comida casera','chickpea stew bowl food','garbanzos restaurante'], tags:['chickpeas','chickpea stew','garbanzos','bowl food','homemade food'] },
  { id:'arvejas', category:'principle', label:'Arvejas', keys:['arveja','arvejas'], aliases:['arvejas guisadas','peas stew'], terms:['arvejas guisadas plato','arvejas con arroz comida casera','peas stew food bowl','arvejas colombianas'], tags:['peas','pea stew','arvejas','bowl food','homemade food'] },
  { id:'pasta', category:'principle', label:'Pasta', keys:['pasta','espagueti','spaghetti','macarron','macarrón','fideos'], aliases:['espagueti','pasta corta','macarrones'], terms:['pasta servida en plato','espagueti plato restaurante','pasta como principio almuerzo','macarrones comida casera'], tags:['pasta plate','spaghetti','macaroni','noodles','restaurant dish'] },
  { id:'arroz', category:'side', label:'Arroz', keys:['arroz','arroz blanco','arroz con coco','arroz amarillo'], aliases:['arroz blanco','rice side dish'], terms:['arroz blanco servido en plato','arroz acompañamiento almuerzo colombiano','white rice side dish','arroz con comida casera'], tags:['white rice','rice plate','rice side','lunch plate','food'] },

  // Acompañamientos
  { id:'ensalada', category:'side', label:'Ensalada', keys:['ensalada','lechuga','repollo','verdura','vegetales'], aliases:['ensalada fresca','green salad'], terms:['ensalada fresca servida en plato','ensalada acompañamiento almuerzo','ensalada de repollo colombiana','green salad side dish'], tags:['salad','green salad','side salad','vegetable salad','lunch plate'] },
  { id:'papa-cocida', category:'side', label:'Papa cocida', keys:['papa cocida','papa salada','papa sudada','papa chorriada'], aliases:['papa cocida','papa salada'], terms:['papa cocida servida en plato','papa salada acompañamiento colombiano','boiled potatoes side dish','papa sudada comida colombiana'], tags:['boiled potatoes','potatoes side','papa','side dish','lunch plate'] },
  { id:'papa-frita', category:'side', label:'Papas fritas', keys:['papa frita','papas fritas','french fries'], aliases:['papas fritas','french fries'], terms:['papas fritas servidas en plato','papas fritas acompañamiento restaurante','french fries plate food','fried potatoes side dish'], tags:['french fries','fried potatoes','fries plate','side dish','food'] },
  { id:'patacon', category:'side', label:'Patacón', keys:['patacon','patacón','toston','tostón'], aliases:['patacones','tostones'], terms:['patacon frito plato colombiano','patacones como acompañamiento','tostones fried plantain plate','patacon con comida colombiana'], tags:['patacones','tostones','fried plantain','plantain plate','colombian food'] },
  { id:'maduro', category:'side', label:'Plátano maduro', keys:['maduro','platano maduro','plátano maduro','tajada','tajadas'], aliases:['tajadas de maduro','fried sweet plantain'], terms:['tajadas de maduro plato colombiano','platano maduro frito acompañamiento','fried sweet plantain plate','maduro con almuerzo colombiano'], tags:['sweet plantain','fried plantain','plantain side','colombian food','lunch plate'] },
  { id:'yuca', category:'side', label:'Yuca', keys:['yuca','yucca','cassava'], aliases:['yuca frita','yuca cocida'], terms:['yuca frita servida en plato','yuca cocida acompañamiento colombiano','cassava side dish plate','yuca con almuerzo colombiano'], tags:['cassava','yuca','yucca fries','side dish','colombian food'] },
  { id:'arepa', category:'side', label:'Arepa', keys:['arepa','arepas'], aliases:['arepa colombiana'], terms:['arepa colombiana servida en plato','arepa acompañamiento comida colombiana','corn arepa plate food','arepa restaurante'], tags:['arepa','corn cake','colombian food','side dish','plate'] },
  { id:'aguacate', category:'side', label:'Aguacate', keys:['aguacate','avocado'], aliases:['aguacate en tajadas'], terms:['aguacate servido en plato','tajadas de aguacate acompañamiento','avocado slices plate food','aguacate almuerzo colombiano'], tags:['avocado','avocado slices','side dish','plate food','lunch'] },

  // Sopas
  { id:'sopa-arroz', category:'soup', label:'Sopa de arroz', keys:['sopa de arroz','arroz sopa'], aliases:['sopa de arroz casera'], terms:['sopa de arroz casera plato hondo','sopa de arroz colombiana','rice soup bowl food','sopa casera de arroz'], tags:['rice soup','soup bowl','homemade soup','colombian soup','food'] },
  { id:'sopa-pasta', category:'soup', label:'Sopa de pasta', keys:['sopa de pasta','sopa de fideos','fideos sopa'], aliases:['sopa de fideos'], terms:['sopa de pasta plato hondo','sopa de fideos casera','noodle soup bowl food','sopa casera con fideos'], tags:['noodle soup','soup bowl','pasta soup','homemade soup','food'] },
  { id:'sopa-verduras', category:'soup', label:'Sopa de verduras', keys:['sopa de verduras','verduras sopa','sopa de vegetales'], aliases:['sopa de verduras casera'], terms:['sopa de verduras plato hondo','sopa de vegetales casera','vegetable soup bowl food','sopa casera de verduras'], tags:['vegetable soup','soup bowl','homemade soup','vegetables','food'] },
  { id:'sancocho', category:'soup', label:'Sancocho', keys:['sancocho'], aliases:['sancocho colombiano'], terms:['sancocho colombiano plato hondo','sancocho de pollo colombiano','sancocho comida colombiana','colombian sancocho soup'], tags:['sancocho','colombian soup','soup bowl','latin food','food'] },
  { id:'mondongo', category:'soup', label:'Mondongo', keys:['mondongo'], aliases:['sopa de mondongo'], terms:['mondongo colombiano plato hondo','sopa de mondongo colombiana','mondongo soup bowl','sopa colombiana mondongo'], tags:['mondongo','tripe soup','soup bowl','colombian food','latin food'] },
  { id:'ajiaco', category:'soup', label:'Ajiaco', keys:['ajiaco'], aliases:['ajiaco colombiano'], terms:['ajiaco colombiano plato hondo','ajiaco santafereño sopa colombiana','ajiaco soup bowl','sopa ajiaco colombiana'], tags:['ajiaco','colombian soup','soup bowl','latin food','food'] },
  { id:'sopa-general', category:'soup', label:'Sopa', keys:['sopa','caldo','crema','consome','consomé'], aliases:['sopa casera','caldo'], terms:['sopa casera plato hondo','caldo colombiano plato hondo','homemade soup bowl food','soup bowl restaurant'], tags:['soup bowl','homemade soup','caldo','restaurant soup','food'] },

  // Bebidas e industriales
  { id:'jugo-mora', category:'drink', label:'Jugo de mora', keys:['jugo de mora','mora'], aliases:['jugo de mora','blackberry juice'], terms:['jugo de mora en vaso','bebida de mora restaurante','blackberry juice glass','jugo natural de mora'], tags:['blackberry juice','fruit juice','juice glass','drink','mora'] },
  { id:'jugo-pina', category:'drink', label:'Jugo de piña', keys:['jugo de pina','jugo de piña','piña','pina'], aliases:['jugo de piña','pineapple juice'], terms:['jugo de piña en vaso','bebida de piña restaurante','pineapple juice glass','jugo natural de piña'], tags:['pineapple juice','fruit juice','juice glass','drink','pineapple'] },
  { id:'jugo-guayaba', category:'drink', label:'Jugo de guayaba', keys:['jugo de guayaba','guayaba'], aliases:['jugo de guayaba','guava juice'], terms:['jugo de guayaba en vaso','bebida de guayaba restaurante','guava juice glass','jugo natural de guayaba'], tags:['guava juice','fruit juice','juice glass','drink','guava'] },
  { id:'jugo-lulo', category:'drink', label:'Jugo de lulo', keys:['jugo de lulo','lulo'], aliases:['jugo de lulo','lulo juice'], terms:['jugo de lulo en vaso','bebida de lulo colombiana','lulo juice glass','jugo natural de lulo'], tags:['lulo juice','fruit juice','juice glass','drink','colombian drink'] },
  { id:'limonada', category:'drink', label:'Limonada', keys:['limonada','limon','limón'], aliases:['limonada natural','lemonade'], terms:['limonada natural en vaso','lemonade glass drink','bebida limonada restaurante','limonada colombiana'], tags:['lemonade','lemon drink','juice glass','drink','restaurant'] },
  { id:'gaseosa', category:'industrial', label:'Gaseosa', keys:['gaseosa','soda','coca cola','coca-cola','pepsi','postobon','postobón','colombiana','manzana postobon','sprite','quatro'], aliases:['gaseosa botella','soda bottle'], terms:['gaseosa colombiana botella','Postobon gaseosa botella','Coca Cola botella Colombia','bebida gaseosa producto supermercado'], tags:['soda bottle','soft drink','coca cola','postobon','drink'] },
  { id:'agua', category:'industrial', label:'Agua', keys:['agua','agua botella','botella de agua'], aliases:['agua embotellada'], terms:['agua embotellada producto','botella de agua supermercado','water bottle product','agua botella'], tags:['water bottle','bottled water','drink product','agua','supermarket'] },
  { id:'snack', category:'industrial', label:'Snack', keys:['snack','papas paquete','paquete','galleta','chitos','doritos','mecato'], aliases:['snack empacado'], terms:['snack empacado producto supermercado','papas paquete producto Colombia','galletas paquete producto','mecato colombiano paquete'], tags:['snack bag','packaged snack','chips bag','supermarket product','snack'] },
  { id:'postre-industrial', category:'industrial', label:'Postre industrial', keys:['postre','gelatina','flan','yogurt','yogur','alpina'], aliases:['postre empacado'], terms:['postre empacado supermercado','gelatina producto supermercado','yogurt Alpina producto','flan empacado producto'], tags:['dessert cup','gelatin dessert','yogurt cup','packaged dessert','supermarket'] },

  // Platos armados y genéricos
  { id:'hamburguesa', category:'complete_plate', label:'Hamburguesa', keys:['hamburguesa','burger','combo hamburguesa'], aliases:['hamburguesa con papas'], terms:['hamburguesa con papas plato restaurante','combo hamburguesa restaurante','burger meal fries','hamburger plate food'], tags:['hamburger','burger meal','fries burger','restaurant burger','food'] },
  { id:'corrientazo', category:'complete_plate', label:'Corrientazo', keys:['corrientazo','almuerzo completo','plato del dia','plato del día','bandeja'], aliases:['almuerzo colombiano','plato del día'], terms:['corrientazo colombiano plato completo','almuerzo colombiano arroz ensalada carne','plato del dia colombiano restaurante','bandeja almuerzo casero colombiano'], tags:['colombian lunch','lunch plate','rice meat salad','latin food','restaurant meal'] },
  { id:'default', category:'general', label:'Plato QuickLunch', keys:[], aliases:['plato de comida','almuerzo'], terms:['plato de comida servido restaurante','almuerzo casero servido en plato','restaurant lunch plate food','homemade lunch plate'], tags:['lunch plate','restaurant dish','homemade meal','food plate','latin food'] }
];

const INDUSTRIAL_DOMAINS = [
  'exito.com','carulla.com','jumbo.com.co','olimpica.com','tiendasd1.com','alkosto.com','makro.com.co','pricesmart.com.co','farmatodo.com.co','merqueo.com','rappi.com.co','mercadolibre.com.co',
  'nutresa.com','postobon.com','coca-cola.com','coca-cola.com.co','alpina.com','pepsico.com','pepsico.com.co','colombina.com','bavaria.co','qualacolombia.com','teamfoods.com',
  'nestle.com.co','unileverfoodsolutions.com.co','dislicores.com','mercacentro.com.co','laika.com.co','tostao.com','ara.com.co','isimo.co','megatiendas.co','superinter.com.co',
  'supermercadoscolsubsidio.com','plazavea.com.co','frisby.com.co','klisto.com.co','makro.com','metro.com.co'
];
const FOOD_RECIPE_DOMAINS = IMAGE_SEARCH_DOMAINS.filter((d) => !INDUSTRIAL_DOMAINS.includes(d));

const INDUSTRIAL_PRODUCT_HINTS = [
  // Palabras de empaque/presentación: estas sí indican producto de supermercado.
  'gaseosa','soda','botella','lata','paquete','producto','industrial','empacado','empaque','snack','mecato','papas paquete','paquete familiar','six pack','pack','ml','litro','litros','presentacion','presentación','unidad','bolsa','caja','vaso','tetrapak','tetra pak','sixpack',
  // Marcas y productos comunes en corrientazos/tiendas.
  'papas margarita','margarita','doritos','cheetos','chitos','todito','de todito','detodito','galleta','galletas','oreo','ducales','saltin','festival','chocolate','jet','chocoramo','nucita','pony malta','maltin polar','mr tea','fuze tea','gatorade','speed max','vive 100','red bull',
  'coca cola','coca-cola','coke','pepsi','sprite','quatro','colombiana','postobon','postobón','manzana postobon','manzana postobón','uva postobon','kola roman','seven up','7up',
  'agua cristal','agua brisa','agua manantial','agua botella','agua embotellada','cristal botella','brisa botella',
  'hit','del valle','frutto','tutti frutti','cifrut','jugos hit','jugo hit','néctar','nectar','caja de jugo','jugo en caja','bebida hit',
  'yogurt','yogur','alpina','alpinette','bonyurt','bon yurt','kumis','avena alpina','gelatina','flan','postre empacado','yogo yogo','regeneris','finesse','alpin'
];

function isIndustrialProductSearch(query = '', description = '') {
  const text = normalizeFoodText(`${query} ${description}`);
  return INDUSTRIAL_PRODUCT_HINTS.some((hint) => text.includes(normalizeFoodText(hint)));
}

function productExactTokens(query = '', description = '') {
  const text = normalizeFoodText(`${query} ${description}`);
  const raw = text.split(' ').filter((w) => w.length > 2 && !GENERIC_IMAGE_WORDS.has(w));
  const brandCombos = [
    'coca cola','coca-cola','manzana postobon','manzana postobón','pony malta','mr tea','fuze tea','agua cristal','agua brisa','papas margarita','de todito','jugo hit','jugos hit','del valle','bon yurt','bonyurt','avena alpina','chocolate jet'
  ].filter((combo) => text.includes(normalizeFoodText(combo))).flatMap((combo) => normalizeFoodText(combo).split(' '));
  return [...new Set([...raw, ...brandCombos].filter(Boolean))].slice(0, 10);
}

function profileScoreForText(profile, text) {
  const normalized = normalizeFoodText(text);
  let score = 0;
  for (const key of profile.keys || []) {
    const k = normalizeFoodText(key);
    if (!k) continue;
    if (normalized.includes(k)) score += 100 + k.length;
  }
  for (const alias of profile.aliases || []) {
    const a = normalizeFoodText(alias);
    if (a && normalized.includes(a)) score += 50 + a.length;
  }
  const tokens = normalized.split(' ').filter((w) => w.length > 2);
  for (const key of profile.keys || []) {
    for (const t of normalizeFoodText(key).split(' ').filter((w) => w.length > 2)) {
      if (tokens.includes(t)) score += 12;
    }
  }
  return score;
}

function detectRealFoodProfile(query = '', description = '') {
  const text = `${query} ${description}`;
  const ranked = CORRIENTAZO_IMAGE_PROFILES
    .filter((p) => p.id !== 'default')
    .map((profile) => ({ profile, score: profileScoreForText(profile, text) }))
    .sort((a, b) => b.score - a.score);
  return ranked[0]?.score > 0 ? ranked[0].profile : CORRIENTAZO_IMAGE_PROFILES.find((p) => p.id === 'default');
}

function profileDomainList(profile, query = '', description = '') {
  if (isIndustrialProductSearch(query, description) || profile?.category === 'industrial') {
    // Para productos empacados se consulta primero supermercado/marca, porque las recetas suelen devolver platos similares pero no el producto real.
    return [...new Set([...INDUSTRIAL_DOMAINS, ...FOOD_RECIPE_DOMAINS])];
  }
  if (profile?.category === 'drink') {
    // Jugos naturales y limonadas deben verse como bebidas reales; supermercados solo quedan como respaldo.
    return [...new Set([...FOOD_RECIPE_DOMAINS, ...INDUSTRIAL_DOMAINS])];
  }
  return [...new Set([...FOOD_RECIPE_DOMAINS, ...INDUSTRIAL_DOMAINS])];
}

function corrientazoContextVariants(profile = {}, query = '', description = '') {
  const rawName = String(query || '').trim();
  const label = profile.label || rawName || 'plato';
  const base = rawName || label;
  const cat = profile.category || 'general';
  const variants = [];

  if (cat === 'protein') {
    variants.push(`${base} almuerzo ejecutivo colombiano`, `${base} corrientazo con arroz y ensalada`, `${base} plato servido restaurante`, `${label} comida casera colombiana`);
  } else if (cat === 'principle') {
    variants.push(`${base} principio de corrientazo colombiano`, `${base} servido con arroz almuerzo`, `${label} casero plato hondo`, `${base} guiso colombiano`);
  } else if (cat === 'side') {
    variants.push(`${base} acompañamiento de almuerzo colombiano`, `${base} servido en plato`, `${label} porción restaurante`, `${base} comida colombiana acompañamiento`);
  } else if (cat === 'soup') {
    variants.push(`${base} sopa casera plato hondo`, `${base} sopa colombiana restaurante`, `${label} caldo servido`, `${base} almuerzo colombiano sopa`);
  } else if (cat === 'drink') {
    variants.push(`${base} jugo natural en vaso`, `${base} bebida natural restaurante`, `${label} vaso frio`, `${base} jugo colombiano`);
  } else if (cat === 'complete_plate') {
    variants.push(`${base} plato completo restaurante`, `${base} almuerzo colombiano`, `${label} servido con acompañamientos`, `${base} comida real`);
  } else {
    variants.push(`${base} plato de comida real`, `${base} restaurante foto`, `${base} almuerzo servido`, `${label} comida colombiana`);
  }

  return variants;
}

function realFoodTerms(query = '', description = '') {
  const profile = detectRealFoodProfile(query, description);
  const rawName = String(query || '').trim();
  const rawDescription = String(description || '').trim();
  const negative = '-logo -icono -vector -dibujo -clipart -caricatura -emoji -banner -plantilla -menu -menú -pdf -mapa';
  const terms = [];
  const industrial = isIndustrialProductSearch(query, description) || profile?.category === 'industrial';

  if (industrial) {
    const presentation = extractPresentationText(`${query} ${description}`);
    const brandQuery = productBrandAwareQuery(query, description);
    if (brandQuery && presentation) terms.push(`${brandQuery} ${presentation} producto original foto ${negative}`);
    if (rawName) terms.push(`${rawName} producto original empaque foto ${negative}`);
    if (rawName) terms.push(`${rawName} supermercado Colombia producto ${negative}`);
    if (rawName) terms.push(`${rawName} botella lata paquete empaque ${negative}`);
    if (rawName) terms.push(`${rawName} tienda online Colombia imagen producto ${negative}`);
    for (const term of profile.terms || []) terms.push(`${term} producto empaque supermercado ${negative}`);
    for (const alias of profile.aliases || []) terms.push(`${alias} producto real empaque ${negative}`);
  } else {
    if (rawName && rawDescription) terms.push(`${rawName} ${rawDescription} foto real ${negative}`);
    if (rawName) terms.push(`${rawName} plato real restaurante ${negative}`);
    if (rawName) terms.push(`${rawName} almuerzo colombiano corrientazo ${negative}`);
    corrientazoContextVariants(profile, query, description).forEach((term) => terms.push(`${term} ${negative}`));
    for (const term of profile.terms || []) terms.push(`${term} ${negative}`);
    for (const alias of profile.aliases || []) terms.push(`${alias} foto real plato ${negative}`);
  }
  return [...new Set(terms.map(x => x.replace(/\s+/g, ' ').trim()).filter(Boolean))].slice(0, 18);
}

function realFoodLabel(query = '', profile = {}) {
  const clean = String(query || '').trim();
  return clean || profile.label || 'Plato QuickLunch';
}

function relevanceTokens(query = '', description = '', profile = detectRealFoodProfile(query, description)) {
  const direct = normalizeFoodText(`${query} ${description}`).split(' ')
    .filter((word) => word.length > 2 && !GENERIC_IMAGE_WORDS.has(word));
  const profileTokens = [profile.label, ...(profile.keys || []), ...(profile.aliases || [])]
    .join(' ')
    .split(' ')
    .map(normalizeFoodText)
    .filter((word) => word.length > 2 && !GENERIC_IMAGE_WORDS.has(word));
  return [...new Set([...direct, ...profileTokens])].slice(0, 14);
}

function candidateAlreadyUsed(list, url = '', thumbnail = '') {
  const normalizedUrl = String(url || '').split('?')[0].toLowerCase();
  const normalizedThumb = String(thumbnail || '').split('?')[0].toLowerCase();
  return list.some(item => {
    const u = String(item.url || '').split('?')[0].toLowerCase();
    const t = String(item.thumbnail || '').split('?')[0].toLowerCase();
    return (normalizedUrl && (u === normalizedUrl || t === normalizedUrl)) || (normalizedThumb && (u === normalizedThumb || t === normalizedThumb));
  });
}

function candidateMatchesSearch(item = {}, query = '', description = '') {
  const profile = detectRealFoodProfile(query, description);
  const haystack = normalizeFoodText(`${item.label || ''} ${item.context || ''} ${item.source || ''} ${item.url || ''}`);
  const tokens = relevanceTokens(query, description, profile);
  if (!tokens.length) return true;
  const hits = tokens.filter((token) => haystack.includes(token)).length;
  if (hits > 0) return true;
  // Para productos industriales, algunas tiendas no ponen el nombre en el thumbnail. Se permite si viene de dominio de producto y la búsqueda era industrial.
  if ((profile.category === 'industrial' || profile.category === 'drink') && /exito|carulla|jumbo|olimpica|d1|alkosto|makro|pricesmart|farmatodo|merqueo|rappi|mercadolibre|nutresa|postobon|coca-cola|alpina/i.test(haystack)) return true;
  return false;
}

function addRealPhotoCandidate(list, item, query = '', description = '') {
  if (!item?.url || !isProbablyImageUrl(item.url)) return;
  const bad = normalizeFoodText(`${item.label || ''} ${item.context || ''} ${item.source || ''} ${item.url || ''}`);
  if (/(logo|icon|vector|svg|clipart|cartoon|drawing|emoji|placeholder|pattern|template|banner|mapa|pdf|menu|menú)/i.test(bad)) return;
  if (!candidateMatchesSearch(item, query, description)) return;
  if (candidateAlreadyUsed(list, item.url, item.thumbnail)) return;
  list.push({
    label: item.label || realFoodLabel(query, detectRealFoodProfile(query, description)),
    url: item.url,
    thumbnail: item.thumbnail || item.url,
    source: item.source || 'Foto real sugerida',
    context: item.context || 'Imagen fotográfica relacionada con el producto',
    attribution: item.attribution || ''
  });
}

async function fetchJsonSafe(url, options = {}) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), options.timeout || 5000);
  try {
    const response = await fetch(url, { signal: controller.signal, headers: { 'User-Agent': 'QuickLunchDemo/1.0 image search' } });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

function extractPresentationText(text = '') {
  const normalized = String(text || '').toLowerCase();
  const matches = normalized.match(/\b\d+(?:[.,]\d+)?\s?(?:ml|mililitros|l|lt|litro|litros|g|gr|gramos|kg|kilo|oz)\b|\b(?:botella|lata|paquete|bolsa|caja|vaso|tetra\s?pak|six\s?pack|unidad|personal|familiar)\b/gi) || [];
  return [...new Set(matches.map((x) => x.replace(/\s+/g, ' ').trim()))].slice(0, 5).join(' ');
}

function productBrandAwareQuery(query = '', description = '') {
  const text = normalizeFoodText(`${query} ${description}`);
  const combos = [
    'coca cola','coca-cola','pepsi','sprite','quatro','colombiana','postobon','postobón','pony malta','mr tea','fuze tea','gatorade','hit','del valle','agua cristal','agua brisa','papas margarita','doritos','cheetos','chitos','de todito','detodito','oreo','festival','ducales','saltin','jet','chocoramo','alpina','alpinette','bonyurt','bon yurt','kumis','avena alpina','yogo yogo'
  ];
  const found = combos.find((combo) => text.includes(normalizeFoodText(combo)));
  if (found) return found;
  return String(query || '').trim();
}

function openFoodFactsQueries(query = '', description = '') {
  const raw = String(query || '').trim();
  const brandAware = productBrandAwareQuery(query, description);
  const presentation = extractPresentationText(`${query} ${description}`);
  const tokens = productExactTokens(query, description).filter((t) => t.length > 2).slice(0, 6).join(' ');
  return [...new Set([
    raw,
    brandAware && presentation ? `${brandAware} ${presentation}` : '',
    brandAware,
    tokens,
    raw ? `${raw} colombia` : '',
    brandAware ? `${brandAware} producto` : ''
  ].map((x) => String(x || '').replace(/\s+/g, ' ').trim()).filter((x) => x.length > 1))].slice(0, 6);
}

function openFoodFactsScore(product = {}, query = '', description = '') {
  const haystack = normalizeFoodText(`${product.product_name || ''} ${product.brands || ''} ${product.generic_name || ''} ${product.quantity || ''} ${product.categories || ''} ${product.stores || ''} ${product.countries || ''}`);
  const exact = productExactTokens(query, description);
  let score = 0;
  for (const token of exact) if (haystack.includes(token)) score += 35;
  const brand = normalizeFoodText(productBrandAwareQuery(query, description));
  if (brand && haystack.includes(brand)) score += 80;
  const presentation = normalizeFoodText(extractPresentationText(`${query} ${description}`));
  if (presentation && haystack.includes(presentation)) score += 25;
  if (/colombia|colombie|co\b/.test(haystack)) score += 8;
  if (/beverage|drink|snack|chips|soda|water|yogurt|galleta|bebida|gaseosa|botella|lata|paquete/.test(haystack)) score += 15;
  return score;
}

async function fetchOpenFoodFactsCandidates(query = '', description = '') {
  if (!isIndustrialProductSearch(query, description)) return [];
  const candidates = [];
  const queries = openFoodFactsQueries(query, description);
  const fields = 'product_name,brands,generic_name,quantity,categories,stores,countries,image_url,image_front_url,image_small_url,image_front_small_url,image_thumb_url';
  for (const q of queries) {
    const params = new URLSearchParams({ search_terms: q, search_simple: '1', action: 'process', json: '1', page_size: '20', fields });
    const urls = [
      `https://world.openfoodfacts.org/cgi/search.pl?${params.toString()}`,
      `https://co.openfoodfacts.org/cgi/search.pl?${params.toString()}`
    ];
    for (const url of urls) {
      const json = await fetchJsonSafe(url, { timeout: 6500 });
      const products = Array.isArray(json?.products) ? json.products : [];
      products
        .map((product) => ({ product, score: openFoodFactsScore(product, query, description) }))
        .filter(({ product, score }) => score >= 25 && (product.image_front_url || product.image_url || product.image_small_url || product.image_thumb_url))
        .sort((a, b) => b.score - a.score)
        .slice(0, 8)
        .forEach(({ product }) => {
          const url = product.image_front_url || product.image_url || product.image_small_url || product.image_thumb_url;
          const thumbnail = product.image_front_small_url || product.image_small_url || product.image_thumb_url || url;
          addRealPhotoCandidate(candidates, {
            label: `${product.brands ? `${product.brands} · ` : ''}${product.product_name || realFoodLabel(query, detectRealFoodProfile(query, description))}`,
            url,
            thumbnail,
            source: 'Open Food Facts · producto real',
            context: `${product.product_name || ''} ${product.brands || ''} ${product.quantity || ''} ${product.categories || ''} ${product.stores || ''} ${q}`,
            attribution: 'Foto de producto real obtenida desde Open Food Facts.'
          }, query, description);
        });
      if (candidates.length >= 5) return diversifyImageCandidates(candidates, { limit: 5 });
    }
  }
  return diversifyImageCandidates(candidates, { limit: 5 });
}

function imageDomainKey(item = {}) {
  return hostFromUrl(item.context || item.url || item.thumbnail || '').replace(/^www\./, '');
}

function labelFingerprint(text = '') {
  return normalizeFoodText(text).split(' ').filter((word) => word.length > 3 && !GENERIC_IMAGE_WORDS.has(word)).slice(0, 7).join('-');
}

function diversifyImageCandidates(items = [], options = {}) {
  const limit = options.limit || 5;
  const unique = [];
  const seenUrl = new Set();
  const seenThumb = new Set();
  const seenFingerprints = new Set();
  const domainCounts = new Map();

  for (const item of items) {
    if (!item?.url) continue;
    const cleanUrl = String(item.url).split('?')[0].toLowerCase();
    const cleanThumb = String(item.thumbnail || item.url).split('?')[0].toLowerCase();
    if (seenUrl.has(cleanUrl) || seenThumb.has(cleanThumb)) continue;
    const fp = labelFingerprint(`${item.label || ''} ${item.context || ''}`);
    const domain = imageDomainKey(item);
    const count = domainCounts.get(domain) || 0;
    if (fp && seenFingerprints.has(fp) && unique.length >= 2) continue;
    if (domain && count >= 2 && unique.length >= 3) continue;
    unique.push(item);
    seenUrl.add(cleanUrl);
    seenThumb.add(cleanThumb);
    if (fp) seenFingerprints.add(fp);
    if (domain) domainCounts.set(domain, count + 1);
    if (unique.length >= limit) break;
  }

  if (unique.length < limit) {
    for (const item of items) {
      if (!item?.url || unique.some((x) => x.url === item.url || x.thumbnail === item.thumbnail)) continue;
      unique.push(item);
      if (unique.length >= limit) break;
    }
  }
  return unique.slice(0, limit);
}

function googleImageScoreV2(item = {}, query = '', description = '') {
  const profile = detectRealFoodProfile(query, description);
  const industrial = isIndustrialProductSearch(query, description) || profile.category === 'industrial';
  const title = item.title || '';
  const snippet = item.snippet || '';
  const contextLink = item.image?.contextLink || '';
  const displayLink = item.displayLink || '';
  const imageUrl = item.link || '';
  const haystack = normalizeFoodText(`${title} ${snippet} ${contextLink} ${displayLink} ${imageUrl}`);
  const tokens = industrial ? productExactTokens(query, description) : relevanceTokens(query, description, profile);
  const badVisual = ['logo','icono','vector','clipart','dibujo','caricatura','emoji','menu','menú','plantilla','ilustracion','ilustración','pdf','mapa','banner','poster','collage','infografia','infografía'];
  let score = 0;

  for (const token of tokens) {
    if (haystack.includes(token)) score += industrial ? 34 : 28;
  }
  for (const term of profile.terms || []) {
    const parts = normalizeFoodText(term).split(' ').filter((w) => w.length > 2 && !GENERIC_IMAGE_WORDS.has(w));
    for (const part of parts) if (haystack.includes(part)) score += industrial ? 7 : 5;
  }
  for (const bad of badVisual) if (haystack.includes(normalizeFoodText(bad))) score -= industrial ? 45 : 80;

  const allowed = allowedImageDomain(contextLink || imageUrl, displayLink);
  if (allowed) score += industrial ? 52 : 28;
  if (industrial && /(exito|carulla|jumbo|olimpica|d1|tiendasd1|alkosto|makro|pricesmart|farmatodo|merqueo|rappi|mercadolibre|nutresa|postobon|coca-cola|alpina|pepsi|colombina|nestle)/i.test(`${displayLink} ${contextLink}`)) score += 35;

  const width = Number(item.image?.width || 0);
  const height = Number(item.image?.height || 0);
  if (width >= 450 && height >= 300) score += 8;
  if (industrial && width >= 250 && height >= 250) score += 8;
  if (width && height && (width < 180 || height < 140)) score -= 40;

  if (!industrial && /(plato|receta|comida|restaurante|food|dish|plate)/.test(haystack)) score += 10;
  if (industrial && /(producto|botella|lata|empaque|bebida|drink|supermercado|market|tienda|ml|litro|paquete|pack)/.test(haystack)) score += 24;
  if (industrial && /(receta|plato|preparacion|preparación|cocinar|casero|served|restaurant dish)/.test(haystack)) score -= 25;
  return score;
}

function googleItemToCandidateV2(item = {}, query = '', description = '') {
  const thumbnail = item.image?.thumbnailLink || item.link;
  const url = item.link || thumbnail;
  const context = item.image?.contextLink || item.formattedUrl || item.displayLink || '';
  return {
    label: item.title || realFoodLabel(query, detectRealFoodProfile(query, description)),
    url,
    thumbnail,
    source: `Google CSE · ${item.displayLink || hostFromUrl(context || url) || 'fuente configurada'}`,
    context: `${context} ${item.snippet || ''}`.trim(),
    attribution: 'Imagen sugerida desde fuentes configuradas para alimentos, restaurantes, recetas o productos.'
  };
}

async function fetchGoogleCseCandidatesV2(query = '', description = '') {
  if (!GOOGLE_CSE_API_KEY || !GOOGLE_CSE_ID) return [];
  const profile = detectRealFoodProfile(query, description);
  const industrial = isIndustrialProductSearch(query, description) || profile.category === 'industrial';
  const terms = realFoodTerms(query, description).slice(0, industrial ? 12 : 10);
  const candidates = [];
  const domains = profileDomainList(profile, query, description);
  const baseParams = {
    key: GOOGLE_CSE_API_KEY,
    cx: GOOGLE_CSE_ID,
    searchType: 'image',
    safe: 'active',
    hl: 'es',
    gl: 'co',
    num: '10'
  };
  if (!industrial) {
    baseParams.imgType = 'photo';
    baseParams.imgSize = 'large';
  }

  const requests = [];
  const rawName = String(query || '').trim();

  if (industrial) {
    const brandAware = productBrandAwareQuery(query, description);
    const presentation = extractPresentationText(`${query} ${description}`);
    const directTerms = [...new Set([
      brandAware && presentation ? `${brandAware} ${presentation}` : '',
      rawName ? `${rawName} producto original` : '',
      rawName ? `${rawName} supermercado Colombia` : '',
      rawName ? `${rawName} botella lata paquete empaque` : '',
      ...terms
    ].filter(Boolean))];
    for (const domain of INDUSTRIAL_DOMAINS.slice(0, 42)) {
      for (const term of directTerms.slice(0, 4)) {
        requests.push({ q: `${term} site:${domain}` });
        requests.push({ q: term, siteSearch: domain, siteSearchFilter: 'i' });
      }
    }
    for (const term of directTerms.slice(0, 8)) requests.push({ q: term });
  } else {
    const corrientazoTerms = [...terms, ...corrientazoContextVariants(profile, query, description)].filter(Boolean);
    for (const term of corrientazoTerms.slice(0, 8)) requests.push({ q: term });
    for (const domain of domains.slice(0, 36)) {
      requests.push({ q: corrientazoTerms[0] || query, siteSearch: domain, siteSearchFilter: 'i' });
    }
    for (const domain of domains.slice(0, 24)) {
      requests.push({ q: corrientazoTerms[1] || corrientazoTerms[0] || query, siteSearch: domain, siteSearchFilter: 'i' });
    }
  }

  for (const request of requests.slice(0, industrial ? 90 : 70)) {
    const params = new URLSearchParams({ ...baseParams, ...request });
    params.set('_ql', String(Date.now()).slice(-6));
    const json = await fetchJsonSafe(`https://www.googleapis.com/customsearch/v1?${params.toString()}`, { timeout: 7000 });
    const items = Array.isArray(json?.items) ? json.items : [];
    const ranked = items
      .filter((item) => item?.link && item?.image?.thumbnailLink)
      .map((item) => ({ item, score: googleImageScoreV2(item, query, description) }))
      .filter(({ item, score }) => score >= (industrial ? 4 : 18) && candidateMatchesSearch(googleItemToCandidateV2(item, query, description), query, description))
      .sort((a, b) => b.score - a.score)
      .map(({ item }) => googleItemToCandidateV2(item, query, description));
    for (const item of ranked) addRealPhotoCandidate(candidates, item, query, description);
    if (candidates.length >= 8) break;
  }
  return diversifyImageCandidates(candidates, { limit: 5 });
}

function loremFlickrCandidates(profile, query = '', description = '') {
  const label = realFoodLabel(query, profile);
  const base = `${query}|${description}|${profile.id}|v120`;
  const exactTokens = relevanceTokens(query, description, profile).slice(0, 3);
  const tagsList = [];
  for (const tags of profile.tags || []) tagsList.push(Array.isArray(tags) ? tags : [tags]);
  tagsList.push(exactTokens.concat(['food']).filter(Boolean));
  tagsList.push([profile.label, 'food', 'plate'].map(normalizeFoodText).filter(Boolean));
  return tagsList.slice(0, 5).map((tags, idx) => {
    const cleaned = tags.join(',').replace(/\s+/g, ',').split(',').map(normalizeFoodText).filter(Boolean).slice(0, 5);
    const lock = (hashInt(`${base}|${idx}|${cleaned.join('|')}`) % 900000) + 10000;
    const url = `https://loremflickr.com/900/620/${cleaned.map(encodeURIComponent).join(',')}?lock=${lock}`;
    return {
      label: `${label} · foto real ${idx + 1}`,
      url,
      thumbnail: url,
      source: 'Fotos reales por etiquetas del producto',
      context: cleaned.join(', '),
      attribution: 'Foto real sugerida por etiquetas específicas del producto.'
    };
  });
}

async function realFoodImageSuggestions(query = '', description = '') {
  const profile = detectRealFoodProfile(query, description);
  const industrial = isIndustrialProductSearch(query, description) || profile.category === 'industrial';
  const productCandidates = industrial ? await fetchOpenFoodFactsCandidates(query, description) : [];
  const googleCandidates = await fetchGoogleCseCandidatesV2(query, description);
  const candidates = diversifyImageCandidates([...productCandidates, ...googleCandidates], { limit: 5 });

  if (industrial) {
    return {
      provider: productCandidates.length
        ? 'Open Food Facts + Google CSE · productos reales'
        : (googleCandidates.length ? 'Google CSE · supermercados y marcas' : 'Sin resultados útiles de productos'),
      images: candidates,
      googleWorking: Boolean(googleCandidates.length),
      productWorking: Boolean(productCandidates.length),
      usingFallback: false,
      profile: profile.id,
      terms: realFoodTerms(query, description).slice(0, 5)
    };
  }

  if (candidates.length >= 4) {
    return { provider: 'Google CSE · búsqueda específica por corrientazo', images: candidates.slice(0, 5), googleWorking: true, usingFallback: false, profile: profile.id, terms: realFoodTerms(query, description).slice(0, 5) };
  }

  const fallback = [...candidates];
  loremFlickrCandidates(profile, query, description).forEach(item => addRealPhotoCandidate(fallback, item, query, description));
  return {
    provider: candidates.length ? 'Google CSE + fotos reales por etiquetas del producto' : 'Fotos reales por etiquetas del producto',
    images: diversifyImageCandidates(fallback, { limit: 5 }),
    googleWorking: Boolean(googleCandidates.length),
    productWorking: false,
    usingFallback: fallback.length > candidates.length,
    profile: profile.id,
    terms: realFoodTerms(query, description).slice(0, 5)
  };
}

app.post('/api/images/import', auth(RESTAURANT_ROLES), async (req, res) => {
  try {
    const remoteUrl = String(req.body.url || '').trim();
    const thumbnailUrl = String(req.body.thumbnail || '').trim();
    const label = String(req.body.label || req.body.name || 'imagen').trim();
    const targetUrl = remoteUrl || thumbnailUrl;
    if (!targetUrl) return res.status(400).json({ message: 'Selecciona una imagen para importarla.' });
    if (targetUrl.startsWith('/uploads/')) {
      return res.status(201).json({ url: targetUrl, message: 'Imagen agregada al inventario.' });
    }
    try {
      const localUrl = await downloadImageToUploads(targetUrl, label);
      return res.status(201).json({ url: localUrl, message: 'Foto real importada y guardada en QuickLunch.' });
    } catch (firstErr) {
      if (thumbnailUrl && thumbnailUrl !== targetUrl) {
        const localUrl = await downloadImageToUploads(thumbnailUrl, label);
        return res.status(201).json({ url: localUrl, message: 'Miniatura importada y guardada porque la imagen original bloqueó la descarga.' });
      }
      throw firstErr;
    }
  } catch (err) {
    res.status(400).json({ message: err.message || 'No se pudo importar la imagen. Se puede usar el enlace original.' });
  }
});

app.get('/api/images/suggest', auth(RESTAURANT_ROLES), async (req, res) => {
  const query = String(req.query.q || '').trim();
  const description = String(req.query.description || '').trim();
  if (hasBadWords(`${query} ${description}`)) {
    return res.status(400).json({ message: 'La búsqueda contiene palabras inapropiadas. Ajusta el nombre o descripción del producto.' });
  }
  if (query.length < 2) return res.status(400).json({ message: 'Escribe mejor el nombre del producto para buscar imágenes.' });

  const result = await realFoodImageSuggestions(query, description);
  const images = asArray(result.images);
  res.json({
    query,
    description,
    provider: result.provider,
    help: images.length
      ? 'Imágenes sugeridas según el nombre y descripción. Para productos empacados escribe marca y presentación; para platos agrega preparación o acompañamientos.'
      : 'No se encontraron fotos útiles. Revisa la ortografía, agrega marca/presentación si es un producto industrial o sube una imagen manualmente.',
    configured: Boolean(GOOGLE_CSE_API_KEY && GOOGLE_CSE_ID),
    googleWorking: Boolean(result.googleWorking),
    productWorking: Boolean(result.productWorking),
    usingFallback: Boolean(result.usingFallback),
    internetSearch: Boolean(result.googleWorking || result.productWorking),
    sourceDomains: IMAGE_SEARCH_DOMAINS,
    images
  });
});

app.get('/api/images/diagnostics', auth(RESTAURANT_ROLES), async (req, res) => {
  const q = String(req.query.q || 'tilapia frita').trim();
  const description = String(req.query.description || 'pescado frito servido en plato de almuerzo').trim();
  const result = await realFoodImageSuggestions(q, description);
  const images = asArray(result.images);
  res.json({
    provider: result.provider,
    ok: true,
    query: q,
    description,
    configured: Boolean(GOOGLE_CSE_API_KEY && GOOGLE_CSE_ID),
    googleWorking: Boolean(result.googleWorking),
    productWorking: Boolean(result.productWorking),
    usingFallback: Boolean(result.usingFallback),
    sourceDomains: IMAGE_SEARCH_DOMAINS,
    returned: images.length,
    internetSearch: Boolean(result.googleWorking || result.productWorking),
    note: 'Esta versión combina Google CSE para platos de corrientazo y Open Food Facts para productos empacados, evitando galerías genéricas repetidas.',
    sample: images.map((img) => ({ title: img.label, thumbnail: img.thumbnail, provider: img.source, context: img.context }))
  });
});

app.get('/api/restaurant/staff', auth(RESTAURANT_ROLES), restaurantGuard, requireRestaurantFull, (req, res) => {
  const id = getRestaurantId(req);
  res.json(usersDb.prepare('SELECT * FROM accounts WHERE restaurant_id=? ORDER BY role, full_name').all(id).map(serializeAccount));
});

app.post('/api/restaurant/staff', auth(RESTAURANT_ROLES), restaurantGuard, requireRestaurantFull, (req, res) => {
  const id = getRestaurantId(req);
  const role = req.body.role === 'restaurant_owner' ? 'restaurant_owner' : 'restaurant_staff';
  const username = cleanUser(req.body.username);
  const email = cleanUser(req.body.email || `${username}@quicklunch.local`);
  if (!username || username.length < 3) return res.status(400).json({ message: 'El usuario debe tener mínimo 3 caracteres.' });
  if (usersDb.prepare('SELECT id FROM accounts WHERE lower(username)=lower(?) OR lower(email)=lower(?)').get(username, email)) return res.status(409).json({ message: 'Ese usuario o correo ya existe.' });
  try {
    const info = usersDb.prepare(`INSERT INTO accounts (username,email,password_hash,password_plain,role,role_label,status,city,full_name,phone,restaurant_id) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      .run(username, email, bcrypt.hashSync(req.body.password || 'quick2026', 10), req.body.password || 'quick2026', role, req.body.role_label || (role === 'restaurant_owner' ? 'Dueño asociado' : 'Cajero / Operador de reservas'), 'active', 'Cali', req.body.full_name || username, req.body.phone || '', id);
    res.status(201).json({ message: 'Colaborador creado.', user: serializeAccount(usersDb.prepare('SELECT * FROM accounts WHERE id=?').get(info.lastInsertRowid)) });
  } catch (err) {
    res.status(409).json({ message: 'No se pudo crear colaborador.', detail: err.message });
  }
});

app.patch('/api/restaurant/staff/:id', auth(RESTAURANT_ROLES), restaurantGuard, requireRestaurantFull, (req, res) => {
  const id = getRestaurantId(req);
  const acc = usersDb.prepare('SELECT * FROM accounts WHERE id=? AND restaurant_id=?').get(req.params.id, id);
  if (!acc) return res.status(404).json({ message: 'Colaborador no encontrado.' });
  const updates = []; const values = [];
  if (req.body.username !== undefined) {
    const username = cleanUser(req.body.username);
    const duplicate = usersDb.prepare('SELECT id FROM accounts WHERE lower(username)=lower(?) AND id<>?').get(username, acc.id);
    if (duplicate) return res.status(409).json({ message: 'Ese usuario ya existe.' });
    updates.push('username=?'); values.push(username);
  }
  if (req.body.email !== undefined) {
    const email = cleanUser(req.body.email);
    const duplicate = usersDb.prepare('SELECT id FROM accounts WHERE lower(email)=lower(?) AND id<>?').get(email, acc.id);
    if (duplicate) return res.status(409).json({ message: 'Ese correo ya existe.' });
    updates.push('email=?'); values.push(email);
  }
  ['full_name','phone','role_label','status'].forEach((k) => { if (req.body[k] !== undefined) { updates.push(`${k}=?`); values.push(req.body[k]); } });
  if (req.body.role !== undefined) { const role = req.body.role === 'restaurant_owner' ? 'restaurant_owner' : 'restaurant_staff'; updates.push('role=?'); values.push(role); }
  if (req.body.password) { updates.push('password_hash=?'); values.push(bcrypt.hashSync(String(req.body.password), 10)); updates.push('password_plain=?'); values.push(String(req.body.password)); }
  if (!updates.length) return res.status(400).json({ message: 'No hay cambios.' });
  values.push(acc.id);
  usersDb.prepare(`UPDATE accounts SET ${updates.join(', ')}, updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(...values);
  res.json({ message: 'Colaborador actualizado.', user: serializeAccount(usersDb.prepare('SELECT * FROM accounts WHERE id=?').get(acc.id)) });
});

app.delete('/api/restaurant/staff/:id', auth(RESTAURANT_ROLES), restaurantGuard, requireRestaurantFull, (req, res) => {
  const id = getRestaurantId(req);
  const acc = usersDb.prepare('SELECT * FROM accounts WHERE id=? AND restaurant_id=?').get(req.params.id, id);
  if (!acc) return res.status(404).json({ message: 'Colaborador no encontrado.' });
  if (Number(acc.id) === Number(req.user.id)) return res.status(409).json({ message: 'No puedes eliminar tu propio acceso desde aquí.' });
  usersDb.prepare("UPDATE accounts SET status='inactive', restaurant_id=NULL, updated_at=CURRENT_TIMESTAMP WHERE id=?").run(acc.id);
  res.json({ ok: true, message: 'Acceso eliminado correctamente.' });
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
  const newName = String(req.body.name || item.name || '').trim();
  const duplicate = restaurantsDb.prepare('SELECT id FROM inventory_items WHERE restaurant_id=? AND category=? AND lower(name)=lower(?) AND id<>? AND active=1').get(restaurantId, category, newName, item.id);
  if (duplicate) return res.status(409).json({ message: 'Ya existe otro alimento con ese nombre en la misma categoría.' });
  const isCompletePlate = category === 'complete_plate';
  const isSpecial = isCompletePlate ? 0 : (req.body.is_special ?? item.is_special ? 1 : 0);
  const price = isCompletePlate ? moneyInt(req.body.price ?? item.price) : 0;
  const additionalCost = isSpecial ? moneyInt(req.body.additional_cost ?? item.additional_cost) : 0;
  restaurantsDb.prepare('UPDATE inventory_items SET category=?, name=?, description=?, cost=0, price=?, stock=?, is_special=?, additional_cost=?, image_url=?, image_source=?, active=?, updated_at=CURRENT_TIMESTAMP WHERE id=?')
    .run(category, newName, req.body.description ?? item.description, price, moneyInt(req.body.stock ?? item.stock), isSpecial, additionalCost, req.body.image_url ?? item.image_url, req.body.image_source ?? item.image_source, req.body.active ?? item.active, item.id);
  res.json(restaurantsDb.prepare('SELECT * FROM inventory_items WHERE id=?').get(item.id));
});

app.delete('/api/restaurant/inventory/:id', auth(RESTAURANT_ROLES), restaurantGuard, (req, res) => {
  const item = restaurantsDb.prepare('SELECT * FROM inventory_items WHERE id=?').get(req.params.id);
  if (!item) return res.status(404).json({ message: 'Ítem no encontrado.' });
  const restaurantId = getRestaurantId(req);
  if (Number(item.restaurant_id) !== Number(restaurantId)) return res.status(403).json({ message: 'No autorizado.' });
  restaurantsDb.prepare('UPDATE inventory_items SET active=0, updated_at=CURRENT_TIMESTAMP WHERE id=?').run(item.id);
  res.json({ ok: true, message: 'Elemento eliminado del inventario.' });
});

app.get('/api/restaurant/menus', auth(RESTAURANT_ROLES), restaurantGuard, (req, res) => {
  const id = getRestaurantId(req);
  const menus = restaurantsDb.prepare('SELECT * FROM daily_menus WHERE restaurant_id=? ORDER BY menu_date DESC, id DESC').all(id);
  res.json(menus.map((m) => ({ ...m, items: restaurantsDb.prepare('SELECT * FROM menu_items WHERE menu_id=?').all(m.id).map((x) => ({ ...x, plate: parseJson(x.plate_json) })) })));
});

function saveRestaurantMenu(restaurantId, d = {}) {
  const menuDate = d.menu_date || getToday();
  const existing = restaurantsDb.prepare('SELECT * FROM daily_menus WHERE restaurant_id=? AND menu_date=? ORDER BY id DESC LIMIT 1').get(restaurantId, menuDate);
  let menuId;
  let mode = 'created';
  if (existing) {
    menuId = existing.id;
    mode = 'updated';
    restaurantsDb.prepare('UPDATE daily_menus SET mode=?, title=?, notes=?, base_price=?, sell_soup_separately=?, soup_price=?, sell_tray_separately=?, tray_price=?, max_lunches_per_order=?, status=?, updated_at=CURRENT_TIMESTAMP WHERE id=?')
      .run(d.mode || 'mixed', d.title || 'Menú del día', d.notes || '', moneyInt(d.base_price, 15000), d.sell_soup_separately ? 1 : 0, moneyInt(d.soup_price, 6000), d.sell_tray_separately ? 1 : 0, moneyInt(d.tray_price, 13000), Math.min(10, moneyInt(d.max_lunches_per_order, 10)), d.status || 'published', menuId);
    restaurantsDb.prepare('DELETE FROM menu_items WHERE menu_id=?').run(menuId);
  } else {
    const info = restaurantsDb.prepare('INSERT INTO daily_menus (restaurant_id,menu_date,mode,title,notes,base_price,sell_soup_separately,soup_price,sell_tray_separately,tray_price,max_lunches_per_order,status) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(restaurantId, menuDate, d.mode || 'mixed', d.title || 'Menú del día', d.notes || '', moneyInt(d.base_price, 15000), d.sell_soup_separately ? 1 : 0, moneyInt(d.soup_price, 6000), d.sell_tray_separately ? 1 : 0, moneyInt(d.tray_price, 13000), Math.min(10, moneyInt(d.max_lunches_per_order, 10)), d.status || 'published');
    menuId = info.lastInsertRowid;
  }
  const stmt = restaurantsDb.prepare('INSERT INTO menu_items (menu_id,inventory_item_id,category,name,stock,remaining,price_delta,price,is_special,image_url,plate_json) VALUES (?,?,?,?,?,?,?,?,?,?,?)');
  for (const item of d.items || []) {
    const inv = item.inventory_item_id ? restaurantsDb.prepare('SELECT * FROM inventory_items WHERE id=?').get(item.inventory_item_id) : null;
    const category = item.category || inv?.category || 'complete_plate';
    const isComplete = category === 'complete_plate';
    stmt.run(menuId, item.inventory_item_id || null, category, item.name || inv?.name, moneyInt(item.stock ?? inv?.stock), moneyInt(item.remaining ?? item.stock ?? inv?.stock), isComplete ? 0 : moneyInt(item.price_delta ?? inv?.additional_cost), isComplete ? moneyInt(item.price ?? inv?.price) : 0, isComplete ? 0 : moneyInt(item.is_special ?? inv?.is_special), item.image_url || inv?.image_url || '', jsonString(item.plate || {}));
  }
  return { id: menuId, mode };
}

app.post('/api/restaurant/menus', auth(RESTAURANT_ROLES), restaurantGuard, (req, res) => {
  const restaurantId = getRestaurantId(req);
  const saved = saveRestaurantMenu(restaurantId, req.body);
  res.status(saved.mode === 'created' ? 201 : 200).json({ ...saved, message: saved.mode === 'created' ? 'Menú publicado correctamente.' : 'Menú modificado correctamente.' });
});

app.get('/api/restaurant/orders/live', auth(RESTAURANT_ROLES), restaurantGuard, (req, res) => {
  const id = getRestaurantId(req);
  const date = req.query.date || getToday();
  const rows = coreDb.prepare("SELECT * FROM orders WHERE restaurant_id=? AND substr(pickup_slot,1,10)=? AND status NOT IN ('claimed','cancelled','no_show') ORDER BY pickup_slot ASC, created_at ASC").all(id, date);
  res.json({ groups: groupedOrders(rows), rows: rows.map(serializeOrder) });
});

app.get('/api/restaurant/orders/history', auth(RESTAURANT_ROLES), restaurantGuard, (req, res) => {
  const id = getRestaurantId(req);
  const q = String(req.query.q || '').trim().toLowerCase();
  const status = String(req.query.status || 'all');
  const date = String(req.query.date || '').slice(0,10);
  let rows = coreDb.prepare("SELECT * FROM orders WHERE restaurant_id=? AND status IN ('claimed','cancelled','no_show') ORDER BY completed_at DESC, cancelled_at DESC, pickup_slot DESC, created_at DESC LIMIT 500").all(id).map(serializeOrder);
  if (status !== 'all') rows = rows.filter((o) => o.status === status);
  if (date) rows = rows.filter((o) => String(o.pickup_slot || '').startsWith(date));
  if (q) rows = rows.filter((o) => [o.id, o.customer_name, o.restaurant_name, o.public_code, o.status, o.payment_method].join(' ').toLowerCase().includes(q));
  res.json(rows);
});

app.patch('/api/restaurant/orders/:id/status', auth(RESTAURANT_ROLES), restaurantGuard, (req, res) => {
  const order = coreDb.prepare('SELECT * FROM orders WHERE id=?').get(req.params.id);
  if (!order) return res.status(404).json({ message: 'Pedido no encontrado.' });
  if (Number(order.restaurant_id) !== Number(getRestaurantId(req))) return res.status(403).json({ message: 'No autorizado.' });
  if (order.status === 'claimed') return res.status(409).json({ message: 'Este pedido ya fue reclamado por código. No se puede modificar.' });
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
  const text = String(req.body.qr_text || req.body.delivery_code || '').trim();
  const codeMatch = text.match(/\d{3}-?\d{3}/);
  const publicCode = (codeMatch?.[0] || text).replace(/[^0-9]/g, '').replace(/(\d{3})(\d{3})/, '$1-$2');
  const order = coreDb.prepare('SELECT * FROM orders WHERE restaurant_id=? AND public_code=?').get(getRestaurantId(req), publicCode);
  if (!order) return res.status(404).json({ message: 'Código inválido o pedido no encontrado para este restaurante.' });
  if (Number(order.restaurant_id) !== Number(getRestaurantId(req))) return res.status(403).json({ message: 'Este código pertenece a otro restaurante.' });
  if (order.status === 'claimed') return res.status(409).json({ message: 'Este código ya fue usado y dejó de tener validez.' });
  if (['cancelled','no_show'].includes(order.status)) return res.status(409).json({ message: 'Este pedido no puede reclamarse.' });
  const paymentStatus = order.payment_method === 'cash' ? 'cash_collected_at_counter' : 'paid_released';
  coreDb.prepare("UPDATE orders SET status='claimed', claimed_at=CURRENT_TIMESTAMP, completed_at=CURRENT_TIMESTAMP, payment_status=?, commission_settled=1, settlement_amount=?, delivery_validation_json=?, updated_at=CURRENT_TIMESTAMP WHERE id=?")
    .run(paymentStatus, order.subtotal, jsonString({ validated_by: req.user.username, validated_at: new Date().toISOString(), delivery_code: publicCode }), order.id);
  decrementMenuStockForOrder(order);
  res.json({ message: 'Código validado. Pedido entregado y dinero liberado al restaurante.', order: serializeOrder(coreDb.prepare('SELECT * FROM orders WHERE id=?').get(order.id)) });
});

app.get('/api/restaurant/analytics', auth(RESTAURANT_ROLES), restaurantGuard, requireRestaurantFull, (req, res) => {
  const id = getRestaurantId(req);
  const summary = coreDb.prepare("SELECT COUNT(*) orders, COALESCE(SUM(total),0) processed, COALESCE(SUM(CASE WHEN status='claimed' THEN subtotal ELSE 0 END),0) released, COALESCE(AVG(total),0) avg_ticket FROM orders WHERE restaurant_id=?").get(id);
  const sanctionsTotal = restaurantsDb.prepare('SELECT COALESCE(SUM(tax_amount),0) total FROM restaurant_penalties WHERE restaurant_id=? AND status!="reversed"').get(id).total || 0;
  summary.released = Math.max(0, Number(summary.released || 0) - Number(sanctionsTotal || 0));
  const pendingHeld = coreDb.prepare("SELECT COALESCE(SUM(subtotal),0) held FROM orders WHERE restaurant_id=? AND payment_method='online' AND status NOT IN ('claimed','cancelled')").get(id).held;
  const frequent = coreDb.prepare('SELECT customer_name, COUNT(*) visits, COALESCE(SUM(total),0) spent FROM orders WHERE restaurant_id=? GROUP BY user_id ORDER BY visits DESC LIMIT 10').all(id);
  const salesByDay = coreDb.prepare("SELECT substr(created_at,1,10) day, COUNT(*) orders, COALESCE(SUM(total),0) sales, COALESCE(SUM(CASE WHEN status='claimed' THEN subtotal ELSE 0 END),0) released FROM orders WHERE restaurant_id=? GROUP BY day ORDER BY day DESC LIMIT 21").all(id).reverse();
  const status = coreDb.prepare('SELECT status, COUNT(*) value FROM orders WHERE restaurant_id=? GROUP BY status').all(id);
  const paymentMix = coreDb.prepare('SELECT payment_method name, COUNT(*) value FROM orders WHERE restaurant_id=? GROUP BY payment_method').all(id);
  const dayTraffic = coreDb.prepare("SELECT substr(pickup_slot,1,10) day, COUNT(*) orders FROM orders WHERE restaurant_id=? GROUP BY day ORDER BY orders DESC LIMIT 7").all(id);
  const itemRows = coreDb.prepare('SELECT items_json FROM orders WHERE restaurant_id=?').all(id);
  const counts = {};
  for (const r of itemRows) for (const lunch of parseJson(r.items_json, [])) for (const name of [lunch.label, lunch.type, ...(lunch.components || []).map((c) => c.name), ...(lunch.extras || []).map((c) => c.name)].filter(Boolean)) counts[name] = (counts[name] || 0) + 1;
  const preferences = Object.entries(counts).map(([name, value]) => ({ name, value })).sort((a,b) => b.value - a.value).slice(0, 12);
  const restaurant = serializeRestaurant(restaurantsDb.prepare('SELECT * FROM restaurants WHERE id=?').get(id));
  const penalties = restaurantsDb.prepare('SELECT * FROM restaurant_penalties WHERE restaurant_id=? ORDER BY created_at DESC LIMIT 20').all(id);
  const aiTips = [
    preferences.length ? `Productos más comprados: ${preferences.slice(0,5).map(p=>`${p.name} (${p.value})`).join(', ')}. Úsalos como gancho en la portada o combos.` : 'Aún no hay suficientes compras para detectar productos favoritos.',
    Number(summary.avg_ticket || 0) > 0 ? `Ticket promedio: ${Number(summary.avg_ticket || 0).toLocaleString('es-CO')} COP. Compara este valor contra tu precio base para ajustar especiales.` : 'Publica menú y valida entregas con código para activar análisis de ticket promedio.',
    Number(pendingHeld || 0) > 0 ? `Dinero pendiente de liberar: ${Number(pendingHeld).toLocaleString('es-CO')} COP. La prioridad operativa es entregar y validar códigos.` : 'No hay saldo relevante retenido; puedes concentrarte en crecer demanda.',
    Number(summary.orders || 0) > 0 && dayTraffic[0] ? `Día con mayor concurrencia: ${dayTraffic[0].day} con ${dayTraffic[0].orders} pedidos. Ajusta cupos y stock del menú alrededor de ese comportamiento.` : 'Cuando haya más historial, QuickLunch detectará días fuertes y débiles.'
  ];
  res.json({ summary, pendingHeld, frequent, preferences, restaurant, penalties, salesByDay, status, paymentMix, dayTraffic, aiTips, reportTitle:'Informe integral del restaurante' });
});


app.post('/api/restaurant/coupons', auth(RESTAURANT_ROLES), restaurantGuard, requireRestaurantFull, (req, res) => {
  try {
    const restaurantId = getRestaurantId(req);
    const payload = buildCouponPayload(req, { restaurantId, ownerScope: false });
    const coupon = insertCoupon(payload, req);
    res.status(201).json(serializeCoupon(coupon));
  } catch (err) { res.status(400).json({ message: err.message }); }
});

app.get('/api/restaurant/coupons', auth(RESTAURANT_ROLES), restaurantGuard, (req, res) => {
  res.json(restaurantsDb.prepare('SELECT * FROM coupons WHERE restaurant_id=? ORDER BY created_at DESC').all(getRestaurantId(req)).map(serializeCoupon));
});

app.patch('/api/restaurant/coupons/:id', auth(RESTAURANT_ROLES), restaurantGuard, requireRestaurantFull, (req, res) => {
  const restaurantId = getRestaurantId(req);
  const current = restaurantsDb.prepare('SELECT * FROM coupons WHERE id=? AND restaurant_id=?').get(req.params.id, restaurantId);
  if (!current) return res.status(404).json({ message: 'Cupón o descuento no encontrado en este restaurante.' });
  try { const coupon = updateCoupon(req.params.id, { ...req, body: { ...req.body, coverage_restaurants: [restaurantId], effect_scope: 'restaurant' } }, false); res.json(serializeCoupon(coupon)); }
  catch (err) { res.status(400).json({ message: err.message }); }
});

app.delete('/api/restaurant/coupons/:id', auth(RESTAURANT_ROLES), restaurantGuard, requireRestaurantFull, (req, res) => {
  const restaurantId = getRestaurantId(req);
  const current = restaurantsDb.prepare('SELECT * FROM coupons WHERE id=? AND restaurant_id=?').get(req.params.id, restaurantId);
  if (!current) return res.status(404).json({ message: 'Cupón o descuento no encontrado en este restaurante.' });
  restaurantsDb.prepare('UPDATE coupons SET active=0 WHERE id=?').run(req.params.id);
  res.json({ ok: true, message: 'Beneficio eliminado/inactivado.' });
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ message: 'Error interno de QuickLunch.', detail: err.message });
});

app.listen(PORT, '0.0.0.0', () => console.log(`QuickLunch API corriendo en http://0.0.0.0:${PORT}`));
