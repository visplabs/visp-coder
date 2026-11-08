import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// A stand-in `gh` for the CI gate's tests: `gh pr view <n>` prints pr-<n>.json and
// `gh pr checks <n>` checks-<n>.json and `gh pr list` pr-list.json from FAKE_DIR.

const SCRIPT = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const [group, action, number] = process.argv.slice(2);
const file = { view: "pr-" + number, checks: "checks-" + number, list: "pr-list" }[action];
if (group === "pr" && file) {
  process.stdout.write(fs.readFileSync(path.join(process.env.FAKE_DIR, file + ".json"), "utf8"));
} else {
  process.stderr.write("fake gh: unsupported " + process.argv.slice(2).join(" ") + "\\n");
  process.exit(1);
}
`;

export function installFakeGh(dir: string): string {
  const path = join(dir, "fake-gh");
  writeFileSync(path, SCRIPT);
  chmodSync(path, 0o755);
  return path;
}
