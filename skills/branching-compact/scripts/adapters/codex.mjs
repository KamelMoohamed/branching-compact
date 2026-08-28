// codex.mjs — the OpenAI Codex adapter.
//
// Everything Codex-specific lives here: the rollout layout under ~/.codex, the
// `session_meta` / `turn_context` / `response_item` / `event_msg` record kinds,
// and the turn bookkeeping a resumable branch needs. The branching engine sees
// none of it.
//
// See references/codex-transcript-format.md. The format is observed from real
// rollouts written by codex-cli 0.148–0.149 and is not a documented API.
//
// Zero dependencies — Node built-ins only.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { readRecords } from '../core/transcript.mjs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ROLLOUT_RE = /^rollout-.*?-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

// Context Codex injects as a user-role record. These are not the human
// speaking, and unlike the real prompt they are never echoed as a
// `user_message` / `item_completed(UserMessage)` event.
const INJECTED_WRAPPERS = [
  'environment_context',
  'recommended_plugins',
  'app-context',
  'user_instructions',
  'skills_instructions',
  'multi_agent_mode',
  'collaboration_mode',
];

export function codexHome(env = process.env, home = os.homedir()) {
  return env.CODEX_HOME ? path.resolve(env.CODEX_HOME) : path.join(home, '.codex');
}

export function sessionsRoot(env = process.env, home = os.homedir()) {
  return path.join(codexHome(env, home), 'sessions');
}

// Codex ids are UUIDv7 — time-ordered, and what every native rollout carries.
// Minting the same shape keeps the branch indistinguishable from a session
// Codex wrote itself, including for anything that sorts ids by their timestamp.
export function uuidv7(now = new Date()) {
  const b = randomBytes(16);
  const ms = BigInt(now.getTime());
  for (let i = 0; i < 6; i++) b[i] = Number((ms >> BigInt(40 - 8 * i)) & 0xffn);
  b[6] = 0x70 | (b[6] & 0x0f);
  b[8] = 0x80 | (b[8] & 0x3f);
  const hex = b.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// Local time, matching how Codex itself names rollout files and buckets them
// into sessions/YYYY/MM/DD.
function localStamp(d) {
  const p = (n) => String(n).padStart(2, '0');
  return {
    date: [String(d.getFullYear()), p(d.getMonth() + 1), p(d.getDate())],
    time: `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`,
  };
}

export async function readFirstRecord(file) {
  for await (const rec of readRecords(file)) return rec.entry;
  return null;
}

export function listRollouts(env = process.env, home = os.homedir()) {
  const root = sessionsRoot(env, home);
  const out = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile() && ROLLOUT_RE.test(e.name)) {
        try {
          out.push({ file: full, mtimeMs: fs.statSync(full).mtimeMs });
        } catch {
          /* vanished mid-scan */
        }
      }
    }
  };
  walk(root);
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

export function looksLikeCodex(entry) {
  return !!(
    entry &&
    typeof entry === 'object' &&
    entry.type === 'session_meta' &&
    entry.payload &&
    typeof entry.payload === 'object' &&
    typeof (entry.payload.session_id ?? entry.payload.id) === 'string'
  );
}

/**
 * Resolve the most recent rollout for `cwd`. Rollouts do not encode the project
 * path in their location the way Claude transcripts do — the working directory
 * is a field inside `session_meta` — so this reads the first record of each
 * candidate, newest first, and stops at the first match.
 */
export async function findLatestSession({ cwd = process.cwd(), home = os.homedir(), env = process.env, anyCwd = false } = {}) {
  const target = path.resolve(cwd);
  const candidates = listRollouts(env, home);
  if (!candidates.length) {
    throw new Error(`no Codex rollout files found under ${sessionsRoot(env, home)}`);
  }
  for (const c of candidates) {
    if (anyCwd) return c.file;
    let head;
    try {
      head = await readFirstRecord(c.file);
    } catch {
      continue;
    }
    if (!looksLikeCodex(head)) continue;
    const sessionCwd = head.payload.cwd;
    if (typeof sessionCwd === 'string' && path.resolve(sessionCwd) === target) return c.file;
  }
  throw new Error(
    `no Codex rollout found for ${target} (scanned ${candidates.length} rollouts under ` +
      `${sessionsRoot(env, home)}). Pass an explicit rollout path, or --cwd for another project.`
  );
}

// --- turn detection ---------------------------------------------------------

function turnIdOf(entry) {
  const p = entry?.payload;
  if (!p || typeof p !== 'object') return null;
  return p.turn_id ?? p.internal_chat_message_metadata_passthrough?.turn_id ?? null;
}

export function textOfContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b) => b && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n');
}

function isUserResponseItem(entry) {
  const p = entry?.payload;
  return entry?.type === 'response_item' && p?.type === 'message' && p.role === 'user';
}

// The event Codex emits once it has accepted a human message. Two spellings
// exist in the wild: `user_message` (0.148 and earlier) and the newer
// `item_completed` carrying a `UserMessage` item (0.149+).
function genuineUserEventText(entry) {
  const p = entry?.payload;
  if (entry?.type !== 'event_msg' || !p) return null;
  if (p.type === 'user_message' && typeof p.message === 'string') return p.message;
  if (p.type === 'item_completed' && p.item && p.item.type === 'UserMessage') {
    return textOfContent(p.item.content);
  }
  return null;
}

export function looksInjected(text) {
  const t = String(text ?? '').trim();
  const m = /^<([a-z][a-z0-9_-]*)>/i.exec(t);
  if (!m) return false;
  if (INJECTED_WRAPPERS.includes(m[1])) return true;
  // Generic case: the whole message is one XML-ish wrapper Codex built.
  return t.endsWith(`</${m[1]}>`);
}

const norm = (s) => String(s ?? '').trim();

/**
 * One streaming pre-pass over the rollout that decides where each human turn
 * begins.
 *
 * Codex writes the prompt as a `response_item` *before* the event that confirms
 * it was a human message, and injects context under the same `role: "user"`,
 * so a single forward pass cannot tell them apart. The pre-pass reads the
 * confirmation events, matches them to the user records in order, and then
 * walks each match back to the first record of its turn — the `task_started`
 * that carries the turn's `turn_context` and any per-turn injected context —
 * so those travel with the turn they configure.
 *
 * Memory stays O(number of turns): only line numbers, turn ids and the head of
 * each user record are retained, never the transcript.
 */
export async function prepare(file) {
  const firstLineOfTurn = new Map();
  const userItems = [];
  const genuine = [];
  let sawUserEvent = false;

  for await (const rec of readRecords(file)) {
    const entry = rec.entry;
    if (!entry) continue;

    const tid = turnIdOf(entry);
    if (tid && !firstLineOfTurn.has(tid)) firstLineOfTurn.set(tid, rec.lineNo);

    const eventText = genuineUserEventText(entry);
    if (eventText !== null) {
      sawUserEvent = true;
      genuine.push(norm(eventText));
      continue;
    }

    if (isUserResponseItem(entry)) {
      const text = textOfContent(entry.payload.content);
      userItems.push({ lineNo: rec.lineNo, turnId: tid, text: norm(text) });
    }
  }

  // Match confirmation events to user records in order. Identical prompts sent
  // twice stay distinguishable because both lists are in file order.
  const matched = [];
  if (sawUserEvent) {
    let ui = 0;
    for (const g of genuine) {
      while (ui < userItems.length && userItems[ui].text !== g) ui++;
      if (ui >= userItems.length) break;
      matched.push(userItems[ui]);
      ui++;
    }
  }
  // Rollouts with no confirmation events at all (an older or trimmed file) fall
  // back to shape: a user record that is not one of Codex's injected wrappers.
  const fallbackUsed = !matched.length && userItems.length > 0;
  if (fallbackUsed) {
    for (const u of userItems) if (!looksInjected(u.text)) matched.push(u);
  }

  const starts = new Map();
  matched.forEach((u, i) => {
    // The first human turn starts at the prompt itself, so the session header,
    // base instructions and standing developer context stay in the preamble and
    // are carried into every branch. Later turns start at the top of their own
    // block, so each one brings its own turn_context and injected records.
    const line = i === 0 ? u.lineNo : firstLineOfTurn.get(u.turnId) ?? u.lineNo;
    if (!starts.has(line)) starts.set(line, u.text);
  });

  return { starts, matchedCount: matched.length, usedFallback: fallbackUsed };
}

// --- adapter ----------------------------------------------------------------

const adapter = {
  id: 'codex',
  displayName: 'OpenAI Codex',
  aliases: ['openai-codex', 'codex-cli'],

  // --- detection ------------------------------------------------------------

  detectFromEnv(env = process.env) {
    if (env.CODEX_THREAD_ID) return `CODEX_THREAD_ID=${env.CODEX_THREAD_ID}`;
    if (env.CODEX_SESSION_ID) return `CODEX_SESSION_ID=${env.CODEX_SESSION_ID}`;
    if (env.CODEX_SANDBOX) return `CODEX_SANDBOX=${env.CODEX_SANDBOX}`;
    return null;
  },

  detectFromHeader: looksLikeCodex,

  hasSessionsFor({ cwd = process.cwd(), home = os.homedir(), env = process.env } = {}) {
    return findLatestSession({ cwd, home, env }).then(
      () => true,
      () => false
    );
  },

  // --- discovery ------------------------------------------------------------

  findLatestSession,

  sessionIdFor(file, header) {
    if (looksLikeCodex(header)) return header.payload.session_id ?? header.payload.id;
    const m = ROLLOUT_RE.exec(path.basename(file));
    return m ? m[1] : path.basename(file, '.jsonl');
  },

  // --- normalization --------------------------------------------------------

  prepare,

  classify(entry, lineNo, state) {
    if (!state || !state.starts.has(lineNo)) return null;
    return { turnStart: true, text: state.starts.get(lineNo) };
  },

  validateHeader(entry, file) {
    if (!looksLikeCodex(entry)) {
      throw new Error(
        `${file} does not look like a Codex rollout (first record is not a session_meta). ` +
          'Pass --agent explicitly if you know better.'
      );
    }
  },

  toolIds(entry) {
    const p = entry?.payload;
    if (entry?.type !== 'response_item' || !p) return null;
    const calls = [];
    const results = [];
    if ((p.type === 'custom_tool_call' || p.type === 'function_call') && p.call_id) calls.push(p.call_id);
    if ((p.type === 'custom_tool_call_output' || p.type === 'function_call_output') && p.call_id) {
      results.push(p.call_id);
    }
    return { calls, results };
  },

  // --- branch writing -------------------------------------------------------

  newSessionId(now = new Date()) {
    return uuidv7(now);
  },

  sessionIdFromPath(output) {
    const m = ROLLOUT_RE.exec(path.basename(output));
    if (m) return m[1];
    const base = path.basename(output, '.jsonl');
    return UUID_RE.test(base) ? base : null;
  },

  // Branches go where Codex looks for sessions: sessions/YYYY/MM/DD, named
  // rollout-<local timestamp>-<id>.jsonl, both in local time — which is how
  // Codex names its own.
  branchPathFor({ newSessionId, home = os.homedir(), env = process.env, now = new Date() }) {
    const { date, time } = localStamp(now);
    return path.join(sessionsRoot(env, home), ...date, `rollout-${time}-${newSessionId}.jsonl`);
  },

  // A rollout names its thread in exactly three places: `session_id` and `id`
  // on the header, and `thread_id` on the item events. Everything else that
  // mentions the old id — a workspace root under ~/.codex/visualizations, a
  // path inside a tool result — refers to a directory that belongs to the
  // original session, and is left alone rather than pointed somewhere that
  // does not exist.
  createRewriter({ newSessionId, originalSessionId, now = new Date() }) {
    let ordinal = 0;
    return {
      line(entry) {
        if (entry.type === 'session_meta' && entry.payload && typeof entry.payload === 'object') {
          entry.payload.session_id = newSessionId;
          entry.payload.id = newSessionId;
          entry.payload.timestamp = now.toISOString();
          entry.timestamp = now.toISOString();
        } else if (
          entry.payload &&
          typeof entry.payload === 'object' &&
          typeof entry.payload.thread_id === 'string' &&
          (!originalSessionId || entry.payload.thread_id === originalSessionId)
        ) {
          entry.payload.thread_id = newSessionId;
        }
        // Newer rollouts number every record. Codex's history projection tracks
        // that counter alongside a byte offset, so a branch that dropped
        // records has to renumber rather than inherit gaps.
        if (Object.prototype.hasOwnProperty.call(entry, 'ordinal')) entry.ordinal = ordinal;
        ordinal++;
        return entry;
      },
    };
  },

  // Codex finds sessions by scanning its sessions root, so a branch written
  // anywhere else is a valid rollout that `codex resume` will never see. Say so
  // rather than letting the caller discover it later.
  branchNotes({ outputPath, home = os.homedir(), env = process.env }) {
    const root = sessionsRoot(env, home);
    if (path.resolve(outputPath).startsWith(root + path.sep)) return null;
    return (
      `this branch is outside ${root}, so \`codex resume\` will not find it. ` +
      'Move it into a sessions/YYYY/MM/DD directory, or re-run without --output.'
    );
  },

  resumeCommand(id) {
    return `codex resume ${id}`;
  },
};

export default adapter;
