// What a coder agent may change: paths inside its task's scope, never the files that define the
// SDLC, CI, lint, tests or packages, and nothing outside the repository but temporary files.

import { tmpdir } from "node:os";
import { basename, relative, resolve, sep } from "node:path";
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
  "tsconfig*.json",
  "tsup*.config.ts",
  "vitest*.config.ts",
];

export function pathRefusal(root, cwd, path, scope) {
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

// Files a shell command would write: redirect targets and the operands of common writers.
// It catches the usual ways an agent edits through the shell, not every possible one.
export function shellWriteTargets(command) {
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
    targets.push(...writerOperands(plain));
  }
  return targets;
}

const WRITERS = {
  rm: (args) => args,
  touch: (args) => args,
  truncate: (args) => args,
  tee: (args) => args,
  chmod: (args) => args.slice(1),
  mv: (args) => args.slice(-1),
  cp: (args) => args.slice(-1),
  ln: (args) => args.slice(-1),
};

function writerOperands(words) {
  const [cmd, ...rest] = words;
  if (!cmd) return [];
  const operands = rest.filter((word) => !word.startsWith("-"));
  const name = basename(cmd);
  if (name === "sed") return rest.some((word) => /^-i/.test(word)) ? operands.slice(-1) : [];
  return WRITERS[name]?.(operands) ?? [];
}
