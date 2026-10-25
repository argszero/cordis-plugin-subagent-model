/**
 * Behaviour tests against a real `@deepseek-ai/cordis` context.
 *
 * Real plugin injection (`inject: ['tools']`), real waterfall dispatch, real
 * `@deepseek-ai/dsh-tools` argument validation: only the Agent and the session
 * are stand-ins, because the plug-in contract reads exactly three things from
 * them (`session.header`, `options`, and `session.requestHeader()`).
 *
 * The decisive observation in every case is the value that LEAVES the handler —
 * the config the agent loop would hand to the provider — never the plugin's own
 * description of itself.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context, Service } from '@deepseek-ai/cordis'
import { apply, inject, name, Config } from '../lib/index.js'

/** The tools registry this plugin injects; the real one adds routing we do not need here. */
class FakeTools extends Service {
  constructor(ctx) {
    super(ctx, 'tools')
    this.registered = []
  }

  register(tool) {
    this.registered.push(tool)
    return () => {}
  }
}

/** Mount the plugin (and its tools service) on a real Context. */
async function mount(config = {}) {
  const ctx = new Context()
  await ctx.plugin(FakeTools)
  await ctx.plugin({ name, inject, apply, Config }, config)
  return { ctx, tools: ctx.tools.registered }
}

function sessionOf(id, header, requestHeaderValue) {
  return {
    id,
    header: { id, version: 1, createdAt: 0, isSeeded: false, ...header },
    requestHeader: () => requestHeaderValue,
  }
}

/**
 * A delegated child: depth 1, marked as a subagent child by its durable header,
 * and carrying the route its delegation inherited exactly as
 * `resolveChildAgentOptions` resolves it.
 */
function child({
  id = 'child-1',
  options = { provider: 'parent-route', model: 'parent-model' },
  header = {},
  requestHeader,
} = {}) {
  return { id, options, session: sessionOf(id, { delegationDepth: 1, origin: 'subagent', ...header }, requestHeader) }
}

/** A top-level agent: no delegation depth anywhere. */
function root({ id = 'root-1', options = {}, requestHeader } = {}) {
  return { id, options, session: sessionOf(id, {}, requestHeader) }
}

const signal = new AbortController().signal

/** Dispatch the real `agent/request` waterfall; `seed` is what the loop proposed. */
function request(ctx, agent, seed) {
  return ctx.waterfall('agent/request', { agent, turn: 1, step: 1, signal }, () => Promise.resolve(seed))
}

/** Dispatch the real `agent/pre-step` waterfall with the loop's own next. */
function preStep(ctx, agent, messages, step = 1) {
  return ctx.waterfall(
    'agent/pre-step',
    { agent, messages, turn: 1, step, signal },
    () => Promise.resolve({ kind: 'enter', messages }),
  )
}

const INHERITED = { provider: 'parent-route', model: 'parent-model', maxTokens: 4096 }
const message = { id: 'm1', role: 'user', content: [{ type: 'text', text: 'do the thing' }] }

test('a subagent request takes the configured route and keeps every other field', async () => {
  const { ctx } = await mount({ provider: 'sub-route', model: 'sub-model' })
  const resolved = await request(ctx, child(), INHERITED)
  assert.equal(resolved.provider, 'sub-route')
  assert.equal(resolved.model, 'sub-model')
  assert.equal(resolved.maxTokens, 4096, 'fields the selection does not name survive untouched')
})

test('a top-level request is not touched by the selection', async () => {
  const { ctx } = await mount({ provider: 'sub-route', model: 'sub-model' })
  const resolved = await request(ctx, root(), INHERITED)
  assert.deepEqual(resolved, INHERITED)
})

test('a subagent with no selection keeps the inherited config, object-identical', async () => {
  const { ctx } = await mount({})
  const resolved = await request(ctx, child(), INHERITED)
  assert.equal(resolved, INHERITED, 'no selection means no rewrite at all')
})

test('a model-only selection keeps the inherited provider', async () => {
  const { ctx } = await mount({ model: 'sub-model' })
  const resolved = await request(ctx, child(), INHERITED)
  assert.equal(resolved.provider, 'parent-route')
  assert.equal(resolved.model, 'sub-model')
})

test('a route change without a named effort clears the inherited effort', async () => {
  const { ctx } = await mount({ model: 'sub-model' })
  const resolved = await request(ctx, child(), { ...INHERITED, reasoningEffort: 'high' })
  assert.equal(resolved.model, 'sub-model')
  assert.equal('reasoningEffort' in resolved, false, 'the effort belonged to the replaced route')
})

test('an effort-only selection keeps the resolved route', async () => {
  const { ctx } = await mount({ reasoningEffort: 'off' })
  const resolved = await request(ctx, child(), { ...INHERITED, reasoningEffort: 'high' })
  assert.equal(resolved.provider, 'parent-route')
  assert.equal(resolved.model, 'parent-model')
  assert.equal(resolved.reasoningEffort, 'off')
})

test('a route change with a named effort applies both', async () => {
  const { ctx } = await mount({ model: 'sub-model', reasoningEffort: 'max' })
  const resolved = await request(ctx, child(), { ...INHERITED, reasoningEffort: 'high' })
  assert.equal(resolved.model, 'sub-model')
  assert.equal(resolved.reasoningEffort, 'max')
})

test('a runtime depth option alone also marks an agent as delegated', async () => {
  const { ctx } = await mount({ model: 'sub-model' })
  const adopted = { id: 'resumed-child', options: { subagentDepth: 1 }, session: sessionOf('resumed-child', {}, undefined) }
  const resolved = await request(ctx, adopted, { provider: 'parent-route', model: 'parent-model' })
  assert.equal(resolved.model, 'sub-model')
})

test('a selection set at runtime reaches the next request of a running child', async () => {
  const { ctx, tools } = await mount({ model: 'before' })
  const running = child()
  assert.equal((await request(ctx, running, INHERITED)).model, 'before')
  await tools[0].execute({ action: 'set', model: 'after' }, { agent: root() })
  assert.equal((await request(ctx, running, INHERITED)).model, 'after', 'the same child follows on its next step')
})

test('a subagent may read the selection but not write it', async () => {
  const { ctx, tools } = await mount({ model: 'before' })
  const report = await tools[0].execute({ action: 'get' }, { agent: child() })
  assert.equal(report.selection, 'model=before', 'the report names exactly the fields the selection sets')
  assert.equal(report.role, 'subagent')
  assert.equal(report.route, 'parent-route/before', 'the selection names the model, the delegation the provider')
  assert.equal(report.source, 'selection')
  await assert.rejects(
    () => tools[0].execute({ action: 'set', model: 'sneaky' }, { agent: child() }),
    /only a top-level agent may write it/,
  )
  assert.equal((await request(ctx, child(), INHERITED)).model, 'before', 'the refusal changed nothing')
})

test('the tool reports the root caller and its live selection', async () => {
  const { tools } = await mount({ provider: 'sub-route', model: 'sub-model' })
  const report = await tools[0].execute({ action: 'get' }, { agent: root() })
  assert.deepEqual(report, {
    action: 'get',
    role: 'root agent',
    selection: 'provider=sub-route model=sub-model',
    route: 'sub-route/sub-model',
    source: 'unset',
  })
  assert.match(tools[0].output.render({}, report)[0].text, /subagents run on provider=sub-route model=sub-model/)
})

test('an empty mount observes: subagents inherit, and the tool says so', async () => {
  const { tools } = await mount({})
  const report = await tools[0].execute({ action: 'get' }, { agent: root() })
  assert.equal(report.selection, 'none')
  assert.match(tools[0].output.render({}, report)[0].text, /subagents inherit the parent route/)
})

test('set without a field is refused instead of silently doing nothing', async () => {
  const { tools } = await mount({})
  await assert.rejects(
    () => tools[0].execute({ action: 'set' }, { agent: root() }),
    /requires at least one of provider, model, or reasoning_effort/,
  )
})

test('clear returns every subagent to inherited routing', async () => {
  const { ctx, tools } = await mount({ model: 'sub-model' })
  assert.equal((await request(ctx, child(), INHERITED)).model, 'sub-model')
  const cleared = await tools[0].execute({ action: 'set', clear: true }, { agent: root() })
  assert.equal(cleared.selection, 'none')
  assert.equal((await request(ctx, child(), INHERITED)).model, 'parent-model')
})

test('the tool rejects arguments the schema does not allow', async () => {
  const { tools } = await mount({})
  await assert.rejects(() => tools[0].execute({ action: 'destroy' }, { agent: root() }), /action/)
})

test('the first admitted child step carries the route notice', async () => {
  const { ctx } = await mount({})
  const decision = await preStep(ctx, child(), [message])
  assert.equal(decision.messages.length, 2)
  const notice = decision.messages[1]
  assert.equal(notice.content[0].text, '[subagent model: parent-route/parent-model]')
  assert.equal(notice.source.kind, 'subagent-model')
  assert.equal(notice.source.plugin, 'subagent-model')
  assert.equal(notice.source.form, 'notice')
  assert.equal(decision.messages[0], message, 'the delegated prompt stays first')
})

test('the notice is not repeated on the following steps', async () => {
  const { ctx } = await mount({})
  const agent = child()
  assert.equal((await preStep(ctx, agent, [message])).messages.length, 2)
  assert.equal((await preStep(ctx, agent, [message], 2)).messages.length, 1)
})

test('a route change after a request announces the boundary', async () => {
  const { ctx, tools } = await mount({})
  const agent = child({ requestHeader: { config: { provider: 'parent-route', model: 'parent-model' } } })
  await preStep(ctx, agent, [message])
  await tools[0].execute({ action: 'set', model: 'later-model' }, { agent: root() })
  const decision = await preStep(ctx, agent, [message], 2)
  assert.match(
    decision.messages[1].content[0].text,
    /^\[model changed: assistant turns above this point were generated by parent-route\/parent-model; the session continues with parent-route\/later-model\]$/,
  )
})

test('a root agent never receives a route notice', async () => {
  const { ctx } = await mount({ model: 'sub-model' })
  const decision = await preStep(ctx, root(), [message])
  assert.equal(decision.messages.length, 1)
})

test('announce: false routes silently', async () => {
  const { ctx } = await mount({ model: 'sub-model', announce: false })
  const agent = child()
  assert.equal((await preStep(ctx, agent, [message])).messages.length, 1)
  assert.equal((await request(ctx, agent, INHERITED)).model, 'sub-model', 'routing is unaffected')
})

test('a child whose route cannot be resolved is not announced', async () => {
  const { ctx } = await mount({})
  const unresolved = { id: 'bare', options: {}, session: sessionOf('bare', { delegationDepth: 1 }, undefined) }
  assert.equal((await preStep(ctx, unresolved, [message])).messages.length, 1)
})

test('an empty step is skipped, matching the loop\'s own notice rule', async () => {
  const { ctx } = await mount({})
  assert.equal((await preStep(ctx, child(), [])).messages.length, 0)
})

test('a rejected decision is passed through untouched', async () => {
  const { ctx } = await mount({})
  const decision = await ctx.waterfall(
    'agent/pre-step',
    { agent: child(), messages: [message], turn: 1, step: 1, signal },
    () => Promise.resolve({ kind: 'reject' }),
  )
  assert.deepEqual(decision, { kind: 'reject' })
})

test('a disposed child forgets its announced route', async () => {
  const { ctx } = await mount({})
  const agent = child()
  await preStep(ctx, agent, [message])
  await ctx.parallel('agent/disposed', { agent })
  assert.equal((await preStep(ctx, agent, [message])).messages.length, 2, 'a new run announces again')
})
