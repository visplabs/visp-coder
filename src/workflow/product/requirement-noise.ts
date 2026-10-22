/**
 * Text in a request that is not a product requirement. The lister takes every list item and
 * sentence, and a request often carries more than the user's task: the host or benchmark
 * wrapper says how to work ("Run every shell command from that directory", "Do not ask
 * questions"), and a bug report pastes code, logs and tracebacks. In benchmark batch leandef2
 * four of six lean runs had their wrapper become R001–R005, and across 214 ChainSWE issues
 * wrapped the same way the median listing was 18 "requirements" (6 for the issue text alone);
 * a listing over 20 moves the feature to the full loop.
 */

/**
 * A sentence that tells the agent how to work or what the host provides, in the words hosts and
 * benchmark wrappers use. Narrow on purpose: a requirement that happens to say "Do not ask the
 * user twice" is the product's, so each pattern names agent-process vocabulary.
 */
const PROCESS_INSTRUCTIONS: readonly RegExp[] = [
  /^This (?:project|repository) uses (?:VISP|visp)\b/i,
  /^(?:Read|Follow|See) (?:the )?(?:CLAUDE|AGENTS)\.md\b/i,
  /\b(?:CLAUDE|AGENTS)\.md\b.*\b(?:before starting|and follow them)\b/i,
  /^Your (?:project|working) directory is\b/i,
  /^(?:Run|Start|Prefix) (?:every|each|all) (?:shell )?(?:command|commands)\b/i,
  /\bcreate or edit files only inside\b/i,
  /^Do not (?:read|open|look at) (?:any )?other (?:directories|folders|files)\b/i,
  /^Do not ask (?:any )?questions\s*[:;.,]|^Do not ask (?:any )?questions$/i,
  /\bmake reasonable assumptions and continue\b/i,
  /^Do not delegate\b/i,
  /^No (?:dependency|package) (?:downloads|installs)\b/i,
  /\b(?:finish|end) with a (?:short |brief )?(?:report|summary)\b/i,
  /\bwhat you actually verified\b/i,
  /^Resolve this (?:GitHub )?issue in\b/i,
  /^Change the project's source so the reported problem is fixed\b/i,
  /\bHidden tests? (?:will|would) (?:check|test)\b/i,
  /\.\/swe-test\b/i,
  /^Task:$/i,
];

/** True for a list item or sentence that instructs the agent instead of stating the product. */
export function isProcessInstruction(text: string): boolean {
  const statement = text.trim();
  return PROCESS_INSTRUCTIONS.some((pattern) => pattern.test(statement));
}

const BOX_DRAWING = /[─-╿]/;
const PYTHON_FRAME = /^\s*File ".*", line \d+/;
const JS_FRAME = /^\s*at\s+\S.*\(.*:\d+(?::\d+)?\)\s*$|^\s*at\s+\S+:\d+(?::\d+)?\s*$/;
const ERROR_LINE =
  /^(?:[A-Za-z_][\w.]*\.)?[A-Z]\w*(?:Error|Exception|Warning|Failure|Exit)(?::|\s*\()/;
const LOG_LEVEL = /^\s*\[?(?:DEBUG|INFO|WARN(?:ING)?|ERROR|CRITICAL|FATAL|TRACE)\]?(?:[:\s|-]|$)/;
const TIMESTAMP = /^\s*\[?\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/;
const SHELL_PROMPT = /^\s*(?:\$|>>>|\.\.\.|In \[\d+\]:|Out\[\d+\]:)\s/;
const TEST_RESULT = /^(?:FAILED|PASSED|ERROR|XFAIL) \S+|^\S+\.py::\S+|^(?:E|>)\s{2,}\S/;
const SEPARATOR = /^[\s\-=_*~#+|.:^]{3,}$/;
const MARKUP_ONLY = /^(?:<!--.*-->|\*\*[^*]+\*\*:?|__[^_]+__:?|_[^_]+_|#{1,6}\s.*)$/;
const CODE_START =
  /^(?:(?:async\s+)?def|class)\s+\w+.*[:(]\s*$|^@\w[\w.]*(?:\(.*\))?$|^import\s+[\w.]+(?:\s+as\s+\w+)?(?:\s*,\s*[\w.]+)*$|^from\s+[\w.]+\s+import\s+\S+/;
const CODE_STATEMENT = /^(?:return|raise|assert|await|yield)\b.*[()[\]{};]/;
const ASSIGNMENT = /^[A-Za-z_][\w.[\]"']*\s*(?:[-+*/|&%]|\*\*)?=(?!=)\s*\S/;
const CODE_CALL = /^[A-Za-z_][\w.]*\(.*\)[,;:]?$|^[A-Za-z_][\w.]*\($/;
const CODE_OPEN = /^[\])}]+[,;:]?$|[{([]\s*$|^[{}[\]]/;
const SHELL_COMMAND =
  /^(?:pip3?|npm|pnpm|yarn|git|cargo|pytest|tox|nox|python3?|node)\s+(?:-{1,2}\w|install\b|run\b|test\b|build\b|commit\b|add\b|status\b|diff\b|checkout\b|[\w./-]+\.(?:py|js|mjs|ts|rs|sh)\b)/;
const HTML_TAG = /^<\/?[a-zA-Z][^>]*>/;
const INDENT = /^(?: {4,}|\t)/;
/** A whole line in one inline-code span: pasted code, not a sentence. */
const CODE_SPAN = /^`[^`]+`[,.;:]?$/;
/** `Label: value` (or a bare `Label:`) with a short label and no sentence end: a line of a pasted dump. */
const LABEL_VALUE = /^[A-Za-z][\w .()/%-]{0,38}:(?:\s+\S.*(?<![.!?]))?$/;
/** Consecutive label lines (four or more) that make a pasted environment or version dump. */
const DUMP_RUN = 4;

/**
 * A line outside lists that is pasted material, not prose: code, a traceback, a log or terminal
 * transcript, test output, a table, a separator or markup (headings, bold labels, HTML comments).
 * List items and their continuations are not tested: a user's bullet is theirs, whatever it says.
 */
export function isPastedLine(line: string): boolean {
  const text = line.trim();
  if (!text) return false;
  if (INDENT.test(line) || BOX_DRAWING.test(text)) return true;
  if (SEPARATOR.test(text) || MARKUP_ONLY.test(text) || HTML_TAG.test(text)) return true;
  if (CODE_SPAN.test(text)) return true;
  if (/^Traceback \(most recent call last\)/.test(text)) return true;
  if (PYTHON_FRAME.test(line) || JS_FRAME.test(line) || ERROR_LINE.test(text)) return true;
  if (LOG_LEVEL.test(line) || TIMESTAMP.test(line) || SHELL_PROMPT.test(line)) return true;
  if (TEST_RESULT.test(text) || SHELL_COMMAND.test(text)) return true;
  return (
    CODE_START.test(text) ||
    CODE_STATEMENT.test(text) ||
    ASSIGNMENT.test(text) ||
    CODE_CALL.test(text) ||
    CODE_OPEN.test(text)
  );
}

/** The indexes of lines that sit in a run of three or more label lines, a pasted dump. */
export function dumpLineIndexes(lines: readonly string[]): ReadonlySet<number> {
  const dump = new Set<number>();
  let run: number[] = [];
  const close = () => {
    if (run.length >= DUMP_RUN) for (const index of run) dump.add(index);
    run = [];
  };
  lines.forEach((line, index) => {
    if (LABEL_VALUE.test(line.trim())) run.push(index);
    else close();
  });
  close();
  return dump;
}
