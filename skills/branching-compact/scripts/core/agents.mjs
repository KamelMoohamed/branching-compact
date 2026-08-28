// agents.mjs — the adapter registry and agent detection.
//
// Two agents, one small contract. This is deliberately not a plugin framework:
// adding a third agent means writing one more file in ../adapters and adding it
// to ADAPTERS below.
//
// Detection order, most trustworthy first:
//   1. an explicit --agent
//   2. the named session file's own format
//   3. the process environment — the agent that is running us says so
//   4. which agent has a session on disk for this directory
//
// The file outranks the environment on purpose. The environment says which
// agent is *running* us, which is not the same question as which agent wrote
// the file we were handed — branching a Codex session from inside Claude Code
// is a perfectly ordinary thing to do.
//
// Anything still ambiguous is an error with both candidates named, never a
// coin flip: guessing wrong here means writing one agent's format into the
// other's session store.
//
// Zero dependencies — Node built-ins only.

import os from 'node:os';
import claude from '../adapters/claude.mjs';
import codex from '../adapters/codex.mjs';
import { readRecords } from './transcript.mjs';

export const ADAPTERS = [claude, codex];

export function agentNames() {
  return ADAPTERS.map((a) => a.id);
}

export function getAdapter(name) {
  const key = String(name).trim().toLowerCase();
  const found = ADAPTERS.find((a) => a.id === key || a.aliases.includes(key));
  if (!found) {
    throw new Error(`unknown agent "${name}" — known agents: ${agentNames().join(', ')}`);
  }
  return found;
}

async function firstRecord(file) {
  for await (const rec of readRecords(file)) return rec.entry;
  return null;
}

/**
 * @param {object} [opts]
 * @param {string} [opts.agent]  explicit --agent value
 * @param {string} [opts.file]   an explicit session file, if the caller named one
 * @param {string} [opts.cwd]    project directory to look for sessions in
 * @returns {Promise<{adapter: object, reason: string, evidence: string}>}
 */
export async function detectAgent({ agent, file, cwd = process.cwd(), env = process.env, home = os.homedir() } = {}) {
  if (agent) {
    return { adapter: getAdapter(agent), reason: 'explicit', evidence: `--agent ${agent}` };
  }

  if (file) {
    const head = await firstRecord(file);
    const matches = ADAPTERS.filter((a) => a.detectFromHeader(head));
    if (matches.length === 1) {
      return { adapter: matches[0], reason: 'file-format', evidence: `first record of ${file}` };
    }
    throw new Error(
      `cannot tell which agent wrote ${file} — its first record matches ` +
        `${matches.length === 0 ? 'no known format' : matches.map((m) => m.id).join(' and ')}. ` +
        `Pass --agent (${agentNames().join('|')}).`
    );
  }

  const fromEnv = ADAPTERS.map((a) => ({ a, ev: a.detectFromEnv(env) })).filter((x) => x.ev);
  if (fromEnv.length === 1) {
    return { adapter: fromEnv[0].a, reason: 'environment', evidence: fromEnv[0].ev };
  }
  if (fromEnv.length > 1) {
    throw new Error(
      `the environment names more than one agent (${fromEnv
        .map((x) => `${x.a.id}: ${x.ev}`)
        .join('; ')}). Pass --agent (${agentNames().join('|')}).`
    );
  }

  const onDisk = [];
  for (const a of ADAPTERS) {
    if (await a.hasSessionsFor({ cwd, home, env })) onDisk.push(a);
  }
  if (onDisk.length === 1) {
    return { adapter: onDisk[0], reason: 'sessions-on-disk', evidence: `${onDisk[0].id} has a session for ${cwd}` };
  }
  if (onDisk.length > 1) {
    throw new Error(
      `both ${onDisk.map((a) => a.id).join(' and ')} have sessions for ${cwd}. ` +
        `Pass --agent (${agentNames().join('|')}).`
    );
  }
  throw new Error(
    `no agent detected: no session found for ${cwd} under any known agent. ` +
      `Pass --agent (${agentNames().join('|')}) and a session file path.`
  );
}
