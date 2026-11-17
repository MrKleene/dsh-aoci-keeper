# AOCI keeper

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
`cwd` and no `repoRoot`), when `aoci` is not installed, or when the user prefers
to run `aoci check` themselves — the plugin degrades to silence in all three
cases rather than warning on every turn.

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
