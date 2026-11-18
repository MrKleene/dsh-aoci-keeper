# AOCI keeper

## Where this sits

The keeper is the last step of an AOCI setup, not the whole of it. It assumes:

- the `aoci` binary is installed at a stable absolute path on the host;
- the repository already has a governed index (`aoci.txt`, `aoci.meta.txt`, `aoci.code.txt`, `.aoci/`)
  created by `aoci init` and `aoci scan`;
- the `aoci-code` MCP server is registered in the DSH profile so the model can actually call
  `aoci_maintain` and `aoci_update_entry`.

It does not install the binary, initialize a repository, register the MCP server, or create the first
index. Those are manual steps documented in the README's "Getting AOCI running on DSH first".

## Why the reminder is needed at all

AOCI's own host integration covers Codex (`SessionStart(compact)` plus a compaction prompt, installed
with `--hooks`), Claude Code (a `PreToolUse` guard), OpenCode, Cursor and Qoder. Every one of those is a
write to host configuration that AOCI performs for a host it knows. DSH is not in that list, and its
documentation says so: "Other MCP hosts — connect to the standard stdio server — require manual
configuration and host-specific validation."

Manual configuration gets the nine tools into the session, but it does not create a trigger. MCP is
pull: tools exist, and the model has to choose them. In a long task the model chooses them rarely, so
the index grows stale between sessions. The keeper supplies the missing trigger by making the finding
count part of the turn's input.

## What it changes

Only the messages entering a turn. While the repository's AOCI index is
unaligned, the plugin prepends one user-role notice to the step:

```
AOCI 认知索引未对齐（governance_aligned=false）。
- findings: 84（stale 75 / pending 10 / missing 2）
- 本轮改动完成后：先 `aoci_maintain` 领取批次并提交，再 `aoci check` 确认归零
```

The notice belongs to that step, not to the session log: reopening the session
shows the conversation without it. No index file, baseline, or session record is
written by the plugin.

## When it helps, and when it does not

It helps when the repository has an `aoci.txt`, the index is expected to stay
aligned, and sessions are long enough that source files change faster than the
index. The reminder is the difference between "the index drifted three days ago"
and "the index drifted in this turn".

It does not help when there is no index to keep (no `aoci.txt` above the session
`cwd` and no `repoRoot`), when `aoci` is not installed, when the MCP server is not
registered (the notice would name a tool the model cannot call), or when the user
prefers to run `aoci check` themselves — the plugin degrades to silence in all of
those cases rather than warning on every turn.

## Request flow

- `agent/pre-step` is a waterfall. The keeper always calls `next()` first and
  only ever enriches an `enter` decision; a `reject` decision and every other
  listener's work pass through untouched.
- The enriched decision is a copy (`{ ...decision, messages }`), so the loop's
  own message list stays as the other listeners produced it.
- The CLI runs off the critical path: a refresh starts in the background and the
  notice uses the cached result, so a slow `aoci check` never delays a step.

## Failure behavior

| condition | behavior |
|---|---|
| `aoci` not installed or not executable | check fails, cached as failed, no notice |
| check exits non-zero with valid JSON | parsed normally; a blocked index exits 1 by design |
| check times out (`timeoutMs`) | process killed, cached as failed |
| no `aoci.txt` above the session `cwd` and no `repoRoot` | plugin stays silent |

## Verified

- DSH `0.2.2-rc.3`, macOS arm64: loads from a profile bundle install, runs the
  check against a repository with 84 findings, and adds exactly one notice per
  turn.
- `node --test tests/keeper.test.mjs`: six cases covering the first silent step,
  the reminder after a cached finding, one notice per turn, an untouched
  `reject` decision, a repository without `aoci.txt`, and a missing executable.
