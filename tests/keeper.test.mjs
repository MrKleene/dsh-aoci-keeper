import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { apply } from '../index.js'

const stub = resolve(import.meta.dirname, 'fixtures/aoci-stub.sh')

/** A repository-shaped temp dir with an aoci.txt at its root. */
function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'aoci-keeper-'))
  writeFileSync(join(dir, 'aoci.txt'), '#Volume: id=meta\n')
  chmodSync(stub, 0o755)
  return dir
}

/** Minimal cordis context: capture the pre-step listener and dispose it on demand. */
function mount(config) {
  const listeners = new Map()
  const ctx = {
    on(name, handler) {
      listeners.set(name, handler)
      return () => listeners.delete(name)
    },
  }
  apply(ctx, config)
  return listeners.get('agent/pre-step')
}

const enter = () => ({ kind: 'enter', messages: [] })
const payload = (cwd, turn) => ({ agent: { session: { header: { cwd } } }, turn, step: 1, messages: [] })

/** Poll pre-step with advancing turns until the background check lands and a notice appears. */
async function waitForNotice(pre, cwd) {
  for (let turn = 1; turn <= 40; turn += 1) {
    const decision = await pre(payload(cwd, turn), async () => enter())
    if (decision.messages.length > 0) return { decision, turn }
    await new Promise((done) => setTimeout(done, 50))
  }
  throw new Error('no notice after 40 steps')
}

test('silent on the first step because the first check is still running', async () => {
  const repo = makeRepo()
  const pre = mount({ command: stub, repoRoot: repo })
  const decision = await pre(payload(repo, 1), async () => enter())
  assert.equal(decision.messages.length, 0)
})

test('adds one notice once the cached check reports findings', async () => {
  const repo = makeRepo()
  const pre = mount({ command: stub, repoRoot: repo, reminderCooldownMs: 0 })
  const { decision } = await waitForNotice(pre, repo)
  const message = decision.messages[0]
  assert.equal(message.role, 'user')
  assert.equal(message.source.kind, 'aoci-keeper')
  assert.match(message.content[0].text, /findings: 3/)
  assert.match(message.content[0].text, /stale 2/)
  assert.equal(Object.isFrozen(message), true)
})

test('does not repeat the notice inside one turn', async () => {
  const repo = makeRepo()
  const pre = mount({ command: stub, repoRoot: repo, reminderCooldownMs: 0 })
  const { decision: first, turn } = await waitForNotice(pre, repo)
  const repeated = await pre(payload(repo, turn), async () => enter())
  assert.equal(first.messages.length, 1)
  assert.equal(repeated.messages.length, 0)
})

test('never rewrites a rejected step', async () => {
  const repo = makeRepo()
  const pre = mount({ command: stub, repoRoot: repo, reminderCooldownMs: 0 })
  await waitForNotice(pre, repo)
  const decision = await pre(payload(repo, 41), async () => ({ kind: 'reject' }))
  assert.deepEqual(decision, { kind: 'reject' })
})

test('stays silent when no repository can be found', async () => {
  const pre = mount({ command: stub, repoRoot: '' })
  const decision = await pre({ agent: { session: { header: {} } }, turn: 1, step: 1, messages: [] }, async () => enter())
  assert.equal(decision.messages.length, 0)
})

test('a missing executable degrades to silence instead of throwing', async () => {
  const repo = makeRepo()
  const pre = mount({ command: join(repo, 'no-such-aoci'), repoRoot: repo, reminderCooldownMs: 0 })
  for (let turn = 1; turn <= 6; turn += 1) {
    const decision = await pre(payload(repo, turn), async () => enter())
    assert.equal(decision.messages.length, 0)
    await new Promise((done) => setTimeout(done, 50))
  }
})


test('skipped binaries are not counted as debt the model can pay', async () => {
  const repo = makeRepo()
  const pre = mount({
    command: resolve(import.meta.dirname, 'fixtures/aoci-stub-skipped.sh'),
    repoRoot: repo,
    reminderCooldownMs: 0,
  })
  const { decision } = await waitForNotice(pre, repo)
  const text = decision.messages[0].content[0].text
  assert.match(text, /findings: 1/)
  assert.doesNotMatch(text, /skipped/)
})

test('an aligned index with only skipped findings stays silent', async () => {
  const repo = makeRepo()
  const pre = mount({
    command: resolve(import.meta.dirname, 'fixtures/aoci-stub-aligned-skipped.sh'),
    repoRoot: repo,
    reminderCooldownMs: 0,
  })
  for (let turn = 1; turn <= 8; turn += 1) {
    const decision = await pre(payload(repo, turn), async () => enter())
    assert.equal(decision.messages.length, 0)
    await new Promise((done) => setTimeout(done, 50))
  }
})
