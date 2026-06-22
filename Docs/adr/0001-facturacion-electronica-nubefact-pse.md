# 0001 — Facturación electrónica: Nubefact como PSE para RMT/RER/RG; SEE-SOL para NRUS; semi-asistido para RHE

**Estado**: Aceptada
**Fecha**: 2026-06-21

## Contexto

El WhatsApp Hub cobra pagos post-conversación (Corte 3) y, por ley peruana, **toda venta de un contribuyente activo obliga a emitir un Comprobante de Pago Electrónico (CPE)**. El mecanismo varía según el régimen tributario del tenant y el tipo de receptor:

- **NRUS Cat. 1 y 2**: solo boletas; no pueden emitir facturas. Cuota fija mensual (S/20 y S/50 respectivamente). Tienen límite de ingresos (≤ S/8,000/mes; anual ≤ S/96,000). **No tienen acceso a la API de Nubefact con las mismas facultades.**
- **NRUS Especial** (agrarios/pescadores artesanales): cuota S/0; mismas restricciones de emisión que Cat. 1/2.
- **RMT, RER, RG**: pueden emitir facturas (receptor con RUC) y boletas (receptor con DNI). Acceso completo a PSE.
- **4ta categoría (RHE)**: profesionales independientes (médicos, psicólogos, abogados, contadores, ingenieros, etc.). El comprobante es el **Recibo por Honorarios Electrónico (RHE)**, serie E001 + correlativo. **SUNAT no expone API de PSE/OSE para RHE**; el correlativo es controlado directamente por SUNAT en su plataforma SOL.

Al diseñar el flujo post-pago, había que decidir:

1. Qué PSE/OSE usar para la emisión automática.
2. Cómo manejar los casos donde la automatización completa no es posible técnicamente.
3. Si el tipo de CPE debe determinarse en onboarding (estático) o en cada transacción (dinámico).

> **Nota de implementación**: las cifras tributarias (cuotas NRUS, umbrales de categoría, porcentaje de retención RHE, UIT 2026 = S/5,500) reflejan la normativa vigente a la fecha de este ADR y **deben verificarse contra fuentes oficiales de SUNAT antes de cualquier despliegue productivo**. La legislación peruana puede cambiar por decreto.

## Decisión

**Se usa Nubefact como PSE exclusivo para tenants RMT/RER/RG y RUC-20 (facturas + boletas, 100% automático). NRUS emite boletas de forma semi-asistida vía SEE-SOL. El RHE de 4ta categoría es semi-automático (notificación al profesional). El tipo de CPE se determina dinámicamente en cada transacción. OSE no aplica al segmento MYPE objetivo.**

### Por qué Nubefact

- **Integración simple**: el tenant solo registra Nubefact con su Clave SOL (~5 min) en el portal de SUNAT (sunat.gob.pe → SOL → Empresas → Comprobantes → Alta de PSE; RUC Nubefact: 20600695771). No necesita certificado digital propio (Nubefact lo provee).
- **API REST estándar**: un `POST` a `https://api.nubefact.com/api/v1/documento` con el token del tenant devuelve el CDR `{ aceptada_por_sunat, enlace_del_pdf, codigo_hash }`. El flujo post-pago queda en menos de 3 segundos.
- **Cubre el 95 %+ del segmento MYPE peruano** (RMT + RER + RG) con automatización completa.
- **Modelo por transacción** o suscripción: sin costo fijo alto; viable para MYPEs con volumen variable.

### Por qué el token del tenant se almacena encriptado en Postgres (AES-256) — no en Supabase Vault

El Hub usa **Postgres 16 self-hosted** (ADR-0004). Supabase no es parte del stack. El token de API de Nubefact de cada tenant es un secreto en reposo que se encripta con AES-256-GCM en la capa de aplicación antes de persistirlo en la columna `encrypted_pse_token` de `billing.tenant_billing_config`. La clave maestra de encriptación se inyecta como variable de entorno (`PSE_ENCRYPTION_KEY`) y nunca toca la DB.

### Por qué semi-asistido para NRUS

NRUS no puede usar la misma ruta de emisión automática:
- SUNAT no les permite operar con PSE en el mismo modo que RMT/RER/RG.
- Solo pueden emitir boletas, desde el portal SEE-SOL de SUNAT directamente.
- El Hub entonces: (a) lleva un contador de ventas mensual del tenant, (b) genera el resumen de datos de la boleta para que el dueño la ingrese manualmente en SEE-SOL, y (c) alerta cuando el volumen de ventas se acerca al límite de categoría (NRUS Cat. 1: S/5,000/mes; Cat. 2: S/8,000/mes) para que el tenant pueda migrar a RMT/RER antes de excederlo. El Hub también ofrece un flujo guiado de upgrade.

### Por qué semi-automático para RHE (4ta categoría)

SUNAT no expone ninguna API pública de PSE u OSE para RHE. El correlativo de la serie E001 es gestionado exclusivamente por SUNAT en su plataforma. Ningún PSE — incluido Nubefact — puede emitir RHE vía API. Por lo tanto el flujo es:

1. Pago confirmado → el Hub notifica al **cliente** ("pago recibido, recibo en camino") vía WhatsApp.
2. El Hub notifica al **profesional** (tenant) por WhatsApp con el link directo a SUNAT SOL + datos del receptor + descripción sugerida del servicio.
3. El profesional emite el RHE en SOL (manual), puede subir el PDF al Hub (botón) para que se reenvíe al cliente, o el cliente lo descarga directamente desde el portal de SUNAT.

La retención del 8 % aplica cuando el recibo supera S/1,500 Y el pagador es agente de retención. Si el cliente es persona natural sin negocio, no hay retención. El Hub informa al profesional en la notificación WhatsApp.

### Por qué OSE no aplica

Las OSE (Operadores de Servicios Electrónicos) pre-validan el XML antes de enviarlo a SUNAT. Son obligatorias solo para **PRICOS** (ingresos > 300 UIT ≈ S/1.65 M/año en 2026). El segmento MYPE objetivo del Hub está muy por debajo de ese umbral. OSE añadiría complejidad y costo sin beneficio para este segmento.

### Por qué el tipo de CPE es dinámico

El mismo tenant puede vender a un receptor con RUC (factura) o a uno con DNI (boleta) en la misma sesión. Hardcodear el tipo al momento del onboarding sería incorrecto. El algoritmo se ejecuta en cada transacción:

```
function determineCpeType(tenantRegime, receptor):
  if tenantRegime.startsWith("NRUS"):
    return "boleta_asistida"
  if tenantRegime == "4TA":
    return "rhe_notificacion_manual"
  if receptor.tipoDoc == "6" and receptor.numDoc.length == 11:  // RUC
    return "factura"
  return "boleta"
```

Solo se persiste el comprobante una vez que SUNAT lo acepta (CDR con `aceptada_por_sunat: true`).

## Consecuencias

**Positivas**
- Onboarding de facturación < 10 minutos para tenants RMT/RER/RG (registro en SUNAT SOL + API token).
- Flujo post-pago completamente automático para el 95 %+ del segmento objetivo.
- Sin certificados digitales ni infraestructura de firma propia: Nubefact lo maneja.
- NRUS tiene un camino asistido claro con alertas de límite, sin bloquear el cobro.
- Profesionales 4ta cat. tienen un flujo WhatsApp-nativo que reduce la fricción del portal SOL.
- El tipo dinámico de CPE elimina errores de configuración del tenant.

**Negativas / riesgos**
- Dependencia de Nubefact: si el PSE cae o cambia su API, la emisión automática se bloquea. Mitigación: reintentos con backoff exponencial en el worker; cola pg-boss para no perder eventos; el comprobante se emite en diferido si el CDR tarda.
- El flujo RHE requiere acción manual del profesional: si no emite en tiempo (antes del 10mo día hábil del mes siguiente), el Hub no puede hacerlo por él. Mitigación: recordatorio automático via WhatsApp al profesional antes del vencimiento.
- Las cifras tributarias (cuotas, umbrales) pueden cambiar por decreto. Mitigación: externalizarlas como constantes configurables (no hardcodeadas en el código), documentadas con su fuente y fecha.
- El token AES-256 en Postgres requiere rotación de clave maestra: se implementa con versionado de clave en la columna (`key_version`).

**Acciones derivadas**
- Crear `billing.tenant_billing_config` con `encrypted_pse_token`, `key_version`, `regime`, `nubefact_series_factura`, `nubefact_series_boleta`.
- Implementar `determineCpeType()` como función pura en `packages/domain/billing`.
- Implementar `NubefactAdapter` en `apps/backend/src/infrastructure/pse/nubefact.adapter.ts`.
- Implementar flujo de onboarding por régimen en el dashboard (wizard de configuración fiscal).
- Implementar job worker de reintento para CDR pendientes (pg-boss + croner).
- Implementar job de alerta de límite NRUS (contador mensual + notificación WhatsApp al tenant).
- Implementar job de recordatorio RHE (WhatsApp al profesional antes del día 10 hábil).
- Detallar todo en `Docs/specs/facturacion-sunat.md`.

## Alternativas consideradas

| Alternativa | Por qué se descartó |
|---|---|
| Sunat directamente (UBL 2.1 propio + certificado) | Certificado digital propio (~S/200/año), validación de XML compleja, mantenimiento de la especificación UBL 2.1 PE. Costo técnico desproporcionado para una MYPE. |
| Otro PSE (EDICOM, SunatBeta, Greenter) | Nubefact tiene la mejor API REST, documentación activa, y ya es conocido en el ecosistema MYPE peruano. Se puede reconsiderar si aparecen problemas de SLA. |
| OSE para todo | Solo aplica a PRICOS. Añade latencia y costo sin beneficio para MYPEs. |
| Tipo de CPE estático (configurado en onboarding) | Un mismo tenant puede necesitar factura o boleta según el receptor de cada transacción. El tipo estático causaría errores en el 100 % de los casos mixtos. |
| Supabase Vault para el token de Nubefact | El stack del Hub no usa Supabase (ADR-0004). El cifrado AES-256-GCM en la capa de aplicación con clave maestra en env es equivalente en seguridad. |
