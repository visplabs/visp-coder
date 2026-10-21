#!/usr/bin/env node
// __HOOK_MARKER__; hook-version: __HOOK_TEMPLATE_VERSION__
// Refuses edits outside the active task's declared scope.
// Decisions come from `__HOOK_PRODUCT_NAME__ guard`, so this file holds no rules of its own.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const cli = __HOOK_CLI__;

function deny(reason) {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  };
}

function readInput() {
  try {
    return JSON.parse(readFileSync(0, "utf8"));
  } catch {
    return undefined;
  }
}

const input = readInput();

// Claude Code names the project in its environment; Codex passes the session cwd instead.
function projectRoot() {
  const start = resolve(process.env.CLAUDE_PROJECT_DIR ?? input?.cwd ?? process.cwd());
  let directory = start;
  while (true) {
    if (existsSync(join(directory, ".visp", "project.json"))) return directory;
    if (existsSync(join(directory, ".git"))) return start;
    const parent = dirname(directory);
    if (parent === directory) return start;
    directory = parent;
  }
}

// The user's own words are the contract the tester and reviewer judge against; workers
// paraphrase them. Kept locally in the git-ignored session directory for `__HOOK_PRODUCT_NAME__ feature`.
// Claude Code delivers a background command's completion as a prompt of its own, which
// `__HOOK_PRODUCT_NAME__ feature` then took as the request; host notifications are not recorded.
if (input?.hook_event_name === "UserPromptSubmit") {
  try {
    const prompt = String(input.prompt ?? "");
    if (!hostNotification(prompt)) {
      const directory = join(projectRoot(), ".visp", "session");
      const file = join(directory, "user-prompts.jsonl");
      mkdirSync(directory, { recursive: true });
      let lines = [];
      try {
        lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
      } catch {}
      lines.push(JSON.stringify({ at: new Date().toISOString(), prompt }));
      writeFileSync(file, `${lines.slice(-20).join("\n")}\n`);
    }
    recordSession();
  } catch {}
  process.exit(0);
}

// A weak worker stopped with slices open and no acceptance, so the pinned tests never ran
// as final checks. Send it back to the next step, only for recent work. A block is a nudge
// about one step: the same step is raised at most twice, and again only when the feature
// changed since the last nudge; a handoff or an unusable environment is raised once.
if (input?.hook_event_name === "Stop") {
  const root = projectRoot();
  try {
    const status = JSON.parse(readFileSync(join(root, ".visp", "status.json"), "utf8"));
    if (!status.activeFeature) process.exit(0);
    // Recent work moves the feature's state file; status.json alone misses a long check.
    let touched = Date.parse(status.updatedAt);
    try {
      touched = Math.max(
        Number.isFinite(touched) ? touched : 0,
        statSync(join(root, ".visp", "features", String(status.activeFeature), "product-state.json")).mtimeMs,
      );
    } catch {}
    if (!(Date.now() - touched < 60 * 60 * 1000)) process.exit(0);
    const envelope = JSON.parse(
      // Unselected, so a later session's untaken request is sent to a feature of its own.
      // The observer marker makes `__HOOK_PRODUCT_NAME__ next` trust the worker's recorded browser
      // capability and report a `progress` token; it changes nothing else.
      execFileSync(process.execPath, [cli, "next", "--json"], {
        cwd: root,
        env: { ...process.env, VISP_OBSERVER: "stop-hook" },
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 170000,
      }).toString(),
    );
    const next = envelope?.data;
    // A step for no feature, such as starting one for an untaken request, is for a session
    // that tried to change the project since the user's latest prompt; one that answered a
    // question or committed is left alone.
    if (!next?.feature && typeof input.session_id === "string") {
      const edits = join(root, ".visp", "session", "edits", encodeURIComponent(input.session_id) + ".json");
      let tried;
      try { tried = Date.parse(JSON.parse(readFileSync(edits, "utf8")).at); } catch { process.exit(0); }
      const prompted = latestPromptAt(root);
      if (prompted !== undefined && !(tried >= prompted)) process.exit(0);
    }
    if (!envelope?.ok || !next?.action || next.action === "complete") process.exit(0);
    const day = 24 * 60 * 60 * 1000;
    const plain = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
    const now = Date.now();
    const kind =
      next.completion === "handoff" ? "handoff" : next.completion === "unresolved-environment" ? "environment" : "work";
    const limit = kind === "work" ? 2 : 1;
    // Ids and values change from call to call; the command's verb and flags name the step.
    const words = String(next.command ?? "").split(/\s+/).filter(Boolean);
    const shape = words.filter((word, index) => index < 2 || word.startsWith("-"));
    const fingerprint = createHash("sha256")
      .update(JSON.stringify([status.activeFeature, next.action, next.completion ?? "", next.task ?? "", shape]))
      .digest("hex");
    const progress = typeof next.progress === "string" ? next.progress : "";
    const counts = join(root, ".visp", "session", "stop-blocks.json");
    let entries = {};
    try {
      const stored = JSON.parse(readFileSync(counts, "utf8"));
      if (stored?.version === 2 && plain(stored.entries)) entries = stored.entries;
    } catch {}
    for (const [name, entry] of Object.entries(entries)) {
      if (!plain(entry) || !(now - Date.parse(entry.at) < day)) delete entries[name];
      else if (plain(entry.fps))
        for (const [id, seen] of Object.entries(entry.fps))
          if (!plain(seen) || !(now - Date.parse(seen.at) < day)) delete entry.fps[id];
    }
    const key = [input.session_id ?? "unknown", status.activeFeature].join(":");
    const entry = plain(entries[key]) && plain(entries[key].fps) ? entries[key] : { total: 0, fps: {} };
    const seen = plain(entry.fps[fingerprint]) ? entry.fps[fingerprint] : undefined;
    if ((Number(entry.total) || 0) >= 6) process.exit(0);
    // The same step blocks up to its limit whatever the worker did in between: in weak-worker
    // runs most repeated nudges were followed, and waiting for a progress change let a worker
    // that did nothing stop after one nudge.
    if (seen && (Number(seen.count) || 0) >= limit) process.exit(0);
    // The counter is on disk before the block is emitted; if it cannot be written the
    // worker is not blocked, since nothing would bound the repeats.
    const at = new Date(now).toISOString();
    entries[key] = {
      total: (Number(entry.total) || 0) + 1,
      at,
      fps: { ...entry.fps, [fingerprint]: { count: (Number(seen?.count) || 0) + 1, progress, at } },
    };
    const temporary = counts + "." + process.pid + ".tmp";
    try {
      mkdirSync(join(root, ".visp", "session"), { recursive: true });
      writeFileSync(temporary, JSON.stringify({ version: 2, entries }));
      renameSync(temporary, counts);
    } catch {
      try { unlinkSync(temporary); } catch {}
      process.exit(0);
    }
    const objective = String(next.objective ?? "").trim().replace(/[.\s]+$/, "");
    const feature = status.activeFeature;
    const command = next.command;
    const reason = !next.feature
      ? command ? `${objective}. Run: ${command}` : `${objective}.`
      : kind === "handoff"
      ? command
        ? `${objective}. Run: ${command} once, then say in your final message what is still open and that ${feature} needs the human reviewer.`
        : `${objective}. Say in your final message what is still open and that ${feature} needs the human reviewer.`
      : kind === "environment"
      ? `VISP cannot verify ${feature} until its execution environment works: ${objective}.${command ? ` Run: ${command} once.` : ""} If it is still unavailable, say in your final message which capability is missing and that ${feature} is not verified; do not retry it repeatedly.`
      : `VISP's next step for ${feature}: ${objective}.${command ? ` Run: ${command}.` : ""} If your own \`__HOOK_PRODUCT_NAME__ next\` shows a different step, follow that one. If you cannot finish, say in your final message what is left and why.`;
    process.stdout.write(JSON.stringify({ decision: "block", reason }));
  } catch {}
  process.exit(0);
}

// When the latest recorded user prompt was sent, or undefined when none is recorded.
function latestPromptAt(root) {
  try {
    const entries = readFileSync(join(root, ".visp", "session", "user-prompts.jsonl"), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter((entry) => !hostNotification(String(entry?.prompt ?? "")));
    const at = Date.parse(entries[entries.length - 1]?.at);
    return Number.isFinite(at) ? at : undefined;
  } catch {
    return undefined;
  }
}

// A prompt that is nothing but host notifications; the same test as host-prompts.ts.
function hostNotification(prompt) {
  return /^(\s*<task-notification>[\s\S]*?<\/task-notification>)+\s*$/.test(prompt);
}

// A worker deleted .visp and the pinned tests with shell commands to get past a scope
// error. Only such commands are refused; every other command gets no decision here, so
// the host's own permission rules still apply.
// `__HOOK_PRODUCT_NAME__ work` stamps its authorization with the session that runs it: record the
// session of each shell command just before it runs, as prompts do.
function recordSession() {
  if (typeof input?.session_id !== "string" || !input.session_id) return;
  try {
    const directory = join(projectRoot(), ".visp", "session");
    mkdirSync(directory, { recursive: true });
    mkdirSync(join(directory, "hosts"), { recursive: true });
    writeFileSync(join(directory, "hosts", encodeURIComponent(input.session_id) + ".json"),
      JSON.stringify({ session: input.session_id, at: new Date().toISOString() }));
    writeFileSync(
      join(directory, "__HOOK_HOST_SESSION_FILE__"),
      JSON.stringify({ session: input.session_id, at: new Date().toISOString() }),
    );
  } catch {}
}

if (input?.tool_name === "Bash") {
  recordSession();
  const command = String(input?.tool_input?.command ?? "");
  const destructive = destructiveShellReason(command);
  if (destructive) {
    process.stdout.write(
      JSON.stringify(
        deny(destructive),
      ),
    );
    process.exit(0);
  }
  const workflow = workflowShellCommand(command);
  // Only Claude Code has run_in_background; Codex runs this hook too, so a loop's refusal
  // names no setting of one host.
  const background = input?.tool_input?.run_in_background === true;
  if (workflow && (workflow.loop || background)) {
    process.stdout.write(
      JSON.stringify(
        deny(
          background
            ? "Run `" + workflow.command + "` by itself in the foreground, not in a loop: repeat it without run_in_background and with timeout 600000. " +
                "It prints its result and the next step; while a review runs, `__HOOK_PRODUCT_NAME__ next` waits for it. " +
                "If the host moves the command to the background, wait for its completion notice, then run `__HOOK_PRODUCT_NAME__ next`; do not poll with pgrep, tail -f or sleep loops."
            : "Run `" + workflow.command + "` by itself, not in a loop, with the host's maximum shell timeout. " +
                "It prints its result and the next step; while a review runs, `__HOOK_PRODUCT_NAME__ next` waits for it. " +
                "Do not poll with pgrep, tail -f or sleep loops.",
        ),
      ),
    );
    process.exit(0);
  }
  const lost = discardedChanges(command);
  if (lost.length > 0) {
    process.stdout.write(
      JSON.stringify(
        deny(
          "This command would discard uncommitted changes to " +
            lost.slice(0, 5).join(", ") +
            (lost.length > 5 ? " and " + (lost.length - 5) + " more" : "") +
            ". They may be earlier work: commit them instead (git add -A && git commit -m '<what they are>'); if the commit fails because Git is read-only, leave them uncommitted. To undo an edit of your own, edit the file back.",
        ),
      ),
    );
  }
  process.exit(0);
}

// Workers started visp done and accept as background tasks and then waited for them with
// loops that never ended on their own (pgrep -f matching its own shell, tail -f piped to
// grep -m1): commands that returned in 15 s left them idle for up to 9 minutes. VISP's
// workflow commands bound their own waits, so they run in the foreground, and never inside a
// loop, which keeps polling until the host's timeout. `__HOOK_PRODUCT_NAME__ feature` keeps writing
// acceptance tests after it prints the feature id and `__HOOK_PRODUCT_NAME__ ui` is a server, so both
// may still run in the background. Only VISP itself counts as the command, with the verb as
// the first word after it: `echo "__HOOK_PRODUCT_NAME__ done"`, `grep __HOOK_PRODUCT_NAME__` and a request in a
// heredoc that says "show __HOOK_PRODUCT_NAME__ status" were refused when any of the three words after
// `__HOOK_PRODUCT_NAME__` anywhere matched. A loop counts only around the VISP command (between its
// while, until or for and done), so `...; done && __HOOK_PRODUCT_NAME__ verify` is not one.
// Function declarations, not top-level constants: the Bash branch above runs first.
function workflowShellCommand(command) {
  const workflow = new Set(["work", "done", "verify", "accept", "next", "pr", "status", "brief", "critic", "review"]);
  let depth = 0;
  for (const words of commandWords(withoutHeredocBodies(command))) {
    if (["while", "until", "for", "select"].includes(words[0])) depth++;
    else if (words[0] === "done") depth = Math.max(0, depth - 1);
    const found = vispInvocation(words);
    if (found?.script !== undefined) {
      const inner = workflowShellCommand(found.script);
      if (inner) return { command: inner.command, loop: inner.loop || depth > 0 };
    } else if (found && workflow.has(found.verb))
      return { command: "__HOOK_PRODUCT_NAME__ " + found.verb, loop: depth > 0 || found.watched };
  }
  return undefined;
}

// Simple commands, split at ; & | newlines, ( ) and command substitutions ($(...) and
// backticks, also inside double quotes), so the VISP in "$(__HOOK_PRODUCT_NAME__ status)" is a command of
// its own. Single-quoted text stays one word; arithmetic $((...)) holds no commands.
function commandWords(command) {
  const commands = [[]];
  let word = "";
  let inWord = false;
  const quotes = [];
  const end = () => {
    if (inWord) commands[commands.length - 1].push(word);
    word = "";
    inWord = false;
  };
  const split = () => {
    end();
    commands.push([]);
  };
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    const quote = quotes[quotes.length - 1];
    if (quote === "'") {
      if (c === "'") quotes.pop();
      else word += c;
      continue;
    }
    if (c === "$" && command.startsWith("((", i + 1)) {
      let open = 0;
      for (i++; i < command.length; i++) {
        if (command[i] === "(") open++;
        else if (command[i] === ")" && --open === 0) break;
      }
      word += "0";
      inWord = true;
      continue;
    }
    if (c === "$" && command[i + 1] === "(") {
      quotes.push("$(");
      i++;
      split();
      continue;
    }
    if (c === "`") {
      if (quote === "`") quotes.pop();
      else quotes.push("`");
      split();
      continue;
    }
    if (quote === '"') {
      if (c === '"') quotes.pop();
      else if (c === "\\" && i + 1 < command.length) word += command[++i];
      else word += c;
      continue;
    }
    if (c === ")" && quote === "$(") {
      quotes.pop();
      split();
    } else if (c === "'" || c === '"') {
      quotes.push(c);
      inWord = true;
    } else if (c === "\\" && i + 1 < command.length) {
      word += command[++i];
      inWord = true;
    } else if ("\n;&|()".includes(c)) split();
    else if (/\s/.test(c)) end();
    else {
      word += c;
      inWord = true;
    }
  }
  end();
  return commands.filter((words) => words.length > 0);
}

// VISP as the command itself: the first word, after assignments, flags and their values,
// durations and wrappers such as env, sudo, timeout, npx or a loop's do. Returns the verb, or
// the script a shell runs with -c, which is checked the same way.
function vispInvocation(words) {
  const wrappers = new Set(["env", "command", "exec", "nohup", "time", "timeout", "sudo", "npx", "pnpm", "npm", "yarn", "bunx", "dlx", "watch", "while", "until", "do", "if", "then", "else", "elif", "!", "{"]);
  let watched = false;
  for (let index = 0; index < words.length; index++) {
    const word = words[index];
    if (word === "__HOOK_PRODUCT_NAME__" || word.endsWith("/__HOOK_PRODUCT_NAME__") || word === "__HOOK_PACKAGE_NAME__" || word.startsWith("__HOOK_PACKAGE_NAME__@"))
      return { verb: words.slice(index + 1).find((next) => !next.startsWith("-")), watched };
    if (/^(?:.*\/)?(?:ba|z|da)?sh$/.test(word)) {
      const flag = words.findIndex((next, at) => at > index && /^-[A-Za-z]*c[A-Za-z]*$/.test(next));
      return flag > 0 && words[flag + 1] !== undefined ? { script: words[flag + 1] } : undefined;
    }
    if (word === "watch") watched = true;
    const previous = words[index - 1] ?? "";
    const prefix =
      wrappers.has(word) ||
      word.startsWith("-") ||
      /^-[A-Za-z]$/.test(previous) ||
      /^[A-Za-z_][A-Za-z0-9_]*=/.test(word) ||
      /^\d+(?:\.\d+)?[smhd]?$/.test(word);
    if (!prefix) return undefined;
  }
  return undefined;
}

// A heredoc body is input text, such as the request `__HOOK_PRODUCT_NAME__ feature` reads, not commands.
// Arithmetic such as $((1<<2)) does not start one.
function withoutHeredocBodies(command) {
  const kept = [];
  const pending = [];
  for (const line of command.split("\n")) {
    if (pending.length) {
      const [delimiter, tabs] = pending[0];
      if ((tabs ? line.replace(/^\t+/, "") : line) === delimiter) pending.shift();
      continue;
    }
    kept.push(line);
    const code = line.replace(/\$?\(\([^()]*\)\)/g, "0");
    for (const match of code.matchAll(/(?<!<)<<(-?)\s*(['"]?)([^\s'"<>;&|()]+)\2/g))
      pending.push([match[3], match[1] === "-"]);
  }
  return kept.join("\n");
}

// A worker discarded a previous session's uncommitted work with git checkout to get the
// clean tree a new feature needs. Commands that would discard uncommitted changes are
// refused: checkout or restore of changed files, forced checkouts and switches, and hard
// resets (untracked files included, which a reset to another commit can overwrite).
// Branch switches that keep changes, staged-only restores and stashes are left alone.
function shellCommands(command) {
  const commands = [[]];
  let word = "";
  let inWord = false;
  let quote = "";
  const end = () => {
    if (inWord) commands[commands.length - 1].push(word);
    word = "";
    inWord = false;
  };
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (quote) {
      if (c === quote) quote = "";
      else if (c === "\\" && quote === '"' && i + 1 < command.length) word += command[++i];
      else word += c;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      inWord = true;
    } else if (c === "\\" && i + 1 < command.length) {
      word += command[++i];
      inWord = true;
    } else if (c === "\n" || c === ";" || c === "&" || c === "|") {
      end();
      commands.push([]);
    } else if (/\s/.test(c)) {
      end();
    } else {
      word += c;
      inWord = true;
    }
  }
  end();
  return commands.filter((words) => words.length > 0);
}

function destructiveShellReason(command) {
  const protectedOperand = (word) => /^(?:\.\/)?(?:\.visp|acceptance)(?:\/|$)/.test(word);
  for (const words of shellCommands(command)) {
    const executable = words[0];
    const operands = words.slice(1).filter((word) => !word.startsWith("-"));
    // A dry run only lists what a clean would delete.
    const dryRun = words.slice(2).some((word) => word === "--dry-run" || /^-[A-Za-z]*n[A-Za-z]*$/.test(word));
    if (executable === "git" && words[1] === "clean" && !dryRun)
      return "git clean may delete untracked VISP state or acceptance tests; inspect and remove individual files instead.";
    if (executable === "git" && words[1] === "stash" && words.slice(2).some((word) => /^(?:-[A-Za-z]*[ua]|--include-untracked|--all)$/.test(word)))
      return "git stash of untracked files may hide VISP state or acceptance tests; commit the work instead.";
    const gitDestructive = executable === "git" && ["checkout", "restore", "rm", "reset"].includes(words[1]);
    const fileDestructive = ["rm", "mv"].includes(executable);
    const findDelete = executable === "find" && words.includes("-delete");
    if ((gitDestructive || fileDestructive || findDelete) && operands.some(protectedOperand))
      return "This command would remove VISP state or the pinned acceptance tests. Keep them; if visp reports a scope problem, restore or scope the files it names instead.";
  }
  return undefined;
}

function workingTreeChanges() {
  const entries = execFileSync("git", ["status", "--porcelain", "-z"], {
    cwd: projectRoot(),
    stdio: ["ignore", "pipe", "ignore"],
  })
    .toString()
    .split("\0");
  const tracked = [];
  const untracked = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (!entry) continue;
    const code = entry.slice(0, 2);
    (code === "??" ? untracked : tracked).push(entry.slice(3));
    if (code[0] === "R" || code[0] === "C") i++;
  }
  return { tracked, untracked };
}

function discardedChanges(command) {
  const targets = [];
  let forced = false;
  let hard = false;
  for (const words of shellCommands(command)) {
    const git = words.indexOf("git");
    if (git < 0) continue;
    const [sub, ...rest] = words.slice(git + 1);
    const separator = rest.indexOf("--");
    const operands = (separator >= 0 ? rest.slice(separator + 1) : rest).filter(
      (word) => separator >= 0 || !word.startsWith("-"),
    );
    const flags = (separator >= 0 ? rest.slice(0, separator) : rest).filter((word) => word.startsWith("-"));
    if (sub === "reset" && flags.includes("--hard")) hard = true;
    else if (sub === "checkout" && flags.some((flag) => flag === "--force" || /^-[A-Za-z]*f/.test(flag)))
      forced = true;
    else if (sub === "switch" && flags.some((flag) => ["-f", "--force", "--discard-changes"].includes(flag)))
      forced = true;
    else if (sub === "checkout" && !flags.some((flag) => ["-b", "-B", "--orphan"].includes(flag)))
      targets.push(...operands);
    else if (
      sub === "restore" &&
      !(flags.includes("--staged") && !flags.includes("--worktree") && !flags.includes("-W"))
    )
      targets.push(...operands);
  }
  if (!hard && !forced && targets.length === 0) return [];
  let changes;
  try {
    changes = workingTreeChanges();
  } catch {
    return [];
  }
  if (hard) return [...changes.tracked, ...changes.untracked];
  if (forced) return changes.tracked;
  const prefixes = targets.map((target) => target.replace(/^\.\//, "").replace(/\/$/, ""));
  return changes.tracked.filter((path) =>
    prefixes.some((prefix) => prefix === "." || path === prefix || path.startsWith(prefix + "/")),
  );
}

const target = input?.tool_input?.file_path ?? input?.tool_input?.notebook_path;

if (!target) {
  process.exit(0);
}

const root = projectRoot();
function realPath(path, depth = 0) {
  if (depth > 40) throw new Error("Too many symlinks in " + path);
  try {
    return realpathSync.native(path);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    try {
      if (lstatSync(path).isSymbolicLink())
        return realPath(resolve(dirname(path), readlinkSync(path)), depth + 1);
    } catch (cause) {
      if (cause?.code !== "ENOENT") throw cause;
    }
    const parent = dirname(path);
    if (parent === path) return path;
    return resolve(realPath(parent, depth + 1), path.slice(parent.length + 1));
  }
}

function outside(path) {
  return path === ".." || path.startsWith(".." + sep) || isAbsolute(path);
}

const absoluteTarget = isAbsolute(target) ? target : resolve(input?.cwd ?? root, target);
const logical = relative(root, absoluteTarget);
const physical = relative(realPath(root), realPath(absoluteTarget));
if (isAbsolute(target) && outside(logical) && outside(physical)) process.exit(0);
if (!outside(logical) && outside(physical)) {
  process.stdout.write(JSON.stringify(deny(String(target) + " resolves outside the project root")));
  process.exit(0);
}
const path = isAbsolute(target) ? (outside(logical) ? physical : logical) : target;
const paths = physical !== path && !outside(physical) ? [path, physical] : [path];

// VISP state changes only through visp commands, which validate and record it. A worker
// that hand-edited the brief left it unreadable and abandoned the workflow. Drafts are
// the one place the workflow asks agents to write.
const statePath = path.replaceAll(String.fromCharCode(92), "/").toLowerCase();
if (
  (statePath === "__HOOK_STATE_DIR__" || statePath.startsWith("__HOOK_STATE_DIR__/")) &&
  !statePath.startsWith("__HOOK_STATE_DIR__/drafts/") &&
  !statePath.split("/").includes("..")
) {
  process.stdout.write(
    JSON.stringify(
      deny(
        `${path} is VISP state; change it only through \`__HOOK_PRODUCT_NAME__\` commands. For the brief, pipe changed fields: \`__HOOK_PRODUCT_NAME__ brief --patch - --reason "<why>"\`.`,
      ),
    ),
  );
  process.exit(0);
}

/**
 * The guard envelope, or undefined when this output did not come from guard.
 *
 * The exit status alone cannot answer that. An argument parser answers
 * __HOOK_EXIT_REFUSED__ for an unknown option, so a *different* `__HOOK_PRODUCT_NAME__` on
 * PATH — an older release, a similarly named tool — would make every write look
 * like a scope violation, and the agent would be sent to widen allowedFiles to
 * fix what is actually an install problem. A status of 0 from such a binary is
 * worse still: it would allow the write with nothing having been checked.
 *
 * So the envelope is the evidence, not the status. No envelope, no answer.
 */
function guardEnvelope(stdout) {
  try {
    const parsed = JSON.parse(stdout?.toString() ?? "");
    const data = parsed?.data;
    const valid =
      parsed?.command === "guard" &&
      typeof parsed.ok === "boolean" &&
      data?.protocolVersion === __HOOK_GUARD_PROTOCOL_VERSION__ &&
      data.runtime?.buildId === __HOOK_BUILD_ID__ &&
      data.runtime?.version === __HOOK_RUNTIME_VERSION__ &&
      Number.isInteger(data.checked) &&
      data.checked >= 0 &&
      typeof data.allowed === "boolean" &&
      Array.isArray(data.violations) &&
      Array.isArray(data.authorizedTasks) &&
      data.authorizedTasks.every((task) => typeof task === "string") &&
      (parsed.ok
        ? data.allowed === true && data.violations.length === 0
        : data.allowed === false &&
          data.violations.length > 0 &&
          data.violations.every((finding) => typeof finding?.message === "string"));
    return valid ? parsed : undefined;
  } catch {
    return undefined;
  }
}

let status = 0;
let stdout;
try {
  const asking =
    typeof input?.session_id === "string" && input.session_id ? ["--session", input.session_id] : [];
  stdout = execFileSync(process.execPath, [cli, "guard", "--path", ...paths, "--json", ...asking], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
  });
} catch (error) {
  status = typeof error?.status === "number" ? error.status : undefined;
  stdout = error?.stdout;
  if (error?.code) status = String(error.code);
}

const envelope = guardEnvelope(stdout);

if (envelope === undefined) {
  let authorization = "unknown";
  try {
    authorization = execFileSync(process.execPath, ["-e", __HOOK_AUTHORIZATION_CHECK__], {
      cwd: root,
      stdio: ["ignore", "pipe", "ignore"],
    }).toString().trim();
  } catch {}
  // No task is active, so there is nothing to enforce: leave Claude's own permission decision in place.
  if (authorization === "inactive") process.exit(0);
  let guardError;
  try { guardError = JSON.parse(stdout?.toString() ?? "").error?.message; } catch {}
  const cause = guardError || (status === 0 || status === __HOOK_EXIT_REFUSED__
    ? `no guard result on stdout — is the installed VISP CLI intact?`
    : `exit ${status}`);
  process.stdout.write(
    JSON.stringify(
      deny(
        `__HOOK_PRODUCT_NAME__ could not check ${path} (${cause}), so the write was refused rather than allowed unchecked. Run \`__HOOK_PRODUCT_NAME__ doctor\` to find out why.`,
      ),
    ),
  );
  process.exit(0);
}

// The Stop hook reminds only a session that tried to change the project. A refused edit is
// such a try: a later session refused under an accepted feature stopped with its request
// unbuilt, because only allowed edits were recorded.
if (typeof input?.session_id === "string") {
  try {
    const directory = join(root, ".visp", "session", "edits");
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, encodeURIComponent(input.session_id) + ".json"), JSON.stringify({ at: new Date().toISOString() }));
  } catch {}
}

if (status === 0 && envelope.ok) process.exit(0);

let reason = `${path} is outside the scope authorized for the current task.`;
const first = envelope?.data?.violations?.[0];
if (first?.message) {
  // Closing a task clears its authorization, so the window right after
  // `__HOOK_PRODUCT_NAME__ done` has none at all. Name the way forward rather than
  // leaving the agent with a refusal it cannot act on.
  if (first.reason === "no-authorization") {
    reason = `${first.message}. No task is authorized right now — run \`__HOOK_PRODUCT_NAME__ next\` to see what is next, then \`__HOOK_PRODUCT_NAME__ work --task <id>\`.`;
  } else if (first.reason === "outside-allowed-files") {
    reason = `${first.message}. Authorize the task that owns this file, or widen its allowedFiles — do not work around the refusal.`;
  } else if (first.reason === "transaction-pending") {
    reason = first.message;
  } else {
    reason = `${first.message}. This path cannot be written by any task.`;
  }
}
process.stdout.write(JSON.stringify(deny(reason)));
