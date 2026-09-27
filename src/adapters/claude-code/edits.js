// What a Claude Code file tool will leave on disk, computed before it runs, so the guard
// can judge the write in PreToolUse. Claude Code runs the tool itself; the store only
// sees the prediction (prepareWrite) and then the file (commitWrite). A wrong prediction
// is not a silent error: the commit notices the file differs and marks the entry `raced`.

/**
 * Where `needle` is in `text`, and how many times. When the exact text is absent, two
 * leniencies Claude Code's Edit applies are tried (not verified against every version):
 * line endings (the file has CRLF, the model sent LF) and typographic quotes (the file
 * has curly quotes, the model sent straight ones). Both keep offsets aligned.
 * @param {string} text
 * @param {string} needle
 * @returns {{ count: number, at: number, length: number, crlf: boolean }}
 */
function locate(text, needle) {
  const exact = occurrences(text, needle);
  if (exact.count > 0) return { ...exact, length: needle.length, crlf: false };
  if (text.includes('\r\n') && needle.includes('\n') && !needle.includes('\r\n')) {
    const crlfNeedle = needle.replace(/\n/g, '\r\n');
    const found = occurrences(text, crlfNeedle);
    if (found.count > 0) return { ...found, length: crlfNeedle.length, crlf: true };
  }
  const plainText = straightQuotes(text);
  const plainNeedle = straightQuotes(needle);
  if (plainText !== text || plainNeedle !== needle) {
    const found = occurrences(plainText, plainNeedle);
    if (found.count > 0) return { ...found, length: needle.length, crlf: false };
  }
  return { count: 0, at: -1, length: needle.length, crlf: false };
}

/** @param {string} s */
const straightQuotes = (s) => s.replace(/[‘’]/g, "'").replace(/[“”]/g, '"');

/**
 * @param {string} text
 * @param {string} needle
 */
function occurrences(text, needle) {
  let count = 0;
  let at = -1;
  for (let i = text.indexOf(needle); i !== -1; i = text.indexOf(needle, i + needle.length)) {
    if (count === 0) at = i;
    count++;
  }
  return { count, at };
}

/**
 * One exact replacement, the way Edit does it; null when Edit would refuse.
 * @param {string|null} before
 * @param {unknown} oldString
 * @param {unknown} newString
 * @param {unknown} replaceAll
 * @returns {string|null}
 */
function applyEdit(before, oldString, newString, replaceAll) {
  if (typeof oldString !== 'string' || typeof newString !== 'string') return null;
  if (before === null) return oldString === '' ? newString : null; // Edit with an empty old_string creates the file
  if (oldString === '' || oldString === newString) return null;
  const found = locate(before, oldString);
  if (found.count === 0) return null;
  if (found.count > 1 && replaceAll !== true) return null;
  const replacement = found.crlf ? newString.replace(/\r?\n/g, '\r\n') : newString;
  if (found.count === 1 || replaceAll !== true) {
    return before.slice(0, found.at) + replacement + before.slice(found.at + found.length);
  }
  // replace_all: every occurrence of the form that matched.
  const needle = before.slice(found.at, found.at + found.length);
  return before.split(needle).join(replacement);
}

/**
 * The content the tool will leave, or null when it is not a file tool we govern or the
 * edit will fail on its own (the old text is not there, or is there more than once).
 * @param {string} tool     'Write' | 'Edit' | 'MultiEdit'
 * @param {unknown} input   the tool_input of the hook event
 * @param {string|null} before  the file now (null: it does not exist)
 * @returns {string|null}
 */
export function predictAfter(tool, input, before) {
  if (input === null || typeof input !== 'object') return null;
  const x = /** @type {Record<string, unknown>} */ (input);
  if (tool === 'Write') return typeof x.content === 'string' ? x.content : null;
  if (tool === 'Edit') return applyEdit(before, x.old_string, x.new_string, x.replace_all);
  if (tool === 'MultiEdit') {
    if (!Array.isArray(x.edits) || x.edits.length === 0) return null;
    let text = before;
    for (const edit of x.edits) {
      if (edit === null || typeof edit !== 'object') return null;
      const e = /** @type {Record<string, unknown>} */ (edit);
      text = applyEdit(text, e.old_string, e.new_string, e.replace_all);
      if (text === null) return null;
    }
    return text;
  }
  return null;
}
