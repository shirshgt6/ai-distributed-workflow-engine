# Testing strategy (Phase 25)

| Layer | Command | Needs | What it proves |
|---|---|---|---|
| Unit | `npm test` | nothing | pure logic: DAG, state machines, backoff, rate-limit rules, calculator, routing, validation/repair, circuit breaker |
| Integration | `npm run test:integration` | `npm run infra:up` | real MongoDB (transactions), Redis (Lua), Kafka, Qdrant: races, recovery, HTTP APIs, authz |
| Real LLM | `npm run test:llm` | local Ollama + models | the plumbing against a real model (structured output, embeddings, RAG, agent, fallback). Not model quality |
| Coverage | `npm run test:coverage` | infra | unit + integration coverage |
| Chaos | `npm run chaos` | infra | real processes: `kill -9` workers + Redis restart during runs, then invariant checks |

## Techniques used
- **Race tests:** N concurrent operations with `Promise.all` against the real database, asserting exactly one winner
  (task completion, D promoted once, workflow edits, registration, idempotency keys, approvals, lock acquisition,
  rate limits, claims).
- **Mutation checks:** a guard (a CAS condition, fencing, dedupe, jitter…) is deliberately removed, the tests must fail, and
  then the guard is restored. The per-phase results are in progress.md. One mutant survived (a redundant guard, documented).
- **Crash simulation:** tests play a worker that dies at a precise moment (after pop, mid-handler, after report).
- **Obedient-model tests:** a mock LLM that follows injected instructions, proving the controls don't depend on model behaviour.

## Measured results (this machine, 2026-09-26)
- **Tests:** 377 unit + integration tests passing.
- **Coverage** (unit + integration, excluding the process entrypoints `server.js`, `worker.js`, `consumers/`):
  statements 93.2%, branches 78.3%, functions 90.6%, lines 95.0%. Measured *before* the registry tests were added.
- **Chaos, run 1:** 20 runs × 7 tasks, 3 worker kills + 1 Redis restart. All invariants held
  (140 tasks, 140 successful attempts, 6 abandoned attempts recovered by takeover).
- **Chaos, run 2:** 40 runs × 7 tasks, a worker killed every 1.5 s (14 kills) + 1 Redis restart. All invariants held
  (280 tasks, exactly 280 successful attempts, 34 abandoned attempts recovered, 23.4 s end to end).

These are correctness results, not performance benchmarks. No throughput or latency claims are made.

## Known flakiness (honest)
Under coverage instrumentation, 1 of 3 full runs had a single failing test, which couldn't be identified because the output
wasn't captured. The next runs (2 with coverage, several without) all passed. Timing-sensitive tests (sub-second leases,
sleeps) are the likely cause. If it recurs: capture the name, then widen that test's timing margin.
