import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import type { ProductWorkContext } from "../../../src/workflow/product/context-types.js";
import { productProject } from "../support/product.js";
import type { TestProject } from "../support/project.js";

let project: TestProject | undefined;
afterEach(async () => project?.destroy());

it("applies excerpt settings to fresh CLI and live MCP delivery without changing scope", async () => {
  const created = await productProject({
    files: {
      "src/value.mjs": "export const value = 1;\n",
      "src/first.mjs": "export const first = 10;\n",
      "src/second.mjs": "export const second = 20;\n",
      "tests/value.test.mjs":
        "import assert from 'node:assert/strict'; import {value} from '../src/value.mjs'; assert.equal(value,2);\n",
    },
  });
  project = created.project;
  const settings = parse(await project.read("visp.yml"));
  const statePath = `.visp/features/${created.feature}/product-state.json`;
  const stateBefore = await project.read(statePath);
  const client = new Client({ name: "configured-context-delivery", version: "1" });
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
    for (const [snippets, fileCount] of [
      [1, 1],
      [2, 2],
      [3, 3],
      [99, 4],
    ] as const) {
      await project.write(
        "visp.yml",
        stringify({
          ...settings,
          context: { ...settings.context, maxSnippets: snippets, tokenBudget: 12000 },
        }),
      );
      const cli = project.json<ProductWorkContext>("work", "--inspect");
      expect(cli.result.exitCode, cli.result.stdout).toBe(0);
      const context = cli.envelope.data;
      if (!context) throw new Error("Missing CLI context");
      expect(context.files).toHaveLength(fileCount);
      expect(context.mayEdit).toBe(false);
      for (const detail of [false, true]) {
        const response = await client.callTool({
          name: "visp_work",
          arguments: { inspect: true, detail },
        });
        expect(response.isError, JSON.stringify(response)).not.toBe(true);
        const data = (response.structuredContent as { data: ProductWorkContext }).data;
        expect(data.files).toEqual(context.files);
        expect(data.scope).toEqual(context.scope);
        expect(data.mayEdit).toBe(false);
      }
      expect(await project.read(statePath)).toBe(stateBefore);
    }
  } finally {
    await client.close();
  }
});
