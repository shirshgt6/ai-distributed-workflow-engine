# Security

Only what is implemented. Planned items are listed separately at the bottom.

## Authentication

| Concern | Implementation | File |
|---|---|---|
| Password storage | bcrypt (bcryptjs), cost 12 by default, random per-password salt | `src/auth/password.js` |
| bcrypt 72-byte truncation | Passwords over 72 **bytes** are rejected at registration | `src/auth/auth.schemas.js` |
| Tokens | JWT HS256. Access 15m (`sub`, `role`), refresh 7d (`sub`, `tv`) | `src/auth/tokens.js` |
| Token confusion | Separate secrets per token type **and** a `type` claim checked on verify | `src/auth/tokens.js` |
| `alg: none` / algorithm confusion | Algorithm pinned to HS256 on verify; issuer checked | `src/auth/tokens.js` |
| Secret quality | ≥ 32 chars, access ≠ refresh, placeholders refused when `NODE_ENV=production` | `src/config/env.js` |
| Revocation | `tokenVersion` on the user; refresh requires `token.tv === user.tokenVersion`. Logout and role changes increment it | `src/services/auth.service.js` |
| User enumeration (message) | Unknown email and wrong password return the identical 401 `INVALID_CREDENTIALS` | `src/services/auth.service.js` |
| User enumeration (timing) | Unknown emails are compared against a dummy hash computed at startup, so both paths cost one bcrypt compare | `src/services/auth.service.js` |
| Duplicate accounts under concurrency | Unique index on `email`; the duplicate-key error is mapped to 409, with no racy pre-check | `src/models/user.model.js` |

## Authorization (RBAC)

Roles: `admin`, `operator`, `viewer`. The single source of truth is `src/auth/permissions.js`.

| Permission | admin | operator | viewer |
|---|---|---|---|
| workflow:create | ✅ | ✅ | ❌ |
| workflow:read | ✅ | ✅ | ✅ |
| workflow:run | ✅ | ✅ | ❌ |
| approval:decide | ✅ | ✅ | ❌ |
| analytics:read | ✅ | ✅ | ✅ |
| user:manage | ✅ | ❌ | ❌ |

- **Deny by default:** an unknown role or permission means no access.
- **Least privilege:** self-registered users are always `viewer`. The first admin is created out of band with `npm run create-admin`, which reads credentials from env vars and never from argv.
- **Mass assignment:** request bodies are parsed with zod allowlist schemas, and controllers only read `req.valid`, so a `role` field in a register body is dropped.
- An admin cannot change their own role, which prevents accidentally leaving the system with no admin.
- **Object-level authorization (BOLA/IDOR protection).** `ownerScope(user)` (`src/auth/ownership.js`) is merged into every workflow query. Non-admins only match their own documents, and admins match all. A foreign workflow returns **404, the same as a missing id**, so ids can't be probed. Updates use the same scope, so they can't touch a foreign workflow either. `ownerId` always comes from the JWT, never from the body.

## HTTP hardening (Phase 1)
helmet headers, `x-powered-by` disabled, JSON body limit (100kb), uniform error responses that never expose internal error messages, and a validated `X-Request-Id`.

## Logging
pino redacts `authorization` and `cookie` headers, and fields named `password`, `passwordHash`, `token`, `accessToken`, `refreshToken` and `apiKey`. Request log lines include `userId` once the request is authenticated.

## Known limitations (accepted, documented)
- **An access token stays valid until it expires (≤ 15 min)** after logout or a role change. That's the cost of stateless verification. Mitigations would be a short TTL (used here) or a Redis denylist keyed by `jti` (not implemented).
- **Logout revokes all devices.** `tokenVersion` is per user, not per session.
- **Refresh tokens are not rotated with reuse detection.** An old refresh token keeps working until logout or expiry. Production improvement: store each refresh token's `jti`, rotate on every use, and treat reuse of an old one as theft (revoke everything).
- **Registration reveals whether an email exists** (409 `EMAIL_TAKEN`). This is a usability trade-off, and rate limiting is the mitigation.

## Rate limiting (Phase 24), `src/middleware/rateLimit.js`
A **sliding-window log** in Redis as **one Lua script** (drop old entries → count → add or refuse). It's atomic, so 20
concurrent requests against a limit of 5 let exactly 5 through (tested). Unlike a fixed window, it never allows 2× the
limit around a boundary.

| Limiter | Key | Limit | Redis down |
|---|---|---|---|
| login per account | IP + email | 5 / 15 min | **fail closed** (503) |
| login per IP | IP | 20 / 15 min | **fail closed** |
| register | IP | 5 / hour | **fail closed** |
| authenticated API | user id | 300 / min | fail open |
| start runs | user id | 60 / min | fail open |
| document uploads | user id | 20 / hour | fail open |

- Limits run **before validation and bcrypt**, so every attempt counts and a flood never burns CPU on password hashing.
- The response carries `RateLimit-Limit`, `RateLimit-Remaining`, and on 429 a `Retry-After` header plus `RATE_LIMITED` details.
- **The fail-open vs fail-closed choice:** protection that matters for security (login) must not disappear when Redis does.
  General limits favour availability.
- `req.ip` comes from `TRUST_PROXY`. Only trust your own proxy hops, because `X-Forwarded-For` is otherwise attacker-controlled.

## Threat model: attack → control → evidence
| Attack | Control | Tested |
|---|---|---|
| Password brute force on one account | per IP+email limit | ✅ the 6th attempt returns 429, even with the correct password |
| Credential spraying across accounts | per-IP login limit | ✅ |
| Offline cracking after a DB leak | bcrypt cost 12, per-password salt | ✅ (hash format) |
| User enumeration (message and timing) | identical 401 + dummy hash | ✅ |
| Token forgery / `alg:none` / token confusion | pinned HS256, separate secrets, `type` claim | ✅ |
| Mass assignment (`role: admin`) | zod allowlists, server-set fields | ✅ |
| BOLA/IDOR (others' workflows, runs, docs, approvals, analytics) | ownership filter **inside every query**, 404 | ✅ |
| Privilege escalation (operator → admin) | RBAC table, `user:manage` admin-only | ✅ |
| NoSQL operator injection (`{"$ne": null}`) | zod types + ObjectId validation; `strictQuery` | ✅ 400 before any query |
| Large-payload DoS | 100 KB body limit (256 KB for `/documents`), zod max lengths, task/doc caps | ✅ 413 |
| Prompt injection → extra output fields | structured output + zod (unknown keys stripped) | ✅ |
| Prompt injection → invented enum / tool | enums in schemas; invalid output → repair → reject or heuristic | ✅ |
| Prompt injection via documents / tool results | `<document>`/`<tool_result>` delimiters + citation enum + tool allowlist | ✅ (a model that *obeys* the injection still can't call `shell`) |
| Agent reading other users' data | ownerId from the task context, never from model args | ✅ |
| Arbitrary code execution through the agent | no shell/HTTP/file tools; calculator parser, never `eval` | ✅ |
| Secrets in the repo | `.gitignore`, `npm run check:secrets` (patterns + local `.env` values) | ✅ run before each commit |
| Secrets in logs | pino redaction; no prompt text stored in `aiexecutions` | ✅ |
| Vulnerable dependencies | `npm run audit` | 0 known vulnerabilities at the time of writing |

## Not implemented (known gaps)
CORS configuration (the API is intended for server-side or same-origin clients: browsers block cross-origin calls by
default), CSRF (not applicable to Bearer-token APIs), refresh-token rotation with reuse detection, separation of duties
for approvals, a WAF / bot detection, encryption at rest (delegated to the database deployment), and security headers
beyond helmet's defaults.
