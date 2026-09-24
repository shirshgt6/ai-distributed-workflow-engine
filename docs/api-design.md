# API Design

Only implemented endpoints are listed. An OpenAPI/Swagger spec comes in Phase 27.

## Conventions

- JSON in, JSON out.
- **Every error** has the same shape:
  ```json
  { "error": { "code": "MACHINE_READABLE", "message": "Human readable", "requestId": "…", "details": "optional" } }
  ```
  Clients should branch on `code`, never on `message`.
- `X-Request-Id` is echoed back, or generated if missing.
- Protected endpoints take `Authorization: Bearer <accessToken>`.
- Checks run in this order: **authenticate (401) → authorize (403) → validate (400) → handler**. Ownership is checked in the service, and a foreign resource returns **404**.
- **Ownership:** non-admins only ever see their own resources. Someone else's resource returns **404, not 403**, so its existence isn't revealed. Admins see all.

### Status codes used

| Code | Meaning here |
|---|---|
| 200 | OK, with a body |
| 201 | Resource created (register, workflow) + `Location` for workflows |
| 202 | Accepted: a run was started (not finished); `Location: /executions/:id` |
| 204 | Success with no body (logout) |
| 400 | `VALIDATION_ERROR` (with `details[]`), `INVALID_WORKFLOW_GRAPH` (with graph `details[]`), or `INVALID_JSON` |
| 401 | Not authenticated: `UNAUTHENTICATED`, `INVALID_CREDENTIALS`, `INVALID_TOKEN`, `TOKEN_EXPIRED`, `TOKEN_REVOKED` |
| 403 | Authenticated but not allowed: `FORBIDDEN`, `SELF_ROLE_CHANGE` |
| 404 | `NOT_FOUND` |
| 409 | `EMAIL_TAKEN`, `VERSION_CONFLICT` |
| 413 | `PAYLOAD_TOO_LARGE` |
| 500 | `INTERNAL_ERROR` (details only in logs) |
| 503 | Not ready (`/ready`) |

## Endpoints

### Health
| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/health` | — | Liveness, checks no dependencies |
| GET | `/ready` | — | Readiness: Mongo + Redis; 503 if down or shutting down |

### Auth
| Method | Path | Auth | Body | Success |
|---|---|---|---|---|
| POST | `/auth/register` | — | `{ email, password }` (8 chars min, 72 bytes max) | 201 `{ user }`, role is always `viewer` |
| POST | `/auth/login` | — | `{ email, password }` | 200 `{ user, tokenType, accessToken, expiresIn, refreshToken }` |
| POST | `/auth/refresh` | — | `{ refreshToken }` | 200 new token pair |
| POST | `/auth/logout` | Bearer | — | 204, revokes all of the user's refresh tokens |
| GET | `/auth/me` | Bearer | — | 200 `{ user }` |

### Users
| Method | Path | Auth | Permission | Body | Success |
|---|---|---|---|---|---|
| PATCH | `/users/:id/role` | Bearer | `user:manage` | `{ role }` | 200 `{ user }`; the target's refresh tokens are revoked |

`user` objects never include `passwordHash` or `tokenVersion`.

### Workflows (definitions)
| Method | Path | Permission | Body / query | Success |
|---|---|---|---|---|
| POST | `/workflows` | `workflow:create` | `{ name, description?, tasks[] }` | 201 `{ workflow }` + `Location` header, `version: 1` |
| POST | `/workflows/validate` | `workflow:create` | same body as create | 200 `{ valid, errors[], order[], levels[][], criticalPathLength }`, nothing saved (200 even when `valid:false`) |
| GET | `/workflows` | `workflow:read` | `?limit=1..100 (20)&page=1..` | 200 `{ items, page, limit, total }` (own only; admin: all) |
| GET | `/workflows/:id` | `workflow:read` | — | 200 `{ workflow }`; 404 if missing **or not yours** |
| PUT | `/workflows/:id` | `workflow:create` | `{ name, description?, tasks[], version }` | 200, `version` + 1; **409 `VERSION_CONFLICT`** if `version` is stale |

Task definition: `{ key, type, name?, dependsOn[], config{}, retryPolicy{maxAttempts 1-10, baseDelayMs}, timeoutMs 100ms-1h }`.
Limits: ≤ 100 tasks, ≤ 50 dependencies per task.
Create and update validate the shape (zod) **and** the graph (cycles, unknown or duplicate dependencies, duplicate keys). An invalid graph returns 400 `INVALID_WORKFLOW_GRAPH`, with one entry per problem, e.g. `{ code: "CYCLE", cycle: ["A","B","C","A"], message }`.

Pagination is offset-based (simple). Known trade-offs: deep pages get slower, and items can shift if data changes between pages. Cursor pagination is the upgrade.

### Executions
| Method | Path | Permission | Body | Success |
|---|---|---|---|---|
| POST | `/workflows/:id/run` | `workflow:run` | `{ input?: object }` | **202** `{ execution }` + `Location: /executions/:id`. 404 if the workflow is missing or not yours; 400 `INVALID_WORKFLOW_GRAPH` for a stored invalid graph |
| GET | `/executions/:id` | `workflow:read` | — | 200 `{ execution, tasks[] }` (tasks: key, type, status, dependsOn, attempt, output, error, timestamps); 404 if not yours |

A run is asynchronous. The client polls `GET /executions/:id` until `execution.status` is `COMPLETED` or `FAILED`.
The execution belongs to the **workflow's owner** (so they can see it), and `triggeredBy` records who started it.
