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

## Planned (not implemented)
Login and registration rate limiting (Redis, Phase 24), prompt-injection defences and agent tool restrictions (Phases 20 and 24).
