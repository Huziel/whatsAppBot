# WhatsApp local CRM

Aplicación local en Node.js/TypeScript con Baileys oficial, MySQL y un panel web local. Captura mensajes de chats individuales y ofrece respuestas opcionales con texto fijo o DeepSeek.

## Requisitos e inicio

- Node.js 20 o superior y npm.
- MySQL 8.0.16 o superior accesible con un usuario y contraseña configurados en `.env`.

```sh
npm install
npm run migrate
npm run dev
```

`npm run dev` abre el panel en `http://127.0.0.1:3000`. El servicio de WhatsApp no comienza hasta pulsar **Iniciar servicio WhatsApp**; el QR aparece en la terminal. La sesión se conserva en la carpeta indicada por `AUTH_DIR`. **Salir de la sesión** desvincula y elimina las credenciales locales.

La primera visita al dashboard solicita crear un usuario y una contraseña de al menos 12 caracteres. Las credenciales se almacenan como hash scrypt en `APP_DATA_DIR/dashboard-auth.json`; las APIs administrativas requieren una sesión local y el botón **Cerrar sesión** la invalida. Si todavía no se configuró el acceso, el formulario inicial permite registrarlo.

La interfaz fuente vive en `web/` con HTML semántico y módulos ES. Tailwind CSS 4 se compila localmente: `npm run dev` inicia el servidor y el watcher de estilos; `npm run build` genera los assets en `dist/public`, servidos por `npm start`.

Para compilar y ejecutar:

```sh
npm run build
npm start
```

Otros comandos:

```sh
npm run stats
npm test
npm audit
```

La migración inicial crea `whatsapp_local`. `.env.example` contiene el formato de configuración; crea `.env` local con credenciales propias. `.env`, `auth/`, `data/`, `dist/` y `node_modules/` están excluidos de Git.

## Dashboard y administración

- **Identidad:** nombre del bot y del negocio. En respuestas fijas puedes usar `{botName}` y `{businessName}`.
- **IA:** DeepSeek opcional, modelo, tono, longitud, instrucciones del negocio, máximo de respuestas por contacto/hora y pausa antes de contestar.
- **Bandeja:** chats paginados y buscables, mensajes, pausa de IA individual y respuesta manual.
- **Contactos:** búsqueda, nombre visible, etiquetas, notas, alta manual con número internacional, exportación JSON y eliminación de datos.
- **Inventario:** productos/servicios con SKU, precio, existencias e imagen HTTPS. DeepSeek usa los artículos activos.
- **Menú público:** vista `/menu` para que los clientes exploren artículos activos, armen un carrito y envíen un pedido pendiente con su número de WhatsApp.
- **Carritos y pedidos:** ver carritos, crear pedidos con reserva transaccional, confirmarlos, prepararlos, marcarlos listos/en camino/completados o cancelarlos desde el panel.
- **Citas:** activar/desactivar, definir horario y zona, y reservar, consultar, cancelar o reprogramar. Horario inicial: lunes-viernes, 09:00–17:00, `America/Mexico_City`, citas de 60 minutos.
- **Privacidad:** exportar/borrar datos por contacto, vaciar el historial global y configurar la retención del contenido de mensajes (`0` desactiva esa limpieza).
- **Transferencia:** se pueden guardar los datos y compartirlos en respuesta a preguntas de pago. No se inicia ni confirma una transferencia.

La API key de DeepSeek y los datos bancarios se cifran con AES-GCM en `data/app-settings.json`, usando una clave derivada de `DB_PASSWORD` en `.env`. Conserva ese valor para descifrarlos después. Al usar DeepSeek se envían el mensaje actual, hasta 12 turnos previos del mismo chat, el carrito actual y el catálogo activo; no se transmite todo el historial ni los datos bancarios.

Las respuestas automáticas solo procesan mensajes nuevos de chats individuales: no responden historial, grupos, estados ni mensajes propios. El archivo de conversaciones tampoco importa el historial sincronizado; solo guarda mensajes con fecha desde el inicio de la sesión actual del servicio WhatsApp. En Privacidad se puede vaciar mensajes, chats y estados operativos; se conservan contactos, citas, pedidos, catálogo y configuración. Un carrito todavía no reserva existencias; la reserva se crea atómicamente al convertirlo en pedido. Las citas se almacenan en UTC y se comprueba que no haya traslapes. Las imágenes se obtienen de URLs HTTPS cuando se envían por WhatsApp; no se suben al servidor.

Las decisiones de DeepSeek son propuestas. Las consultas inequívocas de catálogo, precio, existencias, pagos, horarios y pedidos se resuelven primero con MySQL o la configuración; una caída del proveedor no impide esas respuestas. Las recomendaciones de productos usan las SKU propuestas por DeepSeek, pero el servidor redacta el mensaje con la descripción, precio, existencias e imagen HTTPS del inventario. Consultar un artículo no modifica el carrito: después de seleccionar una opción, expresiones como `lo quiero` o `agrégame dos de esos` sí aplican el cambio verificado. `Finalizar compra` muestra el resumen y exige un `sí` separado antes de crear un pedido pendiente y reservar stock; si el carrito o sus precios cambian, la confirmación se rechaza. Los pedidos de WhatsApp, las modificaciones de carrito y las citas se confirman únicamente después de ejecutar la operación en MySQL. Las citas requieren selección/confirmación y los ajustes guardados se aplican a los mensajes siguientes sin reiniciar WhatsApp. Los mensajes de un mismo chat se procesan en orden; chats distintos pueden procesarse en paralelo.

La retención de mensajes usa la fecha real del mensaje y no elimina estado operativo activo. Los turnos `received`, `processing`, `action_applied`, `send_pending`, `sending` y `uncertain`, junto con sus efectos, se conservan para recuperación o revisión. Los turnos terminales `sent` y `failed` se eliminan transaccionalmente después de 90 días; por tanto, la deduplicación durable de turnos terminales cubre esa ventana, no es indefinida. Las intenciones caducadas se eliminan durante la limpieza. Un envío `uncertain` no se reintenta automáticamente: puede reconciliarse al observar el mensaje propio o requiere revisión para evitar duplicados.

La recuperación captura un límite superior estable, lee lotes de 100 turnos y procesa como máximo cuatro chats en paralelo, manteniendo el orden dentro de cada chat. Los turnos inactivos se reclaman mediante leases y se vuelven a revisar cada minuto mientras el socket está conectado; así pueden retomarse después de una pausa, una cuota agotada o la expiración de un lease sin interferir con respuestas vivas. Un cambio de socket cancela la recuperación anterior antes de iniciar otra.

El menú público no requiere sesión de administración. Para publicarlo en un VPS, mantén Node escuchando en `127.0.0.1:3000` y configura el reverse proxy HTTPS para exponer únicamente estas rutas del storefront (la administración queda local):

```nginx
location = /menu { proxy_pass http://127.0.0.1:3000/menu; proxy_set_header Host $host; }
location = /menu.html { proxy_pass http://127.0.0.1:3000/menu.html; proxy_set_header Host $host; }
location ^~ /pedido/ { proxy_pass http://127.0.0.1:3000; proxy_set_header Host $host; }
location = /pedido.html { proxy_pass http://127.0.0.1:3000/pedido.html; proxy_set_header Host $host; }
location = /assets/dashboard.css { proxy_pass http://127.0.0.1:3000/assets/dashboard.css; proxy_set_header Host $host; }
location = /js/public-menu.js { proxy_pass http://127.0.0.1:3000/js/public-menu.js; proxy_set_header Host $host; }
location = /js/public-order.js { proxy_pass http://127.0.0.1:3000/js/public-order.js; proxy_set_header Host $host; }
location ^~ /api/public/ { proxy_pass http://127.0.0.1:3000; proxy_set_header Host $host; proxy_set_header X-Forwarded-For $remote_addr; }
```

Comparte `https://tu-dominio/menu`. Antes de desplegar una versión nueva ejecuta `npm run migrate` con las credenciales de la base correspondiente y después reinicia el proceso Node. Mantén TLS, límites de cuerpo y de frecuencia en Nginx; no publiques `/`, `/api/settings`, `/api/orders` ni otras rutas administrativas. Node continúa escuchando solo en `127.0.0.1`.

El checkout no cobra ni envía mensajes. Registra el teléfono como dato no verificado del pedido, sin sobrescribir el nombre confiable recibido desde WhatsApp, y crea una reserva atómica con los precios/nombres consultados en MySQL. El cliente recibe un folio aleatorio `WA-...` y un enlace de consulta. El folio no autoriza por sí solo: el navegador conserva un token aleatorio de 256 bits y el servidor almacena únicamente su hash SHA-256. Una consulta con folio inexistente o token incorrecto devuelve el mismo `404` genérico.

El UUID de checkout, el token y el payload enviado se guardan en `sessionStorage`, que debe estar habilitado para enviar el pedido. Si el servidor registró el pedido pero se perdió la respuesta, una recarga reenvía exactamente el mismo intento y devuelve el pedido original; mientras el resultado sea incierto, el formulario conserva y bloquea los datos originales. `orders.public_order_key` sigue siendo `UNIQUE`; además, el hash canónico impide reutilizar una clave con otro teléfono o contenido. El intento se elimina solo después de recibir una respuesta de creación inequívoca.

## Reservas, inventario y estados

`inventory_items.stock_quantity` representa stock físico. `reserved_quantity` representa unidades retenidas por pedidos pendientes y el disponible se calcula como `stock_quantity - reserved_quantity`. Productos con stock `NULL` y servicios no crean una fila de reserva de unidades. El dashboard muestra físico, reservado y disponible por separado.

Al crear un pedido, una transacción bloquea los artículos en orden estable con `SELECT ... FOR UPDATE`, valida todos los SKU y aumenta `reserved_quantity`. También crea el pedido, sus instantáneas, `inventory_reservations` y movimientos `reserve`. Si un solo artículo falla, toda la transacción hace rollback: nunca se acepta un pedido parcial. Deadlocks y timeouts de lock se reintentan de forma acotada; la restricción de MySQL impide que reservado supere el stock físico.

El plazo se configura en **Ventas** mediante `orderReservationMinutes` (15 minutos por defecto; rango 5–1440). Cada pedido guarda su `expires_at`, por lo que cambiar la configuración no altera pedidos existentes. Un worker se ejecuta al iniciar y cada minuto, incluso si WhatsApp está detenido. Busca lotes vencidos con `FOR UPDATE SKIP LOCKED`; MySQL conserva la fuente de verdad, por lo que reinicios o varias instancias no duplican liberaciones. El proceso Node debe permanecer activo para que la liberación sea puntual; si estuvo detenido, procesa los vencimientos al arrancar.

Estados operativos de pedido:

- `pending`: reserva activa, pendiente de revisión.
- `confirmed`: la reserva pasa a venta; disminuyen stock físico y reservado.
- `preparing`, `ready`, `out_for_delivery`, `completed`: progreso posterior sin un segundo movimiento de inventario.
- `cancelled`: una reserva pendiente pasa a liberada sin disminuir stock físico.
- `expired`: una reserva vencida se libera automáticamente.

Los pedidos históricos creados antes de `013` conservan `reservation_status=none`: pueden avanzar de estado por compatibilidad, pero no generan una venta o liberación retroactiva de inventario. Deben revisarse manualmente si se necesita conciliar su stock.

El estado financiero es independiente: `unpaid`, `pending`, `paid`, `failed` o `refunded`. Los pedidos nuevos comienzan en `unpaid`; esta versión no procesa pagos ni integra proveedores externos. `inventory_movements` conserva eventos idempotentes `reserve`, `release` y `sale`; las altas y modificaciones administrativas de stock generan movimientos `adjustment` con valores anterior, nuevo y delta en metadata.

La consulta `GET /api/public/orders/:publicId` requiere `Authorization: Bearer <token>` y devuelve solo folio, fechas públicas, estados, artículos, total y moneda. No devuelve IDs internos, contactos, teléfonos, JID/LID, notas, payloads ni datos bancarios. La página `/pedido/:publicId#token=...` guarda el token en `sessionStorage` y lo retira de la URL visible.

Las respuestas HTTP de error usan un formato uniforme y no exponen excepciones ni SQL:

```json
{"error":{"code":"INSUFFICIENT_STOCK","message":"No hay suficientes unidades disponibles.","requestId":"..."}}
```

El encabezado `X-Request-Id` contiene el mismo identificador para correlacionar el error con los logs internos.

La aplicación limita todo intento de checkout por cliente y ventana global antes de consultar MySQL, limita pedidos nuevos exitosos por teléfono, limita las consultas de estado y mantiene las estructuras en memoria acotadas. Cada checkout admite como máximo 100 unidades totales. Nginx debe sobrescribir `X-Forwarded-For` con `$remote_addr`, como en el ejemplo, y aplicar su propio `limit_req`. El teléfono del checkout no demuestra propiedad; para una exposición de alto riesgo se recomienda incorporar CAPTCHA u OTP por WhatsApp en una fase posterior.

## MySQL

Las migraciones numeradas están en `migrations/` y se pueden volver a ejecutar con `npm run migrate`:

- `001_initial.sql`: contactos, identificadores, chats y mensajes.
- `002`–`004`: inventario de productos/servicios e imágenes.
- `005_shopping_carts.sql`: carritos.
- `006_appointments.sql`: citas.
- `007_admin_tools.sql`: pausas de IA y pedidos.
- `008_contact_profiles.sql`: nombres visibles, etiquetas y notas de contactos.
- `009_conversation_engine.sql`: idempotencia de turnos, resultados de envío e intenciones pendientes.
- `010_retention_recovery_indexes.sql`: índices para retención y recuperación paginada.
- `011_recovery_leases.sql`: leases de recuperación y estado de envío en curso.
- `012_public_order_idempotency.sql`: clave única para reintentos idempotentes del checkout público.
- `013_transactional_sales.sql`: stock reservado, estados operativos/financieros, folios y tokens públicos, expiración, reservas y movimientos de inventario.

Solo se resuelven teléfonos a partir de JID telefónicos o correspondencias PN-LID reales de WhatsApp. Los dígitos de un LID no se convierten en teléfono. Los ejemplos demo de inventario comienzan inactivos.

## Documentación oficial

- Baileys v6: https://github.com/WhiskeySockets/Baileys/tree/v6.7.24
- DeepSeek Chat Completions: https://api-docs.deepseek.com/api/create-chat-completion
- Modelos DeepSeek: https://api-docs.deepseek.com/quick_start/api_usage
