import { Router } from "express";
import { runHealthChecks } from "../services/health.service.js";

/**
 * Two different questions, two endpoints:
 *
 * GET /health  (LIVENESS)  "Is this process alive and able to answer?"
 *   Deliberately checks NO dependencies. If it did, a Mongo outage would
 *   make every API instance "dead", the orchestrator would restart all of
 *   them, and restarting can't fix Mongo — a pointless restart storm.
 *
 * GET /ready   (READINESS) "Should traffic be sent to me right now?"
 *   Checks dependencies. Failing it only takes the instance OUT of the load
 *   balancer until it recovers; nothing gets restarted. It also fails during
 *   graceful shutdown so the load balancer drains us before we exit.
 *
 * @param {{
 *   checks: Record<string, () => Promise<void>>,
 *   isShuttingDown: () => boolean,
 *   logger: import('pino').Logger,
 *   timeoutMs?: number
 * }} deps
 */
export function healthRouter({ checks, isShuttingDown, logger, timeoutMs = 2000 }) {
  const router = Router();

  router.get("/health", (req, res) => {
    res.status(200).json({ status: "ok", uptimeSeconds: Math.round(process.uptime()) });
  });

  router.get("/ready", async (req, res) => {
    if (isShuttingDown()) {
      return res.status(503).json({ status: "shutting_down" });
    }

    const { ready, results } = await runHealthChecks(checks, timeoutMs);

    // Full error detail goes to the logs only. The HTTP body stays generic:
    // raw driver errors can include hostnames, ports and topology details.
    const body = {};
    for (const [name, result] of Object.entries(results)) {
      body[name] = { status: result.status, latencyMs: result.latencyMs };
      if (result.error) {
        logger.warn({ dependency: name, err: result.error.message }, "readiness check failed");
      }
    }

    res.status(ready ? 200 : 503).json({ status: ready ? "ready" : "not_ready", checks: body });
  });

  return router;
}
