# dsh-aoci-keeper

Keeps a repository's AOCI cognition index from silently drifting:
while the index is unaligned, the plugin adds **one** reminder line to the model input at the start of
a turn, with the finding count and the command that fixes it.

```text
AOCI 认知索引未对齐（governance_aligned=false）。
- findings: 84（stale 75 / pending 10 / missing 2）
- 本轮改动完成后：先 `aoci_maintain` 领取批次并提交，再 `aoci check` 确认归零
```

No index file is edited, nothing is auto-committed, and a step never waits on the CLI.

## Why this exists

AOCI builds a per-repository cognition index that the model reads to understand the codebase, and the
index is maintained by the model itself (`aoci_maintain` → `aoci_update_entry`), not by a background
job. DSH has no configurable stop hook, so in practice the index only gets maintained when someone
remembers to ask. This plugin makes the debt visible at exactly the moment it can still be paid: the
start of the next turn.

It is useful when:

- the repository has an `aoci.txt` and the index is expected to stay aligned;
- you want drift surfaced without reading `aoci check` output yourself;
- you run long sessions where files change faster than the index.

It does nothing when `aoci` is missing, no `aoci.txt` is found, or the index is already aligned.

## Install

```sh
dsh plugin add dsh-aoci-keeper          # from npm
dsh plugin add MrKleene/dsh-aoci-keeper # from source
```

Requires DSH `0.2.2-rc.3` or newer and the `aoci` CLI on the host.

## How it works

1. At the start of a turn the plugin resolves the repository: the configured `repoRoot`, else the
   nearest ancestor of the session's `cwd` that holds an `aoci.txt`, else the nearest ancestor of the
   host process `cwd`.
2. It refreshes `aoci check --json` in the background when the cached result is older than
   `refreshIntervalMs`. A step never waits on the CLI.
3. If the cached result is not `governance_aligned` and has at least `minFindings` findings, it
   prepends one user-role notice with the count and the top finding kinds. The notice is scoped to
   the step, so it is not written to the session log.
4. Reminders are limited to one per turn and to one per `reminderCooldownMs` per repository.

## Configuration

| key | default | meaning |
|---|---|---|
| `enabled` | `true` | Turn the keeper off without uninstalling. |
| `repoRoot` | `''` | Absolute repository path. Empty means auto-detect. |
| `command` | `'aoci'` | AOCI executable. Use an absolute path when the app is launched without the user's `PATH`. |
| `refreshIntervalMs` | `30000` | Minimum age of the cached check before a background refresh. |
| `reminderCooldownMs` | `600000` | Minimum gap between two reminders for one repository. |
| `minFindings` | `1` | Skip the reminder below this finding count. |
| `timeoutMs` | `20000` | Kill the check after this long. |
| `extraArgs` | `[]` | Extra arguments appended to `aoci check`. |

Override in the profile's `cordis.patch.yml`; the row replaces the bundle's whole `config`:

```yaml
- id: aoci-keeper
  config:
    command: /Users/me/.local/bin/aoci
    repoRoot: /Users/me/projects/example
```

## Failure behavior

The plugin degrades to silence rather than to noise: a missing `aoci`, a timeout, a non-JSON exit, or
a repository without `aoci.txt` all mean no notice is added. A blocked index is normal — `aoci check`
exits 1 by design when governance findings exist, and the JSON is still parsed.

## License

MIT
