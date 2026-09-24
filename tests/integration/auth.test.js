// Requires real infrastructure:  npm run infra:up
import request from "supertest";
import mongoose from "mongoose";
import { createApp } from "../../src/app.js";
import { createLogger } from "../../src/config/logger.js";
import { connectMongo, disconnectMongo } from "../../src/config/mongo.js";
import { createTokenService } from "../../src/auth/tokens.js";
import { createAuthService } from "../../src/services/auth.service.js";
import { hashPassword } from "../../src/auth/password.js";
import { User } from "../../src/models/user.model.js";

const MONGO_URI =
  process.env.MONGO_URI_TEST ?? "mongodb://localhost:27018/workflow_engine_test?directConnection=true";
const BCRYPT_COST = 4;

const logger = createLogger({ level: "silent" });
const tokens = createTokenService({
  accessSecret: "integration-access-secret-0123456789abcdef",
  refreshSecret: "integration-refresh-secret-0123456789abcdef",
  accessTtl: "15m",
  refreshTtl: "7d",
});
const authService = createAuthService({ User, tokens, bcryptCost: BCRYPT_COST });
const app = createApp({ logger, auth: { authService, tokens } });

const PASSWORD = "s3cure-enough-pass";

async function register(email, extra = {}) {
  return request(app).post("/auth/register").send({ email, password: PASSWORD, ...extra });
}
async function login(email, password = PASSWORD) {
  return request(app).post("/auth/login").send({ email, password });
}
async function createUserWithRole(email, role) {
  const passwordHash = await hashPassword(PASSWORD, BCRYPT_COST);
  return User.create({ email, passwordHash, role });
}

beforeAll(async () => {
  await connectMongo(MONGO_URI, logger);
  await User.deleteMany({});
  await User.init(); // make sure the unique index on email exists before race tests
});

afterAll(async () => {
  await User.deleteMany({});
  await disconnectMongo();
});

describe("POST /auth/register", () => {
  test("201, user is a VIEWER even if the body asks for admin (mass assignment)", async () => {
    const res = await register("mallory@example.com", { role: "admin" });
    expect(res.status).toBe(201);
    expect(res.body.user).toMatchObject({ email: "mallory@example.com", role: "viewer" });
    const stored = await User.findOne({ email: "mallory@example.com" });
    expect(stored.role).toBe("viewer");
  });

  test("response never contains the password hash or tokenVersion", async () => {
    const res = await register("safe@example.com");
    expect(res.body.user.passwordHash).toBeUndefined();
    expect(res.body.user.tokenVersion).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toContain(PASSWORD);
  });

  test("400 with details for invalid input", async () => {
    const res = await request(app).post("/auth/register").send({ email: "nope", password: "short" });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
    expect(res.body.error.details.map((d) => d.path).sort()).toEqual(["email", "password"]);
  });

  test("409 for a duplicate email (case-insensitive)", async () => {
    await register("dup@example.com");
    const res = await register("DUP@example.com");
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("EMAIL_TAKEN");
  });

  test("RACE: 10 simultaneous registrations of one email -> exactly one succeeds", async () => {
    const results = await Promise.all(Array.from({ length: 10 }, () => register("race@example.com")));
    const statuses = results.map((r) => r.status).sort();
    expect(statuses.filter((s) => s === 201)).toHaveLength(1);
    expect(statuses.filter((s) => s === 409)).toHaveLength(9);
    expect(await User.countDocuments({ email: "race@example.com" })).toBe(1);
  });
});

describe("POST /auth/login", () => {
  beforeAll(() => register("login@example.com"));

  test("200 with access + refresh tokens", async () => {
    const res = await login("login@example.com");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ tokenType: "Bearer", expiresIn: "15m" });
    expect(res.body.accessToken).toBeTruthy();
    expect(res.body.refreshToken).toBeTruthy();
  });

  test("unknown email and wrong password give the SAME response (no enumeration)", async () => {
    const wrongPassword = await login("login@example.com", "not-the-password");
    const unknownEmail = await login("ghost@example.com", "not-the-password");
    expect(wrongPassword.status).toBe(401);
    expect(unknownEmail.status).toBe(401);
    const strip = ({ error: { requestId: _requestId, ...rest } }) => rest;
    expect(strip(unknownEmail.body)).toEqual(strip(wrongPassword.body));
  });
});

describe("authenticated routes", () => {
  let accessToken;
  let refreshToken;

  beforeAll(async () => {
    await register("me@example.com");
    ({ accessToken, refreshToken } = (await login("me@example.com")).body);
  });

  test("GET /auth/me without a token -> 401 + WWW-Authenticate", async () => {
    const res = await request(app).get("/auth/me");
    expect(res.status).toBe(401);
    expect(res.headers["www-authenticate"]).toBe("Bearer");
  });

  test("GET /auth/me with a token -> current user", async () => {
    const res = await request(app).get("/auth/me").set("Authorization", `Bearer ${accessToken}`);
    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe("me@example.com");
  });

  test("refresh token cannot be used as an access token", async () => {
    const res = await request(app).get("/auth/me").set("Authorization", `Bearer ${refreshToken}`);
    expect(res.status).toBe(401);
  });

  test("refresh -> new working token pair", async () => {
    const res = await request(app).post("/auth/refresh").send({ refreshToken });
    expect(res.status).toBe(200);
    const me = await request(app).get("/auth/me").set("Authorization", `Bearer ${res.body.accessToken}`);
    expect(me.status).toBe(200);
  });

  test("logout revokes EVERY refresh token of the user (a stolen one too)", async () => {
    const stolen = (await login("me@example.com")).body.refreshToken;

    const out = await request(app).post("/auth/logout").set("Authorization", `Bearer ${accessToken}`);
    expect(out.status).toBe(204);

    for (const token of [refreshToken, stolen]) {
      const res = await request(app).post("/auth/refresh").send({ refreshToken: token });
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe("TOKEN_REVOKED");
    }
  });
});

describe("RBAC: PATCH /users/:id/role", () => {
  let admin;
  let operator;
  let target;

  beforeAll(async () => {
    admin = await createUserWithRole("admin@example.com", "admin");
    operator = await createUserWithRole("op@example.com", "operator");
    target = await createUserWithRole("target@example.com", "viewer");
  });

  const tokenFor = async (email) => (await login(email)).body.accessToken;
  const changeRole = (token, id, role) =>
    request(app).patch(`/users/${id}/role`).set("Authorization", `Bearer ${token}`).send({ role });

  test("anonymous -> 401", async () => {
    const res = await request(app).patch(`/users/${target._id}/role`).send({ role: "admin" });
    expect(res.status).toBe(401);
  });

  test("operator -> 403 (cannot escalate anyone, including themselves)", async () => {
    const token = await tokenFor("op@example.com");
    expect((await changeRole(token, target._id, "admin")).status).toBe(403);
    expect((await changeRole(token, operator._id, "admin")).status).toBe(403);
  });

  test("admin -> 200, and the target's old refresh tokens stop working", async () => {
    const oldRefresh = (await login("target@example.com")).body.refreshToken;
    const res = await changeRole(await tokenFor("admin@example.com"), target._id, "operator");
    expect(res.status).toBe(200);
    expect(res.body.user.role).toBe("operator");

    const refreshed = await request(app).post("/auth/refresh").send({ refreshToken: oldRefresh });
    expect(refreshed.status).toBe(401);

    const newLogin = await login("target@example.com");
    expect(tokens.verifyAccessToken(newLogin.body.accessToken).role).toBe("operator");
  });

  test("admin cannot change their own role", async () => {
    const res = await changeRole(await tokenFor("admin@example.com"), admin._id, "viewer");
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("SELF_ROLE_CHANGE");
  });

  test("400 for invalid role or id; 404 for unknown user", async () => {
    const token = await tokenFor("admin@example.com");
    expect((await changeRole(token, target._id, "superuser")).status).toBe(400);
    expect((await changeRole(token, "not-an-id", "viewer")).status).toBe(400);
    expect((await changeRole(token, new mongoose.Types.ObjectId(), "viewer")).status).toBe(404);
  });
});
