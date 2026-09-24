import { z } from "zod";
import mongoose from "mongoose";

// SHAPE validation only (Phase 3): types, lengths, formats, limits.
// GRAPH validation — unknown dependencies, duplicate keys, cycles — is
// Phase 4 (src/workflow/dag.js), deliberately kept separate: shape rules are
// per-field, graph rules need the whole task list at once.

// Limits exist so one request can't create an unbounded amount of work.
export const LIMITS = Object.freeze({
  MAX_TASKS: 100,
  MAX_DEPENDENCIES: 50,
  MAX_ATTEMPTS: 10,
  MIN_TIMEOUT_MS: 100,
  MAX_TIMEOUT_MS: 60 * 60 * 1000, // 1 hour
});

const taskKey = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,64}$/, "must be 1-64 chars: letters, digits, _ or -");

const taskDefinition = z.object({
  key: taskKey,
  name: z.string().trim().max(100).optional(),
  // e.g. "http.request", "ai.classify". Which types actually exist is
  // decided by the handler registry (Phase 7).
  type: z.string().regex(/^[a-z][a-z0-9._-]{0,63}$/, "must be lowercase, e.g. http.request"),
  dependsOn: z.array(taskKey).max(LIMITS.MAX_DEPENDENCIES).default([]),
  config: z.record(z.string(), z.unknown()).default({}),
  retryPolicy: z
    .object({
      maxAttempts: z.number().int().min(1).max(LIMITS.MAX_ATTEMPTS).default(3),
      baseDelayMs: z.number().int().min(0).max(60_000).default(1000),
    })
    .default({ maxAttempts: 3, baseDelayMs: 1000 }),
  timeoutMs: z.number().int().min(LIMITS.MIN_TIMEOUT_MS).max(LIMITS.MAX_TIMEOUT_MS).default(30_000),
});

const workflowBody = {
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().max(1000).default(""),
  tasks: z.array(taskDefinition).min(1).max(LIMITS.MAX_TASKS),
};

const objectId = z.string().refine((v) => mongoose.isValidObjectId(v), { message: "must be a valid id" });

export const createWorkflowSchema = { body: z.object(workflowBody) };

export const updateWorkflowSchema = {
  params: z.object({ id: objectId }),
  body: z.object({
    ...workflowBody,
    // Required: "I am editing version N". Mismatch -> 409 (optimistic concurrency).
    version: z.number().int().min(1),
  }),
};

export const workflowIdSchema = { params: z.object({ id: objectId }) };

export const listWorkflowsSchema = {
  query: z.object({
    limit: z.coerce.number().int().min(1).max(100).default(20),
    page: z.coerce.number().int().min(1).max(10_000).default(1),
  }),
};
