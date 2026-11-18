# dsh-aoci-keeper

Keeps a repository's AOCI cognition index from silently drifting: while the index is unaligned, the
plugin adds **one** reminder line to the model input at the start of a turn, with the finding count and
the command that fixes it.

```text
AOCI 认知索引未对齐（governance_aligned=false）。
- findings: 84（stale 75 / pending 10 / missing 2）
- 本轮改动完成后：先 `aoci_maintain` 领取批次并提交，再 `aoci check` 确认归零
```

No index file is edited, nothing is auto-committed, and a step never waits on the CLI.

## What it does, and what it does not

| It does | It does not |
|---|---|
| Runs `aoci check` off the critical path and caches the result | Install the `aoci` binary |
| Prepends one reminder per turn while findings exist | Register the `aoci-code` MCP server in DSH |
| Stays silent when the index is aligned or unreachable | Run `aoci init` or `aoci scan` to create an index |
| Degrades to silence on any failure | Call `aoci_maintain` or write entries for you |

It is the *last* step of a five-step setup, not a replacement for the first four. If nothing is set up
yet, start with [Getting AOCI running on DSH first](#getting-aoci-running-on-dsh-first).

## Why this exists

I used `aoci-code` in Claude Code, where `aoci init --hooks` installs a `PreToolUse` guard and the host
has a lifecycle to hang it on. Then I moved to DSH, connected the same MCP server, and watched the index
rot: 84 findings accumulated over two weeks while every session started from a stale picture of the
repository.

Nothing was broken. The MCP server worked, the nine tools were there, `aoci_maintain` was callable. The
problem is that **MCP is pull**: it hands the model a tool and waits. A model that is mid-task does not
spontaneously decide to pay index debt, and DSH has no configurable stop hook to remind it. So the debt
is only paid when someone remembers to ask.

This plugin remembers. It makes the debt visible at exactly the moment it can still be paid — the start
of the next turn — and then gets out of the way.

## Why the aoci-code MCP alone is not enough

The AOCI-CODE README documents host integration per agent, and DSH falls into the last row:

| Host | Current integration | Boundary |
|---|---|---|
| **Other MCP hosts** | Connect to the standard stdio server | Require manual configuration and host-specific validation |

`aoci init --agent` accepts `claude`, `codex`, `cursor`, `opencode`, and `qoder`; `--hooks` installs
lifecycle hooks only for Claude Code (`PreToolUse`) and Codex (`SessionStart(compact)`). DSH appears
nowhere in the AOCI documentation, so on DSH the integration ends at "the tools are available" — there is
no event that fires after a turn and no hook to register.

That is the gap this plugin fills, and the only one it fills.

## Getting AOCI running on DSH first

Four steps, once per machine and once per repository. All commands below assume
`aoci` is at `/absolute/path/to/aoci`.

**1. Install the binary at a stable absolute path.**

Download the release archive for your platform from
[aoci-spec/aoci-code releases](https://github.com/aoci-spec/aoci-code/releases), verify it, and place
`aoci` somewhere that will not move, for example `~/.local/bin/aoci`:

```sh
chmod +x ~/.local/bin/aoci
~/.local/bin/aoci --version
```

The path matters: DSH launched from Finder does not inherit your shell `PATH`, so the MCP row and the
plugin config should both use the absolute path.

**2. Initialize the repository and build its baseline.**

```sh
cd /absolute/path/to/repo
/absolute/path/to/aoci --repo . init
/absolute/path/to/aoci --repo . scan
```

`init` writes the managed `AGENTS.md` rules block, the Git boundaries, and an empty index skeleton.
`scan` establishes the baseline. No host configuration is written for DSH — that is step 3.

**3. Register the MCP server in the DSH profile.**

Add this to `~/.dsh/profiles/<profile>/cordis.patch.yml` (a new entry needs `- insert:`, not a bare
`- id:`), then restart DSH:

```yaml
- insert:
    - id: mcp-aoci
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        transport: stdio
        serverName: aoci
        command: /absolute/path/to/aoci
        args: ['--repo', '/absolute/path/to/repo', 'mcp']
```

After the restart the session should list nine `aoci_*` tools. If it does not, the patch was not picked
up — the loader reads this file at startup, so an edit without a restart changes nothing.

**4. Let the model build the first index.**

Ask the agent to run `aoci_maintain` and author the returned batch with `aoci_update_entry`. That first
pass is the slow one; afterwards the index only drifts as you edit code.

Now install the keeper below, and the remaining drift gets surfaced on its own.

## Install the keeper

```sh
dsh plugin add dsh-aoci-keeper          # from npm
dsh plugin add MrKleene/dsh-aoci-keeper # from source
```

Requires DSH `0.2.2-rc.3` or newer (declared as `engines.dsh`), Node `>=20`, and the `aoci` CLI on the
host.

## When it helps, and when it does not

It helps when:

- the repository has an `aoci.txt` and the index is expected to stay aligned;
- you want drift surfaced without reading `aoci check` output yourself;
- you run long sessions where files change faster than the index.

It does nothing when `aoci` is missing, no `aoci.txt` is found, or the index is already aligned.

## How it works

1. At the start of a turn the plugin resolves the repository: the configured `repoRoot`, else the
   nearest ancestor of the session's `cwd` that holds an `aoci.txt`, else the nearest ancestor of the
   host process `cwd`.
2. It refreshes `aoci check --json` in the background when the cached result is older than
   `refreshIntervalMs`. A step never waits on the CLI.
3. If the cached result is not `governance_aligned` and has at least `minFindings` fixable findings,
   it prepends one user-role notice with the count and the top finding kinds. `code_skipped` findings
   (binaries the index deliberately cannot describe) are not counted, because the model cannot fix
   them. The notice is scoped to the step, so it is not written to the session log.
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

## Related plugins

[dsh-aoci-panel](https://github.com/donyue7/dsh-aoci-panel) is the human-facing side: it adds an AOCI
tab with index analytics, a diff ledger, visual editing and backup of `aoci.txt`, and binding
diagnostics (`aoci_bind_status`, `aoci_bind_repair`, `aoci_project_init`) for repositories that are not
wired up yet. It works when you open it; this plugin works every turn. Use the panel to set up or
inspect, this plugin to keep the index paid for.

## License

MIT
