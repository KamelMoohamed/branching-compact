# Claude Code's on-disk transcript format

Everything here was derived by reading real transcripts, not from documentation. Claude Code does not
publish this format and is free to change it. Treat it as observed behaviour.

This describes what `adapters/claude.mjs` knows. Nothing in `core/` depends on any of it; the Codex
equivalent is [codex-transcript-format.md](codex-transcript-format.md).

## Where transcripts live

```
~/.claude/projects/<encoded-project-path>/<session-id>.jsonl
~/.claude/projects/<encoded-project-path>/sessions/<session-id>.jsonl   # some versions
```

`<encoded-project-path>` is the absolute project path with every character outside `[A-Za-z0-9]`
replaced by a dash, so `/Users/me/Local Disk/Projects/app` becomes
`-Users-me-Local-Disk-Projects-app`. `<session-id>` is a UUID and is the id `claude --resume` takes.

`analyze-turns.mjs --latest` checks both locations and picks the most recently modified `.jsonl`,
which for a live session is the one currently being written.

## Line shape

One JSON object per line, appended as the session runs. The lines that matter carry:

| field | meaning |
|---|---|
| `type` | `user`, `assistant`, plus bookkeeping types like `summary`, `queue-operation`, `attachment`, `last-prompt` |
| `message.role` | `user` / `assistant` |
| `message.content` | a string, or an array of blocks (`text`, `thinking`, `tool_use`, `tool_result`) |
| `uuid` / `parentUuid` | the chain Claude Code walks to reconstruct a conversation |
| `sessionId` | the owning session's UUID |
| `isMeta` | `true` for context Claude Code injected, not something the human typed |
| `isSidechain` | `true` for subagent traffic |
| `toolUseResult` | raw tool output attached to a `tool_result` line |

## What counts as a turn start

The load-bearing detail: **tool results come back as `role: "user"` messages.** Treating every
user-role line as a turn boundary shatters the session into hundreds of fragments and splits tool
calls from their results.

`isTurnStart()` requires all of:

1. `type === "user"` with a `message`.
2. Not `isMeta` — that flag marks skill preambles, hook output, image-dimension notes and similar
   injections. In one real 4,000-line session, 171 lines were `isMeta`.
3. Not `isSidechain` — subagent prompts and replies are not the human speaking.
4. Content is not, and does not contain, a `tool_result` block.
5. Non-empty human text remains after stripping `<system-reminder>`, `<local-command-stdout>`,
   `<command-*>` tag markup and bare `[Image: …]` placeholders.
6. The text is not a synthetic marker — `[Request interrupted by user]`, `(no content)`, or the
   `Caveat: The messages below were generated…` banner a previous compaction leaves behind.

Genuine prompts appear both as plain strings and as arrays containing a `text` block; both are
handled. Slash-command invocations are kept — the human did type them.

Sanity check: on a real 4,071-line session this yields 7 turns, matching what the human actually sent.

## Turn ranges

A turn owns the half-open line range `[start_line, end_line)` — from its human message up to the next
one. Because the range is contiguous and never subdivided, a `tool_use` and its `tool_result` are
always in the same turn, which is what makes filtering safe. Lines before the first human message are
the *preamble* (session metadata, summary records) and are always carried into a fork.

`chars` is the sum of raw line lengths in the range. It is a token-usage *proxy*, not a token count:
JSON punctuation, base64 image payloads and metadata all count. It is good enough for relative
weighting between turns, which is all the percentages claim to be.

## Branching safely

`core/branching.mjs` copies whole turn ranges into a new file and the Claude adapter makes two edits
so the result is resumable:

- `sessionId` on every copied line is set to the new session's UUID.
- Dropping turns leaves holes in the `uuid` → `parentUuid` chain. Any `parentUuid` pointing at a line
  that was not kept is re-anchored to the last kept line, so the fork stays one walkable thread.

Nothing else is rewritten, line order is preserved, and the original file is opened read-only. The
new id is a v4 UUID, matching what Claude Code names its own sessions.
