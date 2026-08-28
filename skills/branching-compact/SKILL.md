---
name: branching-compact
description: >-
  Branch the current coding-agent session into a smaller one that keeps only the topical threads you
  pick. Works with Claude Code and OpenAI Codex. Analyzes the on-disk session into turn summaries,
  groups them into topics with a percentage of context each, asks which to keep, and writes a new
  session you resume with `claude --resume` or `codex resume`. Use when a long session has drifted
  across several unrelated topics and you want to continue just one or two without losing the
  original — for example "compact this session down to the deployment work" or "branch off just the
  refactor".
license: MIT
compatibility: Requires Node 18+ and an existing Claude Code or Codex session on disk.
allowed-tools: Bash, Read, Write, AskUserQuestion
metadata:
  version: 0.2.0
---

# Branching Compact

Ordinary compaction summarizes everything and throws away the detail. This branches instead: it
splits the session into topical threads, lets the user keep the ones that still matter, and writes
those turns verbatim into a **new** session file. The original is never modified.

**Never read the raw session file into your own context.** It is the thing being compacted — loading
it defeats the entire purpose. Work only from the compact JSON the scripts print.

The scripts handle Claude Code and Codex behind one interface. You do not need to know which one you
are running inside; the agent is detected, and `--agent claude` / `--agent codex` overrides it.

`<skill-dir>` below is the directory containing this `SKILL.md`.

## 1. Analyze

```bash
node "<skill-dir>/scripts/branching-compact.mjs" analyze --latest > /tmp/turns.json
```

`--latest` resolves the current session for the working directory. Pass an explicit session file path
instead if the user names one. Then read `/tmp/turns.json` — it is small.

The report carries `agent`, `session_file`, `session_id`, `total_lines`, `preamble` and `turns`. Each
turn has `turn_id`, `start_line`, `end_line` (half-open), `chars`, `pct`, and a `snippet` of the human
message that opened it. A turn begins at a genuine human message and runs until the next one, so
every tool call and its result stay inside one turn.

If `turn_count` is 0 or 1, say so and stop — there is nothing to branch.

If the command fails with an agent-detection error, it is telling you it could not decide safely.
Re-run with `--agent claude` or `--agent codex` rather than working around it.

## 2. Cluster

Group the turns into topical threads **from the snippets you just read**. Do not use a fixed category
list or a fixed number of clusters — let the actual content decide. Consecutive turns often belong
together ("Go on", "continue" follow the topic before them), but a topic can also resume later; group
by meaning, not adjacency.

Sum each cluster's `chars`, divide by `total_chars`, and label it with what it is plus its share:
`Deployment debugging (41%)`.

## 3. Ask

Use **AskUserQuestion** with `multiSelect: true`, one option per cluster. Label each option with the
topic and its percentage; put the turn numbers and a concrete detail in the option description so the
user can tell the clusters apart. Order clusters by size, largest first.

## 4. Build the branch

Collect the `turn_id`s of every selected cluster and pass them as one comma-separated list:

```bash
node "<skill-dir>/scripts/branching-compact.mjs" branch "<session-file>" /tmp/turns.json 2,3,7
```

Turn ids are comma-separated with no spaces. Leave the output path off: the adapter names the new
session the way its agent does — a UUID beside the original for Claude Code, a
`rollout-<timestamp>-<uuidv7>.jsonl` under `~/.codex/sessions/YYYY/MM/DD/` for Codex. Pass
`--output <path>` only if the user asked for a specific location.

The script copies whole turn line ranges in original order, keeps the session preamble, rewrites the
session id and re-anchors the internal links, checks the result for orphaned tool output before
committing it, and prints a JSON report. It refuses to write over the original.

## 5. Open it

Every branch is resumable from a terminal with the `resume_command` in the report — `claude --resume
<id>` or `codex resume <id>`. Lead with that.

**Claude Code desktop app only.** The desktop app does not build its chat list from
`~/.claude/projects/`. It keeps its own registry, and a branched transcript that no registry entry
points at is invisible in the sidebar. Register it:

```bash
node "<skill-dir>/scripts/register-desktop-session.mjs" "<new-session-id>"
```

Omit `--title` and the branch inherits the parent chat's name with `(forked)` appended, which is what
you usually want — the user finds it in the sidebar by looking for the chat it came from. Only pass
`--title` when the user asks for a specific name, and even then keep the parent chat's name in it.
Do **not** invent a topic label from the session's contents: a branch named after one thread inside
it is unrecognisable next to the chat it was split off from.

The script detects the host itself and exits 3 with `{"registered": false, "reason": "not-desktop"}`
when this is not a Claude Code desktop session — treat that as the terminal case, not an error.

**Codex.** Nothing to register. Codex discovers sessions by scanning `~/.codex/sessions/`, so the new
rollout is found on its own; `codex resume <id>` opens it.

## 6. Report

From the reports, tell the user:

- the reduction percentage (`reduction_pct`), and kept vs original line counts
- the new session id and its file path
- the `resume_command` — this is the way in
- that the original session is untouched and still holds the full history

If `register-desktop-session.mjs` reported `registered: true`, its output carries
`restart_required: true` and a `notice` string. **Show the user that notice — do not paraphrase it
away or bury it.** The chat appears in the sidebar under the title you gave it, in the same group as
the chat it came from (the sidebar groups by working directory, and the branch inherits the parent's
`cwd`) — but **only after the desktop app restarts**. The app reads that registry once at startup and
reloads it only on an account or org change, so a running app will never show the branch. Say this
plainly, or the user will look immediately, see nothing, and conclude the branch failed. The resume
command works right now, in any terminal, including the desktop app's built-in one.

## Caveats

This reads and writes each agent's on-disk session format, and **neither is a documented public
API**. Both can change between releases without warning, and this skill is best-effort against them.
The safety net is that the original session file is opened read-only and never modified, so a branch
that turns out wrong costs nothing: delete the new file and resume the original.

Claude Code desktop registration reaches further, into the app's own state directory, which is
undocumented too. It only ever adds a file; to undo one, delete the `local_<uuid>.json` it reports.

## References

- [references/claude-transcript-format.md](references/claude-transcript-format.md) — Claude Code's
  layout, what counts as a genuine human message, and why `isMeta`/`isSidechain`/`tool_result` lines
  do not.
- [references/codex-transcript-format.md](references/codex-transcript-format.md) — Codex's rollout
  layout, the two spellings of the genuine-message event, and what a branch does and does not have to
  write.
- [references/scripts.md](references/scripts.md) — full arguments, output shapes and exit codes for
  every script, plus the adapter contract if you are adding an agent.
