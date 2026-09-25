import { z } from "zod";
import { ValidationError } from "../utils/errors.js";

// Client-chosen, e.g. a UUID generated once per user action and reused on retries.
const idempotencyKeySchema = z.string().regex(/^[A-Za-z0-9_-]{8,128}$/);

/**
 * @param {ReturnType<import('../services/execution.service.js').createExecutionService>} executionService
 */
export function createExecutionController(executionService) {
  return {
    async run(req, res) {
      const rawKey = req.get("idempotency-key");
      let idempotencyKey;
      if (rawKey !== undefined) {
        const parsed = idempotencyKeySchema.safeParse(rawKey);
        if (!parsed.success) {
          throw new ValidationError("Idempotency-Key must be 8-128 chars of letters, digits, _ or -");
        }
        idempotencyKey = parsed.data;
      }

      const { execution, replayed } = await executionService.run(req.user, req.valid.params.id, req.valid.body.input, {
        idempotencyKey,
      });
      // 202 Accepted, not 201/200: the run has STARTED, not finished. The
      // client polls the Location URL for progress. A replay returns the same
      // status and body as the original, flagged with a header.
      if (replayed) res.set("Idempotent-Replayed", "true");
      res.status(202).location(`/executions/${execution._id}`).json({ execution });
    },

    async control(req, res) {
      const action = req.path.split("/").pop(); // pause | resume | cancel
      const execution = await executionService.control(req.user, req.valid.params.id, action);
      res.status(200).json({ execution });
    },

    async get(req, res) {
      const { execution, tasks } = await executionService.get(req.user, req.valid.params.id);
      res.status(200).json({ execution, tasks });
    },
  };
}
