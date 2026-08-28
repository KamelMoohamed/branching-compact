#!/usr/bin/env node
// analyze-turns.mjs — parse a coding-agent session into compact turn summaries.
//
//   node analyze-turns.mjs <session.jsonl> [--agent NAME] [--snippet N]
//   node analyze-turns.mjs --latest [--agent NAME] [--cwd DIR] [--snippet N]
//
// Agent-independent: the shared analysis in core/transcript.mjs runs against
// whichever adapter matches, so this works on a Claude Code transcript and on a
// Codex rollout alike. Without --agent the agent is detected (see
// core/agents.mjs). Equivalent to `branching-compact analyze`.
//
// Prints compact JSON to stdout. Read-only: never opens the session for writing.
// Zero dependencies — Node built-ins only.

import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzeSession } from './core/transcript.mjs';
import { detectAgent, agentNames } from './core/agents.mjs';
import claude from './adapters/claude.mjs';

// Re-exported for callers and tests that predate the adapter split.
export { analyzeSession };
export const analyze = (file, snippetLen = 200, adapter = claude) =>
  analyzeSession(file, adapter, { snippet: snippetLen });
export { isTurnStart, userText, encodeProjectPath } from './adapters/claude.mjs';
export const findLatestSession = (cwd, home = os.homedir()) => claude.findLatestSession({ cwd, home });

function usage(code = 2) {
  process.stderr.write(
    'usage: analyze-turns.mjs <session.jsonl> [--agent NAME] [--snippet N]\n' +
      '       analyze-turns.mjs --latest [--agent NAME] [--cwd DIR] [--snippet N]\n' +
      `agents: ${agentNames().join(', ')}\n`
  );
  process.exit(code);
}

function parseArgs(argv) {
  const opts = { file: null, latest: false, cwd: process.cwd(), snippet: 200, agent: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--latest') opts.latest = true;
    else if (a === '--cwd') opts.cwd = argv[++i] ?? usage();
    else if (a === '--agent') opts.agent = argv[++i] ?? usage();
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

const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const opts = parseArgs(process.argv.slice(2));
  try {
    const { adapter } = await detectAgent({ agent: opts.agent, file: opts.file, cwd: opts.cwd });
    const file =
      opts.file ?? (await adapter.findLatestSession({ cwd: opts.cwd, home: os.homedir(), env: process.env }));
    const report = await analyzeSession(file, adapter, { snippet: opts.snippet });
    process.stdout.write(JSON.stringify(report) + '\n');
  } catch (err) {
    process.stderr.write(`analyze-turns: ${err.message}\n`);
    process.exit(1);
  }
}
