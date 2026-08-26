#!/usr/bin/env node
// Exercises analyze-turns.mjs and build-fork.mjs against test/fake-session.jsonl.
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

const fixture = path.join(here, 'fake-session.jsonl');
const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'branching-compact-test-'));

let passed = 0;
async function check(name, fn) {
  await fn();
  passed++;
  console.log(`  ok  ${name}`);
}

const parseLines = (f) =>
  fs
    .readFileSync(f, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));

console.log('analyze-turns');
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
  assert.equal(report.preamble.start_line, 1);
  assert.equal(report.preamble.end_line, report.turns[0].start_line);
  for (let i = 0; i < report.turns.length - 1; i++) {
    assert.equal(report.turns[i].end_line, report.turns[i + 1].start_line);
    assert.ok(report.turns[i].end_line > report.turns[i].start_line);
  }
  assert.equal(report.turns.at(-1).end_line, report.total_lines + 1);
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

console.log('build-fork');
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

fs.rmSync(tmpdir, { recursive: true, force: true });
console.log(`\n${passed} checks passed`);
