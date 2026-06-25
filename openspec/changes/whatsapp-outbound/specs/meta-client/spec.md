# Spec — meta-client (delta)

> Change: whatsapp-outbound
> Domain: meta-client (NEW capability — injectable Meta Cloud API egress)
> Artifact store: hybrid
> Marker: ADDED

---

## Purpose

Define the observable behavior of the `MetaClient` abstraction: the interface
contract, the real HTTP implementation, and the controllable test double.
This spec describes WHAT must be true — not how it is implemented.

---

## Requirements

### Requirement: MetaClient Interface Contract

The system MUST expose a `MetaClient` interface with a single method:

```
sendText({ phoneNumberId, accessToken, to, text }): Promise<Result<{ wamid, status }, MetaSendError>>
```

All parameters are required non-empty strings. The method MUST return
`Result<T, E>` — it MUST NOT throw for any business or API error. Only
unrecoverable infrastructure failures (e.g. process crash) are allowed to
propagate as uncaught exceptions.

#### Scenario: interface is satisfied by both real and fake implementations

- GIVEN `createMetaClient(version)` is called with a version string
- WHEN the returned object is assigned to a `MetaClient`-typed variable
- THEN TypeScript compilation succeeds without type errors

- GIVEN `createFakeMetaClient()` is called
- WHEN the returned object is assigned to a `MetaClient`-typed variable
- THEN TypeScript compilation succeeds without type errors

---

### Requirement: Real Implementation — POST to Meta Graph API

`createMetaClient(version)` MUST return a `MetaClient` whose `sendText` method
posts to:

```
https://graph.facebook.com/<version>/{phoneNumberId}/messages
```

where `<version>` is the value passed to `createMetaClient` (e.g. `v21.0`).
The version MUST NOT be hardcoded inside the function body.

The HTTP request MUST include:
- Header `Authorization: Bearer <accessToken>`
- Header `Content-Type: application/json`
- JSON body:
  ```json
  {
    "messaging_product": "whatsapp",
    "recipient_type": "individual",
    "to": "<to>",
    "type": "text",
    "text": { "body": "<text>", "preview_url": false }
  }
  ```

On a successful Meta response, the implementation MUST parse `messages[0].id`
from the response body as `wamid` and return `ok({ wamid, status: 'sent' })`.

The `accessToken` value MUST NOT appear in any log line at any level.

#### Scenario: successful send parses wamid from Meta response

- GIVEN a real `MetaClient` constructed with `version = 'v21.0'`
- AND the Meta API returns HTTP 200 with body `{ "messages": [{ "id": "wamid_real_001" }] }`
- WHEN `sendText({ phoneNumberId: 'pnid', accessToken: 'tok', to: '+51987654321', text: 'Hola' })` is called
- THEN the result is `ok({ wamid: 'wamid_real_001', status: 'sent' })`

#### Scenario: configurable version is used in the URL

- GIVEN `createMetaClient('v99.0')` is called
- WHEN `sendText` makes an HTTP request
- THEN the URL contains `/v99.0/` (not any hardcoded version string)

---

### Requirement: Real Implementation — Meta Error Mapping

When the Meta API returns a non-2xx HTTP status or an error payload, the
implementation MUST map the error to a typed `MetaSendError` and return it as
`err(...)` — NEVER throw. Specifically:

- If the Meta response body contains an `error.code` field, that value MUST be
  surfaced as `metaCode` in the error.
- If the HTTP request fails at the transport level (no response received), the
  error MUST be returned as `err({ kind: 'network', ... })`.

The raw Meta error body MAY be included for structured logging, but MUST NOT be
forwarded verbatim as the API response.

#### Scenario: Meta returns error code 131047 → err with metaCode 131047

- GIVEN a real `MetaClient`
- AND the Meta API returns HTTP 400 with body `{ "error": { "code": 131047, "message": "..." } }`
- WHEN `sendText` is called
- THEN the result is `err({ metaCode: 131047, ... })`
- AND no exception is thrown

#### Scenario: Meta returns other error code → err with that metaCode

- GIVEN a real `MetaClient`
- AND the Meta API returns HTTP 400 with body `{ "error": { "code": 190, "message": "Invalid OAuth token" } }`
- WHEN `sendText` is called
- THEN the result is `err({ metaCode: 190, ... })`
- AND no exception is thrown

#### Scenario: network failure → err with kind 'network'

- GIVEN a real `MetaClient`
- AND the underlying `fetch` call throws a `TypeError` (e.g. DNS failure, connection refused)
- WHEN `sendText` is called
- THEN the result is `err({ kind: 'network', ... })`
- AND no exception is thrown to the caller

---

### Requirement: Fake Implementation — Controllable Test Double

`createFakeMetaClient()` MUST return an object that satisfies the `MetaClient`
interface AND exposes control methods for tests. The fake:

- MUST default to returning a successful result on `sendText` (programmable
  success with a generated `wamid`).
- MUST allow tests to program a specific error to be returned on the next call
  (e.g. `fake.queueError({ metaCode: 131047 })`).
- MUST record calls to `sendText` so tests can assert the arguments passed.
- MUST NOT make any real network requests.

#### Scenario: fake returns success by default

- GIVEN `createFakeMetaClient()` with no error programmed
- WHEN `sendText({ phoneNumberId: 'pnid', accessToken: 'tok', to: '+51987654321', text: 'Hola' })` is called
- THEN the result is `ok({ wamid: <non-empty string>, status: 'sent' })`
- AND no network request is made

#### Scenario: fake returns programmed error

- GIVEN `createFakeMetaClient()` with `fake.queueError({ metaCode: 131047 })` called beforehand
- WHEN `sendText` is called
- THEN the result is `err({ metaCode: 131047, ... })`
- AND no network request is made

#### Scenario: fake records call arguments for assertion

- GIVEN `createFakeMetaClient()`
- WHEN `sendText({ phoneNumberId: 'pnid', accessToken: 'tok', to: '+51987654321', text: 'Hola' })` is called
- THEN `fake.calls` (or equivalent) contains exactly one entry with those arguments
- AND the `accessToken` in the recorded call is `'tok'` (the fake records it for test assertion only — no log output)

---

### Requirement: API Version from Environment

The `WHATSAPP_META_API_VERSION` environment variable MUST be read by the
application wiring (`env.ts` + `app.ts`) and passed to `createMetaClient(version)`.
The version MUST NOT be hardcoded anywhere in production code.
If the env var is absent, the default `v21.0` MUST be used.

#### Scenario: env var absent → default v21.0 is used

- GIVEN `WHATSAPP_META_API_VERSION` is not set in the environment
- WHEN the application starts
- THEN the Meta client is constructed with version `v21.0`

#### Scenario: env var present → that version is used

- GIVEN `WHATSAPP_META_API_VERSION=v22.0` is set
- WHEN the application starts
- THEN the Meta client is constructed with version `v22.0`

---

## Out of Scope (Non-Requirements for This Slice)

- Template (HSM) message sending.
- Media message sending.
- Delivery-status webhook handling.
- Token encryption or rotation.
- Multiple concurrent Meta accounts or phone number IDs per call.
- `WHERE tenant_id` in any query — this module has no DB access.
