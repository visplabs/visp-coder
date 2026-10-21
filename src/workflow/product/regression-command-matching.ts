import { basename, dirname, relative, resolve } from "node:path";
import { normalizePath } from "../../core/patterns.js";

/** Resolve complete arguments, never a basename or a substring of another test label. */
export function namesExistingTest(command: string, path: string, root: string): boolean {
  return commandNamesTest(command, path, root, root, [], 0);
}

interface CommandContext {
  directory: string;
  pythonRoots: readonly string[];
}

function commandNamesTest(
  command: string,
  path: string,
  root: string,
  initialDirectory: string,
  initialPythonRoots: readonly string[],
  depth: number,
): boolean {
  if (depth > 4) return false;
  const tokens = commandWords(command);
  if (!tokens) return false;
  const context = { directory: initialDirectory, pythonRoots: initialPythonRoots };
  let segment: string[] = [];
  for (const token of [...tokens, ";"]) {
    if (["&&", "||", ";", "|"].includes(token)) {
      if (segment[0] === "cd" && segment.length === 2)
        context.directory = resolve(context.directory, segment[1] ?? "");
      else if (segmentNamesTest(segment, context, path, root, depth)) return true;
      segment = [];
    } else segment.push(token);
  }
  return false;
}

function segmentNamesTest(
  segment: readonly string[],
  context: CommandContext,
  path: string,
  root: string,
  depth: number,
): boolean {
  const { args, directory } = commandDirectory(segment, context.directory);
  const assignment = args.find((token) => token.startsWith("PYTHONPATH="));
  const pythonRoots = assignment ? assignment.slice(11).split(":") : context.pythonRoots;
  const shell = args.findIndex((token) => /(?:^|\/)(?:ba|da|z|k)?sh$/.test(token));
  const script = args[shell + 2];
  if (shell >= 0 && args[shell + 1] === "-c" && script)
    return commandNamesTest(script, path, root, directory, pythonRoots, depth + 1);
  const roots = pythonModuleRoots(args, directory, pythonRoots);
  return args.some((token) => argumentNamesTest(token, path, root, directory, roots));
}

function commandDirectory(segment: readonly string[], initial: string) {
  let directory = initial;
  const args: string[] = [];
  for (let i = 0; i < segment.length; i++) {
    const token = segment[i] ?? "";
    if (token === "--cd" || token.startsWith("--cd=")) {
      const target = token === "--cd" ? segment[++i] : token.slice(5);
      if (target) directory = resolve(directory, target);
    } else args.push(token);
  }
  return { args, directory };
}

function pythonModuleRoots(
  args: readonly string[],
  directory: string,
  pythonRoots: readonly string[],
) {
  const roots = new Set([
    directory,
    resolve(directory, "src"),
    ...pythonRoots.map((entry) => resolve(directory, entry)),
  ]);
  const python = args.findIndex((token) => /(?:^|\/)python(?:\d+(?:\.\d+)*)?$/.test(token));
  if (python >= 0) {
    const invocation = args.slice(python + 1);
    const runner = invocation.find((token) => !token.startsWith("-"));
    if (!invocation.includes("-m") && !invocation.includes("-c") && runner?.endsWith(".py"))
      roots.add(dirname(resolve(directory, runner)));
  }
  // Behind a wrapper script (`./swe-test ./tests/runtests.py label`), Django's runner still
  // takes labels below its own directory. With an interpreter, only the rule above applies.
  else
    for (const token of args)
      if (basename(token) === "runtests.py") roots.add(dirname(resolve(directory, token)));
  return roots;
}

function argumentNamesTest(
  token: string,
  path: string,
  root: string,
  directory: string,
  roots: ReadonlySet<string>,
): boolean {
  const argument = token.replace(/^--?[\w-]+=/, "").split("::")[0] ?? "";
  if (argument.startsWith("-") || argument.includes("=") || argument === basename(path))
    return false;
  if (argument.includes("/") && resolve(directory, argument) === resolve(root, path)) return true;
  if (!/^[\w]+(?:\.[\w]+)+$/.test(argument)) return false;
  for (const moduleRoot of roots) {
    const local = normalizePath(relative(moduleRoot, resolve(root, path)));
    if (local.startsWith("../")) continue;
    const module = local.replace(/\.[^/.]+$/, "").replaceAll("/", ".");
    if (module.includes(".") && (argument === module || argument.startsWith(`${module}.`)))
      return true;
  }
  return false;
}

/** Small shell-word reader for advisory matching only; these words are never executed. */
function commandWords(command: string): string[] | undefined {
  const pattern = /(?:[^\s"'\\;&|]|\\.|"(?:\\.|[^"\\])*"|'[^']*')+|&&|\|\||[;&|]/g;
  const words: string[] = [];
  let end = 0;
  for (const match of command.matchAll(pattern)) {
    if (command.slice(end, match.index).trim()) return undefined;
    end = match.index + match[0].length;
    words.push(
      match[0].replace(
        /"((?:\\.|[^"\\])*)"|'([^']*)'|\\(.)/g,
        (_match, double: string | undefined, single: string | undefined, escaped: string) =>
          single ?? (double === undefined ? escaped : double.replace(/\\(.)/g, "$1")),
      ),
    );
  }
  return command.slice(end).trim() ? undefined : words;
}
