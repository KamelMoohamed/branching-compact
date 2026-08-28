#!/usr/bin/env node
// branching-compact.mjs — one entry point for every agent.
//
//   branching-compact detect  [--cwd DIR] [--agent NAME]
//   branching-compact analyze [session-file] [--latest] [--agent NAME] [--cwd DIR] [--snippet N]
//   branching-compact branch  <session-file> <turns.json|-> <turn-ids> [--agent NAME] [--output PATH]
//
// Agent is resolved in this order: --agent, the environment, the named file's
// own format, then which agent has a session for --cwd. Aliases are accepted
// (`claude-code`, `openai-codex`).
//
// Every subcommand prints one line of JSON to stdout. The session being read is
// opened read-only and never modified.
//
// Zero dependencies — Node built-ins only.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectAgent, agentNames, getAdapter } from './core/agents.mjs';
import { analyzeSession } from './core/transcript.mjs';
import { buildBranch } from './core/branching.mjs';
import { parseTurnIds } from './core/selection.mjs';

const USAGE = `usage:
  branching-compact detect  [--cwd DIR] [--agent NAME]
  branching-compact analyze [session-file] [--latest] [--agent NAME] [--cwd DIR] [--snippet N]
  branching-compact branch  <session-file> <turns.json|-> <turn-ids> [--agent NAME] [--output PATH]

agents: ${agentNames().join(', ')}
`;

function usage(code = 2) {
  process.stderr.write(USAGE);
  process.exit(code);
}

export function parseArgs(argv) {
  const opts = {
    command: null,
    positionals: [],
    agent: null,
    cwd: process.cwd(),
    latest: false,
    snippet: 200,
    output: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--agent') opts.agent = argv[++i] ?? usage();
    else if (a === '--cwd') opts.cwd = argv[++i] ?? usage();
    else if (a === '--output' || a === '-o') opts.output = argv[++i] ?? usage();
    else if (a === '--snippet') opts.snippet = Number(argv[++i]);
    else if (a === '--latest') opts.latest = true;
    else if (a === '-h' || a === '--help') usage(0);
    else if (a.startsWith('-') && a !== '-') usage();
    else if (opts.command === null) opts.command = a;
    else opts.positionals.push(a);
  }
  if (!opts.command) usage();
  if (!Number.isFinite(opts.snippet) || opts.snippet < 1) usage();
  return opts;
}

function readReport(src) {
  const raw = src === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(src, 'utf8');
  const parsed = JSON.parse(raw);
  if (!parsed || !Array.isArray(parsed.turns)) {
    throw new Error('turns.json has no "turns" array — pass the output of `branching-compact analyze`');
  }
  return parsed;
}

// A file the caller named, or the agent's own idea of "the current session".
async function resolveSessionFile(adapter, opts, given) {
  if (given) return path.resolve(given);
  return adapter.findLatestSession({ cwd: opts.cwd, home: os.homedir(), env: process.env });
}

export async function run(argv) {
  const opts = parseArgs(argv);
  const [first, second, third] = opts.positionals;

  if (opts.command === 'detect') {
    const { adapter, reason, evidence } = await detectAgent({
      agent: opts.agent,
      file: first,
      cwd: opts.cwd,
    });
    return {
      agent: adapter.id,
      display_name: adapter.displayName,
      detected_by: reason,
      evidence,
    };
  }

  if (opts.command === 'analyze') {
    const { adapter } = await detectAgent({ agent: opts.agent, file: first, cwd: opts.cwd });
    const file = await resolveSessionFile(adapter, opts, first);
    return analyzeSession(file, adapter, { snippet: opts.snippet });
  }

  if (opts.command === 'branch') {
    if (!first || !second || !third) usage();
    const report = readReport(second);
    // The report records which agent produced it; honour that unless the caller
    // overrode it, so a branch can never be built with the wrong writer.
    const adapter = opts.agent
      ? getAdapter(opts.agent)
      : report.agent
        ? getAdapter(report.agent)
        : (await detectAgent({ file: first, cwd: opts.cwd })).adapter;

    const originalPath = path.resolve(first);
    const now = new Date();
    const newSessionId = adapter.newSessionId(now);
    const outputPath =
      opts.output ??
      adapter.branchPathFor({ originalPath, newSessionId, home: os.homedir(), env: process.env, now });

    return buildBranch({
      originalPath,
      report,
      ids: parseTurnIds(third),
      outputPath,
      adapter,
      now,
    });
  }

  usage();
}

const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  try {
    const result = await run(process.argv.slice(2));
    process.stdout.write(JSON.stringify(result) + '\n');
  } catch (err) {
    process.stderr.write(`branching-compact: ${err.message}\n`);
    process.exit(1);
  }
}
