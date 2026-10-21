import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { afterEach, expect, it } from "vitest";
import type { ProductWorkContext } from "../../../src/workflow/product/context-types.js";
import { productProject, succeeded } from "../support/product.js";
import type { TestProject } from "../support/project.js";

const projects: TestProject[] = [];
afterEach(async () => {
  await Promise.all(projects.splice(0).map((project) => project.destroy()));
});

it.each(["malformed", "foreign"] as const)(
  "inspects work over a %s graph without rewriting it or changing scope",
  async (kind) => {
    const { project } = await productProject();
    projects.push(project);
    succeeded(project, "work");
    const graphPath = resolve(project.root, ".visp/graph/graph.db");
    const before = project.json<ProductWorkContext>("work", "--inspect").envelope.data;
    let invalid = Buffer.from("This is not a graph database.\n");
    if (kind === "foreign") {
      const donor = (await productProject()).project;
      projects.push(donor);
      succeeded(donor, "work");
      invalid = await readFile(resolve(donor.root, ".visp/graph/graph.db"));
    }
    await writeFile(graphPath, invalid);
    const cli = project.json<ProductWorkContext>("work", "--inspect");
    expect(cli.result.exitCode, cli.result.stdout).toBe(0);
    expect(cli.envelope.data?.scope).toEqual(before?.scope);
    expect(cli.envelope.data?.mayEdit).toBe(before?.mayEdit);
    expect(await readFile(graphPath)).toEqual(invalid);
  },
);
