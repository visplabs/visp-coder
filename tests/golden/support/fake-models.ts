import { mkdtempSync, writeFileSync } from "node:fs";
import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterAll } from "vitest";

/**
 * Stand-ins for the `codex` and `claude` CLIs VISP launches for its reviewer, tester, rule
 * reader and memory gate. No model runs: each call records exactly what VISP sent (arguments
 * and the prompt on stdin) and answers from a plan the scenario sets. The reviewer's answer
 * cites the evidence IDs of the packet it was sent, as a real reviewer must.
 *
 * They are found on PATH, as the real CLIs are, so the scenario drives the same code a user's
 * `visp done` runs. Node name resolution is mocked by the test files that use them, since VISP
 * checks that the model's host resolves before it spends a call.
 */
export interface ModelPlan {
  /** Reviewer verdicts, one per review call in order; the last repeats. */
  readonly reviews?: readonly ("satisfied" | "failed")[];
  /** Findings a failed review reports instead of the missing default export. */
  readonly findings?: readonly { problem: string; required: boolean }[];
  /** Rulings for every dispute the reviewer receives. */
  readonly ruling?: "upheld" | "rejected";
  /** The tester's structured answer; `fail` makes the tester CLI exit with an error. */
  readonly tester?: Record<string, unknown> | "fail";
  /** Rules the rule reader returns; each quote must appear in a recorded prompt. */
  readonly rules?: readonly { rule: string; quote: string }[];
  /** 1-based note numbers the memory gate selects. */
  readonly memory?: readonly number[];
}

export interface ModelCall {
  readonly name: "codex" | "claude";
  readonly role: "reviewer" | "tester" | "rules" | "memory" | "unknown";
  readonly args: readonly string[];
  readonly prompt: string;
}

const RESPONDER = String.raw`
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [dir, name, ...args] = process.argv.slice(2);
if (args[0] === "--version") {
  process.stdout.write(name + " 0.0.0-golden\n");
  process.exit(0);
}
if (name === "claude" && args[0] === "auth") {
  process.stdout.write(JSON.stringify({ loggedIn: true }));
  process.exit(0);
}
const prompt = readFileSync(0, "utf8");
const after = (flag) => args[args.indexOf(flag) + 1];
const schema = JSON.parse(name === "codex" ? readFileSync(after("--output-schema"), "utf8") : after("--json-schema"));
const keys = Object.keys(schema.properties ?? {});
const role = keys.includes("assessments") ? "reviewer" : keys.includes("selected") ? "memory"
  : keys.includes("rules") ? "rules" : keys.includes("tests") ? "tester" : "unknown";
const plan = JSON.parse(readFileSync(join(dir, "plan.json"), "utf8"));
const calls = join(dir, "calls");
mkdirSync(calls, { recursive: true });
let index = readdirSync(calls).length;
for (;;) {
  index += 1;
  try {
    writeFileSync(join(calls, String(index).padStart(3, "0") + ".json"), JSON.stringify({ name, role, args, prompt }), { flag: "wx" });
    break;
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
}
const earlier = (kind) => readdirSync(calls).filter((file) => file < String(index).padStart(3, "0") + ".json")
  .filter((file) => JSON.parse(readFileSync(join(calls, file), "utf8")).role === kind).length;

function reviewer() {
  const lines = prompt.trimEnd().split("\n");
  const packet = JSON.parse(lines[lines.length - 1]);
  const reviews = plan.reviews ?? ["satisfied"];
  const verdict = reviews[Math.min(earlier("reviewer"), reviews.length - 1)];
  const available = (packet.current?.evidence ?? []).filter(
    (entry) => entry.kind === "execution" && entry.status === "available",
  );
  const executions = available.map((entry) => entry.id).slice(0, 1);
  // Each outcome cites the run of a check declared for it, as the evidence mapping requires.
  const evidenceFor = (outcome) => {
    const own = available.find((entry) => (entry.outcomes ?? []).includes(outcome));
    return own ? [own.id] : executions;
  };
  const failed = verdict === "failed";
  return {
    summary: failed ? "The named export is two, but the default export is missing." : "Ran the check and observed the promised value two.",
    assessments: (packet.current?.outcomes ?? []).map((outcome) => ({
      outcome: outcome.id,
      status: failed ? "failed" : "satisfied",
      summary: failed ? "Only the named export is two." : "The promised export is there.",
      evidence: evidenceFor(outcome.id),
      expectations: [],
    })),
    findings: failed
      ? (plan.findings ?? [{ problem: "The module has no default export", required: true }]).map(
          (finding) => ({
            problem: finding.problem,
            consequence: "Callers that import the module's default value receive undefined, not two",
            nextCheck: "Import the default export of src/value.mjs and compare it with two",
            evidence: executions,
            outcomes: (packet.current?.outcomes ?? []).map((outcome) => outcome.id),
            required: finding.required,
          }),
        )
      : [],
    limitations: [],
    resolutions: failed ? [] : (packet.openFindings ?? []).map((finding) => ({
      id: finding.id,
      disposition: "repaired",
      explanation: "The default export is now two as well.",
      evidence: executions,
      regression: { kind: "not-applicable", explanation: "A constant export has no adjacent behavior." },
    })),
    disputes: (packet.disputes ?? []).map((dispute) => ({
      test: dispute.test,
      ruling: plan.ruling ?? "upheld",
      reasoning: plan.ruling === "rejected"
        ? "The request does not say the value is odd or even; the product must satisfy the test."
        : 'The request says "return two"; two is even, so a test that wants an odd value contradicts it.',
    })),
  };
}

const response = role === "reviewer" ? reviewer()
  : role === "memory" ? { selected: (plan.memory ?? []).map((note) => ({ note, why: "It constrains the request." })) }
  : role === "rules" ? { rules: plan.rules ?? [] }
  : role === "tester" && plan.tester && plan.tester !== "fail" ? plan.tester
  : undefined;
if (response === undefined) {
  process.stderr.write("golden " + name + ": no planned " + role + " answer\n");
  process.exit(1);
}
// \`visp feature\` reports a tester it sees running; a tester that answered instantly could
// finish between two of its polls, so the answer takes longer than one poll.
if (role === "tester") Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 400);
if (name === "codex") writeFileSync(after("--output-last-message"), JSON.stringify(response));
else process.stdout.write(JSON.stringify({ type: "result", is_error: false, structured_output: response }));
`;

export class FakeModels {
  private constructor(readonly directory: string) {}

  /** Puts `codex` and `claude` stand-ins first on PATH until this test file ends. */
  static install(): FakeModels {
    const directory = mkdtempSync(join(tmpdir(), "visp-golden-models-"));
    writeFileSync(join(directory, "responder.mjs"), RESPONDER);
    writeFileSync(join(directory, "plan.json"), "{}");
    const quoted = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;
    for (const name of ["codex", "claude"])
      writeFileSync(
        join(directory, name),
        `#!/bin/sh\nexec ${quoted(process.execPath)} ${quoted(join(directory, "responder.mjs"))} ${quoted(directory)} ${name} "$@"\n`,
        { mode: 0o755 },
      );
    const path = process.env.PATH;
    process.env.PATH = `${directory}${delimiter}${path ?? ""}`;
    afterAll(async () => {
      if (path === undefined) delete process.env.PATH;
      else process.env.PATH = path;
      await rm(directory, { recursive: true, force: true });
    });
    return new FakeModels(directory);
  }

  /** Sets the answers for the next calls and forgets every earlier call. */
  async plan(plan: ModelPlan): Promise<void> {
    await rm(join(this.directory, "calls"), { recursive: true, force: true });
    this.seen = 0;
    await writeFile(join(this.directory, "plan.json"), JSON.stringify(plan));
  }

  /** Calls made since the last `plan` or `clear`, in order. */
  async calls(): Promise<ModelCall[]> {
    return (await this.recorded()).slice(this.seen);
  }

  /**
   * Starts a new step: later `calls` leave out what was made so far. The responder still
   * counts every reviewer call since the plan, so its verdicts keep their order.
   */
  async clear(): Promise<void> {
    this.seen = (await this.recorded()).length;
  }

  private seen = 0;
  private async recorded(): Promise<ModelCall[]> {
    const directory = join(this.directory, "calls");
    const files = (await readdir(directory).catch(() => [] as string[])).sort();
    return Promise.all(
      files.map(
        async (file) => JSON.parse(await readFile(join(directory, file), "utf8")) as ModelCall,
      ),
    );
  }
}

/**
 * A model call as the model receives it: the command line VISP chose and the prompt. A JSON
 * packet on the prompt's last line is shown indented, but only when the line is exactly
 * `JSON.stringify` of its value, so the indented form loses no byte of what was sent.
 */
export function modelCallTranscript(call: ModelCall): string {
  const lines = call.prompt.split("\n");
  const last = lines.findLastIndex((line) => line.trim() !== "");
  const packet = last >= 0 ? jsonLine(lines[last] ?? "") : undefined;
  const text = packet === undefined ? call.prompt : lines.slice(0, last).join("\n");
  return [
    `$ ${call.name} ${call.args.map(argument).join(" ")}`,
    `--- prompt (${call.role})`,
    text,
    ...(packet === undefined
      ? []
      : [`--- last prompt line: compact JSON, shown indented`, JSON.stringify(packet, null, 2)]),
  ].join("\n");
}

function jsonLine(line: string): unknown {
  if (!line.startsWith("{")) return undefined;
  try {
    const value = JSON.parse(line);
    return JSON.stringify(value) === line ? value : undefined;
  } catch {
    return undefined;
  }
}

/** Long arguments (an inline schema) are kept whole; spaces are quoted. */
function argument(value: string): string {
  return /^[\w./:=@,+-]+$/.test(value) ? value : `'${value}'`;
}

/** The tester's answer: a pinned suite with the named assertions on the fixture's exports. */
export function testerSuite(tests: readonly (readonly [string, string])[]) {
  const checks = tests
    .map(([name, assertion]) => `check(${JSON.stringify(name)}, () => assert.ok(${assertion}));`)
    .join("\n");
  return {
    file: {
      name: "value.test.mjs",
      content: `import assert from "node:assert/strict";
import * as product from "../../src/value.mjs";
const { value } = product;
const waived = new Set(JSON.parse(process.env.VISP_WAIVED_TESTS ?? "[]"));
let failed = false;
function check(name, run) {
  if (waived.has(name)) return;
  try { run(); console.log(\`PASS: \${name}\`); } catch (error) { failed = true; console.log(\`FAIL: \${name}: \${error.message}\`); }
}
${checks}
process.exitCode = failed ? 1 : 0;
`,
    },
    existingBehavior: false,
    tests: tests.map(([name]) => ({ name, quote: "return two" })),
    ambiguities: [],
    notes: "",
  };
}

/** A tester that writes nothing: the request is too small to test apart from its checks. */
export const DECLINED_TESTER = {
  file: null,
  existingBehavior: false,
  tests: [],
  ambiguities: [],
  notes: "The request states one value; the worker's own check covers it.",
};
