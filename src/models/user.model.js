import mongoose from "mongoose";
import { ROLES } from "../auth/permissions.js";

const userSchema = new mongoose.Schema(
  {
    email: {
      type: String,
      required: true,
      // unique creates a UNIQUE INDEX — this, not an application-level
      // "findOne then create" check, is what makes duplicate registration
      // impossible even when two requests race each other.
      unique: true,
      lowercase: true,
      trim: true,
    },
    // select: false — excluded from every query unless explicitly requested
    // with .select("+passwordHash"). Forgetting to strip it from one
    // response can't leak it if it was never loaded.
    passwordHash: { type: String, required: true, select: false },
    role: {
      type: String,
      enum: Object.values(ROLES),
      // Least privilege by default. Elevated roles are only granted by an
      // admin (PATCH /users/:id/role) or the create-admin script.
      default: ROLES.VIEWER,
    },
    // Revocation counter. Every refresh token embeds the value it was issued
    // with; bumping this invalidates ALL of the user's refresh tokens at once.
    tokenVersion: { type: Number, default: 0 },
  },
  {
    timestamps: true,
    toJSON: {
      // Last line of defence for API responses.
      transform(_doc, ret) {
        ret.id = String(ret._id);
        delete ret._id;
        delete ret.__v;
        delete ret.passwordHash;
        delete ret.tokenVersion;
        return ret;
      },
    },
  }
);

export const User = mongoose.model("User", userSchema);
