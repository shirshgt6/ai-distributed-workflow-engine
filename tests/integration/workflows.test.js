// Requires real infrastructure:  npm run infra:up
import request from "supertest";
import mongoose from "mongoose";
import { connectMongo, disconnectMongo } from "../../src/config/mongo.js";
import { User } from "../../src/models/user.model.js";
import { Workflow } from "../../src/models/workflow.model.js";
import { MONGO_URI, logger, createTestApp, createUser, as } from "../helpers/testApp.js";

const app = createTestApp();

const diamond = {
  name: "Diamond",
  description: "A -> (B, C) -> D",
  tasks: [
    { key: "A", type: "noop" },
    { key: "B", type: "noop", dependsOn: ["A"] },
    { key: "C", type: "noop", dependsOn: ["A"] },
    { key: "D", type: "noop", dependsOn: ["B", "C"] },
  ],
};

let admin;
let alice; // operator
let bob; // operator
let victor; // viewer

beforeAll(async () => {
  await connectMongo(MONGO_URI, logger);
  await Promise.all([User.deleteMany({}), Workflow.deleteMany({})]);
  await User.init();
  [admin, alice, bob, victor] = await Promise.all([
    createUser("admin@wf.test", "admin"),
    createUser("alice@wf.test", "operator"),
    createUser("bob@wf.test", "operator"),
    createUser("victor@wf.test", "viewer"),
  ]);
});

afterAll(async () => {
  await Promise.all([User.deleteMany({}), Workflow.deleteMany({})]);
  await disconnectMongo();
});

describe("POST /workflows", () => {
  test("anonymous -> 401", async () => {
    expect((await request(app).post("/workflows").send(diamond)).status).toBe(401);
  });

  test("viewer -> 403 (RBAC: action level)", async () => {
    expect((await as(app, victor.token).post("/workflows").send(diamond)).status).toBe(403);
  });

  test("operator -> 201, owner taken from the token (not the body), version 1", async () => {
    const res = await as(app, alice.token)
      .post("/workflows")
      .send({ ...diamond, ownerId: String(bob.user._id), version: 42 });
    expect(res.status).toBe(201);
    expect(res.headers.location).toBe(`/workflows/${res.body.workflow.id}`);
    expect(res.body.workflow).toMatchObject({ name: "Diamond", version: 1, ownerId: String(alice.user._id) });
    expect(res.body.workflow.tasks).toHaveLength(4);
    expect(res.body.workflow.tasks[3]).toMatchObject({ key: "D", dependsOn: ["B", "C"], timeoutMs: 30000 });
  });

  test("400 with field details for a bad body", async () => {
    const res = await as(app, alice.token).post("/workflows").send({ name: "", tasks: [] });
    expect(res.status).toBe(400);
    expect(res.body.error.details.map((d) => d.path).sort()).toEqual(["name", "tasks"]);
  });
});

describe("ownership (object-level authorization)", () => {
  let aliceWf;

  beforeAll(async () => {
    aliceWf = (await as(app, alice.token).post("/workflows").send({ ...diamond, name: "Alice private" })).body.workflow;
  });

  test("owner can read it", async () => {
    const res = await as(app, alice.token).get(`/workflows/${aliceWf.id}`);
    expect(res.status).toBe(200);
    expect(res.body.workflow.name).toBe("Alice private");
  });

  test("another operator gets 404 — identical to a truly missing id (no existence leak)", async () => {
    const foreign = await as(app, bob.token).get(`/workflows/${aliceWf.id}`);
    const missing = await as(app, bob.token).get(`/workflows/${new mongoose.Types.ObjectId()}`);
    expect(foreign.status).toBe(404);
    expect(missing.status).toBe(404);
    const strip = ({ error: { requestId: _requestId, ...rest } }) => rest;
    expect(strip(foreign.body)).toEqual(strip(missing.body));
  });

  test("another operator cannot UPDATE it either (404)", async () => {
    const res = await as(app, bob.token)
      .put(`/workflows/${aliceWf.id}`)
      .send({ ...diamond, name: "hijacked", version: 1 });
    expect(res.status).toBe(404);
    expect((await Workflow.findById(aliceWf.id)).name).toBe("Alice private");
  });

  test("admin can read anyone's workflow", async () => {
    expect((await as(app, admin.token).get(`/workflows/${aliceWf.id}`)).status).toBe(200);
  });

  test("list is scoped: bob never sees alice's workflows; admin sees all", async () => {
    await as(app, bob.token).post("/workflows").send({ ...diamond, name: "Bob's" });
    const bobList = (await as(app, bob.token).get("/workflows")).body;
    expect(bobList.items.every((w) => w.ownerId === String(bob.user._id))).toBe(true);
    expect(bobList.items.map((w) => w.name)).toContain("Bob's");

    const adminList = (await as(app, admin.token).get("/workflows")).body;
    expect(adminList.total).toBe(await Workflow.countDocuments({}));
  });

  test("400 for a malformed id (before any DB query)", async () => {
    expect((await as(app, alice.token).get("/workflows/not-an-id")).status).toBe(400);
  });
});

describe("pagination", () => {
  test("limit/page are applied and bounded", async () => {
    const res = await as(app, admin.token).get("/workflows?limit=1&page=1");
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body).toMatchObject({ page: 1, limit: 1 });
    expect((await as(app, admin.token).get("/workflows?limit=1000")).status).toBe(400);
  });
});

describe("PUT /workflows/:id — optimistic concurrency", () => {
  let wf;

  beforeEach(async () => {
    wf = (await as(app, alice.token).post("/workflows").send(diamond)).body.workflow;
  });

  test("update with the current version -> 200 and version bumps", async () => {
    const res = await as(app, alice.token)
      .put(`/workflows/${wf.id}`)
      .send({ ...diamond, name: "Renamed", version: 1 });
    expect(res.status).toBe(200);
    expect(res.body.workflow).toMatchObject({ name: "Renamed", version: 2 });
  });

  test("stale version -> 409 VERSION_CONFLICT with the current version", async () => {
    await as(app, alice.token).put(`/workflows/${wf.id}`).send({ ...diamond, version: 1 });
    const res = await as(app, alice.token).put(`/workflows/${wf.id}`).send({ ...diamond, name: "late", version: 1 });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({ code: "VERSION_CONFLICT", details: { currentVersion: 2 } });
  });

  test("RACE: 5 simultaneous edits of version 1 -> exactly one wins, no lost update", async () => {
    const edits = Array.from({ length: 5 }, (_, i) =>
      as(app, alice.token)
        .put(`/workflows/${wf.id}`)
        .send({ ...diamond, name: `edit-${i}`, version: 1 })
    );
    const results = await Promise.all(edits);
    const winners = results.filter((r) => r.status === 200);
    expect(winners).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(4);

    const stored = await Workflow.findById(wf.id);
    expect(stored.version).toBe(2); // bumped exactly once
    expect(stored.name).toBe(winners[0].body.workflow.name); // the winner's edit is what's stored
  });
});
