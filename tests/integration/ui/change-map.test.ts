import { cp, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { changeMapView } from "../../../src/ui/change-map/index.js";
import type { UiChangeMap, UiEnvelope, UiMapNode } from "../../../src/ui/contract.js";
import { cookieName } from "../../../src/ui/security.js";
import { startUiServer } from "../../../src/ui/server.js";
import { changeMapScenario } from "../../unit/support/change-map-scenario.js";
import { value } from "../../unit/support/ui-scenario.js";
import type { TestWorkspace } from "../../unit/support/workspace.js";

let workspace: TestWorkspace;
let feature: string;
let map: UiChangeMap;

beforeAll(async () => {
  ({ workspace, feature } = await changeMapScenario());
  map = value(await changeMapView(await workspace.state(), feature));
  // Off by default: copy the recorded repository to try the Map tab by hand.
  //   VISP_MAP_DEMO=/tmp/visp-map-demo pnpm vitest run tests/integration/ui/change-map.test.ts
  //   visp ui --project /tmp/visp-map-demo
  if (process.env.VISP_MAP_DEMO)
    await cp(workspace.root, process.env.VISP_MAP_DEMO, { recursive: true });
}, 180_000);

afterAll(async () => {
  await workspace?.destroy();
});

const named = (name: string): UiMapNode => {
  const found = map.nodes.find((node) => node.name === name && node.role === "changed");
  if (!found) throw new Error(`No changed node ${name}: ${map.nodes.map((node) => node.id)}`);
  return found;
};

describe("changeMapView on a recorded feature", () => {
  it("diffs from the commit before the brief to the working tree", () => {
    expect(map.base.how).toBe("feature-start");
    expect(map.end).toEqual({ how: "working-tree" });
    expect(map.graph.state).toBe("current");
    expect(map.files.map((file) => file.path)).toEqual([
      "src/csv.mjs",
      "src/download.mjs",
      "src/report.mjs",
    ]);
  });

  it("seeds the changed declarations, not the blank line beside them", () => {
    expect(map.nodes.filter((node) => node.role === "changed").map((node) => node.id)).toEqual([
      "src/csv.mjs#function:cell",
      "src/download.mjs#function:download",
      "src/report.mjs#variable:COLUMNS",
      "src/report.mjs#function:header",
    ]);
  });

  it("says why a declaration changed and what covers it, with the stale run as stale", () => {
    const cell = named("cell");
    expect(cell.slices).toEqual([
      { id: "T002", via: "scope" },
      { id: "T002", via: "checkpoint" },
    ]);
    expect(cell.outcomes).toEqual(["O002"]);
    expect(cell.checks).toMatchObject([
      { id: "C002", via: "test-command", status: "passed", current: false },
    ]);
    expect(cell.findings).toMatchObject([{ required: false, via: "names-line" }]);
    expect(cell.afterCheckpoints).toBe(true);
    expect(cell.untested).toBe(false);
    expect(named("header").checks).toMatchObject([{ id: "C001", via: "declared" }]);
  });

  it("flags an edit no slice names and nothing tests", () => {
    const download = named("download");
    expect(download.slices).toEqual([]);
    expect(download.untested).toBe(true);
  });

  it("draws resolved relations solid and the name match dashed", () => {
    expect(map.edges.filter((edge) => !edge.resolved)).toEqual([
      {
        source: "src/download.mjs#file",
        target: "src/csv.mjs#function:cell",
        kind: "possible-call",
        resolved: false,
        at: "src/download.mjs: api.cell",
      },
    ]);
    expect(named("cell").unseenCallers).toEqual(["src/download.mjs: api.cell"]);
    expect(map.edges).toContainEqual({
      source: "src/report.mjs#function:header",
      target: "src/csv.mjs#function:row",
      kind: "calls",
      resolved: true,
      at: "src/report.mjs:6",
    });
    expect(map.nodes.find((node) => node.id === "test/csv.test.mjs#file")?.role).toBe("test");
    expect(map.nodes.some((node) => node.id.startsWith("test/csv.test.mjs#function"))).toBe(false);
  });

  it("orders reading by slice, then what no slice explains", () => {
    expect(map.readingOrder).toEqual([
      "src/report.mjs#variable:COLUMNS",
      "src/report.mjs#function:header",
      "src/csv.mjs#function:cell",
      "src/download.mjs#function:download",
    ]);
  });

  it("takes an explicit base and refuses one git does not know", async () => {
    const state = await workspace.state();
    const head = value(await changeMapView(state, feature, "HEAD"));
    expect(head.base).toMatchObject({ ref: "HEAD", how: "explicit" });
    const unknown = await changeMapView(state, feature, "no-such-branch");
    expect(unknown.ok ? undefined : unknown.error.code).toBe("ARTIFACT_MISSING");
    const option = await changeMapView(state, feature, "--output=x");
    expect(option.ok ? undefined : option.error.code).toBe("ARTIFACT_INVALID");
  });

  it("is served at /api/v1/features/:id/map", async () => {
    const assets = await mkdtemp(join(tmpdir(), "visp-map-assets-"));
    await writeFile(join(assets, "index.html"), "<!doctype html><title>visp</title>");
    const server = await startUiServer({ root: workspace.root, assetsDir: assets });
    try {
      const get = (path: string) =>
        fetch(`http://127.0.0.1:${server.port}${path}`, {
          headers: { cookie: `${cookieName(server.port)}=${server.token}` },
        });
      const answer = await get(`/api/v1/features/${feature}/map`);
      const body = (await answer.json()) as UiEnvelope<UiChangeMap>;
      expect(answer.status).toBe(200);
      expect(body.command).toBe("map");
      expect(body.data?.readingOrder).toEqual(map.readingOrder);
      const missing = await get(`/api/v1/features/${feature}/map?base=no-such-branch`);
      expect(missing.status).toBe(404);
    } finally {
      await server.close();
      await rm(assets, { recursive: true, force: true });
    }
  });

  it("without an index, shows changed files and says why there is nothing else", async () => {
    const state = await workspace.state();
    const store = state.paths.graphStore;
    await rename(store, `${store}.away`);
    try {
      const bare = value(await changeMapView(state, feature));
      expect(bare.graph.state).toBe("missing");
      expect(bare.nodes.map((node) => node.id)).toEqual([
        "src/csv.mjs#file",
        "src/download.mjs#file",
        "src/report.mjs#file",
      ]);
      expect(bare.edges).toEqual([]);
      expect(bare.notes.join(" ")).toContain("visp index");
    } finally {
      await rename(`${store}.away`, store);
    }
  });
});
