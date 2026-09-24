import { hashPassword, verifyPassword } from "../../src/auth/password.js";
import { registerSchema } from "../../src/auth/auth.schemas.js";

const COST = 4; // minimum cost: security-irrelevant in tests, keeps them fast

describe("password hashing", () => {
  test("hash is not the password, embeds cost, and verifies", async () => {
    const hash = await hashPassword("correct horse battery", COST);
    expect(hash).not.toContain("correct horse battery");
    expect(hash).toMatch(/^\$2[aby]\$04\$/);
    await expect(verifyPassword("correct horse battery", hash)).resolves.toBe(true);
    await expect(verifyPassword("wrong horse battery", hash)).resolves.toBe(false);
  });

  test("same password -> different hashes (random salt)", async () => {
    const [a, b] = await Promise.all([hashPassword("123456789", COST), hashPassword("123456789", COST)]);
    expect(a).not.toBe(b);
  });

  test("WHY we cap at 72 bytes: bcrypt ignores everything after byte 72", async () => {
    const prefix = "x".repeat(72);
    const hash = await hashPassword(`${prefix}-first-ending`, COST);
    // A DIFFERENT password is accepted — this is the danger we guard against.
    await expect(verifyPassword(`${prefix}-totally-different`, hash)).resolves.toBe(true);
  });
});

describe("register schema", () => {
  const parse = (body) => registerSchema.body.safeParse(body);

  test("strips fields the client must not set (mass assignment)", () => {
    const result = parse({ email: "a@b.co", password: "12345678", role: "admin", tokenVersion: -1 });
    expect(result.success).toBe(true);
    expect(result.data).toEqual({ email: "a@b.co", password: "12345678" });
  });

  test("normalises email", () => {
    expect(parse({ email: "  Ada@Example.COM ", password: "12345678" }).data.email).toBe("ada@example.com");
  });

  test("rejects short passwords and passwords over 72 BYTES", () => {
    expect(parse({ email: "a@b.co", password: "short" }).success).toBe(false);
    expect(parse({ email: "a@b.co", password: "a".repeat(72) }).success).toBe(true);
    // 37 x "é" = 37 characters but 74 bytes in UTF-8.
    expect(parse({ email: "a@b.co", password: "é".repeat(37) }).success).toBe(false);
  });

  test("rejects invalid email", () => {
    expect(parse({ email: "not-an-email", password: "12345678" }).success).toBe(false);
  });
});
