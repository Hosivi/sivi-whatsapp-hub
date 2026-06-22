# PRD — sivi-whatsapp-hub

> Documento de producto del **WhatsApp Hub**, app standalone WhatsApp-first del ecosistema SiviHub.
> Estado: **borrador v2** (incorpora el conocimiento del "CLAUDE.md v2.0").
> Mercado: **Perú**. Doc en español; código/identificadores en inglés.

> **Estrategia de entrega**: se construye **standalone primero** (foco limpio, repo propio) y los datos se **unifican luego en el CRM SiviHub**. La unificación NO es un "algún día" vago: es el destino, y el puente son los **contratos** (`ContactLead` + futuros). El Hub nunca toca las tablas del CRM directamente.

---

## 1. Propósito

El **WhatsApp Hub** convierte el WhatsApp de un negocio MYPE peruano en un **vendedor y asistente automático con IA**: responde consultas, da informes, agenda citas, **cobra mediante links de pago** y **emite el comprobante electrónico** (SUNAT) — todo configurable sin programar. El canal es WhatsApp (>90% de usuarios de internet en Perú lo usan como app principal — OSIPTEL 2024).

Es **vendible por separado** y entrega datos al CRM SiviHub por contrato.

---

## 2. Modelo de negocio

- **Membresía mensual fija** por tenant. El Hub **NO cobra porcentaje ni fee por transacción.**
- El **fee de la pasarela** (Culqi/Izipay) lo absorbe el negocio en su margen.
- Implicancia técnica: **no se usa split/marketplace**. Cada tenant conecta **su propia** cuenta de pasarela; la plata de sus ventas le va directo. El Hub solo genera el link, escucha el webhook y emite el comprobante. La membresía se cobra aparte.

---

## 3. Usuarios

| Tipo | Quién | Cómo interactúa |
|---|---|---|
| **Dueño del negocio (tenant)** | Configura el Hub | Dashboard web (Next.js): conocimiento, IA, pasarela, facturación, bandeja |
| **Cliente final** | Compra/consulta | **Solo WhatsApp** — nunca instala nada |

---

## 4. Verticales soportadas

`academia` (piloto), `restaurante`, `botica`, `tienda_general`, `ecommerce`, `colegio`, `consultorio`, `profesional_independiente`, `otro`. Arquitectura genérica multi-vertical.

---

## 5. Flujo central (todos los verticales)

```
1. Cliente escribe al WhatsApp del negocio        (SERVICE — gratis)
2. AI Agent task-specific clasifica la intención
3. Resuelve: info / cotización / reserva / venta
4. Si hay pago: genera link Culqi/Izipay
5. La pasarela confirma el pago vía webhook
6. Sistema emite el CPE según el régimen tributario del tenant
7. WhatsApp envía el PDF del comprobante al cliente (UTILITY ~S/0.04)
8. Sistema actualiza el vertical + entrega datos al CRM por contrato
```

---

## 6. Cimientos (mismo stack que SiviHub — heredados del ecosistema)

- Backend HonoJS + **composición funcional sin contenedor** (ADR-0017).
- **Postgres 16 self-hosted** como única infraestructura (ADR-0004). Sin Supabase, sin Redis.
- **Multi-tenancy con RLS** vía `SET LOCAL app.current_tenant` (ADR-0003). **Nunca `WHERE tenant_id` manual.**
- Auth `jose` (JWT). Sin Better-Auth.
- `croner` + worker en el mismo binario (ADR-0013). Sin n8n.
- Canal WhatsApp: solo Cloud API oficial (ADR-0016).
- IA gobernada vía Tools auditadas; el LLM nunca escribe a la DB (ADR-0008).
- Cortes verticales + mock-first (ADR-0009, ADR-0015).

---

## 7. Módulos

### 7.1 WhatsApp (Meta Cloud API)
Vía BSP (360dialog/Spur). **Verificación de negocio en Meta** (trámite externo, arranca temprano). Ventana 24h; fuera, templates aprobados. Costos PE 2026: SERVICE gratis · UTILITY ~S/0.04 · MARKETING ~S/0.06. Estrategia: cliente escribe primero (SERVICE), 1 UTILITY por venta.

### 7.2 Pagos
**Culqi** (principal) / **Izipay** (alt). Yape/Plin: confirmación manual en MVP. **Link de pago** en el chat; nunca datos de tarjeta. Cada tenant con su propia cuenta (sin split). Webhook con HMAC.

### 7.3 Facturación electrónica SUNAT
**Nubefact (PSE)** para RMT/RER/RG (factura + boleta automático; token por tenant cifrado). **NRUS**: solo boletas vía SEE-SOL (semi-asistido) + alerta de límite de categoría. **4ta cat (RHE)**: SUNAT sin API de PSE → **semi-automático** (notificación al profesional). **OSE**: solo PRICOS, no aplica. Tipo de CPE **dinámico** por régimen + receptor. (Detalle → ADR-0018 + spec.)

### 7.4 Agenda y reservas
Para `consultorio`, `profesional_independiente`, `academia`, `restaurante`. Servicios + horarios + bloqueos + citas. Reserva por WhatsApp con pago para confirmar; recordatorios UTILITY 24h/2h. (Detalle → spec.)

### 7.5 IA gobernada
**Task-specific por vertical** (Meta 2026 prohíbe propósito general → riesgo de baneo del WABA). Solo Tools auditadas (`createPaymentLink`, `sendFlow`, `scheduleAppointment`, `getBusinessInfo`…). Full-auto en conversación; **confirmación humana en cobros**. (Detalle → spec.)

---

## 8. Relación con el CRM SiviHub (la frontera)

- El Hub es **dueño de su dominio**: contactos WA, conversaciones, mensajes, plantillas, difusiones, intención, pagos, citas, comprobantes.
- **Cruza al CRM solo por contrato**: hoy `ContactLead`; mañana, contratos para ventas/citas/comprobantes según haga falta.
- El contrato vive como archivo replicado (`@sivihub/contracts` cuando se estabilice).
- **El Hub nunca consulta ni escribe las tablas del CRM directamente.** Esa disciplina es lo que permite unificar después sin dolor.

---

## 9. Roadmap de cortes (mock-first)

| Corte | Qué | ¿Meta? | ¿Vendible? |
|---|---|---|---|
| **0** ✓ | Walking skeleton (monorepo + `/health` + contrato `ContactLead`) | No | Base — **hecho** |
| **1** | Contactos: import CSV/Excel/vCard + dedupe + CRUD + tags + intención manual | No — **ya** | Base |
| **2** | Conversación + IA task-specific (responder en ventana 24h) + builder no-code básico | Sí | **Primer corte vendible** |
| **3** | Ventas y cobros: link de pago (Culqi/Izipay) + **facturación SUNAT** post-pago | Sí | Sí (núcleo) |
| **4** | Agenda/citas + IA avanzada (RAG, más Tools) | Sí | Sí |
| **5** | Difusiones (templates + opt-in) + más verticales |  Sí | Sí |

Camino a facturar: **1 → 2 → 3**. En paralelo: **verificación de Meta** (necesaria desde el Corte 2).

---

## 10. Descartado del "CLAUDE.md v2.0"

| Propuesta v2.0 | Por qué se rechaza | ADR |
|---|---|---|
| Supabase | Postgres self-hosted, única infra | ADR-0004 |
| `WHERE tenant_id` manual | Es el *footgun* que el RLS previene | ADR-0003 |
| Better-Auth | DI funcional; `jose` ya implementado | ADR-0017 |
| n8n | Dos procesos, un binario; `croner` | ADR-0013 |
| IA desde el día 1 | Core validado antes de la IA | ADR-0009 |

---

## 11. Próximos pasos

1. Validar este PRD.
2. Bajar a artefactos del Hub: ADR de facturación SUNAT + specs (facturación, agenda, AI agents por vertical).
3. Construir el **Corte 1** (contactos, sin Meta) en sesión enfocada en el Hub.
4. Iniciar verificación de negocio en Meta (en paralelo).

---

## Referencias
- `Docs/whatsapp-hub-handoff.md` (SiviHub) — brief de arranque.
- ADRs del ecosistema: 0003 (RLS), 0004 (Postgres), 0008 (IA), 0009/0015 (cortes/mock-first), 0013 (binario), 0016 (WhatsApp), 0017 (DI).
- Conocimiento tributario base: aportado en el "CLAUDE.md v2.0" (junio 2026).
