import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { parseDocument } from "yaml";
import { assertRecoveredMigration, interruptInstalledMigration } from "./upgrade-interruption.mjs";

// Explicit old binary input: never download a substitute or update the user's installation.
const oldCli = process.argv[2];
assert(
  oldCli && isAbsolute(oldCli),
  "Usage: node scripts/upgrade-smoke.mjs /absolute/path/to/old-visp",
);
assert.notEqual(
  process.platform,
  "win32",
  "This installed-binary fixture currently qualifies POSIX only",
);
const repository = resolve(import.meta.dirname, "..");
function run(binary, args, cwd, env = process.env, input) {
  return execFileSync(binary, args, {
    cwd,
    env,
    input,
    encoding: "utf8",
    stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
  });
}
const oldVersion = run(oldCli, ["--version"], repository).trim();
assert.equal(oldVersion, "0.4.0-beta.1", "This fixture requires an installed 0.4.0-beta.1 CLI");
const scratch = await mkdtemp(join(tmpdir(), "visp-installed-upgrade-"));
const root = join(scratch, "project");
await mkdir(root);
let complete = false;
let oldClient;
let currentClient;
const oldMcpRefusals = [];
try {
  const oldEnv = {
    ...process.env,
    PATH: `${dirname(oldCli)}${delimiter}${process.env.PATH ?? ""}`,
  };
  const call = (binary, args, env, input, allowFailure = false) => {
    let output;
    try {
      output = run(binary, ["--project", root, ...args, "--json"], root, env, input);
    } catch (error) {
      if (!allowFailure || !error.stdout) throw error;
      output = String(error.stdout);
    }
    const envelope = JSON.parse(output);
    if (!allowFailure) assert.equal(envelope.ok, true, JSON.stringify(envelope));
    return envelope;
  };
  const prior = (args, input, allowFailure) => call(oldCli, args, oldEnv, input, allowFailure);
  run("git", ["init", "-q", "-b", "main"], root);
  run("git", ["config", "user.name", "Upgrade Fixture"], root);
  run("git", ["config", "user.email", "upgrade@example.test"], root);
  await writeFile(join(root, "value.mjs"), "export const value = 1;\n");
  await writeFile(
    join(root, "value.test.mjs"),
    "import assert from 'node:assert/strict';import {value} from './value.mjs';assert.equal(value,2);\n",
  );
  prior(["init", "--harness", "generic"]);
  prior(["install", "--hooks", "git", "--no-mcp"]);
  run("git", ["add", "-A"], root);
  run("git", ["commit", "-qm", "old installed baseline"], root, oldEnv);
  const started = prior(["feature", "Return two"]).data.brief;
  const brief = {
    ...started,
    outcomes: [
      {
        id: "O001",
        kind: "functional",
        statement: "Public value equals two",
        priority: "must",
        provenance: "user-stated",
      },
    ],
    checks: [
      {
        id: "C001",
        command: [process.execPath, "value.test.mjs"],
        outcomes: ["O001"],
        files: ["value.mjs", "value.test.mjs"],
        environment: "node",
      },
    ],
    slices: [
      {
        id: "T001",
        goal: "Return two",
        outcomes: ["O001"],
        scope: { allowed: ["value.mjs"], expected: ["value.mjs"], forbidden: [] },
        checks: ["C001"],
      },
    ],
  };
  prior(["brief", "--from", "-", "--reason", "Define verifiable behavior"], JSON.stringify(brief));
  prior(["work", "--task", "T001"]);
  const failed = prior(["verify", "--task", "T001"], undefined, true);
  assert.equal(failed.data?.passed, false);
  assert(failed.data.executions.some((entry) => entry.status === "failed"));
  const statePath = join(root, ".visp/features", brief.feature, "product-state.json");
  const originalText = await readFile(statePath, "utf8");
  const original = JSON.parse(originalText);
  const configPath = join(root, "visp.yml");
  const originalConfig = await readFile(configPath, "utf8");
  oldClient = await connectMcp(oldCli, root, oldEnv);
  assert.equal(oldClient.getServerVersion()?.version, oldVersion);
  const beforeUpgrade = await oldClient.callTool({ name: "visp_next", arguments: {} });
  assert.notEqual(beforeUpgrade.isError, true, JSON.stringify(beforeUpgrade));
  const archive = join(root, ".visp/upgrade-original");
  await mkdir(archive, { recursive: true });
  await writeFile(join(archive, "product-state.json"), originalText);
  await writeFile(join(archive, "visp.yml"), originalConfig);
  const config = parseDocument(originalConfig);
  for (const key of [
    "ranking",
    "snippetCap",
    "maxSnippetLines",
    "includeSnippets",
    "maxRegionsPerFile",
  ])
    config.deleteIn(["context", key]);
  for (const key of ["queryDepth", "queryResults"]) config.deleteIn(["graph", key]);
  for (const key of ["maxSourceFileLines", "maxSourceLineChars", "requireTests"])
    config.deleteIn(["workflow", key]);
  await writeFile(configPath, config.toString());

  const packed = JSON.parse(
    run("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", scratch], repository),
  );
  assert(packed[0]?.filename);
  const prefix = join(scratch, "candidate");
  run(
    "npm",
    [
      "install",
      "--global",
      "--ignore-scripts",
      "--prefix",
      prefix,
      join(scratch, packed[0].filename),
    ],
    repository,
  );
  const bin = join(prefix, "bin");
  const candidateCli = join(bin, "visp");
  const candidateEnv = { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH ?? ""}` };
  const current = (args, input, allowFailure) =>
    call(candidateCli, args, candidateEnv, input, allowFailure);
  const migrate = (operation) =>
    JSON.parse(run(join(bin, "visp-migrate"), ["--project", root, operation], root, candidateEnv));
  const preview = migrate("preview");
  assert.equal(preview.ok, true);
  assert.equal(await readFile(statePath, "utf8"), originalText);
  const interrupted = await interruptInstalledMigration({
    binary: join(bin, "visp-migrate"), root, scratch, statePath, originalText, env: candidateEnv,
  });
  await assert.rejects(assertRecoveredMigration(interrupted), /Restart must recover/);
  // Read-only preview must not silently recover the partial transaction.
  const interruptedState = await readFile(statePath, "utf8");
  migrate("preview");
  assert.equal(await readFile(interrupted.journalPath, "utf8"), interrupted.journalText);
  assert.equal(await readFile(statePath, "utf8"), interruptedState);
  assert.equal(migrate("apply").ok, true);
  await assertRecoveredMigration(interrupted);
  const mismatch = call(
    candidateCli,
    ["install", "--harness", "generic", "--hooks", "git", "--no-mcp"],
    oldEnv,
    undefined,
    true,
  );
  assert.equal(mismatch.ok, false, "Old PATH guard must not silently certify the new runtime");
  assert.match(JSON.stringify(mismatch.error), /protocol|runtime|Invalid product state/i);
  current(["install", "--harness", "generic", "--hooks", "git", "--no-mcp"]);
  const protectedPaths = [
    statePath,
    configPath,
    join(root, ".visp/state/product-authorizations", `${brief.feature}.json`),
    join(root, ".visp/state/implement-allowed/T001.json"),
  ];
  const protectedBefore = await Promise.all(protectedPaths.map(readOptional));
  for (const name of ["visp_work", "visp_done", "visp_accept"]) {
    const response = await oldClient.callTool({ name, arguments: name === "visp_accept" ? {} : { task: "T001" } });
    assert.equal(response.isError, true, `Old MCP must refuse upgraded ${name}: ${JSON.stringify(response)}`);
    const failure = response.structuredContent?.error;
    assert(failure?.code, `Expected a domain refusal, not an absent tool: ${JSON.stringify(response)}`);
    assert.equal(failure.code, "ARTIFACT_INVALID", "Old runtime must refuse the upgraded state format itself");
    oldMcpRefusals.push({ tool: name, code: failure.code, recovery: failure.recovery });
    assert.deepEqual(await Promise.all(protectedPaths.map(readOptional)), protectedBefore, "Old MCP must preserve history, configuration and authorization");
  }
  current(["next"]);
  current(["work", "--task", "T001"]);
  await writeFile(join(root, "value.mjs"), "export const value = 2;\n");
  const blocked = current(["verify", "--task", "T001"], undefined, true);
  assert.equal(
    blocked.ok,
    false,
    "Generated upgrade changes must still respect the original scope",
  );
  assert.match(JSON.stringify(blocked.error), /scope|allowed/i);
  brief.slices[0].scope.allowed.push("AGENTS.visp.md", "VISP.commands.md", ".visp/VISP.commands.md", "visp.yml");
  current(
    [
      "brief",
      "--from",
      "-",
      "--reason",
      "Explicitly include inspected config and generated instruction upgrades",
    ],
    JSON.stringify(brief),
  );
  current(["work", "--task", "T001"]);
  const reauthorizedBefore = await Promise.all(protectedPaths.map(readOptional));
  for (const name of ["visp_work", "visp_done", "visp_accept"]) {
    const response = await oldClient.callTool({ name, arguments: name === "visp_accept" ? {} : { task: "T001" } });
    assert.equal(response.isError, true, `Old MCP must refuse reauthorized ${name}: ${JSON.stringify(response)}`);
    const failure = response.structuredContent?.error;
    assert(failure?.code, JSON.stringify(response));
    assert.equal(failure.code, "ARTIFACT_INVALID", "Old runtime must refuse the upgraded state format itself");
    oldMcpRefusals.push({ phase: "after-reauthorization", tool: name, code: failure.code, recovery: failure.recovery });
    assert.deepEqual(await Promise.all(protectedPaths.map(readOptional)), reauthorizedBefore, "Old MCP must preserve current authorization and history after scope recovery");
  }
  await oldClient.close();
  oldClient = undefined;
  currentClient = await connectMcp(candidateCli, root, candidateEnv);
  assert.equal(currentClient.getServerVersion()?.version, JSON.parse(await readFile(join(repository, "package.json"), "utf8")).version);
  const restarted = await currentClient.callTool({ name: "visp_next", arguments: {} });
  assert.notEqual(restarted.isError, true, JSON.stringify(restarted));
  const repaired = current(["verify", "--task", "T001"]);
  assert.equal(repaired.data?.passed, true);
  const after = JSON.parse(await readFile(statePath, "utf8"));
  for (const execution of original.executions)
    assert.deepEqual(
      after.executions.find((entry) => entry.id === execution.id),
      execution,
    );
  assert.notEqual(after.status, "accepted", "A passing check must not manufacture acceptance");
  assert.equal(await readFile(join(archive, "product-state.json"), "utf8"), originalText);
  assert.equal(await readFile(join(archive, "visp.yml"), "utf8"), originalConfig);
  assert.equal(migrate("apply").data?.changed, 0);
  const identity = current(["guard", "--handshake"]).data;
  assert.match(identity.runtime.buildId, /^[a-f0-9]{16}$/);
  assert.equal(
    identity.runtime.version,
    JSON.parse(await readFile(join(repository, "package.json"), "utf8")).version,
  );
  assert.notEqual(identity.runtime.version, oldVersion);
  console.log(
    JSON.stringify({
      oldVersion,
      candidateVersion: run(candidateCli, ["--version"], root, candidateEnv).trim(),
      identity,
      originalExecutionsPreserved: original.executions.length,
      repaired: true,
      acceptanceClaimed: false,
      oldMcpRefusedUpgrade: true,
      oldMcpRefusals,
      restartedMcpRecovered: true,
      interruptedInstalledMigrationRecovered: true,
    }),
  );
  complete = true;
} finally {
  await oldClient?.close();
  await currentClient?.close();
  if (complete) await rm(scratch, { recursive: true, force: true });
  else console.error(`Upgrade fixture retained for diagnosis: ${scratch}`);
}

async function connectMcp(binary, root, env) {
  const client = new Client({ name: "installed-upgrade", version: "1" });
  const transport = new StdioClientTransport({
    command: binary,
    args: ["--project", root, "serve", "--mcp"],
    env: Object.fromEntries(Object.entries(env).filter(([, value]) => typeof value === "string")),
    stderr: "pipe",
  });
  try {
    await client.connect(transport);
    return client;
  } catch (error) {
    await client.close();
    throw error;
  }
}

async function readOptional(path) {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
}
