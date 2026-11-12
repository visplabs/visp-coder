import { isAbsolute, relative, resolve } from "node:path";
import { vispError } from "../core/errors.js";
import { run } from "../core/exec.js";
import { err, ok, type Result } from "../core/result.js";

export interface GitHookPath {
  readonly absolute: string;
  readonly display: string;
}

/** Resolves Git's effective hooks path, including core.hooksPath. */
export async function preCommitHookPath(root: string): Promise<Result<GitHookPath>> {
  const resolved = await run(
    "git",
    // `--path-format=absolute` requires Git 2.31. Resolving the value against
    // the worktree gives the same result while keeping compatibility with Git
    // versions that already support core.hooksPath (2.10+).
    ["rev-parse", "--git-path", "hooks/pre-commit"],
    { cwd: root, env: { GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" } },
  );
  if (!resolved.ok) return resolved;
  if (resolved.value.exitCode !== 0 || resolved.value.stdout.trim() === "") {
    return err(
      vispError("COMMAND_FAILED", "Could not resolve Git's configured pre-commit hook path", {
        details: { stderr: resolved.value.stderr.trim() },
      }),
    );
  }

  const absolute = resolve(root, resolved.value.stdout.trim());
  const rel = relative(resolve(root), absolute);
  return ok({
    absolute,
    display: rel === "" || rel.startsWith("..") || isAbsolute(rel) ? absolute : rel,
  });
}

/** The value of `core.hooksPath` as configured, or undefined when it is unset or unreadable. */
export async function configuredHooksPath(root: string): Promise<string | undefined> {
  const result = await run("git", ["config", "--get", "core.hooksPath"], {
    cwd: root,
    env: { GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" },
  });
  const value = result.ok && result.value.exitCode === 0 ? result.value.stdout.trim() : "";
  return value === "" ? undefined : value;
}
