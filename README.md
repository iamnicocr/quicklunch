# QuickLunch Web Module v1.0.7

Módulo web integral de QuickLunch para ejecutar en localhost. Incluye backend Express, frontend React + Vite, bases SQLite locales con `sql.js`, panel de owner/admin, paneles de restaurante, app móvil simulada de cliente, QR, soporte, IA operativa por reglas y sistema funcional de cupones/créditos.

## Rutas principales

```txt
/admin                 Panel administrativo QuickLunch
/home                  App móvil simulada para clientes
/                      App móvil simulada para clientes
/<slug-restaurante>    Panel del restaurante
/confirmar/<codigo>    Confirmación pública del QR
```

## Usuario inicial

```txt
Usuario: nicocr
Contraseña: quick2026
Rol: owner
```

El rol `owner` tiene acceso total a todas las plataformas y a todos los restaurantes.

## Instalación en Windows / PowerShell

Desde la carpeta `quicklunch-web`:

```powershell
npm config set registry https://registry.npmjs.org/
npm cache clean --force
npm run install:all
npm run dev
```

Abre:

```txt
http://localhost:5173/admin
```

Si `npm run dev` falla por restricciones de Windows, abre dos terminales:

Terminal 1:

```powershell
npm run dev:server
```

Terminal 2:

```powershell
npm run dev:client
```

## Reiniciar bases de datos

Las bases se crean automáticamente en `server/data`. Para reiniciar todo y dejar solo el owner inicial:

```powershell
npm run reset-db
npm run dev
```

Usa esto solo si tienes datos viejos que choquen con nuevas columnas o roles.

## Roles implementados

| Rol | Acceso |
|---|---|
| `owner` | Acceso total a admin, usuarios, restaurantes, roles, comisiones, soporte, cupones y todos los paneles de restaurante. |
| `admin` | Panel administrativo, usuarios, restaurantes y soporte. No puede entregar rol de administrador ni owner. |
| `restaurant_owner` | Dueño de restaurante. Acceso completo al panel de su restaurante: perfil, inventario, menú, horarios, equipo, pedidos, estadísticas, cupones y descuentos. |
| `restaurant_staff` | Cajero/operador. Acceso limitado a operación de restaurante: menú, pedidos, QR y hora pico. No ve estadísticas ni ingresos. |
| `customer` | Cliente final. Puede ver restaurantes, pedir, pagar, cancelar cuando aplique, usar cupones, soporte, historial y QR. |

## Cambios v1.0.7

### Acceso, usuarios y recuperación

- Recuperación piloto de contraseña por usuario: con solo ingresar el usuario, la pantalla muestra la clave registrada para pruebas locales.
- Creación de usuarios desde admin corregida.
- Owner queda asociado a todos los restaurantes y puede entrar a cualquier panel.
- Validaciones reforzadas para evitar errores/repetidos antes de guardar.

### Cliente y pedidos

- El recuadro de pedido ya no tapa la pantalla ni bloquea el botón de generar pedido.
- Restaurante público desde la app del cliente carga mejor y muestra promociones activas.
- Al reclamar el almuerzo por QR, el usuario recibe una ventana flotante para calificar con estrellas y comentar.
- Una vez el QR queda reclamado, el QR deja de servir y el restaurante ya no puede modificar el estado del pedido.
- El restaurante no acumula ingresos liberados hasta que el QR quede validado.

### Restaurante

- La vista cliente ahora es una previsualización integrada dentro del panel, sin redirigir a otros enlaces.
- La búsqueda de imágenes intenta traer 5 imágenes de internet usando nombre y descripción del plato o porción. Si la búsqueda externa no responde, usa respaldo visual relacionado con comida.
- Las promociones del restaurante resaltan su tarjeta en el listado de clientes y muestran el beneficio más fuerte.

### Soporte funcional

- Soporte asociado a pedidos.
- Chat del usuario con QuickLunch.
- El owner/admin puede implicar al restaurante cuando el problema sí corresponde al restaurante.
- Cuando se implica al restaurante, se abre un canal separado para hablar con el restaurante.
- El owner/admin puede combinar acciones:
  - recompensar usuario
  - sancionar restaurante
  - negar solicitud
  - marcar como resuelto
- El restaurante solo ve soportes en los que QuickLunch lo haya implicado.

### IA operativa integrada

- Se agregó una IA operativa por reglas conectada a la información real del sistema.
- Analiza pedidos, ingresos, demoras, cancelaciones, ratings, restaurantes y comportamiento general.
- Muestra recomendaciones activas para owner/admin, restaurante y usuario según su rol.

### Analíticas owner

- El panel owner muestra ingresos libres de la app.
- Se agregó endpoint de analíticas con ingresos retenidos, liberados y recomendaciones operativas.

### Cupones, créditos y descuentos

- Owner/admin puede crear cupones con:
  - ID/nombre
  - inicio y fin de vigencia
  - usos limitados o ilimitados
  - cobertura: toda la app, un restaurante o grupo de restaurantes
  - efecto: crédito, descuento, servicio gratis o descuento de servicio
  - valor del efecto
  - aplicación automática para todos o usuarios seleccionados
- Cliente puede redimir cupones desde su panel.
- Los créditos de cupones se aplican funcionalmente en la compra.
- Restaurante puede crear beneficios propios únicamente para su restaurante:
  - cupones redimibles por código
  - descuentos automáticos sin código si el usuario cumple requisitos
- Requisitos disponibles:
  - compras anteriores en ese restaurante
  - compra mayor a cierto valor
  - compra mayor a 0 para promociones generales
- Descuentos de restaurante pueden aplicar a todo el pedido, productos concretos o tarifa de servicio.
- Restaurantes no ven ni gestionan cupones de otros restaurantes ni de toda la app.
- El panel registra creador, rol del creador y fecha de creación.
- Las promociones activas resaltan la tarjeta del restaurante y muestran la etiqueta más fuerte:
  - Saldo GRATIS
  - Descuento
  - Servicio gratis
  - Servicio descuento

## Flujo recomendado de prueba

1. Entra a `/admin` con `nicocr / quick2026`.
2. Crea un restaurante desde **Restaurantes**.
3. Entra al panel del restaurante con el slug generado.
4. Crea inventario y menú del día.
5. Configura horarios y cupos de atención.
6. Crea un cupón o descuento desde owner o desde el restaurante.
7. Entra a `/home` como cliente y crea una cuenta.
8. Redime cupón si aplica.
9. Haz un pedido.
10. En el panel de restaurante, valida el QR desde **Pedidos y QR**.
11. Revisa que el pedido quede como QR reclamado y que aparezca la calificación flotante en la app del cliente.

## Imágenes

El restaurante puede:

- Subir logo y banner desde archivo local.
- Subir imágenes de platos/componentes.
- Buscar 5 sugerencias de internet por nombre y descripción.

Las imágenes subidas se guardan en:

```txt
server/uploads/quicklunch
```

## Estructura

```txt
quicklunch-web/
  client/        Frontend React + Vite
  server/        API Express
  server/data/   Bases SQLite generadas automáticamente
  server/uploads Imágenes subidas
  scripts/       Lanzador de desarrollo
```

## Nota

Este módulo está diseñado como entorno formal funcional para pruebas locales del proyecto QuickLunch. Para producción real se recomienda migrar autenticación, pagos, almacenamiento de imágenes, mapas, QR y notificaciones a servicios gestionados con HTTPS.
