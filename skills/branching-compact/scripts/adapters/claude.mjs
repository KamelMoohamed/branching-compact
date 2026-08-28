// claude.mjs — the Claude Code adapter.
//
// Everything Claude-specific lives here: where transcripts are stored, what a
// genuine human message looks like in Claude's line shapes, and the `sessionId`
// / `parentUuid` bookkeeping a resumable fork needs. The branching engine sees
// none of it.
//
// See references/claude-transcript-format.md. The format is observed, not
// documented, and Claude Code can change it in any release.
//
// Zero dependencies — Node built-ins only.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const SYNTHETIC_USER_TEXT = [
  '[Request interrupted by user]',
  '[Request interrupted by user for tool use]',
  '(no content)',
];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Claude Code encodes a project path into a directory name by replacing every
// character outside [A-Za-z0-9] with a dash.
export function encodeProjectPath(p) {
  return p.replace(/[^A-Za-z0-9]/g, '-');
}

export function projectRoot(cwd, home = os.homedir()) {
  return path.join(home, '.claude', 'projects', encodeProjectPath(path.resolve(cwd)));
}

// Transcripts live either at <projects>/<encoded>/<id>.jsonl or, on some
// versions, <projects>/<encoded>/sessions/<id>.jsonl. Check both.
export function findLatestSession({ cwd = process.cwd(), home = os.homedir() } = {}) {
  const root = projectRoot(cwd, home);
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
    throw new Error(`no Claude Code transcript found for project ${cwd} (looked under ${root})`);
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

// Recognise a Claude transcript from its first record, so `--agent claude`
// against a Codex rollout fails with an explanation instead of silently
// producing an empty analysis.
export function looksLikeClaude(entry) {
  if (!entry || typeof entry !== 'object') return false;
  if (typeof entry.sessionId === 'string') return true;
  if (typeof entry.uuid === 'string' && 'parentUuid' in entry) return true;
  return ['user', 'assistant', 'summary'].includes(entry.type) && !!entry.message;
}

const adapter = {
  id: 'claude',
  displayName: 'Claude Code',
  aliases: ['claude-code', 'claudecode', 'cc'],
  homeEnv: 'CLAUDE_CONFIG_DIR',

  // --- detection ------------------------------------------------------------

  detectFromEnv(env = process.env) {
    if (env.CLAUDE_CODE_ENTRYPOINT) return `CLAUDE_CODE_ENTRYPOINT=${env.CLAUDE_CODE_ENTRYPOINT}`;
    if (env.CLAUDECODE) return `CLAUDECODE=${env.CLAUDECODE}`;
    if (env.CLAUDE_CODE_SSE_PORT) return 'CLAUDE_CODE_SSE_PORT is set';
    return null;
  },

  detectFromHeader: looksLikeClaude,

  hasSessionsFor({ cwd = process.cwd(), home = os.homedir() } = {}) {
    try {
      return !!findLatestSession({ cwd, home });
    } catch {
      return false;
    }
  },

  // --- discovery ------------------------------------------------------------

  findLatestSession,

  sessionIdFor(file) {
    return path.basename(file, '.jsonl');
  },

  // --- normalization --------------------------------------------------------

  // Claude's line shapes are self-describing, so no pre-pass is needed.
  prepare: null,

  classify(entry) {
    if (!isTurnStart(entry)) return null;
    return { turnStart: true, text: userText(entry.message) };
  },

  validateHeader(entry, file) {
    if (!looksLikeClaude(entry)) {
      throw new Error(
        `${file} does not look like a Claude Code transcript (first record has no sessionId/uuid). ` +
          'Pass --agent explicitly if you know better.'
      );
    }
  },

  toolIds(entry) {
    const content = entry?.message?.content;
    if (!Array.isArray(content)) return null;
    const calls = [];
    const results = [];
    for (const b of content) {
      if (b?.type === 'tool_use' && b.id) calls.push(b.id);
      if (b?.type === 'tool_result' && b.tool_use_id) results.push(b.tool_use_id);
    }
    return { calls, results };
  },

  // --- branch writing -------------------------------------------------------

  newSessionId() {
    return randomUUID();
  },

  // A Claude fork is named by its session id, so the id comes from the output
  // filename when the caller already chose one.
  sessionIdFromPath(output) {
    const base = path.basename(output, '.jsonl');
    return UUID_RE.test(base) ? base : null;
  },

  branchPathFor({ originalPath, newSessionId }) {
    return path.join(path.dirname(path.resolve(originalPath)), `${newSessionId}.jsonl`);
  },

  createRewriter({ newSessionId }) {
    const keptUuids = new Set();
    let lastKeptUuid = null;
    return {
      line(entry) {
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
        return entry;
      },
    };
  },

  resumeCommand(id) {
    return `claude --resume ${id}`;
  },
};

export default adapter;
