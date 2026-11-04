// Reads the fenced ```yaml blocks in a GitHub issue body. A block with a top-level `schema`
// field is a spec block; other blocks are left alone.

import { parse } from "yaml";

const FENCE = /^```ya?ml[^\n]*\n([\s\S]*?)^```[ \t]*$/gm;

export function yamlBlocks(markdown) {
  const text = markdown.replace(/\r\n/g, "\n");
  const blocks = [];
  let index = 0;
  for (const match of text.matchAll(FENCE)) {
    index += 1;
    let doc;
    try {
      doc = parse(match[1]);
    } catch (error) {
      throw new Error(`yaml block ${index} does not parse: ${error.message}`);
    }
    if (doc && typeof doc === "object" && "schema" in doc) blocks.push(doc);
  }
  return blocks;
}
