// branching.mjs — write a new native session containing only the selected turns.
//
// The engine is agent-independent: it streams the original, copies the line
// ranges `selection.mjs` resolved, and hands every copied record to the
// adapter's rewriter so ids and links come out consistent for that agent. It
// never learns what those ids mean.
//
// Safety rules that hold for every agent:
//   - the original is opened read-only and is never written to;
//   - output goes to `<output>.<pid>.tmp` and is renamed into place, so a crash
//     or a failed check leaves no half-written session behind;
//   - the branch is checked for orphan tool results before the rename, and the
//     temporary file is removed if the check fails.
//
// Zero dependencies — Node built-ins only.

import fs from 'node:fs';
import path from 'node:path';
import { readRecords } from './transcript.mjs';
import { selectRanges } from './selection.mjs';

// Tool calls and their results must travel together. Copying whole turn ranges
// should already guarantee that, so a violation here means either the adapter's
// turn boundaries are wrong or the native format grew a shape we do not know —
// both are reasons to refuse the write rather than emit a broken session.
function checkToolIntegrity(adapter, calls, results) {
  if (!adapter.toolIds) return [];
  const problems = [];
  for (const id of results) {
    if (!calls.has(id)) problems.push(`tool result ${id} has no matching tool call`);
  }
  return problems;
}

/**
 * @param {object}   opts
 * @param {string}   opts.originalPath  native session to branch from (read-only)
 * @param {object}   opts.report        output of `analyzeSession`
 * @param {number[]} opts.ids           turn ids to keep
 * @param {string}   opts.outputPath    where to write the branch
 * @param {object}   opts.adapter       agent adapter
 */
export async function buildBranch({ originalPath, report, ids, outputPath, adapter, now = new Date() }) {
  const original = path.resolve(originalPath);
  const output = path.resolve(outputPath);
  if (original === output) throw new Error('refusing to write over the original session file');

  const ranges = selectRanges(report, ids);
  const newSessionId =
    (adapter.sessionIdFromPath && adapter.sessionIdFromPath(output)) || adapter.newSessionId(now);

  const rewriter = adapter.createRewriter({
    newSessionId,
    originalSessionId: report.session_id,
    now,
  });

  fs.mkdirSync(path.dirname(output), { recursive: true });
  const tmp = `${output}.${process.pid}.tmp`;
  const out = fs.createWriteStream(tmp, { encoding: 'utf8' });

  const toolCalls = new Set();
  const toolResults = new Set();
  let lineNo = 0;
  let ri = 0;
  let keptLines = 0;
  let keptChars = 0;
  let originalChars = 0;
  let humanTurnsSeen = 0;

  // Tear the half-written file down before rethrowing. The stream may still
  // have queued writes, so swallow its teardown error and wait for the close.
  const abort = async (err) => {
    out.on('error', () => {});
    out.destroy();
    await new Promise((resolve) => (out.closed ? resolve() : out.once('close', resolve)));
    fs.rmSync(tmp, { force: true });
    throw err;
  };

  try {
    for await (const rec of readRecords(original)) {
      lineNo = rec.lineNo;
      originalChars += rec.line.length;

      while (ri < ranges.length && lineNo >= ranges[ri].end) ri++;
      const inRange = ri < ranges.length && lineNo >= ranges[ri].start && lineNo < ranges[ri].end;
      if (!inRange) continue;

      let outLine = rec.line;
      if (rec.entry && typeof rec.entry === 'object') {
        const rewritten = rewriter.line(rec.entry, lineNo);
        if (rewritten === null) continue; // adapter dropped the record
        outLine = JSON.stringify(rewritten);

        if (adapter.toolIds) {
          const t = adapter.toolIds(rewritten);
          if (t) {
            for (const id of t.calls ?? []) toolCalls.add(id);
            for (const id of t.results ?? []) toolResults.add(id);
          }
        }
        if (ranges[ri].turn && lineNo === ranges[ri].start) humanTurnsSeen++;
      }

      if (!out.write(outLine + '\n')) {
        await new Promise((resolve) => out.once('drain', resolve));
      }
      keptLines++;
      keptChars += outLine.length;
    }
  } catch (err) {
    await abort(err);
  }

  const problems = checkToolIntegrity(adapter, toolCalls, toolResults);
  if (problems.length) await abort(new Error(`branch would be malformed: ${problems.join('; ')}`));
  if (!humanTurnsSeen) await abort(new Error('branch would contain no human turn'));

  await new Promise((resolve, reject) => {
    out.on('error', reject);
    out.end(resolve);
  });
  fs.renameSync(tmp, output);

  const reduction = originalChars ? (1 - keptChars / originalChars) * 100 : 0;
  const notes = adapter.branchNotes ? adapter.branchNotes({ outputPath: output }) : null;

  return {
    agent: adapter.id,
    new_session_id: newSessionId,
    output_path: output,
    original_path: original,
    original_session_id: report.session_id,
    kept_turns: ids,
    kept_lines: keptLines,
    original_lines: lineNo,
    kept_chars: keptChars,
    original_chars: originalChars,
    reduction_pct: Math.round(reduction * 10) / 10,
    resume_command: adapter.resumeCommand(newSessionId),
    ...(notes ? { note: notes } : {}),
  };
}
