// What a coder agent may change: paths inside its task's scope, never the files that define the
// SDLC, CI, lint, tests or packages, and nothing outside the repository but temporary files.
// Every other agent may not change SDLC state: settings, agent definitions, hooks, the config
// and the shared .sdlc/ folder, where loop counters and contracts live.

import { tmpdir } from "node:os";
import { basename, join, relative, resolve, sep } from "node:path";
import { matchesAny } from "./glob.mjs";
import { splitCommands } from "./shell-words.mjs";

const PROTECTED = [
  ".claude/**",
  ".github/**",
  "scripts/sdlc/**",
  "tests/golden/__snapshots__/**",
  "AGENTS.md",
  "CLAUDE.md",
  "biome.json",
  "knip.json",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "sdlc.config.json",
  ".sdlc/**",
  "tsconfig*.json",
  "tsup*.config.ts",
  "vitest*.config.ts",
];

const STATE = [".claude/**", "scripts/sdlc/**", "sdlc.config.json", ".sdlc/**"];

export function stateRefusal(root, cwd, path, sdlcDir) {
  const absolute = resolve(cwd, path);
  const rel = relative(root, absolute).split(sep).join("/");
  const inSdlc = !relative(sdlcDir, absolute).startsWith("..");
  return inSdlc || matchesAny(rel, STATE)
    ? `${path} is SDLC state; only the owner and the sdlc commands change it`
    : undefined;
}

export function pathRefusal(root, cwd, path, scope) {
  if (/[$`]/.test(path)) {
    return (
      `${path} is a shell variable or substitution, which the scope hook cannot see into; ` +
      "name each file in the command, or use Edit or Write"
    );
  }
  const absolute = resolve(cwd, path);
  const rel = relative(root, absolute).split(sep).join("/");
  if (rel.startsWith("../") || rel === "..") {
    const temporary = absolute.startsWith(tmpdir()) || absolute === "/dev/null";
    return temporary ? undefined : `${path} is outside the repository`;
  }
  if (matchesAny(rel, PROTECTED)) {
    return `${rel} is protected: only the owner changes SDLC, CI, lint, test and package files`;
  }
  if (!matchesAny(rel, scope)) {
    return `${rel} is outside this task's scope, which allows only: ${scope.join(", ")}`;
  }
  return undefined;
}

// The architect drafts ADRs outside the repository; the coder commits them in its worktree, so
// a decision ships with the code it governs and the owner's checkout stays clean.
export function draftRefusal(path, cwd) {
  const drafts = join(tmpdir(), "sdlc-adr");
  return resolve(cwd, path).startsWith(drafts + sep)
    ? undefined
    : `the architect writes ADR drafts only under ${drafts}/VISP-<epic>/; the coder commits them`;
}

// Files a shell command would write: redirect targets and the operands of common writers. A
// copy or move into a folder (`isDir`) writes the source's name inside it. It catches the usual
// ways an agent edits through the shell, not every possible one.
export function shellWriteTargets(command, isDir = () => false) {
  const targets = [];
  for (const words of splitCommands(command)) {
    const plain = [];
    for (let i = 0; i < words.length; i++) {
      const word = words[i];
      if (word === ">" || word === ">>") {
        if (words[i + 1]) targets.push(words[i + 1]);
        i++;
      } else if (/^>>?./.test(word)) {
        targets.push(word.replace(/^>>?/, ""));
      } else {
        plain.push(word);
      }
    }
    targets.push(...writerOperands(plain, isDir));
  }
  return targets;
}

const WRITERS = {
  rm: (args) => args,
  touch: (args) => args,
  truncate: (args) => args,
  tee: (args) => args,
  chmod: (args) => args.slice(1),
  mv: intoTarget,
  cp: intoTarget,
  ln: intoTarget,
};

function intoTarget(args, isDir) {
  const target = args.at(-1);
  if (target === undefined) return [];
  const sources = args.slice(0, -1);
  const folder = sources.length > 1 || target.endsWith("/") || isDir(target);
  return folder && sources.length > 0
    ? sources.map((source) => `${target.replace(/\/+$/, "")}/${basename(source)}`)
    : [target];
}

// Words that start a clause of a compound command (`for ...; do rm x; done`), not a command.
const KEYWORDS = new Set(["do", "then", "else", "elif", "!", "time"]);

function writerOperands(words, isDir) {
  const start = words.findIndex((word) => !KEYWORDS.has(word));
  const [cmd, ...rest] = start < 0 ? [] : words.slice(start);
  if (!cmd) return [];
  const operands = rest.filter((word) => !word.startsWith("-"));
  const name = basename(cmd);
  if (name === "sed") return rest.some((word) => /^-i/.test(word)) ? operands.slice(-1) : [];
  return WRITERS[name]?.(operands, isDir) ?? [];
}
