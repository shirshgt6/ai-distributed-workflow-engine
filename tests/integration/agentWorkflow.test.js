// ai.agent inside real workflow runs, with REAL tools (MongoDB, Qdrant) and a scripted LLM.
import { connectMongo, disconnectMongo } from "../../src/config/mongo.js";
import { User } from "../../src/models/user.model.js";
import { Workflow } from "../../src/models/workflow.model.js";
import { WorkflowExecution } from "../../src/models/workflowExecution.model.js";
import { Task } from "../../src/models/task.model.js";
import { TaskExecution } from "../../src/models/taskExecution.model.js";
import { KnowledgeDocument, KnowledgeChunk } from "../../src/models/knowledge.model.js";
import { createMockProvider } from "../../src/ai/providers/mock.js";
import { MONGO_URI, logger, createTestStack, createUser, as, waitFor } from "../helpers/testApp.js";

let nextSteps = []; // what the scripted agent does, in order
const llm = createMockProvider({
  respond: () => JSON.stringify(nextSteps.shift() ?? { action: "final", answer: "done" }),
});
const stack = createTestStack({ llm });
const { app } = stack;
let alice;
let bob;

async function runAgentTask(user, text, config = {}) {
  const wf = (await as(app, user.token).post("/workflows").send({ name: "agent", tasks: [{ key: "agent", type: "ai.agent", config }] })).body.workflow;
  const id = (await as(app, user.token).post(`/workflows/${wf.id}/run`).send({ input: { text } })).body.execution.id;
  return waitFor(async () => {
    const b = (await as(app, user.token).get(`/executions/${id}`)).body;
    return ["COMPLETED", "FAILED"].includes(b.execution.status) ? b : null;
  });
}
const clean = () => Promise.all([User, Workflow, WorkflowExecution, Task, TaskExecution, KnowledgeDocument, KnowledgeChunk].map((m) => m.deleteMany({})));

beforeAll(async () => {
  await connectMongo(MONGO_URI, logger);
  await clean();
  await stack.start();
  [alice, bob] = await Promise.all([createUser("alice@agent.test", "operator"), createUser("bob@agent.test", "operator")]);
});
afterAll(async () => {
  await stack.stop();
  await clean();
  await disconnectMongo();
});

test("agent looks up the status of the owner's own execution, then answers", async () => {
  const target = (await as(app, alice.token).post("/workflows").send({ name: "t", tasks: [{ key: "A", type: "noop" }] })).body.workflow;
  const targetRun = (await as(app, alice.token).post(`/workflows/${target.id}/run`).send({})).body.execution.id;
  await waitFor(async () => (await WorkflowExecution.findById(targetRun))?.status === "COMPLETED");

  nextSteps = [
    { action: "tool", tool: "get_workflow_status", args: { executionId: targetRun } },
    { action: "final", answer: `Execution ${targetRun} is COMPLETED.` },
  ];
  const { execution, tasks } = await runAgentTask(alice, `What is the status of execution ${targetRun}?`);
  expect(execution.status).toBe("COMPLETED");
  const out = tasks[0].output;
  expect(out.answer).toContain("COMPLETED");
  expect(out.steps[0]).toMatchObject({ tool: "get_workflow_status", ok: true });
  expect(out.steps[0].observation).toContain('"status":"COMPLETED"');
});

test("SCOPE: Bob's agent asking for Alice's execution gets 'not found' (ownerId from the task, not the model)", async () => {
  const aliceRun = await WorkflowExecution.findOne({ ownerId: alice.user._id });
  nextSteps = [
    { action: "tool", tool: "get_workflow_status", args: { executionId: String(aliceRun._id) } },
    { action: "final", answer: "I couldn't find it." },
  ];
  const { tasks } = await runAgentTask(bob, "status please");
  expect(tasks[0].output.steps[0]).toMatchObject({ ok: false });
  expect(tasks[0].output.steps[0].observation).toContain("execution not found");
});

test("task allowlist: an agent limited to the calculator can't use other tools", async () => {
  nextSteps = [
    { action: "tool", tool: "get_workflow_status", args: { executionId: "652f1c2b9d1e8a0012345678" } }, // not allowed -> schema rejects
    { action: "tool", tool: "calculator", args: { expression: "7 * 6" } },
    { action: "final", answer: "42" },
  ];
  const { tasks } = await runAgentTask(alice, "compute 7*6", { tools: ["calculator"] });
  const out = tasks[0].output;
  expect(out.answer).toBe("42");
  expect(out.steps.filter((s) => s.type === "tool").map((s) => s.tool)).toEqual(["calculator"]);
});

test("an agent that never finishes FAILS the task (no retry) instead of looping forever", async () => {
  nextSteps = Array.from({ length: 20 }, (_, i) => ({ action: "tool", tool: "calculator", args: { expression: `${i} + 1` } }));
  const { execution, tasks } = await runAgentTask(alice, "loop", { maxIterations: 2 });
  expect(execution.status).toBe("FAILED");
  expect(tasks[0]).toMatchObject({ status: "FAILED", attempt: 1 });
  expect(tasks[0].error).toMatch(/max_iterations/);
  nextSteps = [];
});

test("unknown tool in the task config fails clearly", async () => {
  const { tasks } = await runAgentTask(alice, "x", { tools: ["shell"] });
  expect(tasks[0].error).toMatch(/Unknown agent tool\(s\): shell/);
});
