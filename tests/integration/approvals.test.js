// Human-in-the-loop, end to end over HTTP with a real worker.  Requires: npm run infra:up
import { connectMongo, disconnectMongo } from "../../src/config/mongo.js";
import { User } from "../../src/models/user.model.js";
import { Workflow } from "../../src/models/workflow.model.js";
import { WorkflowExecution } from "../../src/models/workflowExecution.model.js";
import { Task } from "../../src/models/task.model.js";
import { TaskExecution } from "../../src/models/taskExecution.model.js";
import { ApprovalRequest } from "../../src/models/approval.model.js";
import { MONGO_URI, logger, createTestStack, createUser, as, waitFor } from "../helpers/testApp.js";

const stack = createTestStack();
const { app, engine, worker } = stack;
let alice;
let bob;
let viewer;

const refundFlow = (timeoutMs) => [
  { key: "recommend", type: "echo", config: { action: "refund", amount: 50000, reason: "damaged item" } },
  { key: "approve", type: "human.approval", dependsOn: ["recommend"], config: { title: "Approve ₹50,000 refund?", timeoutMs } },
  { key: "payout", type: "echo", dependsOn: ["approve"] },
];

/** Start a run and wait until it's parked at the approval step. */
async function startAndWait(user = alice, timeoutMs = 3_600_000) {
  const wf = (await as(app, user.token).post("/workflows").send({ name: "refund", tasks: refundFlow(timeoutMs) })).body.workflow;
  const executionId = (await as(app, user.token).post(`/workflows/${wf.id}/run`).send({})).body.execution.id;
  const approval = await waitFor(() => ApprovalRequest.findOne({ executionId }));
  return { executionId, approvalId: String(approval._id) };
}
const state = async (executionId) => {
  const e = await WorkflowExecution.findById(executionId).lean();
  const tasks = Object.fromEntries((await Task.find({ executionId }).lean()).map((t) => [t.key, t.status]));
  return { status: e.status, tasks };
};
const finished = (executionId) =>
  waitFor(async () => {
    const s = await state(executionId);
    return ["COMPLETED", "FAILED", "CANCELLED"].includes(s.status) ? s : null;
  });
const clean = () => Promise.all([User, Workflow, WorkflowExecution, Task, TaskExecution, ApprovalRequest].map((m) => m.deleteMany({})));

beforeAll(async () => {
  await connectMongo(MONGO_URI, logger);
  await clean();
  await ApprovalRequest.init();
  await stack.start();
  [alice, bob, viewer] = await Promise.all([
    createUser("alice@hitl.test", "operator"),
    createUser("bob@hitl.test", "operator"),
    createUser("viewer@hitl.test", "viewer"),
  ]);
});
afterAll(async () => {
  await stack.stop();
  await clean();
  await disconnectMongo();
});

test("the run PARKS at the approval step: no worker is held, the human sees the AI's recommendation", async () => {
  const { executionId, approvalId } = await startAndWait();
  expect(await state(executionId)).toEqual({
    status: "RUNNING",
    tasks: { recommend: "COMPLETED", approve: "WAITING_FOR_APPROVAL", payout: "PENDING" },
  });
  expect(worker.stats().running).toBe(0); // waiting costs no worker

  const res = await as(app, alice.token).get("/approvals?status=PENDING");
  const mine = res.body.approvals.find((a) => a.id === approvalId);
  expect(mine).toMatchObject({ title: "Approve ₹50,000 refund?", status: "PENDING", taskKey: "approve" });
  expect(mine.context.recommend.config).toEqual({ action: "refund", amount: 50000, reason: "damaged item" });
});

test("APPROVE -> the run resumes, the next task gets the decision, the run completes", async () => {
  const { executionId, approvalId } = await startAndWait();
  const res = await as(app, alice.token).post(`/approvals/${approvalId}/approve`).send({ comment: "verified photos" });
  expect(res.status).toBe(200);
  expect(res.body.approval).toMatchObject({ status: "APPROVED", comment: "verified photos", decidedBy: String(alice.user._id) });

  expect(await finished(executionId)).toEqual({ status: "COMPLETED", tasks: { recommend: "COMPLETED", approve: "COMPLETED", payout: "COMPLETED" } });
  const payout = await Task.findOne({ executionId, key: "payout" });
  expect(payout.output.parents.approve).toMatchObject({ approved: true, comment: "verified photos" });
});

test("REJECT -> the approval task fails (no retry), fail-fast cancels the rest", async () => {
  const { executionId, approvalId } = await startAndWait();
  expect((await as(app, alice.token).post(`/approvals/${approvalId}/reject`).send({ comment: "fraud suspected" })).status).toBe(200);
  expect(await finished(executionId)).toEqual({ status: "FAILED", tasks: { recommend: "COMPLETED", approve: "FAILED", payout: "CANCELLED" } });
  const e = await WorkflowExecution.findById(executionId);
  expect(e.error).toBe('Task "approve" failed: Rejected by approver: fraud suspected');
});

test("RACE: 3 approves + 3 rejects at the same moment -> exactly ONE decision wins, the rest get 409", async () => {
  const { executionId, approvalId } = await startAndWait();
  const calls = [..."AAARRR"].map((d) => as(app, alice.token).post(`/approvals/${approvalId}/${d === "A" ? "approve" : "reject"}`).send({}));
  const results = await Promise.all(calls);
  const winners = results.filter((r) => r.status === 200);
  expect(winners).toHaveLength(1);
  expect(results.filter((r) => r.status === 409).every((r) => r.body.error.code === "ALREADY_DECIDED")).toBe(true);

  const winner = winners[0].body.approval.status;
  const final = await finished(executionId);
  expect(final.status).toBe(winner === "APPROVED" ? "COMPLETED" : "FAILED"); // consistent with the winning decision
});

test("TIMEOUT: nobody answers -> the reconciler EXPIRES it, the run fails; a late click gets 409", async () => {
  const { executionId, approvalId } = await startAndWait(alice, 1000);
  await new Promise((r) => setTimeout(r, 1100));
  const counts = await engine.reconcile({ staleMs: 60_000 });
  expect(counts.expiredApprovals).toBe(1);
  expect((await finished(executionId)).status).toBe("FAILED");
  expect((await WorkflowExecution.findById(executionId)).error).toMatch(/Approval timed out/);

  const late = await as(app, alice.token).post(`/approvals/${approvalId}/approve`).send({});
  expect(late.status).toBe(409);
  expect(late.body.error.details.status).toBe("EXPIRED");
});

test("CANCEL while waiting -> the approval is closed; approving afterwards is refused", async () => {
  const { executionId, approvalId } = await startAndWait();
  expect((await as(app, alice.token).post(`/executions/${executionId}/cancel`).send({})).status).toBe(200);
  expect((await ApprovalRequest.findById(approvalId)).status).toBe("CANCELLED");
  expect((await as(app, alice.token).post(`/approvals/${approvalId}/approve`).send({})).status).toBe(409);
  expect((await state(executionId)).status).toBe("CANCELLED");
});

test("authorization: other operator -> 404 (can't even see it); viewer -> 403 (can't decide)", async () => {
  const { approvalId } = await startAndWait();
  expect((await as(app, bob.token).get(`/approvals/${approvalId}`)).status).toBe(404);
  expect((await as(app, bob.token).post(`/approvals/${approvalId}/approve`).send({})).status).toBe(404);
  expect((await as(app, viewer.token).post(`/approvals/${approvalId}/approve`).send({})).status).toBe(403);
  expect((await ApprovalRequest.findById(approvalId)).status).toBe("PENDING");
});
