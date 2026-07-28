#!/usr/bin/env node
'use strict';

// Test suite for bin/huuk.js. Pipes fake Claude Code hook events into the
// engine and asserts on exit codes and output. Run: node test/run-tests.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ENGINE = path.join(__dirname, '..', 'bin', 'huuk.js');

let passed = 0;
const failures = [];

function makeProject(rules) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huuk-test-'));
  fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
  if (rules !== null) {
    const body = typeof rules === 'string' ? rules : JSON.stringify({ rules });
    fs.writeFileSync(path.join(dir, '.claude', 'huuk.rules.json'), body);
  }
  return dir;
}

// Isolated fake HOME so the developer's real global rules can't leak in.
function makeHome(rules) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'huuk-home-'));
  if (rules) {
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(home, '.claude', 'huuk.rules.json'), JSON.stringify({ rules }));
  }
  return home;
}

function trust(proj, home) {
  const r = spawnSync('node', [ENGINE, '--trust'], {
    cwd: proj, encoding: 'utf8', env: { ...process.env, HOME: home },
  });
  if (r.status !== 0) throw new Error('trust failed: ' + r.stderr);
}

// Project + isolated home, with the project rules file pre-trusted.
function trustedSetup(rules) {
  const proj = makeProject(rules);
  const home = makeHome();
  trust(proj, home);
  return { proj, home };
}

function runHook(event, { home, env = {}, args = [], cwd } = {}) {
  return spawnSync('node', [ENGINE, ...args], {
    input: event === null ? '' : JSON.stringify(event),
    encoding: 'utf8',
    cwd: cwd || process.cwd(),
    env: { ...process.env, HOME: home || makeHome(), HUUK_DISABLE: '', ...env },
  });
}

function check(name, cond, detail) {
  if (cond) {
    passed++;
  } else {
    failures.push(`✗ ${name}${detail ? ' — ' + detail : ''}`);
  }
}

function pre(cwd, tool, toolInput) {
  return { hook_event_name: 'PreToolUse', cwd, tool_name: tool, tool_input: toolInput };
}
function post(cwd, tool, toolInput, isError = false) {
  return { hook_event_name: 'PostToolUse', cwd, tool_name: tool, tool_input: toolInput, tool_result_is_error: isError };
}
function denied(r) {
  try {
    return JSON.parse(r.stdout).hookSpecificOutput.permissionDecision === 'deny';
  } catch {
    return false;
  }
}

// ==========================================================================
// Core behavior
// ==========================================================================

// --- failing check blocks git push (deny JSON) ----------------------------
{
  const { proj, home } = trustedSetup([
    { id: 'gate', description: 'tests must pass', on: 'bash:git push*', do: [{ run: 'echo boom >&2; exit 1' }] },
  ]);
  const r = runHook(pre(proj, 'Bash', { command: 'git push origin main' }), { home });
  check('block on failing check: exit 0', r.status === 0, `status=${r.status} stderr=${r.stderr}`);
  check('block on failing check: deny', denied(r), r.stdout);
  const out = JSON.parse(r.stdout || '{}');
  check('block reason includes tool output', /boom/.test(out.hookSpecificOutput?.permissionDecisionReason || ''));
}

// --- passing check allows push (silent) -----------------------------------
{
  const { proj, home } = trustedSetup([
    { id: 'gate', on: 'bash:git push*', do: [{ run: 'exit 0' }] },
  ]);
  const r = runHook(pre(proj, 'Bash', { command: 'git push' }), { home });
  check('allow on passing check: exit 0 and silent', r.status === 0 && r.stdout.trim() === '', r.stdout || r.stderr);
}

// --- unrelated command untouched ------------------------------------------
{
  const proj = makeProject([{ id: 'gate', on: 'bash:git push*', do: [{ forbid: 'nope' }] }]);
  const r = runHook(pre(proj, 'Bash', { command: 'git status' }));
  check('unrelated command: silent allow', r.status === 0 && r.stdout.trim() === '', r.stdout);
}

// --- exact (no-wildcard) pattern does not match superstrings --------------
{
  const proj = makeProject([{ id: 'init', on: 'bash:git init', do: [{ steer: 'ask branch name' }] }]);
  const blocked = runHook(pre(proj, 'Bash', { command: 'git init' }));
  const allowed = runHook(pre(proj, 'Bash', { command: 'git init -b main' }));
  check('exact pattern blocks bare command', denied(blocked), blocked.stdout);
  check('exact pattern allows retried command', allowed.stdout.trim() === '', allowed.stdout);
}

// --- protect file edits ---------------------------------------------------
{
  const proj = makeProject([{ id: 'env', on: 'edit:.env*', do: [{ steer: 'hands off' }] }]);
  const r = runHook(pre(proj, 'Write', { file_path: path.join(proj, 'api', '.env.local'), content: 'X=1' }));
  check('edit glob matches basename anywhere', denied(r), r.stdout);
  const other = runHook(pre(proj, 'Write', { file_path: path.join(proj, 'src', 'main.py') }));
  check('edit glob leaves other files alone', other.stdout.trim() === '', other.stdout);
}

// --- path glob with "/" is path-anchored ----------------------------------
{
  const proj = makeProject([{ id: 'cfg', on: 'edit:config/**/*.yml', do: [{ forbid: 'no' }] }]);
  const hit = runHook(pre(proj, 'Edit', { file_path: path.join(proj, 'config', 'a', 'b.yml') }));
  const miss = runHook(pre(proj, 'Edit', { file_path: path.join(proj, 'other', 'b.yml') }));
  check('path glob matches nested file', denied(hit), hit.stdout);
  check('path glob ignores files outside the path', miss.stdout.trim() === '', miss.stdout);
}

// ==========================================================================
// Severity semantics
// ==========================================================================

// --- warn allows, surfaces a message, and NEVER emits a decision ----------
{
  const { proj, home } = trustedSetup([
    { id: 'soft', on: 'bash:git push*', severity: 'warn', do: [{ run: 'exit 1' }] },
  ]);
  const r = runHook(pre(proj, 'Bash', { command: 'git push' }), { home });
  const out = JSON.parse(r.stdout || '{}');
  check('warn: no permission decision (no auto-approve)', out.hookSpecificOutput === undefined, r.stdout);
  check('warn: systemMessage present', typeof out.systemMessage === 'string' && out.systemMessage.includes('soft'), r.stdout);
}

// --- severity is case-insensitive; unknown severity means block -----------
{
  const proj = makeProject([
    { id: 'a', on: 'bash:git push*', severity: 'WARN', do: [{ forbid: 'w' }] },
  ]);
  const r = runHook(pre(proj, 'Bash', { command: 'git push' }));
  const out = JSON.parse(r.stdout || '{}');
  check('severity WARN treated as warn', out.hookSpecificOutput === undefined && /w/.test(out.systemMessage || ''), r.stdout);
}

// --- mixed block + warn: deny wins, warn text included --------------------
{
  const proj = makeProject([
    { id: 'hard', on: 'bash:git push*', do: [{ forbid: 'hard-no' }] },
    { id: 'soft', on: 'bash:git push*', severity: 'warn', do: [{ forbid: 'soft-note' }] },
  ]);
  const r = runHook(pre(proj, 'Bash', { command: 'git push' }));
  const out = JSON.parse(r.stdout || '{}');
  const reason = out.hookSpecificOutput?.permissionDecisionReason || '';
  check('mixed severities: deny with both messages', denied(r) && /hard-no/.test(reason) && /soft-note/.test(reason), r.stdout);
}

// ==========================================================================
// Evasion resistance (bash matching)
// ==========================================================================

{
  const proj = makeProject([{ id: 'gate', on: 'bash:git push*', do: [{ forbid: 'nope' }] }]);
  const cases = [
    ['chained &&', 'cd /tmp && git push origin main'],
    ['chained ;', 'echo hi; git push'],
    ['piped', 'git push 2>&1 | tee log.txt'],
    ['backgrounded &', 'git push &'],
    ['double space', 'git  push   origin main'],
    ['env-var prefix', 'GIT_TRACE=1 git push'],
    ['sudo wrapper', 'sudo git push'],
    ['env wrapper with flag+arg', 'env -u SOME_VAR git push'],
    ['command wrapper', 'command git push'],
    ['nested wrappers', 'sudo env FOO=1 git push origin main'],
    ['sh -c payload', 'sh -c "git push origin main"'],
    ['bash -lc payload single-quoted', "bash -lc 'git push'"],
    ['sh -c chained payload', 'sh -c "echo hi && git push"'],
  ];
  for (const [name, cmd] of cases) {
    const r = runHook(pre(proj, 'Bash', { command: cmd }));
    check(`evasion: ${name} is caught`, denied(r), `cmd=${cmd} out=${r.stdout}`);
  }
  // Non-evasions that must NOT trigger the gate:
  const benign = [
    ['commit message mentioning push', 'git commit -m "docs: explain git push flow"'],
    ['grep for the pattern', 'grep -r "git pushover" src/'],
    ['pushd builtin', 'pushd /tmp'],
  ];
  for (const [name, cmd] of benign) {
    const r = runHook(pre(proj, 'Bash', { command: cmd }));
    check(`no false positive: ${name}`, r.stdout.trim() === '', `cmd=${cmd} out=${r.stdout}`);
  }
}

// ==========================================================================
// Injection resistance
// ==========================================================================

// --- hostile filename cannot inject commands via {file} -------------------
{
  const { proj, home } = trustedSetup([
    { id: 'fmt', on: 'edited:*.py', do: [{ run: 'touch {file}.marker' }] },
  ]);
  const evil = path.join(proj, 'a$(touch pwned)`touch pwned2`.py');
  fs.writeFileSync(evil, '');
  const r = runHook(post(proj, 'Edit', { file_path: evil }), { home });
  check('hostile filename: no command injection', !fs.existsSync(path.join(proj, 'pwned')) && !fs.existsSync(path.join(proj, 'pwned2')), 'pwned file was created!');
  check('hostile filename: action still ran on literal name', fs.existsSync(evil + '.marker'), r.stderr);
}

// --- filenames with spaces, quotes, unicode, $& sequences -----------------
{
  const { proj, home } = trustedSetup([
    { id: 'fmt', on: 'edited:*.py', do: [{ run: 'touch {file}.marker' }] },
  ]);
  for (const name of ["my file.py", "it's.py", 'caña$&.py']) {
    const f = path.join(proj, name);
    fs.writeFileSync(f, '');
    runHook(post(proj, 'Edit', { file_path: f }), { home });
    check(`odd filename handled: ${name}`, fs.existsSync(f + '.marker'));
  }
}

// ==========================================================================
// Trust model
// ==========================================================================

// --- untrusted project run actions fail closed ----------------------------
{
  const proj = makeProject([
    { id: 'gate', on: 'bash:git push*', do: [{ run: 'echo executed > ran.txt' }] },
  ]);
  const home = makeHome(); // never trusted
  const r = runHook(pre(proj, 'Bash', { command: 'git push' }), { home });
  const out = JSON.parse(r.stdout || '{}');
  check('untrusted: push blocked (fail closed)', denied(r), r.stdout);
  check('untrusted: command did NOT execute', !fs.existsSync(path.join(proj, 'ran.txt')));
  check('untrusted: reason explains how to trust', /--trust/.test(out.hookSpecificOutput?.permissionDecisionReason || ''), r.stdout);
}

// --- trusting enables execution; editing the file revokes trust -----------
{
  const proj = makeProject([
    { id: 'gate', on: 'bash:git push*', do: [{ run: 'exit 0' }] },
  ]);
  const home = makeHome();
  trust(proj, home);
  const ok = runHook(pre(proj, 'Bash', { command: 'git push' }), { home });
  check('trusted: run executes, push allowed', ok.status === 0 && ok.stdout.trim() === '', ok.stdout);
  // tamper with the rules file after trusting
  const rf = path.join(proj, '.claude', 'huuk.rules.json');
  fs.writeFileSync(rf, JSON.stringify({ rules: [{ id: 'gate', on: 'bash:git push*', do: [{ run: 'echo owned > owned.txt' }] }] }));
  const r2 = runHook(pre(proj, 'Bash', { command: 'git push' }), { home });
  check('tampered file: trust revoked, fail closed', denied(r2), r2.stdout);
  check('tampered file: new command did NOT execute', !fs.existsSync(path.join(proj, 'owned.txt')));
}

// --- trust survives a symlinked cwd (macOS: /var -> /private/var) ---------
{
  const real = fs.mkdtempSync(path.join(os.tmpdir(), 'huuk-real-'));
  const link = real + '-link';
  fs.symlinkSync(real, link);
  fs.mkdirSync(path.join(real, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(real, '.claude', 'huuk.rules.json'),
    JSON.stringify({ rules: [{ id: 'gate', on: 'bash:git push*', do: [{ run: 'exit 0' }] }] }));
  const home = makeHome();
  trust(link, home); // trusting via the symlinked path records the real path
  const r = runHook(pre(link, 'Bash', { command: 'git push' }), { home }); // hook sees the symlinked path
  check('trust: symlinked cwd still trusted', r.status === 0 && r.stdout.trim() === '', r.stdout);
}

// --- non-exec actions work without trust ----------------------------------
{
  const proj = makeProject([
    { id: 'readme', on: 'bash:git push*', do: [{ require_file: 'README.md' }] },
  ]);
  const r1 = runHook(pre(proj, 'Bash', { command: 'git push' }));
  check('untrusted require_file: still enforced', denied(r1), r1.stdout);
  fs.writeFileSync(path.join(proj, 'README.md'), '# hi');
  const r2 = runHook(pre(proj, 'Bash', { command: 'git push' }));
  check('untrusted require_file: passes when satisfied', r2.stdout.trim() === '', r2.stdout);
}

// --- global rules need no trust (user's own home) -------------------------
{
  const home = makeHome([
    { id: 'g', on: 'bash:git push*', do: [{ run: 'exit 1' }] },
  ]);
  const proj = makeProject(null);
  const r = runHook(pre(proj, 'Bash', { command: 'git push' }), { home });
  check('global rules execute without trust', denied(r), r.stdout);
}

// --- session_start from untrusted repo runs nothing -----------------------
{
  const proj = makeProject([
    { id: 'evil', on: 'session_start', do: [{ run: 'echo owned > owned.txt' }] },
  ]);
  const r = runHook({ hook_event_name: 'SessionStart', cwd: proj, source: 'startup' });
  check('untrusted session_start: no execution', !fs.existsSync(path.join(proj, 'owned.txt')));
  check('untrusted session_start: context explains trust', /--trust/.test(r.stdout), r.stdout);
}

// ==========================================================================
// Post events
// ==========================================================================

// --- edited: post-hook runs action with {file}; failure exits 2 -----------
{
  const { proj, home } = trustedSetup([
    { id: 'fmt', on: 'edited:*.py', do: [{ run: 'touch {file}.marker' }] },
  ]);
  const file = path.join(proj, 'app.py');
  fs.writeFileSync(file, 'print(1)\n');
  const r = runHook(post(proj, 'Edit', { file_path: file }), { home });
  check('edited: action ran with {file}', fs.existsSync(file + '.marker'), r.stderr);
  check('edited: success is silent', r.status === 0 && r.stdout.trim() === '', r.stdout);
}
{
  const { proj, home } = trustedSetup([
    { id: 'fmt', on: 'edited:*.py', do: [{ run: 'exit 1' }] },
  ]);
  const file = path.join(proj, 'app.py');
  fs.writeFileSync(file, '');
  const r = runHook(post(proj, 'Edit', { file_path: file }), { home });
  check('edited failure: exit 2', r.status === 2, `status=${r.status}`);
  check('edited failure: stderr names rule', /fmt/.test(r.stderr), r.stderr);
}

// --- errored tool result skips post rules ---------------------------------
{
  const { proj, home } = trustedSetup([
    { id: 'fmt', on: 'edited:*.py', do: [{ run: 'exit 1' }] },
  ]);
  const r = runHook(post(proj, 'Edit', { file_path: path.join(proj, 'a.py') }, true), { home });
  check('post skipped when tool errored', r.status === 0 && r.stdout.trim() === '', r.stdout);
}

// --- ran: fires after matching bash command, warn → additionalContext -----
{
  const { proj, home } = trustedSetup([
    { id: 'audit', on: 'ran:npm install*', severity: 'warn', do: [{ run: 'echo vuln-found; exit 1' }] },
  ]);
  const r = runHook(post(proj, 'Bash', { command: 'npm install left-pad' }), { home });
  const out = JSON.parse(r.stdout || '{}');
  check('ran: warn becomes additionalContext', /vuln-found/.test(out.hookSpecificOutput?.additionalContext || ''), r.stdout);
}

// ==========================================================================
// Stop + SessionStart
// ==========================================================================

{
  const { proj, home } = trustedSetup([
    { id: 'build-ok', on: 'stop', do: [{ run: 'exit 1' }] },
  ]);
  const r1 = runHook({ hook_event_name: 'Stop', cwd: proj, stop_hook_active: false }, { home });
  const r2 = runHook({ hook_event_name: 'Stop', cwd: proj, stop_hook_active: true }, { home });
  check('stop: failing check exits 2', r1.status === 2, `status=${r1.status}`);
  check('stop: no re-block when stop_hook_active', r2.status === 0, `status=${r2.status}`);
}
{
  const { proj, home } = trustedSetup([
    { id: 'brief', on: 'session_start', do: [{ run: 'echo hello-from-huuk' }] },
  ]);
  const r = runHook({ hook_event_name: 'SessionStart', cwd: proj, source: 'startup' }, { home });
  const out = JSON.parse(r.stdout || '{}');
  check('session_start: context injected', /hello-from-huuk/.test(out.hookSpecificOutput?.additionalContext || ''), r.stdout);
}

// ==========================================================================
// Config robustness
// ==========================================================================

// --- broken rules file: loud but non-blocking -----------------------------
{
  const proj = makeProject('{ this is not json');
  const r = runHook(pre(proj, 'Bash', { command: 'git push' }));
  check('broken config: exit 1', r.status === 1, `status=${r.status}`);
  check('broken config: stderr explains', /NOT enforced/.test(r.stderr), r.stderr);
}

// --- comments and URLs-in-strings parse fine ------------------------------
{
  const body = `{
    // line comment with "quotes" and a url https://example.com/x
    /* block comment * with / slashes */
    "rules": [
      { "id": "gate", "description": "see https://docs.example.com//path", "on": "bash:git push*", "do": [{ "forbid": "no // really" }] }
    ]
  }`;
  const proj = makeProject(body);
  const r = runHook(pre(proj, 'Bash', { command: 'git push' }));
  const out = JSON.parse(r.stdout || '{}');
  check('JSONC: comments stripped, strings intact', denied(r) && /no \/\/ really/.test(out.hookSpecificOutput?.permissionDecisionReason || ''), r.stdout);
}

// --- degenerate inputs never crash ----------------------------------------
{
  const proj = makeProject([{ id: 'gate', on: 'bash:git push*', do: [{ forbid: 'no' }] }]);
  const cases = [
    ['missing tool_input', pre(proj, 'Bash', undefined)],
    ['empty command', pre(proj, 'Bash', { command: '' })],
    ['unknown tool', pre(proj, 'SomeFutureTool', { x: 1 })],
    ['unknown event', { hook_event_name: 'SomethingNew', cwd: proj }],
    ['rule without on', null],
  ];
  for (const [name, event] of cases) {
    const r = runHook(event === null ? pre(makeProject([{ id: 'x', do: [] }]), 'Bash', { command: 'git push' }) : event);
    check(`degenerate: ${name} → silent exit 0`, r.status === 0 && r.stdout.trim() === '', `status=${r.status} out=${r.stdout} err=${r.stderr}`);
  }
}

// --- no rules file at all: silent no-op -----------------------------------
{
  const proj = makeProject(null);
  const r = runHook(pre(proj, 'Bash', { command: 'git push' }));
  check('no rules file: silent', r.status === 0 && r.stdout.trim() === '', r.stdout);
}

// --- huge check output is truncated in the reason -------------------------
{
  const { proj, home } = trustedSetup([
    { id: 'noisy', on: 'bash:git push*', do: [{ run: 'head -c 100000 /dev/zero | tr "\\0" x; exit 1' }] },
  ]);
  const r = runHook(pre(proj, 'Bash', { command: 'git push' }), { home });
  const out = JSON.parse(r.stdout || '{}');
  const reason = out.hookSpecificOutput?.permissionDecisionReason || '';
  check('huge output: reason bounded', denied(r) && reason.length < 4000, `len=${reason.length}`);
}

// ==========================================================================
// Merging + conditions
// ==========================================================================

{
  const home = makeHome([
    { id: 'gate', on: 'bash:git push*', do: [{ forbid: 'global says no' }] },
    { id: 'extra', on: 'bash:git push*', do: [{ forbid: 'extra global rule' }] },
  ]);
  const proj = makeProject([
    { id: 'gate', on: 'bash:git push*', enabled: false, do: [{ forbid: 'x' }] },
  ]);
  const r = runHook(pre(proj, 'Bash', { command: 'git push' }), { home });
  const out = JSON.parse(r.stdout || '{}');
  const reason = out.hookSpecificOutput?.permissionDecisionReason || '';
  check('merge: project override disables global gate, other global rule still fires',
    /extra global rule/.test(reason) && !/global says no/.test(reason), r.stdout);
}
{
  const proj = makeProject([
    { id: 'protected', on: 'bash:git push*', if: { branch: ['main'] }, do: [{ forbid: 'no' }] },
  ]);
  const r = runHook(pre(proj, 'Bash', { command: 'git push' }));
  check('if.branch: skipped when branch unknown (not a repo)', r.stdout.trim() === '', r.stdout);
}
{
  const proj = makeProject([
    { id: 'node-only', on: 'bash:git push*', if: { exists: 'package.json' }, do: [{ forbid: 'no' }] },
  ]);
  const r1 = runHook(pre(proj, 'Bash', { command: 'git push' }));
  fs.writeFileSync(path.join(proj, 'package.json'), '{}');
  const r2 = runHook(pre(proj, 'Bash', { command: 'git push' }));
  check('if.exists: inactive without file', r1.stdout.trim() === '', r1.stdout);
  check('if.exists: active with file', denied(r2), r2.stdout);
}

// ==========================================================================
// Kill switch + CLI
// ==========================================================================

{
  const proj = makeProject([{ id: 'gate', on: 'bash:git push*', do: [{ forbid: 'no' }] }]);
  const r = runHook(pre(proj, 'Bash', { command: 'git push' }), { env: { HUUK_DISABLE: '1' } });
  check('HUUK_DISABLE: silent no-op', r.status === 0 && r.stdout.trim() === '', r.stdout);
}
{
  const { proj, home } = trustedSetup([
    { id: 'gate', description: 'tests', on: 'bash:git push*', do: [{ run: 'exit 1' }] },
  ]);
  const r = spawnSync('node', [ENGINE, '--check', 'git', 'push'], {
    cwd: proj, encoding: 'utf8', env: { ...process.env, HOME: home },
  });
  check('--check: exit 3 on failure', r.status === 3, `status=${r.status} ${r.stdout}`);
  check('--check: reports BLOCKED', /BLOCKED/.test(r.stdout), r.stdout);
}
{
  const proj = makeProject([
    { id: 'gate', on: 'bash:git push*', do: [{ run: 'exit 0' }] },
  ]);
  const r = spawnSync('node', [ENGINE, '--check'], {
    cwd: proj, encoding: 'utf8', env: { ...process.env, HOME: makeHome() },
  });
  check('--check untrusted: exit 3 + trust note', r.status === 3 && /trust/i.test(r.stdout), `status=${r.status} ${r.stdout}`);
}
{
  const { proj, home } = trustedSetup([
    { id: 'gate', on: 'bash:git push*', do: [{ run: 'true' }] },
  ]);
  const r = spawnSync('node', [ENGINE, '--list'], {
    cwd: proj, encoding: 'utf8', env: { ...process.env, HOME: home },
  });
  const out = JSON.parse(r.stdout || '{}');
  check('--list: merged rules with source + trust status', out.rules?.[0]?.source === 'project' && out.projectTrusted === true, r.stdout);
}

// --------------------------------------------------------------------------
const total = passed + failures.length;
console.log(`\n${passed}/${total} assertions passed`);
if (failures.length) {
  console.log(failures.join('\n'));
  if (process.env.GITHUB_ACTIONS) {
    // surface as annotations so failures are visible without downloading logs
    for (const f of failures) console.log(`::error::${f}`);
  }
  process.exit(1);
}
