// Kiro Stop hook (.kiro/hooks/turn-check.json). After each agent turn it type-checks the project
// and runs the Vitest tests related to the TypeScript files under src/ that are changed or new in
// the working tree. A failure goes back to the agent for one more turn; after two failed checks in
// one session it stops asking and leaves the change to the maintainer. No network, no AI calls.
// Full output: logs/kiro-hook/ (ignored by git).
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const logDir = path.join(root, "logs", "kiro-hook");
fs.mkdirSync(logDir, { recursive: true });

let event = {};
try {
  const raw = fs.readFileSync(0, "utf8");
  event = raw.trim() ? JSON.parse(raw) : {};
} catch {
  event = {};
}
const session =
  String(event.session_id ?? event.sessionId ?? "no-session")
    .replace(/[^A-Za-z0-9_-]/g, "_")
    .slice(0, 80) || "no-session";
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const logFile = path.join(logDir, `${stamp}-${session}.log`);
const logPath = path.relative(root, logFile).split(path.sep).join("/");
const log = (text) => fs.appendFileSync(logFile, `${text}\n`);
log(`event fields: ${Object.keys(event).sort().join(", ") || "(none)"}`);

const gitLines = (args) =>
  (spawnSync("git", args, { cwd: root, encoding: "utf8" }).stdout ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
const changed = [
  ...new Set([
    ...gitLines(["diff", "--name-only", "HEAD"]),
    ...gitLines(["ls-files", "--others", "--exclude-standard"]),
  ]),
]
  .filter((file) => /^src\/.+\.tsx?$/.test(file) && fs.existsSync(path.join(root, file)))
  .sort();
log(`changed: ${changed.join(" ") || "(none)"}`);
if (changed.length === 0) process.exit(0);

const failFile = path.join(logDir, `${session}.failures`);
const failures = fs.existsSync(failFile) ? Number(fs.readFileSync(failFile, "utf8")) || 0 : 0;
if (failures >= 2) {
  log("stopped: this session already failed the check twice; the maintainer reviews the change");
  process.exit(0);
}

// No reader key reaches a test run, so a test can never call a paid AI reader.
const env = { ...process.env };
for (const name of [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "DOCUMENT_INTAKE_ANTHROPIC_KEY",
  "GEMINI_API_KEY",
]) {
  delete env[name];
}
const run = (label, args, timeout) => {
  const result = spawnSync(process.execPath, args, {
    cwd: root,
    env,
    encoding: "utf8",
    timeout,
    maxBuffer: 64 * 1024 * 1024,
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.replace(/\x1b\[[0-9;]*m/g, "");
  const status = result.error
    ? `did not finish (${result.error.code ?? result.error.message})`
    : `exit ${result.status}`;
  log(`--- ${label}: ${status}\n${output}`);
  return { ok: !result.error && result.status === 0, finished: !result.error, output, status };
};
const typeCheck = run(
  "tsc --noEmit",
  [path.join("node_modules", "typescript", "bin", "tsc"), "--noEmit"],
  150000,
);
const tests = run(
  `vitest related --run --no-file-parallelism ${changed.join(" ")}`,
  [path.join("node_modules", "vitest", "vitest.mjs"), "related", "--run", "--no-file-parallelism", ...changed],
  360000,
);
if (typeCheck.ok && tests.ok) {
  log("passed");
  process.exit(0);
}
if (!typeCheck.finished || !tests.finished) {
  log("not decided: a check did not finish; the maintainer runs the checks");
  process.exit(0);
}

fs.writeFileSync(failFile, String(failures + 1));
const lines = [];
if (!typeCheck.ok) {
  lines.push(
    `Type check: ${typeCheck.status}`,
    ...typeCheck.output.split(/\r?\n/).filter((line) => line.includes("error TS")),
  );
}
if (!tests.ok) {
  lines.push(
    `Related tests: ${tests.status}`,
    ...tests.output
      .split(/\r?\n/)
      .filter((line) =>
        /FAIL|×|AssertionError|Error:|Expected|Received|Counterexample|Property failed|Test Files|Tests /.test(line),
      ),
  );
}
const reason = [
  `The turn check failed (${failures + 1} of 2). If this request asked for tests that fail on the current code, these may be the expected failures: do not change or delete those tests; say which ones fail and stop. Otherwise fix the cause with the smallest change in the files of this request, then stop. Full output: ${logPath}`,
  ...lines.slice(0, 40),
].join("\n");
process.stdout.write(`${JSON.stringify({ decision: "block", reason })}\n`);
process.stderr.write(`${reason}\n`);
process.exit(1);
