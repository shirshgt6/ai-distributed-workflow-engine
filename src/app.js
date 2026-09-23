import express from "express";
import helmet from "helmet";
import { pinoHttp } from "pino-http";
import { requestId } from "./middleware/requestId.js";
import { errorHandler, notFound } from "./middleware/errorHandler.js";
import { healthRouter } from "./routes/health.routes.js";

/**
 * Build the Express app WITHOUT starting a server or connecting to anything.
 *
 * All dependencies are passed in (dependency injection). That is what lets
 * tests build an app with fake health checks and a silent logger, and hit
 * it with Supertest — no Mongo/Redis, no open port. server.js passes the
 * real ones.
 *
 * @param {{
 *   logger: import('pino').Logger,
 *   checks?: Record<string, () => Promise<void>>,
 *   isShuttingDown?: () => boolean,
 *   bodyLimit?: string
 * }} deps
 */
export function createApp({ logger, checks = {}, isShuttingDown = () => false, bodyLimit = "100kb" }) {
  const app = express();

  // Don't advertise the framework (X-Powered-By: Express) to scanners.
  app.disable("x-powered-by");

  // ORDER MATTERS: middleware runs top to bottom.
  // 1. requestId first, so every later log line can include it.
  app.use(requestId);

  // 2. Request logging: one structured line per completed request
  //    (method, url, status, responseTime, reqId). Attaches req.log.
  app.use(
    pinoHttp({
      logger,
      genReqId: (req) => req.id,
      // Load balancers hit /health every few seconds; logging each hit
      // would drown real traffic in noise.
      autoLogging: { ignore: (req) => req.url === "/health" },
      customLogLevel: (req, res, err) => {
        if (err || res.statusCode >= 500) return "error";
        if (res.statusCode >= 400) return "warn";
        return "info";
      },
    })
  );

  // 3. Security headers (nosniff, frame protection, etc.).
  app.use(helmet());

  // 4. JSON body parsing with a size cap. Without a limit, one client can
  //    POST a huge body and make the process buffer it all in memory.
  app.use(express.json({ limit: bodyLimit }));

  // 5. Routes.
  app.use(healthRouter({ checks, isShuttingDown, logger }));

  // 6. Nothing matched -> 404, then the error handler LAST.
  app.use(notFound);
  app.use(errorHandler);

  return app;
}
