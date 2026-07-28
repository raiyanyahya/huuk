---
description: Dry-run huuk rules right now — see whether a git push (or any command) would pass or be blocked, without running it
argument-hint: [command to simulate, default "git push origin main"]
---

# huuk check

Dry-run the gate without touching git. Command to simulate: $ARGUMENTS (default: `git push origin main`).

Run from the project root:

```
node "${CLAUDE_PLUGIN_ROOT}/bin/huuk.js" --check <command>
```

Exit codes: `0` = all matching rules pass (or none match) · `3` = at least one blocking rule fails · `1` = rules file has syntax errors.

Report the per-rule results to the user. If something failed, summarize *why* (include the tool output the engine captured) and offer to fix the underlying problem — e.g. failing tests or lint errors — not to weaken the rule. If the rules file has errors, show them and offer to repair the JSON.

If the output notes the project rules file is **not trusted**, explain that huuk refuses to execute commands from an unapproved rules file (protection against malicious cloned repos), and — only if the user confirms the rules are theirs/reviewed — approve with `node "${CLAUDE_PLUGIN_ROOT}/bin/huuk.js" --trust`.
