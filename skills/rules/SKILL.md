---
description: Show, add, edit, or remove huuk rules — the if-this-then-that policy that gates and steers Claude Code in this project
argument-hint: [show | plain-english change, e.g. "block pushes unless mypy passes"]
---

# huuk rules

Manage the huuk rule files. The user's request: $ARGUMENTS

## Step 1 — always load current state first

Run:

```
node "${CLAUDE_PLUGIN_ROOT}/bin/huuk.js" --list
```

(from the project root). This prints the merged rules as JSON, including each rule's `source` (`project` or `global`) and the paths of both rules files.

## Step 2 — if the request is empty or "show"

Render the rules as a compact table: **id · when (on) · what it does · severity · source**. Below the table, note the two file paths and that project rules override global rules with the same id. If there are zero rules, suggest `/huuk:setup`.

## Step 3 — if the request is a change

1. Decide scope: edit the **project** file `.claude/huuk.rules.json` unless the user says "global", "everywhere", or "all my projects" — then `~/.claude/huuk.rules.json`. Create the file with `{ "rules": [] }` if it doesn't exist.
2. Write the rule using this schema (comments are allowed in the file):

```jsonc
{
  "id": "kebab-case-unique",
  "description": "Human sentence shown in failure messages",
  "on": "bash:git push*",        // triggers below
  "severity": "block",           // "block" (default) or "warn"
  "if": { "branch": ["main"], "exists": "package.json" },  // optional
  "do": [
    { "run": "pytest -q" },                  // shell cmd; non-zero exit = fail
    { "require_file": "README.md" },         // fail if missing
    { "forbid": "message" },                 // always fail with message
    { "steer": "instruction to the agent" }  // block + tell Claude what to do instead
  ]
}
```

**Triggers (`on`)**: `bash:<pattern>` (before a shell command; `*` = wildcard, no `*` = exact segment match; chained commands are matched per segment) · `edit:<glob>` (before a file is modified) · `edited:<glob>` (after a file is modified; `{file}` placeholder available in `run`) · `ran:<pattern>` (after a shell command succeeds) · `session_start` (run and inject output as context) · `stop` (end-of-turn checks; failures make Claude keep working).

**Conditions (`if`)**: `branch` (name/pattern list), `exists`, `not_exists` (paths). All must hold or the rule is skipped.

**Placeholders**: `{file}` and `{command}` in `run` commands expand to a shell-quoted value — write `black {file}`, NOT `black "{file}"`.

3. Validate: re-run `--list` and confirm no `errors`. Changes take effect immediately — the engine re-reads the files on every event.
4. **Trust**: editing the project rules file revokes its trust, and untrusted `run` actions fail closed. Since this edit was requested by the user, re-approve it: run `node "${CLAUDE_PLUGIN_ROOT}/bin/huuk.js" --trust` from the project root. (If the user asks to trust/untrust explicitly, use `--trust` / `--untrust`.) Global rules in `~/.claude/` need no trust.
5. Confirm to the user what changed, in which file, and give one example of when it will fire.

To disable a rule without deleting it, set `"enabled": false`. To override a global rule in one project, add a project rule with the same `id`.
