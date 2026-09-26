// Bootstrap the FIRST admin (out-of-band: requires server/DB access, not an
// API call — the API never lets a client choose its own role).
//
//   ADMIN_EMAIL=you@example.com ADMIN_PASSWORD='...' npm run create-admin
//
// Credentials come from env vars, NOT argv: command-line arguments are
// visible to other users via `ps` and are saved in shell history.
//
// Idempotent: if the user exists it is promoted to admin (password untouched);
// running it twice is harmless.
import dotenv from "dotenv";
import mongoose from "mongoose";
import { loadConfig } from "../src/config/env.js";
import { createLogger } from "../src/config/logger.js";
import { connectMongo } from "../src/config/mongo.js";
import { User } from "../src/models/user.model.js";
import { hashPassword } from "../src/auth/password.js";
import { registerSchema } from "../src/auth/auth.schemas.js";
import { ROLES } from "../src/auth/permissions.js";

async function main() {
  dotenv.config({ quiet: true });
  const config = loadConfig();
  // pino-pretty is a dev dependency: it doesn't exist in the production image.
  const logger = createLogger({ level: "info", pretty: !config.isProduction });

  const parsed = registerSchema.body.safeParse({
    email: process.env.ADMIN_EMAIL,
    password: process.env.ADMIN_PASSWORD,
  });
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Set ADMIN_EMAIL and ADMIN_PASSWORD (${problems})`);
  }
  const { email, password } = parsed.data;

  await connectMongo(config.mongo.uri, logger);
  try {
    const existing = await User.findOne({ email });
    if (existing) {
      // Bump tokenVersion: old refresh tokens carried the old role.
      await User.updateOne({ _id: existing._id }, { $set: { role: ROLES.ADMIN }, $inc: { tokenVersion: 1 } });
      logger.info({ email }, "existing user promoted to admin");
    } else {
      const passwordHash = await hashPassword(password, config.auth.bcryptCost);
      await User.create({ email, passwordHash, role: ROLES.ADMIN });
      logger.info({ email }, "admin user created");
    }
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((err) => {
  process.stderr.write(`[create-admin] ${err.message}\n`);
  process.exit(1);
});
