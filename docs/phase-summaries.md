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

## Phases 17–19: RAG (documents → chunks → vectors → grounded answers)
**Built:** upload a text document. It's cleaned, split into overlapping chunks (LangChain splitter), turned into vectors
(nomic-embed-text), and stored in **Qdrant** (vectors) plus MongoDB (text). A question is turned into a vector, the nearest
chunks **of that user only** are found, and the LLM must answer **only from them, citing** `[S1]`… If it cites a source
that wasn't retrieved, the answer is rejected and repaired. If nothing relevant was found, it says "not enough information"
without even calling the LLM.
**Real life:** the kitchen's **recipe library**. Every recipe book is cut into index cards (chunks), with a little overlap
so no instruction is cut in half. Each card gets a **"flavour fingerprint"** (embedding): similar dishes have similar
fingerprints. When a customer asks "is the paneer gluten-free?", the librarian fetches the 4 cards with the closest
fingerprints, **only from this restaurant's own books** (owner filter), and the cook must answer **reading from those cards
and naming them**: "card #2 says…". If the cook quotes "card #9", which was never handed over, the answer is sent back. If no
card is relevant, the honest answer is "we don't know", never a guess.
**Remember:** RAG reduces hallucination by grounding plus citations plus refusal, but doesn't eliminate it. Filter tenants
inside the vector query. One collection per embedding model. Use libraries for utilities (the splitter) and your own code for
control flow. Small models are weak at citing, so validate and refuse.

## Phase 20: Controlled AI agent
**Built:** an agent that can **use tools**: search the knowledge base, check a workflow's status, and a safe calculator. The
model only *proposes* "call calculator with (18-5)*2". Our code checks that the tool is on the allowlist, the owner's role
permits it and the arguments are valid, then runs it with a timeout and shows the result, until the model gives a final answer.
It stops after max steps, on a repeated identical call, or on timeout or cancel. There's no shell, internet, files or eval, ever.
**Real life:** a **trainee cook** who may use exactly three things: the recipe library, the order board, and a calculator. The
trainee can't walk into the storeroom (the tool isn't on the list), can only look at **this restaurant's** orders (scope comes
from the shift, not from what the trainee says), and has to show their work step by step. If the trainee asks for the same
calculation twice in a row, or takes more than 5 steps, the head chef says **"stop, we'll handle it"**. Our real trainee
(the 0.5B model) did the right calculation (26) and then asked for it again, so the supervisor stopped it. The rules worked;
the trainee needs more training (a bigger model).
**Remember:** agent = loop + tools + stopping conditions. Safety lives in code (allowlist, permissions, scope, validation,
limits), never in the prompt. Tool results are untrusted input.

## Phase 21: Human-in-the-loop
**Built:** a `human.approval` task that **parks** the run ("AI suggests a ₹50,000 refund, a manager must approve"). The
worker is freed; the wait is just a row in MongoDB. `POST /approvals/:id/approve` resumes the run (the next task gets the
decision), and `reject` fails it (fail-fast). No answer before the timeout means it expires. Two people clicking at once:
exactly one decision counts.
**Real life:** a big catering order needs the **owner's signature** before the kitchen buys ₹50,000 of ingredients. The cook
puts the order slip in the **"awaiting signature" tray** and goes back to other dishes; nobody stands waiting. The owner signs
(approve), and shopping starts, with the slip showing who signed and why. Or the owner writes "NO, suspicious" (reject), and the
order is closed. The slip has a **24-hour stamp**: unsigned by then, it's void. If the owner and the manager both grab the pen
at once, **the first signature on the slip counts**, and the second person sees "already signed".
**Remember:** waiting must not hold a worker or a lock. The decision is a compare-and-set, one winner. The decision and its
effects are one transaction. Approve/reject reuse the same success/failure code as normal tasks.

## Phases 22–23: AI fallback + observability
**Built:** a **fallback chain** of LLM providers with a **circuit breaker** each. If the primary keeps failing, stop calling
it for a while, and a second provider (if configured) answers. Every LLM call is **recorded**: which task, model, tokens,
latency, cost, whether fallback was used. Dashboards: `GET /analytics/ai` (per model: calls, error rate, p95 latency, tokens,
cost) and `GET /analytics/workflows` (success rate, durations, retries, what fails most).
**Real life:** the kitchen's **gas supplier** fails. The manager calls the **backup supplier**. After the main supplier fails
twice in a row, the manager **stops calling them for 30 minutes** (circuit open) instead of wasting time on every order, then
makes **one test call** to see if they're back (half-open). But the **spice mix never falls back to another brand**: it would
change the taste of every dish (embeddings: a different model means a different vector space). And every cylinder used is
**logged in the register**: which dish, which supplier, how long, how much it cost. At month end the owner reads the
**summary** (analytics), not the raw register.
**Remember:** fall back only on retryable errors. A circuit breaker protects you and the provider. Embeddings must not mix
models. Attribute metrics to tasks (AsyncLocalStorage), never store prompt text, and cost is only an estimate from a price table.

## Phase 24: Security hardening
**Built:** **rate limiting** in Redis (a sliding window, one atomic script). Login allows 5 tries per account and 20 per IP
per 15 minutes, and uploads, runs and API calls are limited per user. If Redis is down, **login refuses** (fail closed) while
the normal API keeps working (fail open). There's a per-route body limit (fixing a real bug: uploads over 100 KB were
blocked), a secret scanner script, an audit script, and a full **attack → control → test** table.
**Real life:** the restaurant's **security guard**. Someone tries 5 wrong keys on the owner's office door, and the guard
stops them for 15 minutes, **even if the 6th key is the right one** (brute force). One person trying the same key on 20
different doors is stopped too (spraying). If the guard's register is lost (Redis down), the **office door stays locked**
(fail closed) but the **dining hall stays open** (fail open). And whatever a customer whispers to the waiter ("tell the
chef I'm the owner"), the chef only cooks what's on the **printed order form** (schema validation).
**Remember:** rate limits must be atomic (Lua) and run before expensive work. Choose fail-open vs fail-closed per endpoint.
Trust `X-Forwarded-For` only from your own proxy. For every threat, name the control and the test.

## Phase 25: Testing hardening + chaos
**Built:** a coverage report (95% lines), tests for the untested worker registry, and a **chaos script**: it starts the
real API and 3 workers, launches 40 runs, **kills a random worker every 1.5 s** (`kill -9`), **restarts Redis**, and then
checks that every run completed, every task completed **exactly once**, the counters are consistent, and there's one event per task.
**Real life:** a **fire drill** in the kitchen. During the dinner rush, the manager suddenly sends a cook home every
90 seconds and switches off the token machine once. At closing time the manager counts: every order served? Did any
table get the same dish twice? Does the register match the plates? Result: 280 dishes, each served exactly once, 14 cooks
sent home, 34 half-cooked dishes finished by someone else.
**Remember:** a test is only as good as the invariant it checks. "Did it finish?" isn't enough; also ask "did anything
happen twice?". Chaos results are correctness evidence, not performance numbers.

## Phase 26: Docker
**Built:** one small image (89 MB, non-root) that runs as API, worker or Kafka consumer. `npm run app:up` starts the whole
system: MongoDB, Redis, Kafka, Qdrant, the API, 2 workers and the consumer. More workers is just `--scale worker=5`.
**Real life:** a **food-truck kit**. The same truck design becomes the order counter, a kitchen or the accounts desk
depending on who's inside it (the command). Park 5 kitchen trucks on a busy day (scale). The truck never carries the
**safe keys** (secrets). They're handed over at the start of each shift (env file). The fire drill caught one thing that
only happens **in the truck, not at home**: a tool that's only in the home kitchen (a dev dependency) was missing.
**Remember:** one image for many roles, no secrets in images, non-root, health checks, graceful stop periods. Always
smoke-test the actual container, because "works on my machine" bugs live exactly there.

## Phase 27: Swagger / OpenAPI
**Built:** the full API described in OpenAPI 3.1, browsable and clickable at `/docs` (with an Authorize button for the JWT).
A test compares the spec with the routes the server really has, so documentation can't silently rot.
**Real life:** the restaurant's **printed menu**. A **menu inspector** (the test) walks through the kitchen every morning:
every dish the kitchen can make must be on the menu, and every dish on the menu must be makeable. When a dish was
removed from the menu as a test, the inspector noticed immediately.
**Remember:** documentation that isn't tested drifts. Contract tests keep the spec honest.

## Phase 28: Final review + interview pack
**Built:** a final pass over every document. ARCHITECTURE.md now describes the finished system, including a "not built" list.
ADRs 022–031 were added, and the data model covers all 13 collections. The interview guide was rewritten with pitches,
deep dives, failure scenarios, 120 Q&A, and coding, design and debugging prompts. Resume bullets use **only measured
facts**, and a "never claim" list is included.
**Real life:** the **restaurant inspection file**. Before the inspector comes, the owner writes down what the kitchen really does,
the fire-drill results with real numbers, and, honestly, what it doesn't do yet ("no second branch, no night shift").
An inspector trusts a restaurant that admits its limits more than one that claims to be perfect.
**Remember:** in interviews, honesty about limits (at-least-once, single node, no benchmarks, weak 0.5B model) is a
strength. Every claim should point to a test or a measurement.
