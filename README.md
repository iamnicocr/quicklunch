# QuickLunch Web Module v1.0.3

Módulo web funcional para simular el ecosistema de QuickLunch en localhost:

- `/` y `/home`: aplicación móvil del usuario.
- `/admin`: panel administrativo de QuickLunch.
- `/<nombre_restaurante>`: portal web del restaurante.
- API Express en `http://localhost:4000/api`.
- Bases SQLite locales en `server/data`.

## Usuario inicial

```txt
Usuario: nicocr
Contraseña: quick2026
Rol: administrador total
Ciudad activa: Cali
```

## Requisitos

- Node.js 18 o superior.
- npm instalado.
- Conexión a internet solo para instalar dependencias la primera vez.

## Instalación limpia en Windows PowerShell

Desde la carpeta raíz del proyecto, es decir, donde está este README:

```powershell
npm config set registry https://registry.npmjs.org/
npm cache clean --force
npm run install:all
npm run dev
```

Luego abre:

```txt
http://localhost:5173/admin
```

El backend queda en:

```txt
http://localhost:4000/api
```

## Si ya habías intentado instalar y falló

El error `ECONNRESET` con una URL parecida a `packages.applied-caas-gateway...` ocurre cuando npm intenta usar un registry interno que no existe en tu computador.

Ejecuta esto desde la carpeta raíz del proyecto:

```powershell
npm config set registry https://registry.npmjs.org/
npm cache clean --force
Remove-Item -Recurse -Force node_modules -ErrorAction SilentlyContinue
Remove-Item -Recurse -Force server\node_modules -ErrorAction SilentlyContinue
Remove-Item -Recurse -Force client\node_modules -ErrorAction SilentlyContinue
Remove-Item -Force package-lock.json -ErrorAction SilentlyContinue
Remove-Item -Force server\package-lock.json -ErrorAction SilentlyContinue
Remove-Item -Force client\package-lock.json -ErrorAction SilentlyContinue
npm run install:all
npm run dev
```

## Alternativa: arrancar en dos terminales

Si prefieres no usar el script unificado:

Terminal 1:

```powershell
npm run dev:server
```

Terminal 2:

```powershell
npm run dev:client
```


## Cambios incluidos en v1.0.3

- Desde `/admin/restaurantes` ahora se puede **editar** la información del restaurante y también **eliminarlo** del sistema demo.
- Los formularios administrativos y legales usan etiquetas claras en español y ejemplos dentro de cada casilla.
- Se reemplazó el texto técnico `chamber commerce` por **Matrícula mercantil / Registro en Cámara de Comercio**.
- La creación de inventario ya no pide precio para proteína, principio, acompañamiento, jugo, postre o extra.
- Cada componente puede marcarse como **especial** y ahí sí se pide el **costo adicional**.
- Los platos armados, como `Combo de hamburguesa`, sí piden precio propio.
- En el pedido del usuario, el menú personalizable cobra el precio base del corrientazo y solo suma adicionales especiales.

Ejemplo implementado:

```txt
Precio base del corrientazo: $15.000
Tilapia marcada como especial: +$5.000
Total del usuario con tilapia: $20.000 antes de tarifa QuickLunch
```

## Rutas principales

```txt
http://localhost:5173/
http://localhost:5173/home
http://localhost:5173/admin
http://localhost:5173/corrientazo-demo
```

## Bases de datos

Al iniciar el servidor se crean automáticamente en:

```txt
server/data/quicklunch_users.db
server/data/quicklunch_restaurants.db
server/data/quicklunch_core.db
```

Por defecto vienen sin datos de negocio, salvo el usuario administrador inicial `nicocr`.

Para reiniciar las bases:

```powershell
npm run reset-db
npm run dev
```

## Flujo recomendado de prueba

1. Entrar a `/admin`.
2. Iniciar sesión con `nicocr / quick2026`.
3. Crear o aprobar un restaurante.
4. Entrar al portal del restaurante con su slug: `/<nombre_restaurante>`.
5. Crear inventario: componentes normales sin precio, opciones especiales con costo adicional y platos armados con precio propio.
6. Publicar menú del día: definir precio base del corrientazo, stock diario y modo personalizable/platos armados/mixto.
7. Entrar a `/home` como usuario.
8. Registrarse como cliente.
9. Hacer una reserva y generar QR.
10. Ver el pedido en la pantalla de reservas del restaurante.

## Notas del proyecto

- Cali es la única ciudad habilitada inicialmente.
- Pasto y Bogotá aparecen como próximas ciudades, pero el sistema bloquea el acceso con el mensaje correspondiente.
- El modelo de tarifas inicial es:
  - Pago adelantado: `$500` de tarifa de app.
  - Pago en local: `$1000` de tarifa de app.
- Los cupos de recogida están configurados cada 10 minutos.
- La ventana máxima de recogida está modelada en la configuración del sistema.
- La integración de Google Maps está simulada mediante embed público; para producción se recomienda usar API Key propia.
- El sistema de IA está representado como recomendaciones internas calculadas/simuladas para orientar el flujo funcional del proyecto.

## Estructura

```txt
quicklunch-web/
├─ client/
│  ├─ src/
│  │  ├─ main.jsx
│  │  └─ styles/theme.css
│  └─ package.json
├─ server/
│  ├─ src/
│  │  ├─ db.js
│  │  ├─ reset-db.js
│  │  └─ server.js
│  ├─ data/
│  └─ package.json
├─ scripts/
│  └─ dev.mjs
├─ .npmrc
├─ package.json
└─ README.md
```

## Si `npm run dev` falla en Windows

Abre dos terminales dentro de la carpeta `quicklunch-web`:

Terminal 1:

```powershell
npm run dev:server
```

Terminal 2:

```powershell
npm run dev:client
```

Luego entra a `http://localhost:5173/admin`.
