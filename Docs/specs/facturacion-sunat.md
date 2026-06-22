# Spec — Facturación electrónica SUNAT

- **Estado:** Borrador v1
- **Corte:** 3 — Ventas y cobros (post-pago)
- **ADR de referencia:** `../adr/0001-facturacion-electronica-nubefact-pse.md`
- **PRD:** `../prd.md` §7.3

> **Aviso normativo**: las cifras tributarias de este documento (cuotas NRUS, umbrales de categoría, porcentaje de retención RHE, UIT 2026) reflejan la normativa vigente a junio de 2026 y **deben verificarse contra fuentes oficiales de SUNAT antes de cualquier despliegue productivo**. Externalizarlas como constantes configurables, no hardcodeadas.

---

## 1. Objetivo

Emitir automáticamente (o asistir la emisión de) el Comprobante de Pago Electrónico (CPE) correcto según el régimen tributario del tenant y el tipo de receptor, inmediatamente después de que la pasarela de pago confirme el cobro. El comprobante se persiste solo cuando SUNAT lo acepta (CDR).

---

## 2. Glosario

| Término | Definición |
|---|---|
| **SUNAT** | Superintendencia Nacional de Aduanas y de Administración Tributaria (Perú) |
| **RUC** | Registro Único de Contribuyentes. 11 dígitos: `10` = persona natural, `20` = empresa |
| **CPE** | Comprobante de Pago Electrónico |
| **CDR** | Constancia de Recepción — respuesta de SUNAT al PSE con `aceptada_por_sunat`, `enlace_del_pdf`, `codigo_hash` |
| **SEE** | Sistema de Emisión Electrónica (plataforma SUNAT) |
| **SEE-SOL** | Portal web de SUNAT para emisión manual por el contribuyente |
| **PSE** | Proveedor de Servicios Electrónicos — genera el XML UBL 2.1, lo firma y lo envía a SUNAT |
| **OSE** | Operador de Servicios Electrónicos — pre-valida antes de SUNAT; solo PRICOS (ingresos > 300 UIT ≈ S/1.65 M/año) |
| **UBL 2.1** | Formato XML estándar para comprobantes electrónicos en Perú |
| **IGV** | Impuesto General a las Ventas (18 %) |
| **RHE** | Recibo por Honorarios Electrónico. Serie E001, correlativo gestionado por SUNAT |
| **NRUS** | Nuevo Régimen Único Simplificado — solo personas naturales y sucesiones indivisas; solo boletas/tickets |
| **RMT** | Régimen MYPE Tributario |
| **RER** | Régimen Especial de Renta |
| **RG** | Régimen General |
| **4TA** | 4ta categoría — profesionales independientes (médicos, psicólogos, abogados, contadores, ingenieros, etc.) |
| **Clave SOL** | Credencial SUNAT del contribuyente para acceder a SOL |
| **UIT 2026** | S/5,500 (unidad impositiva tributaria vigente) |
| **MYPE** | Micro y Pequeña Empresa |
| **PRICO** | Principal Contribuyente (ingresos > 300 UIT) |
| **Nubefact** | PSE elegido. RUC: 20600695771 |

---

## 3. Regímenes tributarios — resumen operativo

| Régimen | Quiénes | CPE permitidos | Mecanismo Hub | Límites clave |
|---|---|---|---|---|
| **NRUS Cat. 1** | Personas nat. / sucesiones indivisas | Boletas, tickets | Semi-asistido (SEE-SOL) | Ingresos ≤ S/5,000/mes |
| **NRUS Cat. 2** | Ídem | Boletas, tickets | Semi-asistido (SEE-SOL) | Ingresos ≤ S/8,000/mes |
| **NRUS Especial** | Agrarios / pescadores artesanales | Boletas, tickets | Semi-asistido (SEE-SOL) | Ingresos ≤ S/60,000/año; cuota S/0 |
| **RMT** | MYPEs — el régimen más común del segmento | Facturas + boletas | Automático (Nubefact) | — |
| **RER** | MYPEs con actividades permitidas | Facturas + boletas | Automático (Nubefact) | — |
| **RG** | Cualquier empresa | Facturas + boletas | Automático (Nubefact) | — |
| **4TA** | Profesionales independientes | RHE (serie E001) | Semi-automático (notificación WA) | Retención 8 % si recibo > S/1,500 y pagador es agente de retención |
| **RUC 20 + médicos** | Clínicas, centros médicos | Facturas + boletas | Automático (Nubefact) | — |

### 3.1 Restricciones NRUS (validar antes de emisión)

- Solo personas naturales y sucesiones indivisas (RUC comenzando en `10`).
- Un solo establecimiento.
- Máximo 5 trabajadores por turno.
- Activos fijos ≤ S/70,000 (excluye predios y vehículos).
- **No pueden emitir facturas** — solo boletas/tickets.
- Límite anual S/96,000.
- Si en un mes supera S/8,000 → debe cambiar a RMT o RER el mes siguiente. El Hub alerta cuando el volumen acumulado supera el 80 % del límite de categoría.

### 3.2 Retención RHE (4ta categoría)

- Retención del 8 % sobre el monto bruto del recibo.
- Aplica cuando: el recibo supera **S/1,500** Y el pagador es **agente de retención** (empresa o persona jurídica con obligación de retener).
- **No aplica** si el cliente es persona natural sin actividad empresarial.
- Suspensión de retención: si la proyección de ingresos anuales del profesional es ≤ S/48,125 (aprox. 8.75 UIT), puede solicitar la suspensión mediante el Formulario Virtual 1609 en SOL. El Hub informa esta opción al profesional en la notificación.
- Umbral mensual orientativo sin retención: ≈ S/3,062 (≈ 7 UIT ÷ 12; verificar con SUNAT).
- El profesional debe registrar el pago del RHE ante SUNAT antes del **10mo día hábil del mes siguiente**.

---

## 4. Algoritmo de determinación del tipo de CPE

Se ejecuta en cada transacción, nunca en onboarding. Función pura, sin efectos secundarios:

```typescript
// packages/domain/billing/determine-cpe-type.ts

type CpeType =
  | "factura"
  | "boleta"
  | "boleta_asistida"   // NRUS: genera resumen para SEE-SOL
  | "rhe_notificacion_manual"; // 4ta cat: notifica al profesional

interface Receptor {
  tipoDoc: "1" | "6" | "0"; // 1=DNI, 6=RUC, 0=sin documento
  numDoc: string;
}

function determineCpeType(tenantRegime: string, receptor: Receptor): CpeType {
  if (tenantRegime.startsWith("NRUS")) return "boleta_asistida";
  if (tenantRegime === "4TA") return "rhe_notificacion_manual";
  if (receptor.tipoDoc === "6" && receptor.numDoc.length === 11) return "factura";
  return "boleta";
}
```

**Regla crítica**: el comprobante se persiste en `billing.comprobantes` **solo cuando SUNAT acepta el CDR** (`aceptada_por_sunat: true`). Nunca antes.

---

## 5. Flujo post-pago: RMT / RER / RG (automático)

```
POST /webhooks/culqi (o /webhooks/izipay)
  │
  ├─ 1. Verificar HMAC de la pasarela
  ├─ 2. Buscar pago pendiente por referencia
  ├─ 3. Marcar pago como `paid`
  ├─ 4. determineCpeType(tenant.regime, receptor)
  ├─ 5. Si factura → consultarRucSunat(receptor.numDoc)  // valida RUC activo/habido
  ├─ 6. POST https://api.nubefact.com/api/v1/documento
  │       Authorization: Bearer {tenant.decryptedPseToken}
  │       Body: { serie, correlativo, tipo_de_comprobante, ... }
  ├─ 7. Recibir CDR: { aceptada_por_sunat, enlace_del_pdf, codigo_hash }
  ├─ 8. Persistir billing.comprobantes { estado: "aceptado", pdf_url, cdr_hash }
  ├─ 9. Enviar template WhatsApp UTILITY al cliente con el link PDF
  └─ 10. Actualizar el vertical (venta confirmada)
```

**Errores y reintentos**: si Nubefact devuelve error o timeout, el evento queda en cola `pg-boss` con reintento exponencial (3 intentos, backoff 30 s / 2 min / 10 min). Si el CDR demora (SUNAT acepta asincrónico), el worker consulta el estado cada 5 minutos hasta `aceptada_por_sunat: true` o 3 horas (luego alerta manual).

---

## 6. Flujo NRUS (semi-asistido)

```
POST /webhooks/culqi
  │
  ├─ 1. Verificar HMAC
  ├─ 2. Marcar pago como `paid`
  ├─ 3. determineCpeType → "boleta_asistida"
  ├─ 4. Generar resumen de datos de la boleta (JSON estructurado)
  │       { fecha, cliente, descripcion, monto, igv, total }
  ├─ 5. Guardar en billing.comprobantes { estado: "pendiente_see_sol" }
  ├─ 6. Notificar al tenant (dueño) por WhatsApp/dashboard:
  │       "Pago recibido. Ingresá estos datos en SUNAT SEE-SOL para emitir la boleta."
  │       + datos estructurados + link directo a SOL
  ├─ 7. Tenant emite la boleta manualmente en SEE-SOL
  └─ 8. (Opcional) Tenant sube el PDF al Hub → Hub reenvía al cliente por WA
```

**Contador de ventas NRUS**: worker diario suma ingresos del mes corriente. Cuando supera el 80 % del límite de categoría → alerta WhatsApp al tenant. Cuando supera el 100 % → alerta urgente + guía de cambio de régimen a RMT/RER.

---

## 7. Flujo 4ta categoría / RHE (semi-automático)

```
POST /webhooks/culqi
  │
  ├─ 1. Verificar HMAC
  ├─ 2. Marcar pago como `paid`
  ├─ 3. determineCpeType → "rhe_notificacion_manual"
  ├─ 4. Guardar billing.comprobantes { estado: "pendiente_rhe" }
  ├─ 5. Notificar al CLIENTE vía WhatsApp UTILITY:
  │       "Pago recibido. Tu recibo de honorarios está siendo preparado."
  ├─ 6. Notificar al PROFESIONAL (tenant) vía WhatsApp:
  │       - Link directo a SUNAT SOL (emitir RHE)
  │       - Datos del cliente (nombre, DNI/RUC, dirección)
  │       - Descripción sugerida del servicio
  │       - Monto, fecha, ¿aplica retención 8%? (lógica de retención incluida)
  │       - Recordatorio: "Registrá el pago ante SUNAT antes del día 10 hábil del mes siguiente"
  ├─ 7. Profesional emite el RHE en SOL (acción manual)
  ├─ 8. Profesional puede subir el PDF al Hub (botón en dashboard)
  │       → Hub reenvía al cliente vía WhatsApp
  │   O bien: el cliente descarga el RHE directamente desde SUNAT
  └─ 9. Job recordatorio: si a día 8 del mes siguiente el estado sigue
        "pendiente_rhe" → nuevo WhatsApp al profesional recordando el plazo
```

---

## 8. Onboarding de facturación por régimen

El wizard de configuración fiscal se ejecuta una vez al activar el módulo de pagos/facturación.

### 8.1 Paso 1 — Verificación del RUC del tenant

- El tenant ingresa su RUC (11 dígitos).
- El Hub consulta la API de SUNAT (`https://e-consulta.sunat.gob.pe/...` o equivalente) para confirmar: estado activo, condición `habido`, régimen tributario.
- Branch por régimen:
  - **NRUS**: explicar límites + flujo SEE-SOL + ofrecer camino de upgrade a RMT.
  - **RMT / RER / RG**: continuar con configuración de Nubefact.
  - **4TA**: configurar flujo semi-automático RHE + informar sobre retención y plazos.

### 8.2 Paso 2 — Alta de Nubefact en SUNAT SOL (solo RMT/RER/RG)

Guía paso a paso en el dashboard:

1. Ingresar a [sunat.gob.pe](https://sunat.gob.pe) → SOL → con Clave SOL.
2. Menú: Empresas → Comprobantes de Pago → Comprobantes Electrónicos → Emisor Electrónico.
3. Opción "Alta de PSE". Ingresar RUC de Nubefact: **20600695771**.
4. Confirmar las series que Nubefact administrará: `F001` (facturas), `B001` (boletas).
5. Aceptar. El alta es inmediata.

> La serie `E001` (RHE) es gestionada exclusivamente por SUNAT; no se delega a ningún PSE.

### 8.3 Paso 3 — Cuenta Nubefact + API token (solo RMT/RER/RG)

1. Crear cuenta en [nubefact.com](https://nubefact.com) con el RUC del negocio.
2. En el dashboard de Nubefact: Configuración → API → copiar el token de producción.
3. Pegar el token en el Hub → se almacena cifrado con AES-256-GCM.
4. El Hub auto-configura las series: `F001` para facturas, `B001` para boletas.

### 8.4 Configuración del Hub (post-onboarding)

- El Hub consulta el RUC SUNAT para validar la dirección fiscal y la razón social del tenant.
- `billing.tenant_billing_config` se crea/actualiza con regime, series, y token cifrado.

---

## 9. Modelo de dominio

### 9.1 Schema: `billing`

#### `billing.tenant_billing_config`

| Columna | Tipo | Descripción |
|---|---|---|
| `id` | `UUID PK` | `gen_random_uuid()` |
| `tenant_id` | `UUID NOT NULL` | FK a `core.tenants`; RLS por `tenant_isolation` |
| `ruc` | `TEXT NOT NULL` | RUC del tenant (11 dígitos) |
| `razon_social` | `TEXT NOT NULL` | Razón social oficial (SUNAT) |
| `regime` | `TEXT NOT NULL` | `NRUS_CAT1`, `NRUS_CAT2`, `NRUS_ESPEC`, `RMT`, `RER`, `RG`, `4TA` |
| `encrypted_pse_token` | `TEXT` | Token Nubefact cifrado con AES-256-GCM. NULL si NRUS o 4TA |
| `key_version` | `INTEGER NOT NULL DEFAULT 1` | Versión de la clave maestra de cifrado (para rotación) |
| `series_factura` | `TEXT DEFAULT 'F001'` | Serie para facturas (Nubefact). NULL si NRUS o 4TA |
| `series_boleta` | `TEXT DEFAULT 'B001'` | Serie para boletas (Nubefact). NULL si NRUS o 4TA |
| `pse_provider` | `TEXT DEFAULT 'nubefact'` | PSE utilizado |
| `onboarding_completed_at` | `TIMESTAMPTZ` | Fecha de finalización del wizard |
| `created_at` | `TIMESTAMPTZ NOT NULL DEFAULT now()` | |
| `updated_at` | `TIMESTAMPTZ NOT NULL DEFAULT now()` | |
| `deleted_at` | `TIMESTAMPTZ` | Soft-delete |

#### `billing.comprobantes`

| Columna | Tipo | Descripción |
|---|---|---|
| `id` | `UUID PK` | `gen_random_uuid()` |
| `tenant_id` | `UUID NOT NULL` | RLS |
| `payment_id` | `UUID NOT NULL` | FK a `payments.payments` |
| `cpe_type` | `TEXT NOT NULL` | `factura`, `boleta`, `boleta_asistida`, `rhe_notificacion_manual` |
| `serie` | `TEXT` | Ej.: `F001`, `B001`. NULL para RHE |
| `correlativo` | `INTEGER` | Asignado por Nubefact o SUNAT SOL |
| `estado` | `TEXT NOT NULL` | `pendiente`, `aceptado`, `rechazado`, `pendiente_see_sol`, `pendiente_rhe` |
| `receptor_tipo_doc` | `TEXT` | `1`=DNI, `6`=RUC, `0`=sin doc |
| `receptor_num_doc` | `TEXT` | DNI o RUC del receptor |
| `receptor_nombre` | `TEXT` | Nombre/razón social |
| `monto_total` | `NUMERIC(12,2) NOT NULL` | Total del comprobante |
| `igv` | `NUMERIC(12,2)` | IGV calculado (18 %). NULL si exonerado |
| `cdr_hash` | `TEXT` | Hash del CDR de SUNAT |
| `pdf_url` | `TEXT` | Link al PDF (Nubefact CDR o subido por tenant) |
| `nubefact_raw_response` | `JSONB` | Respuesta completa de Nubefact (para auditoría) |
| `emitted_at` | `TIMESTAMPTZ` | Timestamp de aceptación por SUNAT |
| `created_at` | `TIMESTAMPTZ NOT NULL DEFAULT now()` | |
| `updated_at` | `TIMESTAMPTZ NOT NULL DEFAULT now()` | |
| `deleted_at` | `TIMESTAMPTZ` | Soft-delete |

#### `billing.nrus_monthly_sales`

Tabla de conteo para alertas de límite NRUS.

| Columna | Tipo | Descripción |
|---|---|---|
| `id` | `UUID PK` | |
| `tenant_id` | `UUID NOT NULL` | RLS |
| `year` | `INTEGER NOT NULL` | |
| `month` | `INTEGER NOT NULL` | 1–12 |
| `total_sales` | `NUMERIC(12,2) NOT NULL DEFAULT 0` | Suma de ventas del mes |
| `alert_80_sent_at` | `TIMESTAMPTZ` | Timestamp de alerta 80 % enviada |
| `alert_100_sent_at` | `TIMESTAMPTZ` | Timestamp de alerta 100 % enviada |
| `UNIQUE` | `(tenant_id, year, month)` | Un registro por tenant/mes |

### 9.2 Índices

```sql
-- billing.comprobantes
CREATE INDEX ON billing.comprobantes (tenant_id, estado);
CREATE INDEX ON billing.comprobantes (payment_id);
CREATE INDEX ON billing.comprobantes (emitted_at DESC);

-- billing.nrus_monthly_sales
CREATE UNIQUE INDEX ON billing.nrus_monthly_sales (tenant_id, year, month);
```

### 9.3 RLS

Todas las tablas del schema `billing` incluyen `tenant_id` y la política `tenant_isolation`:

```sql
ALTER TABLE billing.tenant_billing_config ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON billing.tenant_billing_config
  USING (tenant_id = current_setting('app.current_tenant')::uuid);
-- (ídem para comprobantes y nrus_monthly_sales)
```

El middleware Hono ejecuta `SET LOCAL app.current_tenant = '<uuid>'` por cada request. **Nunca `WHERE tenant_id`** explícito en queries de la app.

---

## 10. Componentes de la capa de aplicación

### 10.1 `packages/domain/billing/`

| Módulo | Responsabilidad |
|---|---|
| `determine-cpe-type.ts` | Función pura `determineCpeType(regime, receptor): CpeType` |
| `calculate-rhe-retention.ts` | Función pura; determina si aplica retención 8 % y el monto |
| `billing-config.ts` | Entidad de dominio `TenantBillingConfig`; invariantes |
| `comprobante.ts` | Entidad de dominio `Comprobante`; estado machine |

### 10.2 `apps/backend/src/infrastructure/pse/`

| Módulo | Responsabilidad |
|---|---|
| `nubefact.adapter.ts` | `NubefactAdapter`: POST a Nubefact API, mapear CDR, gestionar errores → `Result<Cdr, PseError>` |
| `token-encryption.ts` | `encryptPseToken` / `decryptPseToken` con AES-256-GCM; usa `PSE_ENCRYPTION_KEY` de env |
| `sunat-ruc.adapter.ts` | `consultarRucSunat(ruc): Result<RucInfo, SunatError>` — valida RUC activo/habido y obtiene razón social |

### 10.3 `apps/backend/src/application/billing/`

| Caso de uso | Trigger |
|---|---|
| `emitirCpeAutomaticoUseCase` | Llamado por el webhook handler de Culqi/Izipay tras marcar pago como `paid` |
| `generarResumenNrusUseCase` | Para boleta asistida NRUS: devuelve el JSON con datos para SEE-SOL |
| `notificarRheUseCase` | Envía WhatsApp al profesional + cliente (4ta cat.) |
| `registrarPseTokenUseCase` | Cifra y persiste el token de Nubefact del tenant |
| `completarOnboardingFiscalUseCase` | Ejecuta el wizard: consulta SUNAT, valida regime, persiste config |

### 10.4 Jobs del worker (`apps/backend/worker.ts`)

| Job | Frecuencia | Descripción |
|---|---|---|
| `checkPendingCdr` | Cada 5 minutos | Re-consulta a Nubefact comprobantes con estado `pendiente`; actualiza si CDR llegó |
| `nrusMonthlySalesAlert` | Diario | Suma ventas NRUS del mes corriente; envía alerta al 80 % y 100 % del límite de categoría |
| `rhe_payment_reminder` | Diario | Si día 7-9 del mes y hay `comprobantes` en estado `pendiente_rhe`, envía recordatorio WhatsApp al profesional |
| `retryFailedCpe` | Cada 30 minutos | Re-intenta emisión de comprobantes en estado `pendiente` con error; backoff exponencial (max 3 reintentos) |

---

## 11. Seguridad

- El token de Nubefact se cifra con **AES-256-GCM** en la capa de aplicación antes de persistir en `billing.tenant_billing_config.encrypted_pse_token`. La clave maestra se inyecta desde `PSE_ENCRYPTION_KEY` en el entorno (nunca en la DB).
- El campo `key_version` permite rotación de clave sin pérdida de tokens históricos.
- La clave `PSE_ENCRYPTION_KEY` tiene 32 bytes aleatorios y se rota cada 12 meses (definir procedimiento en runbook).
- El webhook de Culqi/Izipay se valida con **HMAC-SHA256** antes de procesar cualquier evento.
- La columna `nubefact_raw_response` (JSONB de auditoría) nunca expone el token en texto plano; el adapter lo elimina del response antes de persistir.

---

## 12. Errores y `Result<T, E>`

Todos los casos de uso del dominio retornan `Result<T, E>` (nunca `throw`). El adaptador Hono (`onError`) captura excepciones de infraestructura.

Tipos de error del módulo:

```typescript
type BillingError =
  | { kind: "pse_rejected"; sunat_code: string; description: string }
  | { kind: "pse_timeout"; attempts: number }
  | { kind: "ruc_invalid"; ruc: string }
  | { kind: "ruc_inactive" }
  | { kind: "token_decryption_failed" }
  | { kind: "regime_not_supported"; regime: string }
  | { kind: "cpe_already_emitted"; comprobante_id: string };
```

---

## 13. Pruebas

- `determine-cpe-type.test.ts`: cobertura 100 % de ramas del algoritmo (todos los regímenes × tipos de receptor).
- `calculate-rhe-retention.test.ts`: casos límite (exactamente S/1,500; agente vs. no-agente; con y sin suspensión).
- `nubefact.adapter.test.ts`: mock de la API Nubefact; CDR aceptado, CDR rechazado, timeout, red caída.
- `emitir-cpe-automatico.use-case.test.ts`: integración con Postgres (test DB); webhook → comprobante persistido.
- `nrus-monthly-sales-alert.job.test.ts`: cubierto con mock del servicio de alertas WhatsApp.

---

## 14. Preguntas abiertas

- ¿La consulta de RUC SUNAT usa la API REST pública (`https://api.sunat.gob.pe`) o scraping de `e-consulta.sunat.gob.pe`? Evaluar disponibilidad y términos de uso antes de implementar.
- ¿El correlativo de Nubefact se gestiona desde la respuesta del CDR o se pre-consulta con la API de Nubefact para asignar número local antes de enviar?
- ¿El Hub guarda el XML UBL 2.1 del comprobante para auditoría propia, además del CDR? (Nubefact lo guarda por 5 años per ley, pero conviene validar la política de retención antes de decidir no guardar una copia local.)
- Para tenants 4ta cat. que son personas naturales con RUC 10 y empleados de una empresa: ¿el receptor de la boleta asistida NRUS puede ser esa empresa con RUC 20?
- Procedimiento exacto de rotación de `PSE_ENCRYPTION_KEY` en producción (documentar en runbook antes del Corte 3).

---

## 15. Fuera de alcance de este spec

- OSE (solo aplica a PRICOS; ver ADR-0001 de este repo).
- Facturación en papel o físicamente (no existe en el segmento digital objetivo).
- Retenciones o detracciones más allá de la retención RHE 8 % (detracciones aplican a bienes físicos, no a servicios digitales del Hub).
- Fraccionamiento de pagos y notas de crédito (pueden entrar en un sub-spec posterior).
- Anulación de comprobantes (nota de débito/crédito electrónica): alcance futuro.
