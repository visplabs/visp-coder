// sdlc validate <file...>: checks YAML files against the schema each one names.

import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { validateDocument } from "../schemas/index.mjs";

export function run(files) {
  if (files.length === 0) throw new Error("name at least one file");
  let failed = 0;
  for (const file of files) {
    const result = validateDocument(parse(readFileSync(file, "utf8")));
    if (result.ok) {
      console.log(`ok ${file}`);
      continue;
    }
    failed += 1;
    for (const error of result.errors) console.error(`${file}: ${error}`);
  }
  return failed > 0 ? 1 : 0;
}
