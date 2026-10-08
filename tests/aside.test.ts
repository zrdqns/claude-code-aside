import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

const PANE = {
  title: 'Aside',
  isFocused: true,
  bodyColumns: 40,
  placement: 'dock',
  scroll: { top: 0, rows: 30, total: 30 },
} as never

const USAGE = {
  input_tokens: 40,
  output_tokens: 120,
  cache_read_input_tokens: 72800,
  cache_creation_input_tokens: 0,
}

const NOTHING = { isAnswered: false, reason: 'nothing-to-fork' }
const said = (text: string) => ({ isAnswered: true, text, usage: USAGE })

/**
 * A model that answers each fork with the next reply and keeps what it was
 * asked; every answer takes 4.2 seconds.
 */
const world = (on: On, forks: unknown[], transcript: unknown[] = []) => {
  const clock = mock.clock(on, { now: 1000 })
  const prompts: string[] = []
  const lives: { model: string; prompt: string; system?: string; maxTokens?: number }[] = []
  const opened: unknown[] = []
  on('ui.open', (_, e) => {
    opened.push(e)

    return { value: { isOpen: true } as never }
  })
  on('model.fork', async (_, e) => {
    prompts.push(e.prompt)
    await clock.set(clock.now() + 4200)

    return { value: forks[prompts.length - 1] as never }
  })
  on('model.complete', (_, e) => {
    lives.push(e)

    return { value: said('Live answer.') as never }
  })
  on('session.messages', () => ({ value: transcript as never }))
  on('turn.complete', () => ({ text: '' }))

  return { prompts, lives, opened }
}

const mount = ($: Engine, surface: 'terminal' | 'desktop' = 'desktop') =>
  $.ui.mount({
    plugin: 'aside',
    surface,
    component: 'Pane',
    requestId: 'aside',
    props: PANE,
  })

const run = ($: Engine, args: string) =>
  $.command.run({ command: 'aside', args } as never)

for (const surface of ['terminal', 'desktop'] as const) {
  test(`asks from the field and draws the answer on ${surface}`, async ($, on) => {
    const w = world(on, [said('We use **UTC**.')])
    const pane = await mount($, surface)
    expect(await pane.find({ type: 'Text' })).toBeUndefined()
    expect(await pane.find({ type: 'Button' })).toBeUndefined()

    await pane.input({ key: 'question-0', text: '  Which time zone do we use?  ' })

    expect(w.prompts).toHaveLength(1)
    expect(w.prompts[0]).toMatch(/Aside question: Which time zone do we use\?$/)
    expect(w.prompts[0]).toMatch(/do not propose edits or use tools/)
    expect(await pane.find({ type: 'Text', text: '› Which time zone do we use?' })).toBeDefined()
    expect(await pane.find({ type: 'Markdown', text: 'We use **UTC**.' })).toBeDefined()
    expect(await pane.find({ text: '4.2 s · 72.8k cached · 120 output' })).toBeDefined()
    expect(await pane.find({ type: 'Input', key: 'question-0' })).toBeUndefined()
    await pane.unmount()
  })
}

test('/aside opens the pane, asks and leaves no text in the conversation', async ($, on) => {
  const w = world(on, [said('First.'), said('Second.')])

  const first = await run($, 'one?')
  expect(first.text).toBeUndefined()
  expect(w.opened).toHaveLength(1)
  const pane = await mount($)
  expect(await pane.find({ type: 'Markdown', text: 'First.' })).toBeDefined()

  await run($, 'two?')
  expect(w.prompts[1]).toMatch(/Earlier aside question: one\?\nYour answer: First\./)
  const texts = (await pane.findAll({ type: 'Text' })).map(found => found.text)
  expect(texts.indexOf('› two?')).toBeLessThan(texts.indexOf('› one?'))
  expect(await pane.find({ type: 'Svg' })).toBeDefined()

  await run($, '   ')
  expect(w.prompts).toHaveLength(2)
  await pane.unmount()
})

test('the Clear button and /aside clear wipe the history', async ($, on) => {
  world(on, [said('One.'), said('Another.')])
  const pane = await mount($)

  await run($, 'one?')
  await pane.press({ key: 'clear' })
  expect(await pane.find({ text: '› one?' })).toBeUndefined()

  await run($, 'two?')
  const cleared = await run($, 'clear')
  expect(cleared.text).toBeUndefined()
  expect(await pane.find({ text: '› two?' })).toBeUndefined()
  await pane.unmount()
})

test('carries in each question only as many earlier exchanges as the option says', { options: { maxHistory: 1 } }, async ($, on) => {
  const w = world(on, [said('A.'), said('B.'), said('C.')])

  await run($, 'one?')
  await run($, 'two?')
  await run($, 'three?')

  expect(w.prompts[2]).toMatch(/Earlier aside question: two\?/)
  expect(w.prompts[2]).not.toMatch(/one\?/)
})

test('before the first turn it answers live with the light model', async ($, on) => {
  const w = world(on, [NOTHING], [
    { role: 'user', text: 'Fix the login', toolUses: [] },
    { role: 'assistant', text: 'Checking the form.', toolUses: [] },
  ])
  const pane = await mount($)

  await run($, 'what did I ask?')

  expect(w.lives).toHaveLength(1)
  expect(w.lives[0]?.model).toBe('haiku')
  expect(w.lives[0]?.maxTokens).toBe(400)
  expect(w.lives[0]?.prompt).toMatch(/USER: Fix the login\n\nASSISTANT: Checking the form\./)
  expect(w.lives[0]?.prompt).toMatch(/Aside question: what did I ask\?$/)
  expect(await pane.find({ type: 'Markdown', text: 'Live answer.' })).toBeDefined()
  expect(await pane.find({ text: /^live · .* · 40 uncached · 120 output$/ })).toBeDefined()
  await pane.unmount()
})

test('with the conversation empty it says so instead of asking', async ($, on) => {
  const w = world(on, [NOTHING])
  const pane = await mount($)

  await run($, 'hello?')

  expect(w.lives).toHaveLength(0)
  expect(await pane.find({ text: /the conversation is empty/ })).toBeDefined()
  await pane.unmount()
})

test('with no live answer, the question waits and is answered when the turn ends', { options: { liveFallback: false } }, async ($, on) => {
  const w = world(on, [NOTHING, said('Now it can.')])
  const pane = await mount($)

  await run($, 'and this?')
  expect(w.lives).toHaveLength(0)
  expect(await pane.find({ text: 'waiting for the turn to end…' })).toBeDefined()

  await $.turn.complete({
    answer: 'done',
    durationMs: 10,
    isAborted: false,
    turnId: 't1',
    reason: 'answer',
  } as never)

  expect(w.prompts).toHaveLength(2)
  expect(await pane.find({ type: 'Markdown', text: 'Now it can.' })).toBeDefined()
  await pane.unmount()
})

test('explains why there was no answer', async ($, on) => {
  world(on, [{ isAnswered: false, reason: 'api-error', status: 529, error: 'overloaded', usage: USAGE }])
  const pane = await mount($)

  await run($, 'another?')

  expect(await pane.find({ text: /API error/ })).toBeDefined()
  await pane.unmount()
})
