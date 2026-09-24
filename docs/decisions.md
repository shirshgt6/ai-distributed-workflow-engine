# Architecture Decision Records

Short ADRs: context → decision → consequences. New decisions are appended.

---

## ADR-001: JavaScript (ES modules) instead of TypeScript

- **Context:** Resume/learning project; the author will be asked to explain and
  reproduce code in interviews. Project 1 was written in JavaScript.
- **Decision:** Plain JavaScript with native ES modules. Types are documented
  with JSDoc where they help; runtime boundaries are validated with zod.
- **Consequences:** No build step, faster iteration, code reads the same as in
  an interview. We lose compile-time checking, so runtime validation (zod) at
  every boundary (env, HTTP input, LLM output, events) matters more.

## ADR-002: MongoDB runs as a single-node replica set

- **Context:** The transactional outbox (Phase 11) needs multi-document
  transactions; MongoDB only supports those on replica sets.
- **Decision:** Local Mongo starts with `--replSet rs0` and is initiated by its
  healthcheck. Clients use `directConnection=true`.
- **Consequences:** Transactions and change streams are available locally.
  A single node gives no real redundancy — production would use 3 members.

## ADR-003: Redis configured with AOF persistence and `noeviction`

- **Context:** Redis will hold queues, leases and locks. The default policy on
  some deployments evicts keys when memory is full, which would silently drop tasks.
- **Decision:** `appendonly yes`, `maxmemory-policy noeviction`.
- **Consequences:** When full, Redis rejects writes (loud failure) rather than
  losing data (silent failure). MongoDB remains the source of truth, so Redis
  state is still treated as rebuildable.

## ADR-004: Liveness and readiness are separate endpoints

- **Decision:** `/health` checks nothing external; `/ready` checks Mongo and
  Redis with per-check timeouts and fails during shutdown.
- **Consequences:** A dependency outage removes instances from the load
  balancer instead of triggering restart loops that cannot fix the dependency.

## ADR-005: Fail fast on startup; supervisor restarts

- **Decision:** If config is invalid or Mongo/Redis are unreachable at boot, exit 1.
- **Consequences:** Simpler code (no "half-started" state). Relies on Docker
  restart policies / Kubernetes to retry with backoff.

## ADR-006: Ollama as the local LLM provider (planned, Phase 13)

- **Decision:** Use Ollama locally through its OpenAI-compatible API, plus a
  deterministic mock provider for tests. No paid API key required.
- **Consequences:** Free and offline; smaller local models are weaker at
  structured output, which makes validation/repair logic genuinely necessary.
  Azure OpenAI is not supported and must not be claimed.

## ADR-007: Stateless JWT access tokens + DB-checked refresh tokens

- **Context:** Every API request must be authenticated; a DB lookup per request adds latency
  and load, but purely stateless tokens cannot be revoked.
- **Decision:** Short-lived access tokens (15m) verified by signature only; long-lived refresh
  tokens (7d) checked against `user.tokenVersion` in MongoDB on every refresh.
- **Consequences:** No DB hit on normal requests. Revocation (logout, role change) takes effect
  for refresh immediately, but an already-issued access token remains valid up to 15 minutes.
  `tokenVersion` is per user, so logout signs out all devices. Rotation with reuse detection
  is a documented future improvement.

## ADR-008: bcryptjs instead of native bcrypt

- **Context:** The native `bcrypt` package needs an install script (native build); this
  environment blocks npm install scripts by default.
- **Decision:** `bcryptjs` (pure JS, same algorithm and hash format).
- **Consequences:** No native toolchain needed, identical `$2b$` hashes (switchable later).
  Somewhat slower per hash than native and runs on the main thread — a hash blocks the event
  loop for its duration. At high login volume, move hashing to worker threads or native bcrypt.

## ADR-009: RBAC as a permission table; ownership checks are separate

- **Decision:** Code checks permissions (`requirePermission("workflow:run")`), never role names.
  One table maps roles to permissions. Object-level authorization (is this resource yours?)
  is enforced in the service layer when resources are loaded.
- **Consequences:** Changing a role's powers is a one-file change with a test matrix guarding it.
  RBAC alone does not prevent BOLA/IDOR — ownership filters are required on every resource query.
