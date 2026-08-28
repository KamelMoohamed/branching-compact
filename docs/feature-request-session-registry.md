# Feature request: let a skill register a session so it appears without an app restart

**Products:** Claude Code Desktop 1.37937.1 (macOS), Claude Code CLI 2.1.246

## Summary

A skill can build a new session transcript on disk, but has no supported way to make the desktop app
show it as a chat. The app reads its session registry once at startup, so a transcript created during
a session stays invisible in the sidebar until the app is relaunched.

The underlying capability already exists — `LocalSessions.forkSession` — it just isn't reachable from
a skill. Exposing it, or a narrower refresh, on the existing `ccd_session_mgmt` bridge would close
the gap.

## Use case

I wrote a skill, [`branching-compact`](https://github.com/KamelMoohamed/branching-compact),
that forks a long session instead of summarizing it. `/compact` collapses everything into a summary
and discards the detail; a long session is usually several unrelated threads, and often only one is
still worth continuing.

The skill parses the session's JSONL transcript into per-turn summaries, groups them into topics,
asks which to keep, and writes the selected turns verbatim into a new transcript. On a real 745-line
session it produced a 94.4% reduction while keeping the chosen thread intact.

The new transcript is valid and `claude --resume <id>` opens it. The gap is purely presentational:
in the desktop app it does not appear as a chat until the next launch.

Note this is not the same operation as the existing fork. `forkSession(parentSessionId,
forkAtMessageUuid)` truncates a conversation at one point. Selective compaction keeps an arbitrary
subset of turns — several disjoint ranges — so the result cannot be expressed as a truncation.

## What the app does today

Session entries live at:

```
macOS    ~/Library/Application Support/Claude/claude-code-sessions/<accountId>/<orgId>/local_<uuid>.json
Linux    ~/.config/Claude/claude-code-sessions/...
Windows  %APPDATA%/Claude/claude-code-sessions/...
```

Each entry points at a transcript through `cliSessionId`. A transcript in `~/.claude/projects/` that
no entry points at is fully resumable from a terminal and completely invisible in the app.

The registry is read by `loadSessions()`, reached only from `initializeWithAccount()`, which runs
from three places:

1. first initialization at app start,
2. the org-change listener (`handleOrgChange`),
3. the account-change listener (account switch, or logout → login).

There is no `fs.watch` on that directory, no polling timer, and no UI action that re-reads it. Every
entry is cached in an in-memory `Map`, so once loaded, later edits to a file are ignored too —
renaming an entry on disk has no effect until relaunch.

The app's own logs match: `Loaded N persisted sessions` and `reinitializing sessions` appear only
around startup.

## What a skill can reach

The `ccd_session_mgmt` MCP server is the only bridge from a skill to the app, and its tool list is
fixed:

```
list_sessions · get_session · search_session_transcripts
list_events · archive_session · set_session_title · send_message
```

All read-only or metadata operations. Nothing creates a session or refreshes the registry.

`LocalSessions` — which already has `forkSession`, `start`, `updateSession`, `getAll` — is Electron
main↔renderer IPC, internal to the app process. The app opens no listening ports, and
`/tmp/cc-socks/<pid>.sock` belongs to the CLI process for inbound cross-session messages, not to the
app. So there is no supported path from a skill to those methods.

## Requested change

Either would solve it. The first is smaller; the second is more useful.

**Option A — `refresh_sessions`.** A tool on `ccd_session_mgmt` that re-runs `loadSessions()`. Any
externally written entry becomes visible immediately. No new persistence logic, and it also fixes
stale in-memory entries after an on-disk edit.

**Option B — `create_session_from_transcript(cli_session_id, title, cwd?)`.** Register an existing
on-disk transcript as a chat and return its `sessionId`. More general than `forkSession`, since the
caller supplies the transcript rather than a truncation point, and it covers any tool that produces
a transcript — compaction, import, migration, session repair.

For Option B the natural defaults are the ones the app already stores: inherit `cwd`, `model`,
`effort`, `permissionMode` and MCP configuration from a parent session, so the new chat behaves like
the one it came from.

## Current workaround, and why it isn't enough

The skill writes the registry entry itself, modelled on the parent chat's entry. It works — the fork
appears correctly, in the right sidebar group, with the parent's settings — but only from the next
launch, because of the load-once behaviour above.

That means the skill has to depend on an undocumented on-disk format that can change in any release,
and users still have to restart to see the result. `claude --resume <id>` opens the fork immediately
and is what the skill recommends, but it puts the session in a terminal rather than in the sidebar
where the user expects it.

A supported tool would let the skill drop the private-format dependency entirely.
