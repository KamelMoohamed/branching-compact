# Script reference

All scripts are plain ES modules using Node built-ins only (`fs`, `os`, `path`, `readline`, `crypto`,
`url`). No `npm install`, no `package.json` needed. Node 18+.

Everything streams line by line, so a 90 MB session costs almost no memory.

## Layout

```
scripts/
  branching-compact.mjs          the entry point: detect | analyze | branch
  analyze-turns.mjs              analyze, as its own command
  build-fork.mjs                 branch, as its own command
  register-desktop-session.mjs   Claude Code desktop only
  core/
    agents.mjs                   adapter registry and agent detection
    transcript.mjs               the normalized model and turn analysis
    selection.mjs                turn ids to line ranges
    branching.mjs                the branch writer
  adapters/
    claude.mjs                   everything Claude Code specific
    codex.mjs                    everything Codex specific
```

Nothing under `core/` knows which agent produced the file it is reading.

---

## `scripts/branching-compact.mjs`

```
branching-compact detect  [--cwd DIR] [--agent NAME]
branching-compact analyze [session-file] [--latest] [--agent NAME] [--cwd DIR] [--snippet N]
branching-compact branch  <session-file> <turns.json|-> <turn-ids> [--agent NAME] [--output PATH]
```

| flag | meaning |
|---|---|
| `--agent NAME` | `claude` or `codex`; aliases `claude-code`, `openai-codex`, `codex-cli`, `cc` |
| `--latest` | resolve the current session for `--cwd` |
| `--cwd DIR` | project directory (default: current directory) |
| `--snippet N` | snippet length in characters (default 200) |
| `--output PATH` | where to write the branch; defaults to the agent's own naming |

Every subcommand prints one line of JSON. Exit codes: `0` success, `1` runtime error, `2` bad usage.

`detect` reports which agent was chosen and why:

```json
{ "agent": "codex", "display_name": "OpenAI Codex", "detected_by": "environment",
  "evidence": "CODEX_THREAD_ID=01a0480f-…" }
```

`detected_by` is one of `explicit`, `environment`, `file-format`, `sessions-on-disk`.

---

## Agent detection

In order, stopping at the first that resolves:

1. **`--agent`.** Always wins.
2. **The named session file's own format.** A first record with a `sessionId`/`uuid` is a Claude Code
   transcript; a `session_meta` record is a Codex rollout.
3. **The environment.** `CLAUDE_CODE_ENTRYPOINT`, `CLAUDECODE` or `CLAUDE_CODE_SSE_PORT` mean Claude
   Code; `CODEX_THREAD_ID`, `CODEX_SESSION_ID` or `CODEX_SANDBOX` mean Codex. Both agents set these
   in the environment of the commands they run, so with no file named this is usually the answer.
4. **Which agent has a session on disk** for `--cwd`.

The file outranks the environment on purpose: the environment says which agent is *running* the
script, which is not the same question as which agent wrote the file it was handed. Branching a Codex
session from inside Claude Code is an ordinary thing to do.

If more than one candidate survives — both agents' environment variables are set, or both have a
session for this directory — that is an **error naming both candidates**, never a coin flip. Guessing
wrong means writing one agent's format into the other's session store.

`analyze` and `branch` both validate the file's format against the chosen agent before doing
anything, so an explicit `--agent` that contradicts the file fails with an explanation rather than
producing an empty analysis.

---

## `scripts/analyze-turns.mjs`

```
node analyze-turns.mjs <session.jsonl> [--agent NAME] [--snippet N]
node analyze-turns.mjs --latest [--agent NAME] [--cwd DIR] [--snippet N]
```

Read-only — the session is only ever opened with `flags: 'r'`. Equivalent to
`branching-compact analyze`. Prints one line of JSON:

```json
{
  "agent": "claude",
  "session_file": "/Users/me/.claude/projects/-Users-me-app/8f3c….jsonl",
  "session_id": "8f3c…",
  "total_lines": 1265,
  "total_chars": 4821903,
  "preamble": { "start_line": 1, "end_line": 5, "chars": 1204 },
  "turn_count": 18,
  "turns": [
    { "turn_id": 1, "start_line": 5, "end_line": 295, "chars": 255000, "pct": 5.3,
      "snippet": "I've implemented the plan you created before…" }
  ]
}
```

- `end_line` is exclusive; the last turn's `end_line` is `total_lines + 1`.
- `pct` is `chars / total_chars`, rounded to one decimal. Turn percentages plus the preamble's share
  sum to 100 up to rounding.
- Turn ranges are contiguous: each turn's `end_line` equals the next turn's `start_line`.
- `session_id` comes from the filename for Claude Code and from `session_meta` for Codex.

The module also exports `analyze`, `analyzeSession`, `isTurnStart`, `userText`, `findLatestSession`
and `encodeProjectPath`. The unprefixed names operate on Claude Code transcripts, as they did before
the adapter split.

---

## `scripts/build-fork.mjs`

```
node build-fork.mjs <original.jsonl> <turns.json|-> <turn_ids_csv> [output.jsonl] [--agent NAME]
```

| argument | meaning |
|---|---|
| `<original.jsonl>` | the session to branch, opened read-only |
| `<turns.json>` | the output of `analyze-turns.mjs`; `-` reads it from stdin |
| `<turn_ids_csv>` | ids to keep, e.g. `2,3,7` — order and duplicates do not matter |
| `[output.jsonl]` | optional; without it the adapter picks the agent's own location and name |

The agent comes from `--agent`, else the report's own `agent` field, else detection — so a report
produced by one adapter can never be written back by another.

Behaviour, for every agent:

- Keeps the preamble plus the full line range of each selected turn, in original file order.
- Turn ranges are copied whole, so a tool call is never separated from its result.
- Writes to `<output>.<pid>.tmp` and renames, so a crash leaves no half-written session.
- Before the rename, checks the result for tool output whose call was not kept. A branch that would
  be malformed is **refused**, and the temporary file removed.
- Throws if the output path resolves to the original, if a requested turn id is not in the report, or
  if the selection would produce a branch with no human turn.

Per-agent rewrites are in [claude-transcript-format.md](claude-transcript-format.md) and
[codex-transcript-format.md](codex-transcript-format.md).

Prints one line of JSON:

```json
{
  "agent": "codex",
  "new_session_id": "01a04818-8b08-7df2-8763-8e99eced4a02",
  "output_path": "/Users/me/.codex/sessions/2026/08/28/rollout-2026-08-28T21-19-23-01a04818-….jsonl",
  "original_path": "/Users/me/.codex/sessions/2026/08/28/rollout-2026-08-28T21-09-15-01a0480f-….jsonl",
  "original_session_id": "01a0480f-446e-7180-a8d6-19b8675ce33d",
  "kept_turns": [2, 3],
  "kept_lines": 40,
  "original_lines": 67,
  "kept_chars": 108484,
  "original_chars": 125142,
  "reduction_pct": 13.3,
  "resume_command": "codex resume 01a04818-8b08-7df2-8763-8e99eced4a02"
}
```

`reduction_pct` is measured in characters, not lines — it tracks context weight rather than record
count.

---

## `scripts/register-desktop-session.mjs`

**Claude Code desktop only.** Codex needs no equivalent: it discovers sessions by scanning
`~/.codex/sessions/`, so a new rollout is visible without any registration.

```
node register-desktop-session.mjs <fork-session-id> --title "..." [--template <local_id>] [--cwd DIR]
```

The desktop app does not list chats by scanning `~/.claude/projects/`. It keeps its own registry —
one JSON per chat — and each entry points at a transcript through `cliSessionId`:

```
macOS    ~/Library/Application Support/Claude/claude-code-sessions/<accountId>/<orgId>/local_<uuid>.json
Linux    ~/.config/Claude/claude-code-sessions/...
Windows  %APPDATA%/Claude/claude-code-sessions/...
```

A branched `.jsonl` that no entry points at resumes fine from a terminal but is invisible in the app.
This script adds the missing entry.

Detection and location both come from the environment the desktop app sets:

- `CLAUDE_CODE_ENTRYPOINT` contains `desktop` when running inside the app.
- `CLAUDE_CODE_HOST_SESSION_ID` is the current chat's registry id, so the script finds the registry
  file directly instead of guessing the `<accountId>`/`<orgId>` directory names.

That file is also the template: the branch inherits `cwd`, `originCwd`, `model`, `effort`,
`permissionMode`, `chromePermissionMode`, `remoteMcpServersConfig` and `enabledMcpTools` from the
chat it came from. Everything else is set fresh, so no per-turn state or accumulated permission
grants carry over. `--template` overrides the source entry; `--cwd` overrides the directory.

Prints on success:

```json
{
  "registered": true,
  "desktop_session_id": "local_…",
  "cli_session_id": "…",
  "title": "Parent chat (forked)",
  "cwd": "/path/to/project",
  "registry_file": "…/local_….json",
  "template_file": "…/local_….json",
  "restart_required": true,
  "notice": "Restart the Claude desktop app to see this chat in the sidebar — …"
}
```

`restart_required` and `notice` are always present on success. The notice is meant to be shown to the
user verbatim: without it, someone who looks at the sidebar immediately will conclude the branch
failed.

Exits **3** with `{"registered": false, "reason": "..."}` when it cannot register — `not-desktop`,
`no-host-session`, `registry-not-found`, or `collision`. That is the fall-through case, not a
failure: use the resume command instead. Exit `1` is a real error, `2` bad usage.

Two behaviours worth knowing:

- **A new entry appears only after the app restarts.** The session manager reads this directory once
  during `initializeWithAccount()` and caches every entry in memory. That runs at app start and on an
  account change, org change, or logout→login — there is no file watcher, no polling timer, and no
  UI action that re-reads the directory.
- **Edits to an already-loaded entry need a restart.** Once the app has an entry in memory it ignores
  later changes to the file. Verified by renaming a loaded entry on disk and reading back the old
  title. This is why the title has to be right when the entry is created.
- **It appears next to its parent.** The sidebar groups chats by working directory, and the entry
  inherits `cwd` from the chat it came from.

The script only ever creates a file, never edits one, and refuses to overwrite an existing entry. To
undo a registration, delete the `local_<uuid>.json` it reports.

---

## The adapter contract

Adding an agent means one file in `adapters/` and one line in `core/agents.mjs`. There is no plugin
framework and no registration protocol — with two agents, that would be more machinery than the
problem has.

| member | purpose |
|---|---|
| `id`, `displayName`, `aliases` | naming for `--agent` |
| `detectFromEnv(env)` | evidence string, or `null` |
| `detectFromHeader(entry)` | is this first record ours? |
| `hasSessionsFor({cwd, home, env})` | does this agent have a session for this directory? |
| `findLatestSession({cwd, home, env})` | resolve the current session file |
| `sessionIdFor(file, header)` | the id the agent's resume command takes |
| `prepare(file)` | optional pre-pass; returns opaque state for `classify` |
| `classify(entry, lineNo, state)` | `{ turnStart, text }` — the one thing the core needs |
| `validateHeader(entry, file)` | throw if the file is not this agent's format |
| `toolIds(entry)` | `{ calls, results }`, so the core can reject orphaned tool output |
| `newSessionId(now)` | mint an id in the agent's own shape |
| `sessionIdFromPath(output)` | recover an id from a caller-supplied output path, or `null` |
| `branchPathFor({...})` | where a branch belongs, named the agent's way |
| `createRewriter({...})` | `line(entry)` → rewritten entry, or `null` to drop it |
| `resumeCommand(id)` | the command shown to the user |

## Tests

```bash
node test/run-tests.mjs
```

51 checks across `test/fixtures/`. See the Development section of the README.
