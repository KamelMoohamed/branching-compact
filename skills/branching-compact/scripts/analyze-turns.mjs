#!/usr/bin/env node
// analyze-turns.mjs — parse a Claude Code JSONL transcript into compact turn summaries.
//
//   node analyze-turns.mjs <session.jsonl> [--snippet N]
//   node analyze-turns.mjs --latest [--cwd DIR] [--snippet N]
//
// Prints compact JSON to stdout. Read-only: never opens the transcript for writing.
// Zero dependencies — Node built-ins only.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline';

const SYNTHETIC_USER_TEXT = [
  '[Request interrupted by user]',
  '[Request interrupted by user for tool use]',
  '(no content)',
];

function usage(code = 2) {
  process.stderr.write(
    'usage: analyze-turns.mjs <session.jsonl> [--snippet N]\n' +
      '       analyze-turns.mjs --latest [--cwd DIR] [--snippet N]\n'
  );
  process.exit(code);
}

function parseArgs(argv) {
  const opts = { file: null, latest: false, cwd: process.cwd(), snippet: 200 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--latest') opts.latest = true;
    else if (a === '--cwd') opts.cwd = argv[++i] ?? usage();
    else if (a === '--snippet') opts.snippet = Number(argv[++i]);
    else if (a === '-h' || a === '--help') usage(0);
    else if (a.startsWith('-')) usage();
    else if (opts.file === null) opts.file = a;
    else usage();
  }
  if (!Number.isFinite(opts.snippet) || opts.snippet < 1) usage();
  if (!opts.file && !opts.latest) usage();
  return opts;
}

// Claude Code encodes a project path into a directory name by replacing every
// character outside [A-Za-z0-9] with a dash.
export function encodeProjectPath(p) {
  return p.replace(/[^A-Za-z0-9]/g, '-');
}

// Transcripts live either at <projects>/<encoded>/<id>.jsonl or, on some
// versions, <projects>/<encoded>/sessions/<id>.jsonl. Check both.
export function findLatestSession(cwd, home = os.homedir()) {
  const root = path.join(home, '.claude', 'projects', encodeProjectPath(path.resolve(cwd)));
  const dirs = [path.join(root, 'sessions'), root];
  let best = null;
  for (const dir of dirs) {
    let entries;
    try {
      entries = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (!name.endsWith('.jsonl')) continue;
      const full = path.join(dir, name);
      let st;
      try {
        st = fs.statSync(full);
      } catch {
        continue;
      }
      if (!st.isFile()) continue;
      if (!best || st.mtimeMs > best.mtimeMs) best = { file: full, mtimeMs: st.mtimeMs };
    }
  }
  if (!best) {
    throw new Error(`no .jsonl transcript found for project ${cwd} (looked under ${root})`);
  }
  return best.file;
}

// Pull the human-authored text out of a user-role message, dropping the
// wrappers Claude Code injects around it.
export function userText(message) {
  if (!message) return '';
  const content = message.content;
  let raw = '';
  if (typeof content === 'string') {
    raw = content;
  } else if (Array.isArray(content)) {
    // A message carrying any tool_result block is a tool response, not a prompt.
    if (content.some((b) => b && b.type === 'tool_result')) return '';
    raw = content
      .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('\n');
  } else {
    return '';
  }
  return raw
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/<local-command-stdout>[\s\S]*?<\/local-command-stdout>/g, '')
    .replace(/<\/?command-(?:name|message|args|contents)>/g, ' ')
    .replace(/^\[Image:[^\]]*\]$/gm, '')
    .trim();
}

// A turn starts at a genuine human message. Injected context (isMeta), subagent
// traffic (isSidechain), tool results and synthetic markers are not turn starts.
export function isTurnStart(entry) {
  if (!entry || entry.type !== 'user' || !entry.message) return false;
  if (entry.message.role && entry.message.role !== 'user') return false;
  if (entry.isMeta === true || entry.isSidechain === true) return false;
  const text = userText(entry.message);
  if (!text) return false;
  if (SYNTHETIC_USER_TEXT.includes(text)) return false;
  if (text.startsWith('Caveat: The messages below were generated')) return false;
  return true;
}

function snippetOf(text, max) {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : flat.slice(0, max - 1) + '…';
}

export async function analyze(file, snippetLen = 200) {
  const turns = [];
  let lineNo = 0;
  let totalChars = 0;
  let preambleChars = 0;
  let current = null;

  const rl = readline.createInterface({
    input: fs.createReadStream(file, { encoding: 'utf8', flags: 'r' }),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    lineNo++;
    const chars = line.length;
    totalChars += chars;

    let entry = null;
    if (line.trim()) {
      try {
        entry = JSON.parse(line);
      } catch {
        entry = null; // a truncated tail line still counts toward the range
      }
    }

    if (entry && isTurnStart(entry)) {
      if (current) current.end_line = lineNo;
      current = {
        turn_id: turns.length + 1,
        start_line: lineNo,
        end_line: lineNo + 1,
        chars: 0,
        pct: 0,
        snippet: snippetOf(userText(entry.message), snippetLen),
      };
      turns.push(current);
    }

    if (current) current.chars += chars;
    else preambleChars += chars;
  }

  if (current) current.end_line = lineNo + 1;

  const firstTurnLine = turns.length ? turns[0].start_line : lineNo + 1;
  for (const t of turns) {
    t.pct = totalChars ? Math.round((t.chars / totalChars) * 1000) / 10 : 0;
  }

  return {
    session_file: file,
    session_id: path.basename(file, '.jsonl'),
    total_lines: lineNo,
    total_chars: totalChars,
    preamble: { start_line: 1, end_line: firstTurnLine, chars: preambleChars },
    turn_count: turns.length,
    turns,
  };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const opts = parseArgs(process.argv.slice(2));
  try {
    const file = opts.file ?? findLatestSession(opts.cwd);
    const report = await analyze(file, opts.snippet);
    process.stdout.write(JSON.stringify(report) + '\n');
  } catch (err) {
    process.stderr.write(`analyze-turns: ${err.message}\n`);
    process.exit(1);
  }
}
