import { basename, posix } from "node:path";
import { resolveCommand } from "../../../core/exec.js";
import { matchesAny } from "../../../core/patterns.js";
import { privatePath } from "../../../core/redaction.js";
import type { WorkspaceState } from "../../state.js";
import { isBrowserCheckCommand } from "../check/check-command.js";
import type { ProductCheck, ProductExecution } from "../model.js";

/** Infer executable entries and conventional discovery inputs, never claim they were assertions. */
export async function reviewCheckPaths(
  workspace: WorkspaceState,
  checks: readonly ProductCheck[],
  snapshot: Record<string, string>,
) {
  const paths = Object.keys(snapshot).filter((path) => !privatePath(path));
  const selected = new Set<string>();
  for (const check of checks) {
    if (isBrowserCheckCommand(check.command)) continue;
    const argv = resolveCommand(check.command);
    if (!argv.ok) continue;
    for (const path of await commandPaths(workspace, argv.value, paths)) selected.add(path);
  }
  for (const patterns of [
    checks.flatMap((check) => check.verifierFiles ?? []),
    checks.flatMap((check) => check.files),
  ])
    for (const path of paths.filter((path) => matchesAny(path, patterns))) selected.add(path);
  return [...selected];
}

async function commandPaths(
  workspace: WorkspaceState,
  argv: string[],
  paths: string[],
  depth = 0,
): Promise<string[]> {
  if (depth > 3) return [];
  const executable = basename(argv[0] ?? "");
  const args = argv.slice(1);
  const selected = paths.filter((path) =>
    argv.some((arg) => {
      const input = posix.normalize(arg.replace(/^--[^=]+=/, ""));
      return path === input || path.startsWith(`${input}/`);
    }),
  );
  if (/^(?:sh|bash|zsh|dash)$/.test(executable) && args[0] === "-c") {
    const inner = resolveCommand(args[1] ?? "");
    if (inner.ok) selected.push(...(await commandPaths(workspace, inner.value, paths, depth + 1)));
  }
  const wrapped = wrappedRunner(executable, args);
  if (wrapped) selected.push(...(await commandPaths(workspace, wrapped, paths, depth + 1)));
  const discovered = discoveredTests(executable, args, paths);
  const script = await packageScript(workspace, executable, args);
  if (script) selected.push(...(await commandPaths(workspace, script, paths, depth + 1)));
  return [...new Set([...discovered, ...selected])];
}

/** Package exec wrappers launch a runner, rather than a script named "exec". */
function wrappedRunner(executable: string, args: string[]): string[] | undefined {
  const direct = /^(?:npx|bunx)$/.test(executable);
  const exec =
    /^(?:npm|pnpm|yarn|bun)$/.test(executable) &&
    (args[0] === "exec" || (executable === "bun" && args[0] === "x"));
  if (!direct && !exec) return undefined;
  const runner = args.slice(direct ? 0 : 1);
  while (runner[0]?.startsWith("-")) {
    const option = runner.shift();
    if (option === "--") break;
    if (/^(?:--package|-p|--cache|--prefix)$/.test(option ?? "")) runner.shift();
  }
  return runner.length ? runner : undefined;
}

/**
 * Keep observed names verbatim; an exit code never invents per-assertion successes. The flip
 * duration is wall-clock time: pass `timing: false` for any text that identifies the execution.
 */
export function reviewCheckResult(
  execution: ProductExecution,
  check?: ProductCheck,
  options: { timing?: boolean } = {},
) {
  return [
    `Check ${execution.check}; execution ${execution.id}; ${execution.status}; exit ${execution.exitCode}`,
    `Command executed: ${execution.command}`,
    `Provenance: ${execution.provenance}; assertions: ${execution.assertions}`,
    ...(execution.flip
      ? [
          `Without the change (implementation reverted to the work-authorization baseline, tests kept): ${execution.flip.failsWithoutChange === true ? "failed" : execution.flip.failsWithoutChange === false ? "passed" : "unchecked"}${execution.flip.reason ? ` (${execution.flip.reason})` : ""}`,
          ...(options.timing === false
            ? []
            : [`Flip check extra time: ${execution.flipDurationMs ?? 0} ms`]),
        ]
      : []),
    ...(check && isBrowserCheckCommand(check.command)
      ? [`Executed journey/check source: ${JSON.stringify(check.command)}`]
      : []),
    "Recorded assertion results/output (names are supplied only when the check emitted them):",
    ...(/^\s*NOT OBSERVED:/im.test(execution.output)
      ? [
          "Coverage gap: NOT OBSERVED means zero qualifying events or a goal the tester's bounded search never reached; on its own it is neither a passing assertion nor a product failure. A NOT OBSERVED goal the request states (winning a level, completing a flow, or a screen that follows one) is unmet: do not rate its outcome satisfied; report a required finding naming it, even when the implementer's own tests or one precise input sequence reach it, because a goal that a bounded search over the stated inputs misses is one people will not reach either. Only when the test source shows its search cannot work (inputs outside the stated range, a wrong hook, a helper error), say so in limitations instead.",
        ]
      : []),
    execution.output ||
      "No named assertion results or output were emitted; the exit status alone does not establish individual assertions.",
  ].join("\n");
}

async function packageScript(workspace: WorkspaceState, executable: string, args: string[]) {
  if (!/^(?:npm|pnpm|yarn|bun)$/.test(executable)) return undefined;
  const name = args[0] === "run" || args[0] === "run-script" ? args[1] : args[0];
  const read = await workspace.files.readTextIfExists("package.json");
  if (!read.ok || !read.value) return undefined;
  try {
    const script = JSON.parse(read.value).scripts?.[name ?? ""];
    const parsed = typeof script === "string" ? resolveCommand(script) : undefined;
    return parsed?.ok ? parsed.value : undefined;
  } catch {
    return undefined;
  }
}

function discoveredTests(executable: string, args: string[], paths: string[]) {
  if (
    /^python(?:\d+(?:\.\d+)*)?$/.test(executable) &&
    (args.includes("unittest") || args.includes("pytest"))
  ) {
    const modules = args
      .filter((arg) => !arg.startsWith("-"))
      .map((arg) => arg.replaceAll(".", "/"));
    return paths.filter(
      (path) =>
        /(?:^|\/)(?:test[^/]*|[^/]*_test)\.py$/.test(path) &&
        (args.includes("discover") ||
          args.includes("pytest") ||
          modules.some((module) => path.startsWith(module))),
    );
  }
  if (executable === "pytest")
    return paths.filter((path) => /(?:^|\/)(?:test[^/]*|[^/]*_test)\.py$/.test(path));
  const roots = args
    .map((argument) => posix.normalize(argument))
    .filter(
      (argument) =>
        !argument.startsWith("-") &&
        paths.some((path) => path === argument || path.startsWith(`${argument}/`)),
    );
  const explicit = roots.length > 0;
  if (
    /^(?:node|nodejs|vitest|jest)$/.test(executable) &&
    (args.includes("--test") || /^(?:vitest|jest)$/.test(executable))
  )
    return paths.filter(
      (path) =>
        /(?:^|\/)(?:tests?\/.*|test[^/]*|[^/]*[.-](?:test|spec))\.[cm]?[jt]sx?$/.test(path) &&
        (!explicit || roots.some((root) => path === root || path.startsWith(`${root}/`))),
    );
  return [];
}
