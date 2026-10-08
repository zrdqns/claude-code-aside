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

    return { value: said('Respuesta en vivo.') as never }
  })
  on('session.messages', () => ({ value: transcript as never }))
  on('turn.complete', () => ({ text: '' }))

  return { prompts, lives, opened }
}

const mount = ($: Engine, surface: 'terminal' | 'desktop' = 'desktop') =>
  $.ui.mount({
    plugin: 'aparte',
    surface,
    component: 'Pane',
    requestId: 'aparte',
    props: PANE,
  })

const run = ($: Engine, args: string) =>
  $.command.run({ command: 'aside', args } as never)

for (const surface of ['terminal', 'desktop'] as const) {
  test(`pregunta desde el campo y dibuja la respuesta en ${surface}`, async ($, on) => {
    const w = world(on, [said('Usamos **UTC**.')])
    const pane = await mount($, surface)
    expect(await pane.find({ type: 'Text' })).toBeUndefined()
    expect(await pane.find({ type: 'Button' })).toBeUndefined()

    await pane.input({ key: 'pregunta-0', text: '  ¿Qué zona horaria usamos?  ' })

    expect(w.prompts).toHaveLength(1)
    expect(w.prompts[0]).toMatch(/Pregunta aparte: ¿Qué zona horaria usamos\?$/)
    expect(w.prompts[0]).toMatch(/no propongas ediciones ni uses herramientas/)
    expect(await pane.find({ type: 'Text', text: '› ¿Qué zona horaria usamos?' })).toBeDefined()
    expect(await pane.find({ type: 'Markdown', text: 'Usamos **UTC**.' })).toBeDefined()
    expect(await pane.find({ text: '4,2 s · 72.8k de caché · 120 de salida' })).toBeDefined()
    expect(await pane.find({ type: 'Input', key: 'pregunta-0' })).toBeUndefined()
    await pane.unmount()
  })
}

test('/aside abre el panel, pregunta y no deja texto en la conversación', async ($, on) => {
  const w = world(on, [said('Primera.'), said('Segunda.')])

  const first = await run($, '¿uno?')
  expect(first.text).toBeUndefined()
  expect(w.opened).toHaveLength(1)
  const pane = await mount($)
  expect(await pane.find({ type: 'Markdown', text: 'Primera.' })).toBeDefined()

  await run($, '¿dos?')
  expect(w.prompts[1]).toMatch(/Pregunta aparte anterior: ¿uno\?\nTu respuesta: Primera\./)
  const texts = (await pane.findAll({ type: 'Text' })).map(found => found.text)
  expect(texts.indexOf('› ¿dos?')).toBeLessThan(texts.indexOf('› ¿uno?'))
  expect(await pane.find({ type: 'Svg' })).toBeDefined()

  await run($, '   ')
  expect(w.prompts).toHaveLength(2)
  await pane.unmount()
})

test('el botón Limpiar y /aside limpiar borran el historial', async ($, on) => {
  world(on, [said('Una.'), said('Otra.')])
  const pane = await mount($)

  await run($, '¿uno?')
  await pane.press({ key: 'limpiar' })
  expect(await pane.find({ text: '› ¿uno?' })).toBeUndefined()

  await run($, '¿dos?')
  const cleared = await run($, 'limpiar')
  expect(cleared.text).toBeUndefined()
  expect(await pane.find({ text: '› ¿dos?' })).toBeUndefined()
  await pane.unmount()
})

test('lleva en cada pregunta solo los últimos intercambios que diga la opción', { options: { maxHistory: 1 } }, async ($, on) => {
  const w = world(on, [said('A.'), said('B.'), said('C.')])

  await run($, '¿uno?')
  await run($, '¿dos?')
  await run($, '¿tres?')

  expect(w.prompts[2]).toMatch(/Pregunta aparte anterior: ¿dos\?/)
  expect(w.prompts[2]).not.toMatch(/¿uno\?/)
})

test('antes del primer turno responde en vivo con el modelo ligero', async ($, on) => {
  const w = world(on, [NOTHING], [
    { role: 'user', text: 'Arregla el login', toolUses: [] },
    { role: 'assistant', text: 'Reviso el formulario.', toolUses: [] },
  ])
  const pane = await mount($)

  await run($, '¿qué pedí?')

  expect(w.lives).toHaveLength(1)
  expect(w.lives[0]?.model).toBe('haiku')
  expect(w.lives[0]?.maxTokens).toBe(400)
  expect(w.lives[0]?.prompt).toMatch(/USUARIO: Arregla el login\n\nASISTENTE: Reviso el formulario\./)
  expect(w.lives[0]?.prompt).toMatch(/Pregunta aparte: ¿qué pedí\?$/)
  expect(await pane.find({ type: 'Markdown', text: 'Respuesta en vivo.' })).toBeDefined()
  expect(await pane.find({ text: /^en vivo · .* · 40 sin caché · 120 de salida$/ })).toBeDefined()
  await pane.unmount()
})

test('con la conversación vacía lo dice en vez de preguntar', async ($, on) => {
  const w = world(on, [NOTHING])
  const pane = await mount($)

  await run($, '¿hola?')

  expect(w.lives).toHaveLength(0)
  expect(await pane.find({ text: /la conversación está vacía/ })).toBeDefined()
  await pane.unmount()
})

test('sin respuesta en vivo, la pregunta espera y se responde al terminar el turno', { options: { liveFallback: false } }, async ($, on) => {
  const w = world(on, [NOTHING, said('Ahora sí.')])
  const pane = await mount($)

  await run($, '¿y esto?')
  expect(w.lives).toHaveLength(0)
  expect(await pane.find({ text: 'esperando a que termine el turno…' })).toBeDefined()

  await $.turn.complete({
    answer: 'listo',
    durationMs: 10,
    isAborted: false,
    turnId: 't1',
    reason: 'answer',
  } as never)

  expect(w.prompts).toHaveLength(2)
  expect(await pane.find({ type: 'Markdown', text: 'Ahora sí.' })).toBeDefined()
  await pane.unmount()
})

test('explica por qué no hubo respuesta', async ($, on) => {
  world(on, [{ isAnswered: false, reason: 'api-error', status: 529, error: 'overloaded', usage: USAGE }])
  const pane = await mount($)

  await run($, '¿otra?')

  expect(await pane.find({ text: /error de la API/ })).toBeDefined()
  await pane.unmount()
})
