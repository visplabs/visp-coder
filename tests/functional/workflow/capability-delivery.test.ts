import { unlink } from "node:fs/promises";
import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import type { ProductWorkContext } from "../../../src/workflow/product/context-types.js";
import { productProject, succeeded } from "../support/product.js";
import type { TestProject } from "../support/project.js";

let project: TestProject | undefined;
afterEach(async () => project?.destroy());

it("delivers retained knowledge in a fresh work session and isolates graph and skill ablations", async () => {
  ({ project } = await productProject());
  await project.write(
    "numeric-value.md",
    "---\nname: numeric-value\ndescription: Preserve numeric value compatibility\nappliesTo:\n  paths:\n    - src/**\n---\n\n## Procedure\n\nCheck numeric consumers when changing the public value.\n\n## Verification\n\nRun the public value test.\n",
  );
  succeeded(
    project,
    "skill",
    "propose",
    "--id",
    "numeric-value",
    "--file",
    "numeric-value.md",
    "--origin",
    "seeded",
  );
  succeeded(project, "skill", "admit", "numeric-value", "--by", "test-fixture");
  await project.write(
    "typed-review.md",
    "---\nname: typed-review\nappliesTo:\n  language: typescript\n---\n## Procedure\nInspect typed callers.\n",
  );
  succeeded(
    project,
    "skill",
    "propose",
    "--id",
    "typed-review",
    "--file",
    "typed-review.md",
    "--origin",
    "seeded",
  );
  succeeded(project, "skill", "admit", "typed-review", "--by", "test-fixture");
  await project.write(
    "script-tests.md",
    "---\nname: script-tests\nappliesTo:\n  language: javascript\n  entrypointKind: test_entrypoint\n---\n## Procedure\nCheck executable script behavior.\n",
  );
  succeeded(
    project,
    "skill",
    "propose",
    "--id",
    "script-tests",
    "--file",
    "script-tests.md",
    "--origin",
    "seeded",
  );
  succeeded(project, "skill", "admit", "script-tests", "--by", "test-fixture");
  await project.write(
    "repair-review.md",
    "---\nname: repair-review\nappliesTo:\n  taskClass: bugfix\n---\n## Procedure\nReproduce the reported defect.\n",
  );
  succeeded(
    project,
    "skill",
    "propose",
    "--id",
    "repair-review",
    "--file",
    "repair-review.md",
    "--origin",
    "seeded",
  );
  succeeded(project, "skill", "admit", "repair-review", "--by", "test-fixture");
  await project.write(
    "class-patch.json",
    JSON.stringify({ slices: [{ id: "T001", taskClass: "bugfix" }] }),
  );
  succeeded(
    project,
    "brief",
    "--patch",
    "class-patch.json",
    "--reason",
    "Repair the public value behavior",
  );
  const settings = parse(await project.read("visp.yml"));
  // Each command starts a fresh process. Knowledge must survive the writing session.
  const context = () => {
    const result = project?.json<ProductWorkContext>("work");
    expect(result?.result.exitCode, result?.result.stdout).toBe(0);
    if (!result?.envelope.data) throw new Error("Missing product context");
    return result.envelope.data;
  };
  const full = context();
  expect(full.taskClass).toBe("bugfix");
  expect(full.skills.some((entry) => entry.path.includes("repair-review"))).toBe(true);
  expect(full.graph.length).toBeGreaterThan(0);
  expect(full.notes.join("\n")).toContain("typed-review: trigger did not match");
  expect(full.notes.join("\n")).not.toContain("language facts are unavailable");
  expect(full.notes.join("\n")).toContain("Skill graph facts observed from snapshot");
  expect(full.skills.some((entry) => entry.path.includes("script-tests"))).toBe(true);
  expect(full.skills.some((entry) => entry.path.includes("typed-review"))).toBe(false);
  expect(full.skills.some((entry) => entry.path.includes("numeric-value"))).toBe(true);
  expect(full.skills.every((entry) => entry.advisory)).toBe(true);

  const client = new Client({ name: "capability-delivery", version: "1" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve("dist/cli.js"), "--project", project.root, "serve", "--mcp"],
    env: Object.fromEntries(
      Object.entries(project.env()).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    ),
    stderr: "pipe",
  });
  try {
    await client.connect(transport);
    for (const detail of [false, true]) {
      const response = await client.callTool({
        name: "visp_work",
        arguments: { inspect: true, detail },
      });
      expect(response.structuredContent).toMatchObject({
        ok: true,
        data: {
          taskClass: "bugfix",
          scope: full.scope,
          skills: full.skills,
          graph: full.graph,
        },
      });
      const text = (response.content as { type: string; text?: string }[])
        .filter((entry) => entry.type === "text")
        .map((entry) => entry.text ?? "")
        .join("\n");
      expect(text).toContain("Check numeric consumers when changing the public value.");
      expect(text).toContain('"graph"');
      expect(text).toContain(full.graph[0]?.name);
      expect(text).toContain("bugfix");
    }
  } finally {
    await client.close();
  }

  for (const disabled of ["graph", "skills"] as const) {
    const changed = structuredClone(settings);
    if (disabled === "graph") changed.graph = { ...changed.graph, exclude: ["**"] };
    else changed[disabled] = { ...changed[disabled], enabled: false };
    await project.write("visp.yml", stringify(changed));
    const delivered = context();
    expect(delivered[disabled]?.length, `${disabled} treatment must actually be absent`).toBe(0);
    for (const retained of ["graph", "skills"] as const)
      if (retained !== disabled) expect(delivered[retained]?.length).toBeGreaterThan(0);
    expect(delivered.scope).toEqual(full.scope);
    expect(delivered.outcomes).toEqual(full.outcomes);
  }

  await project.write("visp.yml", stringify(settings));
  await assertSkillBodyIntegrity(project, full, context);
});

async function assertSkillBodyIntegrity(
  project: TestProject,
  full: ProductWorkContext,
  context: () => ProductWorkContext,
) {
  const admitted = full.skills.find((entry) => entry.path.includes("numeric-value"));
  if (!admitted) throw new Error("Missing admitted skill fixture");
  const original = await project.read(admitted.path);
  const skillClient = new Client({ name: "skill-body-integrity", version: "1" });
  const skillTransport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve("dist/cli.js"), "--project", project.root, "serve", "--mcp"],
    env: Object.fromEntries(
      Object.entries(project.env()).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    ),
    stderr: "pipe",
  });
  const excluded = (delivered: ProductWorkContext, serialized: string) => {
    expect(delivered.skills.some((entry) => entry.path === admitted.path)).toBe(false);
    expect(delivered.skills.some((entry) => entry.path.includes("repair-review"))).toBe(true);
    expect(delivered.notes.join("\n")).toContain(
      "numeric-value: its file is not the one that was admitted; skill omitted",
    );
    expect(delivered.scope).toEqual(full.scope);
    expect(delivered.outcomes).toEqual(full.outcomes);
    expect(serialized).not.toContain("UNADMITTED_SKILL_SENTINEL");
  };
  try {
    await skillClient.connect(skillTransport);
    for (const state of ["changed", "missing"] as const) {
      if (state === "changed")
        await project.write(admitted.path, `${original}\nUNADMITTED_SKILL_SENTINEL\n`);
      else await unlink(resolve(project.root, admitted.path));
      const delivered = context();
      excluded(delivered, JSON.stringify(delivered));
      for (const detail of [false, true]) {
        const response = await skillClient.callTool({
          name: "visp_work",
          arguments: { inspect: true, detail },
        });
        expect(response.isError, JSON.stringify(response)).not.toBe(true);
        excluded(
          (response.structuredContent as { data: ProductWorkContext }).data,
          JSON.stringify(response),
        );
      }
    }
    await project.write(admitted.path, original);
    const restored = context();
    expect(restored.skills.find((entry) => entry.path === admitted.path)).toEqual(admitted);
  } finally {
    await skillClient.close();
  }
}
