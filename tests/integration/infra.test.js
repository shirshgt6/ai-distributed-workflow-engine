// Requires real infrastructure:  npm run infra:up
import request from "supertest";
import { createApp } from "../../src/app.js";
import { createLogger } from "../../src/config/logger.js";
import { connectMongo, disconnectMongo, pingMongo } from "../../src/config/mongo.js";
import { createRedisClient, pingRedis } from "../../src/config/redis.js";

const MONGO_URI = process.env.MONGO_URI ?? "mongodb://localhost:27018/workflow_engine_test?directConnection=true";
const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6380";

const logger = createLogger({ level: "silent" });
let redis;
let conn;

beforeAll(async () => {
  conn = await connectMongo(MONGO_URI, logger);
  redis = createRedisClient(REDIS_URL, logger, { name: "test" });
  await redis.connect();
});

afterAll(async () => {
  await disconnectMongo();
  await redis.quit();
});

test("Mongo is a replica set primary (required for transactions later)", async () => {
  const hello = await conn.db.admin().command({ hello: 1 });
  expect(hello.setName).toBe("rs0");
  expect(hello.isWritablePrimary).toBe(true);
});

test("Redis will not evict keys under memory pressure (queues must not lose data)", async () => {
  const [, policy] = await redis.config("GET", "maxmemory-policy");
  expect(policy).toBe("noeviction");
});

test("GET /ready is 200 against real Mongo + Redis", async () => {
  const app = createApp({
    logger,
    checks: { mongo: pingMongo, redis: () => pingRedis(redis) },
  });
  const res = await request(app).get("/ready");
  expect(res.status).toBe(200);
  expect(res.body.checks.mongo.status).toBe("up");
  expect(res.body.checks.redis.status).toBe("up");
});
