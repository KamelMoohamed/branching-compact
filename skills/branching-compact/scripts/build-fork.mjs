#!/usr/bin/env node
// build-fork.mjs — write a new session containing only the selected turns.
//
//   node build-fork.mjs <original.jsonl> <turns.json|-> <turn_ids_csv> [output.jsonl] [--agent NAME]
//
// <turns.json> is the output of analyze-turns.mjs (a path, or "-" for stdin).
// <turn_ids_csv> is e.g. "1,3,4" — ids as printed by analyze-turns.mjs.
// Omit the output path and the adapter picks the right native location and name
// for the agent — which is what you want for Codex, whose rollout filenames
// encode a timestamp. Equivalent to `branching-compact branch`.
//
// Agent-independent: the shared writer in core/branching.mjs copies whole turn
// ranges and lets the adapter fix up ids and links. The agent comes from
// --agent, else from the report's `agent` field, else from detection.
//
// Prints a compact JSON report to stdout. The original session is opened
// read-only and is never modified. Zero dependencies — Node built-ins only.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildBranch } from './core/branching.mjs';
import { parseTurnIds } from './core/selection.mjs';
import { detectAgent, getAdapter, agentNames } from './core/agents.mjs';
import claude from './adapters/claude.mjs';

export { buildBranch };
// Kept for callers and tests that predate the adapter split.
export const buildFork = (originalPath, report, ids, outputPath, adapter = claude) =>
  buildBranch({ originalPath, report, ids, outputPath, adapter });

function usage(code = 2) {
  process.stderr.write(
    'usage: build-fork.mjs <original.jsonl> <turns.json|-> <turn_ids_csv> [output.jsonl] [--agent NAME]\n' +
      `agents: ${agentNames().join(', ')}\n`
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

function parseArgs(argv) {
  const opts = { agent: null, positionals: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--agent') opts.agent = argv[++i] ?? usage();
    else if (a === '-h' || a === '--help') usage(0);
    else if (a.startsWith('-') && a !== '-') usage();
    else opts.positionals.push(a);
  }
  if (opts.positionals.length < 3 || opts.positionals.length > 4) usage();
  return opts;
}

const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const opts = parseArgs(process.argv.slice(2));
  const [originalPath, turnsSrc, idsCsv, outputPath] = opts.positionals;
  try {
    const report = readTurnsJson(turnsSrc);
    const adapter = opts.agent
      ? getAdapter(opts.agent)
      : report.agent
        ? getAdapter(report.agent)
        : (await detectAgent({ file: originalPath })).adapter;

    const now = new Date();
    const resolved =
      outputPath ??
      adapter.branchPathFor({
        originalPath: path.resolve(originalPath),
        newSessionId: adapter.newSessionId(now),
        home: os.homedir(),
        env: process.env,
        now,
      });

    const result = await buildBranch({
      originalPath,
      report,
      ids: parseTurnIds(idsCsv),
      outputPath: resolved,
      adapter,
      now,
    });
    process.stdout.write(JSON.stringify(result) + '\n');
  } catch (err) {
    process.stderr.write(`build-fork: ${err.message}\n`);
    process.exit(1);
  }
}
