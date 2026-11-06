// V8 coverage of the node processes a test file starts, mostly the CLI from dist/. Each process
// writes a profile of everything it ran (about 6 MB); after the test file only this repository's
// dist/ scripts are kept and merged into one profile per test file, and the raw profiles go.
import { readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import v8Coverage from "@bcoe/v8-coverage";

export function collectChildProfiles(rawDir, outFile, { distDir, testFile }) {
  const distUrl = `${pathToFileURL(distDir).href}/`;
  const profiles = [];
  for (const name of readdirSync(rawDir)) {
    const profile = readProfile(join(rawDir, name));
    const result = profile?.result.filter((script) => script.url.startsWith(distUrl)) ?? [];
    if (result.length > 0) profiles.push({ result });
  }
  rmSync(rawDir, { recursive: true, force: true });
  if (profiles.length === 0) return false;
  const merged = v8Coverage.mergeProcessCovs(profiles);
  writeFileSync(outFile, JSON.stringify({ testFile, processes: profiles.length, ...merged }));
  return true;
}

// A process still writing its profile when the test file ends leaves invalid JSON; it is skipped.
function readProfile(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}
