import { nextRunAfter } from "./cron.js";

const DUPLICATE_KEY = 11000;

/**
 * CRON SCHEDULER: starts runs of workflows whose schedule is due.
 *
 * Exactly-one-run-per-slot, without trusting the lock alone:
 *   1. LEADER ELECTION: only the holder of the "scheduler" Redis lock ticks.
 *      That avoids wasted work, but a paused leader could overlap a new one.
 *   2. IDEMPOTENCY KEY per slot: "schedule:<workflowId>:<slot ISO time>".
 *      Starting the same slot twice (two leaders, or a crash between "start
 *      run" and "advance nextRunAt") hits the unique index and returns the
 *      existing run. THIS is the real guarantee; the lock is an optimization.
 *   3. ADVANCE with compare-and-set: nextRunAt moves forward only if it is
 *      still the slot we just handled.
 *
 * Order: start the run FIRST, then advance nextRunAt. A crash in between means
 * the next tick retries the same slot, and the idempotency key dedupes it.
 * (Advancing first could skip a run forever.)
 *
 * Missed slots (scheduler down for hours): NO backfill. The overdue slot runs
 * once, then the next slot is computed from "now". An hourly job after a 5-hour
 * outage runs once, not five times.
 *
 * @param {{ Workflow, engine, lock, logger, now?: () => Date, batchSize?: number }} deps
 */
export function createScheduler({ Workflow, engine, lock, logger, now = () => new Date(), batchSize = 50 }) {
  let held = null;
  let timer = null;
  let busy = false;

  async function runDue() {
    const current = now();
    const due = await Workflow.find({ "schedule.enabled": true, "schedule.nextRunAt": { $lte: current } })
      .sort({ "schedule.nextRunAt": 1 })
      .limit(batchSize);

    let started = 0;
    for (const workflow of due) {
      const { cron, timezone, input } = workflow.schedule;
      const slot = workflow.schedule.nextRunAt;
      const idempotencyKey = `schedule:${workflow._id}:${slot.toISOString()}`;
      let lastError = null;

      try {
        await engine.startExecution({
          workflow,
          input: input ?? {},
          triggeredBy: workflow.ownerId, // runs on behalf of the owner
          trigger: "schedule",
          idempotencyKey,
        });
        started += 1;
      } catch (err) {
        if (err?.code === DUPLICATE_KEY && err?.keyPattern?.idempotencyKey) {
          logger.info({ workflowId: String(workflow._id), slot }, "scheduled slot already started (deduplicated)");
        } else {
          // e.g. the stored graph is invalid: record it, still move on, so one
          // broken workflow can't block the schedule forever.
          lastError = err.message;
          logger.warn({ workflowId: String(workflow._id), err: err.message }, "scheduled run failed to start");
        }
      }

      const base = slot > current ? slot : current; // no backfill of missed slots
      await Workflow.updateOne(
        { _id: workflow._id, "schedule.nextRunAt": slot },
        {
          $set: {
            "schedule.nextRunAt": nextRunAfter(cron, base, timezone),
            "schedule.lastRunAt": current,
            "schedule.lastError": lastError,
          },
        }
      );
    }
    return started;
  }

  async function tick() {
    if (busy) return 0;
    busy = true;
    try {
      if (held && !(await lock.extend(held.token))) held = null;
      if (!held) {
        held = await lock.acquire();
        if (held) logger.info({ fence: held.fence }, "became scheduler leader");
      }
      if (!held) return 0;
      return await runDue();
    } catch (err) {
      logger.warn({ err: err.message }, "scheduler tick failed");
      return 0;
    } finally {
      busy = false;
    }
  }

  return {
    tick,
    start(intervalMs) {
      timer = setInterval(tick, intervalMs);
    },
    async stop() {
      clearInterval(timer);
      if (held) await lock.release(held.token).catch(() => {});
      held = null;
    },
  };
}
