# Spec — AI Agents por vertical (WhatsApp Hub)

- **Estado:** Borrador v1
- **Corte:** 2 (Conversación + IA task-specific)
- **Relacionados:** `Docs/prd.md` · ADR-0008 (ecosistema SiviHub) · `Docs/specs/facturacion-sunat.md` · `Docs/specs/agenda-citas.md`

---

## 1. Principio: IA task-specific (y por qué — el riesgo Meta)

A partir de 2026, Meta prohíbe los **chatbots de propósito general** en las cuentas WABA (WhatsApp Business API). Un agente que responda cualquier pregunta, haga de asistente general o navegue sin límite de dominio es causa suficiente para la **suspensión del número de WhatsApp** del tenant.

**La regla es estructural, no de UX:** cada instancia del AI Agent está ligada a un vertical concreto y solo puede invocar las Tools auditadas de ese vertical. No existe un agente "polivalente" que cubra varios verticales a la vez. Si un tenant opera varios tipos de negocio bajo el mismo número, se configura como `otro` con el conjunto de intents más próximo, o se asigna un número diferente por vertical.

Esto alinea con el ADR-0008 del ecosistema SiviHub:

> "La LLM NUNCA escribe a la DB directamente. Solo invoca Tools registradas. Las Tools ejecutan use cases de la capa de aplicación."

---

## 2. Tool Registry — gobernanza y auditoría

### 2.1 Concepto

Cada Tool es una función registrada en el MCP server interno (`apps/backend/src/ai/mcp/`) que:

1. Expone una capacidad de la capa de aplicación (never de la DB directamente).
2. Está tipada con Zod (input + output).
3. Genera un registro en `ai.invocation_log` en cada invocación.
4. Requiere **100 % de cobertura de tests** (sin excepción).

El agente recibe del orchestrator solo las Tools habilitadas para su vertical. No puede invocar Tools de otros verticales.

### 2.2 Registro de auditoría

Cada invocación genera una fila en `ai.invocation_log`:

| Campo | Tipo | Qué registra |
|---|---|---|
| `id` | UUID PK | Identificador único |
| `tenant_id` | UUID | Tenant dueño del negocio |
| `tool_name` | TEXT | Nombre de la Tool invocada |
| `input` | JSONB | Parámetros enviados por el LLM |
| `output` | JSONB | Resultado devuelto al LLM |
| `status` | TEXT | `ok` / `error` / `pending_human` |
| `tokens_in` | INT | Tokens del prompt |
| `tokens_out` | INT | Tokens del completion |
| `cost_microdollars` | INT | Costo estimado en microdólares |
| `conversation_id` | UUID | Conversación en la que ocurrió |
| `created_at` | TIMESTAMPTZ | Marca temporal de la invocación |

### 2.3 Regla de confirmación humana

Las Tools que **mueven dinero** (`createPaymentLink`, `confirmOrder`) tienen el campo `requires_human_confirmation = true`. El orchestrator envía la propuesta al cliente ("¿Confirmás tu pedido de S/80?") y solo invoca la Tool si el cliente responde afirmativamente. La Tool nunca se invoca sin esa confirmación explícita.

### 2.4 Tools del catálogo base

| Tool name | Qué hace | `requires_human_confirmation` |
|---|---|---|
| `getBusinessInfo` | Devuelve nombre, dirección, horarios, redes, servicios del tenant | No |
| `getProductCatalog` | Lista productos/servicios con precio y stock | No |
| `getProductPrice` | Precio unitario de un producto/servicio | No |
| `checkStock` | Disponibilidad actual de un producto/servicio | No |
| `createPaymentLink` | Genera link Culqi/Izipay para el monto calculado | **Sí** |
| `getPaymentStatus` | Consulta si el pago fue acreditado | No |
| `registerContact` | Registra o actualiza los datos del contacto/cliente | No |
| `checkAppointmentAvailability` | Devuelve slots disponibles según agenda del tenant | No |
| `scheduleAppointment` | Reserva un slot específico (requiere pago opcional) | **Sí** |
| `cancelAppointment` | Cancela una cita existente | **Sí** |
| `getAppointmentStatus` | Estado de una cita (confirmada, pendiente pago, cancelada) | No |
| `getDebtBalance` | Saldo de deuda o estado de cuenta del cliente | No |
| `sendFlow` | Envía un WhatsApp Flow interactivo al cliente | No |
| `getOrderStatus` | Estado de un pedido en curso | No |
| `escalateToHuman` | Transfiere la conversación a la bandeja humana del negocio | No |

> **Para consultorios:** las Tools `checkAppointmentAvailability`, `scheduleAppointment`, `cancelAppointment`, `getAppointmentStatus` están disponibles. `getDebtBalance` refiere únicamente al saldo de la consulta/honorario — **nunca** se registra ni procesa información clínica, diagnósticos, síntomas ni antecedentes médicos (Ley 29733 — datos sensibles de salud).

---

## 3. Intents por vertical

La tabla lista los intents habilitados por vertical. El LLM clasifica la intención del cliente dentro de este conjunto acotado. Un intent fuera de la lista es **out-of-scope** → patrón de respuesta §4.

| Vertical | Intents habilitados |
|---|---|
| `academia` | `consultar_precios` · `ver_horarios` · `registrar_alumno` · `pagar_mensualidad` · `consultar_saldo_deuda` |
| `restaurante` | `ver_menu` · `hacer_pedido` · `consultar_delivery` · `estado_pedido` · `reservar_mesa` |
| `botica` | `consultar_precio` · `verificar_stock` · `hacer_pedido` · `delivery` |
| `tienda_general` | `ver_catalogo` · `hacer_pedido` · `consultar_precio` · `estado_pedido` |
| `ecommerce` | `ver_productos` · `checkout` · `estado_envio` · `devolucion` |
| `colegio` | `consultar_pension` · `pagar_pension` · `ver_horario` · `estado_cuenta` · `comunicados` |
| `consultorio` | `reservar_cita` · `cancelar_cita` · `consultar_disponibilidad` · `pagar_consulta` · `estado_cita` |
| `profesional_independiente` | `agendar_sesion` · `consultar_disponibilidad` · `cancelar_sesion` · `pagar_honorarios` |

### Reglas de habilitación

- Los intents que involucran pago (`pagar_*`, `checkout`, `hacer_pedido`, `delivery`) requieren que el tenant haya conectado su cuenta de pasarela de cobros (Culqi o Izipay). Si no está configurada, la Tool `createPaymentLink` está bloqueada y el agente responde que el cobro en línea no está disponible por ahora.
- `comunicados` (colegio) solo va en dirección tenant → cliente, vía templates de difusión (Corte 5). No es un intent entrante del cliente.

---

## 4. Manejo de out-of-scope

Cuando el cliente escribe algo que no mapea a ningún intent del vertical, el agente responde con este patrón (no puede inventar otra respuesta):

```
Solo puedo ayudarte con {nombre_negocio}.
¿En qué puedo ayudarte hoy?
1️⃣ {intención_1}
2️⃣ {intención_2}
3️⃣ Hablar con una persona
```

La opción 3️⃣ siempre está presente. Si el cliente la elige, se invoca `escalateToHuman` y la conversación entra en la bandeja de atención manual del tenant.

**Ejemplos de out-of-scope que el agente NUNCA responde:**
- Preguntas de cultura general, clima, noticias.
- Ayuda con otros negocios o servicios externos.
- Para `consultorio`: síntomas, diagnósticos, pronósticos, antecedentes clínicos o cualquier pregunta médica. Tampoco pide el número de historia clínica en el chat.

---

## 5. System prompt base por vertical

El system prompt se construye en runtime por el orchestrator. Los valores entre `{}` son parámetros obligatorios resueltos desde la configuración del tenant.

```
Sos el asistente de {nombre_negocio}, un {tipo_vertical} en {ciudad}, Perú.
Tu función es EXCLUSIVAMENTE ayudar a los clientes del negocio con: {lista_intenciones_del_vertical}.

Reglas que siempre cumplís:
- Respondés en español, de manera directa y amable, sin ser demasiado formal.
- Cuando el cliente quiere pagar, generás un link de pago seguro (Culqi/Izipay). NUNCA pedís datos de tarjeta en el chat.
- Antes de emitir un comprobante de pago, preguntás si el cliente va a facturar a nombre de una empresa (→ factura) o como persona natural (→ boleta). En el primer caso pedís su RUC; en el segundo, su DNI.
- Si no entendés lo que el cliente escribió, respondés con el menú de opciones.
- NUNCA respondés preguntas que no tengan que ver con {nombre_negocio}.
- Cuando el cliente pide hablar con una persona, invocás escalateToHuman sin hacer más preguntas.
[Solo para consultorio] NUNCA pedís historial clínico, síntomas, diagnósticos ni información de salud. Para eso existe el profesional de salud; tu rol es únicamente gestionar la agenda y el cobro de la consulta.
```

> **Nota de implementación:** este system prompt es la base. El orchestrator puede agregar bloques de contexto dinámico (catálogo de productos, horarios del día, saldo del cliente) como mensajes del sistema adicionales, no como modificaciones al prompt base. El prompt base es inmutable por vertical.

---

## 6. Modelo de costos de mensajes WhatsApp (Perú 2026)

### 6.1 Categorías Meta

| Categoría | Cuándo aplica | Costo aprox. (PEN) |
|---|---|---|
| **SERVICE** | El cliente escribe primero; ventana de 24 h activa | S/ 0.00 |
| **SERVICE (Ad window)** | El cliente llega por Click-to-WhatsApp Ad; ventana de 72 h | S/ 0.00 |
| **UTILITY** | Mensajes transaccionales confirmatorios (confirmación de pago, recordatorio de cita) | ≈ S/ 0.04 |
| **MARKETING** | Difusiones proactivas (promociones, campañas) | ≈ S/ 0.06 |
| **AUTH** | OTP de autenticación | ≈ S/ 0.02 |

### 6.2 Estrategia de minimización de costos

El objetivo es que la mayor parte del flujo caiga en SERVICE (costo cero):

1. **El cliente siempre escribe primero.** Todos los flujos de venta y consulta empiezan con un mensaje entrante del cliente. Los anuncios Click-to-WhatsApp extienden la ventana gratuita a 72 h.
2. **Quick replies mantienen la ventana abierta.** Los botones de respuesta rápida (opciones del menú, confirmaciones de pedido) cuentan como respuesta del cliente y mantienen activa la ventana de 24 h sin costo adicional.
3. **1 sola UTILITY por venta.** Al confirmar el pago, se envía un único mensaje UTILITY que incluye el comprobante (PDF adjunto). No se fragmenta en múltiples mensajes transaccionales.
4. **Recordatorios de cita = UTILITY, no MARKETING.** Los recordatorios de cita 24 h y 2 h antes son transaccionales (el cliente ya reservó); califican como UTILITY (≈ S/ 0.04), no como MARKETING (≈ S/ 0.06).
5. **MARKETING solo para campañas estratégicas mensuales.** No se usan mensajes MARKETING para re-engagement genérico ni notificaciones operativas.

### 6.3 Costo estimado por venta/cita completada

| Tipo de mensaje | Cantidad | Costo unitario | Subtotal |
|---|---|---|---|
| Mensajes del flujo de venta (SERVICE) | N | S/ 0.00 | S/ 0.00 |
| Confirmación de pago + comprobante (UTILITY) | 1 | ≈ S/ 0.04 | ≈ S/ 0.04 |
| Recordatorio de cita (UTILITY, si aplica) | 1–2 | ≈ S/ 0.04 | ≈ S/ 0.04–0.08 |
| **Total estimado por transacción** | | | **≈ S/ 0.04–0.12** |

> El costo de IA (tokens de inferencia) es independiente y corre por cuenta del tenant de acuerdo a su plan de membresía.

---

## 7. Escenarios

### Escenario 1 — Consulta de precio y pago de mensualidad (academia)

**Vertical:** `academia`
**Intent:** `consultar_precios` → `pagar_mensualidad`
**Categoría de mensajes Meta:** SERVICE (cliente escribe primero) + 1 UTILITY (confirmación de pago)

```
Cliente:  "Hola, ¿cuánto cuesta la mensualidad de marinera?"
Agente:   [invoca getProductCatalog(category: "membership")]
          "¡Hola! En {nombre_negocio} la mensualidad de marinera es S/120 al mes.
           ¿Querés anotarte? Con gusto te genero el link de pago. 💃"
Cliente:  "Sí, quiero pagar."
Agente:   "Perfecto. ¿Vas a necesitar factura a nombre de empresa o boleta de consumidor?"
Cliente:  "Boleta está bien. Mi DNI es 74512380."
Agente:   [invoca createPaymentLink(amount: 120, currency: "PEN", description: "Mensualidad marinera")]
          "¡Listo! Acá tenés tu link de pago seguro: https://pay.culqi.com/xyz
           Una vez que pagues te mando el comprobante directo por acá. 🎉"
          [webhook de pago recibido → sistema emite boleta → UTILITY]
          "✅ ¡Pago confirmado! Tu boleta electrónica está adjunta. Bienvenida. 🕺"
```

**Tools invocadas:** `getProductCatalog` → `createPaymentLink` (con confirmación del cliente) → (webhook externo, no Tool) → sistema emite CPE
**Costo Meta estimado:** S/ 0.04 (1 UTILITY para el comprobante)

---

### Escenario 2 — Reserva de cita (consultorio)

**Vertical:** `consultorio`
**Intent:** `reservar_cita` → `pagar_consulta`
**Restricción aplicada:** sin datos clínicos

```
Cliente:  "Quiero una cita con el dr. Ramírez para la próxima semana."
Agente:   [invoca checkAppointmentAvailability(professional: "Dr. Ramírez", range: "próxima semana")]
          "El Dr. Ramírez tiene disponibilidad el martes 24 a las 10:00 y el jueves 26 a las 15:00.
           ¿Cuál te viene mejor?"
Cliente:  "El martes a las 10."
Agente:   "La consulta tiene un costo de S/80. ¿Confirmás la reserva y el pago para el
           martes 24 de junio a las 10:00 con el Dr. Ramírez?"
Cliente:  "Sí."
Agente:   [invoca scheduleAppointment(slot: "2026-06-24T10:00", professional: "Dr. Ramírez")]
          [invoca createPaymentLink(amount: 80, description: "Consulta Dr. Ramírez 24/06")]
          "¡Reserva confirmada! 🗓️ Acá tenés el link para pagar y asegurar tu lugar:
           https://pay.culqi.com/abc
           Te mando un recordatorio el lunes a la tarde. 😊"
```

**Lo que el agente NUNCA hace en este flujo:**
- Preguntar motivo de consulta, síntomas, diagnóstico anterior o historial clínico.
- Guardar ningún dato de salud en la conversación.

**Tools invocadas:** `checkAppointmentAvailability` → `scheduleAppointment` → `createPaymentLink`
**Costo Meta estimado:** S/ 0.04 (cita) + S/ 0.04 (UTILITY confirmación de pago) = ≈ S/ 0.08

---

### Escenario 3 — Out-of-scope (restaurante)

**Vertical:** `restaurante`
**Trigger:** mensaje fuera de los intents del vertical

```
Cliente:  "¿Sabés a qué hora abre el banco BCP?"
Agente:   "Solo puedo ayudarte con {nombre_negocio}.
           ¿En qué puedo ayudarte hoy?
           1️⃣ Ver el menú
           2️⃣ Hacer un pedido
           3️⃣ Hablar con una persona"
```

**Tools invocadas:** ninguna (respuesta fija del orchestrator, sin inferencia adicional).
**Costo Meta:** S/ 0.00 (SERVICE, dentro de la ventana de 24 h).

---

### Escenario 4 — Consulta de stock y pedido (botica)

**Vertical:** `botica`
**Intent:** `verificar_stock` → `hacer_pedido`

```
Cliente:  "¿Tienen Paracetamol 500mg?"
Agente:   [invoca checkStock(product: "Paracetamol 500mg")]
          "Sí, tenemos Paracetamol 500mg a S/0.80 la unidad. ¿Cuántas unidades necesitás?"
Cliente:  "Dame 10 por favor."
Agente:   "Son S/8.00 en total. ¿Retirás en tienda o querés delivery?"
Cliente:  "Delivery."
Agente:   "¿Me confirmás tu dirección de entrega?"
Cliente:  "Av. La Marina 1250, Pueblo Libre."
Agente:   "Tu pedido: 10x Paracetamol 500mg — S/8.00 + delivery.
           ¿Confirmás el pedido?"
Cliente:  "Sí."
Agente:   [invoca createPaymentLink(amount: 8.00, description: "Paracetamol 500mg x10 + delivery")]
          "¡Listo! Acá tu link de pago: https://pay.culqi.com/def
           Una vez confirmado, te avisamos el tiempo estimado de entrega. 📦"
```

**Tools invocadas:** `checkStock` → `createPaymentLink` (con confirmación del cliente)
**Costo Meta estimado:** S/ 0.04 (1 UTILITY para la confirmación de pago)

---

## 8. Reglas técnicas de implementación

- El orchestrator inyecta en cada conversación: el system prompt base del vertical, el contexto dinámico (horarios, catálogo en caché, saldo del cliente si aplica) y la lista de Tools habilitadas para ese vertical.
- El `LlmAdapter` expone un único método: `complete(messages: Message[], tools: Tool[]): Promise<LlmResponse>`. Las implementaciones concretas son `AnthropicAdapter` y `OpenAIAdapter` (intercambiables sin cambiar el código de negocio — ADR-0008).
- El orchestrator **no expone el system prompt al cliente** en ningún mensaje. El prompt es configuración interna del tenant.
- Todas las Tools del catálogo base tienen tests con 100 % de cobertura. El template de test incluye: input tipado con Zod, mock del repositorio y assert del registro en `ai.invocation_log`.
- La Tool `escalateToHuman` marca la conversación con `status = 'needs_human'` y dispara una notificación en la bandeja del dashboard del tenant. A partir de ese momento, el agente no responde más en esa conversación hasta que el staff la resuelva y la devuelva al agente.
- El número máximo de Tool calls por turno del LLM es **5**. Si se alcanza sin resolver la intent, el orchestrator invoca `escalateToHuman` automáticamente.

---

## 9. Fuera de alcance de esta spec

- El builder no-code de configuración del agente (dashboard web) — es parte del Corte 2, spec separada.
- RAG sobre documentos del tenant (PDFs de catálogo, precios extendidos) — Corte 4.
- Difusiones proactivas (campañas MARKETING) — Corte 5.
- Intents de devolución/reclamo con intervención compleja — Corte 4+.
- Autenticación del cliente final (verificación de identidad más allá del DNI/RUC para comprobantes) — a diseñar en el Corte 3.

---

## 10. Preguntas abiertas

- ¿El tenant puede agregar intents custom fuera de la lista del vertical? Si sí, ¿se validan contra Meta antes de habilitarse?
- ¿La ventana de 72 h de Click-to-WhatsApp Ads requiere que el Ad esté activo en el momento de la conversación, o basta con que el cliente haya llegado originalmente por un Ad?
- ¿El saldo de deuda (`consultar_saldo_deuda`, `estado_cuenta`) se expone por número de teléfono o requiere que el cliente se identifique con DNI primero?
- Para `profesional_independiente` con régimen 4ta categoría: ¿el link de pago genera el RHE automáticamente o se hace semi-manual? (Ver spec de facturación SUNAT.)
