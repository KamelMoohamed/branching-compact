# Codex's on-disk session format

Everything here was derived by reading real rollout files written by **codex-cli 0.148.0-alpha.15**
(the Codex desktop app) and **0.149.0-alpha.4.1** (the CLI bundled in `ChatGPT.app`). Codex does not
publish this format and is free to change it. Treat it as observed behaviour.

## Where sessions live

```
~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-<YYYY-MM-DD>T<HH-MM-SS>-<session-id>.jsonl
```

`$CODEX_HOME` overrides `~/.codex`. **The date directory and the timestamp in the filename are local
time**, while the `timestamp` fields inside the file are UTC — a session started at 20:26 Melbourne
time on 2026-08-21 lands in `2026/08/21/rollout-2026-08-21T20-26-51-…` and carries
`"timestamp": "2026-08-21T10:26:51.510Z"` inside. `<session-id>` is a UUIDv7 and is the id
`codex resume` takes.

Unlike Claude Code, the project path is **not** encoded in the location. The working directory is a
field (`payload.cwd`) inside the first record, so finding "the session for this directory" means
reading the first line of each rollout, newest first. Rollouts reach tens of megabytes, so nothing
here reads more than it needs to.

Resuming appends to the same file. One rollout is one session, with one `session_meta` at the top.

## Line shape

One JSON object per line. Every line has `timestamp`, `type`, `payload`; **0.149 and later also carry
a top-level `ordinal`**, a 0-based counter over the records in the file.

| `type` | what it is |
|---|---|
| `session_meta` | first line only: `session_id`, `id`, `cwd`, `originator`, `cli_version`, `source`, `model_provider`, `base_instructions` |
| `response_item` | a record that is part of the model conversation — `message`, `reasoning`, `custom_tool_call`, `custom_tool_call_output`, `function_call`, `function_call_output`, `web_search_call` |
| `event_msg` | a UI/bookkeeping event — `task_started`, `task_complete`, `user_message`, `item_completed`, `token_count`, `thread_settings_applied`, `turn_aborted` |
| `turn_context` | the per-turn configuration: `cwd`, `model`, `approval_policy`, `sandbox_policy` |
| `world_state` | a snapshot of environment/skills/instructions available to the turn |
| `compacted` | a compaction point, carrying `replacement_history` |

`response_item.payload.role` is `user`, `assistant`, or `developer`.

Turn identity is explicit and consistent: `turn_id` appears directly on `event_msg` and
`turn_context` payloads, and under
`payload.internal_chat_message_metadata_passthrough.turn_id` on every `response_item`.

## What counts as a turn start

The load-bearing detail here is the mirror image of Claude's: **Codex injects context as
`role: "user"` records.** `<environment_context>`, `<recommended_plugins>`, `<app-context>` and
friends are indistinguishable from a prompt by role alone, and treating each one as a turn boundary
produces phantom turns holding no human input.

The genuine prompt is identified by the event Codex emits once it has accepted a human message. Two
spellings exist in the wild, and both are handled:

| CLI | event |
|---|---|
| ≤ 0.148 | `event_msg` with `payload.type == "user_message"`, text in `payload.message` |
| ≥ 0.149 | `event_msg` with `payload.type == "item_completed"` and `payload.item.type == "UserMessage"` |

That event is written **after** the `response_item` it confirms, so a single forward pass cannot tell
the prompt from an injection. `adapters/codex.mjs` therefore does one streaming pre-pass that
collects the confirmation events and matches them, in file order, to the `role: "user"` records. Only
line numbers, turn ids and message heads are retained — never the transcript.

If a rollout has no confirmation events at all, the adapter falls back to shape: a `role: "user"`
record whose text is one complete XML-ish wrapper (`<environment_context>…</environment_context>`) is
an injection; anything else is a prompt.

## Turn ranges

A turn owns the half-open line range `[start_line, end_line)`, exactly as on the Claude side, but the
boundary is placed with Codex's block structure in mind:

```
event_msg/task_started        (turn_id = T)   ← turn T's block begins
[world_state]
[injected role:user records]                  ← <environment_context>, plugin lists
[developer messages]
turn_context                  (turn_id = T)
response_item/message role=user               ← the genuine prompt
event_msg/user_message | item_completed(UserMessage)
… reasoning, tool calls, tool outputs, assistant messages …
event_msg/task_complete       (turn_id = T)
[event_msg/thread_settings_applied]
```

- **The first turn starts at its prompt.** Everything above it — `session_meta`, the base
  instructions, the standing developer messages — is the *preamble*, which is carried into every
  branch regardless of which turns were chosen.
- **Every later turn starts at its own `task_started`**, so its `turn_context` and any per-turn
  injected context travel with the turn they configure, and no branch ever ends on a `task_started`
  whose turn was dropped.

Ranges stay contiguous and are never subdivided, so a `custom_tool_call` and its
`custom_tool_call_output` are always in the same turn — which is what makes dropping turns safe.

`chars` is the sum of raw line lengths. It is a token-usage *proxy*, not a token count.

## Branching safely

`core/branching.mjs` copies whole turn ranges into a new rollout and the Codex adapter makes three
edits:

- `payload.session_id` and `payload.id` on the `session_meta` header become the new id, and its
  timestamps become now. The new id is minted as a **UUIDv7**, the shape Codex mints itself, so
  anything that sorts ids by their embedded time still works.
- `payload.thread_id`, which appears on `item_completed` events, is repointed at the new id.
- `ordinal` is renumbered contiguously from 0 where the format has it. Codex projects rollouts into
  `~/.codex/thread_history_*.sqlite` and tracks its position with `next_rollout_ordinal` alongside a
  byte offset, so a branch that dropped records must not inherit gaps.

`turn_id` values are **not** rewritten. They are scoped to a thread, and every `task_started`,
`turn_context` and `response_item` inside a kept range agrees on them; regenerating would risk
breaking that agreement for no gain.

Nothing else is rewritten. In particular, an old session id embedded in a **path** — a workspace root
under `~/.codex/visualizations/<date>/<session-id>`, or a path inside a tool result — is left alone:
that directory belongs to the original session, and repointing it would name something that does not
exist.

## What is *not* needed to make a branch resumable

Verified by building a branch and resuming it with `codex exec resume <id>`:

- **`~/.codex/session_index.jsonl` does not need an entry.** It maps a session id to a `thread_name`
  so `codex resume <name>` can resolve a name. On the machine this was developed against it held 21
  entries for 40 rollouts, and `codex exec resume` opened rollouts that were not in it.
- **`~/.codex/sqlite/codex-dev.db` (`local_thread_catalog`) does not need a row.** It is a reconciled
  cache the desktop app builds by scanning rollouts — it carries an `observation_sequence` and a
  reconciliation watermark, and had exactly one row per rollout file.
- **`~/.codex/thread_history_*.sqlite` does not need a row.** Its
  `thread_history_projection_state` table stores a byte offset and ordinal *into the rollout file*,
  which is what makes the rollout the source of truth and the table a projection of it.

So a branch is a file, and only a file. `branching-compact` writes nothing else under `~/.codex`.
