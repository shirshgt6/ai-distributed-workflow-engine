// Scan every git-tracked (and staged) file for things that look like secrets.
//   npm run check:secrets      (exit 1 if anything is found)
// Patterns + the actual values of secret-looking variables in the local .env,
// so a real key pasted into a tracked file is caught even if it has no known prefix.
import { execSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";

const PATTERNS = [
  [/sk-[A-Za-z0-9_-]{20,}/, "OpenAI-style API key"],
  [/AKIA[0-9A-Z]{16}/, "AWS access key id"],
  [/-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/, "private key"],
  [/ghp_[A-Za-z0-9]{36}/, "GitHub token"],
  [/xox[baprs]-[A-Za-z0-9-]{10,}/, "Slack token"],
  [/mongodb(\+srv)?:\/\/[^\s:@/]+:[^\s@/]+@/, "MongoDB URI with credentials"],
];

const localSecrets = [];
if (existsSync(".env")) {
  for (const line of readFileSync(".env", "utf8").split("\n")) {
    const m = /^([A-Z0-9_]*(SECRET|KEY|TOKEN|PASSWORD)[A-Z0-9_]*)=(.{12,})$/.exec(line.trim());
    if (m) localSecrets.push([m[1], m[3]]);
  }
}

const files = execSync("git ls-files && git diff --cached --name-only", { encoding: "utf8" })
  .split("\n")
  .filter((f) => f && existsSync(f) && !f.endsWith("package-lock.json") && f !== "scripts/check-secrets.js");

const findings = [];
for (const file of new Set(files)) {
  const text = readFileSync(file, "utf8");
  for (const [re, what] of PATTERNS) if (re.test(text)) findings.push(`${file}: ${what}`);
  for (const [name, value] of localSecrets) if (text.includes(value)) findings.push(`${file}: value of ${name} from .env`);
}

if (findings.length) {
  process.stderr.write(`Possible secrets found:\n  ${findings.join("\n  ")}\n`);
  process.exit(1);
}
process.stdout.write(`check:secrets OK (${new Set(files).size} files, ${PATTERNS.length} patterns, ${localSecrets.length} local secret values)\n`);
