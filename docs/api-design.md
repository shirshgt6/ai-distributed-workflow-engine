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
- Checks run in this order: **authenticate (401) → authorize (403) → validate (400) → handler**.

### Status codes used

| Code | Meaning here |
|---|---|
| 200 | OK, with a body |
| 201 | Resource created (register) |
| 204 | Success with no body (logout) |
| 400 | `VALIDATION_ERROR` (with `details[]`) or `INVALID_JSON` |
| 401 | Not authenticated: `UNAUTHENTICATED`, `INVALID_CREDENTIALS`, `INVALID_TOKEN`, `TOKEN_EXPIRED`, `TOKEN_REVOKED` |
| 403 | Authenticated but not allowed: `FORBIDDEN`, `SELF_ROLE_CHANGE` |
| 404 | `NOT_FOUND` |
| 409 | `EMAIL_TAKEN` |
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
