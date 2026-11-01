import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import { renderPreToolUseHook } from "../../../src/harness/hooks.js";
import type { ProductReviewBundle } from "../../../src/workflow/product/review/review.js";
import { succeeded, VALUE_SOURCE, VALUE_TEST } from "../../functional/support/product.js";
import { TestProject } from "../../functional/support/project.js";
import { moduleFeedback } from "../../unit/support/product-feedback.js";

/**
 * The Stop hook is shipped source, so it runs here against a stand-in `visp next` that
 * prints exactly the envelope a case needs, and against the real CLI for an accepted feature.
 */
describe("Stop hook step guard", () => {
  let root: string;
  let hook: string;
  let session = 0;

  const feature = "f1";
  const counts = () => join(root, ".visp/session/stop-blocks.json");

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "visp-stop-hook-"));
    await mkdir(join(root, ".visp/features", feature), { recursive: true });
    await writeFile(join(root, ".visp/project.json"), "{}");
    await writeFile(
      join(root, ".visp/status.json"),
      JSON.stringify({ activeFeature: feature, updatedAt: new Date().toISOString() }),
    );
    await writeFile(join(root, ".visp/features", feature, "product-state.json"), "{}");
    // A stand-in CLI: prints the envelope in FAKE_NEXT and records the observer marker.
    const fake = join(root, "fake-visp.mjs");
    await writeFile(
      fake,
      `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(join(root, "observer.txt"))}, process.env.VISP_OBSERVER ?? "");
process.stdout.write(process.env.FAKE_NEXT ?? "");
`,
    );
    hook = join(root, "hook.mjs");
    const rendered = renderPreToolUseHook().replace(
      /^const cli = .*;$/m,
      `const cli = ${JSON.stringify(fake)};`,
    );
    expect(rendered).toContain(JSON.stringify(fake));
    await writeFile(hook, rendered);
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  /** One Stop call from `who` (a fresh session by default) against the given `next`. */
  function stop(next: Record<string, unknown> | undefined, who = `s${++session}`): string {
    return execFileSync(process.execPath, [hook], {
      cwd: root,
      input: JSON.stringify({ hook_event_name: "Stop", session_id: who }),
      env: {
        ...process.env,
        CLAUDE_PROJECT_DIR: root,
        FAKE_NEXT: JSON.stringify({
          ok: true,
          data: { feature, evidence: [], mayEdit: true, ...next },
        }),
      },
      encoding: "utf8",
    });
  }
  const reason = (output: string): string => JSON.parse(output).reason;
  const work = (progress: string, extra: Record<string, unknown> = {}) => ({
    action: "implement",
    task: "T001",
    objective: "Change the auth module",
    command: `visp done --feature ${feature} --task T001`,
    progress,
    ...extra,
  });

  it("runs `next` as an observer", async () => {
    stop(work("p1"));
    expect(await readFile(join(root, "observer.txt"), "utf8")).toBe("stop-hook");
  });

  it("blocks an identical step twice at most, whether or not anything changed", () => {
    const who = "identical";
    expect(JSON.parse(stop(work("p1"), who))).toMatchObject({ decision: "block" });
    expect(JSON.parse(stop(work("p1"), who))).toMatchObject({ decision: "block" });
    expect(stop(work("p2"), who)).toBe("");
    expect(stop(work("p3"), who)).toBe("");
  });

  it("bounds a step the same way when the CLI reports no progress token", () => {
    const who = "no-progress";
    const bare = () => stop(work("", { progress: undefined }), who);
    expect(JSON.parse(bare())).toMatchObject({ decision: "block" });
    expect(JSON.parse(bare())).toMatchObject({ decision: "block" });
    expect(bare()).toBe("");
  });

  it("treats a different command shape as a different step", () => {
    const who = "distinct";
    stop(work("p1"), who);
    stop(work("p1"), who);
    expect(stop(work("p1"), who)).toBe("");
    const other = work("p1", { command: `visp verify --feature ${feature} --task T001` });
    expect(JSON.parse(stop(other, who))).toMatchObject({ decision: "block" });
    // Ids and values are not part of the step, flags and verbs are.
    const renamed = work("p1", { command: `visp verify --feature other --task T009` });
    expect(JSON.parse(stop(renamed, who))).toMatchObject({ decision: "block" });
    expect(stop(renamed, who)).toBe("");
    const action = work("p1", { action: "fix" });
    expect(JSON.parse(stop(action, who))).toMatchObject({ decision: "block" });
  });

  it("raises a handoff once, in the objective's own words", () => {
    const who = "handoff";
    const next = work("p1", {
      action: "accept",
      completion: "handoff",
      objective: "  The reviewer capacity is used up.  ",
      command: "visp pr",
    });
    const message = reason(stop(next, who));
    expect(message).toBe(
      `The reviewer capacity is used up. Run: visp pr once, then say in your final message what is still open and that ${feature} needs the human reviewer.`,
    );
    expect(message).not.toContain("Independent review");
    expect(stop(next, who)).toBe("");
    expect(stop({ ...next, progress: "p2" }, who)).toBe("");
  });

  // done or next already printed it with what is open; a block only cost a second final answer.
  it("lets the worker stop at a handoff that names no command", () => {
    const next = work("p1", {
      action: "fix",
      completion: "handoff",
      objective: "The independent review budget is spent. Run nothing more for it",
      command: undefined,
    });
    expect(stop(next, "handoff-done")).toBe("");
  });

  it("raises an unresolved environment once", () => {
    const who = "environment";
    const next = work("p1", {
      action: "understand",
      completion: "unresolved-environment",
      objective: "The browser cannot start",
      command: "visp verify",
    });
    expect(reason(stop(next, who))).toBe(
      `VISP cannot verify ${feature} until its execution environment works: The browser cannot start. Run: visp verify once. If it is still unavailable, say in your final message which capability is missing and that ${feature} is not verified; do not retry it repeatedly.`,
    );
    expect(stop({ ...next, progress: "p2" }, who)).toBe("");
  });

  it("writes one separator whether or not the objective ends in a period", () => {
    const withPeriod = reason(stop(work("p1", { objective: "Change the auth module." })));
    const without = reason(stop(work("p1", { objective: "Change the auth module" })));
    expect(withPeriod).toBe(without);
    expect(withPeriod).toBe(
      `VISP's next step for ${feature}: Change the auth module. Run: visp done --feature ${feature} --task T001. If your own \`visp next\` shows a different step, follow that one. If you cannot finish, say in your final message what is left and why.`,
    );
    expect(reason(stop(work("p1", { command: undefined })))).not.toContain("Run:");
  });

  it("stops after six blocks for one session and feature", () => {
    const who = "cap";
    const steps = Array.from({ length: 8 }, (_, index) =>
      work("p1", {
        task: `T00${index}`,
        action: index % 2 ? "fix" : "implement",
        command: `visp step${index}`,
      }),
    );
    const blocked = steps.map((step) => stop(step, who)).filter(Boolean);
    expect(blocked).toHaveLength(6);
  });

  it("drops counters older than a day", async () => {
    const who = "old";
    const old = new Date(Date.now() - 25 * 60 * 60_000).toISOString();
    await writeFile(
      counts(),
      JSON.stringify({
        version: 2,
        entries: { [`${who}:${feature}`]: { total: 6, at: old, fps: {} } },
      }),
    );
    expect(JSON.parse(stop(work("p1"), who))).toMatchObject({ decision: "block" });
    const stored = JSON.parse(await readFile(counts(), "utf8"));
    expect(stored.entries[`${who}:${feature}`].total).toBe(1);
  });
});

describe("Stop hook on an accepted feature", () => {
  let project: TestProject;
  let scratch: string;

  beforeAll(async () => {
    scratch = await mkdtemp(join(tmpdir(), "visp-stop-env-"));
    project = await TestProject.create({
      "src/value.mjs": VALUE_SOURCE,
      "tests/value.test.mjs": VALUE_TEST,
    });
    succeeded(project, "init", "--harness", "generic");
    const settings = parse(await project.read("visp.yml"));
    settings.critic = { ...settings.critic, enabled: false };
    await project.write("visp.yml", stringify(settings));
    succeeded(project, "install", "--harness", "claude-code", "--hooks", "claude", "git");
    project.commit("install product workflow");
    const created = project.json<{ brief: { feature: string } }>("feature", "Return two");
    const feature = created.envelope.data?.brief.feature ?? "";
    await project.authorBrief(feature, {
      outcomes: [
        {
          id: "O001",
          kind: "functional",
          statement: "The public value is two",
          priority: "must",
          provenance: "user-stated",
        },
      ],
      checks: [
        {
          id: "C001",
          command: [process.execPath, "--test", "tests/value.test.mjs"],
          outcomes: ["O001"],
          files: ["src/value.mjs", "tests/value.test.mjs"],
          environment: "node",
        },
      ],
      slices: [
        {
          id: "T001",
          goal: "Return the promised value",
          outcomes: ["O001"],
          scope: { allowed: ["src/**", "tests/**"], expected: ["src/value.mjs"], forbidden: [] },
          checks: ["C001"],
        },
      ],
    });
    succeeded(project, "work", "--task", "T001");
  });

  afterAll(async () => {
    await project?.destroy();
    await rm(scratch, { recursive: true, force: true });
  });

  const hookPath = () => join(project.root, ".visp/hooks/claude-pretooluse.mjs");
  const stop = (node: string, env: NodeJS.ProcessEnv, session: string): string =>
    execFileSync(node, [hookPath()], {
      cwd: project.root,
      input: JSON.stringify({ hook_event_name: "Stop", session_id: session }),
      env,
      encoding: "utf8",
    });

  it("sees `complete` from another PATH, locale, node path and an empty environment", async () => {
    // Before acceptance the same hook nudges: the silence below is the accepted state.
    expect(
      JSON.parse(
        stop(process.execPath, { ...project.env(), CLAUDE_PROJECT_DIR: project.root }, "before"),
      ),
    ).toMatchObject({
      decision: "block",
    });

    await project.write("src/value.mjs", "export const value = 2;\n");
    succeeded(project, "done", "--task", "T001");
    const review = project.json<ProductReviewBundle>("review").envelope.data;
    if (!review) throw new Error("Missing review bundle");
    await project.write(
      ".visp/drafts/review.json",
      JSON.stringify({
        subjectDigest: review.subjectDigest,
        feedback: moduleFeedback(review),
        assessments: [
          {
            outcome: "O001",
            status: "satisfied",
            summary:
              "The executed public-module assertion confirms value two and matches the preserved request",
            evidence: ["C001"],
          },
        ],
      }),
    );
    succeeded(project, "review", "--from", ".visp/drafts/review.json");
    succeeded(project, "accept");
    expect(project.json<{ action: string }>("next").envelope.data?.action).toBe("complete");

    // Another path to the same node binary: the worker's toolchain is not the hook's.
    const otherNode = join(scratch, "node-alias");
    await symlink(process.execPath, otherNode);
    const base = { ...process.env, CLAUDE_PROJECT_DIR: project.root };
    const environments: [string, string, NodeJS.ProcessEnv][] = [
      [
        "worker environment",
        process.execPath,
        { ...project.env(), CLAUDE_PROJECT_DIR: project.root },
      ],
      [
        "other PATH and locale",
        process.execPath,
        {
          ...base,
          PATH: "/usr/bin:/bin",
          LANG: "de_DE.UTF-8",
          LC_ALL: "C",
          TZ: "Asia/Tokyo",
          CI: "1",
          TERM: "dumb",
        },
      ],
      [
        "other node path",
        otherNode,
        { ...base, PATH: `${scratch}:${process.env.PATH ?? ""}`, LANG: "C" },
      ],
      ["browser override", process.execPath, { ...base, CHROME_BIN: join(scratch, "no-browser") }],
    ];
    for (const [index, [name, node, env]] of environments.entries())
      expect(stop(node, env, `after-${index}`), name).toBe("");

    // `env -i`: nothing inherited but a minimal PATH.
    const bare = execFileSync("env", ["-i", "PATH=/usr/bin:/bin", process.execPath, hookPath()], {
      cwd: project.root,
      input: JSON.stringify({ hook_event_name: "Stop", session_id: "bare" }),
      encoding: "utf8",
    });
    expect(bare).toBe("");
    const next = execFileSync(
      "env",
      [
        "-i",
        "PATH=/usr/bin:/bin",
        process.execPath,
        join(process.cwd(), "dist/cli.js"),
        "--project",
        project.root,
        "next",
        "--json",
      ],
      { cwd: project.root, encoding: "utf8" },
    );
    expect(JSON.parse(next).data.action).toBe("complete");
  });
});
