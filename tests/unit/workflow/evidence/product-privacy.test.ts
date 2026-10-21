import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { updateProductBrief } from "../../../../src/workflow/product/brief.js";
import { prepareCandidate } from "../../../../src/workflow/product/candidate.js";
import { criticSelection } from "../../../../src/workflow/product/critic/critic-store.js";
import { runProductVerify } from "../../../../src/workflow/product/evidence.js";
import { runProductWork } from "../../../../src/workflow/product/work.js";
import { productWorkspace } from "../../support/product-workspace.js";
import type { TestWorkspace } from "../../support/workspace.js";

let project: TestWorkspace;
afterEach(async () => {
  vi.unstubAllEnvs();
  await project?.destroy();
});

it.each([0, 700])(
  "redacts check output before truncating it (secret padding: %i)",
  async (padding) => {
    const setup = await productWorkspace();
    project = setup.workspace;
    vi.stubEnv("AUDIT_SECRET", "inherited-private-value");
    const secret = `file-private-value${"private-fragment-".repeat(padding)}`;
    await project.write(".env", `DEPLOY_KEY=${JSON.stringify(secret)}\n`);
    await project.write(
      "test/value.test.mjs",
      "console.log(process.env.AUDIT_SECRET, process.env.DEPLOY_KEY, process.cwd());\n",
    );
    const updated = await updateProductBrief(await project.state(), {
      brief: {
        ...setup.brief,
        checks: [
          {
            ...setup.brief.checks[0],
            command: [process.execPath, "--env-file=.env", "test/value.test.mjs"],
            files: [".env", "test/value.test.mjs"],
            verifierFiles: [".env", "test/value.test.mjs"],
          },
        ],
      },
      reason: "Exercise private check inputs",
    });
    expect(updated.ok).toBe(true);
    expect((await runProductWork(await project.state(), { task: "T001" })).ok).toBe(true);
    const checked = await runProductVerify(await project.state());
    expect(checked.ok).toBe(true);
    const stored = await readFile(
      join(project.root, `.visp/features/${setup.brief.feature}/product-state.json`),
      "utf8",
    );
    expect(stored).not.toContain("inherited-private-value");
    expect(stored).not.toContain("file-private-value");
    expect(stored).not.toContain("private-fragment-");
    expect(stored).not.toContain(project.root);
    expect(stored).toContain("[REDACTED]");
    const rawDir = join(project.root, ".visp/session/check-output");
    const raw = await readFile(join(rawDir, (await readdir(rawDir))[0] ?? ""), "utf8");
    expect(raw).toContain(secret);
    expect(project.git("check-ignore", ".visp/session/check-output/test.log").trim()).toBe(
      ".visp/session/check-output/test.log",
    );
  },
);

it("stores only hashes for private inputs and image evidence in candidates", async () => {
  const setup = await productWorkspace();
  project = setup.workspace;
  await project.write(".env", "TOKEN=private-input-value\n");
  await project.write(
    ".gitignore",
    `${await readFile(join(project.root, ".gitignore"), "utf8")}private.txt\n`,
  );
  await project.write("private.txt", "ignored private input");
  await project.write("deploy.key", "private signing key");
  await updateProductBrief(await project.state(), {
    brief: {
      ...setup.brief,
      checks: setup.brief.checks.map((check) => ({
        ...check,
        files: [...check.files, ".env", "private.txt", "deploy.key"],
      })),
    },
    reason: "Check private inputs",
  });
  const workspace = await project.state();
  const selected = await criticSelection(workspace, { task: "T001" });
  if (!selected.ok) throw new Error(selected.error.message);
  const prepared = await prepareCandidate(workspace, selected.value, {
    images: [{ id: "image-1", sha256: "digest", data: "BASE64_IMAGE" }],
  });
  if (!prepared.ok) throw new Error(prepared.error.message);
  const candidate = prepared.value.candidate;
  for (const path of [".env", "private.txt", "deploy.key"])
    expect(candidate.files.find((file) => file.path === path)).toMatchObject({
      content: null,
      omitted: true,
    });
  expect(JSON.stringify(candidate)).not.toContain("BASE64_IMAGE");
  expect(JSON.parse(candidate.productState)).toEqual({
    executions: selected.value.record.state.executions,
  });
});

it("masks credentials in the request before saving or publishing and tells the caller", async () => {
  const { TestWorkspace } = await import("../../support/workspace.js");
  const { createProductFeature } = await import(
    "../../../../src/workflow/product/feature-create.js"
  );
  const { runProductReport } = await import("../../../../src/workflow/product/status.js");
  project = await TestWorkspace.create();
  await project.installFoundation();
  project.commit("foundation");
  const secret = "ghp_abcdefghijklmnopqrstuvwxyz123456";
  const created = await createProductFeature(await project.state(), {
    goal: "Deploy the app",
    sourceBrief: `My deploy key is ${secret}; deploy the app.`,
  });
  if (!created.ok) throw new Error(created.error.message);
  expect(created.value.redactionNotice).toContain("masked");
  for (const file of ["brief.yaml", "intent.json", "product-state.json"]) {
    const text = await readFile(
      join(project.root, `.visp/features/${created.value.brief.feature}/${file}`),
      "utf8",
    );
    expect(text).not.toContain(secret);
    expect(text).toContain("[REDACTED]");
  }
  // The record and the full handoff document both carry the request.
  const report = await runProductReport(await project.state(), { full: true });
  expect(report.ok && report.value.markdown).not.toContain(secret);
});
