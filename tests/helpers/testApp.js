// Shared setup for integration tests: a fully wired app (real Mongo, fake
// secrets, low bcrypt cost) plus helpers to create users with a given role.
import request from "supertest";
import { createApp } from "../../src/app.js";
import { createLogger } from "../../src/config/logger.js";
import { createTokenService } from "../../src/auth/tokens.js";
import { createAuthService } from "../../src/services/auth.service.js";
import { createWorkflowService } from "../../src/services/workflow.service.js";
import { hashPassword } from "../../src/auth/password.js";
import { User } from "../../src/models/user.model.js";
import { Workflow } from "../../src/models/workflow.model.js";

export const MONGO_URI =
  process.env.MONGO_URI_TEST ?? "mongodb://localhost:27018/workflow_engine_test?directConnection=true";
export const PASSWORD = "s3cure-enough-pass";
const BCRYPT_COST = 4;

export const logger = createLogger({ level: "silent" });
export const tokens = createTokenService({
  accessSecret: "integration-access-secret-0123456789abcdef",
  refreshSecret: "integration-refresh-secret-0123456789abcdef",
  accessTtl: "15m",
  refreshTtl: "7d",
});

export function createTestApp() {
  const authService = createAuthService({ User, tokens, bcryptCost: BCRYPT_COST });
  const workflowService = createWorkflowService({ Workflow });
  return createApp({ logger, auth: { authService, tokens }, workflowService });
}

/** Creates a user directly in the DB and returns { user, token }. */
export async function createUser(email, role) {
  const passwordHash = await hashPassword(PASSWORD, BCRYPT_COST);
  const user = await User.create({ email, passwordHash, role });
  return { user, token: tokens.signAccessToken(user) };
}

/** Supertest request with a Bearer token attached. */
export function as(app, token) {
  const withAuth = (req) => req.set("Authorization", `Bearer ${token}`);
  return {
    get: (url) => withAuth(request(app).get(url)),
    post: (url) => withAuth(request(app).post(url)),
    put: (url) => withAuth(request(app).put(url)),
    patch: (url) => withAuth(request(app).patch(url)),
  };
}
