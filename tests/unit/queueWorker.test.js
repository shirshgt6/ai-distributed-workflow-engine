import { createQueueWorker } from "../../src/workers/queueWorker.js";
import { runTask } from "../../src/workers/runTask.js";
import { handlers as builtins, sleep } from "../../src/handlers/index.js";
import { createLogger } from "../../src/config/logger.js";

const logger = createLogger({ level: "silent" });

/** In-memory stand-in for the Redis queue that records what the worker does. */
function fakeQueue(ids = []) {
  const ready = [...ids];
  const log = [];
  return {
    log,
    async claim() {
      const id = ready.shift() ?? null;
      if (id) log.push(["claim", id]);
      return id;
    },
    async extendLease(id, ms) {
      log.push(["extend", id, ms]);
      return true;
    },
    async ack(id) {
      log.push(["ack", id]);
      return true;
    },
    async requeueExpired() {
      return [];
    },
    async promoteDue() {
      return [];
    },
  };
}

/** Engine stand-in: startTask returns a task of the given shape (or null). */
function fakeEngine(taskFor, log = []) {
  return {
    log,
    async startTask(taskId) {
      const task = taskFor(taskId);
      if (!task) return null;
      return {
        task: { _id: taskId, executionId: "e1", key: taskId, attempt: 1, leaseToken: 7, timeoutMs: 1000, config: {}, ...task },
        input: {},
        parents: {},
      };
    },
    async completeTask(args) {
      log.push(["complete", String(args.taskId), args.output]);
    },
    async renewLease() {
      return true;
    },
    async failTask(args) {
      log.push(["fail", String(args.taskId), args.error.message, args.error.name]);
    },
  };
}

const waitFor = async (cond, ms = 2000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await sleep(5);
  }
};

function makeWorker(queue, engine, extra = {}) {
  return createQueueWorker({
    queue,
    engine,
    handlers: builtins,
    logger,
    workerId: "w1",
    concurrency: 2,
    pollIntervalMs: 5,
    leaseMs: 1500,
    maintenanceIntervalMs: 1000,
    ...extra,
  });
}

describe("queue worker", () => {
  test("claim -> extend lease -> run -> report to MongoDB -> ack LAST", async () => {
    const queue = fakeQueue(["t1"]);
    const events = [];
    const engine = fakeEngine(() => ({ type: "echo", config: { x: 1 } }), events);
    const origAck = queue.ack;
    queue.ack = async (id) => {
      events.push(["ack", id]);
      return origAck(id);
    };

    const worker = makeWorker(queue, engine);
    worker.start();
    await waitFor(() => events.some((e) => e[0] === "ack"));
    await worker.stop();

    expect(queue.log.find((e) => e[0] === "extend")).toEqual(["extend", "t1", 1500]);
    // The result must be stored BEFORE the queue forgets the task.
    expect(events.map((e) => e[0])).toEqual(["complete", "ack"]);
    expect(events[0][2]).toEqual({ config: { x: 1 }, input: {}, parents: {} });
  });

  test("a task that can't be claimed in MongoDB (finished/cancelled/live elsewhere) is acked and dropped", async () => {
    const queue = fakeQueue(["stale"]);
    const engine = fakeEngine(() => null);
    const worker = makeWorker(queue, engine);
    worker.start();
    await waitFor(() => queue.log.some((e) => e[0] === "ack"));
    await worker.stop();
    expect(queue.log).toEqual([
      ["claim", "stale"],
      ["ack", "stale"],
    ]);
    expect(engine.log).toEqual([]);
  });

  test("if reporting to MongoDB fails, the task is NOT acked (its lease will expire and it is retried)", async () => {
    const queue = fakeQueue(["t1"]);
    const engine = fakeEngine(() => ({ type: "noop" }));
    engine.completeTask = async () => {
      throw new Error("mongo down");
    };
    const worker = makeWorker(queue, engine);
    worker.start();
    await sleep(60);
    await worker.stop();
    expect(queue.log.map((e) => e[0])).toEqual(["claim", "extend"]); // no ack
  });

  test("Redis errors on claim: the worker backs off instead of crashing", async () => {
    let calls = 0;
    const queue = fakeQueue();
    queue.claim = async () => {
      calls += 1;
      throw new Error("ECONNREFUSED");
    };
    const worker = makeWorker(queue, fakeEngine(() => null), { concurrency: 1 });
    worker.start();
    await sleep(100);
    await worker.stop();
    // Exponential backoff (5, 10, 20, 40ms...) => only a handful of attempts in 100ms, not ~20.
    expect(calls).toBeGreaterThan(1);
    expect(calls).toBeLessThan(8);
  });

  test("never runs more than `concurrency` tasks at once", async () => {
    let active = 0;
    let maxActive = 0;
    const handlers = {
      slow: async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        await sleep(20);
        active--;
        return {};
      },
    };
    const queue = fakeQueue(Array.from({ length: 10 }, (_, i) => `t${i}`));
    const engine = fakeEngine(() => ({ type: "slow" }));
    const worker = makeWorker(queue, engine, { handlers, concurrency: 3 });
    worker.start();
    await waitFor(() => engine.log.length === 10);
    await worker.stop();
    expect(maxActive).toBe(3);
  });

  test("lease lost mid-task (cancel/takeover): the handler is ABORTED and its report goes nowhere useful", async () => {
    const queue = fakeQueue(["t1"]);
    let aborted = null;
    const handlers = {
      long: async ({ signal }) => {
        try {
          await sleep(5000, signal);
        } catch (err) {
          aborted = err.message;
          throw err;
        }
      },
    };
    const engine = fakeEngine(() => ({ type: "long", timeoutMs: 10_000 }));
    engine.renewLease = async () => false; // MongoDB says: not yours any more
    const worker = makeWorker(queue, engine, { handlers, concurrency: 1, leaseMs: 90 });
    worker.start();
    await waitFor(() => aborted !== null);
    await worker.stop();
    expect(aborted).toMatch(/Lease lost/);
  });

  test("stop() lets the in-flight task finish and report", async () => {
    const queue = fakeQueue(["t1", "t2"]);
    const engine = fakeEngine(() => ({ type: "delay", config: { ms: 40 } }));
    const worker = makeWorker(queue, engine, { concurrency: 1 });
    worker.start();
    await sleep(10);
    await worker.stop();
    expect(engine.log.map((e) => e[1])).toEqual(["t1"]); // t1 finished; t2 never started
  });
});

describe("runTask", () => {
  const claimed = (task) => ({
    task: { _id: "t1", executionId: "e1", key: "t1", attempt: 1, leaseToken: 7, timeoutMs: 1000, config: {}, ...task },
    input: {},
    parents: {},
  });

  test("sync and async throws are both reported as failures", async () => {
    const handlers = {
      syncThrow: () => {
        throw new Error("sync boom");
      },
      fail: builtins.fail,
    };
    const engine = fakeEngine(() => null);
    await runTask({ claimed: claimed({ type: "syncThrow" }), engine, handlers, logger });
    await runTask({ claimed: claimed({ type: "fail" }), engine, handlers, logger });
    expect(engine.log.map((e) => e[2])).toEqual(["sync boom", "Task configured to fail"]);
  });

  test("timeout fails the task AND aborts the handler's work", async () => {
    let aborted = false;
    const handlers = {
      hang: async ({ signal }) => {
        try {
          await sleep(10_000, signal);
        } catch (err) {
          aborted = true;
          throw err;
        }
      },
    };
    const engine = fakeEngine(() => null);
    await runTask({ claimed: claimed({ type: "hang", timeoutMs: 30 }), engine, handlers, logger });
    expect(engine.log[0]).toEqual(["fail", "t1", 'task "t1" timed out after 30ms', "TimeoutError"]);
    await waitFor(() => aborted);
  });

  test("unknown task type fails the task instead of crashing the worker", async () => {
    const engine = fakeEngine(() => null);
    await runTask({ claimed: claimed({ type: "does.not.exist" }), engine, handlers: builtins, logger });
    expect(engine.log[0][2]).toMatch(/No handler registered/);
  });

  test("the lease token from the claim is what gets reported (fencing)", async () => {
    const reports = [];
    const engine = { completeTask: async (a) => reports.push(a.leaseToken), failTask: async () => {} };
    await runTask({ claimed: claimed({ type: "noop", leaseToken: 42 }), engine, handlers: builtins, logger });
    expect(reports).toEqual([42]);
  });
});

describe("built-in handlers", () => {
  test("delay honours abort", async () => {
    const controller = new AbortController();
    const p = builtins.delay({ config: { ms: 5000 }, signal: controller.signal });
    controller.abort(new Error("stop"));
    await expect(p).rejects.toThrow("stop");
  });
});
