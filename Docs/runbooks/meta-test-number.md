# Runbook — Probar el Hub con el número de prueba de Meta

- **Para quién:** el owner del Hub, en su máquina local.
- **Objetivo:** recorrer el flujo real de punta a punta con la WhatsApp Cloud API de Meta:
  tu teléfono → Meta → webhook → Hub → Gemini → Graph API → tu teléfono.
- **Relacionados:** `apps/backend/src/db/configure-meta.ts` · `apps/backend/src/config/env.ts` · `docker-compose.dev.yml`

---

## 1. Qué prueba esto (y qué no)

**Prueba:**

- La verificación del webhook (`GET /webhooks/whatsapp`) y la firma HMAC de cada `POST`.
- La resolución del tenant a partir del `phone_number_id` que manda Meta.
- La respuesta de la IA gobernada (Gemini) y el envío real de texto por la Graph API.

**No prueba:**

- Clientes reales: el número de prueba solo le escribe a **hasta 5 destinatarios verificados**.
- Plantillas (templates): el Hub no envía mensajes proactivos.
- Estados de entrega (`sent` / `delivered` / `read`): el Hub los recibe y los ignora.
- Embedded Signup, verificación del negocio ni App Review.

---

## 2. Preparación en el dashboard de Meta

1. **Número de prueba.** En tu app de Meta, WhatsApp → **"Paso 1. Pruébalo"**. Copiá el
   **identificador del número de teléfono** (`phone_number_id`), el **identificador de la cuenta
   de WhatsApp Business** (WABA id) y el número tal como lo muestra Meta. Usá los del número de
   **prueba**, no los de un número de producción.
2. **Destinatario.** En el mismo paso, agregá y verificá tu propio celular como destinatario.
   Tiene que ser un **móvil peruano `+51 9XXXXXXXX`**: el Hub normaliza el remitente con
   `normalizePhoneE164` (`apps/backend/src/contacts/phone-e164.ts`), que solo acepta ese formato.
   Cualquier otro número se descarta con `INVALID_PHONE`.
3. **Token de System User.** El token temporal de la consola vence en menos de 24 h. Creá uno
   permanente: Configuración del negocio → **Usuarios del sistema** → generá un token con los
   permisos `whatsapp_business_messaging` y `whatsapp_business_management`, y asignale como
   activos **la app** y **la WABA**.
4. **App Secret.** Configuración de la app → **Básica** → copiá la **clave secreta de la app**.
   Es la que valida la firma `X-Hub-Signature-256` de cada webhook.

---

## 3. Archivo `.env`

Creá un `.env` en la raíz del repo (los scripts del backend leen `../../.env` y
`apps/backend/.env`). Está en `.gitignore`: **nunca lo commitees**. Plantilla con placeholders:

```dotenv
# --- Base de datos (Postgres de docker-compose.dev.yml, puerto 5434) ---
# <pg-password> = POSTGRES_PASSWORD de docker-compose.dev.yml
DATABASE_ADMIN_URL=postgresql://postgres:<pg-password>@localhost:5434/sivi_whatsapp_hub
# <app-rls-password> debe ser IGUAL a APP_RLS_PASSWORD (migrate lo aplica al rol app_rls)
DATABASE_URL=postgresql://app_rls:<app-rls-password>@localhost:5434/sivi_whatsapp_hub
# <app-webhook-password> debe ser IGUAL a APP_WEBHOOK_PASSWORD (rol app_webhook)
DATABASE_WEBHOOK_URL=postgresql://app_webhook:<app-webhook-password>@localhost:5434/sivi_whatsapp_hub
APP_RLS_PASSWORD=<app-rls-password>
APP_WEBHOOK_PASSWORD=<app-webhook-password>

# --- Servidor ---
AUTH_MODE=dev-header
PORT=3002
LOG_LEVEL=info

# --- WhatsApp Cloud API (globales de la app de Meta) ---
WHATSAPP_VERIFY_TOKEN=<string-largo-y-aleatorio-que-inventás-vos>
WHATSAPP_APP_SECRET=<clave-secreta-de-la-app>
# Opcional (default v21.0)
WHATSAPP_META_API_VERSION=v21.0

# --- IA ---
GEMINI_API_KEY=<tu-api-key-de-gemini>

# --- Solo para configure:meta (credenciales del número de prueba) ---
META_PHONE_NUMBER_ID=<phone-number-id-del-numero-de-prueba>
META_DISPLAY_PHONE_NUMBER=<numero-de-prueba-como-lo-muestra-meta>
META_WABA_ID=<waba-id-del-numero-de-prueba>
META_ACCESS_TOKEN=<token-del-system-user>
```

**Importante:**

- **No** definas `ENABLE_DEV_ENDPOINTS=true`. Con ese flag `apps/backend/src/main.ts` usa el
  cliente **falso** de Meta y el LLM **falso**: nada sale a Meta ni a Gemini.
- Usá el script `dev`, **no** `dev:local`. `apps/backend/dev-local.mjs` inyecta
  `ENABLE_DEV_ENDPOINTS=true` y secretos de WhatsApp de mentira para toda variable que no
  esté definida.
- `configure:meta` toma las credenciales **solo** del entorno; nunca las pases como argumentos.

---

## 4. Levantar todo (en este orden)

```bash
docker compose -f docker-compose.dev.yml up -d --wait
pnpm --filter @sivihub/whatsapp-hub-backend migrate
pnpm --filter @sivihub/whatsapp-hub-backend seed:dev
pnpm --filter @sivihub/whatsapp-hub-backend configure:meta
pnpm --filter @sivihub/whatsapp-hub-backend dev
```

`configure:meta` carga el número de prueba en el tenant de desarrollo (en una sola transacción):
actualiza su única cuenta activa de `whatsapp_accounts` (o la crea si no hay ninguna) y deja
`tenant_ai_config.enabled = true`. Imprime el `tenant_id`, el `phone_number_id` y el número;
**nunca** el token. Podés volver a correrlo cuando rotes el token: no hace falta reiniciar
`dev`, el token se lee de la base en cada envío.

> **No vuelvas a correr `seed:dev` después de `configure:meta`.** El seed vuelve a insertar la
> cuenta `dev-phone-123` y el tenant queda con dos cuentas activas (ver `MULTIPLE_ACTIVE_ACCOUNTS`
> abajo).

---

## 5. Túnel HTTPS

Meta solo llama a URLs HTTPS públicas. En otra terminal, exponé el puerto de `PORT`:

```bash
cloudflared tunnel --url http://localhost:3002
# o bien
ngrok http 3002
```

Las URLs del quick tunnel de cloudflared (y las de ngrok sin dominio fijo) **cambian en cada
ejecución**: cada vez que reinicies el túnel, actualizá la callback URL en Meta (paso 6).

---

## 6. Webhook en Meta

Con el backend y el túnel corriendo, en tu app de Meta → WhatsApp → **Configuración** → Webhook:

1. **Callback URL:** `https://<tu-tunel>/webhooks/whatsapp`
2. **Token de verificación:** el mismo valor que pusiste en `WHATSAPP_VERIFY_TOKEN`.
3. Verificá y guardá. Si el token no coincide, el Hub responde `403` y Meta rechaza la URL.
4. En **Campos del webhook**, suscribite a `messages`.

---

## 7. Primera prueba

Desde tu celular (el destinatario verificado), mandale un **mensaje de texto** al número de
prueba. **Escribís vos primero:** la IA solo responde dentro de la ventana de servicio de 24 h
y el Hub no envía plantillas. En los logs de `dev` tenés que ver `ai_reply_sent` y recibir la
respuesta en WhatsApp.

---

## 8. Troubleshooting

Los `POST` al webhook **siempre** responden `200` a Meta (para evitar reintentos en cascada),
así que los errores solo se ven en los logs del backend.

| Síntoma / log | Causa probable | Qué hacer |
|---|---|---|
| `[whatsapp-webhook] POST error` con `code: "BAD_SIGNATURE"` | `WHATSAPP_APP_SECRET` no es la clave secreta de la app que tiene el webhook. Meta no muestra error porque recibe `200`. | Copiá de nuevo la clave (Configuración de la app → Básica) y reiniciá `dev`. |
| `[whatsapp-webhook] POST error` con `code: "UNKNOWN_PHONE_NUMBER_ID"` | El `phone_number_id` que manda Meta no está en `whatsapp_accounts`: no corriste `configure:meta`, o usaste el id de otro número. | Revisá `META_PHONE_NUMBER_ID` contra "Paso 1. Pruébalo" y volvé a correr `configure:meta`. |
| `[whatsapp-webhook] POST error` con `code: "INVALID_PHONE"` | Le escribiste desde un número que no es móvil peruano (`+51 9XXXXXXXX`). | Usá un destinatario verificado con celular peruano. |
| `ai_reply_skipped reason=AI_DISABLED` | El tenant no tiene `tenant_ai_config` habilitado. | Volvé a correr `configure:meta`. |
| `ai_reply_skipped reason=WINDOW_CLOSED` | No hay un mensaje entrante del contacto en las últimas 24 h. | Escribí vos primero desde tu celular. |
| `ai_reply_failed reason=SEND_FAILED` con `error.code: "WINDOW_CLOSED"` | Meta rechazó el envío porque la ventana de 24 h está cerrada de su lado. | Escribí de nuevo desde tu celular y reintentá. |
| `ai_reply_failed reason=SEND_FAILED` con `error.code: "META_API_ERROR"` | Meta rechazó el envío. La causa más común es el token vencido o inválido (Meta responde `401`), por ejemplo si usaste el token temporal de la consola. El Hub no loguea el código de Meta. | Generá un token de System User (paso 2.3) y volvé a correr `configure:meta`. Revisá también que el System User tenga asignada la WABA. |
| `ai_reply_failed reason=SEND_FAILED` con `error.code: "MULTIPLE_ACTIVE_ACCOUNTS"` | El tenant tiene más de una cuenta activa, típicamente por correr `seed:dev` después de `configure:meta`. | Marcá con `deleted_at` la fila sobrante de `whatsapp_accounts` y volvé a correr `configure:meta`. |
| `ai_reply_failed reason=LLM_FAILED` o `ai_reply_failed LLM threw unexpectedly` | Falla de Gemini, por ejemplo falta `GEMINI_API_KEY` o es inválida. | Revisá `GEMINI_API_KEY` y reiniciá `dev`. |
| No llega nada a los logs | El túnel cambió de URL, el backend no está corriendo o no estás suscripto a `messages`. | Revisá los pasos 5 y 6. |
