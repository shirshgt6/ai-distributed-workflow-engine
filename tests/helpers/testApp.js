// Shared setup for integration tests: a fully wired app (real Mongo, fake
// secrets, low bcrypt cost) plus helpers to create users with a given role.
import { randomUUID } from "node:crypto";
import request from "supertest";
import { createApp } from "../../src/app.js";
import { createLogger } from "../../src/config/logger.js";
import { createTokenService } from "../../src/auth/tokens.js";
import { createAuthService } from "../../src/services/auth.service.js";
import { createWorkflowService } from "../../src/services/workflow.service.js";
import { hashPassword } from "../../src/auth/password.js";
import { User } from "../../src/models/user.model.js";
import { Workflow } from "../../src/models/workflow.model.js";
import { WorkflowExecution } from "../../src/models/workflowExecution.model.js";
import { Task } from "../../src/models/task.model.js";
import { TaskExecution } from "../../src/models/taskExecution.model.js";
import { createEngine } from "../../src/workflow/engine.js";
import { createRedisClient } from "../../src/config/redis.js";
import { createTaskQueue } from "../../src/queues/taskQueue.js";
import { createQueueWorker } from "../../src/workers/queueWorker.js";
import { createWorkerRegistry, listWorkers } from "../../src/workers/registry.js";
import { Worker } from "../../src/models/worker.model.js";
import { OutboxEvent } from "../../src/models/outboxEvent.model.js";
import { createExecutionService } from "../../src/services/execution.service.js";
import { handlers as builtinHandlers } from "../../src/handlers/index.js";
import { createAiHandlers } from "../../src/handlers/ai.js";
import { createMockProvider } from "../../src/ai/providers/mock.js";
import { createVectorStore } from "../../src/ai/rag/vectorStore.js";
import { createRagPipeline } from "../../src/ai/rag/pipeline.js";
import { KnowledgeDocument, KnowledgeChunk } from "../../src/models/knowledge.model.js";
import { createToolRegistry } from "../../src/ai/agent/tools.js";

export const MONGO_URI =
  process.env.MONGO_URI_TEST ?? "mongodb://localhost:27018/workflow_engine_test?directConnection=true";
export const REDIS_URL = process.env.REDIS_URL_TEST ?? "redis://localhost:6380";
export const QDRANT_URL = process.env.QDRANT_URL_TEST ?? "http://localhost:6333";
export const PASSWORD = "s3cure-enough-pass";
const BCRYPT_COST = 4;

export const logger = createLogger({ level: "silent" });
export const tokens = createTokenService({
  accessSecret: "integration-access-secret-0123456789abcdef",
  refreshSecret: "integration-refresh-secret-0123456789abcdef",
  accessTtl: "15m",
  refreshTtl: "7d",
});

export function createTestApp() {
  const authService = createAuthService({ User, tokens, bcryptCost: BCRYPT_COST });
  const workflowService = createWorkflowService({ Workflow });
  return createApp({ logger, auth: { authService, tokens }, workflowService });
}

/**
 * Full stack: API + engine + Redis queue (isolated key prefix) + a queue
 * worker, for end-to-end tests. `await stack.start()` in beforeAll and
 * `await stack.stop()` in afterAll.
 */
export const TEST_MODELS = { small: "mock-small", large: "mock-large", embedding: "mock-embed" };

export function createTestStack({
  concurrency = 4,
  leaseMs = 2000,
  workerId = "test-worker",
  withRegistry = false,
  llm = createMockProvider(),
  ragOptions = {},
} = {}) {
  const vectorStore = createVectorStore({ url: QDRANT_URL, prefix: `test_${randomUUID().slice(0, 8)}` });
  const rag = createRagPipeline({ provider: llm, vectorStore, models: TEST_MODELS, KnowledgeDocument, KnowledgeChunk, logger, minScore: 0.1, ...ragOptions });
  const tools = createToolRegistry({ rag, WorkflowExecution, Task });
  const getUserRole = async (userId) => (await User.findById(userId).select("role").lean())?.role ?? null;
  const handlers = {
    ...builtinHandlers,
    ...createAiHandlers({ provider: llm, models: TEST_MODELS, logger, rag, tools, getUserRole }),
  };
  const redis = createRedisClient(REDIS_URL, logger, { name: "test-stack" });
  const queue = createTaskQueue(redis, { prefix: `test:${randomUUID()}` });
  const authService = createAuthService({ User, tokens, bcryptCost: BCRYPT_COST });
  const workflowService = createWorkflowService({ Workflow });
  const engine = createEngine({
    models: { WorkflowExecution, Task, TaskExecution, OutboxEvent },
    enqueue: (item) => queue.enqueue(item.taskId),
    enqueueDelayed: (item, delayMs) => queue.enqueueDelayed(item.taskId, delayMs),
    logger,
    leaseMs,
    backoff: (attempt) => 20 * attempt, // fast, deterministic retries in tests
  });
  const worker = createQueueWorker({
    queue,
    engine,
    handlers,
    logger,
    workerId,
    concurrency,
    pollIntervalMs: 20,
    leaseMs,
    maintenanceIntervalMs: 50,
    registry: withRegistry
      ? createWorkerRegistry({ Worker, redis, workerId, host: "test-host", pid: process.pid, concurrency, ttlMs: leaseMs, logger })
      : null,
  });
  const executionService = createExecutionService({ Workflow, WorkflowExecution, Task, engine });
  const app = createApp({
    logger,
    auth: { authService, tokens },
    workflowService,
    executionService,
    admin: { listWorkers: () => listWorkers({ Worker, redis }) },
    knowledge: { rag, KnowledgeDocument },
  });

  return {
    rag,
    vectorStore,
    app,
    engine,
    queue,
    worker,
    redis,
    /** @param {{ startWorker?: boolean }} [options] false = connect only (tests start the worker later) */
    async start({ startWorker = true } = {}) {
      await redis.connect();
      if (startWorker) await worker.start();
    },
    async stop() {
      await worker.stop();
      await vectorStore.deleteCollection(TEST_MODELS.embedding, llm.dims ?? 64);
      await redis.del(...Object.values(queue.keys));
      await redis.quit();
    },
  };
}

/** Poll until fn() returns a truthy value (or time out). */
export async function waitFor(fn, { timeoutMs = 5000, intervalMs = 25 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("waitFor: timed out");
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/** Creates a user directly in the DB and returns { user, token }. */
export async function createUser(email, role) {
  const passwordHash = await hashPassword(PASSWORD, BCRYPT_COST);
  const user = await User.create({ email, passwordHash, role });
  return { user, token: tokens.signAccessToken(user) };
}

/** Supertest request with a Bearer token attached. */
export function as(app, token) {
  const withAuth = (req) => req.set("Authorization", `Bearer ${token}`);
  return {
    get: (url) => withAuth(request(app).get(url)),
    post: (url) => withAuth(request(app).post(url)),
    put: (url) => withAuth(request(app).put(url)),
    patch: (url) => withAuth(request(app).patch(url)),
    delete: (url) => withAuth(request(app).delete(url)),
  };
}
