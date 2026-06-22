# Módulo: Agenda y Citas — Reservas WhatsApp-first con pago para confirmar

- **Estado:** En diseño
- **Corte:** 4 — Agenda/citas + IA avanzada
- **Estrategia:** Corte vertical completo (flujo reserva → pago → recordatorios)
- **Tenant cero:** Consultorio médico / psicólogo unipersonal
- **Relacionados:**
  - `Docs/prd.md` §7.4 — Agenda y reservas
  - `Docs/prd.md` §7.2 — Pagos (Culqi/Izipay)
  - `Docs/prd.md` §7.3 — Facturación SUNAT (comprobante post-pago)
  - `Docs/prd.md` §7.5 — IA gobernada (Tool `scheduleAppointment`)

---

## Objetivo

Permitir que el cliente final agende, pague y reciba confirmación de una cita **sin salir de WhatsApp**, mientras el tenant gestiona su disponibilidad, bloqueos y políticas de cancelación desde el dashboard. El módulo aplica a los verticales `consultorio`, `profesional_independiente`, `academia` y `restaurante`.

**No es** un sistema de calendarios completo ni de gestión de historiales clínicos — solo reserva + confirmación + recordatorios.

---

## Por qué este módulo en Corte 4

Los Cortes 1–3 establecen los cimientos (contactos, IA conversacional, pagos + SUNAT). La agenda necesita los tres: contactos para vincular al receptor, pagos para confirmar la cita, y SUNAT para emitir el comprobante. Sin esos cimientos operando en producción, la agenda no puede estar completa ni ser vendida de forma aislada.

---

## Dominio — Agenda

```
tenant
  │
  ├── servicios_agenda  ─────────────── horarios_disponibles
  │       │                                    │
  │       │                             (dia_semana, hora)
  │       │
  │       └── citas ──── receptor (contacto WA)
  │               │
  │               ├── pago_id (→ módulo pagos)
  │               └── comprobante_id (→ módulo SUNAT)
  │
  └── bloqueos_agenda (fechas de cierre completo)
```

### Entidades

| Entidad | Qué representa | Notas clave |
|---|---|---|
| `servicios_agenda` | Servicio reservable (consulta médica, clase, mesa) | Duración fija, precio, anticipación mínima, ventana de cancelación |
| `horarios_disponibles` | Franjas semanales ofrecidas por servicio | Por `dia_semana` (0=Dom … 6=Sáb) + `hora_inicio`/`hora_fin` |
| `bloqueos_agenda` | Períodos de cierre total (vacaciones, feriado, capacitación) | Rango de fechas; tiene prioridad sobre `horarios_disponibles` |
| `citas` | La reserva concreta: quién, cuándo, servicio, estado | Ciclo de vida: `pendiente_pago → confirmada → completada / cancelada / no_asistio` |

---

## Schema Drizzle (campo por campo)

> Todos los campos de tiempo son `TIMESTAMPTZ`. PKs son `UUID` (`gen_random_uuid()`). Todas las tablas tienen `tenant_id UUID NOT NULL` + política RLS `tenant_isolation`. Soft-delete con `deleted_at TIMESTAMPTZ NULL`.

### `servicios_agenda`

```ts
export const serviciosAgenda = pgTable('servicios_agenda', {
  id:                   uuid('id').primaryKey().defaultRandom(),
  tenantId:             uuid('tenant_id').notNull(),
  nombre:               varchar('nombre', { length: 120 }).notNull(),
  duracionMin:          integer('duracion_min').notNull(),          // duración fija en minutos
  precio:               numeric('precio', { precision: 10, scale: 2 }).notNull(),
  moneda:               varchar('moneda', { length: 3 }).notNull().default('PEN'),
  color:                varchar('color', { length: 7 }),            // hex, para UI de calendario
  activo:               boolean('activo').notNull().default(true),
  anticipacionMinHrs:   integer('anticipacion_min_hrs').notNull().default(2),   // mínimo de antelación para reservar
  cancelacionMaxHrs:    integer('cancelacion_max_hrs').notNull().default(24),   // hasta cuántas horas antes se puede cancelar
  createdAt:            timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt:            timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  deletedAt:            timestamp('deleted_at', { withTimezone: true }),
});
```

### `horarios_disponibles`

```ts
export const horariosDisponibles = pgTable('horarios_disponibles', {
  id:           uuid('id').primaryKey().defaultRandom(),
  tenantId:     uuid('tenant_id').notNull(),
  servicioId:   uuid('servicio_id').notNull().references(() => serviciosAgenda.id),
  diaSemana:    integer('dia_semana').notNull(),   // 0 = Domingo … 6 = Sábado
  horaInicio:   time('hora_inicio').notNull(),
  horaFin:      time('hora_fin').notNull(),
  activo:       boolean('activo').notNull().default(true),
  createdAt:    timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt:    timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
```

### `bloqueos_agenda`

```ts
export const bloqueosAgenda = pgTable('bloqueos_agenda', {
  id:           uuid('id').primaryKey().defaultRandom(),
  tenantId:     uuid('tenant_id').notNull(),
  fechaInicio:  timestamp('fecha_inicio', { withTimezone: true }).notNull(),
  fechaFin:     timestamp('fecha_fin',    { withTimezone: true }).notNull(),
  motivo:       varchar('motivo', { length: 200 }),
  createdAt:    timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt:    timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
```

### `citas`

```ts
export const EstadoCita = pgEnum('estado_cita', [
  'pendiente_pago',
  'confirmada',
  'completada',
  'cancelada',
  'no_asistio',
]);

export const citas = pgTable('citas', {
  id:                          uuid('id').primaryKey().defaultRandom(),
  tenantId:                    uuid('tenant_id').notNull(),
  servicioId:                  uuid('servicio_id').notNull().references(() => serviciosAgenda.id),
  receptorId:                  uuid('receptor_id').notNull(),   // contacto WA (tabla contacts del Hub)
  estado:                      EstadoCita('estado').notNull().default('pendiente_pago'),
  fechaHoraInicio:             timestamp('fecha_hora_inicio', { withTimezone: true }).notNull(),
  fechaHoraFin:                timestamp('fecha_hora_fin',   { withTimezone: true }).notNull(),
  pagoId:                      uuid('pago_id'),                // FK → módulo pagos (null hasta confirmación)
  monto:                       numeric('monto', { precision: 10, scale: 2 }),
  comprobanteId:               uuid('comprobante_id'),         // FK → módulo SUNAT (null hasta emisión)
  recordatorio24hEnviado:      boolean('recordatorio_24h_enviado').notNull().default(false),
  recordatorio2hEnviado:       boolean('recordatorio_2h_enviado').notNull().default(false),
  whatsappConfirmacionMsgId:   varchar('whatsapp_confirmacion_msg_id', { length: 100 }),
  motivoCancelacion:           varchar('motivo_cancelacion', { length: 300 }),
  createdAt:                   timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt:                   timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  deletedAt:                   timestamp('deleted_at', { withTimezone: true }),
});
```

---

## Puerto de dominio (AgendaPort)

```ts
// packages/contracts/src/agenda.ts  (o apps/backend/src/modules/agenda/agenda.port.ts)

export interface Slot {
  inicio: Date;
  fin:    Date;
  disponible: boolean;
}

export interface ReservarCitaInput {
  tenantId:    string;
  servicioId:  string;
  receptorId:  string;
  slot:        Pick<Slot, 'inicio' | 'fin'>;
  monto:       number;
  moneda:      string;
}

export interface CancelarCitaInput {
  citaId: string;
  motivo?: string;
}

export interface AgendaPort {
  /** Devuelve los slots disponibles para un servicio a partir de una fecha de inicio */
  obtenerDisponibilidad(
    tenantId:   string,
    servicioId: string,
    desde:      Date,
  ): Promise<Slot[]>;

  /** Crea la cita en estado pendiente_pago; el pago la confirma vía webhook */
  reservarCita(data: ReservarCitaInput): Promise<Result<Cita, AgendaError>>;

  /** Cancela la cita si está dentro de la ventana permitida */
  cancelarCita(input: CancelarCitaInput): Promise<Result<void, AgendaError>>;

  /** Marca la cita como confirmada una vez el webhook de pago dispara */
  confirmarCita(citaId: string, pagoId: string): Promise<Result<Cita, AgendaError>>;

  /** Marca la cita como completada (post-atención) */
  completarCita(citaId: string): Promise<Result<void, AgendaError>>;

  /** Marca no_asistio (worker nocturno, si pasó la hora y sigue confirmada) */
  marcarNoAsistio(citaId: string): Promise<Result<void, AgendaError>>;
}

export type AgendaError =
  | { code: 'SLOT_NO_DISPONIBLE';        message: string }
  | { code: 'ANTICIPACION_INSUFICIENTE'; message: string }
  | { code: 'CANCELACION_FUERA_DE_VENTANA'; message: string }
  | { code: 'CITA_YA_CONFIRMADA';        message: string }
  | { code: 'CITA_NO_ENCONTRADA';        message: string };
```

---

## Cálculo de disponibilidad

La función `obtenerDisponibilidad` computa los slots así:

```
slots_brutos  = horarios_disponibles WHERE servicio_id = X AND activo = true
                → generar ventanas de (duracion_min) minutos dentro de cada franja
                → para los próximos N días (p.ej. 7) a partir de `desde`

bloqueados    = bloqueos_agenda WHERE tenant_id = T
                AND fecha_inicio <= slot.inicio AND fecha_fin >= slot.fin

ocupados      = citas WHERE servicio_id = X
                AND estado IN ('pendiente_pago', 'confirmada')
                AND fecha_hora_inicio >= desde

disponibles   = slots_brutos − bloqueados − ocupados
                (también excluir slots donde slot.inicio < NOW() + anticipacion_min_hrs)
```

La implementación vive en una función pura `computeAvailableSlots(horarios, bloqueos, citasExistentes, ahora, anticipacionMin)` que no toca la DB — facilita el unit testing sin mocks.

---

## Flujo completo de reserva por WhatsApp

```
1. Cliente escribe al WhatsApp del negocio
2. IA detecta intención de reserva → invoca Tool scheduleAppointment (read-only: lista servicios)
3. Bot presenta servicios disponibles (nombre, duración, precio)
4. Cliente elige servicio
5. Bot muestra slots libres de la semana (hasta 6–8 opciones)
6. Cliente elige slot
7. Bot solicita datos para el comprobante:
     - "¿A nombre de quién emito el comprobante? (nombre + DNI o RUC)"
8. Bot genera link de pago Culqi/Izipay con monto del servicio
9. Bot envía el link: "Para confirmar tu cita, completá el pago aquí: [link]"
10. [Webhook Culqi/Izipay confirma el pago con HMAC]
11. Sistema:
      a. Actualiza cita: estado = confirmada, pagoId = X
      b. Emite CPE SUNAT (boleta/factura según régimen + receptor)
      c. WhatsApp → cliente: confirmación con fecha, dirección, link PDF comprobante,
         aviso de recordatorio
      d. WhatsApp → profesional: nombre+DNI cliente, fecha, monto recibido;
         si 4ta categoría → link para emitir RHE
```

---

## Recordatorios automáticos (worker — croner)

Los recordatorios se envían como **WhatsApp UTILITY templates** (aprobados por Meta).

| Recordatorio | Cuándo | Template sugerido | Acción del cliente |
|---|---|---|---|
| 24h antes | 24 h previas a `fecha_hora_inicio` | "Recordatorio: mañana tenés cita a las {hora}. ¿Confirmás? Respondé Sí / Cancelar" | Respuesta activa → flujo de confirmación o cancelación |
| 2h antes | 2 h previas a `fecha_hora_inicio` | "Tu cita de hoy es a las {hora} en {dirección}. ¡Te esperamos!" | Informativo, sin acción |
| Post-cita | ~30 min después de `fecha_hora_fin` | "¿Cómo fue tu experiencia? Calificá del 1 al 5" | Captura de feedback |

El worker (`worker.ts`) corre un job croner cada 15 minutos:
```
- Busca citas confirmadas donde fecha_hora_inicio BETWEEN NOW()+24h-15m AND NOW()+24h
  y recordatorio_24h_enviado = false → envía template + marca true
- Busca citas confirmadas donde fecha_hora_inicio BETWEEN NOW()+2h-15m AND NOW()+2h
  y recordatorio_2h_enviado = false → envía template + marca true
- Busca citas confirmadas donde fecha_hora_fin < NOW()-30m
  y estado = confirmada → marca estado = no_asistio (si no se marcó completada)
```

No se usa n8n ni cron externo: todo vive en el worker binario del Hub.

---

## Reglas de negocio (invariantes — van a la capa de aplicación)

### RN-01 — Anticipación mínima
Una cita no puede reservarse para un slot cuyo inicio sea inferior a `servicio.anticipacion_min_hrs` horas en el futuro.

### RN-02 — Sin solapamiento
Un slot está disponible solo si no existe otra `cita` en estado `pendiente_pago` o `confirmada` que lo ocupe total o parcialmente.

### RN-03 — Bloqueos tienen prioridad total
Si el slot cae dentro de un `bloqueo_agenda`, no se ofrece, sin importar `horarios_disponibles`.

### RN-04 — Pago obligatorio para confirmar
Una cita en `pendiente_pago` NO es una reserva confirmada. El slot permanece bloqueado (para evitar dobles reservas) pero se libera automáticamente si el pago no llega dentro de 30 minutos (job de expiración en worker).

### RN-05 — Ventana de cancelación
El cliente solo puede cancelar si `NOW() < cita.fecha_hora_inicio - servicio.cancelacion_max_hrs horas`. Fuera de esa ventana, la cancelación requiere gestión manual del tenant.

### RN-06 — No-show automático
Si a los 30 minutos post `fecha_hora_fin` la cita sigue en `confirmada`, el worker la marca `no_asistio`. El tenant puede revertir manualmente.

### RN-07 — Comprobante post-pago únicamente
El `comprobante_id` solo se llena una vez el pago está confirmado y SUNAT acepta el CDR. Nunca antes.

### RN-08 — Multi-tenancy estricta
Ninguna query puede incluir `WHERE tenant_id = ?` explícito. La política RLS `tenant_isolation` en cada tabla lo hace vía `SET LOCAL app.current_tenant`.

### RN-09 — Moneda
La moneda de un servicio es `PEN` por defecto. El pago se procesa en la misma moneda que el servicio. No hay conversión en el Hub.

---

## Escenarios

### Escenario 1 — Reserva exitosa (happy path)

```
Dado:   servicio "Consulta psicológica" (60 min, S/80, anticipación 2h, cancelación 24h)
        horario disponible: Lunes 09:00–13:00
        sin bloqueos ni citas existentes
        cliente WA: Mario Condori, DNI 12345678

Cuando: Mario elige "Lunes 23/06 09:00–10:00"
        proporciona nombre "Mario Condori" + DNI
        completa el pago Culqi S/80

Entonces:
  - cita creada con estado = confirmada
  - WhatsApp a Mario: confirmación con fecha, dirección, PDF boleta
  - WhatsApp al profesional: "Nueva cita — Mario Condori (DNI 12345678), Lunes 23/06 09:00, S/80 recibido"
  - recordatorio_24h_enviado = false (se enviará el domingo 22/06 ~09:00)
```

### Escenario 2 — Cancelación dentro de la ventana

```
Dado:   cita confirmada para Lunes 23/06 10:00
        servicio.cancelacion_max_hrs = 24
        NOW() = Domingo 22/06 08:00

Cuando: cliente solicita cancelar vía WhatsApp

Entonces:
  - cita.estado = cancelada
  - cita.motivo_cancelacion = "Cancelada por el cliente vía WhatsApp"
  - WhatsApp al cliente: "Tu cita fue cancelada. Para reagendar, escribinos."
  - WhatsApp al profesional: "Mario Condori canceló la cita del Lunes 23/06 10:00"
  - El slot queda libre para nuevas reservas
  - El reembolso del pago es responsabilidad del tenant (fuera del alcance del Hub)
```

### Escenario 3 — Intento de cancelación fuera de la ventana

```
Dado:   cita confirmada para Lunes 23/06 10:00
        servicio.cancelacion_max_hrs = 24
        NOW() = Lunes 23/06 09:30

Cuando: cliente solicita cancelar vía WhatsApp

Entonces:
  - AgendaPort.cancelarCita devuelve Err({ code: 'CANCELACION_FUERA_DE_VENTANA' })
  - WhatsApp al cliente: "Lo sentimos, esta cita ya no puede cancelarse por este medio.
    Comunicate directamente con el negocio."
  - cita.estado NO cambia
```

### Escenario 4 — No-show

```
Dado:   cita confirmada para Lunes 23/06 10:00–11:00
        NOW() = Lunes 23/06 11:35
        cita.estado = confirmada (el profesional no marcó completada)

Cuando: worker de no-show corre (cada 15 min)

Entonces:
  - cita.estado = no_asistio
  - Log de auditoría registra el evento
  - (Opcional Corte 5) WhatsApp al cliente: "Te perdimos hoy. ¿Reagendamos?"
```

### Escenario 5 — Expiración de pago pendiente

```
Dado:   cita en pendiente_pago creada a las 15:00
        NOW() = 15:31

Cuando: worker de expiración corre

Entonces:
  - cita.estado = cancelada, motivo_cancelacion = "Pago no recibido en 30 minutos"
  - El slot queda libre
  - WhatsApp al cliente: "Tu reserva expiró por falta de pago. Podés intentar de nuevo."
```

---

## Pantallas dashboard (Next.js)

1. **Servicios** — CRUD de `servicios_agenda`: nombre, duración, precio, anticipación, ventana de cancelación, color, estado activo/inactivo.
2. **Horarios** — Configuración de `horarios_disponibles` por servicio: grilla semanal con franjas horarias.
3. **Bloqueos** — CRUD de `bloqueos_agenda`: fecha inicio/fin + motivo (vacaciones, feriado, etc.).
4. **Calendario de citas** — Vista semanal/mensual de `citas` por estado; acción manual para marcar completada, cancelar, o revertir no-show.
5. **Detalle de cita** — Estado completo, datos del receptor, pago vinculado, comprobante PDF, historial de eventos.

---

## Convenciones técnicas

- **Schema Postgres:** `agenda` (tablas: `servicios_agenda`, `horarios_disponibles`, `bloqueos_agenda`, `citas`).
- **RLS:** política `tenant_isolation` en las cuatro tablas; el middleware de Hono corre `SET LOCAL app.current_tenant = '<uuid>'` por request.
- **PKs:** `UUID` (`gen_random_uuid()`).
- **Timestamps:** siempre `TIMESTAMPTZ`; nunca `TIMESTAMP` sin zona.
- **Soft-delete:** `deleted_at TIMESTAMPTZ NULL` en `servicios_agenda` y `citas`; las otras dos tablas se eliminan físicamente (son configuración, no historial).
- **i18n:** labels y mensajes de WhatsApp en `es.json`; código y comentarios en inglés.
- **Errores en dominio:** `Result<T, AgendaError>` — nunca `throw` en lógica de negocio.
- **IA Tool:** `scheduleAppointment` solo lee disponibilidad y crea la cita en `pendiente_pago`; nunca confirma ni cobra directamente.

---

## Fuera de alcance de este módulo

| Qué | Por qué / Cuándo |
|---|---|
| Gestión de historiales clínicos / notas de sesión | No es un EHR; fuera del Hub |
| Pagos con Yape/Plin | Confirmación manual en MVP (Corte 3 lo define) |
| Reagendamiento automático | Corte 5 o posterior |
| Citas recurrentes (p.ej. clase semanal fija) | Requiere motor de recurrencia; fuera de Corte 4 |
| Multi-profesional por tenant | Corte 5 (un profesional por tenant en MVP) |
| Reembolsos automáticos al cancelar | Responsabilidad del tenant; el Hub no custodia fondos |
| Reservas de mesas (restaurante) con número de comensales | El schema base lo soporta; UI específica en Corte 5 |

---

## Preguntas abiertas

1. **¿El slot en `pendiente_pago` bloquea el slot para otros clientes?**
   Propuesta: sí, por 30 minutos (RN-04). ¿El tenant quiere configurar ese timeout?

2. **¿Qué pasa si Culqi no dispara el webhook?** (red failure)
   Propuesta: worker de reconciliación consulta la API de Culqi cada hora para citas en `pendiente_pago` con más de 1h de antigüedad.

3. **¿El recordatorio de 24h pregunta "confirmás / cancelar"?**
   Si el cliente responde "Cancelar", ¿aplica la ventana de cancelación o hay política especial de respuesta al recordatorio?

4. **¿Multi-profesional desde Corte 4 o Corte 5?**
   Un consultorio con dos médicos necesitaría `profesional_id` en `citas` y en `horarios_disponibles`. Definir antes de implementar el schema.

5. **Academia con cupos:** ¿`citas` representa un alumno en una clase grupal (muchos-a-uno sobre un slot) o una sesión individual? Si es grupal, se necesita `capacidad_maxima` en `servicios_agenda` y contar citas por slot.
