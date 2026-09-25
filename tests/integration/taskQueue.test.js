// Requires real Redis:  npm run infra:up
import { randomUUID } from "node:crypto";
import { createRedisClient } from "../../src/config/redis.js";
import { createTaskQueue } from "../../src/queues/taskQueue.js";
import { sleep } from "../../src/handlers/index.js";
import { logger } from "../helpers/testApp.js";

const REDIS_URL = process.env.REDIS_URL_TEST ?? "redis://localhost:6380";
let redis;
let queue;

beforeAll(async () => {
  redis = createRedisClient(REDIS_URL, logger, { name: "test-queue" });
  await redis.connect();
});

beforeEach(() => {
  // A fresh key prefix per test: tests never see each other's data.
  queue = createTaskQueue(redis, { prefix: `test:${randomUUID()}` });
});

afterEach(async () => {
  await redis.del(...Object.values(queue.keys));
});

afterAll(async () => {
  await redis.quit();
});

describe("enqueue / claim / ack", () => {
  test("FIFO order", async () => {
    for (const id of ["t1", "t2", "t3"]) await queue.enqueue(id);
    expect([await queue.claim(5000), await queue.claim(5000), await queue.claim(5000)]).toEqual(["t1", "t2", "t3"]);
    expect(await queue.claim(5000)).toBeNull();
  });

  test("enqueue is idempotent: the same id is never queued twice", async () => {
    expect(await queue.enqueue("t1")).toBe(true);
    expect(await queue.enqueue("t1")).toBe(false);
    expect(await queue.stats()).toMatchObject({ ready: 1 });
  });

  test("a claimed (leased) id can't be re-enqueued until it is acked", async () => {
    await queue.enqueue("t1");
    await queue.claim(5000);
    expect(await queue.enqueue("t1")).toBe(false); // still in the queue, just leased
    expect(await queue.ack("t1")).toBe(true);
    expect(await queue.enqueue("t1")).toBe(true); // gone after ack, can be queued again
  });

  test("claim moves the id to leases ATOMICALLY; ack removes it", async () => {
    await queue.enqueue("t1");
    await queue.claim(5000);
    expect(await queue.stats()).toEqual({ ready: 0, leased: 1, delayed: 0 });
    await queue.ack("t1");
    expect(await queue.stats()).toEqual({ ready: 0, leased: 0, delayed: 0 });
  });

  test("RACE: 50 concurrent claims on 20 tasks -> each task claimed exactly once", async () => {
    const ids = Array.from({ length: 20 }, (_, i) => `t${i}`);
    for (const id of ids) await queue.enqueue(id);
    const claimed = (await Promise.all(Array.from({ length: 50 }, () => queue.claim(5000)))).filter(Boolean);
    expect(claimed.sort()).toEqual([...ids].sort());
    expect(new Set(claimed).size).toBe(20);
  });
});

describe("leases (the Project 1 'pop then crash' bug)", () => {
  test("a worker that claims and then DIES does not lose the task", async () => {
    await queue.enqueue("job-42");
    const claimed = await queue.claim(100); // worker pops job-42 ...
    expect(claimed).toBe("job-42");
    // ... and dies: no ack, no report. In Project 1 the id was simply gone.

    expect(await queue.requeueExpired()).toEqual([]); // lease still valid
    await sleep(150);
    expect(await queue.requeueExpired()).toEqual(["job-42"]); // lease expired -> back in line
    expect(await queue.claim(5000)).toBe("job-42"); // another worker gets it
  });

  test("extendLease keeps a slow-but-alive worker's task from being reaped", async () => {
    await queue.enqueue("t1");
    await queue.claim(100);
    expect(await queue.extendLease("t1", 5000)).toBe(true);
    await sleep(150);
    expect(await queue.requeueExpired()).toEqual([]);
  });

  test("extendLease fails once the lease was reaped (the worker must not assume it still owns it)", async () => {
    await queue.enqueue("t1");
    await queue.claim(50);
    await sleep(80);
    await queue.requeueExpired();
    expect(await queue.extendLease("t1", 5000)).toBe(false);
  });

  test("RACE: concurrent reapers requeue an expired id exactly once", async () => {
    await queue.enqueue("t1");
    await queue.claim(20);
    await sleep(50);
    const results = await Promise.all(Array.from({ length: 5 }, () => queue.requeueExpired()));
    expect(results.flat()).toEqual(["t1"]);
    expect(await queue.stats()).toMatchObject({ ready: 1, leased: 0 });
  });
});

describe("delayed tasks", () => {
  test("become claimable only after their delay", async () => {
    await queue.enqueueDelayed("later", 100);
    expect(await queue.promoteDue()).toEqual([]);
    expect(await queue.claim(5000)).toBeNull();
    await sleep(150);
    expect(await queue.promoteDue()).toEqual(["later"]);
    expect(await queue.claim(5000)).toBe("later");
  });

  test("RACE: concurrent promoters move a due id exactly once", async () => {
    await queue.enqueueDelayed("d1", 0);
    const results = await Promise.all(Array.from({ length: 5 }, () => queue.promoteDue()));
    expect(results.flat()).toEqual(["d1"]);
    expect(await queue.stats()).toMatchObject({ ready: 1, delayed: 0 });
  });

  test("REGRESSION: a failing task's retry survives the worker's ack (leased -> delayed)", async () => {
    await queue.enqueue("t1");
    await queue.claim(5000); // worker holds the lease
    expect(await queue.enqueueDelayed("t1", 0)).toBe(true); // engine schedules the retry
    expect(await queue.ack("t1")).toBe(false); // worker acks after reporting: lease already moved
    expect(await queue.promoteDue()).toEqual(["t1"]);
    expect(await queue.claim(5000)).toBe("t1"); // the retry really happens
  });

  test("ack after the lease was reaped leaves the requeued entry alone", async () => {
    await queue.enqueue("t1");
    await queue.claim(10);
    await sleep(30);
    await queue.requeueExpired(); // back in ready
    expect(await queue.ack("t1")).toBe(false); // the slow original worker finally acks
    expect(await queue.enqueue("t1")).toBe(false); // still a member: no duplicate can be added
    expect(await queue.claim(5000)).toBe("t1");
  });

  test("delayed enqueue is deduplicated with the ready list", async () => {
    await queue.enqueue("t1");
    expect(await queue.enqueueDelayed("t1", 0)).toBe(false);
  });
});
