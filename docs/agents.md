# Controlled AI agent (Phase 20)

## LLM call vs agent
An **LLM call** answers once. An **agent** loops: *think → propose a tool call → our code runs it → the result goes back → think again*, until it gives a final answer. The model never executes anything itself; it only **proposes**, and code decides.

## The loop (`src/ai/agent/agent.js`)
```
repeat up to maxIterations (default 5, max 8):
  model → structured step (validated):
          {"action":"tool","tool":<enum of ALLOWED tools>,"args":{...}}  |  {"action":"final","answer":"..."}
  final?                         → done
  same tool+args as last step?   → STOP (loop_detected)
  args fail the tool's zod schema → error observation (tool NOT run)
  run tool with per-tool timeout  → result (or error) truncated to 2000 chars
  append as <tool_result> … </tool_result>  (untrusted data)
max iterations reached → STOP (max_iterations)
overall timeout / task timeout / cancel → abort
```

## Tools (`src/ai/agent/tools.js`): the complete list
| Tool | Does | Permission | Scope |
|---|---|---|---|
| `search_knowledge_base` | RAG retrieval (snippets) | `workflow:read` | run owner's documents only |
| `get_workflow_status` | status of an execution + its tasks | `workflow:read` | run owner's executions only (others → "not found") |
| `calculator` | arithmetic via a **safe recursive-descent parser** | none | pure |

Every tool is **read-only**. There is **no** shell, HTTP fetch, file system or code execution, and the calculator never uses `eval`.

## Controls, and the attack each one stops
| Control | Where | Stops |
|---|---|---|
| Tool allowlist as a schema **enum** | agent step schema | model inventing or calling tools it wasn't given ("shell") |
| Allowlist ∩ registry ∩ **owner's role** | `selectTools` | privilege escalation through the agent; unknown tool names in config fail loudly |
| **ownerId from the task**, never from model args | tool `run(args, ctx)` | "look up user X's data" style prompt injection |
| zod **argument validation** | before `run` | malformed or hostile arguments |
| Per-tool **timeout**, output truncation | loop | hanging tools, prompt flooding |
| **maxIterations**, loop guard, overall timeout, AbortSignal | loop | runaway cost, infinite loops |
| Tool results wrapped as `<tool_result>` | transcript | instructions hidden in data (reduced, not eliminated) |
| Agent without a final answer → task **FAILED (non-retryable)** | `ai.agent` handler | silent partial results; retry storms of the same goal |

## Verified
- **Unit and integration tests:** the calculator's grammar and rejections (`process.exit()`, `require`, huge exponents), role and
  allowlist selection, the happy path, a disallowed tool rejected by the schema, invalid args, tool errors, max iterations,
  loop detection, per-tool timeout, external abort, and ownerId coming from the task. In a real workflow: status lookup of own
  execution, Bob's agent getting "not found" for Alice's execution, the task allowlist enforced, a never-finishing agent failing
  the task, and an unknown tool failing clearly.
- **Real model (qwen2.5:0.5b, `npm run test:llm`):** the agent chose the right tool and arguments
  (`calculator("(18 - 5) * 2") → 26`) but then repeated the same call instead of answering, so the **loop guard stopped it**
  (3/3 runs). A prompt nudge to finish didn't change that and was reverted. **Honest conclusion:** the control loop works; a 0.5B
  model is too weak to be a useful agent. A larger model is required. No agent success rate is claimed.
