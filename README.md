# Branching Compact

Branch long Claude Code and Codex sessions by topic instead of compacting unrelated work into a
single summary.

Compaction squashes your whole session into a summary and throws the detail away. But long sessions
usually aren't one thing — they're four. You did some theory, then wrote code, then chased a
deployment bug, then started drafting a report. When you only want to keep going on the deployment
bug, summarizing all four is the wrong move.

`branching-compact` splits the session into topical threads, shows you what share of the context each
one is eating, lets you pick the ones worth keeping, and writes those turns **verbatim** into a new
session you can resume. The original session file is opened read-only and never modified.

## Branching vs. compaction

| | compaction | branching |
|---|---|---|
| what survives | a summary of everything | the chosen turns, verbatim |
| what it costs you | the detail of every thread | the threads you didn't pick |
| the original | replaced in place | untouched, still resumable |
| unrelated work | averaged into one narrative | left behind cleanly |
| tool calls | described, not replayable | kept with their results |

Branching is the right move when the session has **drifted**. Compaction is still the right move when
it's one long piece of work you want condensed.

## Supported agents

| Agent | Read sessions | Create branches | Resume branch |
|-------------|---------------|-----------------|---------------|
| Claude Code | ✅ | ✅ | ✅ `claude --resume <id>` |
| Codex | ✅ | ✅ | ✅ `codex resume <id>` |

Both columns are verified against real sessions on real installs — see
[Verification](#what-was-actually-verified). One caveat, on the Claude Code **desktop app** only: a
new branch does not appear in the sidebar until the app restarts, because the app reads its chat
registry once at startup. The resume command works immediately either way.

## How it works

```
native session (Claude .jsonl / Codex rollout)
    ↓  agent adapter
normalized turns  — line ranges, char weights, one snippet each
    ↓  shared branching engine
selected turns
    ↓  agent adapter
native branched session
```

1. Find the current session — `~/.claude/projects/…` for Claude Code, `~/.codex/sessions/…` for
   Codex.
2. Stream it into compact per-turn summaries: line range, character count, percentage of the session,
   and a short snippet. **The raw session never enters the model's context**; that would defeat the
   point.
3. The model clusters those snippets into topical threads by content — no fixed category list, no
   fixed count.
4. You get a multi-select question listing each thread with its share of the context.
5. A new session file is written containing only the selected turns, in original order, plus the
   session preamble. Turn line ranges are copied whole, so a tool call is never separated from its
   result, and the result is checked for orphaned tool output before it is committed.
6. You get the reduction percentage and the resume command.

A turn starts at a *genuine* human message, and that distinction is where most of the work is. Both
agents muddy it, in opposite ways:

- **Claude Code** delivers tool results as `role: "user"` messages, along with injected context and
  subagent traffic. Naively splitting on user-role lines shatters a session into hundreds of broken
  fragments.
- **Codex** injects context (`<environment_context>`, plugin lists, app context) as `role: "user"`
  records that look exactly like prompts. It confirms real prompts with a separate event, written
  *after* the record it confirms — so identifying them takes a pre-pass, not a filter.

See [claude-transcript-format.md](skills/branching-compact/references/claude-transcript-format.md)
and [codex-transcript-format.md](skills/branching-compact/references/codex-transcript-format.md).

## Example run

```
> /branching-compact

Analyzing session 15e357f3-9cb1-4ec6-a94b-6c75489b3ebf — 1,265 lines, 18 turns.
```

You then get:

> **Which threads do you want to keep?** *(select all that apply)*
>
> - **Deployment debugging (42%)** — turns 10, 15: switching off the local backend to the deployed
>   API, chasing the caching issue
> - **Mobile app rebuild (28%)** — turns 11, 16, 18: stale build, missing features, rebuilding
> - **Content seeding (15%)** — turns 2, 3, 6–8, 13: seed files, playlist metadata, multi-item fetches
> - **UI fixes and commits (9%)** — turns 12, 14, 17: labels, group goals, commit/push

Pick one or more, and:

```
Branched 2 of 18 turns → 57.6% smaller (174 of 1,265 lines).

  New session: cf63ebe7-fe9c-44a2-82f9-4c12119c8b5c
  File:        ~/.claude/projects/-Users-me-app/cf63ebe7-….jsonl

  claude --resume cf63ebe7-fe9c-44a2-82f9-4c12119c8b5c

The original session is untouched and still has the full history.
```

## Architecture

One branching engine, two thin adapters. Nothing under `core/` knows which agent produced the file it
is reading.

```
skills/branching-compact/
  SKILL.md
  scripts/
    branching-compact.mjs          entry point: detect | analyze | branch
    analyze-turns.mjs              analyze, as its own command
    build-fork.mjs                 branch, as its own command
    register-desktop-session.mjs   Claude Code desktop only
    core/
      agents.mjs                   adapter registry and agent detection
      transcript.mjs               the normalized model and turn analysis
      selection.mjs                turn ids to line ranges
      branching.mjs                the branch writer
    adapters/
      claude.mjs                   ~/.claude, sessionId, parentUuid, isMeta/isSidechain
      codex.mjs                    ~/.codex, session_meta, turn_id, rollout naming
  references/
    claude-transcript-format.md
    codex-transcript-format.md
    scripts.md
test/
  fixtures/claude/  fixtures/codex/
  run-tests.mjs
```

**The normalized model is held by reference.** A turn records the half-open line range
`[start_line, end_line)` of the native records it owns, not their content. Real sessions reach tens of
megabytes — the largest tested here is 94 MB — and the whole point of the tool is to keep them out of
anyone's context, so nothing ever holds more than one line at a time.

The adapter contract is fourteen small members, listed in
[references/scripts.md](skills/branching-compact/references/scripts.md#the-adapter-contract). Adding a
third agent means one file in `adapters/` and one line in `core/agents.mjs`. There is deliberately no
plugin framework.

## Usage

Inside any Claude Code or Codex session with some history:

```
/branching-compact
```

Or run the scripts directly:

```bash
node skills/branching-compact/scripts/branching-compact.mjs analyze --latest > /tmp/turns.json
```

```bash
node skills/branching-compact/scripts/branching-compact.mjs branch <session-file> /tmp/turns.json 2,3,7
```

Leave the output path off and the branch is named and placed the way its agent names its own
sessions. Full flags and output shapes:
[references/scripts.md](skills/branching-compact/references/scripts.md).

### `--agent`

```bash
branching-compact analyze --latest --agent claude
branching-compact analyze --latest --agent codex
```

Aliases: `claude-code`, `cc`, `openai-codex`, `codex-cli`.

### Automatic detection

Without `--agent`, in order, stopping at the first that resolves:

1. **The named session file's own format** — a `sessionId`/`uuid` first record vs. a `session_meta`.
2. **The environment.** `CLAUDE_CODE_ENTRYPOINT` / `CLAUDECODE` / `CLAUDE_CODE_SSE_PORT` mean Claude
   Code; `CODEX_THREAD_ID` / `CODEX_SESSION_ID` / `CODEX_SANDBOX` mean Codex. Both agents set these
   for the commands they run, so with no file named this is almost always the answer.
3. **Which agent has a session on disk** for the working directory.

A named file outranks the environment on purpose: the environment says which agent is *running* the
script, not which agent wrote the file. Branching a Codex session from inside Claude Code works.

If two candidates survive, that is an **error naming both**, not a coin flip:

```
branching-compact: both claude and codex have sessions for /path. Pass --agent (claude|codex).
```

Guessing wrong would mean writing one agent's format into the other's session store. Check what it
decided with `branching-compact detect`.

## Install

The skill folder is a standard Agent Skill, and the same folder works for both agents — there is no
duplicate Codex copy to keep in sync.

### Claude Code

```bash
git clone https://github.com/KamelMoohamed/branching-compact.git
mkdir -p ~/.claude/skills
cp -r branching-compact/skills/branching-compact ~/.claude/skills/
```

For one project only, copy it into that project's `.claude/skills/` instead. Claude Code watches its
skill directories and picks the skill up **in your current session, without a restart** — unless
`~/.claude/skills/` did not exist when the session started, in which case restart so it starts
watching the new directory.

Or via the Skills CLI:

```bash
npx skills add KamelMoohamed/branching-compact --agent claude-code --global
```

Or as a plugin — the repository doubles as its own single-plugin marketplace:

```
/plugin marketplace add KamelMoohamed/branching-compact
/plugin install branching-compact@branching-compact
```

Check the install summary: if it says `Run /reload-plugins to activate.`, run `/reload-plugins`.
Plugin skills are namespaced, so this path gives you **`/branching-compact:branching-compact`**; the
bare `/branching-compact` also works unless another command already uses that name.

### Codex

Codex reads skills from `~/.codex/skills/<name>/SKILL.md`:

```bash
git clone https://github.com/KamelMoohamed/branching-compact.git
mkdir -p ~/.codex/skills
cp -r branching-compact/skills/branching-compact ~/.codex/skills/
```

Use `$CODEX_HOME/skills` if you have set `CODEX_HOME`. For one project only, Codex also reads
`.codex/skills/` from the working directory. Ask Codex to "branch this session by topic", or invoke
the skill by name.

Uninstall either by deleting the directory you copied.

### Check it worked

Claude Code: run `/skills` and look for `branching-compact`. Either agent: confirm Node is new
enough and that detection resolves:

```bash
node --version && node skills/branching-compact/scripts/branching-compact.mjs detect
```

## Requirements

- **Node 18+** (the scripts use `crypto.randomUUID` and ESM; zero npm dependencies)
- **An existing session** to run against — the skill reads a session file that already exists on
  disk, so it does nothing useful in a brand-new session
- macOS, Linux, or WSL2

## Safety

The original session file is opened read-only and **never written to**. That is the whole safety
model: a branch that comes out wrong costs you nothing — delete the new file and resume the original.

On top of that:

- **Format validation before anything else.** The first record is checked against the chosen agent's
  format. An unknown format, or an `--agent` that contradicts the file, is an error with an
  explanation — never a silently empty analysis.
- **Ambiguous detection is refused**, so a branch cannot be written in the wrong agent's format.
- **Atomic writes.** Output goes to `<path>.<pid>.tmp` and is renamed into place. A crash leaves no
  half-written session.
- **The branch is checked before it is committed.** Tool output whose call was not kept, or a
  selection that would produce no human turn, aborts the write and removes the temporary file.
- **Whole turn ranges only.** A range is never subdivided, so a tool call and its result cannot be
  separated, and no assistant message is kept without the tool output it depended on.
- **No index or state file is modified.** Codex needs none (see below). The one exception is Claude
  Code desktop registration, which only ever *creates* a `local_<uuid>.json` and never edits one;
  delete the file it reports to undo it.

## Known limitations

- **Both formats are undocumented.** This depends on Claude Code's transcript format and Codex's
  rollout format, neither of which is a public API. Both were derived by reading real files, both can
  change in any release, and this is best-effort against that. Specifically:
  - Turn detection is a heuristic on the Claude side (filtering `isMeta`, `isSidechain`,
    `tool_result` and synthetic markers) and event-driven on the Codex side (matching the
    `user_message` / `item_completed(UserMessage)` events). New line kinds could slip through either.
    One known case: Claude Code's `<task-notification>` injections are not marked `isMeta` and are
    counted as turns.
  - Character count is a **token proxy**, not a token count. JSON punctuation, metadata and base64
    image payloads all count. The percentages are for relative weighting between turns, and that is
    all they claim to be.
- **Codex `turn_id` values are not rewritten.** They are thread-scoped and internally consistent
  within each kept range; regenerating them would risk breaking that agreement for no gain.
- **An old session id embedded in a path is left alone.** Codex sessions reference workspace roots
  under `~/.codex/visualizations/<date>/<session-id>`; those directories belong to the original
  session, so repointing them would name something that does not exist.
- **Claude Code desktop: the sidebar entry needs a restart.** The app reads its chat registry once at
  startup and reloads it only on an account or org change — there is no watcher and no timer. Use
  `claude --resume <id>`, which works in any terminal including the app's built-in one.
- **Encrypted reasoning is copied as-is.** Codex reasoning items carry `encrypted_content`. Kept
  turns keep theirs; how a given Codex version replays them is up to it. Resuming worked in every
  branch tested, but this is not something the tool can guarantee across versions.
- **Cloud and remote sessions are out of scope.** Only local session files are read.

## What was actually verified

Beyond the test suite, on a real install (codex-cli 0.149.0-alpha.4.1, Claude Code desktop):

- A real four-topic Codex session was created, analyzed (4 turns found, boundaries confirmed by hand
  against the raw rollout), and branched two different ways.
- Both branches were resumed with `codex exec resume <id>`. Each one recalled **exactly** the topics
  and shell commands from the turns that were kept, and none from the turns that were dropped.
- The Codex branch was written as a plain rollout file with no index or database update. It was
  discoverable and resumable on that basis alone — confirming `session_index.jsonl`, the desktop
  app's `local_thread_catalog`, and `thread_history_*.sqlite` are all derived from the rollout files,
  not prerequisites for them.
- On the Claude Code side, a real 48 MB / 2,039-line transcript was analyzed (9 turns) and branched:
  79.5% reduction, one `sessionId` throughout, zero dangling `parentUuid`, zero orphaned
  `tool_result`, original byte-identical afterwards.

Not verified: whether a Codex branch shows up in the **Codex desktop app's** thread list, which would
need an app restart to observe.

## Development

```bash
node test/run-tests.mjs
```

51 checks. The Claude Code half is the original suite unchanged — turn grouping, contiguous half-open
ranges, tool pairs never splitting across turns, char and percentage totals, filtered output contents
and ordering, `parentUuid` integrity, and that the original file is byte-identical afterwards.

Added for Codex: discovery by working directory, both rollout shapes (0.148's `user_message` and
0.149's `item_completed`), the fallback for rollouts with no message events at all, injected
user-role context never starting a turn, each turn keeping its own `turn_context`, tool call/output
grouping, `session_meta` and `thread_id` rewriting, ordinal renumbering, UUIDv7 shape and ordering,
rollout path naming in local time, and refusing to write a branch that would orphan tool output.

For the shared core, `test/fixtures/claude/equivalent-session.jsonl` and
`test/fixtures/codex/equivalent-session.jsonl` encode **the same logical conversation** in the two
native formats; the suite asserts they normalize to identical turns and feed identical ranges into
selection — which is what "the branching engine doesn't know which agent it's reading" means in
practice.

Fixtures are sanitized: their record shapes mirror real sessions, their content does not come from
one.

## License

MIT — see [LICENSE](LICENSE).
