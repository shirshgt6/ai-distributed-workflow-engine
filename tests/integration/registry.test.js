// Worker registry + heartbeat + GET /workers; provider/RAG factories from config.
import { randomUUID } from "node:crypto";
import { connectMongo, disconnectMongo } from "../../src/config/mongo.js";
import { createRedisClient } from "../../src/config/redis.js";
import { createWorkerRegistry, listWorkers } from "../../src/workers/registry.js";
import { Worker } from "../../src/models/worker.model.js";
import { User } from "../../src/models/user.model.js";
import { AIExecution } from "../../src/models/aiExecution.model.js";
import { createProviderFromConfig } from "../../src/ai/providers/index.js";
import { createRagFromConfig } from "../../src/ai/rag/index.js";
import { loadConfig } from "../../src/config/env.js";
import { MONGO_URI, REDIS_URL, logger, createTestStack, createUser, as } from "../helpers/testApp.js";

let redis;
beforeAll(async () => {
  await connectMongo(MONGO_URI, logger);
  await Promise.all([Worker.deleteMany({}), User.deleteMany({})]);
  redis = createRedisClient(REDIS_URL, logger, { name: "test-registry" });
  await redis.connect();
});
afterAll(async () => {
  await Promise.all([Worker.deleteMany({}), User.deleteMany({}), AIExecution.deleteMany({})]);
  await redis.quit();
  await disconnectMongo();
});

const registryFor = (workerId, ttlMs = 200) =>
  createWorkerRegistry({ Worker, redis, workerId, host: "h", pid: 1, concurrency: 2, ttlMs, logger });

test("register -> ACTIVE; heartbeat updates counters; deregister -> STOPPED", async () => {
  const id = `w-${randomUUID()}`;
  const reg = registryFor(id, 5000);
  await reg.register();
  await reg.beat({ runningTasks: 2, completedSinceLastBeat: 3 });
  let w = (await listWorkers({ Worker, redis })).find((x) => x.workerId === id);
  expect(w).toMatchObject({ status: "ACTIVE", runningTasks: 2, tasksCompleted: 3 });
  await reg.deregister();
  w = (await listWorkers({ Worker, redis })).find((x) => x.workerId === id);
  expect(w.status).toBe("STOPPED");
});

test("a worker that stops heartbeating (crashed) shows as UNRESPONSIVE once its TTL key expires", async () => {
  const id = `w-${randomUUID()}`;
  await registryFor(id, 150).register(); // ...then no more beats (process "died")
  expect((await listWorkers({ Worker, redis })).find((x) => x.workerId === id).status).toBe("ACTIVE");
  await new Promise((r) => setTimeout(r, 250));
  expect((await listWorkers({ Worker, redis })).find((x) => x.workerId === id).status).toBe("UNRESPONSIVE");
});

test("GET /workers: admin only", async () => {
  const stack = createTestStack({ withRegistry: true });
  await stack.start();
  try {
    const [admin, op] = await Promise.all([createUser(`a-${randomUUID()}@r.test`, "admin"), createUser(`o-${randomUUID()}@r.test`, "operator")]);
    const res = await as(stack.app, admin.token).get("/workers");
    expect(res.status).toBe(200);
    expect(res.body.workers.some((w) => w.workerId === "test-worker" && w.status === "ACTIVE")).toBe(true);
    expect((await as(stack.app, op.token).get("/workers")).status).toBe(403);
  } finally {
    await stack.stop();
  }
});

test("provider factory: mock mode builds the full observed + fallback stack and records calls", async () => {
  const base = { MONGO_URI: "mongodb://x", REDIS_URL: "redis://x", JWT_ACCESS_SECRET: "a".repeat(32), JWT_REFRESH_SECRET: "b".repeat(32) };
  const config = loadConfig({ ...base, LLM_PROVIDER: "mock" });
  const provider = createProviderFromConfig(config.llm, { AIExecution, logger });
  const r = await provider.chat({ model: "m", messages: [{ role: "user", content: "hi" }] });
  expect(r).toMatchObject({ content: "{}", provider: "mock", fallbackUsed: false });
  await new Promise((res) => setTimeout(res, 50)); // recording is fire-and-forget
  expect(await AIExecution.countDocuments({ provider: "mock", model: "m" })).toBeGreaterThan(0);

  const withFallback = loadConfig({ ...base, LLM_FALLBACK_BASE_URL: "http://backup:8000", LLM_FALLBACK_MODEL: "hosted" });
  expect(createProviderFromConfig(withFallback.llm, { AIExecution, logger }).name).toBe("ollama>fallback");

  const { rag, vectorStore } = createRagFromConfig({ config, provider, logger });
  expect(typeof rag.answer).toBe("function");
  expect(typeof vectorStore.search).toBe("function");
});
