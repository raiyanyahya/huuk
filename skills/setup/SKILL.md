---
description: Create a starter .claude/huuk.rules.json for this project, with checks auto-detected from the codebase
argument-hint: [optional preferences, e.g. "strict" or "only gate pushes"]
---

# huuk setup

Create a sensible starter rules file for this project. User preferences: $ARGUMENTS

## Step 1 — detect the project

Inspect the repo root (don't deep-scan): look for `package.json` (read its `scripts`), `pyproject.toml`, `pytest.ini`/`tests/`, `ruff.toml`/`[tool.ruff]`, `.eslintrc*`, `tsconfig.json`, `go.mod`, `Cargo.toml`, `Makefile`, `.pre-commit-config.yaml`. Prefer commands the project already defines (`npm test`, `make test`, `pre-commit run --all-files`) over guessing tool invocations.

## Step 2 — propose rules

Build 3–6 rules from what exists. Typical starter set:

- **gate-push** (`bash:git push*`, block): run the detected test command, plus the detected linter/typechecker.
- **protect-env** (`edit:.env*`, block): `steer` — "Don't modify env files; tell the user which variable to set."
- **no-force-push-protected** (`bash:git push*--force*`, `if.branch: ["main","master"]`, block): `forbid`.
- **format-after-edit** (`edited:*.<ext>`, warn): run the detected formatter on `{file}` — only if a formatter is configured. `{file}` expands already shell-quoted: write `black {file}`, not `black "{file}"`.
- **init-branch-name** (`bash:git init`, block): `steer` — ask the user for the default branch name, then use `git init -b <name>`. (Exact match, so the retried `git init -b x` is not re-blocked.)

Show the proposed JSON to the user with one sentence per rule.

## Step 3 — write and verify

- If `.claude/huuk.rules.json` already exists, do NOT overwrite — show a diff of what you'd add and ask first.
- Write the file, then validate with `node "${CLAUDE_PLUGIN_ROOT}/bin/huuk.js" --list` (must report no `errors`).
- Trust it (the user just approved this policy): `node "${CLAUDE_PLUGIN_ROOT}/bin/huuk.js" --trust` from the project root. Without this, `run` actions fail closed by design.
- Demo it: run `node "${CLAUDE_PLUGIN_ROOT}/bin/huuk.js" --check "git push origin main"` and show the result.
- Tell the user: rules are live immediately, `/huuk:rules` edits them, and committing `.claude/huuk.rules.json` shares the policy with the whole team.
