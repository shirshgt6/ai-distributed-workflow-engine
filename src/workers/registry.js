/**
 * HEARTBEAT: a worker proves it is alive by refreshing two things every
 * interval:
 *   Redis  wf:worker:<id>  with a TTL   -> disappears on its own if we die
 *   Mongo  Worker.lastSeenAt            -> durable history for GET /workers
 *
 * A heartbeat is a FAILURE DETECTOR, and an imperfect one: "no heartbeat" can
 * mean dead, paused, or partitioned. That's why correctness (who may finish a
 * task) is decided by task leases + fencing tokens, never by this registry.
 *
 * @param {{ Worker, redis, workerId: string, host: string, pid: number, concurrency: number, ttlMs: number, logger }} deps
 */
export function createWorkerRegistry({ Worker, redis, workerId, host, pid, concurrency, ttlMs, logger }) {
  const key = `wf:worker:${workerId}`;

  return {
    async register() {
      await Worker.updateOne(
        { workerId },
        {
          $set: { host, pid, concurrency, status: "ACTIVE", startedAt: new Date(), lastSeenAt: new Date(), runningTasks: 0 },
        },
        { upsert: true }
      );
      await redis.set(key, String(Date.now()), "PX", ttlMs);
    },

    async beat({ runningTasks, completedSinceLastBeat = 0 }) {
      try {
        await Promise.all([
          redis.set(key, String(Date.now()), "PX", ttlMs),
          Worker.updateOne(
            { workerId },
            { $set: { lastSeenAt: new Date(), runningTasks, status: "ACTIVE" }, $inc: { tasksCompleted: completedSinceLastBeat } }
          ),
        ]);
      } catch (err) {
        logger.warn({ err: err.message }, "heartbeat failed");
      }
    },

    async deregister() {
      await Promise.allSettled([redis.del(key), Worker.updateOne({ workerId }, { $set: { status: "STOPPED", runningTasks: 0 } })]);
    },
  };
}

/** Is a registered worker alive right now? (Redis key present = heartbeat within TTL.) */
export async function listWorkers({ Worker, redis }) {
  const workers = await Worker.find({}).sort({ lastSeenAt: -1 }).limit(200).lean();
  const alive = workers.length ? await redis.mget(...workers.map((w) => `wf:worker:${w.workerId}`)) : [];
  return workers.map((w, i) => ({
    workerId: w.workerId,
    host: w.host,
    pid: w.pid,
    concurrency: w.concurrency,
    status: w.status === "ACTIVE" && !alive[i] ? "UNRESPONSIVE" : w.status,
    runningTasks: w.runningTasks,
    tasksCompleted: w.tasksCompleted,
    startedAt: w.startedAt,
    lastSeenAt: w.lastSeenAt,
  }));
}
