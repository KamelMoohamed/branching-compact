// selection.mjs — turning a set of chosen turn ids into line ranges to copy.
//
// Clustering itself is not done here. Grouping turn snippets into topics is a
// judgement call about meaning, so the model does it from the snippets that
// `analyzeSession` prints; this module only takes the ids that came back and
// resolves them to the ranges the branch writer copies.
//
// Zero dependencies — Node built-ins only.

export function parseTurnIds(csv) {
  const ids = String(csv)
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

/**
 * Half-open `[start, end)` ranges, in original file order and never subdivided.
 * A turn's whole line range travels together, which is what keeps a tool call
 * and its result — and every record that depends on them — inside one unit.
 * The preamble is always included: it carries the session header and whatever
 * standing instructions the agent injected before the first human message.
 */
export function selectRanges(report, ids) {
  const byId = new Map(report.turns.map((t) => [t.turn_id, t]));
  const ranges = [];
  for (const id of ids) {
    const turn = byId.get(id);
    if (!turn) throw new Error(`turn id ${id} not present in the analysis report`);
    ranges.push({ start: turn.start_line, end: turn.end_line, turn });
  }
  const preamble = report.preamble ?? { start_line: 1, end_line: 1 };
  if (preamble.end_line > preamble.start_line) {
    ranges.unshift({ start: preamble.start_line, end: preamble.end_line, turn: null });
  }
  return ranges.sort((a, b) => a.start - b.start);
}
