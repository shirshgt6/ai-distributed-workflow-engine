import dotenv from "dotenv";
import { loadConfig } from "./config/env.js";
import { createLogger } from "./config/logger.js";
import { connectMongo, disconnectMongo, pingMongo } from "./config/mongo.js";
import { createRedisClient, pingRedis } from "./config/redis.js";
import { createApp } from "./app.js";
import { createTokenService } from "./auth/tokens.js";
import { createAuthService } from "./services/auth.service.js";
import { User } from "./models/user.model.js";
import { Workflow } from "./models/workflow.model.js";
import { createWorkflowService } from "./services/workflow.service.js";
import { WorkflowExecution } from "./models/workflowExecution.model.js";
import { Task } from "./models/task.model.js";
import { TaskExecution } from "./models/taskExecution.model.js";
import { createEngine } from "./workflow/engine.js";
import { createTaskQueue } from "./queues/taskQueue.js";
import { Worker } from "./models/worker.model.js";
import { OutboxEvent } from "./models/outboxEvent.model.js";
import { ApprovalRequest } from "./models/approval.model.js";
import { listWorkers } from "./workers/registry.js";
import { createProviderFromConfig } from "./ai/providers/index.js";
import { AIExecution } from "./models/aiExecution.model.js";
import { createAnalyticsService } from "./services/analytics.service.js";
import { createRagFromConfig } from "./ai/rag/index.js";
import { KnowledgeDocument } from "./models/knowledge.model.js";
import { createExecutionService } from "./services/execution.service.js";

// Composition root: the ONE place that reads config, creates real
// connections and wires them into the app. Everything else receives its
// dependencies as arguments.
async function main() {
  dotenv.config({ quiet: true });

  const config = loadConfig();
  const logger = createLogger({ level: config.logLevel, pretty: !config.isProduction });

  // Fail fast: if a hard dependency is unreachable at boot, exit non-zero.
  // In Docker/Kubernetes the orchestrator restarts us with backoff; that is
  // simpler and more honest than serving traffic we can't handle.
  await connectMongo(config.mongo.uri, logger);
  const redis = createRedisClient(config.redis.url, logger);
  await redis.connect();

  const tokens = createTokenService(config.auth);
  const authService = createAuthService({ User, tokens, bcryptCost: config.auth.bcryptCost });
  const workflowService = createWorkflowService({ Workflow });

  // Engine -> Redis queue -> worker -> engine. MongoDB holds task state;
  // Redis only holds "which task id to pick up next".
  const queue = createTaskQueue(redis);
  const engine = createEngine({
    models: { WorkflowExecution, Task, TaskExecution, OutboxEvent, ApprovalRequest },
    enqueue: (item) => queue.enqueue(item.taskId),
    enqueueDelayed: (item, delayMs) => queue.enqueueDelayed(item.taskId, delayMs),
    logger,
    leaseMs: config.worker.leaseMs,
  });
  const executionService = createExecutionService({ Workflow, WorkflowExecution, Task, engine });
  // RAG: document upload + search (ingestion embeds via the LLM provider).
  const llm = createProviderFromConfig(config.llm, { AIExecution, logger });
  const { rag, vectorStore } = createRagFromConfig({ config, provider: llm, logger });

  // The API only STARTS runs (MongoDB + enqueue to Redis). Tasks are executed
  // by separate worker processes: `npm run worker` (src/worker.js). The
  // reconciler runs in the workers too.

  let shuttingDown = false;

  const app = createApp({
    logger,
    bodyLimit: config.bodyLimit,
    checks: {
      mongo: pingMongo,
      redis: () => pingRedis(redis),
      qdrant: () => vectorStore.ping(),
    },
    isShuttingDown: () => shuttingDown,
    auth: { authService, tokens },
    workflowService,
    executionService,
    admin: { listWorkers: () => listWorkers({ Worker, redis }) },
    knowledge: { rag, KnowledgeDocument },
    approvals: { engine, ApprovalRequest },
    analyticsService: createAnalyticsService({ WorkflowExecution, Task, TaskExecution, AIExecution }),
  });

  const server = app.listen(config.port, () => {
    logger.info({ port: config.port, env: config.env }, "API listening");
  });

  server.on("error", (err) => {
    // e.g. EADDRINUSE — another process already owns the port.
    logger.fatal({ err }, "HTTP server error");
    process.exit(1);
  });

  // GRACEFUL SHUTDOWN
  // SIGTERM is what Docker/Kubernetes send before killing a container;
  // SIGINT is Ctrl+C. Instead of dying mid-request we:
  //   1. flip `shuttingDown` -> /ready returns 503 so no NEW traffic arrives
  //   2. server.close()      -> stop accepting connections, let in-flight
  //                             requests finish
  //   3. close Mongo + Redis -> flush and release connections cleanly
  //   4. exit 0
  // A timer force-exits if any step hangs, so a stuck request can't block
  // a deploy forever.
  async function shutdown(signal) {
    if (shuttingDown) return; // second Ctrl+C / duplicate signal: already on it
    shuttingDown = true;
    logger.info({ signal }, "shutting down gracefully");

    const forceExit = setTimeout(() => {
      logger.error({ timeoutMs: config.shutdownTimeoutMs }, "graceful shutdown timed out, forcing exit");
      process.exit(1);
    }, config.shutdownTimeoutMs);
    forceExit.unref(); // this timer alone must not keep the process alive

    await new Promise((resolve) => server.close(resolve));
    await Promise.allSettled([disconnectMongo(), redis.quit()]);

    logger.info("shutdown complete");
    process.exit(0);
  }

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  // A promise rejected with no .catch() anywhere means the process is in
  // an unknown state. Log it and shut down rather than limp on.
  process.on("unhandledRejection", (reason) => {
    logger.fatal({ err: reason }, "unhandled promise rejection");
    shutdown("unhandledRejection");
  });
}

main().catch((err) => {
  // The logger may not exist yet (e.g. config validation failed), so this
  // last-resort path writes directly to stderr.
  process.stderr.write(`[fatal] failed to start: ${err.stack ?? err}\n`);
  process.exit(1);
});
