// Inserted into the PreToolUse hook as one function expression; it must stay self-contained.
// Every file a Codex apply_patch patch adds, updates, deletes or moves (both ends of a move),
// as written in its headers. Undefined when a line fits no part of the patch grammar, so the
// hook can refuse a patch it cannot read instead of letting unnamed files through.
export function patchPaths(patch) {
  const lines = String(patch).split("\n").map((line) => line.replace(/\r$/, ""));
  const begin = lines.findIndex((line) => line.trim() === "*** Begin Patch");
  if (begin < 0) return undefined;
  const headers = [
    ["*** Add File: ", "add"],
    ["*** Update File: ", "update"],
    ["*** Delete File: ", "delete"],
  ];
  const paths = [];
  let body;
  // A move is the line right after its Update header.
  let movable = false;
  for (const line of lines.slice(begin + 1)) {
    const header = line.trim();
    if (header === "*** End Patch") return paths;
    if (movable && header.startsWith("*** Move to: ")) {
      const target = header.slice("*** Move to: ".length).trim();
      if (!target) return undefined;
      paths.push(target);
      movable = false;
      continue;
    }
    movable = false;
    if (body === "add" && line.startsWith("+")) continue;
    if (body === "update" && (/^[ +-]/.test(line) || line.startsWith("@@") || header === "*** End of File")) continue;
    if (header === "") continue;
    const found = headers.find(([prefix]) => header.startsWith(prefix));
    if (!found) return undefined;
    const path = header.slice(found[0].length).trim();
    if (!path) return undefined;
    paths.push(path);
    body = found[1];
    movable = body === "update";
  }
  return undefined;
}
