---
name: branching-compact
description: >-
  Fork the current Claude Code session into a smaller one that keeps only the topical threads you
  pick. Analyzes the on-disk transcript into turn summaries, groups them into topics with a
  percentage of context each, asks which to keep, and writes a new session you resume with
  `claude --resume`. Use when a long session has drifted across several unrelated topics and you
  want to continue just one or two without losing the original — for example "compact this session
  down to the deployment work" or "branch off just the refactor".
license: MIT
compatibility: Requires Node 18+ and an existing Claude Code session transcript on disk.
allowed-tools: Bash, Read, Write, AskUserQuestion
metadata:
  version: 0.1.0
---

# Branching Compact

Ordinary `/compact` summarizes everything and throws away the detail. This forks instead: it splits
the session into topical threads, lets the user keep the ones that still matter, and writes those
turns verbatim into a **new** session file. The original is never modified.

**Never read the raw transcript into your own context.** It is the thing being compacted — loading
it defeats the entire purpose. Work only from the compact JSON the scripts print.

`<skill-dir>` below is the directory containing this `SKILL.md`.

## 1. Analyze

```bash
node "<skill-dir>/scripts/analyze-turns.mjs" --latest > /tmp/turns.json
```

`--latest` resolves the most recently modified transcript for the current working directory. Pass an
explicit path instead if the user names a session. Then read `/tmp/turns.json` — it is small.

Each turn carries `turn_id`, `start_line`, `end_line` (half-open), `chars`, `pct`, and a `snippet` of
the human message that opened it. A turn begins at a genuine human message and runs until the next
one, so every tool call and its result stay inside one turn.

If `turn_count` is 0 or 1, say so and stop — there is nothing to branch.

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

## 4. Build the fork

Collect the `turn_id`s of every selected cluster, generate a fresh UUID, and write the new session
beside the original:

```bash
NEW=$(node -e 'console.log(crypto.randomUUID())')
DIR=$(dirname "<original transcript path>")
node "<skill-dir>/scripts/build-fork.mjs" "<original>" /tmp/turns.json "2,3,7" "$DIR/$NEW.jsonl"
```

Turn ids are comma-separated with no spaces. The script copies whole turn line ranges in original
order, keeps the pre-turn preamble, rewrites `sessionId` to the new id, re-anchors `parentUuid` links
across the dropped turns, and prints a JSON report. It refuses to write over the original.

## 5. Report

From the report, tell the user:

- the reduction percentage (`reduction_pct`), and kept vs original line counts
- the new session id and its file path
- the resume command: `claude --resume <new_session_id>`
- that the original session is untouched and still holds the full history

The new session is a file on disk, not the running session — the user has to resume it themselves.

## Caveats

This reads and writes Claude Code's on-disk transcript format, which is **not a documented public
API**. It can change between Claude Code versions without warning, and this skill is best-effort
against it. The safety net is that the original session file is opened read-only and never modified,
so a fork that turns out wrong costs nothing: delete the new `.jsonl` and resume the original.

## References

- [references/transcript-format.md](references/transcript-format.md) — the on-disk layout, what
  counts as a genuine human message, and why `isMeta`/`isSidechain`/`tool_result` lines do not.
- [references/scripts.md](references/scripts.md) — full arguments, output shapes, and exit codes for
  both scripts.
