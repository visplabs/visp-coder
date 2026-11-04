// Path globs for task scopes: `*` matches within one path segment, `**` across segments and
// `?` one character. Paths use `/` and are relative to the repository root.

export function matchesAny(path, globs) {
  return globs.some((glob) => globToRegExp(glob).test(path));
}

function globToRegExp(glob) {
  let pattern = "";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === "*" && glob[i + 1] === "*") {
      i++;
      if (glob[i + 1] === "/") {
        i++;
        pattern += "(?:.*/)?";
      } else {
        pattern += ".*";
      }
    } else if (ch === "*") {
      pattern += "[^/]*";
    } else if (ch === "?") {
      pattern += "[^/]";
    } else {
      pattern += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${pattern}$`);
}
