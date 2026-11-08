// Converts between the issue bodies the SDLC writes (markdown with sdlc markers and fenced
// blocks, see issue-body.mjs) and Jira's document format (ADF). Only the shapes the SDLC writes
// need to survive: headings, paragraphs and code blocks. A code block keeps its text exactly;
// the owner's words and the spec section are found again by the heading in front of them,
// because Jira drops HTML comments and may drop an unknown code-block language.

const MARKERS = {
  owner: ["<!-- sdlc:owner-text -->", "<!-- /sdlc:owner-text -->"],
  spec: ["<!-- sdlc:spec -->", "<!-- /sdlc:spec -->"],
};
const OWNER_HEADING = "The owner's words";
const SPEC_HEADING = "Spec";

export function bodyToAdf(body) {
  const lines = body.replace(/\r\n/g, "\n").split("\n");
  const content = [];
  let paragraph = [];
  const flush = () => {
    const text = paragraph.join("\n").trim();
    if (text) content.push({ type: "paragraph", content: [{ type: "text", text }] });
    paragraph = [];
  };
  let i = 0;
  while (i < lines.length) {
    const block = blockAt(lines, i);
    if (block) {
      flush();
      if (block.node) content.push(block.node);
      i = block.end + 1;
    } else {
      paragraph.push(lines[i]);
      i += 1;
    }
  }
  flush();
  return { type: "doc", version: 1, content };
}

// The node that starts at line i, with the last line it uses, or undefined for paragraph text.
// Blank lines and the spec markers end a paragraph and add nothing.
function blockAt(lines, i) {
  const line = lines[i];
  if (line === MARKERS.owner[0]) {
    const end = lines.indexOf(MARKERS.owner[1], i + 1);
    return { node: codeBlock("text", lines.slice(i + 1, end).join("\n")), end };
  }
  if (line.trim() === "" || line === MARKERS.spec[0] || line === MARKERS.spec[1]) {
    return { end: i };
  }
  const heading = line.match(/^(#{1,6}) (.*)$/);
  if (heading) {
    const text = [{ type: "text", text: heading[2] }];
    return {
      node: { type: "heading", attrs: { level: heading[1].length }, content: text },
      end: i,
    };
  }
  const fence = line.match(/^```([\w-]*)\s*$/);
  if (!fence) return undefined;
  let end = i + 1;
  while (end < lines.length && !/^```\s*$/.test(lines[end])) end++;
  return { node: codeBlock(fence[1] || "text", lines.slice(i + 1, end).join("\n")), end };
}

// The body again, with the sdlc markers put back around the owner's words and the spec section.
export function adfToBody(adf) {
  const out = [];
  let section;
  for (const node of adf?.content ?? []) {
    const level = node.attrs?.level ?? 2;
    if (node.type === "heading" && !(section === "spec" && level > 2)) {
      section = openSection(out, section, textOf(node), level);
    } else if (node.type === "codeBlock" && section === "owner") {
      out.push(MARKERS.owner[0], textOf(node), MARKERS.owner[1], "");
      section = undefined;
    } else {
      out.push(...rendered(node, level));
    }
  }
  if (section === "spec") out.push(MARKERS.spec[1], "");
  return out.join("\n");
}

// A top-level heading closes the spec section and may open the owner's or the spec section.
function openSection(out, previous, text, level) {
  if (previous === "spec") out.push(MARKERS.spec[1], "");
  const section = text === SPEC_HEADING ? "spec" : text === OWNER_HEADING ? "owner" : undefined;
  out.push(`${"#".repeat(level)} ${text}`, "");
  if (section === "spec") out.push(MARKERS.spec[0]);
  return section;
}

function rendered(node, level) {
  if (node.type === "heading") return [`${"#".repeat(level)} ${textOf(node)}`, ""];
  if (node.type !== "codeBlock") return [textOf(node), ""];
  const language = node.attrs?.language;
  return [`\`\`\`${language && language !== "text" ? language : ""}`, textOf(node), "```", ""];
}

function codeBlock(language, text) {
  return {
    type: "codeBlock",
    attrs: { language },
    content: text ? [{ type: "text", text }] : [],
  };
}

function textOf(node) {
  if (node.type === "text") return node.text ?? "";
  if (node.type === "hardBreak") return "\n";
  const parts = (node.content ?? []).map(textOf);
  return node.type === "paragraph" || node.type === "heading" || node.type === "codeBlock"
    ? parts.join("")
    : parts.join("\n");
}
