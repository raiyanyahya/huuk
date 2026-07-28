# Contributing to huuk

Thanks for wanting to help! huuk is small on purpose — a policy engine people trust to
gate their agent's actions has to stay auditable in one sitting. Contributions that keep
it that way are very welcome.

## Ground rules

- **Zero runtime dependencies.** The engine (`bin/huuk.js`) must run on bare Node ≥ 18 —
  no `npm install`, ever. Vendoring a library needs a very good reason.
- **The engine is security-sensitive.** Anything touching matching, substitution, trust,
  or the hook output protocol needs tests proving the security property, not just the
  feature (see below).
- **Fail the right way.** Gates fail *closed* (uncertain → block, with a clear reason);
  infrastructure fails *open but loud* (a broken rules file must never brick a session —
  and must never execute anything either).

## Getting started

```bash
git clone <your-fork>
cd huuk
node test/run-tests.js          # everything green? you're set — there is no build step
claude --plugin-dir .           # try your changes in a live Claude Code session
```

Project layout:

| Path | What it is |
|---|---|
| `bin/huuk.js` | the entire engine: rules loading, trust, matching, actions, hook I/O, CLI |
| `hooks/hooks.json` | static hook wiring (PreToolUse / PostToolUse / SessionStart / Stop) |
| `skills/*/SKILL.md` | the `/huuk:setup`, `/huuk:rules`, `/huuk:check` skills |
| `test/run-tests.js` | the whole test suite; fixtures are built in temp dirs with an isolated fake `$HOME` |
| `examples/huuk.rules.json` | the showcase rules file — CI parses it through the real engine |

## Tests

`node test/run-tests.js` must pass. For new behavior, add assertions in the matching
section of the suite; the helpers (`makeProject`, `makeHome`, `trustedSetup`, `runHook`)
cover almost every scenario.

Extra requirements for sensitive areas:

- **Matcher changes** (`candidateSegments`, `strippedVariants`, globs): add both an
  *evasion* test (the sneaky form is caught) and a *false-positive* test (a benign
  look-alike is not).
- **Substitution / action execution**: add an injection test with a hostile input
  (` `` `, `$( )`, quotes, `$&`) proving nothing executes.
- **Trust model**: prove untrusted `run` actions fail closed and that your change doesn't
  create a path around the hash check.
- **Hook output**: warn-severity output must never contain a `permissionDecision`.

CI (`.github/workflows/ci.yml`) runs the suite on Linux and macOS across Node 18/20/22.
Test commands must be POSIX (`sh`) compatible.

## Pull requests

1. One logical change per PR; keep diffs reviewable.
2. Update the docs that the change touches: `README.md`, the relevant `SKILL.md`
   (Claude follows these verbatim — treat them as code), and `examples/huuk.rules.json`
   if the schema grew.
3. Bump `version` in `.claude-plugin/plugin.json` and the `VERSION` const in
   `bin/huuk.js` together (semver: new triggers/actions = minor, fixes = patch).
4. Describe the failure mode your change prevents or the workflow it enables — not just
   what the code does.

## Reporting security issues

If you find a way to make a gate not fire, execute code from an untrusted rules file, or
inject via substitution: please **do not open a public issue**. Email
raiyanyahyadeveloper@gmail.com with a proof of concept and give a few days for a fix
before disclosure. Credit given gladly.

## Ideas that would be great PRs

- More built-in condition types (`files_changed:` glob against `git diff --name-only`)
- A `check:` action type for reusable named checks (`tests-exist-for-changed-files`)
- Windows support for the test suite (portable fixture commands)
- An org-managed scope layered above project rules
