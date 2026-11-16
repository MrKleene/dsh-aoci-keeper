# AOCI keeper

## Install

```sh
dsh plugin add dsh-aoci-keeper          # from npm
dsh plugin add MrKleene/dsh-aoci-keeper # from source
```

DSH has no configurable stop hook, and AOCI's index maintenance is a model
action (`aoci_maintain`) rather than a background job. This plugin closes that
gap: it runs `aoci check` against the session's repository and, while the index
is unaligned, adds one notice to the messages entering a turn — the finding
count and the maintenance command. It never edits the index itself.

## How it works

1. At the start of a turn the plugin resolves the repository: the configured
   `repoRoot`, else the nearest ancestor of the session's `cwd` that holds an
   `aoci.txt`, else the nearest ancestor of the host process `cwd`.
2. It refreshes `aoci check --json` in the background when the cached result is
   older than `refreshIntervalMs`. A step never waits on the CLI.
3. If the cached result is not `governance_aligned` and has at least
   `minFindings` findings, it prepends one user-role notice with the count and
   the top finding kinds. The notice is scoped to the step, so it is not written
   to the session log.
4. Reminders are limited to one per turn and to one per `reminderCooldownMs`
   per repository.

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

Override in the profile's `cordis.patch.yml`; the row replaces the bundle's
whole `config`:

```yaml
- id: aoci-keeper
  config:
    command: /Users/me/.local/bin/aoci
    repoRoot: /Users/me/projects/example
```

## Requirements

- DSH `0.2.2-rc.3` or newer.
- The `aoci` CLI on the host. The plugin does nothing when the executable is
  missing: the check fails, the failure is cached, and no notice is added.
