import { z } from "zod";
import mongoose from "mongoose";
import { ROLES } from "./permissions.js";
import { BCRYPT_MAX_BYTES } from "./password.js";

// These schemas are ALLOWLISTS. z.object() drops any key it doesn't declare,
// so `{ email, password, role: "admin" }` parses to `{ email, password }`.
// That is the mass-assignment defence: the client can only ever set the
// fields listed here.

const email = z.string().trim().toLowerCase().pipe(z.email().max(254));

const password = z
  .string()
  .min(8, "must be at least 8 characters")
  .refine((p) => Buffer.byteLength(p, "utf8") <= BCRYPT_MAX_BYTES, {
    message: `must be at most ${BCRYPT_MAX_BYTES} bytes`,
  });

export const registerSchema = { body: z.object({ email, password }) };

// Login does NOT apply password rules: rejecting a login with "too short"
// would leak policy details and break logins after a policy change.
export const loginSchema = {
  body: z.object({ email, password: z.string().min(1).max(1024) }),
};

export const refreshSchema = { body: z.object({ refreshToken: z.string().min(1).max(4096) }) };

const objectId = z.string().refine((v) => mongoose.isValidObjectId(v), { message: "must be a valid id" });

export const changeRoleSchema = {
  params: z.object({ id: objectId }),
  body: z.object({ role: z.enum(Object.values(ROLES)) }),
};
