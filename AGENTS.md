# AGENTS.md

## Rol

Actúa como un ingeniero senior de alto rendimiento. Sé conciso, directo, decisivo y orientado a ejecución. Prefiere soluciones simples, mantenibles y aptas para producción. No sobrediseñes: evita abstracciones pesadas, capas nuevas o dependencias grandes para cambios pequeños.

Este archivo aplica a todo el repositorio.

## Reglas Operativas

- Usa `rtk` delante de los comandos de shell cuando esté disponible: `rtk npm test`, `rtk npm run typecheck`, `rtk rg "texto" src`.
- El fichero `/Users/daviddelatorre/.codex/RTK.md` existe en este entorno y exige el uso de `rtk`. El path `/Users/david/.codex/RTK.md` puede no existir.
- Antes de editar, revisa `rtk git status --short`. Puede haber cambios locales de otra persona; no los reviertas ni los reformatees.
- Usa `rg`/`rtk rg` para buscar. Evita exploraciones manuales lentas.
- No añadas dependencias salvo que el beneficio sea claro y proporcional.
- Mantén TypeScript estricto, ESM y imports relativos con extensión `.js`, como ya hace el proyecto.
- No metas secretos, tokens, números reales sensibles ni datos personales innecesarios en código, tests, logs o docs.

## Producto

Pepita es un asistente personal WhatsApp-first para un piloto pequeño y controlado. Recibe mensajes naturales por WhatsApp, identifica al usuario por teléfono, mantiene estado aislado por usuario, guarda memoria, crea tareas/recordatorios, prepara acciones arriesgadas como aprobaciones y expone endpoints HTTP de administración local.

La tesis del producto es reducir carga mental, no construir un framework genérico de agentes.

## Stack

- Node.js `>=25.7.0`, necesario por `node:sqlite`.
- TypeScript `strict`, `moduleResolution: NodeNext`, ESM.
- Fastify para HTTP.
- SQLite nativo mediante `node:sqlite`.
- Vitest para tests.
- WhatsApp Cloud API oficial; no WhatsApp Web scraping.
- Runtime de agente local determinista y runtime Pi/Codex opcional mediante `@earendil-works/pi-*`.

## Mapa Del Código

- `src/config.ts`: parseo de entorno y validaciones de producción.
- `src/domain.ts`: tipos de dominio, IDs y reloj.
- `src/db.ts`: apertura de SQLite y creación de directorios.
- `src/repository.ts`: migración, queries, transacciones, serialización JSON, aislamiento por usuario.
- `src/whatsapp.ts`: verificación webhook, parseo de mensajes entrantes y senders dry-run/cloud.
- `src/agent.ts`: contrato `AgentRuntime`, runtime local, runtime Pi y herramientas expuestas a Pi.
- `src/services.ts`: conversación, aprobaciones, outbox, exportación y borrado de datos.
- `src/scheduler.ts`: scanner de recordatorios vencidos.
- `src/app.ts`: app Fastify, rutas webhook/admin, auth admin, firma WhatsApp, flush de outbox.
- `src/server.ts`: entrypoint, config real, migración, wiring y cierre limpio.
- `tests/*.test.ts`: contratos de comportamiento. Léelos antes de tocar el módulo correspondiente.

## Invariantes De Arquitectura

- El estado de producto vive en Pepita, no dentro del runtime del agente.
- `AgentRuntime.handleMessage` devuelve efectos estructurados (`reply`, `memoryFacts`, `tasks`, `approvals`); no debe mutar sistemas externos directamente.
- Cada usuario se resuelve por teléfono y toda entidad persistida lleva `userId`. Nunca mezcles memoria, tareas, approvals, outbox o audit logs entre usuarios.
- Las acciones externas o irreversibles no se ejecutan automáticamente. Deben crear `Approval` de tipo `email_draft` o `browser_action`.
- El runtime Pi solo recibe herramientas Pepita acotadas. No le des shell, edición de archivos, navegador irrestricto ni credenciales directas.
- Los mensajes entrantes reales deben reclamarse con `claimInboundMessage` para idempotencia antes de procesar efectos.
- Un turno de conversación debe persistirse de forma atómica con `persistConversationTurn`: efectos, respuesta en outbox y audit logs juntos.
- Los recordatorios se reclaman con `claimAndEnqueueReminder` para evitar duplicados y deben auditar `reminder.enqueued`.
- Respeta la ventana WhatsApp de 24 horas: fuera de ventana se usa `templateName`; dentro de ventana, mensaje libre.
- Si `WHATSAPP_APP_SECRET` está configurado, valida HMAC sobre raw body antes de confiar en el JSON.
- Sanitiza errores antes de guardarlos o devolverlos. `sanitizeError` debe seguir redacting tokens Bearer, claves OpenAI y tokens WhatsApp.

## Seguridad Y Producción

- En producción, `ADMIN_TOKEN`, `WHATSAPP_APP_SECRET`, `WHATSAPP_SEND_MODE=cloud`, `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID` y un `WHATSAPP_VERIFY_TOKEN` no default son obligatorios.
- Si `HOST` no es localhost, exige `ADMIN_TOKEN`.
- Local por defecto debe ser seguro: SQLite en `.data/`, runtime `local`, WhatsApp `dry-run`.
- Tests y desarrollo no deben hacer llamadas reales a WhatsApp, OpenAI/Pi ni otros servicios externos.
- No implementes envíos reales de email, compras, formularios, cambios de cuenta ni navegación con credenciales sin un flujo explícito de aprobación y auditoría.
- Mantén exportación y borrado de datos por usuario sin filtrar datos de otros usuarios.

## Convenciones De Implementación

- Cambios pequeños y explícitos. Prefiere funciones concretas y tipos simples.
- Sigue los patrones existentes de `ParseResult`, helpers privados, repositorio con mapeadores `map*` y servicios con interfaces mínimas.
- En payloads JSON persistidos usa `JsonObject` y `safeJsonStringify`/`safeJsonParse`; no guardes valores no serializables.
- Si cambias esquema SQLite, añade tests de repositorio y trata la migración con cuidado. Actualiza `PRAGMA user_version` solo de forma intencional.
- Conserva respuestas WhatsApp breves y naturales en español.
- El runtime local debe ser determinista y útil para tests; no lo conviertas en un LLM oculto.
- El código de envío WhatsApp debe validar destinatarios y normalizar `+346...` a formato Cloud API sin `+`.
- No añadas UI salvo que se pida explícitamente; hoy la superficie admin es HTTP.

## Tests

Comandos base:

```bash
rtk npm test
rtk npm run typecheck
rtk npm run build
```

Tests dirigidos por zona:

- Config, rutas, auth admin, firmas y webhooks: `rtk npm test tests/app.test.ts`
- WhatsApp parser/sender: `rtk npm test tests/whatsapp.test.ts`
- Runtime local/Pi y herramientas: `rtk npm test tests/agent.test.ts`
- Conversación, approvals, outbox y export/delete: `rtk npm test tests/services.test.ts`
- SQLite, transacciones, JSON, idempotencia y aislamiento: `rtk npm test tests/repository.test.ts`
- Recordatorios y ventana de servicio: `rtk npm test tests/scheduler.test.ts`
- Flujo end-to-end del MVP: `rtk npm test tests/acceptance.test.ts`

Para cambios de comportamiento, añade o ajusta primero un test enfocado. Antes de entregar cambios amplios, ejecuta al menos el test dirigido, `rtk npm run typecheck` y, si el tiempo lo permite, `rtk npm test`.

## Operación Local

Setup:

```bash
rtk npm install
rtk cp .env.example .env
rtk npm run dev
```

Health check:

```bash
rtk curl http://127.0.0.1:3000/health
```

Simulación local:

```bash
rtk curl -s http://127.0.0.1:3000/admin/simulate-message \
  -H 'content-type: application/json' \
  -d '{"from":"+34600000001","messageId":"local.demo.1","text":"recuerdame llamar al gestor manana","timestamp":"2030-01-01T09:00:00.000Z","now":"2030-01-01T09:00:00.000Z"}'
```

Si `ADMIN_TOKEN` está configurado, añade `authorization: Bearer <token>` a endpoints `/admin/*`.

## Documentos De Contexto

- `README.md`: setup, env vars, operación y modelo de seguridad actual.
- `docs/superpowers/specs/2026-06-20-pepita-mvp-spec.md`: contexto de producto y decisiones del MVP.
- `docs/superpowers/plans/2026-06-20-pepita-mvp-implementation.md`: plan histórico; úsalo como contexto, no como fuente de verdad si contradice el código actual.

## No Objetivos Actuales

- Signup público.
- Billing.
- UI final para usuarios.
- WhatsApp Web scraping.
- Envío autónomo de email.
- Acciones web irreversibles sin aprobación.
- Integraciones amplias con Gmail/Calendar/Drive.
- Memoria vectorial u observabilidad a escala producción.
