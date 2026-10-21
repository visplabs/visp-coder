import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { GraphConfig } from "../../config/schema.js";
import { hashValue, sha256 } from "../../core/hash.js";
import { GRAMMARS } from "../constants.js";
import { type AliasSources, loadAliases } from "./tsconfig.js";

/** Bump when resolution/extraction behavior changes without a grammar byte change. */
const EXTRACTOR_REVISION = 4;
const wasmDirectory = dirname(createRequire(import.meta.url).resolve("@vscode/tree-sitter-wasm"));

export async function extractionInputs(
  root: string,
  config: GraphConfig,
): Promise<{ readonly fingerprint: string; readonly aliases: AliasSources }> {
  const aliases = await loadAliases(root);
  const grammars = GRAMMARS.filter((grammar) =>
    config.languages.includes(grammar === "tsx" ? "typescript" : grammar),
  );
  const runtime = await Promise.all(
    [
      "tree-sitter.js",
      "tree-sitter.wasm",
      ...grammars.map((name) => `tree-sitter-${name}.wasm`),
    ].map(async (name) => {
      try {
        return [name, sha256(await readFile(join(wasmDirectory, name)))];
      } catch (cause) {
        return [name, `unreadable:${(cause as NodeJS.ErrnoException).code ?? "unknown"}`];
      }
    }),
  );
  return {
    aliases,
    fingerprint: hashValue({
      extractor: EXTRACTOR_REVISION,
      runtime,
      languages: [...new Set(config.languages)].sort(),
      // Exclude patterns can be ordered negations; preserve their order.
      exclude: config.exclude,
      maxFileBytes: config.maxFileBytes,
      configs: aliases.sources,
    }),
  };
}
