# WhatsApp local CRM

Aplicación local en Node.js/TypeScript con Baileys oficial, MySQL y un panel web local. Captura mensajes de chats individuales y ofrece respuestas opcionales con texto fijo o DeepSeek.

## Requisitos e inicio

- Node.js 20 o superior y npm.
- MySQL local accesible con un usuario y contraseña configurados en `.env`.

```sh
npm install
npm run migrate
npm run dev
```

`npm run dev` abre el panel en `http://127.0.0.1:3000`. El servicio de WhatsApp no comienza hasta pulsar **Iniciar servicio WhatsApp**; el QR aparece en la terminal. La sesión se conserva en la carpeta indicada por `AUTH_DIR`. **Salir de la sesión** desvincula y elimina las credenciales locales.

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

## Panel de configuración y administración

- **Identidad:** nombre del bot y del negocio. En respuestas fijas puedes usar `{botName}` y `{businessName}`.
- **IA:** DeepSeek opcional, modelo, tono, longitud, instrucciones del negocio, máximo de respuestas por contacto/hora y pausa antes de contestar.
- **Bandeja:** chats paginados y buscables, mensajes, pausa de IA individual y respuesta manual.
- **Contactos:** búsqueda, nombre visible, etiquetas, notas, alta manual con número internacional, exportación JSON y eliminación de datos.
- **Inventario:** productos/servicios con SKU, precio, existencias e imagen HTTPS. DeepSeek usa los artículos activos.
- **Carritos y pedidos:** ver carritos, crear pedidos pendientes y confirmarlos o cancelarlos desde el panel.
- **Citas:** activar/desactivar, definir horario y zona, y reservar, consultar, cancelar o reprogramar. Horario inicial: lunes-viernes, 09:00–17:00, `America/Mexico_City`, citas de 60 minutos.
- **Privacidad:** exportar/borrar datos por contacto y configurar la retención de mensajes (`0` desactiva la limpieza automática).
- **Transferencia:** se pueden guardar los datos y compartirlos en respuesta a preguntas de pago. No se inicia ni confirma una transferencia.

La API key de DeepSeek y los datos bancarios se cifran con AES-GCM en `data/app-settings.json`, usando una clave derivada de `DB_PASSWORD` en `.env`. Conserva ese valor para descifrarlos después. Al usar DeepSeek se envían el mensaje actual, hasta 12 turnos previos del mismo chat, el carrito actual y el catálogo activo; no se transmite todo el historial ni los datos bancarios.

Las respuestas automáticas solo procesan mensajes nuevos de chats individuales: no responden historial, grupos, estados ni mensajes propios. Un carrito no reserva existencias ni cobra. Las citas se almacenan en UTC y se comprueba que no haya traslapes. Las imágenes se obtienen de URLs HTTPS cuando se envían por WhatsApp; no se suben al servidor.

## MySQL

Las migraciones numeradas están en `migrations/` y se pueden volver a ejecutar con `npm run migrate`:

- `001_initial.sql`: contactos, identificadores, chats y mensajes.
- `002`–`004`: inventario de productos/servicios e imágenes.
- `005_shopping_carts.sql`: carritos.
- `006_appointments.sql`: citas.
- `007_admin_tools.sql`: pausas de IA y pedidos.
- `008_contact_profiles.sql`: nombres visibles, etiquetas y notas de contactos.

Solo se resuelven teléfonos a partir de JID telefónicos o correspondencias PN-LID reales de WhatsApp. Los dígitos de un LID no se convierten en teléfono. Los ejemplos demo de inventario comienzan inactivos.

## Documentación oficial

- Baileys v6: https://github.com/WhiskeySockets/Baileys/tree/v6.7.24
- DeepSeek Chat Completions: https://api-docs.deepseek.com/api/create-chat-completion
- Modelos DeepSeek: https://api-docs.deepseek.com/quick_start/api_usage
