#!/usr/bin/env node
// Exercises the shared branching engine and both agent adapters against the
// fixtures in test/fixtures/.
//   node test/run-tests.mjs

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..');
const scripts = path.join(repo, 'skills', 'branching-compact', 'scripts');

const { analyze } = await import(path.join(scripts, 'analyze-turns.mjs'));
const { buildFork } = await import(path.join(scripts, 'build-fork.mjs'));
const { analyzeSession } = await import(path.join(scripts, 'core', 'transcript.mjs'));
const { buildBranch } = await import(path.join(scripts, 'core', 'branching.mjs'));
const { selectRanges, parseTurnIds } = await import(path.join(scripts, 'core', 'selection.mjs'));
const { detectAgent, getAdapter } = await import(path.join(scripts, 'core', 'agents.mjs'));
const claude = (await import(path.join(scripts, 'adapters', 'claude.mjs'))).default;
const codexMod = await import(path.join(scripts, 'adapters', 'codex.mjs'));
const codex = codexMod.default;

const fx = (...p) => path.join(here, 'fixtures', ...p);
const fixture = fx('claude', 'fake-session.jsonl');
const codexFixture = fx('codex', 'fake-session.jsonl');
const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'branching-compact-test-'));

let passed = 0;
let failed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (err) {
    failed++;
    console.log(`FAIL  ${name}\n      ${err.message}`);
  }
}

const parseLines = (f) =>
  fs
    .readFileSync(f, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));

// Every turn owns a contiguous half-open range, together covering the file.
function assertContiguous(report) {
  assert.equal(report.preamble.start_line, 1);
  assert.equal(report.preamble.end_line, report.turns[0].start_line);
  for (let i = 0; i < report.turns.length - 1; i++) {
    assert.equal(report.turns[i].end_line, report.turns[i + 1].start_line);
    assert.ok(report.turns[i].end_line > report.turns[i].start_line);
  }
  assert.equal(report.turns.at(-1).end_line, report.total_lines + 1);
}

// ============================================================ Claude Code
console.log('claude / analyze-turns');
const report = await analyze(fixture);

await check('finds exactly the four genuine human turns', () => {
  assert.equal(report.turn_count, 4);
  assert.equal(report.turns.length, 4);
});

await check('turn snippets come from the human message text', () => {
  const s = report.turns.map((t) => t.snippet);
  assert.match(s[0], /^Explain the convergence proof/);
  assert.match(s[1], /^Now implement that estimator/);
  assert.match(s[2], /^The runtime is too slow/);
  assert.match(s[3], /^Draft the results section/);
});

await check('tool_result, isMeta, isSidechain and synthetic lines never start a turn', () => {
  const all = parseLines(fixture);
  for (const t of report.turns) {
    const entry = all[t.start_line - 1];
    assert.equal(entry.type, 'user');
    assert.ok(!entry.isMeta, 'turn start must not be isMeta');
    assert.ok(!entry.isSidechain, 'turn start must not be isSidechain');
    const c = entry.message.content;
    if (Array.isArray(c)) assert.ok(!c.some((b) => b.type === 'tool_result'));
    assert.notEqual(c, '[Request interrupted by user]');
  }
});

await check('ranges are contiguous, half-open and cover the whole file', () => {
  assertContiguous(report);
});

await check('tool_use and its tool_result land in the same turn', () => {
  const all = parseLines(fixture);
  const turnOf = (line) => report.turns.find((t) => line >= t.start_line && line < t.end_line);
  const useTurn = new Map();
  let pairs = 0;
  all.forEach((entry, i) => {
    const c = entry.message?.content;
    if (!Array.isArray(c)) return;
    for (const b of c) {
      if (b.type === 'tool_use') useTurn.set(b.id, turnOf(i + 1)?.turn_id);
      if (b.type === 'tool_result') {
        pairs++;
        assert.equal(turnOf(i + 1)?.turn_id, useTurn.get(b.tool_use_id), `pair ${b.tool_use_id} split`);
      }
    }
  });
  assert.equal(pairs, 3, 'fixture should contain three tool_use/tool_result pairs');
});

await check('char counts and percentages sum to the session total', () => {
  const sum = report.turns.reduce((a, t) => a + t.chars, 0) + report.preamble.chars;
  assert.equal(sum, report.total_chars);
  const pct = report.turns.reduce((a, t) => a + t.pct, 0);
  assert.ok(pct > 80 && pct <= 100, `turn percentages should be plausible, got ${pct}`);
});

await check('the report names the agent it came from', () => {
  assert.equal(report.agent, 'claude');
});

console.log('claude / build-fork');
const selected = [2, 3];
const newId = randomUUID();
const outPath = path.join(tmpdir, `${newId}.jsonl`);
const before = fs.readFileSync(fixture);
const result = await buildFork(fixture, report, selected, outPath);
const forked = parseLines(outPath);

await check('original transcript is byte-identical afterwards', () => {
  assert.deepEqual(fs.readFileSync(fixture), before);
});

await check('output is named by, and carries, the new session id', () => {
  assert.equal(result.new_session_id, newId);
  for (const e of forked) if (e.sessionId) assert.equal(e.sessionId, newId);
});

await check('fork holds the preamble plus exactly the selected turns', () => {
  const keptLines =
    report.preamble.end_line -
    report.preamble.start_line +
    selected.reduce((a, id) => {
      const t = report.turns.find((x) => x.turn_id === id);
      return a + (t.end_line - t.start_line);
    }, 0);
  assert.equal(result.kept_lines, keptLines);
  assert.equal(forked.length, keptLines);
});

await check('no line from an unselected turn survives', () => {
  const dropped = report.turns.filter((t) => !selected.includes(t.turn_id));
  const text = fs.readFileSync(outPath, 'utf8');
  for (const t of dropped) {
    const firstWords = t.snippet.split(' ').slice(0, 4).join(' ');
    assert.ok(!text.includes(firstWords), `dropped turn ${t.turn_id} leaked: ${firstWords}`);
  }
  for (const id of selected) {
    const t = report.turns.find((x) => x.turn_id === id);
    assert.ok(text.includes(t.snippet.split(' ').slice(0, 4).join(' ')), `turn ${id} missing`);
  }
});

await check('lines keep their original relative order', () => {
  const originals = parseLines(fixture).map((e) => e.uuid);
  const order = forked.map((e) => originals.indexOf(e.uuid)).filter((i) => i >= 0);
  assert.deepEqual(order, [...order].sort((a, b) => a - b));
});

await check('parentUuid chain has no dangling links', () => {
  const seen = new Set();
  for (const e of forked) {
    if (Object.prototype.hasOwnProperty.call(e, 'parentUuid') && e.parentUuid !== null) {
      assert.ok(seen.has(e.parentUuid), `dangling parentUuid ${e.parentUuid}`);
    }
    if (e.uuid) seen.add(e.uuid);
  }
});

await check('reduction percentage is reported and plausible', () => {
  assert.equal(result.original_lines, report.total_lines);
  assert.ok(result.reduction_pct > 0 && result.reduction_pct < 100, `got ${result.reduction_pct}`);
  assert.ok(result.kept_chars < result.original_chars);
  assert.equal(result.resume_command, `claude --resume ${newId}`);
});

await check('refuses to write over the original', async () => {
  await assert.rejects(() => buildFork(fixture, report, selected, fixture));
});

await check('rejects a turn id that does not exist', async () => {
  await assert.rejects(() => buildFork(fixture, report, [99], path.join(tmpdir, 'x.jsonl')));
});

await check('rejects a Codex rollout passed as a Claude transcript', async () => {
  await assert.rejects(() => analyzeSession(codexFixture, claude), /does not look like a Claude Code transcript/);
});

// ================================================================== Codex
console.log('codex / discovery');

// A throwaway CODEX_HOME laid out the way Codex lays out its own.
const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'branching-compact-codex-'));
const CODEX_ENV = { CODEX_HOME: codexHome };
const FIXTURE_CWD = '/tmp/branching-compact-fixture';
const rolloutDir = path.join(codexHome, 'sessions', '2026', '08', '28');
fs.mkdirSync(rolloutDir, { recursive: true });
const rolloutFile = path.join(
  rolloutDir,
  'rollout-2026-08-28T12-00-00-01a05000-0000-7000-8000-00000000f00d.jsonl'
);
fs.copyFileSync(codexFixture, rolloutFile);

await check('discovers the rollout for a working directory', async () => {
  const found = await codex.findLatestSession({ cwd: FIXTURE_CWD, env: CODEX_ENV });
  assert.equal(found, rolloutFile);
});

await check('refuses to guess when no rollout matches the working directory', async () => {
  await assert.rejects(
    () => codex.findLatestSession({ cwd: '/tmp/some-other-project', env: CODEX_ENV }),
    /no Codex rollout found/
  );
});

await check('reads the session id out of session_meta, not the filename', async () => {
  const r = await analyzeSession(rolloutFile, codex);
  assert.equal(r.session_id, '01a05000-0000-7000-8000-00000000f00d');
  assert.equal(r.agent, 'codex');
});

console.log('codex / parsing');
const codexReport = await analyzeSession(codexFixture, codex);
const codexLines = parseLines(codexFixture);

await check('finds exactly the four genuine human turns', () => {
  assert.equal(codexReport.turn_count, 4);
  const s = codexReport.turns.map((t) => t.snippet);
  assert.match(s[0], /^Refactor the auth middleware/);
  assert.match(s[1], /^Now write the database migration/);
  assert.match(s[2], /^The login button does nothing/);
  assert.match(s[3], /^Deploy is failing/);
});

await check('ranges are contiguous, half-open and cover the whole file', () => {
  assertContiguous(codexReport);
});

await check('injected user-role context never starts a turn', () => {
  const text = (e) =>
    (e.payload?.content ?? []).map((b) => b.text ?? '').join('');
  const injected = codexLines
    .map((e, i) => ({ e, line: i + 1 }))
    .filter(({ e }) => e.type === 'response_item' && e.payload?.role === 'user' && text(e).startsWith('<'));
  assert.ok(injected.length >= 2, 'fixture should contain injected user-role records');
  for (const { line } of injected) {
    assert.ok(
      !codexReport.turns.some((t) => t.start_line === line),
      `injected record on line ${line} started a turn`
    );
  }
});

await check('developer and assistant records never start a turn', () => {
  for (const t of codexReport.turns) {
    const e = codexLines[t.start_line - 1];
    const role = e.payload?.role;
    assert.notEqual(role, 'developer', `turn ${t.turn_id} starts at a developer record`);
    assert.notEqual(role, 'assistant', `turn ${t.turn_id} starts at an assistant record`);
  }
  // The first turn starts at the prompt itself, so the base instructions ahead
  // of it stay in the always-kept preamble.
  const first = codexLines[codexReport.turns[0].start_line - 1];
  assert.equal(first.type, 'response_item');
  assert.equal(first.payload.role, 'user');
});

await check('each turn after the first starts at its own task_started', () => {
  for (const t of codexReport.turns.slice(1)) {
    const e = codexLines[t.start_line - 1];
    assert.equal(e.payload.type, 'task_started', `turn ${t.turn_id} does not start at task_started`);
  }
  // …so the turn_context that configures the turn travels with it.
  for (const t of codexReport.turns.slice(1)) {
    const range = codexLines.slice(t.start_line - 1, t.end_line - 1);
    assert.ok(range.some((e) => e.type === 'turn_context'), `turn ${t.turn_id} lost its turn_context`);
  }
});

await check('the session header and standing instructions stay in the preamble', () => {
  const pre = codexLines.slice(0, codexReport.preamble.end_line - 1);
  assert.equal(pre[0].type, 'session_meta');
  assert.ok(pre.some((e) => e.payload?.role === 'developer'), 'developer instructions left the preamble');
});

await check('a tool call and its output land in the same turn', () => {
  const turnOf = (line) => codexReport.turns.find((t) => line >= t.start_line && line < t.end_line);
  let pairs = 0;
  const callTurn = new Map();
  codexLines.forEach((e, i) => {
    const p = e.payload;
    if (p?.type === 'custom_tool_call') callTurn.set(p.call_id, turnOf(i + 1)?.turn_id);
    if (p?.type === 'custom_tool_call_output') {
      pairs++;
      assert.equal(turnOf(i + 1)?.turn_id, callTurn.get(p.call_id), `pair ${p.call_id} split`);
    }
  });
  assert.equal(pairs, 4, 'fixture should contain four tool call/output pairs');
});

await check('char counts sum to the session total', () => {
  const sum = codexReport.turns.reduce((a, t) => a + t.chars, 0) + codexReport.preamble.chars;
  assert.equal(sum, codexReport.total_chars);
});

console.log('codex / format variants');

await check('parses the 0.148 rollout shape, whose event is user_message', async () => {
  const r = await analyzeSession(fx('codex', 'legacy-session.jsonl'), codex);
  assert.equal(r.turn_count, 2);
  assert.match(r.turns[0].snippet, /^Refactor the auth middleware/);
  assertContiguous(r);
});

await check('falls back to shape when a rollout has no message events', async () => {
  const r = await analyzeSession(fx('codex', 'no-user-events.jsonl'), codex);
  assert.equal(r.turn_count, 2);
  assert.match(r.turns[0].snippet, /^Refactor the auth middleware/);
  assert.ok(!r.turns.some((t) => t.snippet.startsWith('<')), 'fallback let an injected wrapper through');
});

await check('refuses an unknown format instead of producing an empty analysis', async () => {
  await assert.rejects(
    () => analyzeSession(fx('codex', 'unknown-format.jsonl'), codex),
    /does not look like a Codex rollout/
  );
});

await check('refuses a Claude transcript passed as a Codex rollout', async () => {
  await assert.rejects(() => analyzeSession(fixture, codex), /does not look like a Codex rollout/);
});

console.log('codex / id generation');

await check('mints UUIDv7 ids, so branches look like sessions Codex wrote', () => {
  const id = codex.newSessionId(new Date('2026-08-28T12:00:00Z'));
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  const later = codex.newSessionId(new Date('2026-08-28T13:00:00Z'));
  assert.ok(later > id, 'v7 ids must sort by time');
  assert.notEqual(codex.newSessionId(), codex.newSessionId());
});

await check('branch path is a rollout in the right day bucket, in local time', () => {
  const now = new Date(2026, 7, 28, 21, 14, 58);
  const id = '01a04814-8286-7a40-bbcb-dd43aceb191f';
  const p = codex.branchPathFor({ newSessionId: id, env: CODEX_ENV, now });
  assert.equal(
    p,
    path.join(codexHome, 'sessions', '2026', '08', '28', `rollout-2026-08-28T21-14-58-${id}.jsonl`)
  );
  assert.equal(codex.sessionIdFromPath(p), id);
});

console.log('codex / branch reconstruction');
const codexKeep = [1, 4];
const codexBefore = fs.readFileSync(codexFixture);
const codexOut = path.join(tmpdir, 'rollout-2026-08-28T21-14-58-01a04814-8286-7a40-bbcb-dd43aceb191f.jsonl');
const codexResult = await buildBranch({
  originalPath: codexFixture,
  report: codexReport,
  ids: codexKeep,
  outputPath: codexOut,
  adapter: codex,
});
const branched = parseLines(codexOut);

await check('original rollout is byte-identical afterwards', () => {
  assert.deepEqual(fs.readFileSync(codexFixture), codexBefore);
});

await check('session_meta carries the new id and nothing else claims the old one', () => {
  const meta = branched[0];
  assert.equal(meta.type, 'session_meta');
  assert.equal(meta.payload.session_id, codexResult.new_session_id);
  assert.equal(meta.payload.id, codexResult.new_session_id);
  assert.ok(!fs.readFileSync(codexOut, 'utf8').includes(codexReport.session_id));
});

await check('branch holds the preamble plus exactly the selected turns', () => {
  const expected =
    codexReport.preamble.end_line -
    codexReport.preamble.start_line +
    codexKeep.reduce((a, id) => {
      const t = codexReport.turns.find((x) => x.turn_id === id);
      return a + (t.end_line - t.start_line);
    }, 0);
  assert.equal(codexResult.kept_lines, expected);
  assert.equal(branched.length, expected);
  const text = fs.readFileSync(codexOut, 'utf8');
  assert.ok(text.includes('Refactor the auth middleware'));
  assert.ok(text.includes('Deploy is failing'));
  assert.ok(!text.includes('database migration'), 'dropped turn 2 leaked');
  assert.ok(!text.includes('login button'), 'dropped turn 3 leaked');
});

await check('the branch has no orphan tool output', () => {
  const calls = new Set();
  for (const e of branched) {
    const p = e.payload;
    if (p?.type === 'custom_tool_call') calls.add(p.call_id);
    if (p?.type === 'custom_tool_call_output') {
      assert.ok(calls.has(p.call_id), `orphan tool output ${p.call_id}`);
    }
  }
});

await check('record ordinals are renumbered contiguously from zero', () => {
  branched.forEach((e, i) => assert.equal(e.ordinal, i, `ordinal gap at record ${i}`));
});

await check('turn ids stay consistent between task_started and its records', () => {
  const started = new Set();
  for (const e of branched) {
    const p = e.payload ?? {};
    if (p.type === 'task_started') started.add(p.turn_id);
    const tid = p.turn_id ?? p.internal_chat_message_metadata_passthrough?.turn_id;
    if (tid && p.type !== 'task_started') {
      assert.ok(started.has(tid), `record references turn ${tid} with no task_started`);
    }
  }
});

await check('reports the reduction and the Codex resume command', () => {
  assert.equal(codexResult.agent, 'codex');
  assert.ok(codexResult.reduction_pct > 0 && codexResult.reduction_pct < 100);
  assert.equal(codexResult.resume_command, `codex resume ${codexResult.new_session_id}`);
});

await check('refuses to write over the original rollout', async () => {
  await assert.rejects(
    () => buildBranch({ originalPath: codexFixture, report: codexReport, ids: [1], outputPath: codexFixture, adapter: codex }),
    /refusing to write over the original/
  );
});

await check('refuses to write a branch that would orphan a tool output', async () => {
  // A hand-damaged report whose range starts after the tool call but keeps its
  // output — the shape the engine exists to prevent.
  const callLine = codexLines.findIndex((e) => e.payload?.type === 'custom_tool_call') + 1;
  const damaged = {
    ...codexReport,
    turns: [{ ...codexReport.turns[0], start_line: callLine + 1 }, ...codexReport.turns.slice(1)],
  };
  const target = path.join(tmpdir, 'orphan.jsonl');
  await assert.rejects(
    () => buildBranch({ originalPath: codexFixture, report: damaged, ids: [1], outputPath: target, adapter: codex }),
    /branch would be malformed/
  );
  assert.ok(!fs.existsSync(target), 'a rejected branch must not be left on disk');
  assert.equal(fs.readdirSync(tmpdir).filter((f) => f.includes('.tmp')).length, 0, 'temp file left behind');
});

// ============================================================ shared core
console.log('shared core / agent-independence');

const claudeEq = await analyzeSession(fx('claude', 'equivalent-session.jsonl'), claude);
const codexEq = await analyzeSession(fx('codex', 'equivalent-session.jsonl'), codex);

await check('the same conversation normalizes to the same turns under both agents', () => {
  assert.equal(claudeEq.turn_count, codexEq.turn_count);
  assert.deepEqual(
    claudeEq.turns.map((t) => t.snippet),
    codexEq.turns.map((t) => t.snippet)
  );
  assert.deepEqual(
    claudeEq.turns.map((t) => t.turn_id),
    codexEq.turns.map((t) => t.turn_id)
  );
});

await check('both feed selection the same ranges, so clustering sees the same input', () => {
  const a = selectRanges(claudeEq, [1, 3]);
  const b = selectRanges(codexEq, [1, 3]);
  assert.equal(a.length, b.length);
  assert.deepEqual(
    a.map((r) => (r.turn ? r.turn.turn_id : 'preamble')),
    b.map((r) => (r.turn ? r.turn.turn_id : 'preamble'))
  );
});

await check('branching either one keeps the same human prompts', async () => {
  const prompts = (text) =>
    ['Refactor the auth middleware', 'database migration', 'login button'].filter((p) => text.includes(p));
  const aOut = path.join(tmpdir, `${randomUUID()}.jsonl`);
  const bOut = path.join(tmpdir, 'rollout-2026-08-28T00-00-00-01a05000-1111-7000-8000-000000000001.jsonl');
  await buildBranch({ originalPath: fx('claude', 'equivalent-session.jsonl'), report: claudeEq, ids: [1, 3], outputPath: aOut, adapter: claude });
  await buildBranch({ originalPath: fx('codex', 'equivalent-session.jsonl'), report: codexEq, ids: [1, 3], outputPath: bOut, adapter: codex });
  assert.deepEqual(prompts(fs.readFileSync(aOut, 'utf8')), prompts(fs.readFileSync(bOut, 'utf8')));
  assert.deepEqual(prompts(fs.readFileSync(aOut, 'utf8')), ['Refactor the auth middleware', 'login button']);
});

await check('selection parses turn id lists the same way for every agent', () => {
  assert.deepEqual(parseTurnIds('3,1,1,2'), [1, 2, 3]);
  assert.throws(() => parseTurnIds('1,x'), /not an integer/);
  assert.throws(() => parseTurnIds(''), /no turn ids/);
});

console.log('shared core / agent detection');

await check('an explicit agent wins, and aliases resolve', async () => {
  assert.equal((await detectAgent({ agent: 'codex' })).adapter.id, 'codex');
  assert.equal(getAdapter('claude-code').id, 'claude');
  assert.equal(getAdapter('openai-codex').id, 'codex');
  assert.throws(() => getAdapter('cursor'), /unknown agent/);
});

await check('the environment identifies the agent running us', async () => {
  const a = await detectAgent({ env: { CODEX_THREAD_ID: 'abc' } });
  assert.equal(a.adapter.id, 'codex');
  assert.equal(a.reason, 'environment');
  const b = await detectAgent({ env: { CLAUDECODE: '1' } });
  assert.equal(b.adapter.id, 'claude');
});

await check('a named session file identifies itself by its own format', async () => {
  const a = await detectAgent({ file: codexFixture, env: {} });
  assert.equal(a.adapter.id, 'codex');
  assert.equal(a.reason, 'file-format');
  const b = await detectAgent({ file: fixture, env: {} });
  assert.equal(b.adapter.id, 'claude');
});

await check('a named file outranks the agent that happens to be running us', async () => {
  // Branching a Codex session from inside Claude Code is ordinary; the
  // environment says who is running, not who wrote the file.
  const a = await detectAgent({ file: codexFixture, env: { CLAUDE_CODE_ENTRYPOINT: 'cli' } });
  assert.equal(a.adapter.id, 'codex');
  const b = await detectAgent({ file: fixture, env: { CODEX_THREAD_ID: 'abc' } });
  assert.equal(b.adapter.id, 'claude');
});

await check('ambiguity is an error, never a guess', async () => {
  await assert.rejects(
    () => detectAgent({ env: { CODEX_THREAD_ID: 'a', CLAUDECODE: '1' } }),
    /more than one agent/
  );
  await assert.rejects(
    () => detectAgent({ file: fx('codex', 'unknown-format.jsonl'), env: {} }),
    /cannot tell which agent/
  );
});

fs.rmSync(tmpdir, { recursive: true, force: true });
fs.rmSync(codexHome, { recursive: true, force: true });

console.log(`\n${passed} checks passed${failed ? `, ${failed} FAILED` : ''}`);
process.exit(failed ? 1 : 0);
