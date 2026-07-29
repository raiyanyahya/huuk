#!/usr/bin/env node
'use strict';

/*
 * huuk — if-this-then-that rules for Claude Code.
 *
 * Runs as a Claude Code hook (PreToolUse / PostToolUse / SessionStart / Stop)
 * and as a small CLI (--list, --check, --trust, --untrust). Zero dependencies.
 *
 * Rules live in:
 *   <project>/.claude/huuk.rules.json   (project scope, committed)
 *   ~/.claude/huuk.rules.json           (global scope, personal)
 * Project rules override global rules that share the same id.
 * Comments (// and block comments) are allowed in the rules files.
 *
 * Security model:
 *  - A project rules file must be trusted (hash recorded via --trust) before
 *    its `run` actions execute — a cloned repo cannot run code just by
 *    shipping a rules file. Untrusted `run` actions fail closed.
 *  - {file} / {command} placeholders are shell-quoted on substitution so
 *    hostile filenames cannot inject commands.
 *  - warn-severity rules never emit a permission decision, so they can never
 *    auto-approve a command that would otherwise prompt the user.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');

const VERSION = '0.2.2';
const DEFAULT_ACTION_TIMEOUT_S = 300;
const OUTPUT_TAIL_CHARS = 2000;
const MAX_CONTEXT_CHARS = 8000;

const EDIT_TOOLS = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'];

// ---------------------------------------------------------------------------
// Rules loading + trust
// ---------------------------------------------------------------------------

function stripJsonComments(text) {
  let out = '';
  let i = 0;
  let inStr = false;
  while (i < text.length) {
    const c = text[i];
    const n = text[i + 1];
    if (inStr) {
      out += c;
      if (c === '\\' && n !== undefined) {
        out += n;
        i += 2;
        continue;
      }
      if (c === '"') inStr = false;
      i++;
      continue;
    }
    if (c === '"') {
      inStr = true;
      out += c;
      i++;
      continue;
    }
    if (c === '/' && n === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && n === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

// Canonicalize paths so trust keys match regardless of symlinks — on macOS,
// hook events see /var/… while process.cwd() resolves to /private/var/….
function realpathOr(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

// Like realpathOr, but works for paths that don't exist yet (a Write creating
// a new file): canonicalize the nearest existing ancestor, keep the rest.
function canonicalPath(p) {
  let head = path.resolve(p);
  const tail = [];
  while (true) {
    try {
      return tail.length ? path.join(fs.realpathSync(head), ...tail) : fs.realpathSync(head);
    } catch {
      const parent = path.dirname(head);
      if (parent === head) return p;
      tail.unshift(path.basename(head));
      head = parent;
    }
  }
}

function trustStoreFile() {
  return path.join(os.homedir(), '.claude', 'huuk-trust.json');
}

function readTrustStore() {
  try {
    return JSON.parse(fs.readFileSync(trustStoreFile(), 'utf8')) || {};
  } catch {
    return {};
  }
}

function isProjectTrusted(projectFile) {
  if (!fs.existsSync(projectFile)) return true; // nothing to trust
  try {
    return readTrustStore()[projectFile] === sha256(fs.readFileSync(projectFile));
  } catch {
    return false;
  }
}

function loadRulesFile(file, source) {
  if (!fs.existsSync(file)) return { rules: [], errors: [] };
  try {
    const parsed = JSON.parse(stripJsonComments(fs.readFileSync(file, 'utf8')));
    const rules = Array.isArray(parsed.rules) ? parsed.rules : [];
    for (const r of rules) {
      r._source = source;
      r._file = file;
    }
    return { rules, errors: [] };
  } catch (e) {
    return { rules: [], errors: [`${file}: ${e.message}`] };
  }
}

function loadAllRules(cwd) {
  cwd = realpathOr(cwd);
  const globalFile = path.join(os.homedir(), '.claude', 'huuk.rules.json');
  const projectFile = path.join(cwd, '.claude', 'huuk.rules.json');
  const g = loadRulesFile(globalFile, 'global');
  const p = loadRulesFile(projectFile, 'project');
  const projectTrusted = isProjectTrusted(projectFile);
  for (const r of p.rules) r._untrusted = !projectTrusted;
  const projectIds = new Set(p.rules.map((r) => r.id).filter(Boolean));
  const merged = [...g.rules.filter((r) => !projectIds.has(r.id)), ...p.rules];
  return {
    rules: merged.filter((r) => r.enabled !== false),
    errors: [...g.errors, ...p.errors],
    globalFile,
    projectFile,
    projectTrusted,
  };
}

function trustMessage() {
  return (
    'the project rules file is not trusted (new or changed since last approval), ' +
    'so its commands will not run. If the user approves these rules, run: ' +
    `node "${__filename}" --trust  (from the project root)`
  );
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

function normalizeWs(s) {
  return String(s).replace(/\s+/g, ' ').trim();
}

function wildcardToRegex(pattern) {
  const esc = String(pattern).replace(/[.*+?^${}()|[\]\\]/g, (ch) =>
    ch === '*' ? '.*' : '\\' + ch
  );
  return new RegExp('^' + esc + '$');
}

const WRAPPERS = new Set([
  'sudo', 'doas', 'env', 'command', 'exec', 'nohup', 'time', 'nice', 'stdbuf', 'xargs',
]);
const WRAPPER_FLAGS_WITH_ARG = new Set(['-u', '-n', '-o', '-e', '-i', '-p', '-g']);
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish']);

// `sudo git push`, `FOO=1 git push`, `env -u X git push` → also try `git push`.
function strippedVariants(seg) {
  const out = [seg];
  let tokens = seg.split(' ');
  for (let guard = 0; guard < 8; guard++) {
    let changed = false;
    while (tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0])) {
      tokens = tokens.slice(1);
      changed = true;
    }
    if (tokens.length && WRAPPERS.has(tokens[0])) {
      tokens = tokens.slice(1);
      changed = true;
      while (tokens.length && tokens[0].startsWith('-')) {
        const flag = tokens[0];
        tokens = tokens.slice(1);
        if (WRAPPER_FLAGS_WITH_ARG.has(flag) && tokens.length) tokens = tokens.slice(1);
      }
    }
    if (!changed) break;
    if (tokens.length) out.push(tokens.join(' '));
  }
  return out;
}

const CHAIN_SPLIT = /&&|\|\||[;|&\n]/;

// git global options that sit between `git` and the subcommand and take a
// separate argument token (`git -C /repo push`, `git -c k=v push`).
const GIT_OPTS_WITH_ARG = new Set([
  '-C', '-c', '--git-dir', '--work-tree', '--namespace', '--super-prefix', '--exec-path',
]);

// Expose the subcommand form so `git push*` still matches `git -C /repo push`
// or `git -c k=v push` — agents use these whenever they aren't cd'd into the
// repo. Returns e.g. "git push origin main", or null if nothing to strip.
function gitNormalize(seg) {
  const tokens = seg.split(' ');
  if (tokens[0] !== 'git') return null;
  let i = 1;
  while (i < tokens.length && tokens[i].startsWith('-')) {
    const opt = tokens[i];
    i++;
    if (GIT_OPTS_WITH_ARG.has(opt) && i < tokens.length) i++; // consume its arg
  }
  if (i === 1 || i >= tokens.length) return null; // no options stripped, or no subcommand
  return 'git ' + tokens.slice(i).join(' ');
}

// All the strings a command could "mean": the whole command, each chained
// segment, wrapper-stripped variants, git-subcommand-normalized forms, and —
// for `sh -c "…"` style calls — the quoted payload (recursively split too).
function candidateSegments(command) {
  const set = new Set();
  const add = (s) => {
    const n = normalizeWs(s);
    if (!n) return;
    for (const v of strippedVariants(n)) {
      set.add(v);
      const g = gitNormalize(v);
      if (g) set.add(g);
    }
  };
  add(command);
  for (const rawSeg of String(command).split(CHAIN_SPLIT)) {
    add(rawSeg);
    const seg = normalizeWs(rawSeg);
    const tokens = seg.split(' ');
    const isShellC =
      SHELLS.has(tokens[0]) && tokens.some((t) => /^-[a-zA-Z]*c$/.test(t));
    if (isShellC) {
      for (const m of rawSeg.matchAll(/"([^"]*)"|'([^']*)'/g)) {
        const inner = m[1] !== undefined ? m[1] : m[2];
        add(inner);
        for (const innerSeg of String(inner).split(CHAIN_SPLIT)) add(innerSeg);
      }
    }
  }
  return [...set];
}

function matchBash(pattern, command) {
  const re = wildcardToRegex(normalizeWs(pattern));
  return candidateSegments(command).some((seg) => re.test(seg));
}

function globToRegex(glob) {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        out += '.*';
        i++;
        if (glob[i + 1] === '/') i++;
      } else {
        out += '[^/]*';
      }
    } else if (c === '?') {
      out += '[^/]';
    } else {
      out += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp('^' + out + '$');
}

// Globs without "/" match the basename (".env*" matches "api/.env.local");
// globs with "/" match the absolute and project-relative path.
function matchFile(glob, filePath, cwd) {
  if (!filePath) return false;
  const re = globToRegex(String(glob).trim());
  const abs = canonicalPath(path.resolve(cwd, filePath));
  if (!String(glob).includes('/')) return re.test(path.basename(abs));
  const rel = path.relative(cwd, abs);
  return re.test(abs) || re.test(rel);
}

// "on" grammar: bash:<pattern> | edit:<glob> | edited:<glob> | ran:<pattern>
//               | session_start | stop
function parseOn(rule) {
  const on = String(rule.on || '');
  const idx = on.indexOf(':');
  if (idx === -1) return { kind: on.trim(), arg: '' };
  return { kind: on.slice(0, idx).trim(), arg: on.slice(idx + 1).trim() };
}

function severity(rule) {
  return String(rule.severity || 'block').toLowerCase() === 'warn' ? 'warn' : 'block';
}

// ---------------------------------------------------------------------------
// Conditions
// ---------------------------------------------------------------------------

function currentBranch(cwd) {
  try {
    return execSync('git rev-parse --abbrev-ref HEAD', {
      cwd,
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
    })
      .toString()
      .trim();
  } catch {
    return null;
  }
}

function asList(v) {
  return Array.isArray(v) ? v : [v];
}

function conditionsMet(rule, cwd) {
  const cond = rule.if;
  if (!cond) return true;
  if (cond.branch !== undefined) {
    const b = currentBranch(cwd);
    if (b === null) return false;
    if (!asList(cond.branch).some((p) => wildcardToRegex(p).test(b))) return false;
  }
  if (cond.exists !== undefined) {
    if (!asList(cond.exists).every((f) => fs.existsSync(path.resolve(cwd, f)))) return false;
  }
  if (cond.not_exists !== undefined) {
    if (!asList(cond.not_exists).every((f) => !fs.existsSync(path.resolve(cwd, f)))) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

function shQuote(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

// Function replacements so `$&`-style sequences in values are inert; `quote`
// shell-quotes values so hostile filenames can't inject commands.
function substitute(str, ctx, quote) {
  const rep = (v) => (quote ? shQuote(v) : v);
  return String(str)
    .replace(/\{file\}/g, () => (ctx.file ? rep(ctx.file) : ''))
    .replace(/\{command\}/g, () => (ctx.command ? rep(ctx.command) : ''));
}

function tail(text, n = OUTPUT_TAIL_CHARS) {
  const t = String(text || '').trim();
  return t.length > n ? '…' + t.slice(-n) : t;
}

// Runs a rule's actions. Returns { failures: [string], output: [string] }.
// "output" collects stdout of successful `run` actions (used by session_start).
function runActions(rule, ctx) {
  const failures = [];
  const output = [];
  for (const action of rule.do || []) {
    if (typeof action !== 'object' || action === null) {
      failures.push(`Invalid action: ${JSON.stringify(action)}`);
      continue;
    }
    if (action.forbid !== undefined) {
      failures.push(String(action.forbid));
      continue;
    }
    if (action.steer !== undefined) {
      failures.push(String(action.steer));
      continue;
    }
    if (action.require_file !== undefined) {
      const rel = substitute(action.require_file, ctx, false);
      if (!fs.existsSync(path.resolve(ctx.cwd, rel))) {
        failures.push(`Required file is missing: ${rel}`);
      }
      continue;
    }
    if (action.run !== undefined) {
      if (rule._untrusted) {
        failures.push(`Refusing to run \`${action.run}\`: ${trustMessage()}`);
        continue;
      }
      const cmd = substitute(action.run, ctx, true);
      const timeoutS = Number(action.timeout_s) || DEFAULT_ACTION_TIMEOUT_S;
      try {
        const stdout = execSync(cmd, {
          cwd: ctx.cwd,
          stdio: ['ignore', 'pipe', 'pipe'],
          timeout: timeoutS * 1000,
          maxBuffer: 10 * 1024 * 1024,
          env: { ...process.env, HUUK: '1' },
        });
        output.push(stdout.toString());
      } catch (e) {
        const combined = [e.stdout, e.stderr]
          .map((b) => (b ? b.toString() : ''))
          .join('\n');
        const status = e.status != null ? `exit ${e.status}` : e.code || 'error';
        failures.push(`\`${cmd}\` failed (${status}):\n${tail(combined) || '(no output)'}`);
      }
      continue;
    }
    failures.push(`Unknown action ${JSON.stringify(action)} — expected run | require_file | forbid | steer`);
  }
  return { failures, output };
}

function formatRuleFailure(rule, failures) {
  const title = rule.description ? `"${rule.id}" (${rule.description})` : `"${rule.id}"`;
  return `Rule ${title}:\n${failures.map((f) => '  - ' + f).join('\n')}`;
}

// ---------------------------------------------------------------------------
// Event handlers
// ---------------------------------------------------------------------------

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function matchingRules(rules, cwd, predicate) {
  return rules.filter((r) => {
    const on = parseOn(r);
    return predicate(on) && conditionsMet(r, cwd);
  });
}

function evaluate(matched, ctx) {
  const blocks = [];
  const warns = [];
  for (const rule of matched) {
    const { failures } = runActions(rule, ctx);
    if (!failures.length) continue;
    const msg = formatRuleFailure(rule, failures);
    if (severity(rule) === 'warn') warns.push(msg);
    else blocks.push(msg);
  }
  return { blocks, warns };
}

function handlePreToolUse(input, rules, cwd) {
  const tool = input.tool_name;
  const toolInput = input.tool_input || {};
  let matched = [];
  const ctx = { cwd };

  if (tool === 'Bash') {
    ctx.command = toolInput.command || '';
    matched = matchingRules(rules, cwd, (on) => on.kind === 'bash' && matchBash(on.arg, ctx.command));
  } else if (EDIT_TOOLS.includes(tool)) {
    ctx.file = toolInput.file_path || toolInput.notebook_path || '';
    matched = matchingRules(rules, cwd, (on) => on.kind === 'edit' && matchFile(on.arg, ctx.file, cwd));
  }
  if (!matched.length) return;

  const { blocks, warns } = evaluate(matched, ctx);
  const target = tool === 'Bash' ? `\`${ctx.command}\`` : `modifying ${ctx.file}`;

  if (blocks.length) {
    const all = [...blocks, ...warns];
    emit({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason:
          `huuk blocked ${target}.\n\n${all.join('\n\n')}\n\n` +
          `Address the issues above, then retry. Do not work around these checks; ` +
          `if a rule seems wrong, tell the user and let them change it with /huuk:rules.`,
      },
    });
  } else if (warns.length) {
    // Message only — deliberately NO permission decision, so a warn rule can
    // never auto-approve a command that would otherwise prompt the user.
    emit({ systemMessage: `huuk warnings for ${target} (non-blocking):\n${warns.join('\n\n')}` });
  }
}

function handlePostToolUse(input, rules, cwd) {
  if (input.tool_result_is_error) return;
  const tool = input.tool_name;
  const toolInput = input.tool_input || {};
  let matched = [];
  const ctx = { cwd };

  if (tool === 'Bash') {
    ctx.command = toolInput.command || '';
    matched = matchingRules(rules, cwd, (on) => on.kind === 'ran' && matchBash(on.arg, ctx.command));
  } else if (EDIT_TOOLS.includes(tool)) {
    ctx.file = toolInput.file_path || toolInput.notebook_path || '';
    matched = matchingRules(rules, cwd, (on) => on.kind === 'edited' && matchFile(on.arg, ctx.file, cwd));
  }
  if (!matched.length) return;

  const { blocks, warns } = evaluate(matched, ctx);
  if (blocks.length) {
    process.stderr.write(
      `huuk post-check failed after ${tool}.\n\n${blocks.join('\n\n')}\n\nFix this before continuing.\n`
    );
    process.exit(2);
  }
  if (warns.length) {
    emit({
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        additionalContext: `huuk warnings:\n${warns.join('\n\n')}`,
      },
    });
  }
}

function handleSessionStart(input, rules, cwd) {
  const matched = matchingRules(rules, cwd, (on) => on.kind === 'session_start');
  if (!matched.length) return;

  const parts = [];
  for (const rule of matched) {
    const { failures, output } = runActions(rule, { cwd });
    const body = [...output, ...failures].join('\n').trim();
    if (body) parts.push(`[huuk:${rule.id}]\n${body}`);
  }
  if (!parts.length) return;
  emit({
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: tail(parts.join('\n\n'), MAX_CONTEXT_CHARS),
    },
  });
}

function handleStop(input, rules, cwd) {
  // Never block twice in a row — prevents infinite stop loops.
  if (input.stop_hook_active) return;
  const matched = matchingRules(rules, cwd, (on) => on.kind === 'stop');
  if (!matched.length) return;

  const { blocks, warns } = evaluate(matched, { cwd });
  if (blocks.length) {
    process.stderr.write(
      `huuk end-of-turn checks failed.\n\n${blocks.join('\n\n')}\n\n` +
        `Fix these before finishing. If a check cannot be satisfied, explain why to the user.\n`
    );
    process.exit(2);
  }
  if (warns.length) {
    emit({ systemMessage: `huuk end-of-turn warnings:\n${warns.join('\n\n')}` });
  }
}

// ---------------------------------------------------------------------------
// CLI modes (used by the /huuk:* skills)
// ---------------------------------------------------------------------------

function cliList() {
  const cwd = process.cwd();
  const { rules, errors, globalFile, projectFile, projectTrusted } = loadAllRules(cwd);
  emit({
    version: VERSION,
    projectFile,
    globalFile,
    projectTrusted,
    errors,
    rules: rules.map((r) => ({
      id: r.id,
      description: r.description || '',
      on: r.on,
      if: r.if || null,
      severity: severity(r),
      do: r.do || [],
      source: r._source,
    })),
  });
  if (errors.length) process.exit(1);
}

function cliCheck(args) {
  const cwd = process.cwd();
  const command = args.length ? args.join(' ') : 'git push origin main';
  const { rules, errors, projectTrusted } = loadAllRules(cwd);
  if (errors.length) {
    console.error('huuk: config errors:\n' + errors.join('\n'));
    process.exit(1);
  }
  if (!projectTrusted) {
    console.log('note: project rules file is NOT trusted — its `run` actions fail closed. Approve with --trust.');
  }
  const ctx = { cwd, command };
  const matched = matchingRules(rules, cwd, (on) => on.kind === 'bash' && matchBash(on.arg, command));
  if (!matched.length) {
    console.log(`huuk: no rules match \`${command}\` in ${cwd}`);
    return;
  }
  let failed = false;
  for (const rule of matched) {
    const { failures } = runActions(rule, ctx);
    const sev = severity(rule);
    if (failures.length) {
      if (sev === 'block') failed = true;
      console.log(`✗ [${sev}] ${formatRuleFailure(rule, failures)}`);
    } else {
      console.log(`✓ [${sev}] "${rule.id}" ${rule.description || ''}`.trim());
    }
  }
  if (failed) {
    console.log(`\nResult: \`${command}\` would be BLOCKED right now.`);
    process.exit(3);
  }
  console.log(`\nResult: \`${command}\` would be allowed.`);
}

function cliTrust(remove) {
  const cwd = realpathOr(process.cwd());
  const projectFile = path.join(cwd, '.claude', 'huuk.rules.json');
  const store = readTrustStore();
  if (remove) {
    delete store[projectFile];
    fs.mkdirSync(path.dirname(trustStoreFile()), { recursive: true });
    fs.writeFileSync(trustStoreFile(), JSON.stringify(store, null, 2));
    console.log(`huuk: untrusted ${projectFile}`);
    return;
  }
  if (!fs.existsSync(projectFile)) {
    console.error(`huuk: no project rules file at ${projectFile}`);
    process.exit(1);
  }
  const hash = sha256(fs.readFileSync(projectFile));
  store[projectFile] = hash;
  fs.mkdirSync(path.dirname(trustStoreFile()), { recursive: true });
  fs.writeFileSync(trustStoreFile(), JSON.stringify(store, null, 2));
  console.log(`huuk: trusted ${projectFile} (sha256 ${hash.slice(0, 12)}…)`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (data += c));
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(data));
  });
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv[0] === '--version') return console.log('huuk ' + VERSION);
  if (argv[0] === '--list') return cliList();
  if (argv[0] === '--check') return cliCheck(argv.slice(1));
  if (argv[0] === '--trust') return cliTrust(false);
  if (argv[0] === '--untrust') return cliTrust(true);

  // Hook mode: event JSON arrives on stdin.
  if (process.env.HUUK_DISABLE === '1') return;

  let input;
  try {
    input = JSON.parse(await readStdin());
  } catch {
    process.stderr.write('huuk: could not parse hook input\n');
    process.exit(1);
  }

  const cwd = realpathOr(input.cwd || process.cwd());
  const { rules, errors } = loadAllRules(cwd);
  if (errors.length) {
    // Broken config must be loud but must not brick the session: non-blocking error.
    process.stderr.write('huuk: rules file has errors (rules NOT enforced): ' + errors.join('; ') + '\n');
    process.exit(1);
  }
  if (!rules.length) return;

  switch (input.hook_event_name) {
    case 'PreToolUse':
      return handlePreToolUse(input, rules, cwd);
    case 'PostToolUse':
      return handlePostToolUse(input, rules, cwd);
    case 'SessionStart':
      return handleSessionStart(input, rules, cwd);
    case 'Stop':
      return handleStop(input, rules, cwd);
    default:
      return;
  }
}

main().catch((e) => {
  process.stderr.write('huuk: internal error: ' + (e && e.stack ? e.stack : e) + '\n');
  process.exit(1);
});
