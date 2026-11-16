/**
 * aoci-keeper — keep an AOCI cognition index from silently drifting.
 *
 * DSH has no configurable stop hook, and AOCI's own index maintenance is a
 * model action (`aoci_maintain`), not a background job. This plugin closes the
 * gap the only way that is honest: it watches the repository's index health and
 * puts the finding count in front of the model at the start of a turn, so the
 * maintenance step lands before the model declares the task done.
 *
 * Zero dependencies on purpose: the plugin runs from the profile's node
 * resolution, where no @deepseek-ai/* package is guaranteed to exist.
 *
 * @module dsh-aoci-keeper
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export const name = 'aoci-keeper'

/** @type {{enabled:boolean, repoRoot:string, command:string, refreshIntervalMs:number, reminderCooldownMs:number, minFindings:number, timeoutMs:number, extraArgs:string[]}} */
const DEFAULTS = {
  enabled: true,
  repoRoot: '',
  command: 'aoci',
  refreshIntervalMs: 30_000,
  reminderCooldownMs: 120_000,
  minFindings: 1,
  timeoutMs: 20_000,
  extraArgs: [],
}

const CODE_LABELS = {
  code_stale: 'stale',
  code_missing: 'missing',
  code_unbaselined: 'unbaselined',
  code_skipped: 'skipped',
  observed_pending: 'pending',
  code_volume_unbaselined: 'volume-unbaselined',
}

/**
 * Resolve a bare command against PATH plus the usual user install locations.
 * A desktop app launched from Finder inherits a minimal PATH, so a plugin that
 * only trusts PATH works on the terminal and silently fails everywhere else.
 */
function resolveCommand(command) {
  if (command.includes('/')) return command
  const dirs = [
    ...(process.env.PATH ?? '').split(':'),
    join(homedir(), '.local', 'bin'),
    '/usr/local/bin',
    '/opt/homebrew/bin',
  ]
  for (const dir of dirs) {
    if (!dir) continue
    const candidate = join(dir, command)
    if (existsSync(candidate)) return candidate
  }
  return command
}

/** Walk up from a directory to the nearest folder holding an AOCI manifest. */
function findRepoRoot(start) {
  if (!start) return ''
  let dir = start
  for (let i = 0; i < 16; i += 1) {
    if (existsSync(join(dir, 'aoci.txt'))) return dir
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return ''
}

/** Run `aoci check --json` and fold the machine-readable answer into a snackable summary. */
function runCheck(repoRoot, config) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(config.command, ['--repo', repoRoot, 'check', '--json', ...config.extraArgs], {
        cwd: repoRoot,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      resolve({ ok: false, reason: String(error && error.message ? error.message : error) })
      return
    }

    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {
        // Already gone.
      }
    }, config.timeoutMs)

    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      resolve({ ok: false, reason: String(error && error.message ? error.message : error) })
    })
    child.on('close', () => {
      clearTimeout(timer)
      let parsed
      try {
        parsed = JSON.parse(stdout)
      } catch {
        resolve({ ok: false, reason: (stderr || stdout).trim().split('\n')[0] || 'aoci check produced no JSON' })
        return
      }
      const findings = Array.isArray(parsed.findings) ? parsed.findings : []
      const byCode = new Map()
      for (const finding of findings) {
        const code = typeof finding?.code === 'string' ? finding.code : 'other'
        byCode.set(code, (byCode.get(code) ?? 0) + 1)
      }
      resolve({
        ok: true,
        aligned: parsed.governance_aligned === true && parsed.ok === true,
        structureValid: parsed.structure_valid !== false,
        count: findings.length,
        byCode,
      })
    })
  })
}

/** One line naming the top three finding kinds, so the reminder is actionable, not just alarming. */
function describeFindings(byCode) {
  const parts = [...byCode.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([code, count]) => `${CODE_LABELS[code] ?? code} ${count}`)
  return parts.join(' / ')
}

/** The model-facing nudge. State and action only; no explanation of how AOCI works. */
function reminderText(summary) {
  const kinds = describeFindings(summary.byCode)
  return 'AOCI 认知索引未对齐（governance_aligned=false）。\n'
    + `- findings: ${summary.count}${kinds ? `（${kinds}）` : ''}\n`
    + '- 本轮改动完成后：先 `aoci_maintain` 领取批次并提交，再 `aoci check` 确认归零'
}

function deepFreeze(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const key of Object.keys(value)) deepFreeze(value[key])
  }
  return value
}

/** Build a context message the runtime accepts as a user-role notice. */
function noticeMessage(text, summary) {
  const kinds = describeFindings(summary.byCode)
  return deepFreeze({
    id: crypto.randomUUID(),
    role: 'user',
    content: Object.freeze([Object.freeze({ type: 'text', text })]),
    source: deepFreeze({
      kind: 'aoci-keeper',
      form: 'notice',
      summary: `aoci 索引待维护 · ${summary.count} findings${kinds ? ` (${kinds})` : ''}`.slice(0, 120),
    }),
  })
}

export function apply(ctx, rawConfig) {
  const config = { ...DEFAULTS, ...(rawConfig ?? {}) }
  if (!config.enabled) return
  if (typeof config.command !== 'string' || config.command.length === 0) {
    throw new Error('aoci-keeper: `command` must be a non-empty string')
  }
  config.command = resolveCommand(config.command)

  /** @type {Map<string, {at:number, pending:Promise<void>|null, summary:{ok:boolean, aligned?:boolean, count?:number, byCode?:Map<string,number>, reason?:string}}>} */
  const cache = new Map()
  /** Last reminder per repository: time + turn pair, so one turn gets one nudge. */
  const lastReminder = new Map()

  function repoFor(agent) {
    const fromConfig = typeof config.repoRoot === 'string' && config.repoRoot.length > 0 ? config.repoRoot : ''
    if (fromConfig) return findRepoRoot(fromConfig) || fromConfig
    const cwd = agent?.session?.header?.cwd
    if (typeof cwd === 'string' && cwd.length > 0) {
      const detected = findRepoRoot(cwd)
      if (detected) return detected
    }
    return findRepoRoot(process.cwd())
  }

  function refresh(repoRoot) {
    const entry = cache.get(repoRoot)
    const now = Date.now()
    if (entry) {
      if (entry.pending) return entry.pending
      if (now - entry.at < config.refreshIntervalMs) return Promise.resolve()
    }
    const pending = runCheck(repoRoot, config)
      .then((summary) => {
        cache.set(repoRoot, { at: Date.now(), pending: null, summary })
      })
      .catch(() => {
        cache.set(repoRoot, { at: Date.now(), pending: null, summary: { ok: false, reason: 'check failed' } })
      })
    cache.set(repoRoot, { at: entry?.at ?? 0, pending, summary: entry?.summary ?? { ok: false } })
    return pending
  }

  ctx.on('agent/pre-step', async ({ agent, step, turn }, next) => {
    const decision = await next()
    if (decision.kind !== 'enter') return decision
    const repoRoot = repoFor(agent)
    if (!repoRoot) return decision

    const entry = cache.get(repoRoot)
    // Refresh in the background: the current step must never wait on a CLI run.
    if (!entry || Date.now() - entry.at >= config.refreshIntervalMs) void refresh(repoRoot)
    if (!entry?.summary?.ok || entry.summary.aligned) return decision
    if ((entry.summary.count ?? 0) < config.minFindings) return decision

    const mark = lastReminder.get(repoRoot)
    if (mark && mark.turn === turn && mark.repo === repoRoot) return decision
    if (mark && Date.now() - mark.at < config.reminderCooldownMs) return decision

    lastReminder.set(repoRoot, { at: Date.now(), turn, repo: repoRoot })
    const message = noticeMessage(reminderText(entry.summary), entry.summary)
    return { ...decision, messages: [message, ...decision.messages] }
  })
}
