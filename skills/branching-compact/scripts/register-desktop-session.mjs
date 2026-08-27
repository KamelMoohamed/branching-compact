#!/usr/bin/env node
// register-desktop-session.mjs — make a forked transcript visible as a chat in
// the Claude Code desktop app.
//
//   node register-desktop-session.mjs <fork-session-id> --title "..." [--template <local_id>] [--cwd DIR]
//
// The desktop app does not build its session list from ~/.claude/projects/. It
// keeps its own registry — one JSON per chat — and each entry points at a
// transcript through its `cliSessionId`. A forked .jsonl that no entry points at
// is resumable from a terminal but invisible in the app. This adds that entry.
//
// Detection and location both come from the environment the desktop app sets:
// CLAUDE_CODE_ENTRYPOINT identifies the host, and CLAUDE_CODE_HOST_SESSION_ID
// names the current chat's own registry file, which is used as the template — so
// the fork inherits the parent chat's cwd, model, permissions and MCP config.
//
// Exits 3 with {"registered": false, "reason": "..."} when this is not a desktop
// session, so a caller can fall back to `claude --resume`. Never modifies an
// existing registry entry. Zero dependencies — Node built-ins only.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

// Config the forked chat should inherit from the chat it was forked out of.
// Anything not listed here is set fresh, so no per-turn conversation state or
// accumulated permission grants leak into the new entry.
const INHERITED = [
  'cwd',
  'originCwd',
  'model',
  'effort',
  'permissionMode',
  'chromePermissionMode',
  'remoteMcpServersConfig',
  'enabledMcpTools',
  'classifierSummaryEnabled',
  'reportFindingsCard',
];

function usage(code = 2) {
  process.stderr.write(
    'usage: register-desktop-session.mjs <fork-session-id> --title "..." [--template <local_id>] [--cwd DIR]\n'
  );
  process.exit(code);
}

function bail(reason, detail) {
  process.stdout.write(JSON.stringify({ registered: false, reason, detail }) + '\n');
  process.exit(3);
}

// The desktop app's state directory, per platform.
export function appSupportDirs(home = os.homedir(), platform = process.platform) {
  if (platform === 'darwin') return [path.join(home, 'Library', 'Application Support', 'Claude')];
  if (platform === 'win32') {
    const appdata = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
    return [path.join(appdata, 'Claude')];
  }
  return [path.join(home, '.config', 'Claude'), path.join(home, '.claude-desktop')];
}

// Registry entries live at <appSupport>/claude-code-sessions/<device>/<account>/<id>.json.
// Locate the template's file rather than guessing those two directory ids.
export function findTemplateEntry(templateId, home = os.homedir(), platform = process.platform) {
  for (const base of appSupportDirs(home, platform)) {
    const root = path.join(base, 'claude-code-sessions');
    let devices;
    try {
      devices = fs.readdirSync(root);
    } catch {
      continue;
    }
    for (const device of devices) {
      let accounts;
      try {
        accounts = fs.readdirSync(path.join(root, device));
      } catch {
        continue;
      }
      for (const account of accounts) {
        const file = path.join(root, device, account, `${templateId}.json`);
        if (fs.existsSync(file)) return file;
      }
    }
  }
  return null;
}

export function buildEntry(template, { cliSessionId, title, cwd, now = Date.now() }) {
  const sessionId = `local_${randomUUID()}`;
  const entry = { sessionId, cliSessionId };
  for (const key of INHERITED) {
    if (template[key] !== undefined) entry[key] = template[key];
  }
  if (cwd) {
    entry.cwd = cwd;
    entry.originCwd = cwd;
  }
  entry.createdAt = now;
  entry.lastActivityAt = now;
  entry.lastFocusedAt = now;
  entry.isArchived = false;
  entry.title = title;
  entry.titleSource = 'custom';
  entry.completedTurns = 0;
  entry.alwaysAllowedReasons = [];
  entry.sessionPermissionUpdates = [];
  entry.spawnSeed = {};
  return entry;
}

function parseArgs(argv) {
  const opts = { forkId: null, title: null, template: null, cwd: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--title') opts.title = argv[++i] ?? usage();
    else if (a === '--template') opts.template = argv[++i] ?? usage();
    else if (a === '--cwd') opts.cwd = argv[++i] ?? usage();
    else if (a === '-h' || a === '--help') usage(0);
    else if (a.startsWith('-')) usage();
    else if (opts.forkId === null) opts.forkId = a;
    else usage();
  }
  if (!opts.forkId) usage();
  return opts;
}

const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const opts = parseArgs(process.argv.slice(2));

  const entrypoint = process.env.CLAUDE_CODE_ENTRYPOINT ?? '';
  const templateId = opts.template ?? process.env.CLAUDE_CODE_HOST_SESSION_ID ?? '';

  if (!opts.template && !entrypoint.includes('desktop')) {
    bail('not-desktop', `CLAUDE_CODE_ENTRYPOINT=${entrypoint || '(unset)'}`);
  }
  if (!templateId) bail('no-host-session', 'CLAUDE_CODE_HOST_SESSION_ID is unset');

  const templateFile = findTemplateEntry(templateId);
  if (!templateFile) bail('registry-not-found', `no registry entry for ${templateId}`);

  try {
    const template = JSON.parse(fs.readFileSync(templateFile, 'utf8'));
    const entry = buildEntry(template, {
      cliSessionId: opts.forkId,
      title: opts.title ?? `Fork of ${template.title ?? 'session'}`,
      cwd: opts.cwd,
    });

    const target = path.join(path.dirname(templateFile), `${entry.sessionId}.json`);
    if (fs.existsSync(target)) bail('collision', `${target} already exists`);

    const tmp = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(entry), 'utf8');
    fs.renameSync(tmp, target);

    process.stdout.write(
      JSON.stringify({
        registered: true,
        desktop_session_id: entry.sessionId,
        cli_session_id: opts.forkId,
        title: entry.title,
        cwd: entry.cwd,
        registry_file: target,
        template_file: templateFile,
      }) + '\n'
    );
  } catch (err) {
    process.stderr.write(`register-desktop-session: ${err.message}\n`);
    process.exit(1);
  }
}
