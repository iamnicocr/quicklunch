# QuickLunch Web Module

Versión: v1.0.12 v1.0.10

Módulo web integral de QuickLunch para ejecutar en localhost. Incluye backend Express, frontend React + Vite, bases SQLite locales con `sql.js`, panel de owner/admin, paneles de restaurante, app móvil simulada de cliente, códigos de entrega, soporte, IA operativa por reglas y sistema funcional de cupones/créditos.

## Rutas principales

```txt
/admin                 Panel administrativo QuickLunch
/home                  App móvil simulada para clientes
/                      App móvil simulada para clientes
/<slug-restaurante>    Panel del restaurante
/confirmar/<codigo>    Confirmación pública del código de entrega
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
| `restaurant_staff` | Cajero/operador. Acceso limitado a operación de restaurante: menú, pedidos, códigos y hora pico. No ve estadísticas ni ingresos. |
| `customer` | Cliente final. Puede ver restaurantes, pedir, pagar, cancelar cuando aplique, usar cupones, soporte, historial y código de entrega. |

## Cambios v1.0.10

### Acceso, usuarios y recuperación

- Recuperación piloto de contraseña por usuario: con solo ingresar el usuario, la pantalla muestra la clave registrada para pruebas locales.
- Creación de usuarios desde admin corregida.
- Owner queda asociado a todos los restaurantes y puede entrar a cualquier panel.
- Validaciones reforzadas para evitar errores/repetidos antes de guardar.

### Cliente y pedidos

- El recuadro de pedido ya no tapa la pantalla ni bloquea el botón de generar pedido.
- Restaurante público desde la app del cliente carga mejor y muestra promociones activas.
- Al reclamar el almuerzo con código, el usuario recibe una ventana flotante para calificar con estrellas y comentar.
- Una vez el código queda reclamado, el código deja de servir y el restaurante ya no puede modificar el estado del pedido.
- El restaurante no acumula ingresos liberados hasta que el código quede validado.

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
10. En el panel de restaurante, valida el código desde **Pedidos y códigos**.
11. Revisa que el pedido quede como código reclamado y que aparezca la calificación flotante en la app del cliente.

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

Este módulo está diseñado como entorno formal funcional para pruebas locales del proyecto QuickLunch. Para producción real se recomienda migrar autenticación, pagos, almacenamiento de imágenes, mapas, códigos de entrega y notificaciones a servicios gestionados con HTTPS.


## Notas v1.0.10

- Los usuarios inician sesión sin distinguir mayúsculas/minúsculas en el usuario o correo. Las contraseñas sí distinguen mayúsculas y minúsculas.
- El botón global de regresar aparece en admin, restaurante y usuario.
- Si un restaurante no publicó menú, aparece “Disponible en breve” y no se permite entrar desde la app cliente.
- Los pedidos reclamados por código quedan cerrados, el código pierde validez y el pedido baja al fondo de Pedidos y códigos.


## Si aparece pantalla en blanco

La versión 1.0.10 incluye una pantalla de arranque que muestra errores visibles. Si no carga:

1. Verifica que ambos servicios estén activos:
   - API: http://localhost:4000/api/health
   - Cliente: http://localhost:5173
2. Borra dependencias viejas y reinstala:
   ```powershell
   Remove-Item -Recurse -Force node_modules, server\node_modules, client\node_modules -ErrorAction SilentlyContinue
   npm config set registry https://registry.npmjs.org/
   npm run install:all
   npm run dev
   ```
3. Si usas una base anterior, ejecuta:
   ```powershell
   npm run reset-db
   npm run dev
   ```


## Corrección v1.0.15 - imágenes sin claves

- Se eliminó la integración con Google Custom Search para este módulo. Ya no se necesitan `GOOGLE_CSE_API_KEY`, `GOOGLE_CSE_ID` ni contraseñas/llaves externas para buscar imágenes.
- El nuevo buscador usa Openverse como fuente principal de imágenes abiertas y Wikimedia Commons como respaldo.
- Devuelve 5 imágenes, evita repetidas por URL y título, filtra malas palabras, logos, dibujos, vectores, memes, íconos e imágenes demasiado pequeñas.
- Las búsquedas se arman con nombre + descripción del plato y términos expandidos en español/inglés para alimentos comunes.
- Al seleccionar una imagen, QuickLunch intenta importarla y guardarla en `server/uploads/quicklunch/suggested`. Si el proveedor bloquea la descarga, usa la miniatura estable como respaldo visible.
- El endpoint de diagnóstico ahora es `/api/images/diagnostics` y revisa Openverse, no Google.
- Mensaje visible para el restaurante: “¿Problemas en conseguir tu imagen? Asegúrate de haber escrito correctamente el producto y agrega una descripción clara.”

## Corrección v1.0.17 - galería inteligente local

- Se reemplazó definitivamente la búsqueda externa de imágenes por una galería inteligente local generada por QuickLunch.
- Ya no usa Google, Openverse, Wikimedia, API keys, contraseñas, `.env` especial ni enlaces externos para sugerencias.
- El sistema genera 5 imágenes SVG locales, legibles y diferentes entre sí, asociadas al nombre y descripción del producto.
- Las imágenes se guardan automáticamente en:

```txt
server/uploads/quicklunch/generated-food
```

- Al seleccionar una sugerencia, se guarda directamente en el inventario porque ya pertenece al servidor local.
- Esto evita imágenes rotas, repetidas, bloqueadas por hotlink o poco relacionadas.
- Para mejores resultados, escribe nombre + descripción clara. Ejemplo:

```txt
Nombre: Tilapia frita
Descripción: pescado frito servido en plato de almuerzo colombiano
```


## Módulo de imágenes v1.0.17

La búsqueda de imágenes ya no genera iconos SVG. Ahora sugiere fotos reales usando una estrategia híbrida:

- TheMealDB y DummyJSON Recipes para recetas con foto real.
- Wikimedia Commons para fotografías públicas.
- Galería real curada QuickLunch como respaldo por categoría.
- LoremFlickr como respaldo por etiquetas cuando se necesitan más variantes.

No requiere claves, contraseñas ni `GOOGLE_CSE_API_KEY`. Si una imagen externa no puede importarse, la aplicación conserva el enlace original para que el plato siga mostrando una foto real.

## v1.0.19 - Búsqueda de imágenes con recetas, supermercados y productos

El módulo de imágenes usa Google Programmable Search con fuentes configuradas de cocina, recetas, supermercados y productos industriales. La idea es que funcione mejor tanto para platos reales como para jugos, gaseosas, snacks, postres empacados y otros productos de inventario que no son platos preparados.

En `server/.env` deben existir:

```env
GOOGLE_CSE_API_KEY=tu_api_key
GOOGLE_CSE_ID=tu_search_engine_id
QL_IMAGE_SEARCH_DOMAINS=misrecetascolombia.com,elrinconcolombiano.com,recetas123.net,mycolombianrecipes.com,sweetysalado.com,antojandoando.com,colombia.com,comidascolombianas.com,recetinas.com,recetasgratis.net,cookpad.com,kiwilimon.com,quericavida.com,goya.com,comedera.com,paulinacocina.net,directoalpaladar.com,bonviveur.es,hogarmania.com,cocinatis.com,recetasdecocina.elmundo.es,196flavors.com,allrecipes.com,blogspot.com,comida.com,gastronomia.com,platos.com,cocina.com,exito.com,carulla.com,jumbo.com.co,olimpica.com,tiendasd1.com,alkosto.com,makro.com.co,pricesmart.com.co,farmatodo.com.co,merqueo.com,rappi.com.co,mercadolibre.com.co,nutresa.com,postobon.com,coca-cola.com,alpina.com
```

Si Google no devuelve resultados útiles desde esos sitios, QuickLunch ya no abre búsquedas amplias; solo usa una galería curada de respaldo para evitar imágenes que no tengan nada que ver.


## v1.0.20 - Búsqueda de imágenes por variantes reales de corrientazo

Esta versión corrige la repetición de imágenes entre búsquedas distintas. El módulo ya no completa con una galería genérica fija cuando Google no devuelve suficientes resultados. Ahora:

- Detecta perfiles específicos de corrientazo: tilapia, mojarra, pollo, chuleta de cerdo, chuleta de res, costilla, carne de res, chicharrón, albóndigas, fríjoles, lentejas, garbanzos, arvejas, pasta, arroz, ensalada, papa cocida, papas fritas, patacón, maduro, yuca, arepa, aguacate, sopas, jugos, gaseosas, agua, snacks, postres industriales, hamburguesas y plato completo.
- Construye búsquedas diferentes para cada producto usando nombre + descripción + variantes conocidas.
- Prioriza dominios de recetas para platos y dominios de supermercados/productos para bebidas o industriales.
- Filtra repetidas por URL y miniatura, no por título, para evitar descartar fotos útiles.
- Si Google devuelve pocos resultados, completa con fotos reales por etiquetas específicas del producto, no con imágenes genéricas repetidas.
- La respuesta incluye `profile` y `terms` para diagnosticar qué tipo de plato detectó QuickLunch.

## v1.0.21 - Ajuste de imágenes para corrientazos y productos de supermercado

Esta versión separa mejor dos tipos de búsqueda:

- **Platos y componentes de corrientazo:** proteínas, principios, acompañamientos, sopas, jugos naturales y platos armados. Se priorizan sitios gastronómicos, recetas y comida colombiana/latina.
- **Productos industriales o de supermercado:** gaseosas, aguas, jugos embotellados, snacks, postres empacados, marcas comerciales y productos por presentación. Se priorizan supermercados, marcas y tiendas.

Para productos empacados se recomienda escribir marca y presentación, por ejemplo:

- `Coca Cola botella 400 ml`
- `Papas Margarita limón paquete`
- `Pony Malta lata`
- `Yogurt Alpina vaso`
- `Agua Cristal botella`

En productos industriales, QuickLunch evita completar con imágenes genéricas de platos para no confundir marcas, empaques o presentaciones.


## v1.0.22 - Imágenes con más variedad y productos empacados funcionales

Esta versión mejora el módulo de imágenes para inventario:

- Para **platos y componentes de corrientazo**, QuickLunch genera más consultas por contexto: proteína, principio, acompañamiento, sopa, jugo natural y plato armado.
- Para **productos de supermercado**, se agregó una fuente adicional sin clave: **Open Food Facts**, que devuelve fotos reales de empaques, botellas, latas, snacks, yogures, bebidas y marcas.
- El sistema combina Open Food Facts + Google CSE para productos industriales, y Google CSE + variantes de corrientazo para platos reales.
- Se reducen imágenes repetidas por URL, miniatura, dominio y similitud de título/contexto.
- Para productos empacados se recomienda escribir marca + presentación, por ejemplo: `Coca Cola botella 400 ml`, `Papas Margarita limón paquete`, `Pony Malta lata`, `Yogurt Alpina vaso`.
- Para platos se recomienda escribir preparación + contexto, por ejemplo: `Tilapia frita` con descripción `pescado frito servido con arroz y ensalada`.

El endpoint `/api/images/diagnostics` ahora devuelve también `productWorking`, que indica si Open Food Facts encontró productos reales.


## v1.0.23 - Correcciones de menú, cupones y navegación

- Al modificar un elemento del inventario, la interfaz sube automáticamente a la parte superior para editar los campos.
- Se corrigieron los errores `visibleBenefitName is not defined` y `normalizeDateTime is not defined` al crear cupones/descuentos desde restaurante.
- El listado público de restaurantes ahora calcula `menuPublished` desde la base de datos para volver a habilitar el acceso cuando el restaurante publica menú.
- El menú del día queda limitado a un menú por restaurante y fecha: si ya existe, el formulario lo modifica en vez de crear otro.
- Se agregaron flechas de regreso también en pantallas de login/registro/solicitud, además de los paneles internos.
