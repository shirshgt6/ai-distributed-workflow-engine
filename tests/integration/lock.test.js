// Requires real Redis:  npm run infra:up
import { randomUUID } from "node:crypto";
import { createRedisClient } from "../../src/config/redis.js";
import { createLock } from "../../src/queues/lock.js";
import { sleep } from "../../src/handlers/index.js";
import { logger, REDIS_URL } from "../helpers/testApp.js";

let redis;
let lock;

beforeAll(async () => {
  redis = createRedisClient(REDIS_URL, logger, { name: "test-lock" });
  await redis.connect();
});
beforeEach(() => {
  lock = createLock(redis, `test-${randomUUID()}`, { ttlMs: 100 });
});
afterEach(async () => {
  await redis.del(lock.key, `${lock.key}:fence`);
});
afterAll(async () => {
  await redis.quit();
});

test("RACE: 10 contenders -> exactly one holder", async () => {
  const results = await Promise.all(Array.from({ length: 10 }, () => lock.acquire()));
  expect(results.filter(Boolean)).toHaveLength(1);
});

test("release only works with the holder's token", async () => {
  const held = await lock.acquire();
  expect(await lock.release("someone-elses-token")).toBe(false);
  expect(await lock.acquire()).toBeNull(); // still held
  expect(await lock.release(held.token)).toBe(true);
  expect(await lock.acquire()).not.toBeNull();
});

test("a crashed holder's lock frees itself after the TTL (no deadlock)", async () => {
  await lock.acquire(); // ...and never releases
  await sleep(150);
  expect(await lock.acquire()).not.toBeNull();
});

test("a STALE holder cannot release or extend the NEW holder's lock", async () => {
  const old = await lock.acquire();
  await sleep(150); // old holder paused past the TTL
  const fresh = await lock.acquire();
  expect(await lock.release(old.token)).toBe(false); // would have deleted the new lock with plain DEL
  expect(await lock.extend(old.token)).toBe(false);
  expect(await lock.extend(fresh.token)).toBe(true);
});

test("fencing tokens strictly increase across acquisitions", async () => {
  const a = await lock.acquire();
  await lock.release(a.token);
  const b = await lock.acquire();
  expect(b.fence).toBeGreaterThan(a.fence);
});
