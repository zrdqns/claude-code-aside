import { atom, read, update } from 'claude-code'
import type { EngineInterface, PluginOptions, Register } from 'claude-code'

import type { Exchange } from '../types'

const PANE = 'aside'
const TITLE = 'Aside'
const FIELD = 'question'
const CLEAR = 'clear'
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

const exchanges = atom({ plugin: 'aside', key: 'asked' } as const, [])

const INTRO = [
  'This is an aside question from the user about the conversation above.',
  'It is not part of the task: do not continue it, do not propose edits or use tools.',
  'Answer in the language of the question, briefly and in plain prose, only with what is already in the conversation;',
  'use a list only if the question asks for an enumeration.',
].join(' ')

const LIVE_SYSTEM =
  'You answer read-only aside questions about a Claude Code session from its ' +
  'transcript. No tools; do not continue the task; answer in the language of the question, briefly and in plain prose.'

const FAILURES: Record<string, string> = {
  'api-error': 'The model could not answer (API error). Try again.',
  'empty-reply': 'The model returned no text. Try again.',
  aborted: 'The query was interrupted. Try again.',
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

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`

/** What an answer cost, in one dim line. */
const footer = (one: Exchange) =>
  [
    ...(one.kind === 'live' ? ['live'] : []),
    seconds(one.ms),
    ...(one.cacheRead > 0 ? [`${compact(one.cacheRead)} cached`] : []),
    // Paid in full: all of a live answer, or a fork whose cache had lapsed.
    ...(one.kind === 'live' || one.fresh >= 1000
      ? [`${compact(one.fresh)} uncached`]
      : []),
    `${compact(one.output)} output`,
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
              `Earlier aside question: ${one.question}\nYour answer: ${one.answer.slice(0, MAX_CARRIED)}`,
            ],
      )
      .slice(-carried),
    `Aside question: ${question}`,
  ].join('\n\n')

/** Before any turn has ended: a plain completion over the transcript's text. */
const answerLive = async (
  $: EngineInterface,
  prompt: string,
  cfg: Settings,
): Promise<Outcome> => {
  const messages = await $.session.messages()
  if (messages.length === 0) {
    return failed('Nothing to ask about yet: the conversation is empty.')
  }
  const transcript = messages
    .map(one => `${one.role === 'user' ? 'USER' : 'ASSISTANT'}: ${one.text}`)
    .join('\n\n')
    .slice(-LIVE_CHARS)
  const reply = await $.model.complete({
    model: cfg.liveModel,
    maxTokens: LIVE_TOKENS,
    system: LIVE_SYSTEM,
    prompt: `Conversation so far:\n\n${transcript}\n\n${prompt}`,
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
    : failed(FAILURES[reply.reason] ?? 'There was no answer.')
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
    return failed(FAILURES[reply.reason] ?? 'There was no answer.')
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
  ).catch(() => failed('The question could not be sent.'))
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
        'Aside question about the conversation, without spending its context; "clear" wipes the history',
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
  on('ui.input', { plugin: 'aside' }, async ($, e, next) => {
    if (e.kind !== 'submit' || !e.element.startsWith(FIELD)) return next(e)
    if (background === undefined) await ask($, e.value, cfg)
    else background.ask(e.value)

    return { element: e.element, value: e.value }
  })

  on('ui.press', { plugin: 'aside' }, async ($, e, next) => {
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

      return <Svg source={RULE} alt="separator" height={9} />
    }

    return (
      <Box flexDirection="column" gap={1}>
        {/* A new key after each question draws the field empty again. */}
        <Input
          key={`${FIELD}-${list[0]?.id ?? 0}`}
          placeholder="Ask aside…"
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
                    ? 'waiting for the turn to end…'
                    : 'thinking…'}
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
              label="Clear"
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
