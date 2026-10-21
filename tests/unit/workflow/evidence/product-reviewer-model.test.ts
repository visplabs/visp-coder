import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { reviewerMemoryGate } from "../../../../src/workflow/product/memory-gate.js";
import { reviewerRuleExtractor } from "../../../../src/workflow/product/rule-extraction.js";

/**
 * The rule reader and the memory gate ask the model of the reviewer VISP launches. Under
 * `critic.launch: claude-exec` that is one `claude -p` at low effort, in an empty directory.
 */
let directory: string | undefined;
afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = undefined;
});

/** A `claude` that records its arguments and working directory and answers `answer`. */
async function fakeClaude(answer: unknown): Promise<{ executable: string; log: string }> {
  directory = await mkdtemp(join(tmpdir(), "visp-fake-claude-"));
  const executable = join(directory, "claude");
  const log = join(directory, "calls.json");
  await writeFile(
    executable,
    `#!/usr/bin/env node
const { readFileSync, writeFileSync } = require("node:fs");
const prompt = readFileSync(0, "utf8");
writeFileSync(${JSON.stringify(log)}, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), prompt }));
process.stdout.write(JSON.stringify({ is_error: false, structured_output: ${JSON.stringify(answer)} }));
`,
  );
  await chmod(executable, 0o755);
  return { executable, log };
}

const reachable = async () => ({ address: "127.0.0.1" });
const CLAUDE = { launch: "claude-exec", model: "claude-sonnet-5-5" } as const;

it("asks a Claude reviewer's model to choose notes, at low effort, outside the project", async () => {
  const { executable, log } = await fakeClaude({ selected: [{ note: 2, why: "restock" }] });
  const gate = reviewerMemoryGate(CLAUDE, { executable, lookup: reachable });
  const notes = ["Archived items cannot be reserved.", "Items hold at most 10000 units."];
  expect(await gate("Add restocking.", notes)).toEqual(["Items hold at most 10000 units."]);
  const call = JSON.parse(await readFile(log, "utf8"));
  expect(call.args).toEqual(
    expect.arrayContaining(["-p", "--model", "claude-sonnet-5-5", "--effort", "low"]),
  );
  expect(call.prompt).toContain("REQUEST:\nAdd restocking.");
  expect(call.cwd).toContain("visp-memory-gate-");
  await expect(stat(call.cwd)).rejects.toThrow();
});

it("asks a Claude reviewer's model to read the rules", async () => {
  const rules = [{ rule: "Money fields end in Cents.", quote: "money fields end in Cents" }];
  const { executable, log } = await fakeClaude({ rules });
  const read = reviewerRuleExtractor(CLAUDE, { executable, lookup: reachable });
  expect(await read(["House style: money fields end in Cents."])).toEqual(rules);
  const call = JSON.parse(await readFile(log, "utf8"));
  expect(call.args).toEqual(expect.arrayContaining(["--model", "claude-sonnet-5-5"]));
  expect(call.prompt).toContain("Message 1:\nHouse style: money fields end in Cents.");
});

it("fails without reaching Claude, so the caller falls back", async () => {
  const { executable, log } = await fakeClaude({ selected: [] });
  const offline = async () => {
    throw new Error("ENOTFOUND");
  };
  const gate = reviewerMemoryGate(CLAUDE, { executable, lookup: offline });
  await expect(gate("Add restocking.", ["A note."])).rejects.toThrow("cannot reach its model");
  await expect(readFile(log, "utf8")).rejects.toThrow();
});
