# Phase summaries, with real-life examples

One story runs through all of them: **"Sharma Caterers"**, a wedding kitchen.
- recipe card = Workflow
- order slip = Execution
- dishes = Tasks
- wall whiteboard = MongoDB
- token machine + register = Redis
- cooks = workers

Each phase says **what was built**, **the real-life version**, and **the one line to remember**. Detailed
explanations live in the other docs; this is the revision map.

---

## Phase 1: Project foundation
**Built:** validated config (fails at boot), structured logs with request ids, `/health` vs `/ready`, graceful shutdown, Docker infra (Mongo replica set, Redis).
**Real life:** before opening the restaurant, you check the gas, water and staff list *before* customers arrive, not when the first order comes in. `/health` asks "is the cook alive?". `/ready` asks "can the cook take orders right now (is the gas on)?".
**Remember:** fail fast at startup. Liveness never checks dependencies.

## Phase 2: Authentication + RBAC
**Built:** bcrypt, JWT access (15m) and refresh (7d), `tokenVersion` revocation, roles admin/operator/viewer, zod allowlists, user-enumeration and timing-attack defences.
**Real life:** the office gate checks your **ID card** (authentication). Your card decides **which floors open** (authorization). A lost card is blocked by bumping its version number at the security desk.
**Remember:** 401 = who are you? 403 = you can't. A JWT is signed, not encrypted.

## Phase 3: Domain models + state machines
**Built:** Workflow (versioned), Execution, Task, TaskExecution; transition tables; `transitionTask` compare-and-set; ownership in every query (404 for others' data).
**Real life:** a **traffic signal** only moves red → green → yellow, never randomly. "Tick the dish as done **only if it is still marked cooking**" is compare-and-set.
**Remember:** the table stops logic bugs, and the conditional update stops races.

## Phase 4: DAG validation
**Built:** Kahn's algorithm (order + parallel levels), 3-colour DFS names cycles; rejects unknown or duplicate dependencies and duplicate keys.
**Real life:** before cooking, the head chef checks the recipe card: "paneer needs dal, and dal needs paneer"? That's impossible (a cycle). "Needs ghee" when ghee isn't on the list is an unknown dependency.
**Remember:** Kahn is `remainingDeps` simulated. Fewer tasks emitted than total means a cycle.

## Phase 5: Execution engine
**Built:** transactional start, complete and fail; dependency counters; `pendingTasks` against write skew; fail-fast; reconciler.
**Real life:** there's no head chef. Every cook updates the whiteboard **in one go** when a dish is done, and the "dishes left" box on top ensures somebody rings the "order ready" bell.
**Remember:** write skew means disjoint writes plus stale snapshots. The fix is making both write the same document.

## Phase 6: Redis queue
**Built:** Lua claim (pop + lease atomically), reaper, delayed set, dedupe, takeover with fencing tokens, "ack last".
**Real life:** a **library register**. Taking a book writes "return by 5 pm" in the same moment. If the reader vanishes, the librarian puts it back on the shelf after 5 pm.
**Remember:** an id is always in ready, leases or delayed, never lost. Everyone uses the server's clock.

## Phase 7: Separate worker processes
**Built:** `npm run worker`, stateless workers with no leader, graceful SIGTERM drain.
**Real life:** the **waiter stops cooking**. Waiters take orders, cooks cook. On a festival day, just call more cooks; the recipe doesn't change.
**Remember:** horizontal scaling means stateless processes sharing Redis and MongoDB.

## Phase 8: Retries, backoff, DLQ
**Built:** transient vs permanent errors, exponential backoff with full jitter, DEAD_LETTER, a poison-pill guard. It also fixed a retry-lost-by-ack bug.
**Real life:** the gas cylinder is empty, so **wait and try again**, longer each time, and not every cook at the same second (jitter). "Customer is allergic" can never be fixed by retrying, so stop immediately. After 3 burnt tries the dish goes to the **manager's table** (dead letter).
**Remember:** retries without jitter cause retry storms. Don't retry permanent errors.

## Phase 9: Idempotency + distributed lock
**Built:** `Idempotency-Key` on runs (unique index on the execution itself, 422 for a mismatched body); a Redis lock with a random token, compare-and-delete release, TTL and a fencing counter (used by the scheduler).
**Real life:** **idempotency** is the order number on a receipt. If the customer says "same order again" twice with the same number, the kitchen makes it once. **Lock**: only one person holds the **storeroom key**, it auto-returns after 10 minutes if they faint (TTL), and you can only return *your* key, not the next person's (token check).
**Remember:** a lock alone doesn't guarantee correctness. Use fencing tokens or idempotency for stale holders.

## Phase 10: Heartbeats, worker registry, pause/resume/cancel
**Built:** the running-task lease is now a short `LEASE_TTL_MS`, **renewed every TTL/3 while the handler runs** (heartbeat). A lost renewal aborts the handler. There's a worker registry (Redis TTL key + Mongo doc) at `GET /workers` (ACTIVE / UNRESPONSIVE / STOPPED), and `POST /executions/:id/pause|resume|cancel`.
**Real life:** every cook shouts "**still cooking!**" every 5 minutes. If a cook goes silent for 15 minutes, someone else takes over the dish, even for a 2-hour biryani (the heartbeat lets long dishes keep their lease without a huge timeout). **Pause**: "don't start new dishes, finish what's on the stove". **Cancel**: the customer left, so every dish is crossed off; a cook notices at their next "still cooking!" shout and stops.
**Remember:** a heartbeat is a failure *detector*, not proof of death. Correctness still comes from leases and fencing.

## Phase 11: Kafka events through a transactional outbox
**Built:** every state change writes an event row in the **same MongoDB transaction** (outbox). A relay (one leader,
using the Redis lock) publishes the rows to a Kafka topic. An analytics consumer group counts events, and skips duplicates
using a processed-events table updated in the same transaction as the count.
**Real life:** the kitchen has a **"news register"** next to the whiteboard. Whenever a cook updates the board ("dal
ready"), they write the same line in the register **in the same stroke**, never one without the other. A **messenger boy**
(the relay; only one has the register key at a time) reads new lines and announces them on the **loudspeaker** (Kafka).
Accounts, the manager and the owner each listen separately (consumer groups). If the messenger faints after announcing but
before ticking the register, the next messenger announces it again. So the accountant keeps a **"heard already"** list of
line numbers (eventId) and never counts a line twice.
**Remember:** update the database, then publish, and you lose events on a crash. The outbox gives at-least-once delivery,
so consumers must dedupe. Never claim exactly-once.

## Phase 12: Scheduled workflows (cron)
**Built:** attach a cron schedule to a workflow ("every night at 2 am IST"). A scheduler inside the workers (one leader via
the Redis lock) starts due runs. Each time slot has its own idempotency key, so a slot can never run twice.
**Real life:** the kitchen has a **"daily orders" calendar**: "every morning at 7, make 50 breakfasts for the hostel". Only
the **shift manager on duty** (the lock holder) checks the calendar. If two managers accidentally both think they're on
duty, the order slip for "hostel, 25 Sept, 7 am" has a **unique number**, and the second slip with the same number is
refused (idempotency). If the kitchen was **closed for 5 hours**, nobody cooks 5 missed breakfasts: make today's one, then
continue normally (no backfill).
**Remember:** the lock is an optimization, and the idempotency key is the guarantee. Start the run first, then advance
the schedule, so a crash in between can only cause a deduplicated retry, never a missed run.

## Phases 13–14: LLM provider abstraction + structured output
**Built:** one **interface** for talking to any LLM (`chat`, `embed`). Behind it sit Ollama (a real local model) and a
Mock (for tests). There's a `generateStructured` helper: it asks the model for JSON matching a schema, validates it with zod,
and if it's wrong, shows the model its mistake and asks it to fix it (repair), up to 2 times.
**Real life:** the kitchen hires **cooks from any agency** (Ollama, OpenAI...) through a **standard job description**
("can make roti, can make dal"). The head chef never cares which agency a cook came from, and on test days a
**practice dummy cook** (Mock) follows a script. **Structured output**: the order form has fixed boxes (dish name, quantity
1–10, spice level low/medium/high). If a new cook writes "spice level: very tasty", the form is handed back: "the
spice-level box only accepts low/medium/high, fix it". After 3 wrong forms, the order is rejected rather than guessed.
**Remember:** JSON mode guarantees syntax, not meaning, so always validate. Depend on interfaces, not vendors. Delimiters
reduce prompt injection; they don't eliminate it.

## Phases 15–16: AI classification + model routing
**Built:** an LLM reads a request and fills a validated form: task type, complexity, needs our documents (RAG)?, needs
tools (agent)?. Simple rules then pick the pipeline and model: tools → agent; documents → RAG; hard → big model;
everything else → small model. If the LLM is down, a keyword rule-book classifies instead, and says so.
**Real life:** the restaurant's **receptionist** looks at each order and stamps it: "simple tea → junior cook", "5-course
wedding menu → head chef", "customer asks what's in our secret masala → check the **recipe book** first (RAG)", "customer
asks where their delivery is → someone must **phone the rider** (agent/tools)". The stamps follow a **fixed rulebook**
on the wall (routing rules), so the same order always goes to the same place and anyone can explain why. If the receptionist
is on leave, a simple checklist ("does the order mention 'recipe'?") does the job, badly but visibly.
**Remember:** rules are cheap, fast, testable and explainable, and an LLM router is none of these. Send the common path to
the small model and escalate only when needed. Few-shot examples help small models, but that isn't an accuracy measurement.
