# Script reference

Both scripts are plain ES modules using Node built-ins only (`fs`, `os`, `path`, `readline`,
`crypto`, `url`). No `npm install`, no `package.json` needed. Node 18+.

Both stream the transcript line by line, so a multi-megabyte session costs almost no memory.

---

## `scripts/analyze-turns.mjs`

```
node analyze-turns.mjs <session.jsonl> [--snippet N]
node analyze-turns.mjs --latest [--cwd DIR] [--snippet N]
```

| flag | meaning |
|---|---|
| `<session.jsonl>` | explicit transcript path |
| `--latest` | resolve the most recently modified transcript for `--cwd` |
| `--cwd DIR` | project directory for `--latest` (default: current directory) |
| `--snippet N` | snippet length in characters (default 200) |

Read-only — the transcript is only ever opened with `flags: 'r'`.

Prints one line of JSON to stdout:

```json
{
  "session_file": "/Users/me/.claude/projects/-Users-me-app/8f3c….jsonl",
  "session_id": "8f3c…",
  "total_lines": 1265,
  "total_chars": 4821903,
  "preamble": { "start_line": 1, "end_line": 5, "chars": 1204 },
  "turn_count": 18,
  "turns": [
    {
      "turn_id": 1,
      "start_line": 5,
      "end_line": 295,
      "chars": 255_000,
      "pct": 5.3,
      "snippet": "I've implemented the plan you created before…"
    }
  ]
}
```

- `end_line` is exclusive; the last turn's `end_line` is `total_lines + 1`.
- `pct` is `chars / total_chars`, rounded to one decimal. Turn percentages plus the preamble's share
  sum to 100 up to rounding.
- Turn ranges are contiguous: each turn's `end_line` equals the next turn's `start_line`.

Exit codes: `0` success, `1` runtime error (unreadable file, no transcript found), `2` bad usage.

The module also exports `analyze`, `isTurnStart`, `userText`, `findLatestSession` and
`encodeProjectPath` for testing.

---

## `scripts/build-fork.mjs`

```
node build-fork.mjs <original.jsonl> <turns.json|-> <turn_ids_csv> <output.jsonl>
```

| argument | meaning |
|---|---|
| `<original.jsonl>` | the transcript to fork, opened read-only |
| `<turns.json>` | the output of `analyze-turns.mjs`; `-` reads it from stdin |
| `<turn_ids_csv>` | ids to keep, e.g. `2,3,7` — order and duplicates do not matter |
| `<output.jsonl>` | where to write; name it `<new-uuid>.jsonl` in the same directory |

Behaviour:

- Keeps the preamble plus the full line range of each selected turn, in original file order.
- Turn ranges are copied whole, so a `tool_use` is never separated from its `tool_result`.
- Rewrites `sessionId` to the new id, and re-anchors any `parentUuid` that pointed into a dropped
  turn (see [transcript-format.md](transcript-format.md)).
- Takes the new session id from the output filename when it looks like a UUID, otherwise generates
  one with `crypto.randomUUID()`.
- Writes to `<output>.<pid>.tmp` and renames, so a crash leaves no half-written session.
- Throws if the output path resolves to the original, or if a requested turn id is not in
  `turns.json`.

Prints one line of JSON to stdout:

```json
{
  "new_session_id": "9cf88ff5-…",
  "output_path": "/Users/me/.claude/projects/-Users-me-app/9cf88ff5-….jsonl",
  "original_path": "/Users/me/.claude/projects/-Users-me-app/8f3c….jsonl",
  "kept_turns": [2, 4],
  "kept_lines": 15,
  "original_lines": 23,
  "kept_chars": 7305,
  "original_chars": 11548,
  "reduction_pct": 36.7,
  "resume_command": "claude --resume 9cf88ff5-…"
}
```

`reduction_pct` is measured in characters, not lines — it tracks context weight rather than record
count.

Exit codes: `0` success, `1` runtime error, `2` bad usage.

---

## Tests

```bash
node test/run-tests.mjs
```

Runs both scripts against `test/fake-session.jsonl`, a synthetic four-topic transcript containing
tool_use/tool_result pairs, an `isMeta` injection, sidechain lines and a `[Request interrupted by
user]` marker. The checks cover turn detection, contiguous half-open ranges, tool pairs staying
within one turn, char/percentage totals, filtered output contents and ordering, `parentUuid`
integrity, and that the original file is byte-identical afterwards.
