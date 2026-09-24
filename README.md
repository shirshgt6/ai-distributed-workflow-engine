# AI-Powered Distributed Workflow Orchestration Engine

A backend for defining and executing workflows as DAGs (directed acyclic
graphs) of tasks — with parallel execution of independent tasks, persistent
state, retries, crash recovery, lifecycle events, and AI-powered task types
(LLM routing, RAG, controlled agents, human approval).

> **Status: Phase 2 of 28 complete — foundation + authentication/RBAC.**
> No workflow features exist yet. See [docs/progress.md](docs/progress.md)
> for exactly what is implemented, and [ARCHITECTURE.md](ARCHITECTURE.md)
> for the target design.

## What works today

- Validated configuration (fails fast at boot with a list of every bad variable)
- Structured JSON logging (pino) with request IDs and secret redaction
- `GET /health` (liveness) and `GET /ready` (readiness: checks MongoDB + Redis)
- Consistent JSON error format, body size limit, security headers
- Graceful shutdown on SIGTERM / SIGINT
- Local infrastructure via Docker Compose: MongoDB (single-node replica set) + Redis
- Auth: register / login / refresh / logout / me with bcrypt + JWT (access 15m, refresh 7d)
- RBAC (`admin` / `operator` / `viewer`) with a single permission table; `PATCH /users/:id/role`
- See [docs/api-design.md](docs/api-design.md) and [docs/security.md](docs/security.md)

## Tech stack (so far)

Node.js (JavaScript, ES modules) · Express 5 · MongoDB 7 + Mongoose · Redis 7 +
ioredis · zod · pino · bcryptjs · jsonwebtoken · Jest + Supertest · ESLint · Docker Compose

## Getting started

Prerequisites: Node.js ≥ 20.11, Docker Desktop running.

```bash
npm install
cp .env.example .env        # then replace the JWT secret placeholders (below)
npm run infra:up            # start MongoDB + Redis, wait until healthy
npm run dev                 # API on http://localhost:4000
```

Replace the placeholder `JWT_*_SECRET` values in `.env` with random ones:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

Create the first admin (the API never lets a client pick its own role):

```bash
ADMIN_EMAIL=you@example.com ADMIN_PASSWORD='a-long-password' npm run create-admin
```

```bash
curl localhost:4000/health  # {"status":"ok",...}
curl localhost:4000/ready   # {"status":"ready","checks":{"mongo":...,"redis":...}}
```

Host ports are **27018** (Mongo) and **6380** (Redis) so this can run next to
other local projects using the default ports.

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Start API with auto-reload |
| `npm start` | Start API |
| `npm test` | Unit tests (no Docker needed) |
| `npm run test:integration` | Integration tests against real Mongo/Redis (`infra:up` first) |
| `npm run test:all` | Both |
| `npm run lint` | ESLint |
| `npm run create-admin` | Create or promote an admin (reads `ADMIN_EMAIL` / `ADMIN_PASSWORD`) |
| `npm run infra:up` / `infra:down` | Start / stop local infrastructure |

## Project layout

```
src/
  server.js          composition root: config -> connections -> app -> listen, graceful shutdown
  app.js             createApp(deps): Express app with injected dependencies (testable)
  config/            env validation, logger, mongo, redis
  auth/              passwords, tokens, permissions (RBAC table), request schemas
  models/            Mongoose models (User)
  middleware/        requestId, errorHandler, authenticate, authorize, validate
  controllers/       HTTP <-> service translation
  routes/            health, auth
  services/          health checks, auth
  utils/             errors, withTimeout
scripts/             create-admin
tests/unit/          fast tests, fake dependencies
tests/integration/   real Mongo/Redis
docker/              docker-compose.yml
docs/                progress, decisions (ADRs), api-design, security
```

## Benchmarks

Not benchmarked yet. No performance numbers are claimed anywhere in this
project until they are measured by a script in the repository.
