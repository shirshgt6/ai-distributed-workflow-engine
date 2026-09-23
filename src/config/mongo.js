import mongoose from "mongoose";

/**
 * Connect Mongoose to MongoDB. Throws if the server can't be reached within
 * serverSelectionTimeoutMS — the caller (server.js) treats that as fatal.
 *
 * @param {string} uri
 * @param {import('pino').Logger} logger
 */
export async function connectMongo(uri, logger) {
  // Reject query filters on fields not in the schema instead of silently
  // ignoring them (a typo'd filter field would otherwise match EVERY doc).
  mongoose.set("strictQuery", true);

  const conn = mongoose.connection;
  conn.on("disconnected", () => logger.warn("mongo disconnected"));
  conn.on("reconnected", () => logger.info("mongo reconnected"));
  conn.on("error", (err) => logger.error({ err }, "mongo connection error"));

  await mongoose.connect(uri, { serverSelectionTimeoutMS: 5000 });

  // The workflow engine will rely on multi-document transactions (outbox
  // pattern, Phase 11), which MongoDB only supports on a replica set. Warn
  // loudly now rather than fail mysteriously later.
  const hello = await conn.db.admin().command({ hello: 1 });
  if (!hello.setName) {
    logger.warn("mongo is NOT a replica set member — transactions will be unavailable");
  }

  logger.info({ db: conn.name, replicaSet: hello.setName ?? null }, "mongo connected");
  return conn;
}

/** Readiness probe: a real round-trip, not just "is the socket open". */
export async function pingMongo() {
  if (mongoose.connection.readyState !== 1) {
    throw new Error("mongo not connected");
  }
  await mongoose.connection.db.admin().ping();
}

export async function disconnectMongo() {
  await mongoose.disconnect();
}
