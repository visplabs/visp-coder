// Splits a shell command line into simple commands, each a list of words, without running it.
// Quotes and backslashes are honoured, and `&&`, `||`, `;`, `|`, `&`, newlines and parentheses
// end a command only outside quotes. Nothing is expanded: this serves a guard, not a shell.

const OPERATORS = new Set(["&", "|", ";", "\n", "(", ")"]);

export function splitCommands(line) {
  const state = { commands: [], words: [], word: "", inWord: false };
  let i = 0;
  while (i < line.length) i = step(state, line, i);
  endWord(state);
  endCommand(state);
  return state.commands;
}

function step(state, line, i) {
  const ch = line[i];
  if (ch === "'" || ch === '"') return readQuoted(state, line, i + 1, ch);
  if (ch === "\\") {
    state.word += line[i + 1] ?? "";
    state.inWord = true;
    return i + 2;
  }
  if (ch === " " || ch === "\t") {
    endWord(state);
    return i + 1;
  }
  if (OPERATORS.has(ch)) {
    endWord(state);
    endCommand(state);
    return i + 1;
  }
  state.word += ch;
  state.inWord = true;
  return i + 1;
}

function readQuoted(state, line, start, quote) {
  state.inWord = true;
  let i = start;
  while (i < line.length && line[i] !== quote) {
    if (quote === '"' && line[i] === "\\" && i + 1 < line.length) i++;
    state.word += line[i];
    i++;
  }
  return i + 1;
}

function endWord(state) {
  if (state.inWord) state.words.push(state.word);
  state.word = "";
  state.inWord = false;
}

function endCommand(state) {
  if (state.words.length > 0) state.commands.push(state.words);
  state.words = [];
}
