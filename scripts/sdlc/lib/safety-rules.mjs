// Commands an agent must leave to the owner: force pushes, pushes to main or develop, tags,
// merges, releases, publishing, branch and worktree deletion, `git clean -x`, credential reads,
// changing the GitHub identity agents run under, overriding the models agents run on, and
// editing or deleting issues (the spec and the owner's approval live there). Inside a subagent
// it also refuses direct `codex` calls, `sdlc review` from any agent but the reviewer, Jira
// writes from any agent but the clerk, and a pull request whose task may not ship yet. Each rule gets the words of one simple command and
// returns what the command would do that is refused, or undefined. It catches mistakes; a
// determined script can still get past it.

import { execFileSync } from "node:child_process";
import { basename, resolve } from "node:path";
import { agentCommandRefusal } from "./sdlc-command-rules.mjs";
import { splitCommands } from "./shell-words.mjs";

const PROTECTED_BRANCHES = new Set(["main", "develop"]);
const CREDENTIAL_PATHS = [".config/gh/hosts.yml", ".git-credentials", ".npmrc"];
const CREDENTIAL_PATTERNS = [/\.codex[^/\s]*\/auth\.json/];
const WRAPPERS = new Set(["sudo", "env", "command", "exec", "time", "nohup"]);
const SHELLS = new Set(["bash", "sh", "zsh"]);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const IDENTITY_VAR = /^(GH_CONFIG_DIR|GH_TOKEN|GITHUB_TOKEN|GH_ENTERPRISE_TOKEN)(=|$)/;
const IDENTITY_EXPANSION = /\$\{?(GH_CONFIG_DIR|GH_TOKEN|GITHUB_TOKEN|GH_ENTERPRISE_TOKEN)\b/;
// The Codex home holds the reviewer's login; these Claude Code variables outrank the models and
// efforts that sdlc.config.json and the agent definitions set.
const RUNTIME_VAR =
  /^(CODEX_HOME|CLAUDE_CODE_SUBAGENT_MODEL|CLAUDE_CODE_SUBAGENT_MODEL_FORCE|CLAUDE_CODE_EFFORT_LEVEL|ANTHROPIC_MODEL)=/;
const UNSETTERS = new Set(["-u", "--unset", "unset", "export"]);

// `agentType` is the subagent running the command; undefined in the owner's own session.
export function refusal(line, cwd, agentType) {
  for (const words of splitCommands(line)) {
    const reason =
      identityRefusal(words) ??
      runtimeRefusal(words) ??
      refuseCommand(stripPrefixes(words), cwd, agentType);
    if (reason) return reason;
  }
  return undefined;
}

function runtimeRefusal(words) {
  return words.some((word) => RUNTIME_VAR.test(word))
    ? "changes the Codex home or the model an agent runs on"
    : undefined;
}

// Agents act as the agent bot through GH_CONFIG_DIR; setting, unsetting or reading these
// variables would let them act, or read a token, as someone else.
function identityRefusal(words) {
  const touches = words.some(
    (word, i) =>
      IDENTITY_EXPANSION.test(word) ||
      (IDENTITY_VAR.test(word) && (word.includes("=") || UNSETTERS.has(words[i - 1] ?? ""))) ||
      (IDENTITY_VAR.test(word) && (words[0] === "unset" || words[0] === "export")),
  );
  return touches ? "changes or reads the GitHub identity agents run under" : undefined;
}

function stripPrefixes(words) {
  let i = 0;
  while (i < words.length && (WRAPPERS.has(words[i]) || ASSIGNMENT.test(words[i]))) i++;
  return words.slice(i);
}

function refuseCommand(words, cwd, agentType) {
  const [cmd, ...args] = words;
  if (!cmd) return undefined;
  if (words.some(readsCredentials)) return "reads stored credentials";
  const name = basename(cmd);
  if (SHELLS.has(name)) {
    const script = args[args.indexOf("-c") + 1];
    return args.includes("-c") && script ? refusal(script, cwd, agentType) : undefined;
  }
  if (name === "eval") return refusal(args.join(" "), cwd, agentType);
  return (
    (agentType ? agentCommandRefusal(words, cwd, agentType) : undefined) ??
    COMMAND_RULES[name]?.(args, cwd)
  );
}

function readsCredentials(word) {
  return (
    CREDENTIAL_PATHS.some((path) => word.includes(path)) ||
    CREDENTIAL_PATTERNS.some((pattern) => pattern.test(word))
  );
}

const COMMAND_RULES = {
  git: gitRule,
  gh: ghRule,
  npm: packageRule,
  pnpm: packageRule,
  yarn: packageRule,
  "secret-tool": () => "reads stored credentials",
};

function gitRule(args, cwd) {
  let dir = cwd;
  let i = 0;
  while (i < args.length && args[i].startsWith("-")) {
    if (args[i] === "-C") dir = resolve(dir, args[i + 1] ?? ".");
    i += args[i] === "-C" || args[i] === "-c" ? 2 : 1;
  }
  return GIT_RULES[args[i]]?.(args.slice(i + 1), dir);
}

const GIT_RULES = {
  push: pushRule,
  tag: tagRule,
  branch: (args) =>
    args.some((arg) => arg === "--delete" || /[dD]/.test(shortFlags(arg)))
      ? "deletes a branch"
      : undefined,
  worktree: (args) =>
    args[0] === "remove" || args[0] === "prune" ? "removes a worktree" : undefined,
  clean: (args) =>
    args.some((arg) => /[xX]/.test(shortFlags(arg))) ? "removes ignored files" : undefined,
  credential: (args) => (args[0] === "fill" ? "reads stored credentials" : undefined),
};

const PUSH_FLAGS = {
  "--force": "force-pushes",
  "--force-with-lease": "force-pushes",
  "--force-if-includes": "force-pushes",
  "--mirror": "force-pushes",
  "--tags": "pushes tags",
  "--follow-tags": "pushes tags",
  "--delete": "deletes a remote branch",
  "--prune": "deletes remote branches",
};

function pushRule(args, dir) {
  for (const flag of args.filter((arg) => arg.startsWith("-"))) {
    const reason = PUSH_FLAGS[flag.split("=")[0]];
    if (reason) return reason;
    if (shortFlags(flag).includes("f")) return "force-pushes";
    if (shortFlags(flag).includes("d")) return "deletes a remote branch";
  }
  const refspecs = args.filter((arg) => !arg.startsWith("-")).slice(1);
  if (refspecs.length === 0) return protectedPush(currentBranch(dir));
  for (const spec of refspecs) {
    const reason = refspecReason(spec, dir);
    if (reason) return reason;
  }
  return undefined;
}

function refspecReason(spec, dir) {
  if (spec.startsWith("+")) return "force-pushes";
  if (spec.startsWith(":")) return "deletes a remote branch";
  const target = spec.slice(spec.indexOf(":") + 1);
  if (target.startsWith("refs/tags/")) return "pushes a tag";
  const branch = target.replace(/^refs\/heads\//, "");
  return protectedPush(branch === "HEAD" ? currentBranch(dir) : branch);
}

function protectedPush(branch) {
  return PROTECTED_BRANCHES.has(branch) ? `pushes to ${branch}` : undefined;
}

function currentBranch(dir) {
  try {
    return execFileSync("git", ["-C", dir, "symbolic-ref", "--short", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

function tagRule(args) {
  if (args.includes("-d") || args.includes("--delete")) return "deletes a tag";
  if (args.some((arg) => arg === "-l" || arg === "--list" || arg.startsWith("-n"))) {
    return undefined;
  }
  return args.length > 0 ? "creates a tag" : undefined;
}

const RELEASE_READS = new Set(["view", "list", "download"]);
const REPO_CHANGES = new Set(["delete", "archive", "rename", "edit"]);

function ghRule(args) {
  const [group, action] = args;
  if (group === "pr" && action === "merge") return "merges a pull request";
  if (group === "release" && action && !RELEASE_READS.has(action)) return "changes a release";
  if (group === "auth" && action === "token") return "reads stored credentials";
  if (group === "repo" && REPO_CHANGES.has(action)) return "changes repository settings";
  if (group === "issue" && ISSUE_CHANGES.has(action)) return "deletes, unlocks or moves an issue";
  if (group === "issue" && action === "edit" && args.some((arg) => BODY_FLAG.test(arg))) {
    return "edits an issue body, where the spec and the owner's words live";
  }
  if (group === "api" && WRITE_METHODS.has(apiMethod(args))) {
    return "changes GitHub data through the API";
  }
  return undefined;
}

const ISSUE_CHANGES = new Set(["delete", "unlock", "transfer"]);
const BODY_FLAG = /^(--body|--body-file|-b|-F)(=|$)/;
const WRITE_METHODS = new Set(["PATCH", "PUT", "DELETE"]);

function apiMethod(args) {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "-X" || args[i] === "--method") return (args[i + 1] ?? "").toUpperCase();
    const joined = args[i].match(/^(?:-X|--method=)(.+)$/);
    if (joined) return joined[1].toUpperCase();
  }
  return "GET";
}

const PACKAGE_CHANGES = new Set(["publish", "unpublish", "deprecate"]);
const PACKAGE_SUBCHANGES = { stage: ["approve", "publish"], "dist-tag": ["add", "rm", "set"] };

function packageRule(args) {
  const [action, sub] = args;
  if (PACKAGE_CHANGES.has(action)) return "publishes or changes a package";
  if (PACKAGE_SUBCHANGES[action]?.includes(sub)) return "publishes or changes a package";
  return undefined;
}

function shortFlags(arg) {
  return /^-[A-Za-z]+$/.test(arg) ? arg.slice(1) : "";
}
