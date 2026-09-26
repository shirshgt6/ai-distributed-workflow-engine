# AI-Powered Distributed Workflow Orchestration Engine

A backend for defining and executing workflows as DAGs (directed acyclic
graphs) of tasks — with parallel execution of independent tasks, persistent
state, retries, crash recovery, lifecycle events, and AI-powered task types
(LLM routing, RAG, controlled agents, human approval).

> **Status: all 28 phases complete.** 381 automated tests, a chaos test (workers killed + Redis restarted mid-run,
> every task completed exactly once), and real-model checks against local Ollama. See [ARCHITECTURE.md](ARCHITECTURE.md),
> [docs/progress.md](docs/progress.md) and, for interviews, [docs/interview-guide.md](docs/interview-guide.md).

## What works today

- Validated configuration (fails fast at boot with a list of every bad variable)
- Structured JSON logging (pino) with request IDs and secret redaction
- `GET /health` (liveness) and `GET /ready` (readiness: checks MongoDB + Redis)
- Consistent JSON error format, body size limit, security headers
- Graceful shutdown on SIGTERM / SIGINT
- Local infrastructure via Docker Compose: MongoDB (single-node replica set) + Redis
- Auth: register / login / refresh / logout / me with bcrypt + JWT (access 15m, refresh 7d)
- RBAC (`admin` / `operator` / `viewer`) with a single permission table; `PATCH /users/:id/role`
- Workflow definitions API (create / list / get / update) with per-user ownership (404 for foreign)
  and optimistic concurrency on edits (409 on stale version)
- Explicit task/execution state machines with race-safe conditional transitions
- DAG validation on every save (cycles named as a path, unknown/duplicate dependencies, duplicate keys)
  and `POST /workflows/validate` returning topological order + parallel levels
- **Execution engine**: `POST /workflows/:id/run` runs the DAG with independent tasks in parallel, data flowing
  from parents to children, transactional state changes, fail-fast failure handling, timeouts, and recovery of
  stuck or orphaned tasks after a crash
- **Reliable Redis queue**: atomic Lua claim with a lease (no "popped then lost" jobs), a reaper,
  delayed tasks, and dedupe. Worker takeover after a crash uses fencing tokens, and a reconciler rebuilds
  Redis from MongoDB. See [docs/redis.md](docs/redis.md)
- **Separate worker processes** (`npm run worker`): run as many as needed, with graceful shutdown on SIGTERM
- **Retries**: transient vs non-retryable errors, exponential backoff with full jitter, dead-lettering when
  attempts run out, and a poison-pill guard
- **Idempotent runs**: an `Idempotency-Key` header makes retried `POST /workflows/:id/run` calls return the same run
- **Heartbeats + worker registry** (`GET /workers`), **pause/resume/cancel** (`POST /executions/:id/pause|resume|cancel`)
- **Kafka lifecycle events** via a transactional outbox, with an idempotent analytics consumer (`npm run consumer:analytics`),
  see [docs/kafka.md](docs/kafka.md)
- **AI tasks**: `ai.classify`, `ai.route`, `ai.generate`, `ai.rag`, `ai.agent` (bounded tool-using agent, see [docs/agents.md](docs/agents.md)) (local Ollama, or any OpenAI-compatible API)
- **RAG**: `POST /documents` (chunk + embed + Qdrant), owner-isolated retrieval, cited and validated answers
- **Human-in-the-loop**: `human.approval` tasks park a run until `POST /approvals/:id/approve|reject` or the timeout, see
  [docs/human-in-the-loop.md](docs/human-in-the-loop.md)
- **LLM resilience + observability**: fallback provider chain with circuit breakers; every LLM call recorded (tokens, latency,
  cost, fallback); `GET /analytics/ai`, `GET /analytics/workflows`, see [docs/observability.md](docs/observability.md)
- **Security**: Redis rate limiting (brute force, spraying, per-user quotas), threat model with tests, see
  [docs/security.md](docs/security.md)
- **Cron schedules** (`PUT /workflows/:id/schedule`): leader-elected scheduler, one run per slot guaranteed by idempotency keys
- See [docs/api-design.md](docs/api-design.md), [docs/security.md](docs/security.md),
  [docs/database-design.md](docs/database-design.md), [docs/workflow-engine.md](docs/workflow-engine.md)

## Tech stack

Node.js (JavaScript, ES modules) · Express 5 · MongoDB 7 (replica set) + Mongoose · Redis 7 + ioredis (Lua scripts) ·
Kafka (KRaft) + kafkajs · Qdrant · Ollama (qwen2.5:0.5b, nomic-embed-text) via an OpenAI-compatible API · LangChain.js
text splitter · zod · pino · bcryptjs · jsonwebtoken · cron-parser · Jest + Supertest · ESLint · Docker / Compose ·
OpenAPI 3.1 + Swagger UI

## Getting started

Prerequisites: Node.js ≥ 20.11, Docker Desktop running.

```bash
npm install
cp .env.example .env        # then replace the JWT secret placeholders (below)
npm run infra:up            # start MongoDB + Redis, wait until healthy
npm run dev                 # terminal 1: API on http://localhost:4000
npm run worker              # terminal 2 (and 3, 4... for more workers): executes tasks
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
open http://localhost:4000/docs   # interactive API docs (Swagger UI)
```

Run a workflow (with a token from `POST /auth/login` as an operator or admin):

```bash
curl -X POST localhost:4000/workflows -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"name":"Diamond","tasks":[{"key":"A","type":"noop"},{"key":"B","type":"delay","dependsOn":["A"],"config":{"ms":500}},{"key":"C","type":"delay","dependsOn":["A"],"config":{"ms":500}},{"key":"D","type":"echo","dependsOn":["B","C"]}]}'
curl -X POST localhost:4000/workflows/<id>/run -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{}'
curl localhost:4000/executions/<executionId> -H "Authorization: Bearer $TOKEN"
```

### Run everything in containers (Phase 26)

```bash
cp .env.example .env         # set real JWT secrets
npm run app:up               # builds the image; starts Mongo, Redis, Kafka, Qdrant, API, 2 workers, analytics consumer
docker compose -f docker/docker-compose.yml --env-file .env --profile app exec \
  -e ADMIN_EMAIL=you@example.com -e ADMIN_PASSWORD='a-long-password' api node scripts/create-admin.js
docker compose -f docker/docker-compose.yml --env-file .env --profile app up -d --scale worker=5   # scale out
npm run app:down             # stop the app containers (infrastructure keeps running)
```
One image runs as API, worker or consumer, depending on the command. It runs as the non-root `node` user, with no secrets
baked in (they come from `.env` at runtime). Ollama stays on the host and is reached at `host.docker.internal`.

Host ports are **27018** (Mongo) and **6380** (Redis) so this can run next to
other local projects using the default ports.

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Start API with auto-reload |
| `npm start` | Start API |
| `npm run worker` / `dev:worker` | Start a worker process (run several to scale out) |
| `npm run consumer:analytics` | Kafka consumer that aggregates lifecycle events |
| `npm test` | Unit tests (no Docker needed) |
| `npm run test:integration` | Integration tests against real Mongo/Redis (`infra:up` first) |
| `npm run test:all` | Unit + integration |
| `npm run test:llm` | Real-model tests against local Ollama (opt-in) |
| `npm run test:coverage` | Unit + integration with coverage |
| `npm run chaos` | Kill workers + restart Redis during 20 runs, then verify invariants (see [docs/testing.md](docs/testing.md)) |
| `npm run lint` | ESLint |
| `npm run check:secrets` | Scan tracked files for secrets (patterns + local `.env` values) |
| `npm run audit` | `npm audit` for production dependencies |
| `npm run create-admin` | Create or promote an admin (reads `ADMIN_EMAIL` / `ADMIN_PASSWORD`) |
| `npm run infra:up` / `infra:down` | Start / stop local infrastructure |
| `npm run app:up` / `app:down` | Build + run the whole app in containers / stop the app containers |

## Project layout

```
src/
  server.js          composition root: config -> connections -> app -> listen, graceful shutdown
  app.js             createApp(deps): Express app with injected dependencies (testable)
  config/            env validation, logger, mongo, redis
  auth/              passwords, tokens, permissions (RBAC table), ownership, request schemas
  models/            Mongoose models (User, Workflow, WorkflowExecution, Task, TaskExecution)
  repositories/      race-safe data operations (transitionTask)
  workflow/          engine, state machines, DAG validation, request schemas
  worker.js          worker process entrypoint (queue worker + reconciler + graceful shutdown)
  queues/            Redis task queue (Lua scripts)
  workers/           queue worker loop, runTask (handler + timeout + report), retry policy
  handlers/          built-in task handlers (noop, delay, fail, flaky, echo)
  middleware/        requestId, errorHandler, authenticate, authorize, validate
  controllers/       HTTP <-> service translation
  routes/            health, auth, workflows, executions
  services/          health checks, auth, workflows, executions
  utils/             errors, withTimeout
scripts/             create-admin
tests/unit/          fast tests, fake dependencies
tests/integration/   real Mongo/Redis
tests/helpers/       shared integration-test setup
docker/              docker-compose.yml
docs/                progress, decisions (ADRs), api-design, security, database-design, workflow-engine, redis,
                     interview-guide
```

## Benchmarks

Not benchmarked yet. No performance numbers are claimed anywhere in this
project until they are measured by a script in the repository.
