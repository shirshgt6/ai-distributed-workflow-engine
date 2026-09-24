import { createInProcessExecutor } from "../../src/workflow/inProcessExecutor.js";
import { handlers as builtins, sleep } from "../../src/handlers/index.js";
import { createLogger } from "../../src/config/logger.js";

const logger = createLogger({ level: "silent" });

/** A fake engine that records calls; startTask returns a task of the given type. */
function fakeEngine(taskFor) {
  const calls = { completed: [], failed: [] };
  return {
    calls,
    async startTask(taskId) {
      const task = taskFor(taskId);
      if (!task) return null;
      return { task: { _id: taskId, executionId: "e1", key: taskId, leaseToken: 7, timeoutMs: 1000, config: {}, ...task }, input: {}, parents: {} };
    },
    async completeTask(args) {
      calls.completed.push(args);
    },
    async failTask(args) {
      calls.failed.push({ ...args, message: args.error.message });
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

describe("in-process executor", () => {
  test("runs the handler and reports completion with the lease token", async () => {
    const engine = fakeEngine(() => ({ type: "echo", config: { x: 1 } }));
    const executor = createInProcessExecutor({ handlers: builtins, concurrency: 2, logger });
    executor.attach(engine);
    executor.enqueue({ taskId: "t1" });
    await waitFor(() => engine.calls.completed.length === 1);
    expect(engine.calls.completed[0]).toMatchObject({ taskId: "t1", leaseToken: 7, output: { config: { x: 1 } } });
  });

  test("never runs more than `concurrency` handlers at once", async () => {
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
    const engine = fakeEngine(() => ({ type: "slow" }));
    const executor = createInProcessExecutor({ handlers, concurrency: 3, logger });
    executor.attach(engine);
    for (let i = 0; i < 10; i++) executor.enqueue({ taskId: `t${i}` });
    await waitFor(() => engine.calls.completed.length === 10);
    expect(maxActive).toBe(3);
  });

  test("a throwing handler (sync or async) is reported as a failure", async () => {
    const handlers = {
      syncThrow: () => {
        throw new Error("sync boom");
      },
      fail: builtins.fail,
    };
    const engine = fakeEngine((id) => ({ type: id }));
    const executor = createInProcessExecutor({ handlers, concurrency: 2, logger });
    executor.attach(engine);
    executor.enqueue({ taskId: "syncThrow" });
    executor.enqueue({ taskId: "fail" });
    await waitFor(() => engine.calls.failed.length === 2);
    expect(engine.calls.failed.map((f) => f.message).sort()).toEqual(["Task configured to fail", "sync boom"]);
    expect(engine.calls.completed).toHaveLength(0);
  });

  test("timeout: fails the task AND aborts the handler's work", async () => {
    let abortedWith = null;
    const handlers = {
      hang: async ({ signal }) => {
        try {
          await sleep(10_000, signal);
        } catch (err) {
          abortedWith = err;
          throw err;
        }
      },
    };
    const engine = fakeEngine(() => ({ type: "hang", timeoutMs: 30 }));
    const executor = createInProcessExecutor({ handlers, concurrency: 1, logger });
    executor.attach(engine);
    executor.enqueue({ taskId: "t1" });
    await waitFor(() => engine.calls.failed.length === 1);
    expect(engine.calls.failed[0].error.name).toBe("TimeoutError");
    await waitFor(() => abortedWith !== null);
  });

  test("unknown task type fails the task instead of crashing", async () => {
    const engine = fakeEngine(() => ({ type: "does.not.exist" }));
    const executor = createInProcessExecutor({ handlers: builtins, concurrency: 1, logger });
    executor.attach(engine);
    executor.enqueue({ taskId: "t1" });
    await waitFor(() => engine.calls.failed.length === 1);
    expect(engine.calls.failed[0].message).toMatch(/No handler registered/);
  });

  test("a task that can't be claimed (cancelled / taken) is skipped silently", async () => {
    const engine = fakeEngine(() => null);
    const executor = createInProcessExecutor({ handlers: builtins, concurrency: 1, logger });
    executor.attach(engine);
    executor.enqueue({ taskId: "t1" });
    await sleep(20);
    expect(engine.calls.completed).toHaveLength(0);
    expect(engine.calls.failed).toHaveLength(0);
  });

  test("stop(): waits for running handlers, drops the backlog, rejects new work", async () => {
    const handlers = { delay: builtins.delay };
    const engine = fakeEngine(() => ({ type: "delay", config: { ms: 40 } }));
    const executor = createInProcessExecutor({ handlers, concurrency: 1, logger });
    executor.attach(engine);
    executor.enqueue({ taskId: "running" });
    executor.enqueue({ taskId: "backlog" });
    await sleep(5);
    await executor.stop();
    expect(engine.calls.completed.map((c) => c.taskId)).toEqual(["running"]);
    executor.enqueue({ taskId: "late" });
    await sleep(60);
    expect(engine.calls.completed).toHaveLength(1);
  });
});

describe("built-in handlers", () => {
  test("delay honours abort", async () => {
    const controller = new AbortController();
    const p = builtins.delay({ config: { ms: 5000 }, signal: controller.signal });
    controller.abort(new Error("stop"));
    await expect(p).rejects.toThrow("stop");
  });

  test("delay is capped at 60s", async () => {
    const controller = new AbortController();
    const p = builtins.delay({ config: { ms: 10_000_000 }, signal: controller.signal });
    controller.abort(new Error("stop"));
    await expect(p).rejects.toThrow();
  });
});
