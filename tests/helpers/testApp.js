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
import { createExecutionService } from "../../src/services/execution.service.js";
import { handlers } from "../../src/handlers/index.js";

export const MONGO_URI =
  process.env.MONGO_URI_TEST ?? "mongodb://localhost:27018/workflow_engine_test?directConnection=true";
export const REDIS_URL = process.env.REDIS_URL_TEST ?? "redis://localhost:6380";
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
export function createTestStack({ concurrency = 4, leaseGraceMs = 2000, workerId = "test-worker" } = {}) {
  const redis = createRedisClient(REDIS_URL, logger, { name: "test-stack" });
  const queue = createTaskQueue(redis, { prefix: `test:${randomUUID()}` });
  const authService = createAuthService({ User, tokens, bcryptCost: BCRYPT_COST });
  const workflowService = createWorkflowService({ Workflow });
  const engine = createEngine({
    models: { WorkflowExecution, Task, TaskExecution },
    enqueue: (item) => queue.enqueue(item.taskId),
    enqueueDelayed: (item, delayMs) => queue.enqueueDelayed(item.taskId, delayMs),
    logger,
    leaseGraceMs,
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
    leaseGraceMs,
    maintenanceIntervalMs: 50,
  });
  const executionService = createExecutionService({ Workflow, WorkflowExecution, Task, engine });
  const app = createApp({ logger, auth: { authService, tokens }, workflowService, executionService });

  return {
    app,
    engine,
    queue,
    worker,
    redis,
    /** @param {{ startWorker?: boolean }} [options] false = connect only (tests start the worker later) */
    async start({ startWorker = true } = {}) {
      await redis.connect();
      if (startWorker) worker.start();
    },
    async stop() {
      await worker.stop();
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
  };
}
