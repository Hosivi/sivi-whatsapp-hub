# Runbook — Probar el Hub con el número de prueba de Meta

- **Para quién:** el owner del Hub, en su máquina local.
- **Objetivo:** recorrer el flujo real de punta a punta con la WhatsApp Cloud API de Meta:
  tu teléfono → Meta → webhook → Hub → respuesta fija (o Gemini, si activas la IA) →
  Graph API → tu teléfono.
- **Relacionados:** `apps/backend/src/db/configure-meta.ts` · `apps/backend/src/config/env.ts` ·
  `apps/backend/src/fixed-replies/` · `docker-compose.dev.yml`

---

## 1. Qué prueba esto (y qué no)

**Prueba:**

- La verificación del webhook (`GET /webhooks/whatsapp`) y la firma HMAC de cada `POST`.
- La resolución del tenant a partir del `phone_number_id` que manda Meta.
- Las respuestas fijas (saludo, horario y derivación a un asesor) y el envío real de texto por
  la Graph API. Con la configuración por defecto el Hub **no** usa la IA: hasta que entre el
  agente de SiviHub (etapa E4) solo contesta con respuestas fijas.
- Opcional: la respuesta de la IA gobernada (Gemini), si la activas a propósito (sección 7.2).

**No prueba:**

- Clientes reales: el número de prueba solo le escribe a **hasta 5 destinatarios verificados**.
- Plantillas (templates): el Hub no envía mensajes proactivos.
- Estados de entrega (`sent` / `delivered` / `read`): el Hub los recibe y los ignora.
- Embedded Signup, verificación del negocio ni App Review.

---

## 2. Preparación en el dashboard de Meta

1. **Número de prueba.** En tu app de Meta, entra a WhatsApp → **"Paso 1. Pruébalo"**. Copia el
   **identificador del número de teléfono** (`phone_number_id`), el **identificador de la cuenta
   de WhatsApp Business** (WABA id) y el número tal como lo muestra Meta. Usa los del número de
   **prueba**, no los de un número de producción.
2. **Destinatario.** En el mismo paso, agrega y verifica tu propio celular como destinatario.
   Tiene que ser un **móvil peruano `+51 9XXXXXXXX`**: el Hub normaliza el remitente con
   `normalizePhoneE164` (`apps/backend/src/contacts/phone-e164.ts`), que solo acepta ese formato.
   Cualquier otro número se descarta con `INVALID_PHONE`.
3. **Token de System User.** El token temporal de la consola vence en menos de 24 h. Crea uno
   permanente: Configuración del negocio → **Usuarios del sistema** → genera un token con los
   permisos `whatsapp_business_messaging` y `whatsapp_business_management`, y asígnale como
   activos **la app** y **la WABA**.
4. **App Secret.** Configuración de la app → **Básica** → copia la **clave secreta de la app**.
   Es la que valida la firma `X-Hub-Signature-256` de cada webhook.

---

## 3. Archivo `.env`

Crea un `.env` en la raíz del repo (los scripts del backend leen `../../.env` y
`apps/backend/.env`). Está en `.gitignore`: **nunca lo subas al repositorio**. Plantilla con
placeholders:

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
WHATSAPP_VERIFY_TOKEN=<string-largo-y-aleatorio-que-inventas-tú>
WHATSAPP_APP_SECRET=<clave-secreta-de-la-app>
# Opcional (default v21.0)
WHATSAPP_META_API_VERSION=v21.0

# --- IA (apagada por defecto; ver sección 7.2) ---
# Solo el valor literal "true" la enciende. Apagada, el Hub responde solo con respuestas fijas.
AI_REPLY_ENABLED=false
# Solo hace falta si enciendes la IA.
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
- Usa el script `dev`, **no** `dev:local`. `apps/backend/dev-local.mjs` inyecta
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

`seed:dev` crea el tenant de desarrollo con la IA apagada y con su fila de
`tenant_reply_settings` (nombre del negocio y horario), que usan las respuestas fijas.

`configure:meta` carga el número de prueba en el tenant de desarrollo (en una sola transacción):
actualiza su única cuenta activa de `whatsapp_accounts` (o la crea si no hay ninguna) y se
asegura de que exista su `tenant_ai_config`, **sin encender la IA**: deja la fila como está o,
si no existe, la crea con `enabled = false`. Imprime el `tenant_id`, el `phone_number_id` y el
número; **nunca** el token. Puedes volver a correrlo cuando rotes el token: no hace falta
reiniciar `dev`, el token se lee de la base en cada envío.

> **No vuelvas a correr `seed:dev` después de `configure:meta`.** El seed vuelve a insertar la
> cuenta `dev-phone-123` y el tenant queda con dos cuentas activas (ver `MULTIPLE_ACTIVE_ACCOUNTS`
> abajo).

---

## 5. Túnel HTTPS

Meta solo llama a URLs HTTPS públicas. En otra terminal, expón el puerto de `PORT`:

```bash
cloudflared tunnel --url http://localhost:3002
# o bien
ngrok http 3002
```

Las URLs del quick tunnel de cloudflared (y las de ngrok sin dominio fijo) **cambian en cada
ejecución**: cada vez que reinicies el túnel, actualiza la callback URL en Meta (paso 6).

---

## 6. Webhook en Meta

Con el backend y el túnel corriendo, en tu app de Meta → WhatsApp → **Configuración** → Webhook:

1. **Callback URL:** `https://<tu-tunel>/webhooks/whatsapp`
2. **Token de verificación:** el mismo valor que pusiste en `WHATSAPP_VERIFY_TOKEN`.
3. Verifica y guarda. Si el token no coincide, el Hub responde `403` y Meta rechaza la URL.
4. En **Campos del webhook**, suscríbete a `messages`.

---

## 7. Primera prueba

### 7.1 Respuestas fijas (configuración por defecto)

Desde tu celular (el destinatario verificado), envía un **mensaje de texto** al número de
prueba. **Escribe tú primero:** el Hub solo responde dentro de la ventana de servicio de 24 h
y no envía plantillas.

| Escribes | Recibes | Log en `dev` |
|---|---|---|
| Tu primer texto en 24 h, por ejemplo "Hola" | El saludo con el menú: «¡Hola! Gracias por escribir a Tienda Dev (seed). Responde 1 para ver nuestro horario o 2 para hablar con un asesor.» | `fixed_reply_sent kind=greeting` |
| `1`, o una palabra como "horario" o "¿a qué hora abren?" | El horario del negocio | `fixed_reply_sent kind=hours` |
| `2`, o una palabra como "asesor" o "persona" | «Listo, un asesor te responderá por este chat en cuanto esté disponible.» | `fixed_reply_sent kind=handoff` |
| Cualquier otro texto después del primero, por ejemplo "gracias" | Nada: el Hub no contesta todos los mensajes | `fixed_reply_skipped reason=NO_MATCH` |

El saludo sale solo con el primer texto de las últimas 24 h. Si ya le escribiste antes al
número de prueba, envía `1` o `2` para ver una respuesta.

Para cambiar los textos del tenant de desarrollo, edita su fila de `tenant_reply_settings`
(por ahora no hay pantalla ni API). Por ejemplo:

```bash
docker compose -f docker-compose.dev.yml exec postgres psql -U postgres -d sivi_whatsapp_hub -c \
  "UPDATE tenant_reply_settings SET hours_text = 'lunes a sábado, de 9:00 a 20:00', updated_at = now()
   WHERE tenant_id = '00000000-0000-0000-0000-000000000001' AND deleted_at IS NULL;"
```

Columnas: `business_name` (`{negocio}`), `hours_text` (`{horario}`), `greeting_text` y
`handoff_text` (textos propios; pueden usar `{negocio}` y `{horario}`) y `enabled`
(`false` = sin respuestas fijas para el tenant). Los cambios se aplican desde el siguiente
mensaje, sin reiniciar `dev`.

### 7.2 Probar la IA (opcional)

La IA está apagada por dos llaves, y `configure:meta` ya no enciende ninguna. Para probarla:

1. En el `.env`, define `AI_REPLY_ENABLED=true` y una `GEMINI_API_KEY` válida.
2. Habilita la fila de `tenant_ai_config` del tenant de desarrollo:

   ```bash
   docker compose -f docker-compose.dev.yml exec postgres psql -U postgres -d sivi_whatsapp_hub -c \
     "UPDATE tenant_ai_config SET enabled = true, updated_at = now()
      WHERE tenant_id = '00000000-0000-0000-0000-000000000001' AND deleted_at IS NULL;"
   ```

3. Reinicia `dev` (el `.env` se lee al arrancar) y escribe desde tu celular. En los logs tienes
   que ver `ai_reply_sent` y recibir la respuesta en WhatsApp. Con la IA encendida **no** salen
   respuestas fijas: cada mensaje lo atiende solo uno de los dos caminos.

Al terminar, vuelve a `AI_REPLY_ENABLED=false` y reinicia `dev`.

---

## 8. Troubleshooting

Los `POST` al webhook **siempre** responden `200` a Meta (para evitar reintentos en cascada),
así que los errores solo se ven en los logs del backend.

| Síntoma / log | Causa probable | Qué hacer |
|---|---|---|
| `[whatsapp-webhook] POST error` con `code: "BAD_SIGNATURE"` | `WHATSAPP_APP_SECRET` no es la clave secreta de la app que tiene el webhook. Meta no muestra error porque recibe `200`. | Copia de nuevo la clave (Configuración de la app → Básica) y reinicia `dev`. |
| `[whatsapp-webhook] POST error` con `code: "UNKNOWN_PHONE_NUMBER_ID"` | El `phone_number_id` que manda Meta no está en `whatsapp_accounts`: no corriste `configure:meta`, o usaste el id de otro número. | Revisa `META_PHONE_NUMBER_ID` contra "Paso 1. Pruébalo" y vuelve a correr `configure:meta`. |
| `[whatsapp-webhook] POST error` con `code: "INVALID_PHONE"` | Le escribiste desde un número que no es móvil peruano (`+51 9XXXXXXXX`). | Usa un destinatario verificado con celular peruano. |
| Recibes respuestas fijas y no de la IA; en los logs ves `fixed_reply_*` y ningún `ai_reply_*` | Es lo esperado: `AI_REPLY_ENABLED` no vale `true` (IA apagada, el valor por defecto) y el Hub solo usa respuestas fijas. | Nada, salvo que quieras probar la IA: sigue la sección 7.2. |
| `fixed_reply_skipped reason=NO_MATCH` | El texto no es el primero de las últimas 24 h, ni `1` o `2`, ni trae una palabra de horario o de asesor. El Hub no contesta todos los mensajes. | Envía `1` o `2`. |
| `fixed_reply_skipped reason=DISABLED` | La fila de `tenant_reply_settings` del tenant tiene `enabled = false`. | Ponla en `true` por SQL (sección 7.1). |
| `fixed_reply_skipped reason=WINDOW_CLOSED` | No hay un mensaje entrante del contacto en las últimas 24 h; por ejemplo, Meta reenvió un mensaje antiguo. | Escribe de nuevo desde tu celular. |
| `fixed_reply_failed reason=DB_ERROR` | Falló la base de datos; lo más común es no haber corrido `migrate` después de actualizar el código (falta la tabla `tenant_reply_settings`). | Corre `migrate` y reinicia `dev`. |
| `ai_reply_skipped reason=AI_DISABLED` | Con `AI_REPLY_ENABLED=true`, la fila de `tenant_ai_config` del tenant no existe o tiene `enabled = false` (el valor por defecto). `configure:meta` ya no la habilita. | Habilítala por SQL (sección 7.2). |
| `ai_reply_skipped reason=WINDOW_CLOSED` | No hay un mensaje entrante del contacto en las últimas 24 h. | Escribe tú primero desde tu celular. |
| `fixed_reply_failed` o `ai_reply_failed` con `reason=SEND_FAILED` y `error.code: "WINDOW_CLOSED"` | Meta rechazó el envío porque la ventana de 24 h está cerrada de su lado. | Escribe de nuevo desde tu celular y vuelve a intentarlo. |
| `fixed_reply_failed` o `ai_reply_failed` con `reason=SEND_FAILED` y `error.code: "META_API_ERROR"` | Meta rechazó el envío. La causa más común es el token vencido o inválido (Meta responde `401`), por ejemplo si usaste el token temporal de la consola. El Hub no registra el código de Meta en los logs. | Genera un token de System User (paso 2.3) y vuelve a correr `configure:meta`. Revisa también que el System User tenga asignada la WABA. |
| `fixed_reply_failed` o `ai_reply_failed` con `reason=SEND_FAILED` y `error.code: "MULTIPLE_ACTIVE_ACCOUNTS"` | El tenant tiene más de una cuenta activa, típicamente por correr `seed:dev` después de `configure:meta`. | Marca con `deleted_at` la fila sobrante de `whatsapp_accounts` y vuelve a correr `configure:meta`. |
| `ai_reply_failed reason=LLM_FAILED` o `ai_reply_failed LLM threw unexpectedly` | Con la IA encendida, falla Gemini; por ejemplo, falta `GEMINI_API_KEY` o es inválida. | Revisa `GEMINI_API_KEY` y reinicia `dev`. |
| No llega nada a los logs | El túnel cambió de URL, el backend no está corriendo o no estás suscrito a `messages`. | Revisa los pasos 5 y 6. |
