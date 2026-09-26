// CHAOS TEST: real processes, real infrastructure, deliberate failures.
//
//   npm run infra:up && npm run chaos            (Ollama not needed)
//
// Starts the API + 3 worker processes (on port 4100, isolated database), launches
// RUNS workflow runs, and while they execute:
//   - kill -9 a random worker every KILL_EVERY_MS, and start a replacement
//   - restart Redis once (docker restart wf_redis)
// Then it checks INVARIANTS directly in MongoDB:
//   1. every run finished COMPLETED (nothing lost, nothing stuck)
//   2. every task COMPLETED, with exactly ONE successful attempt (no double completion)
//   3. pendingTasks == 0 for every run (counters consistent)
//   4. exactly one task.completed outbox event per task (no duplicate state changes)
// Exit code 0 only if every invariant holds. Numbers printed are what THIS run measured.
import { spawn, execSync } from "node:child_process";
import mongoose from "mongoose";

const RUNS = Number(process.env.CHAOS_RUNS ?? 20);
const KILL_EVERY_MS = Number(process.env.CHAOS_KILL_EVERY_MS ?? 2500);
const DB = `workflow_engine_chaos_${Date.now()}`;
const PORT = 4100;
const BASE = `http://localhost:${PORT}`;
const env = {
  ...process.env,
  NODE_ENV: "production",
  LOG_LEVEL: "error",
  PORT: String(PORT),
  MONGO_URI: `mongodb://localhost:27018/${DB}?directConnection=true`,
  REDIS_URL: "redis://localhost:6380",
  JWT_ACCESS_SECRET: "chaos-access-secret-0123456789abcdefghij",
  JWT_REFRESH_SECRET: "chaos-refresh-secret-0123456789abcdefghij",
  LLM_PROVIDER: "mock",
  LEASE_TTL_MS: "1500", // a killed worker's tasks are taken over after ≤ 1.5 s
  RECONCILE_INTERVAL_MS: "1000",
  RECONCILE_STALE_MS: "2000",
  WORKER_CONCURRENCY: "3",
  RATE_LIMIT_ENABLED: "false",
  BCRYPT_COST: "4",
};

const procs = new Set();
function start(script, name) {
  const p = spawn("node", [script], { env, stdio: ["ignore", "ignore", "pipe"] });
  p.name = name;
  p.stderr.on("data", () => {}); // keep the pipe drained
  procs.add(p);
  p.on("exit", () => procs.delete(p));
  return p;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function http(method, path, token, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...(token && { Authorization: `Bearer ${token}` }) },
    body: body && JSON.stringify(body),
  });
  const json = res.status === 204 ? null : await res.json();
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${JSON.stringify(json)}`);
  return json;
}

async function main() {
  const t0 = Date.now();
  execSync("node scripts/create-admin.js", { env: { ...env, ADMIN_EMAIL: "chaos@chaos.test", ADMIN_PASSWORD: "chaos-password-123" }, stdio: "ignore" });
  start("src/server.js", "api");
  let workers = [1, 2, 3].map((i) => start("src/worker.js", `worker-${i}`));
  for (let i = 0; i < 40; i++) {
    try {
      await http("GET", "/health");
      break;
    } catch {
      await sleep(250);
    }
  }
  const { accessToken: token } = await http("POST", "/auth/login", null, { email: "chaos@chaos.test", password: "chaos-password-123" });

  // start -> 5 parallel tasks (one flaky: fails once, retried) -> end
  const tasks = [
    { key: "start", type: "noop" },
    ...[1, 2, 3, 4].map((i) => ({ key: `p${i}`, type: "delay", dependsOn: ["start"], config: { ms: 300 + i * 150 } })),
    { key: "flaky", type: "flaky", dependsOn: ["start"], config: { failTimes: 1 }, retryPolicy: { maxAttempts: 5, baseDelayMs: 200 } },
    { key: "end", type: "echo", dependsOn: ["p1", "p2", "p3", "p4", "flaky"] },
  ];
  // Several attempts may be consumed by kills, so allow plenty of takeovers.
  for (const t of tasks) t.retryPolicy = { maxAttempts: 8, baseDelayMs: 200, ...(t.retryPolicy ?? {}), ...(t.key === "flaky" ? { maxAttempts: 8 } : {}) };
  const wf = (await http("POST", "/workflows", token, { name: "chaos", tasks })).workflow;

  const ids = [];
  for (let i = 0; i < RUNS; i++) ids.push((await http("POST", `/workflows/${wf.id}/run`, token, {})).execution.id);
  console.log(`[chaos] ${RUNS} runs x ${tasks.length} tasks started; killing a worker every ${KILL_EVERY_MS} ms, Redis restart at ~4 s`);

  let kills = 0;
  let redisRestarted = false;
  const killer = setInterval(() => {
    const victim = workers[Math.floor(Math.random() * workers.length)];
    victim.kill("SIGKILL");
    kills += 1;
    workers = workers.filter((w) => w !== victim);
    setTimeout(() => workers.push(start("src/worker.js", `worker-r${kills}`)), 800);
  }, KILL_EVERY_MS);
  setTimeout(() => {
    execSync("docker restart wf_redis", { stdio: "ignore" });
    redisRestarted = true;
  }, 4000);

  // Wait for every run to finish (or give up after 120 s).
  await mongoose.connect(env.MONGO_URI);
  const { WorkflowExecution } = await import("../src/models/workflowExecution.model.js");
  const { Task } = await import("../src/models/task.model.js");
  const { TaskExecution } = await import("../src/models/taskExecution.model.js");
  const { OutboxEvent } = await import("../src/models/outboxEvent.model.js");
  const deadline = Date.now() + 120_000;
  let done = 0;
  while (Date.now() < deadline) {
    done = await WorkflowExecution.countDocuments({ status: { $in: ["COMPLETED", "FAILED", "CANCELLED"] } });
    if (done === RUNS) break;
    await sleep(500);
  }
  clearInterval(killer);
  const elapsedS = ((Date.now() - t0) / 1000).toFixed(1);

  // ---- invariants ----
  const executions = await WorkflowExecution.find({}).lean();
  const allTasks = await Task.find({}).lean();
  const succeeded = await TaskExecution.aggregate([{ $match: { status: "SUCCEEDED" } }, { $group: { _id: "$taskId", n: { $sum: 1 } } }]);
  const attempts = await TaskExecution.aggregate([{ $group: { _id: "$status", n: { $sum: 1 } } }]);
  const completedEvents = await OutboxEvent.aggregate([{ $match: { type: "task.completed" } }, { $group: { _id: "$payload.taskId", n: { $sum: 1 } } }]);

  const checks = {
    [`all ${RUNS} runs COMPLETED`]: executions.length === RUNS && executions.every((e) => e.status === "COMPLETED"),
    "every task COMPLETED": allTasks.every((t) => t.status === "COMPLETED"),
    "exactly one SUCCEEDED attempt per task": succeeded.length === allTasks.length && succeeded.every((s) => s.n === 1),
    "pendingTasks == 0 for every run": executions.every((e) => e.pendingTasks === 0),
    "exactly one task.completed event per task": completedEvents.length === allTasks.length && completedEvents.every((e) => e.n === 1),
  };
  const byStatus = Object.fromEntries(attempts.map((a) => [a._id, a.n]));
  console.log(JSON.stringify({ runs: RUNS, tasks: allTasks.length, finished: done, workerKills: kills, redisRestarted, elapsedSeconds: Number(elapsedS), attemptsByStatus: byStatus, checks }, null, 2));

  for (const p of procs) p.kill("SIGKILL");
  await mongoose.connection.db.dropDatabase();
  await mongoose.disconnect();
  const ok = Object.values(checks).every(Boolean);
  console.log(ok ? "[chaos] PASS: every invariant held" : "[chaos] FAIL: an invariant was violated");
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error("[chaos] error:", err);
  for (const p of procs) p.kill("SIGKILL");
  process.exit(1);
});
