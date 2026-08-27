# branching-compact

A Claude Code skill that **forks** a long session instead of summarizing it.

`/compact` squashes your whole session into a summary and throws the detail away. But long sessions
usually aren't one thing — they're four. You did some theory, then wrote code, then chased a
deployment bug, then started drafting a report. When you only want to keep going on the deployment
bug, summarizing all four is the wrong move.

`branching-compact` splits the session into topical threads, shows you what share of the context each
one is eating, lets you pick the ones worth keeping, and writes those turns **verbatim** into a new
session you can resume. The original session file is opened read-only and never modified.

## How it works

1. Finds the current session's JSONL transcript under `~/.claude/projects/`.
2. Runs `analyze-turns.mjs`, which streams the transcript and emits compact per-turn summaries —
   line range, character count, percentage of the session, and a short snippet. **The raw transcript
   never enters the model's context**; that would defeat the point.
3. Claude clusters those turn snippets into topical threads by content — no fixed category list, no
   fixed count.
4. You get a multi-select question listing each thread with its share of the context.
5. `build-fork.mjs` writes a new session file containing only the selected turns, in original order,
   plus the session preamble. Turn line ranges are copied whole, so a tool call is never separated
   from its result.
6. In the **desktop app**, `register-desktop-session.mjs` adds the registry entry that makes the fork
   visible as a chat in your sidebar; in a **terminal** that step is skipped as unnecessary.
7. You get the reduction percentage and a `claude --resume <id>` command.

A turn starts at a *genuine* human message. That distinction matters more than it sounds: in Claude
Code's transcript format, tool results also arrive as `role: "user"` messages, as do injected context
and subagent traffic. Naively splitting on user-role lines shatters a session into hundreds of broken
fragments. See
[references/transcript-format.md](skills/branching-compact/references/transcript-format.md).

## Example run

```
> /branching-compact

Analyzing session 15e357f3-9cb1-4ec6-a94b-6c75489b3ebf — 1,265 lines, 18 turns.
```

Claude then asks:

> **Which threads do you want to keep?** *(select all that apply)*
>
> - **Deployment debugging (42%)** — turns 10, 15: switching off the local backend to the deployed
>   API, chasing the caching issue
> - **Mobile app rebuild (28%)** — turns 11, 16, 18: stale build, missing features, rebuilding
> - **Ayah content seeding (15%)** — turns 2, 3, 6–8, 13: seed files, playlist metadata, multi-ayah
>   fetches
> - **UI fixes and commits (9%)** — turns 12, 14, 17: menstrual-mode label, group goals, commit/push

Pick one or more, and you get:

```
Forked 2 of 18 turns → 57.6% smaller (174 of 1,265 lines).

  New session: cf63ebe7-fe9c-44a2-82f9-4c12119c8b5c
  File:        ~/.claude/projects/-Users-me-app/cf63ebe7-….jsonl

  claude --resume cf63ebe7-fe9c-44a2-82f9-4c12119c8b5c

The original session is untouched and still has the full history.
```

In a terminal, that command is the way in. In the desktop app the skill also registers the fork as a
chat — but **the app must be restarted before it appears**, and it lands ungrouped rather than inside
the parent chat's sidebar group. Until then, `claude --resume` still opens it.

## Requirements

- **Node 18+** (the scripts use `crypto.randomUUID` and ESM; zero npm dependencies)
- **An existing Claude Code session** to run against — the skill reads a transcript that already
  exists on disk, so it does nothing useful in a brand-new session
- macOS, Linux, or WSL2

## Install

Pick one of the three. Paths 1 and 2 give you `/branching-compact`; the plugin path namespaces it as
`/branching-compact:branching-compact` (bare `/branching-compact` works too, unless another command
already claims that name).

### 1. Manual copy

```bash
git clone https://github.com/KamelMoohamed/claude-branching-compact.git
mkdir -p ~/.claude/skills
cp -r claude-branching-compact/skills/branching-compact ~/.claude/skills/
```

For one project only, copy it into that project's `.claude/skills/` instead:

```bash
mkdir -p .claude/skills && cp -r claude-branching-compact/skills/branching-compact .claude/skills/
```

Claude Code watches its skill directories and picks the skill up **in your current session, without a
restart**. The one exception: if `~/.claude/skills/` (or `.claude/skills/`) did not exist when the
session started — that is, `mkdir -p` above just created it — restart Claude Code so it starts
watching the new directory.

Uninstall by deleting the directory you copied.

### 2. Skills CLI

Browse what the repo contains first, if you like:

```bash
npx skills add KamelMoohamed/claude-branching-compact --list
```

Install it for Claude Code across all your projects:

```bash
npx skills add KamelMoohamed/claude-branching-compact --agent claude-code --global
```

Drop `--global` to install into the current project instead. This copies the skill into
`~/.claude/skills/branching-compact`, so it keeps working if you delete the checkout. Remove it with
`npx skills remove branching-compact --global`.

### 3. Claude Code plugin marketplace

```
/plugin marketplace add KamelMoohamed/claude-branching-compact
```

```
/plugin install branching-compact@claude-branching-compact
```

Check the install summary: if it says `Run /reload-plugins to activate.`, run `/reload-plugins`. If it
says `Plugin is now active.`, you are already done.

Plugin skills are namespaced, so this path gives you **`/branching-compact:branching-compact`**. The
bare `/branching-compact` also works unless another command already uses that name.

The repository doubles as its own single-plugin marketplace:
[`.claude-plugin/marketplace.json`](.claude-plugin/marketplace.json) declares the marketplace
`claude-branching-compact` and points at the plugin at the repo root, whose
[`.claude-plugin/plugin.json`](.claude-plugin/plugin.json) lets Claude Code auto-discover
`skills/branching-compact/SKILL.md`.

Uninstall with `/plugin uninstall branching-compact@claude-branching-compact`.

### Check it worked

Run `/skills` and look for `branching-compact`, or type `/branching-compact` (or
`/branching-compact:branching-compact` on the plugin path). If the skill is installed but the scripts
fail, confirm Node is new enough:

```bash
node --version
```

## Usage

Inside any Claude Code session with some history:

```
/branching-compact
```

You can also run the scripts directly:

```bash
node skills/branching-compact/scripts/analyze-turns.mjs --latest > /tmp/turns.json
```

```bash
node skills/branching-compact/scripts/build-fork.mjs <original.jsonl> /tmp/turns.json 2,3,7 <new-uuid>.jsonl
```

Full flags and output shapes: [references/scripts.md](skills/branching-compact/references/scripts.md).

## Caveats

**This depends on Claude Code's on-disk transcript format, which is not a documented public API.**
It was derived by reading real transcripts. Claude Code can change it in any release, and this skill
is best-effort against that. Specifically:

- Turn detection is a heuristic. It filters `isMeta` injections, `isSidechain` subagent traffic,
  `tool_result` messages and synthetic markers like `[Request interrupted by user]`. New line kinds
  could slip through.
- Character count is a **token proxy**, not a token count. JSON punctuation, metadata and base64
  image payloads all count toward it. The percentages are for relative weighting between turns, and
  that is all they claim to be.
- Forking rewrites `sessionId` on copied lines and re-anchors `parentUuid` links across dropped turns
  so the new session stays one walkable thread. How a given Claude Code version renders that fork is
  up to it.
- Desktop registration reaches further still, into the app's own undocumented state directory. It is
  additive — it only ever creates a `local_<uuid>.json`, never edits one — and the skill falls back to
  the resume command wherever that registry isn't found. Delete the file it reports to undo it.

**Treat your original session as the safety net** — which this workflow guarantees. The original is
opened read-only and never written to, so a fork that comes out wrong costs you nothing: delete the
new `.jsonl` and resume the original.

## Development

```bash
node test/run-tests.mjs
```

15 checks run both scripts against [`test/fake-session.jsonl`](test/fake-session.jsonl), a synthetic
four-topic transcript with tool_use/tool_result pairs, an `isMeta` injection, sidechain lines and an
interrupt marker. They verify turn grouping, contiguous half-open ranges, tool pairs never splitting
across turns, char and percentage totals, filtered output contents and ordering, `parentUuid`
integrity, and that the original file is byte-identical afterwards.

## License

MIT — see [LICENSE](LICENSE).

Repository layout follows the convention used by
[amElnagdy/delegate-skills](https://github.com/amElnagdy/delegate-skills).
