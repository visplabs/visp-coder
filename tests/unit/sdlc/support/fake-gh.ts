import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// A stand-in `gh` for hook tests. Issues live as issue-<n>.json in `dir`; every call is logged
// to calls.jsonl with the gh config directory it ran under, so tests can tell owner calls from
// agent calls.

const SCRIPT = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const dir = process.env.FAKE_DIR;
const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const body = () => flag("--body-file") ? fs.readFileSync(flag("--body-file"), "utf8") : flag("--body");
const issuePath = (n) => path.join(dir, "issue-" + n + ".json");
fs.appendFileSync(path.join(dir, "calls.jsonl"), JSON.stringify({
  args, config: process.env.GH_CONFIG_DIR ?? null, body: body() ?? null,
}) + "\\n");
const [group, action, number] = args;
if (group === "api" && action === "graphql") {
  const field = args.find((arg) => arg.startsWith("number="));
  process.stdout.write(fs.readFileSync(path.join(dir, "graphql-" + field.slice(7) + ".json"), "utf8"));
} else if (group === "repo" && action === "view") {
  process.stdout.write(JSON.stringify({ nameWithOwner: "o/r" }));
} else if (group === "pr" && action === "view") {
  process.stdout.write(fs.readFileSync(path.join(dir, "pr-" + number + ".json"), "utf8"));
} else if (group === "api") {
  const file = path.join(dir, "sub-issues.json");
  process.stdout.write(fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "[]");
} else if (group === "issue" && action === "create") {
  const next = fs.existsSync(path.join(dir, "next")) ? fs.readFileSync(path.join(dir, "next"), "utf8").trim() : "20";
  const url = "https://github.com/o/r/issues/" + next;
  fs.writeFileSync(issuePath(next), JSON.stringify({ title: flag("--title"), body: body(), updatedAt: "2026-11-05T10:00:00Z", url }));
  process.stdout.write(url + "\\n");
} else if (group === "issue" && action === "view") {
  process.stdout.write(fs.readFileSync(issuePath(number), "utf8"));
} else if (group === "issue" && action === "edit" && body() !== undefined) {
  const issue = JSON.parse(fs.readFileSync(issuePath(number), "utf8"));
  fs.writeFileSync(issuePath(number), JSON.stringify({ ...issue, body: body(), updatedAt: "2026-11-05T11:00:00Z" }));
} else if (group === "issue" && action === "comment") {
  process.stdout.write("https://github.com/o/r/issues/" + number + "#issuecomment-1\\n");
}
`;

export function installFakeGh(dir: string): string {
  const path = join(dir, "fake-gh");
  writeFileSync(path, SCRIPT);
  chmodSync(path, 0o755);
  return path;
}

export function setFakeIssue(dir: string, number: number, body: string, title = "Work log") {
  const issue = { title, body, updatedAt: "2026-11-05T10:00:00Z", url: `https://x/${number}` };
  writeFileSync(join(dir, `issue-${number}.json`), JSON.stringify(issue));
}

const block = (text: string) => `\`\`\`yaml\n${text}\n\`\`\``;

// A feature issue body as /feature writes it, with the spec section filled or empty.
export function featureBody(ownerText: string, specBlocks: string[] = []) {
  const spec = specBlocks.length > 0 ? specBlocks.map(block).join("\n\n") : "_No spec yet._";
  return [
    "<!-- sdlc:owner-text -->",
    ownerText,
    "<!-- /sdlc:owner-text -->",
    "",
    "<!-- sdlc:spec -->",
    spec,
    "<!-- /sdlc:spec -->",
  ].join("\n");
}
