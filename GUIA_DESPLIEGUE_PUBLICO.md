# QuickLunch — Despliegue público con Vercel + Render

Esta guía deja QuickLunch con un dominio público accesible desde cualquier red:

- **Frontend público:** Vercel, por ejemplo `https://quicklunch.vercel.app`
- **Backend público:** Render, por ejemplo `https://quicklunch-api.onrender.com`

> Importante: el proyecto incluye backend, pero Vercel en esta configuración publica el frontend. Para que login, pedidos, códigos, soporte, restaurantes, membresías y analíticas funcionen públicamente, el backend debe estar publicado también.

---

## 1. Estructura del proyecto

```txt
quicklunch-web/
  client/          Frontend React/Vite
  server/          Backend Express + SQLite local
  scripts/         Arranque local simultáneo
  vercel.json      Configuración frontend Vercel
  package.json     Scripts generales
```

---

## 2. Probar en localhost primero

En la raíz del proyecto:

```powershell
npm config set registry https://registry.npmjs.org/
npm install
npm run install:all
npm run dev
```

Abre:

```txt
http://localhost:5173/home
http://localhost:5173/admin
```

Usuario inicial:

```txt
usuario: nicocr
contraseña: quick2026
```

Si necesitas base limpia:

```powershell
npm run reset-db
npm run dev
```

---

## 3. Subir el proyecto a GitHub

En la carpeta del proyecto:

```powershell
git init
git add .
git commit -m "QuickLunch feria deploy publico"
git branch -M main
git remote add origin https://github.com/TU_USUARIO/quicklunch.git
git push -u origin main
```

Si ya tenías repo:

```powershell
git add .
git commit -m "Actualiza QuickLunch para feria y despliegue publico"
git push
```

---

## 4. Publicar backend en Render

1. Entra a Render.
2. Crea **New + → Web Service**.
3. Conecta tu repositorio de GitHub.
4. Configura:

```txt
Name: quicklunch-api
Root Directory: server
Runtime: Node
Build Command: npm install
Start Command: npm start
```

5. En Environment Variables agrega:

```env
NODE_ENV=production
PORT=10000
JWT_SECRET=cambia_este_secreto_quicklunch_2026
CLIENT_ORIGINS=https://TU-PROYECTO.vercel.app
CLIENT_ORIGIN=https://TU-PROYECTO.vercel.app
```

Al principio no conoces aún la URL de Vercel. Puedes poner una temporal y luego volver a editarla.

6. Haz deploy.
7. Copia la URL de Render, por ejemplo:

```txt
https://quicklunch-api.onrender.com
```

8. Prueba:

```txt
https://quicklunch-api.onrender.com/api/health
```

Debe responder JSON indicando que la API está viva.

---

## 5. Publicar frontend en Vercel

En Vercel:

1. **Add New Project**.
2. Importa el repositorio de GitHub.
3. Configura:

```txt
Application Preset: Vite
Root Directory: ./
Build Command: npm run vercel-build
Output Directory: client/dist
Install Command: npm install && npm run install:all
```

4. En Environment Variables agrega:

```env
VITE_API_URL=https://TU-BACKEND.onrender.com/api
```

Ejemplo:

```env
VITE_API_URL=https://quicklunch-api.onrender.com/api
```

5. En **Environments**, deja:

```txt
Production and Preview
```

6. Presiona **Deploy**.

---

## 6. Ajustar CORS después de tener URL de Vercel

Cuando Vercel termine, copia tu URL, por ejemplo:

```txt
https://quicklunch.vercel.app
```

Vuelve a Render → Environment Variables y ajusta:

```env
CLIENT_ORIGINS=https://quicklunch.vercel.app
CLIENT_ORIGIN=https://quicklunch.vercel.app
```

Luego haz **Manual Deploy → Deploy latest commit** en Render.

---

## 7. Probar funcionamiento público

Abre desde cualquier red:

```txt
https://TU-PROYECTO.vercel.app/home
```

Prueba:

- Login owner: `nicocr / quick2026`
- Crear usuario de feria.
- Entrar a `/admin`.
- Crear o aprobar restaurante.
- Publicar menú.
- Realizar pedido desde `/home`.
- Validar código desde panel de restaurante.

---

## 8. Observaciones importantes

- Render en plan gratuito puede dormir el backend si no se usa por un rato. La primera carga puede tardar.
- SQLite local en Render sirve para demo/feria, pero no es ideal para producción permanente. Si Render reinicia o redeploya, los datos pueden perderse.
- Para versión final estable, migra la base a PostgreSQL/Supabase/Neon.
- No subas claves privadas reales al repo. Usa Environment Variables.

---

## 9. Configuración rápida de Vercel si aparece error

Revisa que esté exactamente así:

```txt
Root Directory: ./
Build Command: npm run vercel-build
Output Directory: client/dist
Install Command: npm install && npm run install:all
```

Y que exista:

```env
VITE_API_URL=https://TU-BACKEND.onrender.com/api
```
