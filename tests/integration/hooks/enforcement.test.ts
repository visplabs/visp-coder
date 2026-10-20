import { execFileSync, spawnSync } from "node:child_process";
import { chmod, mkdir, rename, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GUARD_PROTOCOL_VERSION } from "../../../src/core/constants.js";
import {
  applyFileTransaction,
  recoverFileTransactions,
} from "../../../src/core/file-transaction.js";
import { runtimeIdentity } from "../../../src/core/version.js";
import { TestProject } from "../../functional/support/project.js";

/**
 * The generated hooks are shipped source: a syntax error or a wrong contract in
 * one of them silently disables enforcement, so they are executed here rather
 * than merely rendered.
 */
describe("generated hooks", () => {
  let project: TestProject;

  beforeAll(async () => {
    project = await TestProject.create({
      "src/auth/login.ts": "export const login = () => null;\n",
    });
    project.run("init", "--harness", "generic");
    project.run("install", "--harness", "claude-code", "--hooks", "claude", "git");

    await project.installShim();

    project.commit("add visp");
    await setUpTask(project);
  });

  afterAll(async () => {
    await project.destroy();
  });

  function callPreToolUse(
    filePath: string,
    env: NodeJS.ProcessEnv = project.env(),
  ): Record<string, unknown> {
    // Absolute node, so a case that empties PATH still reaches the interpreter.
    const output = execFileSync(
      process.execPath,
      [join(project.root, ".visp/hooks/claude-pretooluse.mjs")],
      {
        cwd: project.root,
        input: JSON.stringify({ tool_input: { file_path: filePath } }),
        encoding: "utf8",
        env,
      },
    );
    return output ? JSON.parse(output) : {};
  }

  function decision(response: Record<string, unknown>): string {
    const output = response.hookSpecificOutput as Record<string, string> | undefined;
    return output?.permissionDecision ?? "";
  }

  function callPreCommit(env: NodeJS.ProcessEnv): string {
    return execFileSync("/bin/sh", [join(project.root, ".git/hooks/pre-commit")], {
      cwd: project.root,
      encoding: "utf8",
      env,
    });
  }

  // Workers paraphrase requests; the host records the user's own words for `visp feature`.
  it("records each user prompt locally and registers for prompt events", async () => {
    const { readFile } = await import("node:fs/promises");
    for (const prompt of ["first request", 'Build the "quoted"\nmulti-line request'])
      execFileSync(process.execPath, [join(project.root, ".visp/hooks/claude-pretooluse.mjs")], {
        cwd: project.root,
        input: JSON.stringify({ hook_event_name: "UserPromptSubmit", prompt }),
        env: { ...project.env(), CLAUDE_PROJECT_DIR: project.root },
      });
    const recorded = (
      await readFile(join(project.root, ".visp/session/user-prompts.jsonl"), "utf8")
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line).prompt);
    expect(recorded).toEqual(["first request", 'Build the "quoted"\nmulti-line request']);
    const settings = JSON.parse(
      await readFile(join(project.root, ".claude/settings.json"), "utf8"),
    );
    expect(settings.hooks.UserPromptSubmit).toEqual([
      { hooks: [{ type: "command", command: expect.stringContaining("claude-pretooluse.mjs") }] },
    ]);
    expect(settings.hooks.Stop).toEqual([
      {
        hooks: [
          {
            type: "command",
            command: expect.stringContaining("claude-pretooluse.mjs"),
            timeout: 180,
          },
        ],
      },
    ]);
    const { rm } = await import("node:fs/promises");
    await rm(join(project.root, ".visp/session/user-prompts.jsonl"));
  });

  // Claude Code delivers a background command's completion as a prompt; VISP took one as the
  // user's request (bench run co1-conventions-carryover-prose-visp-dev-1).
  it("does not record a host task notification as a user prompt", async () => {
    const { readFile } = await import("node:fs/promises");
    const notification =
      '<task-notification>\n<task-id>bwvi3ofw5</task-id>\n<status>completed</status>\n<summary>Background command "Create VISP feature" completed (exit code 0)</summary>\n</task-notification>';
    for (const prompt of ["first request", notification])
      execFileSync(process.execPath, [join(project.root, ".visp/hooks/claude-pretooluse.mjs")], {
        cwd: project.root,
        input: JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: "s", prompt }),
        env: { ...project.env(), CLAUDE_PROJECT_DIR: project.root },
      });
    const recorded = (
      await readFile(join(project.root, ".visp/session/user-prompts.jsonl"), "utf8")
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line).prompt);
    expect(recorded).toEqual(["first request"]);
    await rm(join(project.root, ".visp/session/user-prompts.jsonl"));
  });

  it("records a session started in a subdirectory at the initialized root", async () => {
    const { readFile } = await import("node:fs/promises");
    const nested = join(project.root, "src/auth");
    execFileSync(process.execPath, [join(project.root, ".visp/hooks/claude-pretooluse.mjs")], {
      cwd: nested,
      input: JSON.stringify({
        hook_event_name: "UserPromptSubmit",
        cwd: nested,
        prompt: "nested request",
      }),
      env: { ...project.env(), CLAUDE_PROJECT_DIR: "" },
    });
    expect(
      await readFile(join(project.root, ".visp/session/user-prompts.jsonl"), "utf8"),
    ).toContain("nested request");
    await rm(join(project.root, ".visp/session/user-prompts.jsonl"));
  });

  // Weak workers stopped with slices open; the Stop hook nudges them back to the next
  // step, at most twice per identical step and only again once something changed.
  describe("Stop hook", () => {
    const blocks = join(".visp", "session", "stop-blocks.json");
    const stop = (session = "first"): string =>
      execFileSync(process.execPath, [join(project.root, ".visp/hooks/claude-pretooluse.mjs")], {
        cwd: project.root,
        input: JSON.stringify({
          hook_event_name: "Stop",
          stop_hook_active: false,
          session_id: session,
        }),
        env: { ...project.env(), CLAUDE_PROJECT_DIR: project.root },
        encoding: "utf8",
      });

    afterAll(async () => {
      await rm(join(project.root, blocks), { recursive: true, force: true });
    });

    it("blocks the same step twice, names it, then stays silent", () => {
      const first = JSON.parse(stop());
      expect(first).toMatchObject({ decision: "block" });
      expect(first.reason).toContain(
        "VISP's next step for 001-scoped-work: Change the auth module. Run: visp done",
      );
      expect(first.reason).toContain(
        "If your own `visp next` shows a different step, follow that one.",
      );
      expect(first.reason).not.toContain("Continue until");
      expect(JSON.parse(stop())).toMatchObject({ decision: "block" });
      expect(stop()).toBe("");
    });

    it("does not block the same step a third time even after the feature changed", () => {
      expect(project.run("verify", "--task", "T001").exitCode).toBe(0);
      expect(stop()).toBe("");
    });

    it("counts each session separately", () => {
      expect(JSON.parse(stop("second"))).toMatchObject({ decision: "block" });
      expect(JSON.parse(stop("second"))).toMatchObject({ decision: "block" });
      expect(stop("second")).toBe("");
    });

    it("ignores counters written in the old flat format", async () => {
      await writeFile(
        join(project.root, blocks),
        JSON.stringify({ "third:001-scoped-work:work": 3 }),
      );
      expect(JSON.parse(stop("third"))).toMatchObject({ decision: "block" });
      await rm(join(project.root, blocks));
    });

    it("does not block when the counter cannot be written", async () => {
      // A directory in the counter's place cannot be renamed over.
      await rm(join(project.root, blocks), { recursive: true, force: true });
      await mkdir(join(project.root, blocks, "keep"), { recursive: true });
      expect(stop("fourth")).toBe("");
      await rm(join(project.root, blocks), { recursive: true });
    });

    it("skips a feature whose state has not moved for an hour, and keys recency on the state file", async () => {
      const { readFile } = await import("node:fs/promises");
      const statusFile = join(project.root, ".visp/status.json");
      const stateFile = join(project.root, ".visp/features/001-scoped-work/product-state.json");
      const original = await readFile(statusFile, "utf8");
      const stateTimes = await stat(stateFile);
      const old = new Date(Date.now() - 61 * 60_000);
      try {
        await writeFile(
          statusFile,
          JSON.stringify({ ...JSON.parse(original), updatedAt: old.toISOString() }),
        );
        // A fresh state file keeps an hour-old status.json current.
        expect(JSON.parse(stop("fifth"))).toMatchObject({ decision: "block" });
        await utimes(stateFile, old, old);
        expect(stop("sixth")).toBe("");
      } finally {
        await writeFile(statusFile, original);
        await utimes(stateFile, stateTimes.atime, stateTimes.mtime);
        await rm(join(project.root, blocks), { force: true });
      }
    });
  });

  // A worker hand-edited the brief, left it unreadable and abandoned the workflow.
  it("refuses agent edits of VISP state except drafts", () => {
    expect(decision(callPreToolUse(".visp/features/x/brief.yaml"))).toBe("deny");
    expect(decision(callPreToolUse(".visp/drafts/assessment.json"))).toBe("");
  });

  // Workers backgrounded visp done and accept (15 s commands), then waited up to 9 minutes
  // in polling loops that never ended on their own.
  it("sends backgrounded VISP workflow commands to the foreground and leaves servers alone", () => {
    const run = (command: string, background: boolean) => {
      const output = execFileSync(
        process.execPath,
        [join(project.root, ".visp/hooks/claude-pretooluse.mjs")],
        {
          cwd: project.root,
          input: JSON.stringify({
            tool_name: "Bash",
            tool_input: { command, ...(background ? { run_in_background: true } : {}) },
          }),
          env: { ...project.env(), CLAUDE_PROJECT_DIR: project.root },
          encoding: "utf8",
        },
      );
      return output ? JSON.parse(output) : {};
    };
    const refusal = (verb: string) =>
      `Run \`visp ${verb}\` by itself in the foreground, not in a loop: repeat it without run_in_background and with timeout 600000. It prints its result and the next step; while a review runs, \`visp next\` waits for it. If the host moves the command to the background, wait for its completion notice, then run \`visp next\`; do not poll with pgrep, tail -f or sleep loops.`;
    const loopRefusal = (verb: string) =>
      `Run \`visp ${verb}\` by itself, not in a loop, with the host's maximum shell timeout. It prints its result and the next step; while a review runs, \`visp next\` waits for it. Do not poll with pgrep, tail -f or sleep loops.`;
    for (const [command, verb] of <const>[
      ["visp done --feature 001-x --task T001 2>&1", "done"],
      ["export PATH=/opt/shim:$PATH && visp accept --feature 001-x", "accept"],
      ["cd /p && /opt/shim/visp next | head -50", "next"],
      ["cd x && visp done", "done"],
      ["npx @visporg/visp-coder done", "done"],
      ["npx -y @visporg/visp-coder@beta verify", "verify"],
      [`${join(project.root, ".bin/visp")} status`, "status"],
      ['bash -c "visp done"', "done"],
      ["sudo visp done", "done"],
      ["timeout -s KILL 600 visp done", "done"],
      ["( visp done )", "done"],
      ["x=$(visp next); echo $x", "next"],
      // Arithmetic is not a heredoc: the line after it is still a command.
      ["echo $((1<<2))\nvisp done", "done"],
      // A loop elsewhere in the line does not make this a loop around visp.
      ["for f in tests/*.py; do python $f; done && visp verify", "verify"],
      ["visp done; for f in *.log; do tail -3 $f; done", "done"],
    ]) {
      const response = run(command, true);
      expect(decision(response), command).toBe("deny");
      expect(response.hookSpecificOutput.permissionDecisionReason, command).toBe(refusal(verb));
      expect(decision(run(command, false)), command).toBe("");
    }
    // A loop around a workflow command waits up to the host's timeout, in the foreground too.
    for (const [command, verb] of <const>[
      ["until visp status | grep -q accepted; do sleep 10; done", "status"],
      ["while true; do visp next; sleep 30; done", "next"],
      ["watch -n 5 visp status", "status"],
      ['until [ "$(visp status --json | jq -r .phase)" = accepted ]; do sleep 10; done', "status"],
      ["until [ `visp status` = ok ]; do sleep 2; done", "status"],
      ["bash -c 'until visp status; do sleep 1; done'", "status"],
    ])
      for (const background of [true, false]) {
        const response = run(command, background);
        expect(decision(response), command).toBe("deny");
        // Codex runs the same hook and has no run_in_background, so a foreground loop's
        // refusal names no Claude Code setting.
        expect(response.hookSpecificOutput.permissionDecisionReason, command).toBe(
          background ? refusal(verb) : loopRefusal(verb),
        );
      }
    // Only visp itself, as the command, counts: not text that mentions it.
    for (const command of [
      'echo "visp done"',
      "grep visp README.md",
      "grep -rn visp done",
      "git commit -m 'visp done'",
      "visp ui --port 4000",
      "npm run dev",
      "while pgrep -f node; do sleep 5; done",
      'git commit -m "fix: make visp done faster"',
      "echo '$(visp done)'",
    ])
      expect(decision(run(command, true)), command).toBe("");
    // feature keeps writing acceptance tests after it prints the id the worker continues with,
    // and a request in its heredoc is text, not commands.
    expect(
      decision(
        run(
          "visp feature \"Build it\" --source-brief - <<'REQUEST'\nBuild it, then show visp status\nvisp done\nREQUEST",
          true,
        ),
      ),
    ).toBe("");
  });

  // A worker ran rm -rf .visp acceptance to get past a scope error it could not read.
  it("refuses shell commands that would delete VISP state and leaves others to the host", async () => {
    const shell = (command: string) =>
      execFileSync(process.execPath, [join(project.root, ".visp/hooks/claude-pretooluse.mjs")], {
        cwd: project.root,
        input: JSON.stringify({ tool_name: "Bash", tool_input: { command } }),
        env: { ...project.env(), CLAUDE_PROJECT_DIR: project.root },
        encoding: "utf8",
      });
    expect(decision(JSON.parse(shell("rm -rf .visp acceptance")))).toBe("deny");
    expect(decision(JSON.parse(shell("git clean -fd")))).toBe("deny");
    expect(decision(JSON.parse(shell("git clean -f")))).toBe("deny");
    // A dry run deletes nothing: it is how a worker looks before it decides.
    for (const dry of [
      "git clean -n",
      "git clean -nd",
      "git clean -fdn",
      "git clean -fd --dry-run",
      "git clean --dry-run",
    ])
      expect(shell(dry), dry).toBe("");
    expect(shell("python3 acceptance/x/test.py")).toBe("");
    expect(shell("git stash")).toBe("");
    expect(shell("node --test acceptance/ && rm -rf dist")).toBe("");
    expect(shell("git checkout main && ls acceptance")).toBe("");
    expect(shell('git commit -m "fix rm handling in acceptance tests"')).toBe("");
    expect(decision(JSON.parse(shell("find .visp -delete")))).toBe("deny");
    const { readFile } = await import("node:fs/promises");
    const settings = JSON.parse(
      await readFile(join(project.root, ".claude/settings.json"), "utf8"),
    );
    expect(settings.hooks.PreToolUse).toContainEqual({
      matcher: "Bash",
      hooks: [{ type: "command", command: expect.stringContaining("claude-pretooluse.mjs") }],
    });
  });

  it.each(["missing", "different"])("ignores a PATH guard with %s build identity", async (kind) => {
    const envelope = {
      command: "guard",
      ok: true,
      data: {
        protocolVersion: GUARD_PROTOCOL_VERSION,
        checked: 1,
        allowed: true,
        violations: [],
        authorizedTasks: ["T001"],
        ...(kind === "different"
          ? { runtime: { ...runtimeIdentity(), buildId: "0123456789abcdef" } }
          : {}),
      },
    };
    const env = await fakeGuardEnv(
      project,
      `.identity-${kind}`,
      `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(JSON.stringify(envelope))});\n`,
    );
    expect(callPreToolUse("src/auth/login.ts", env)).toEqual({});
    expect(callPreCommit(env)).toBe("");
  });

  it("runs without a syntax error and allows an in-scope write", () => {
    expect(decision(callPreToolUse("src/auth/login.ts"))).toBe("");
  });

  it("leaves Claude's normal permission decision in place outside the project", () => {
    expect(callPreToolUse(join(project.root, "../.claude/plans/draft.md"))).toEqual({});
  });

  it.skipIf(process.platform === "win32")(
    "accepts the symlinked spelling of an in-scope path",
    async () => {
      const alias = `${project.root}-alias`;
      await symlink(project.root, alias, "dir");
      try {
        expect(callPreToolUse(join(alias, "src/auth/login.ts"))).toEqual({});
      } finally {
        await rm(alias);
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "refuses an in-scope symlink that resolves to a blocked file",
    async () => {
      await project.write(".env", "SECRET=fixture\n");
      const link = join(project.root, "src/auth/settings.ts");
      await symlink("../../.env", link);
      try {
        expect(decision(callPreToolUse("src/auth/settings.ts"))).toBe("deny");
      } finally {
        await rm(link);
        await rm(join(project.root, ".env"));
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "refuses a dangling link that would write outside the project",
    async () => {
      const link = join(project.root, "src/auth/leak.ts");
      await symlink(join(project.root, "../outside-leak.ts"), link);
      try {
        const response = callPreToolUse("src/auth/leak.ts");
        expect(decision(response)).toBe("deny");
        expect(
          (response.hookSpecificOutput as Record<string, string>).permissionDecisionReason,
        ).toContain("resolves outside");
      } finally {
        await rm(link);
      }
    },
  );

  it("allows ordinary edits when the pinned CLI is unavailable and no task is active", async () => {
    const { readFile } = await import("node:fs/promises");
    const hook = join(project.root, ".visp/hooks/claude-pretooluse.mjs");
    const original = await readFile(hook, "utf8");
    const marker = join(project.root, ".visp/state/product-authorizations");
    const parked = `${marker}.parked`;
    await writeFile(hook, original.replace(/const cli = .*;/, 'const cli = "/missing/visp.js";'));
    try {
      expect(decision(callPreToolUse("src/auth/login.ts"))).toBe("deny");
      await rename(marker, parked);
      try {
        expect(callPreToolUse("README.md")).toEqual({});
      } finally {
        await rename(parked, marker);
      }
    } finally {
      await writeFile(hook, original);
    }
  });

  /**
   * A broken install is not a scope violation. Denying is still right — a hook
   * that cannot check must not allow — but reporting it as an out-of-scope path
   * sends someone to edit allowedFiles to fix a missing binary.
   */
  it("uses the installed CLI when visp is absent from PATH", () => {
    const response = callPreToolUse("src/auth/login.ts", {
      ...project.env(),
      PATH: "/nonexistent",
    });
    expect(response).toEqual({});
  });

  it("denies a write outside the task's scope", () => {
    const response = callPreToolUse("src/billing/invoice.ts");
    expect(decision(response)).toBe("deny");

    const output = response.hookSpecificOutput as Record<string, string>;
    expect(output.permissionDecisionReason).toContain("src/billing/invoice.ts");
  });

  it("denies a blocked path without suggesting a gate that would not help", () => {
    const response = callPreToolUse(".env");
    const output = response.hookSpecificOutput as Record<string, string>;

    expect(decision(response)).toBe("deny");
    expect(output.permissionDecisionReason).toContain("blocked");
    expect(output.permissionDecisionReason).not.toContain("gate implement");
  });

  it("denies traversal disguised as a VISP state write", () => {
    const response = callPreToolUse(".visp/../src/billing/invoice.ts");
    const output = response.hookSpecificOutput as Record<string, string>;

    expect(decision(response)).toBe("deny");
    expect(output.permissionDecisionReason).toContain("project-relative path");
  });

  it("allows a tool call that touches no file", () => {
    // Absolute node, so a case that empties PATH still reaches the interpreter.
    const output = execFileSync(
      process.execPath,
      [join(project.root, ".visp/hooks/claude-pretooluse.mjs")],
      {
        cwd: project.root,
        input: JSON.stringify({ tool_input: { command: "ls" } }),
        encoding: "utf8",
      },
    );
    expect(output).toBe("");
  });

  /**
   * `.claude/settings.json` is committed; `.visp/hooks/` and `.visp/state/` are not. A fresh
   * clone runs the committed commands with no script, which must not block every edit, while
   * deleting the script during an authorized slice must not switch enforcement off.
   */
  describe.skipIf(process.platform === "win32")("settings command without the hook script", () => {
    const script = () => join(project.root, ".visp/hooks/claude-pretooluse.mjs");
    const authorizations = () => join(project.root, ".visp/state/product-authorizations");

    async function settingsCommand(event: "edit" | "Bash" | "UserPromptSubmit" | "Stop") {
      const settings = JSON.parse(await project.read(".claude/settings.json")) as {
        hooks: Record<string, { matcher?: string; hooks: { command: string }[] }[]>;
      };
      const entries =
        event === "edit" || event === "Bash" ? settings.hooks.PreToolUse : settings.hooks[event];
      const matcher =
        event === "edit" ? "Edit|Write|NotebookEdit" : event === "Bash" ? "Bash" : undefined;
      const entry = entries?.find((candidate) => candidate.matcher === matcher);
      if (!entry?.hooks[0]) throw new Error(`no ${event} entry`);
      return entry.hooks[0].command;
    }

    async function runSettings(
      event: "edit" | "Bash" | "UserPromptSubmit" | "Stop",
      { root = project.root, env = project.env() }: { root?: string; env?: NodeJS.ProcessEnv } = {},
    ) {
      const input =
        event === "edit"
          ? { hook_event_name: "PreToolUse", tool_input: { file_path: "src/billing/invoice.ts" } }
          : event === "Bash"
            ? { hook_event_name: "PreToolUse", tool_input: { command: "ls" } }
            : { hook_event_name: event, prompt: "hello" };
      const result = spawnSync("/bin/sh", ["-c", await settingsCommand(event)], {
        cwd: root,
        env: { ...env, CLAUDE_PROJECT_DIR: root },
        input: JSON.stringify(input),
        encoding: "utf8",
      });
      return { status: result.status, stdout: result.stdout, stderr: result.stderr };
    }

    async function withoutScript<T>(action: () => Promise<T>): Promise<T> {
      await rename(script(), `${script()}.parked`);
      try {
        return await action();
      } finally {
        await rename(`${script()}.parked`, script());
      }
    }

    async function withAuthorizations<T>(
      replacement: ((path: string) => Promise<void>) | undefined,
      action: () => Promise<T>,
    ): Promise<T> {
      await rename(authorizations(), `${authorizations()}.parked`);
      try {
        await replacement?.(authorizations());
        return await action();
      } finally {
        await rm(authorizations(), { recursive: true, force: true });
        await rename(`${authorizations()}.parked`, authorizations());
      }
    }

    const noNode = () => ({ ...project.env(), PATH: "/nonexistent" });

    it("stays silent with no authorization, with or without node", async () => {
      await withoutScript(() =>
        withAuthorizations(undefined, async () => {
          expect(await runSettings("edit")).toEqual({ status: 0, stdout: "", stderr: "" });
          expect(await runSettings("edit", { env: noNode() })).toEqual({
            status: 0,
            stdout: "",
            stderr: "",
          });
        }),
      );
    });

    it("refuses an edit while a slice is authorized, with or without node", async () => {
      await withoutScript(async () => {
        for (const env of [project.env(), noNode()]) {
          const result = await runSettings("edit", { env });
          expect(result.status).toBe(2);
          expect(result.stdout).toBe("");
          expect(result.stderr).toContain("visp install --harness claude-code");
        }
      });
    });

    it("runs the script as before when it is present", async () => {
      const result = await runSettings("edit");
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual(callPreToolUse("src/billing/invoice.ts"));
      expect(decision(JSON.parse(result.stdout))).toBe("deny");
    });

    it("leaves prompts, Stop and shell commands alone", async () => {
      await withoutScript(async () => {
        for (const event of ["Bash", "UserPromptSubmit", "Stop"] as const)
          expect(await runSettings(event)).toEqual({ status: 0, stdout: "", stderr: "" });
      });
    });

    it("allows edits in a fresh clone that has not run visp install", async () => {
      const clone = `${project.root}-clone`;
      execFileSync("git", ["clone", "--quiet", project.root, clone], { env: project.env() });
      try {
        await expect(stat(join(clone, ".claude/settings.json"))).resolves.toBeDefined();
        await expect(stat(join(clone, ".visp/hooks"))).rejects.toThrow();
        await expect(stat(join(clone, ".visp/state"))).rejects.toThrow();
        expect(await runSettings("edit", { root: clone })).toEqual({
          status: 0,
          stdout: "",
          stderr: "",
        });
      } finally {
        await rm(clone, { recursive: true, force: true });
      }
    });

    it("fails closed when the authorization directory is a link or unreadable", async () => {
      const elsewhere = `${project.root}-linked-state`;
      await mkdir(elsewhere, { recursive: true });
      try {
        await withoutScript(async () => {
          await writeFile(join(elsewhere, "001-scoped-work.json"), "{}");
          await withAuthorizations(
            (path) => symlink(elsewhere, path, "dir"),
            async () => expect((await runSettings("edit")).status).toBe(2),
          );
          await rm(join(elsewhere, "001-scoped-work.json"));
          await withAuthorizations(
            (path) => symlink(elsewhere, path, "dir"),
            async () => expect((await runSettings("edit")).status).toBe(2),
          );
          // Root reads any directory, so the permission case only means something otherwise.
          if (process.getuid?.() !== 0) {
            await withAuthorizations(
              async (path) => {
                await mkdir(path);
                await chmod(path, 0o000);
              },
              async () => {
                try {
                  expect((await runSettings("edit")).status).toBe(2);
                } finally {
                  await chmod(authorizations(), 0o755);
                }
              },
            );
          }
        });
      } finally {
        await rm(elsewhere, { recursive: true, force: true });
      }
    });
  });

  it("refuses a commit whose staged files are out of scope", async () => {
    await project.write("src/billing/invoice.ts", "export const invoice = () => 1;\n");
    project.git("add", "src/billing/invoice.ts");

    expect(() =>
      execFileSync("git", ["commit", "-m", "out of scope"], {
        cwd: project.root,
        encoding: "utf8",
        env: project.env(),
      }),
    ).toThrow();

    project.git("reset", "-q");
  });

  it("refuses a commit after an ignored environment file changes", async () => {
    await project.write(".env", "SECRET=fixture\n");
    try {
      expect(() => callPreCommit(project.env())).toThrow();
    } finally {
      await rm(join(project.root, ".env"));
    }
  });

  it("fails closed when visp is unavailable and an authorization is active", () => {
    expect(() => callPreCommit({ ...project.env(), PATH: "/usr/bin:/bin" })).toThrow();
  });

  it("warns but allows an unchecked commit when no authorization is active", async () => {
    const markers = join(project.root, ".visp/state/product-authorizations");
    const parked = `${markers}.parked`;
    await rename(markers, parked);
    try {
      expect(callPreCommit({ ...project.env(), PATH: "/usr/bin:/bin" })).toBe("");
    } finally {
      await rename(parked, markers);
    }
  });

  it("ignores malformed guard output from a PATH shadow", async () => {
    const env = await malformedGuardEnv(project);

    expect(callPreCommit(env)).toBe("");
  });

  it("ignores an underspecified legacy guard on PATH", async () => {
    const env = await fakeGuardEnv(
      project,
      ".old-bin",
      '#!/bin/sh\necho \'{"command":"guard","ok":true,"data":{"allowed":true}}\'\n',
    );

    expect(callPreCommit(env)).toBe("");
    expect(callPreToolUse("src/auth/login.ts", env)).toEqual({});
  });

  it("fails closed when interrupted closure removed the marker before commit", async () => {
    const marker = ".visp/state/product-authorizations/001-scoped-work.json";
    const interrupted = await applyFileTransaction(
      project.root,
      "interrupted-task-closure",
      [{ kind: "remove", path: marker }],
      {
        afterMutation() {
          throw new Error("simulated process exit");
        },
        leavePreparedOnError: true,
      },
    );
    expect(interrupted.ok).toBe(false);
    try {
      expect(() => callPreCommit(project.env())).toThrow();
    } finally {
      const recovered = await recoverFileTransactions(project.root);
      expect(recovered.ok).toBe(true);
    }
  });

  it("allows an unchecked commit when only a stale done-task marker remains", async () => {
    await project.editArtifact("001-scoped-work", "product-state.json", (state) => ({
      ...state,
      slices: {
        ...(state.slices as Record<string, unknown>),
        T001: {
          ...(state.slices as Record<string, Record<string, unknown>>).T001,
          status: "closed",
        },
      },
    }));
    try {
      expect(
        callPreCommit({ ...project.env(), PATH: `${dirname(process.execPath)}:/usr/bin:/bin` }),
      ).toBe("");
    } finally {
      await project.editArtifact("001-scoped-work", "product-state.json", (state) => ({
        ...state,
        slices: {
          ...(state.slices as Record<string, unknown>),
          T001: {
            ...(state.slices as Record<string, Record<string, unknown>>).T001,
            status: "in-progress",
          },
        },
      }));
    }
  });

  it.each([2, 99])(
    "fails closed on unrecognized state generation %i even for a closed slice",
    async (version) => {
      let original: Record<string, unknown> = {};
      await project.editArtifact("001-scoped-work", "product-state.json", (state) => {
        original = state;
        const slices = state.slices as Record<string, Record<string, unknown>>;
        return {
          ...state,
          version,
          slices: { ...slices, T001: { ...slices.T001, status: "closed" } },
        };
      });
      try {
        expect(() => callPreCommit({ ...project.env(), PATH: "/usr/bin:/bin" })).toThrow();
      } finally {
        await project.editArtifact("001-scoped-work", "product-state.json", () => original);
      }
    },
  );

  it("fails closed when a malformed guard follows missing product state", async () => {
    const path = join(project.root, ".visp/features/001-scoped-work/product-state.json");
    const parked = `${path}.parked`;
    await rename(path, parked);
    try {
      const env = await malformedGuardEnv(project);
      expect(() => callPreCommit(env)).toThrow();
    } finally {
      await rename(parked, path);
    }
  });
});

/**
 * A first session ended with its slice open after the review budget ran out. A later
 * session with a new request then edited under that leftover authorization and never
 * started the workflow for its own request.
 */
describe("edit authorization across host sessions", () => {
  let project: TestProject;
  const hook = () => join(project.root, ".visp/hooks/claude-pretooluse.mjs");
  const env = () => ({ ...project.env(), CLAUDE_PROJECT_DIR: project.root });

  beforeAll(async () => {
    project = await TestProject.create({
      "src/auth/login.ts": "export const login = () => null;\n",
    });
    project.run("init", "--harness", "generic");
    project.run("install", "--harness", "claude-code", "--hooks", "claude", "git");
    await project.installShim();
    project.commit("add visp");
  });

  afterAll(async () => {
    await project.destroy();
  });

  function prompt(session: string, text: string): void {
    execFileSync(process.execPath, [hook()], {
      cwd: project.root,
      input: JSON.stringify({
        hook_event_name: "UserPromptSubmit",
        session_id: session,
        prompt: text,
      }),
      env: env(),
    });
  }

  function write(path: string, session: string): { decision: string; reason: string } {
    const raw = execFileSync(process.execPath, [hook()], {
      cwd: project.root,
      input: JSON.stringify({ session_id: session, tool_input: { file_path: path } }),
      encoding: "utf8",
      env: env(),
    });
    const output = raw ? (JSON.parse(raw).hookSpecificOutput as Record<string, string>) : {};
    return {
      decision: output.permissionDecision ?? "",
      reason: output.permissionDecisionReason ?? "",
    };
  }

  it("refuses edits under an authorization from an earlier session and names both ways on", async () => {
    const { readFile } = await import("node:fs/promises");
    prompt("session-1", "Change the auth module");
    await setUpTask(project);
    expect(write("src/auth/login.ts", "session-1").decision).toBe("");
    const authorization = join(
      project.root,
      ".visp/state/product-authorizations/001-scoped-work.json",
    );
    const baseline = JSON.parse(await readFile(authorization, "utf8")).baseline;

    prompt("session-2", "Add prices to items");
    const refused = write("src/auth/login.ts", "session-2");
    expect(refused.decision).toBe("deny");
    expect(refused.reason).toContain("earlier session");
    expect(refused.reason).toContain("visp feature");
    expect(refused.reason).toContain("visp work --task T001");
    // Asked what to do, VISP sent that worker back to the old task, where it built the new
    // request with no feature of its own; the request no feature has taken starts one.
    const next = project.run("next", "--json");
    expect(next.stdout).toContain('visp feature \\"<the user\'s request>\\"');
    expect(next.stdout).not.toMatch(/"task":\s*"T001"/);
    const stopped = execFileSync(process.execPath, [hook()], {
      cwd: project.root,
      input: JSON.stringify({ hook_event_name: "Stop", session_id: "session-2" }),
      encoding: "utf8",
      env: env(),
    });
    expect(stopped).toBe("");

    // A follow-up in the same session keeps the authorization it re-confirms.
    const worked = project.run("work", "--task", "T001");
    expect(worked.exitCode, worked.stdout + worked.stderr).toBe(0);
    prompt("session-2", "Also keep the login response unchanged");
    expect(write("src/auth/login.ts", "session-2").decision).toBe("");
    expect(JSON.parse(await readFile(authorization, "utf8")).baseline).toEqual(baseline);
  });

  // Two sessions in one checkout: the latest prompt came from another session, but the
  // hook names the session that is editing, and only the one that ran `visp work` may.
  it("leaves an anonymous grant unstamped when several sessions are active", () => {
    prompt("session-3", "Unrelated question in another window");
    expect(write("src/auth/login.ts", "session-2").decision).toBe("");
    expect(write("src/auth/login.ts", "session-3").decision).toBe("");
  });

  it("does not use a shell heartbeat to guess an anonymous caller among active sessions", async () => {
    const { readFile } = await import("node:fs/promises");
    execFileSync(process.execPath, [hook()], {
      cwd: project.root,
      input: JSON.stringify({
        session_id: "session-4",
        tool_name: "Bash",
        tool_input: { command: "visp work --task T001" },
      }),
      env: env(),
    });
    const worked = project.run("work", "--task", "T001");
    expect(worked.exitCode, worked.stdout + worked.stderr).toBe(0);
    const authorization = join(
      project.root,
      ".visp/state/product-authorizations/001-scoped-work.json",
    );
    expect(JSON.parse(await readFile(authorization, "utf8")).session).toBeUndefined();
    expect(write("src/auth/login.ts", "session-4").decision).toBe("");
    expect(write("src/auth/login.ts", "session-2").decision).toBe("");
  });
});

/**
 * `visp feature` refused a working tree holding a previous session's uncommitted work,
 * and the worker discarded that work with `git checkout <files>` to get a clean tree.
 */
describe("shell commands that would discard uncommitted work", () => {
  let project: TestProject;

  beforeAll(async () => {
    project = await TestProject.create({
      "src/auth/login.ts": "export const login = () => null;\n",
      "src/auth/token.ts": "export const token = () => null;\n",
      "src/auth/foo bar.ts": "export const spaced = 1;\n",
    });
    project.run("init", "--harness", "generic");
    project.run("install", "--harness", "claude-code", "--hooks", "claude", "git");
    await project.installShim();
    project.commit("add visp");
    await project.write("src/auth/login.ts", "export const login = () => 'earlier work';\n");
    await project.write("src/auth/foo bar.ts", "export const spaced = 2;\n");
  });

  afterAll(async () => {
    await project.destroy();
  });

  function shell(command: string): string {
    const output = execFileSync(
      process.execPath,
      [join(project.root, ".visp/hooks/claude-pretooluse.mjs")],
      {
        cwd: project.root,
        input: JSON.stringify({ tool_name: "Bash", tool_input: { command } }),
        env: { ...project.env(), CLAUDE_PROJECT_DIR: project.root },
        encoding: "utf8",
      },
    );
    return output ? (JSON.parse(output).hookSpecificOutput?.permissionDecision ?? "") : "";
  }

  it.each([
    "git checkout README.md src/auth/login.ts",
    `cd ${"$"}PWD && git checkout -- src/auth/login.ts`,
    "git checkout .",
    "git checkout src",
    "git restore src/auth/login.ts",
    "git reset --hard",
    "git reset --hard HEAD",
    // Review: shell quoting and forced modes also discard work.
    "git checkout -- 'src/auth/foo bar.ts'",
    'git checkout "src/auth/foo bar.ts"',
    "git checkout -f main",
    "git checkout --force main",
    "git switch --discard-changes main",
  ])("refuses %s", (command) => {
    expect(shell(command)).toBe("deny");
  });

  it.each([
    "git checkout src/auth/token.ts",
    "git checkout -b next-feature",
    "git restore --staged src/auth/login.ts",
    "git reset",
    "git status",
    "git add -A && git commit -m 'earlier work'",
  ])("leaves %s to the host", (command) => {
    expect(shell(command)).toBe("");
  });
});

// A hard reset to a commit that tracks a path deletes the untracked file there.
describe("hard resets over untracked work", () => {
  let project: TestProject;

  beforeAll(async () => {
    project = await TestProject.create({ "src/app.ts": "export const app = 1;\n" });
    project.run("init", "--harness", "generic");
    project.run("install", "--harness", "claude-code", "--hooks", "claude", "git");
    await project.installShim();
    project.commit("add visp");
    await project.write("src/new-work.ts", "export const earlier = true;\n");
  });

  afterAll(async () => {
    await project.destroy();
  });

  it("refuses a hard reset while untracked work exists", () => {
    const output = execFileSync(
      process.execPath,
      [join(project.root, ".visp/hooks/claude-pretooluse.mjs")],
      {
        cwd: project.root,
        input: JSON.stringify({
          tool_name: "Bash",
          tool_input: { command: "git reset --hard HEAD^" },
        }),
        env: { ...project.env(), CLAUDE_PROJECT_DIR: project.root },
        encoding: "utf8",
      },
    );
    expect(JSON.parse(output).hookSpecificOutput.permissionDecision).toBe("deny");
  });
});

async function malformedGuardEnv(project: TestProject): Promise<NodeJS.ProcessEnv> {
  return fakeGuardEnv(project, ".bad-bin", "#!/bin/sh\necho not-json\n");
}

async function fakeGuardEnv(
  project: TestProject,
  directory: string,
  source: string,
): Promise<NodeJS.ProcessEnv> {
  const bin = join(project.root, directory);
  await mkdir(bin, { recursive: true });
  const fake = join(bin, "visp");
  await writeFile(fake, source, "utf8");
  await chmod(fake, 0o755);
  return { ...project.env(), PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin` };
}

async function setUpTask(project: TestProject): Promise<void> {
  const feature = "001-scoped-work";
  expect(project.run("feature", "Scoped work").exitCode).toBe(0);
  await project.authorBrief(feature, {
    outcomes: [{ id: "O001", kind: "functional", statement: "Login returns a token" }],
    checks: [{ id: "C001", command: ["node", "--test"], outcomes: ["O001"] }],
    slices: [
      {
        id: "T001",
        goal: "Change the auth module",
        outcomes: ["O001"],
        scope: { allowed: ["src/auth/**/*.ts"] },
        checks: ["C001"],
      },
    ],
  });
  // Isolate hook/scope enforcement from the separately tested critic consultation.
  expect(project.run("critic", "--off").exitCode).toBe(0);
  const worked = project.run("work", "--task", "T001");
  expect(worked.exitCode, worked.stdout + worked.stderr).toBe(0);
}
