import { atom, read, update } from 'claude-code'
import type { EngineInterface, PluginOptions, Register } from 'claude-code'

import type { Exchange } from '../types'

const PANE = 'aparte'
const TITLE = 'Aside'
const FIELD = 'pregunta'
const CLEAR = 'limpiar'
// Exchanges the pane keeps and draws; `maxHistory` says how many ride a prompt.
const KEPT = 12
// A Markdown element draws at most 10000 characters.
const MAX_ANSWER = 9000
// An earlier answer, as a later question's prompt carries it.
const MAX_CARRIED = 1200
// What a live answer is given of the transcript, and may write.
const LIVE_CHARS = 60000
const LIVE_TOKENS = 400
// A hairline between exchanges. The desktop draws it as an image, outside
// the theme: this grey reads on a dark and on a light pane alike.
const RULE =
  '<svg xmlns="http://www.w3.org/2000/svg" width="2000" height="9" viewBox="0 0 100 9" preserveAspectRatio="none">' +
  '<rect y="4" width="100" height="1" fill="#9c9a92" fill-opacity="0.3"/></svg>'

const exchanges = atom({ plugin: 'aparte', key: 'asked' } as const, [])

const INTRO = [
  'Esto es una pregunta aparte de Daniel sobre la conversación de arriba.',
  'No forma parte de la tarea: no la continúes, no propongas ediciones ni uses herramientas.',
  'Responde en español, breve y en prosa llana, solo con lo que ya está en la conversación;',
  'usa una lista únicamente si la pregunta pide enumerar.',
].join(' ')

const LIVE_SYSTEM =
  'Respondes preguntas aparte, de solo lectura, sobre una sesión de Claude Code a partir de su ' +
  'transcripción. Sin herramientas; no continúes la tarea; responde en español, breve y en prosa llana.'

const FAILURES: Record<string, string> = {
  'api-error': 'El modelo no pudo responder (error de la API). Prueba otra vez.',
  'empty-reply': 'El modelo no devolvió texto. Prueba otra vez.',
  aborted: 'La consulta se interrumpió. Prueba otra vez.',
}

type Settings = { liveFallback: boolean; liveModel: string; carried: number }

type Outcome = Pick<
  Exchange,
  'answer' | 'failure' | 'kind' | 'isQueued' | 'cacheRead' | 'fresh' | 'output'
>

const PENDING: Outcome = {
  answer: null,
  failure: null,
  kind: null,
  isQueued: false,
  cacheRead: 0,
  fresh: 0,
  output: 0,
}

const failed = (failure: string): Outcome => ({ ...PENDING, failure })

const settingsOf = (options: PluginOptions): Settings => ({
  liveFallback:
    typeof options.liveFallback === 'boolean' ? options.liveFallback : true,
  liveModel:
    typeof options.liveModel === 'string' && options.liveModel !== ''
      ? options.liveModel
      : 'haiku',
  carried:
    typeof options.maxHistory === 'number' && options.maxHistory >= 1
      ? Math.floor(options.maxHistory)
      : 8,
})

const compact = (n: number) =>
  n >= 1e6
    ? `${(n / 1e6).toFixed(2)}M`
    : n >= 1e3
      ? `${(n / 1e3).toFixed(1)}k`
      : `${n}`

const seconds = (ms: number) => `${(ms / 1000).toFixed(1).replace('.', ',')} s`

/** What an answer cost, in one dim line. */
const footer = (one: Exchange) =>
  [
    ...(one.kind === 'live' ? ['en vivo'] : []),
    seconds(one.ms),
    ...(one.cacheRead > 0 ? [`${compact(one.cacheRead)} de caché`] : []),
    // Paid in full: all of a live answer, or a fork whose cache had lapsed.
    ...(one.kind === 'live' || one.fresh >= 1000
      ? [`${compact(one.fresh)} sin caché`]
      : []),
    `${compact(one.output)} de salida`,
  ].join(' · ')

/**
 * The question as the model reads it. A fork takes one message, so the side
 * chat's own history rides in it: the last `carried` answered exchanges.
 */
const promptFor = (earlier: Exchange[], question: string, carried: number) =>
  [
    INTRO,
    ...earlier
      .flatMap(one =>
        one.answer === null
          ? []
          : [
              `Pregunta aparte anterior: ${one.question}\nTu respuesta: ${one.answer.slice(0, MAX_CARRIED)}`,
            ],
      )
      .slice(-carried),
    `Pregunta aparte: ${question}`,
  ].join('\n\n')

/** Before any turn has ended: a plain completion over the transcript's text. */
const answerLive = async (
  $: EngineInterface,
  prompt: string,
  cfg: Settings,
): Promise<Outcome> => {
  const messages = await $.session.messages()
  if (messages.length === 0) {
    return failed('Aún no hay nada que consultar: la conversación está vacía.')
  }
  const transcript = messages
    .map(one => `${one.role === 'user' ? 'USUARIO' : 'ASISTENTE'}: ${one.text}`)
    .join('\n\n')
    .slice(-LIVE_CHARS)
  const reply = await $.model.complete({
    model: cfg.liveModel,
    maxTokens: LIVE_TOKENS,
    system: LIVE_SYSTEM,
    prompt: `Conversación hasta ahora:\n\n${transcript}\n\n${prompt}`,
  })

  return reply.isAnswered
    ? {
        ...PENDING,
        answer: reply.text.slice(0, MAX_ANSWER),
        kind: 'live',
        cacheRead: reply.usage.cache_read_input_tokens,
        fresh:
          reply.usage.input_tokens + reply.usage.cache_creation_input_tokens,
        output: reply.usage.output_tokens,
      }
    : failed(FAILURES[reply.reason] ?? 'No hubo respuesta.')
}

/**
 * One fork of the session's transcript as of its last completed turn: the
 * main thread never sees the question, and the fork can call no tool.
 */
const answer = async (
  $: EngineInterface,
  prompt: string,
  cfg: Settings,
): Promise<Outcome> => {
  const reply = await $.model.fork({ prompt })
  if (reply.isAnswered) {
    return {
      ...PENDING,
      answer: reply.text.slice(0, MAX_ANSWER),
      kind: 'fork',
      cacheRead: reply.usage.cache_read_input_tokens,
      fresh: reply.usage.input_tokens + reply.usage.cache_creation_input_tokens,
      output: reply.usage.output_tokens,
    }
  }
  if (reply.reason !== 'nothing-to-fork') {
    return failed(FAILURES[reply.reason] ?? 'No hubo respuesta.')
  }

  return cfg.liveFallback
    ? answerLive($, prompt, cfg)
    : { ...PENDING, isQueued: true }
}

/** Answers the exchange `id` and writes down what came of it. */
const settle = async ($: EngineInterface, id: number, cfg: Settings) => {
  const [all, started] = await Promise.all([read($, exchanges), $.clock.now()])
  const entry = all.find(one => one.id === id)
  if (entry === undefined) return
  const earlier = all.filter(one => one.id < id)
  const outcome = await answer(
    $,
    promptFor(earlier, entry.question, cfg.carried),
    cfg,
  ).catch(() => failed('No se pudo enviar la pregunta.'))
  const ms = (await $.clock.now()) - started
  await update($, exchanges, list =>
    list.map(one => (one.id === id ? { ...one, ...outcome, ms } : one)),
  )
}

const ask = async ($: EngineInterface, text: string, cfg: Settings) => {
  const question = text.trim()
  if (question === '') return
  const [now, earlier] = await Promise.all([$.clock.now(), read($, exchanges)])
  // Two questions in one millisecond still get ids of their own.
  const id = Math.max(now, (earlier.at(-1)?.id ?? 0) + 1)
  await update($, exchanges, all =>
    [...all, { ...PENDING, id, question, ms: 0 }].slice(-KEPT),
  )
  await settle($, id, cfg)
}

/** Once a turn has ended there is a transcript to fork for what was waiting. */
const answerQueued = async ($: EngineInterface, cfg: Settings) => {
  const waiting = (await read($, exchanges)).filter(one => one.isQueued)
  for (const one of waiting) await settle($, one.id, cfg)
}

export const register: Register = (on, options) => {
  const cfg = settingsOf(options)
  // Work nobody waits on runs through the `$` of session.start, which
  // outlives the dispatch that asked for it. Absent until then.
  let background:
    | { ask: (question: string) => void; answerQueued: () => void }
    | undefined

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'aside',
      description:
        'Pregunta aparte sobre la conversación, sin gastar su contexto; "limpiar" borra el historial',
    })
    background = {
      ask: question => {
        void ask($, question, cfg)
      },
      answerQueued: () => {
        void answerQueued($, cfg)
      },
    }

    return next(e)
  })

  // Answers with no text: a line here would enter the main conversation.
  on('command.run', { command: 'aside' }, async ($, e) => {
    const text = e.args.trim()
    if (text.toLowerCase() === CLEAR) {
      await update($, exchanges, () => [])

      return {}
    }
    await $.ui.open({ id: PANE, title: TITLE, focus: true })
    if (background === undefined) await ask($, text, cfg)
    else background.ask(text)

    return {}
  })

  // The field and the button are answered here, not in closures on the
  // elements: a closure belongs to one drawing, and an Enter that lands while
  // the pane redraws would find it gone.
  on('ui.input', { plugin: 'aparte' }, async ($, e, next) => {
    if (e.kind !== 'submit' || !e.element.startsWith(FIELD)) return next(e)
    if (background === undefined) await ask($, e.value, cfg)
    else background.ask(e.value)

    return { element: e.element, value: e.value }
  })

  on('ui.press', { plugin: 'aparte' }, async ($, e, next) => {
    if (e.element !== CLEAR) return next(e)
    await update($, exchanges, () => [])

    return { element: e.element }
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      if (background === undefined) await answerQueued($, cfg)
      else background.answerQueued()
    }

    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e, next) => {
    if (e.surface === 'mobile') return next(e)
    const { Box, Text, Markdown, Input, Button } = $.ui.resolve(e)
    const list = [...(await read($, exchanges))].reverse()

    const rule = () => {
      if (e.surface === 'terminal') return null
      const { Svg } = $.ui.resolve(e)

      return <Svg source={RULE} alt="separador" height={9} />
    }

    return (
      <Box flexDirection="column" gap={1}>
        {/* A new key after each question draws the field empty again. */}
        <Input
          key={`${FIELD}-${list[0]?.id ?? 0}`}
          placeholder="Pregunta aparte…"
          submitLabel="↵"
          onSubmit={() => undefined}
        />
        {list.map((one, index) => (
          <Box flexDirection="column" gap={1}>
            {index > 0 && rule()}
            <Box flexDirection="column">
              <Text dimColor>{`› ${one.question}`}</Text>
              {one.answer !== null && <Markdown text={one.answer} />}
              {one.failure !== null && (
                <Text color="warning">{one.failure}</Text>
              )}
              {one.answer === null && one.failure === null && (
                <Text dimColor>
                  {one.isQueued
                    ? 'esperando a que termine el turno…'
                    : 'pensando…'}
                </Text>
              )}
              {one.answer !== null && <Text dimColor>{footer(one)}</Text>}
            </Box>
          </Box>
        ))}
        {list.length > 0 && (
          <Box flexDirection="row" justifyContent="flex-end">
            <Button
              key={CLEAR}
              label="Limpiar"
              plain
              dimColor
              onPress={() => undefined}
            />
          </Box>
        )}
      </Box>
    )
  })
}
