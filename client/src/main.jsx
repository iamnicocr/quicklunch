import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Routes, Route, Navigate, Link, useNavigate, useParams } from 'react-router-dom';
import { BarChart3, CheckCircle2, ChefHat, CircleDollarSign, ClipboardList, Clock, Coffee, Edit3, Gift, Home, LayoutDashboard, LogOut, MapPin, MessageCircle, QrCode, Save, Search, ShieldCheck, ShoppingBag, Sparkles, Store, Trash2, UserRound, UsersRound, WalletCards, XCircle } from 'lucide-react';
import { BarChart, Bar, CartesianGrid, XAxis, YAxis, Tooltip, ResponsiveContainer, PieChart, Pie, Cell, Legend } from 'recharts';
import './styles/theme.css';

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:4000/api';
const MAP_URL = import.meta.env.VITE_GOOGLE_MAPS_EMBED_URL || 'https://www.google.com/maps?q=corrientazos%20Cali%20Colombia&output=embed';

function api(path, options = {}) {
  const token = localStorage.getItem('ql_token');
  return fetch(`${API_URL}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.headers || {})
    }
  }).then(async (res) => {
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.message || 'Error QuickLunch');
    return data;
  });
}

function money(v) {
  return new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 }).format(Number(v || 0));
}



const CATEGORY_LABELS = {
  protein: 'Proteína',
  principle: 'Principio',
  side: 'Acompañamiento',
  drink: 'Jugo o bebida',
  dessert: 'Postre',
  extra: 'Extra',
  complete_plate: 'Plato armado'
};

const STATUS_LABELS = {
  active: 'Activo', inactive: 'Inactivo', banned: 'Bloqueado', pending: 'Pendiente', approved: 'Aprobado', rejected: 'Rechazado',
  reserved: 'Reservado', preparing: 'En preparación', ready: 'Listo', claimed: 'Reclamado', delayed: 'En demora', cancelled: 'Cancelado', no_show: 'No reclamado'
};

const MODE_LABELS = { customizable: 'Personalizable recomendado', fixed_plates: 'Platos armados', mixed: 'Mixto' };
const BASE_LUNCH_PRICE = 15000;

const FIELD_LABELS = {
  name: 'Nombre comercial del restaurante', slug: 'Ruta pública del restaurante', city: 'Ciudad', address: 'Dirección completa', phone: 'Teléfono', email: 'Correo de contacto',
  owner_name: 'Nombre del dueño', owner_document: 'Documento del dueño', legal_representative: 'Representante legal', nit: 'NIT o identificación tributaria',
  chamber_commerce: 'Matrícula mercantil / Registro en Cámara de Comercio', rut: 'RUT actualizado', sanitary_concept: 'Concepto sanitario o soporte sanitario',
  firefighter_certificate: 'Certificado de Bomberos / seguridad humana', land_use_concept: 'Concepto de uso del suelo', police_opening_notice: 'Aviso de apertura a la autoridad cuando aplique',
  food_handler_certificates: 'Soportes de manipulación de alimentos', personal_data_policy_url: 'Política de tratamiento de datos personales', association_valid_until: 'Vigencia de asociación con QuickLunch',
  manager_username: 'Usuario del gestor del restaurante', manager_password: 'Contraseña del gestor', manager_full_name: 'Nombre completo del gestor', manager_email: 'Correo del gestor'
};

const FIELD_PLACEHOLDERS = {
  name: 'Ej: Corrientazos La 5ta', slug: 'Ej: corrientazos-la-5ta', city: 'Cali', address: 'Ej: Cra. 5 #12-34, San Nicolás, Cali', phone: 'Ej: 3001234567', email: 'Ej: restaurante@email.com',
  owner_name: 'Ej: María Fernanda Gómez', owner_document: 'Ej: CC 1.144.000.000', legal_representative: 'Ej: María Fernanda Gómez', nit: 'Ej: 901234567-8',
  chamber_commerce: 'Ej: Matrícula mercantil No. 123456 de Cali', rut: 'Ej: RUT actualizado PDF / código interno', sanitary_concept: 'Ej: Concepto sanitario favorable 2026',
  firefighter_certificate: 'Ej: Certificado Bomberos Cali vigente', land_use_concept: 'Ej: Uso permitido para restaurante', police_opening_notice: 'Ej: Aviso radicado o no aplica',
  food_handler_certificates: 'Ej: 3 certificados del personal de cocina', personal_data_policy_url: 'Ej: https://restaurante.com/politica-datos', association_valid_until: 'Ej: 2026-12-31',
  manager_username: 'Ej: la5ta_admin', manager_password: 'Mínimo 6 caracteres', manager_full_name: 'Ej: Juan Pérez - cajero principal', manager_email: 'Ej: gestor@email.com'
};

function label(key) { return FIELD_LABELS[key] || key.replaceAll('_', ' '); }
function placeholder(key) { return FIELD_PLACEHOLDERS[key] || 'Escribe la información solicitada'; }
function categoryLabel(key) { return CATEGORY_LABELS[key] || key; }
function statusLabel(key) { return STATUS_LABELS[key] || key; }
function modeLabel(key) { return MODE_LABELS[key] || key; }
function inputType(key) { return key.includes('password') ? 'password' : key.includes('email') ? 'email' : key.includes('until') ? 'date' : 'text'; }
function itemExtra(item) { return Number(item.price_delta ?? item.additional_cost ?? item.price ?? 0); }

function useAuth() {
  const [account, setAccount] = useState(() => JSON.parse(localStorage.getItem('ql_account') || 'null'));
  const save = (payload) => {
    localStorage.setItem('ql_token', payload.token);
    localStorage.setItem('ql_account', JSON.stringify(payload.account));
    setAccount(payload.account);
  };
  const logout = () => { localStorage.removeItem('ql_token'); localStorage.removeItem('ql_account'); setAccount(null); };
  return { account, save, logout };
}

function Logo({ compact = false }) {
  return <div className="logo"><span className="logo-mark"><ChefHat size={compact ? 18 : 22} /></span><span>{compact ? 'QL' : 'QuickLunch'}</span></div>;
}

function Toast({ message, type = 'info', onClose }) {
  if (!message) return null;
  return <div className={`toast ${type}`} onClick={onClose}>{message}</div>;
}

function CityGate({ value, setValue }) {
  const [toast, setToast] = useState('');
  const change = (e) => {
    const next = e.target.value;
    if (next !== 'Cali') { setToast('Ciudad próximamente disponible'); return; }
    setValue(next);
  };
  return <>
    <label className="field compact"><span>Ciudad activa</span><select value={value} onChange={change}><option>Cali</option><option>Pasto</option><option>Bogotá</option></select></label>
    <Toast message={toast} type="warning" onClose={() => setToast('')} />
  </>;
}

function LoginCard({ role, title, subtitle, onLogged, allowRegister = false }) {
  const [city, setCity] = useState('Cali');
  const [form, setForm] = useState({ username: 'nicocr', password: 'quick2026' });
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const submit = async (e) => {
    e.preventDefault(); setError(''); setLoading(true);
    try {
      const payload = await api('/auth/login', { method: 'POST', body: JSON.stringify({ ...form, city }) });
      if (role && payload.account.role !== role && payload.account.role !== 'admin') throw new Error(`Esta entrada no corresponde al perfil seleccionado.`);
      onLogged(payload);
    } catch (err) { setError(err.message); } finally { setLoading(false); }
  };
  return <section className="login-shell">
    <div className="login-card card glass">
      <Logo />
      <h1>{title}</h1>
      <p>{subtitle}</p>
      <CityGate value={city} setValue={setCity} />
      <form onSubmit={submit} className="form-grid">
        <label className="field"><span>Usuario o correo</span><input value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} /></label>
        <label className="field"><span>Contraseña</span><input type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} /></label>
        {error && <p className="error-msg">{error}</p>}
        <button className="primary-btn" disabled={loading}>{loading ? 'Ingresando...' : 'Ingresar'}</button>
      </form>
      {allowRegister && <p className="muted center">¿Restaurante nuevo? Usa la pestaña de registro para enviar la solicitud legal.</p>}
    </div>
  </section>;
}

function MapPanel({ restaurants = [], compact = false }) {
  return <div className={`map-panel ${compact ? 'compact-map' : ''}`}>
    <iframe title="Mapa Google QuickLunch Cali" src={MAP_URL} loading="lazy" />
    <div className="map-overlay">
      <strong><MapPin size={16} /> Cali</strong>
      <span>{restaurants.length} restaurantes aliados activos</span>
    </div>
  </div>;
}

function StatCard({ icon: Icon, label, value, hint }) {
  return <div className="stat-card"><Icon size={22} /><div><span>{label}</span><strong>{value}</strong>{hint && <small>{hint}</small>}</div></div>;
}

function Shell({ children, nav, account, logout, mode = 'desktop' }) {
  return <div className={`app-shell ${mode}`}>
    <aside className="sidebar"><Logo /><nav>{nav.map((item) => <Link key={item.to} to={item.to}><item.icon size={18} /> {item.label}</Link>)}</nav><button className="ghost-btn" onClick={logout}><LogOut size={18} /> Cerrar sesión</button></aside>
    <main className="content-area"><header className="topbar"><div><p>Hola, {account?.full_name || account?.username}</p><h2>{account?.role === 'admin' ? 'Panel administrativo total' : 'Gestión del restaurante'}</h2></div><span className="role-pill">{account?.role === 'admin' ? 'Administrador' : account?.role === 'restaurant' ? 'Restaurante' : 'Cliente'}</span></header>{children}</main>
  </div>;
}

function AdminApp() {
  const auth = useAuth();
  if (!auth.account || !['admin'].includes(auth.account.role)) return <LoginCard role="admin" title="Administración QuickLunch" subtitle="Acceso privado para gestionar Cali, restaurantes, usuarios, soporte, pagos y operación." onLogged={auth.save} />;
  const nav = [
    { to: '/admin', icon: LayoutDashboard, label: 'Inicio' }, { to: '/admin/restaurantes', icon: Store, label: 'Restaurantes' }, { to: '/admin/solicitudes', icon: ClipboardList, label: 'Solicitudes' }, { to: '/admin/usuarios', icon: UsersRound, label: 'Usuarios' }, { to: '/admin/analitica', icon: BarChart3, label: 'Analítica' }, { to: '/admin/soporte', icon: MessageCircle, label: 'Soporte' }
  ];
  return <Shell nav={nav} account={auth.account} logout={auth.logout}>
    <Routes>
      <Route index element={<AdminDashboard />} />
      <Route path="restaurantes" element={<AdminRestaurants />} />
      <Route path="solicitudes" element={<AdminApplications />} />
      <Route path="usuarios" element={<AdminUsers />} />
      <Route path="analitica" element={<AdminAnalytics />} />
      <Route path="soporte" element={<SupportPanel />} />
    </Routes>
  </Shell>;
}

function AdminDashboard() {
  const [data, setData] = useState(null);
  const [restaurants, setRestaurants] = useState([]);
  useEffect(() => { api('/admin/dashboard').then(setData); api('/admin/restaurants').then(setRestaurants); }, []);
  if (!data) return <p>Cargando panel...</p>;
  return <div className="page-grid">
    <section className="hero-card"><div><span className="eyebrow">Cali · operación inicial</span><h1>Control central de QuickLunch</h1><p>Visualiza restaurantes, usuarios, ingresos, solicitudes legales y la operación QR desde un único panel.</p></div><CityPreview /></section>
    <div className="stats-grid"><StatCard icon={Store} label="Restaurantes" value={data.restaurants} /><StatCard icon={UsersRound} label="Usuarios" value={data.users} /><StatCard icon={ClipboardList} label="Solicitudes" value={data.pendingApplications} /><StatCard icon={CircleDollarSign} label="Ingresos procesados" value={money(data.revenue)} /></div>
    <section className="card two-col"><div><h3>Mapa de corrientazos aliados</h3><MapPanel restaurants={restaurants} /></div><div><h3>Modelo QuickLunch</h3><ul className="check-list"><li>Prepago: tarifa app {money(data.settings.fees.online)}</li><li>Pago en local: tarifa app {money(data.settings.fees.cash)}</li><li>Cupos cada {data.settings.pickup.intervalMinutes} minutos</li><li>QR obligatorio: no entrega sin escaneo</li><li>Ventana de recogida máxima: {data.settings.pickup.maxWindowMinutes} minutos</li></ul></div></section>
    <section className="card"><h3>Restaurantes con más movimiento</h3><div className="table-wrap"><table><thead><tr><th>Restaurante</th><th>Pedidos</th><th>Ventas</th></tr></thead><tbody>{data.topRestaurants.map((r, i) => <tr key={i}><td>{r.restaurant_name || 'Sin datos'}</td><td>{r.orders}</td><td>{money(r.sales)}</td></tr>)}</tbody></table></div></section>
  </div>;
}

function CityPreview() {
  const [city, setCity] = useState('Cali');
  return <div className="mini-panel"><CityGate value={city} setValue={setCity} /><p>Cali está habilitada. Pasto y Bogotá quedan visibles como expansión futura.</p></div>;
}

function AdminRestaurants() {
  const editableFields = ['name','slug','address','phone','email','owner_name','owner_document','legal_representative','nit','chamber_commerce','rut','sanitary_concept','firefighter_certificate','land_use_concept','police_opening_notice','food_handler_certificates','personal_data_policy_url','association_valid_until','status'];
  const createFields = ['name','slug','address','phone','email','owner_name','owner_document','legal_representative','nit','chamber_commerce','rut','sanitary_concept','firefighter_certificate','land_use_concept','police_opening_notice','food_handler_certificates','personal_data_policy_url','association_valid_until','manager_username','manager_password','manager_full_name','manager_email'];
  const empty = Object.fromEntries(createFields.map((f) => [f, f === 'status' ? 'active' : '']));
  const [restaurants, setRestaurants] = useState([]);
  const [form, setForm] = useState(empty);
  const [editing, setEditing] = useState(null);
  const [msg, setMsg] = useState('');
  const load = () => api('/admin/restaurants').then(setRestaurants);
  useEffect(load, []);
  const create = async (e) => {
    e.preventDefault(); setMsg('');
    try { await api('/admin/restaurants', { method: 'POST', body: JSON.stringify(form) }); setForm(empty); setMsg('Restaurante creado con su gestor.'); load(); }
    catch (err) { setMsg(err.message); }
  };
  const beginEdit = (restaurant) => setEditing({ id: restaurant.id, ...Object.fromEntries(editableFields.map((f) => [f, restaurant[f] || ''])) });
  const saveEdit = async () => {
    if (!editing?.id) return;
    try { await api(`/admin/restaurants/${editing.id}`, { method: 'PATCH', body: JSON.stringify(editing) }); setMsg('Datos del restaurante actualizados.'); setEditing(null); load(); }
    catch (err) { setMsg(err.message); }
  };
  const remove = async (restaurant) => {
    const ok = window.confirm(`¿Eliminar ${restaurant.name}? Esta acción borra inventario, menús, cupones, pedidos demo y desactiva sus gestores.`);
    if (!ok) return;
    try { await api(`/admin/restaurants/${restaurant.id}`, { method: 'DELETE' }); setMsg('Restaurante eliminado correctamente.'); load(); }
    catch (err) { setMsg(err.message); }
  };
  return <div className="page-grid">
    <section className="card">
      <h2>Gestión total de restaurantes</h2>
      <p>Consulta, modifica o elimina restaurantes aliados. Este panel controla datos legales, ubicación, gestores, vigencia, estado y métricas.</p>
      {msg && <p className="success-msg">{msg}</p>}
      <div className="table-wrap"><table><thead><tr><th>Restaurante</th><th>Ruta</th><th>Dueño</th><th>Pedidos</th><th>Ventas</th><th>Estado</th><th>Acciones</th></tr></thead><tbody>{restaurants.map((r) => <tr key={r.id}><td>{r.name}<br/><small>{r.address}</small></td><td>/{r.slug}</td><td>{r.owner_name || 'Sin dueño registrado'}</td><td>{r.metrics?.orders || 0}</td><td>{money(r.metrics?.sales || 0)}</td><td><span className="status ok">{statusLabel(r.status)}</span></td><td><button className="tiny-btn" onClick={() => beginEdit(r)}><Edit3 size={14}/> Editar</button><button className="tiny-btn" onClick={() => remove(r)}><Trash2 size={14}/> Eliminar</button></td></tr>)}</tbody></table></div>
    </section>
    {editing && <section className="card"><h3>Modificar datos de restaurante</h3><p>Los campos vacíos conservan claridad con ejemplos. El slug define la ruta pública: <strong>/{editing.slug || 'restaurante'}</strong>.</p><div className="form-grid columns">{editableFields.map((k) => <label className="field" key={k}><span>{label(k)}</span>{k === 'status' ? <select value={editing[k]} onChange={(e) => setEditing({ ...editing, [k]: e.target.value })}><option value="active">Activo</option><option value="inactive">Inactivo</option></select> : <input type={inputType(k)} placeholder={placeholder(k)} value={editing[k] || ''} onChange={(e) => setEditing({ ...editing, [k]: e.target.value })} />}</label>)}<button className="primary-btn" onClick={saveEdit}><Save size={16}/> Guardar cambios</button><button className="ghost-btn" onClick={() => setEditing(null)}>Cancelar</button></div></section>}
    <section className="card"><h3>Crear restaurante manualmente</h3><p>Usa este formulario cuando QuickLunch registre directamente un restaurante sin pasar por solicitud pública.</p><form className="form-grid columns" onSubmit={create}>{createFields.map((k) => <label className="field" key={k}><span>{label(k)}</span><input type={inputType(k)} placeholder={placeholder(k)} value={form[k] || ''} onChange={(e) => setForm({ ...form, [k]: e.target.value })} /></label>)}<button className="primary-btn">Crear restaurante y gestor</button></form></section>
  </div>;
}

function AdminApplications() {
  const [apps, setApps] = useState([]); const [msg, setMsg] = useState('');
  const load = () => api('/admin/applications').then(setApps);
  useEffect(load, []);
  const review = async (id, decision) => {
    try { await api(`/admin/applications/${id}/review`, { method: 'POST', body: JSON.stringify({ decision, notes: decision === 'approved' ? 'Documentación aprobada para demo.' : 'Documentación incompleta.' }) }); setMsg(`Solicitud ${decision === 'approved' ? 'aprobada' : 'rechazada'}.`); load(); }
    catch (err) { setMsg(err.message); }
  };
  return <section className="card"><h2>Aprobación legal de restaurantes</h2><p>Revisa documentos y datos enviados antes de activar el perfil en QuickLunch.</p>{msg && <p className="success-msg">{msg}</p>}<div className="cards-list">{apps.map((a) => <article className="application-card" key={a.id}><div><h3>{a.legal.name}</h3><p>{a.legal.address} · {a.legal.email}</p><small>NIT: {a.legal.nit || 'por validar'} · Matrícula mercantil: {a.legal.chamber_commerce || 'por validar'} · RUT: {a.legal.rut || 'por validar'}</small><ul className="mini-tags"><li>Sanitario: {a.legal.sanitary_concept || 'por validar'}</li><li>Bomberos: {a.legal.firefighter_certificate || 'por validar'}</li><li>Uso del suelo: {a.legal.land_use_concept || 'por validar'}</li></ul></div><span className={`status ${a.status === 'pending' ? 'warn' : 'ok'}`}>{statusLabel(a.status)}</span>{a.status === 'pending' && <div className="row-actions"><button className="primary-btn" onClick={() => review(a.id, 'approved')}><CheckCircle2 size={16} /> Aprobar</button><button className="danger-btn" onClick={() => review(a.id, 'rejected')}><XCircle size={16} /> Rechazar</button></div>}</article>)}</div></section>;
}

function AdminUsers() {
  const [users, setUsers] = useState([]); const [msg, setMsg] = useState('');
  const load = () => api('/admin/users').then(setUsers);
  useEffect(load, []);
  const patch = async (id, body) => { await api(`/admin/users/${id}`, { method: 'PATCH', body: JSON.stringify(body) }); setMsg('Usuario actualizado.'); load(); };
  return <section className="card"><h2>Gestión de usuarios</h2><p>Datos no sensibles, actividad, pedidos, gastos, reportes, saldo, cupones y bloqueos.</p>{msg && <p className="success-msg">{msg}</p>}<div className="table-wrap"><table><thead><tr><th>Usuario</th><th>Rol</th><th>Correo</th><th>Pedidos</th><th>Gasto</th><th>Reportes</th><th>Saldo</th><th>Estado</th><th>Acciones</th></tr></thead><tbody>{users.map((u) => <tr key={u.id}><td>{u.full_name || u.username}<br/><small>@{u.username}</small></td><td>{u.role === 'customer' ? 'Cliente' : u.role === 'restaurant' ? 'Restaurante' : 'Administrador'}</td><td>{u.email}</td><td>{u.metrics?.orders || 0}</td><td>{money(u.metrics?.spent || 0)}</td><td>{u.metrics?.reports || 0}</td><td>{money(u.wallet_balance)}</td><td>{statusLabel(u.status)}</td><td><button className="tiny-btn" onClick={() => patch(u.id, { status: u.status === 'active' ? 'banned' : 'active' })}>{u.status === 'active' ? 'Banear' : 'Activar'}</button><button className="tiny-btn" onClick={() => patch(u.id, { wallet_balance: Number(u.wallet_balance || 0) + 5000 })}>+Saldo</button></td></tr>)}</tbody></table></div></section>;
}

function AdminAnalytics() {
  const [data, setData] = useState(null);
  useEffect(() => { api('/admin/analytics').then(setData); }, []);
  if (!data) return <p>Cargando analítica...</p>;
  return <div className="page-grid"><section className="card chart-card"><h2>Ventas por día</h2><ResponsiveContainer width="100%" height={280}><BarChart data={data.salesByDay}><CartesianGrid strokeDasharray="3 3" /><XAxis dataKey="day" /><YAxis /><Tooltip formatter={(v) => money(v)} /><Bar dataKey="sales" radius={[8,8,0,0]} /></BarChart></ResponsiveContainer></section><section className="card chart-card"><h2>Métodos de pago</h2><ResponsiveContainer width="100%" height={260}><PieChart><Pie data={data.payments} dataKey="value" nameKey="name" outerRadius={90} label /><Tooltip /><Legend /></PieChart></ResponsiveContainer></section></div>;
}

function SupportPanel() {
  const [threads, setThreads] = useState([]);
  useEffect(() => { api('/support/threads').then(setThreads).catch(() => setThreads([])); }, []);
  return <section className="card"><h2>Centro de soporte</h2><p>Conecta usuario, restaurante y QuickLunch para resolver conflictos de pagos, QR, demoras o cancelaciones.</p><div className="cards-list">{threads.map((t) => <article className="application-card" key={t.id}><MessageCircle /><div><h3>{t.subject}</h3><p>Orden #{t.order_id || 'N/A'} · Restaurante #{t.restaurant_id || 'N/A'}</p><small>{t.status} · {t.created_at}</small></div></article>)}{!threads.length && <p className="muted">No hay tickets todavía.</p>}</div></section>;
}

function RestaurantApp() {
  const auth = useAuth();
  const { slug } = useParams();
  const [tab, setTab] = useState('login');
  if (!auth.account || !['restaurant','admin'].includes(auth.account.role)) return <section className="split-auth"><div className="brand-panel"><Logo /><h1>Portal del restaurante</h1><p>Gestiona inventario, menú del día, pedidos en vivo, estadísticas, cupones y la apariencia pública de tu perfil.</p><p className="muted">Ruta actual: /{slug}</p></div><div><div className="tab-switch"><button className={tab==='login'?'active':''} onClick={() => setTab('login')}>Ingreso</button><button className={tab==='registro'?'active':''} onClick={() => setTab('registro')}>Registro legal</button></div>{tab === 'login' ? <LoginCard role="restaurant" title="Ingreso restaurante" subtitle="Solo gestores previamente aprobados por QuickLunch." onLogged={auth.save} allowRegister /> : <RestaurantApplyForm />}</div></section>;
  const nav = [ { to: `/${slug}`, icon: LayoutDashboard, label: 'Inicio' }, { to: `/${slug}/inventario`, icon: ClipboardList, label: 'Inventario' }, { to: `/${slug}/menu`, icon: Coffee, label: 'Menú del día' }, { to: `/${slug}/pedidos`, icon: QrCode, label: 'Reservas en vivo' }, { to: `/${slug}/perfil`, icon: Sparkles, label: 'Personalización' }, { to: `/${slug}/soporte`, icon: MessageCircle, label: 'Soporte' } ];
  return <Shell nav={nav} account={auth.account} logout={auth.logout}><Routes><Route index element={<RestaurantDashboard />} /><Route path="inventario" element={<InventoryPage />} /><Route path="menu" element={<MenuPage />} /><Route path="pedidos" element={<LiveOrders />} /><Route path="perfil" element={<ProfileDesigner />} /><Route path="soporte" element={<SupportPanel />} /></Routes></Shell>;
}

function RestaurantApplyForm() {
  const fields = ['name','owner_name','owner_document','legal_representative','nit','chamber_commerce','rut','sanitary_concept','firefighter_certificate','land_use_concept','police_opening_notice','food_handler_certificates','personal_data_policy_url','address','phone','email','manager_username','manager_password','manager_full_name'];
  const [form, setForm] = useState(Object.fromEntries(fields.map((f) => [f, '']))); const [msg, setMsg] = useState('');
  const submit = async (e) => { e.preventDefault(); setMsg(''); try { await api('/restaurants/apply', { method: 'POST', body: JSON.stringify({ ...form, city: 'Cali' }) }); setMsg('Solicitud enviada a QuickLunch. El administrador puede aprobarla desde /admin/solicitudes.'); } catch (err) { setMsg(err.message); } };
  return <form className="card form-grid columns" onSubmit={submit}><h2>Registro formal del restaurante</h2><p>Incluye información legal, sanitaria y operativa. Cada casilla tiene un ejemplo para evitar dudas.</p>{fields.map((f) => <label className="field" key={f}><span>{label(f)}</span><input type={inputType(f)} placeholder={placeholder(f)} value={form[f]} onChange={(e) => setForm({ ...form, [f]: e.target.value })} /></label>)}<button className="primary-btn">Enviar solicitud</button>{msg && <p className="success-msg">{msg}</p>}</form>;
}

function RestaurantDashboard() {
  const [data, setData] = useState(null);
  useEffect(() => { api('/restaurant/analytics').then(setData); }, []);
  if (!data) return <p>Cargando restaurante...</p>;
  return <div className="page-grid"><section className="hero-card"><div><span className="eyebrow">Operación restaurante</span><h1>Tu corrientazo, más rápido y medible</h1><p>QuickLunch te ayuda a preparar antes, reducir filas y entender qué piden tus clientes frecuentes.</p></div><ChefHat size={86} /></section><div className="stats-grid"><StatCard icon={ShoppingBag} label="Pedidos" value={data.summary.orders} /><StatCard icon={CircleDollarSign} label="Ventas" value={money(data.summary.sales)} /><StatCard icon={WalletCards} label="Ticket promedio" value={money(data.summary.avg_ticket)} /></div><section className="card"><h3>Recomendaciones IA para el restaurante</h3><ul className="check-list">{data.aiTips.map((t) => <li key={t}>{t}</li>)}</ul></section><section className="card"><h3>Clientes frecuentes</h3><div className="table-wrap"><table><thead><tr><th>Cliente</th><th>Visitas</th><th>Gasto</th></tr></thead><tbody>{data.frequent.map((c, i) => <tr key={i}><td>{c.customer_name}</td><td>{c.visits}</td><td>{money(c.spent)}</td></tr>)}</tbody></table></div></section></div>;
}

function InventoryPage() {
  const empty = { category: 'protein', name: '', description: '', stock: 10, is_special: false, additional_cost: 0, price: 0 };
  const [items, setItems] = useState([]);
  const [form, setForm] = useState(empty);
  const [msg, setMsg] = useState('');
  const load = () => api('/restaurant/inventory').then(setItems);
  useEffect(load, []);
  const isPlate = form.category === 'complete_plate';
  const submit = async (e) => {
    e.preventDefault(); setMsg('');
    try { await api('/restaurant/inventory', { method: 'POST', body: JSON.stringify(form) }); setForm(empty); setMsg('Elemento agregado al inventario.'); load(); }
    catch (err) { setMsg(err.message); }
  };
  return <div className="page-grid">
    <section className="card"><h2>Creación de inventario</h2><p>Agrega opciones que luego usarás en el menú del día. Las proteínas, principios, acompañamientos y jugos no tienen precio individual; solo se marca costo adicional si son especiales. Los platos armados sí tienen precio propio.</p>{msg && <p className="success-msg">{msg}</p>}<form className="form-grid columns" onSubmit={submit}>
      <label className="field"><span>Tipo de comida</span><select value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value, is_special: false, additional_cost: 0, price: 0 })}>{Object.entries(CATEGORY_LABELS).map(([value, text]) => <option value={value} key={value}>{text}</option>)}</select></label>
      <label className="field"><span>Nombre</span><input placeholder="Ej: Tilapia, lenteja, patacón, jugo de mora" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
      <label className="field"><span>Stock sugerido para menú</span><input type="number" min="0" placeholder="Ej: 10" value={form.stock} onChange={(e) => setForm({ ...form, stock: Number(e.target.value) })} /></label>
      {isPlate ? <label className="field"><span>Precio del plato armado</span><input type="number" min="0" placeholder="Ej: 20000" value={form.price} onChange={(e) => setForm({ ...form, price: Number(e.target.value) })} /></label> : <label className="check"><input type="checkbox" checked={form.is_special} onChange={(e) => setForm({ ...form, is_special: e.target.checked, additional_cost: e.target.checked ? form.additional_cost : 0 })} /> Marcar como especial con costo adicional</label>}
      {!isPlate && form.is_special && <label className="field"><span>Costo adicional</span><input type="number" min="0" placeholder="Ej: 5000 si tilapia sube de 15.000 a 20.000" value={form.additional_cost} onChange={(e) => setForm({ ...form, additional_cost: Number(e.target.value) })} /></label>}
      <label className="field"><span>Descripción opcional</span><input placeholder="Ej: opción del menú normal o especial" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></label>
      <button className="primary-btn">Agregar al inventario</button>
    </form></section>
    <section className="card"><h3>Inventario disponible</h3><div className="cards-list compact">{items.map((i) => <article className="menu-chip" key={i.id}><strong>{i.name}</strong><span>{categoryLabel(i.category)}</span><small>Stock sugerido: {i.stock || 0}</small>{i.category === 'complete_plate' ? <small>Precio: {money(i.price)}</small> : Number(i.is_special) ? <small>Especial: +{money(i.additional_cost)}</small> : <small>Menú normal: sin costo adicional</small>}</article>)}</div></section>
  </div>;
}

function MenuPage() {
  const [inventory, setInventory] = useState([]);
  const [menus, setMenus] = useState([]);
  const [selected, setSelected] = useState([]);
  const [mode, setMode] = useState('customizable');
  const [basePrice, setBasePrice] = useState(BASE_LUNCH_PRICE);
  const [msg, setMsg] = useState('');
  const load = () => { api('/restaurant/inventory').then(setInventory); api('/restaurant/menus').then(setMenus); };
  useEffect(load, []);
  const toggle = (item) => {
    setSelected((prev) => prev.find((x) => x.inventory_item_id === item.id)
      ? prev.filter((x) => x.inventory_item_id !== item.id)
      : [...prev, { inventory_item_id: item.id, category: item.category, name: item.name, stock: item.stock || 10, remaining: item.stock || 10, price_delta: item.category === 'complete_plate' ? Number(item.price || 0) : Number(item.is_special ? item.additional_cost : 0), plate: { is_special: Boolean(item.is_special), base_price: basePrice, fixed_plate_price: Number(item.price || 0) } }]);
  };
  const updateSelected = (id, patch) => setSelected((prev) => prev.map((x) => x.inventory_item_id === id ? { ...x, ...patch, remaining: patch.stock ?? x.remaining } : x));
  const publish = async () => {
    setMsg('');
    if (!selected.length) { setMsg('Selecciona al menos un elemento del inventario.'); return; }
    await api('/restaurant/menus', { method: 'POST', body: JSON.stringify({ menu_date: new Date().toISOString().slice(0,10), mode, title: 'Menú del día QuickLunch', notes: `Precio base personalizable: ${basePrice}`, status: 'published', items: selected.map((x) => ({ ...x, plate: { ...(x.plate || {}), base_price: basePrice } })) }) });
    setSelected([]); setMsg('Menú publicado correctamente.'); load();
  };
  return <div className="page-grid"><section className="card"><h2>Menú del día</h2><p>Recomendación QuickLunch: publicar menú personalizable. El usuario paga el precio base del corrientazo y solo suma costos adicionales si elige una opción especial. Si publicas platos armados, cada plato usa su precio propio.</p>{msg && <p className="success-msg">{msg}</p>}<div className="form-grid columns"><label className="field compact"><span>Modo de publicación</span><select value={mode} onChange={(e) => setMode(e.target.value)}><option value="customizable">Personalizable recomendado</option><option value="fixed_plates">Platos armados</option><option value="mixed">Mixto</option></select></label><label className="field compact"><span>Precio base del corrientazo personalizable</span><input type="number" min="0" value={basePrice} onChange={(e) => setBasePrice(Number(e.target.value))} /></label></div><div className="cards-list compact">{inventory.map((item) => { const chosen = selected.find((x) => x.inventory_item_id === item.id); return <button type="button" className={`menu-chip ${chosen ? 'selected' : ''}`} key={item.id} onClick={() => toggle(item)}><strong>{item.name}</strong><span>{categoryLabel(item.category)}</span>{item.category === 'complete_plate' ? <small>Precio propio: {money(item.price)}</small> : Number(item.is_special) ? <small>Especial: +{money(item.additional_cost)}</small> : <small>Menú normal: +{money(0)}</small>}<small>Stock sugerido: {item.stock || 10}</small></button>; })}</div>{selected.length > 0 && <section className="card"><h3>Stock de lo que publicarás hoy</h3><div className="form-grid columns">{selected.map((x) => <label className="field" key={x.inventory_item_id}><span>{x.name} · {categoryLabel(x.category)}</span><input type="number" min="0" value={x.stock} onChange={(e) => updateSelected(x.inventory_item_id, { stock: Number(e.target.value) })} /></label>)}</div></section>}<button className="primary-btn" onClick={publish}>Publicar menú de hoy</button></section><section className="card"><h3>Menús publicados</h3>{menus.map((m) => <article className="application-card" key={m.id}><Coffee /><div><h3>{m.title}</h3><p>{m.menu_date} · {modeLabel(m.mode)} · {statusLabel(m.status)}</p><small>{m.items?.map((i) => `${i.name}${itemExtra(i) ? ` (+${money(itemExtra(i))})` : ''}`).join(', ')}</small></div></article>)}</section></div>;
}

function LiveOrders() {
  const [orders, setOrders] = useState([]);
  const load = () => api('/restaurant/orders/live').then(setOrders);
  useEffect(() => { load(); const timer = setInterval(load, 5000); return () => clearInterval(timer); }, []);
  const status = async (id, value) => { await api(`/restaurant/orders/${id}/status`, { method: 'PATCH', body: JSON.stringify({ status: value }) }); load(); };
  return <section className="card"><h2>Simulación de reservas en vivo</h2><p>Debe mantenerse abierta en hora pico. Los pedidos entran por orden y permiten preparar antes de la llegada del cliente.</p><div className="kanban">{orders.map((o) => <article className="order-card" key={o.id}><div className="order-top"><strong>{o.public_code}</strong><span className={`status ${o.status}`}>{statusLabel(o.status)}</span></div><p><Clock size={15} /> {o.pickup_slot}</p><p><UserRound size={15} /> {o.customer_name}</p><ul>{o.items.map((i, idx) => <li key={idx}>{i.name || i.category}</li>)}</ul><div className="row-actions"><button onClick={() => status(o.id, 'preparing')}>Preparación</button><button onClick={() => status(o.id, 'ready')}>Listo</button><button onClick={() => status(o.id, 'claimed')}>QR reclamado</button><button onClick={() => status(o.id, 'delayed')}>Demora</button><button onClick={() => status(o.id, 'cancelled')}>Cancelar</button></div></article>)}</div>{!orders.length && <p className="muted">Aún no hay pedidos para este restaurante.</p>}</section>;
}

function ProfileDesigner() {
  const [me, setMe] = useState(null); const [profile, setProfile] = useState({ bio: '', cover: '', accent: '#ff7a1a' }); const [msg, setMsg] = useState('');
  useEffect(() => { api('/restaurant/me').then((r) => { setMe(r.restaurant); setProfile({ bio: r.restaurant?.profile?.bio || '', cover: r.restaurant?.profile?.cover || '', accent: r.restaurant?.design?.accent || '#ff7a1a' }); }); }, []);
  const save = async () => { await api('/restaurant/profile', { method: 'PUT', body: JSON.stringify({ profile: { bio: profile.bio, cover: profile.cover }, design: { accent: profile.accent }, openingHours: me?.openingHours || {}, settings: me?.settings || {} }) }); setMsg('Perfil actualizado.'); };
  return <section className="card"><h2>Personalización del perfil público</h2><p>Modifica cómo se ve tu restaurante para el cliente: portada, descripción, color, horarios y preferencias.</p><div className="profile-preview" style={{ '--accent': profile.accent }}><div className="cover"></div><h3>{me?.name || 'Restaurante'}</h3><p>{profile.bio || 'Describe tu propuesta de corrientazo.'}</p></div><div className="form-grid"><label className="field"><span>Biografía</span><textarea value={profile.bio} onChange={(e) => setProfile({ ...profile, bio: e.target.value })} /></label><label className="field"><span>URL imagen portada</span><input value={profile.cover} onChange={(e) => setProfile({ ...profile, cover: e.target.value })} /></label><label className="field compact"><span>Color de marca</span><input type="color" value={profile.accent} onChange={(e) => setProfile({ ...profile, accent: e.target.value })} /></label><button className="primary-btn" onClick={save}>Guardar diseño</button>{msg && <p className="success-msg">{msg}</p>}</div></section>;
}

function MobileApp() {
  const auth = useAuth();
  if (!auth.account || !['customer','admin'].includes(auth.account.role)) return <CustomerAuth onLogged={auth.save} />;
  return <CustomerHome account={auth.account} logout={auth.logout} />;
}

function CustomerAuth({ onLogged }) {
  const [tab, setTab] = useState('login');
  return <section className="mobile-frame"><div className="mobile-card hero-mobile"><Logo /><h1>Reserva tu corrientazo sin fila.</h1><p>Escoge restaurante, arma tu almuerzo, elige hora de recogida, paga en línea o en local y reclama con QR.</p></div><div className="tab-switch"><button className={tab==='login'?'active':''} onClick={() => setTab('login')}>Ingreso</button><button className={tab==='registro'?'active':''} onClick={() => setTab('registro')}>Registro</button></div>{tab === 'login' ? <LoginCard role="customer" title="Entrar a QuickLunch" subtitle="También puedes entrar con nicocr para probar todo." onLogged={onLogged} /> : <CustomerRegister onLogged={onLogged} />}</section>;
}

function CustomerRegister({ onLogged }) {
  const [form, setForm] = useState({ full_name: '', username: '', email: '', phone: '', password: '', consent_analytics: true }); const [error, setError] = useState('');
  const submit = async (e) => { e.preventDefault(); setError(''); try { const payload = await api('/auth/register', { method: 'POST', body: JSON.stringify(form) }); onLogged(payload); } catch (err) { setError(err.message); } };
  return <form className="mobile-card form-grid" onSubmit={submit}><h2>Crear cuenta</h2>{['full_name','username','email','phone','password'].map((f) => <label className="field" key={f}><span>{f.replaceAll('_',' ')}</span><input type={f==='password'?'password':'text'} value={form[f]} onChange={(e) => setForm({ ...form, [f]: e.target.value })} /></label>)}<label className="check"><input type="checkbox" checked={form.consent_analytics} onChange={(e) => setForm({ ...form, consent_analytics: e.target.checked })} /> Acepto que QuickLunch use mis gustos y actividad para recomendar platos, restaurantes y próximos pedidos.</label>{error && <p className="error-msg">{error}</p>}<button className="primary-btn">Registrarme</button></form>;
}

function CustomerHome({ account, logout }) {
  const [restaurants, setRestaurants] = useState([]); const [selected, setSelected] = useState(null); const [orders, setOrders] = useState([]); const [query, setQuery] = useState('');
  const load = () => { api('/restaurants/public').then(setRestaurants); api('/orders/mine').then(setOrders).catch(() => setOrders([])); };
  useEffect(load, []);
  const filtered = restaurants.filter((r) => r.name.toLowerCase().includes(query.toLowerCase()) || r.address.toLowerCase().includes(query.toLowerCase()));
  return <section className="mobile-app"><header className="mobile-top"><Logo compact /><button className="tiny-btn" onClick={logout}><LogOut size={15} /></button></header><div className="mobile-greeting"><h1>Hola, {account.full_name?.split(' ')[0] || account.username}</h1><p>¿Qué corrientazo quieres recoger hoy?</p></div><div className="search-box"><Search size={18} /><input placeholder="Buscar restaurante o zona" value={query} onChange={(e) => setQuery(e.target.value)} /></div><MapPanel restaurants={restaurants} compact /><div className="ai-strip"><Sparkles size={18} /><span>IA QuickLunch: cuando tengas historial, te sugeriremos restaurante, hora y plato probable.</span></div><h2>Cerca de ti</h2><div className="restaurant-grid">{filtered.map((r) => <button className="restaurant-tile" key={r.id} onClick={() => setSelected(r)}><div className="tile-cover"><Store /></div><strong>{r.name}</strong><span>{r.address}</span><small>Ver menú de hoy</small></button>)}</div>{!restaurants.length && <div className="mobile-card"><h3>Aún no hay restaurantes activos</h3><p>Ingresa a /admin con nicocr y crea o aprueba un restaurante para empezar la simulación.</p></div>}<CustomerOrders orders={orders} /><BottomNav /><OrderModal restaurant={selected} close={() => { setSelected(null); load(); }} /></section>;
}

function CustomerOrders({ orders }) {
  return <section><h2>Mis pedidos</h2><div className="cards-list compact">{orders.slice(0, 4).map((o) => <article className="receipt-card" key={o.id}><div><strong>{o.restaurant_name}</strong><p>{o.pickup_slot} · {statusLabel(o.status)}</p><small>{o.public_code}</small></div><QrCode /></article>)}{!orders.length && <p className="muted">No tienes pedidos todavía.</p>}</div></section>;
}

function BottomNav() {
  return <nav className="bottom-nav"><button><Home />Inicio</button><button><Gift />Cupones</button><button><ShoppingBag />Pedidos</button><button><MessageCircle />Soporte</button><button><UserRound />Cuenta</button></nav>;
}

function OrderModal({ restaurant, close }) {
  const [detail, setDetail] = useState(null);
  const [slot, setSlot] = useState('12:00');
  const [date] = useState(new Date().toISOString().slice(0,10));
  const [payment, setPayment] = useState('online');
  const [receipt, setReceipt] = useState(null);
  const [error, setError] = useState('');
  const [selection, setSelection] = useState({});
  useEffect(() => { if (restaurant) api(`/restaurants/${restaurant.slug}/public`).then((data) => { setDetail(data); setSelection({}); }); }, [restaurant]);
  if (!restaurant) return null;
  const menuItems = detail?.menu?.items || [];
  const basePrice = Number(menuItems[0]?.plate?.base_price || BASE_LUNCH_PRICE);
  const fixedPlates = menuItems.filter((i) => i.category === 'complete_plate');
  const customizableItems = menuItems.filter((i) => i.category !== 'complete_plate');
  const byCategory = customizableItems.reduce((acc, item) => ({ ...acc, [item.category]: [...(acc[item.category] || []), item] }), {});
  const selectedCustom = Object.values(selection).filter(Boolean);
  const chosenFixed = selection.complete_plate ? fixedPlates.find((p) => String(p.id) === String(selection.complete_plate)) : null;
  const usingFixed = Boolean(chosenFixed);
  const items = usingFixed
    ? [{ menu_item_id: chosenFixed.id, name: chosenFixed.name, category: 'complete_plate', price: Number(chosenFixed.price_delta || chosenFixed.price || 0) }]
    : selectedCustom.map((item) => ({ menu_item_id: item.id, name: item.name, category: item.category, price: itemExtra(item), price_delta: itemExtra(item) }));
  const subtotal = usingFixed ? Number(chosenFixed?.price_delta || chosenFixed?.price || basePrice) : basePrice + items.reduce((s, i) => s + Number(i.price || 0), 0);
  const fee = payment === 'online' ? 500 : 1000;
  const order = async () => {
    setError('');
    try {
      const payloadItems = items.length ? items : [{ name: 'Corrientazo base', category: 'customizable_base', price: basePrice }];
      const res = await api('/orders', { method: 'POST', body: JSON.stringify({ restaurant_id: restaurant.id, menu_id: detail?.menu?.id, pickup_date: date, pickup_time: slot, payment_method: payment, items: payloadItems, subtotal }) });
      setReceipt(res);
    } catch (err) { setError(err.message); }
  };
  return <div className="modal-backdrop"><div className="order-modal"><button className="close" onClick={close}>×</button>{receipt ? <div className="receipt-view"><CheckCircle2 size={46} /><h2>Reserva confirmada</h2><p>{receipt.restaurant_name}</p><div className="qr-box"><QrCode size={86} /><span>{receipt.public_code}</span></div><p>Recoge a las <strong>{receipt.pickup_slot}</strong>. QR obligatorio para entrega.</p><button className="primary-btn" onClick={close}>Listo</button></div> : <><h2>{restaurant.name}</h2><p>{detail?.restaurant?.profile?.bio || 'Menú disponible para reserva.'}</p>{!detail?.menu && <div className="ai-strip"><Sparkles size={18}/> Este restaurante aún no publicó menú. Se muestra corrientazo base demo.</div>}{fixedPlates.length > 0 && <section className="menu-builder"><h3>Platos armados</h3><label className="field"><span>Elegir plato armado</span><select value={selection.complete_plate || ''} onChange={(e) => setSelection({ complete_plate: e.target.value })}><option value="">Prefiero personalizar mi almuerzo</option>{fixedPlates.map((p) => <option value={p.id} key={p.id}>{p.name} · {money(Number(p.price_delta || p.price || basePrice))}</option>)}</select></label></section>}{!usingFixed && <section className="menu-builder"><h3>Personaliza tu almuerzo</h3><p>Precio base: <strong>{money(basePrice)}</strong>. Las opciones normales no suman precio; las especiales muestran su adicional.</p>{Object.entries(byCategory).map(([cat, list]) => <label className="field" key={cat}><span>{categoryLabel(cat)}</span><select value={selection[cat]?.id || ''} onChange={(e) => setSelection({ ...selection, [cat]: list.find((x) => String(x.id) === e.target.value) })}><option value="">Elegir {categoryLabel(cat).toLowerCase()}</option>{list.map((item) => <option value={item.id} key={item.id}>{item.name}{itemExtra(item) ? ` · especial +${money(itemExtra(item))}` : ' · menú normal'}</option>)}</select></label>)}</section>}<div className="menu-builder"><h3>Resumen del pedido</h3>{usingFixed ? <div className="line-item"><span>{chosenFixed.name}</span><strong>{money(subtotal)}</strong></div> : <><div className="line-item"><span>Almuerzo base personalizable</span><strong>{money(basePrice)}</strong></div>{items.map((i) => <div className="line-item" key={`${i.category}-${i.menu_item_id}`}><span>{categoryLabel(i.category)}: {i.name}</span><strong>{i.price ? `+${money(i.price)}` : money(0)}</strong></div>)}</>}</div><label className="field"><span>Hora de recogida</span><select value={slot} onChange={(e) => setSlot(e.target.value)}>{['11:00','11:10','11:20','11:30','11:40','11:50','12:00','12:10','12:20','12:30','12:40','12:50','13:00','13:10','13:20','13:30','13:40','13:50','14:00'].map((s) => <option key={s}>{s}</option>)}</select></label><div className="payment-options"><button className={payment==='online'?'selected':''} onClick={() => setPayment('online')}><WalletCards /> Pago adelantado <small>Menos espera · tarifa {money(500)}</small></button><button className={payment==='cash'?'selected':''} onClick={() => setPayment('cash')}><CircleDollarSign /> Pago en local <small>Reserva presencial · tarifa {money(1000)}</small></button></div><div className="invoice"><span>Subtotal</span><strong>{money(subtotal)}</strong><span>Tarifa QuickLunch</span><strong>{money(fee)}</strong><span>Total</span><strong>{money(subtotal + fee)}</strong></div>{payment === 'online' && <div className="gateway-demo"><ShieldCheck /> Pasarela demo: tarjetas, Nequi, PSE y Bancolombia simulan aprobación inmediata.</div>}{error && <p className="error-msg">{error}</p>}<button className="primary-btn" onClick={order}>Confirmar pedido</button></>}</div></div>;
}

function App() {
  return <BrowserRouter><Routes><Route path="/admin/*" element={<AdminApp />} /><Route path="/" element={<MobileApp />} /><Route path="/home" element={<MobileApp />} /><Route path="/:slug/*" element={<RestaurantApp />} /><Route path="*" element={<Navigate to="/home" />} /></Routes></BrowserRouter>;
}

createRoot(document.getElementById('root')).render(<App />);
