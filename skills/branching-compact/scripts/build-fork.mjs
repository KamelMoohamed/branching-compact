#!/usr/bin/env node
// build-fork.mjs — write a new Claude Code session containing only the selected turns.
//
//   node build-fork.mjs <original.jsonl> <turns.json> <turn_ids_csv> <output.jsonl>
//
// <turns.json> is the output of analyze-turns.mjs (a path, or "-" for stdin).
// <turn_ids_csv> is e.g. "1,3,4" — ids as printed by analyze-turns.mjs.
//
// Prints a compact JSON report to stdout. The original transcript is opened
// read-only and is never modified. Zero dependencies — Node built-ins only.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline';
import { randomUUID } from 'node:crypto';

function usage(code = 2) {
  process.stderr.write(
    'usage: build-fork.mjs <original.jsonl> <turns.json|-> <turn_ids_csv> <output.jsonl>\n'
  );
  process.exit(code);
}

function readTurnsJson(src) {
  const raw = src === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(src, 'utf8');
  const parsed = JSON.parse(raw);
  if (!parsed || !Array.isArray(parsed.turns)) {
    throw new Error('turns.json has no "turns" array — pass the output of analyze-turns.mjs');
  }
  return parsed;
}

function parseIds(csv) {
  const ids = csv
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const n = Number(s);
      if (!Number.isInteger(n)) throw new Error(`turn id "${s}" is not an integer`);
      return n;
    });
  if (!ids.length) throw new Error('no turn ids given');
  return [...new Set(ids)].sort((a, b) => a - b);
}

// Half-open [start, end) ranges, kept in original order and never subdivided —
// a turn's whole line range travels together, so a tool_use can never be
// separated from its tool_result.
function selectRanges(report, ids) {
  const byId = new Map(report.turns.map((t) => [t.turn_id, t]));
  const ranges = [];
  for (const id of ids) {
    const turn = byId.get(id);
    if (!turn) throw new Error(`turn id ${id} not present in turns.json`);
    ranges.push({ start: turn.start_line, end: turn.end_line, turn });
  }
  const preamble = report.preamble ?? { start_line: 1, end_line: 1 };
  if (preamble.end_line > preamble.start_line) {
    ranges.unshift({ start: preamble.start_line, end: preamble.end_line, turn: null });
  }
  return ranges.sort((a, b) => a.start - b.start);
}

export async function buildFork(originalPath, report, ids, outputPath) {
  const original = path.resolve(originalPath);
  const output = path.resolve(outputPath);
  if (original === output) throw new Error('refusing to write over the original transcript');

  const ranges = selectRanges(report, ids);
  const newSessionId = /^[0-9a-f-]{36}$/i.test(path.basename(output, '.jsonl'))
    ? path.basename(output, '.jsonl')
    : randomUUID();

  fs.mkdirSync(path.dirname(output), { recursive: true });
  const tmp = `${output}.${process.pid}.tmp`;
  const out = fs.createWriteStream(tmp, { encoding: 'utf8' });

  const rl = readline.createInterface({
    input: fs.createReadStream(original, { encoding: 'utf8', flags: 'r' }),
    crlfDelay: Infinity,
  });

  const keptUuids = new Set();
  let lastKeptUuid = null;
  let lineNo = 0;
  let ri = 0;
  let keptLines = 0;
  let keptChars = 0;
  let originalChars = 0;

  try {
    for await (const line of rl) {
      lineNo++;
      originalChars += line.length;

      while (ri < ranges.length && lineNo >= ranges[ri].end) ri++;
      const inRange = ri < ranges.length && lineNo >= ranges[ri].start && lineNo < ranges[ri].end;
      if (!inRange) continue;

      let entry = null;
      if (line.trim()) {
        try {
          entry = JSON.parse(line);
        } catch {
          entry = null;
        }
      }

      let outLine = line;
      if (entry && typeof entry === 'object') {
        if (entry.sessionId) entry.sessionId = newSessionId;
        // Dropped turns leave holes in the parentUuid chain; re-anchor the
        // first line after each hole so the fork stays one walkable thread.
        if (Object.prototype.hasOwnProperty.call(entry, 'parentUuid')) {
          if (entry.parentUuid !== null && !keptUuids.has(entry.parentUuid)) {
            entry.parentUuid = lastKeptUuid;
          }
        }
        if (entry.uuid) {
          keptUuids.add(entry.uuid);
          lastKeptUuid = entry.uuid;
        }
        outLine = JSON.stringify(entry);
      }

      if (!out.write(outLine + '\n')) {
        await new Promise((resolve) => out.once('drain', resolve));
      }
      keptLines++;
      keptChars += outLine.length;
    }
  } catch (err) {
    out.destroy();
    fs.rmSync(tmp, { force: true });
    throw err;
  }

  await new Promise((resolve, reject) => {
    out.on('error', reject);
    out.end(resolve);
  });
  fs.renameSync(tmp, output);

  const originalLines = lineNo;
  const reduction = originalChars ? (1 - keptChars / originalChars) * 100 : 0;

  return {
    new_session_id: newSessionId,
    output_path: output,
    original_path: original,
    kept_turns: ids,
    kept_lines: keptLines,
    original_lines: originalLines,
    kept_chars: keptChars,
    original_chars: originalChars,
    reduction_pct: Math.round(reduction * 10) / 10,
    resume_command: `claude --resume ${newSessionId}`,
  };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const [originalPath, turnsSrc, idsCsv, outputPath, ...rest] = process.argv.slice(2);
  if (!originalPath || !turnsSrc || !idsCsv || !outputPath || rest.length) usage();
  try {
    const report = readTurnsJson(turnsSrc);
    const result = await buildFork(originalPath, report, parseIds(idsCsv), outputPath);
    process.stdout.write(JSON.stringify(result) + '\n');
  } catch (err) {
    process.stderr.write(`build-fork: ${err.message}\n`);
    process.exit(1);
  }
}
