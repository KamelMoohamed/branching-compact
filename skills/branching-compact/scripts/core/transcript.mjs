// transcript.mjs — the agent-independent transcript model and turn analysis.
//
// A native session file is a JSONL stream whose line shapes differ per agent.
// An adapter turns those lines into the one thing the branching engine needs:
// where each *genuine human turn* begins. Everything downstream — clustering,
// selection, branch writing — works on that normalized view and never learns
// which agent produced the file.
//
// The normalized conversation is deliberately held **by reference**: a turn
// records the half-open line range `[start_line, end_line)` of the native
// records it owns rather than their content. Real transcripts reach tens of
// megabytes, and the whole point of the tool is to avoid pulling them into
// anyone's context, so nothing here ever holds more than one line at a time.
//
//   normalized turn = {
//     turn_id,          // 1-based ordinal, stable within one analysis
//     start_line,       // first native record of the turn (inclusive)
//     end_line,         // first native record of the next turn (exclusive)
//     chars,            // raw bytes of the range — a context-weight proxy
//     pct,              // chars as a share of the whole session
//     snippet,          // the human message that opened the turn
//   }
//
// Zero dependencies — Node built-ins only.

import fs from 'node:fs';
import readline from 'node:readline';

export function snippetOf(text, max) {
  const flat = String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return flat.length <= max ? flat : flat.slice(0, max - 1) + '…';
}

// Stream a JSONL file line by line. Unparseable lines yield `null` rather than
// throwing: a live session's tail can be a half-written line, and it still
// counts toward the enclosing turn's range.
export async function* readRecords(file) {
  const rl = readline.createInterface({
    input: fs.createReadStream(file, { encoding: 'utf8', flags: 'r' }),
    crlfDelay: Infinity,
  });
  let lineNo = 0;
  for await (const line of rl) {
    lineNo++;
    let entry = null;
    if (line.trim()) {
      try {
        entry = JSON.parse(line);
      } catch {
        entry = null;
      }
    }
    yield { lineNo, line, entry };
  }
}

/**
 * Analyze a native session into normalized turns.
 *
 * The adapter supplies two things:
 *   `prepare(file)`  — optional first pass, returns opaque state
 *   `classify(entry, lineNo, state)` — `{ turnStart, text }` for each record
 *
 * @param {string} file        path to the native session file
 * @param {object} adapter     agent adapter
 * @param {object} [options]
 * @param {number} [options.snippet=200]  snippet length in characters
 */
export async function analyzeSession(file, adapter, options = {}) {
  const snippetLen = options.snippet ?? 200;
  const state = adapter.prepare ? await adapter.prepare(file) : null;

  const turns = [];
  let lineNo = 0;
  let totalChars = 0;
  let preambleChars = 0;
  let current = null;
  let header = null;

  for await (const rec of readRecords(file)) {
    lineNo = rec.lineNo;
    totalChars += rec.line.length;
    if (lineNo === 1) header = rec.entry;

    const verdict = rec.entry ? adapter.classify(rec.entry, lineNo, state) : null;
    if (verdict && verdict.turnStart) {
      if (current) current.end_line = lineNo;
      current = {
        turn_id: turns.length + 1,
        start_line: lineNo,
        end_line: lineNo + 1,
        chars: 0,
        pct: 0,
        snippet: snippetOf(verdict.text, snippetLen),
      };
      turns.push(current);
    }

    if (current) current.chars += rec.line.length;
    else preambleChars += rec.line.length;
  }

  if (current) current.end_line = lineNo + 1;

  if (adapter.validateHeader) adapter.validateHeader(header, file);

  for (const t of turns) {
    t.pct = totalChars ? Math.round((t.chars / totalChars) * 1000) / 10 : 0;
  }

  const firstTurnLine = turns.length ? turns[0].start_line : lineNo + 1;

  return {
    agent: adapter.id,
    session_file: file,
    session_id: adapter.sessionIdFor(file, header),
    total_lines: lineNo,
    total_chars: totalChars,
    preamble: { start_line: 1, end_line: firstTurnLine, chars: preambleChars },
    turn_count: turns.length,
    turns,
  };
}
