# aside

A mod for [Claude Code](https://claude.com/claude-code): a side chat for asking about the conversation without spending its context.

```
/aside why did it pick that library and not the other one?
```

The question and its answer stay in the **Aside** pane: the main thread never sees them, so they take up none of its context window and do not derail the task in progress.

## How it works

- `/aside <question>` opens the pane and asks. The pane has its own field to keep asking.
- Each answer comes from a fork of the conversation as its last turn left it: same model and same system prompt, served from the prompt cache and with no access to tools.
- Before the first turn ends there is nothing to fork yet. The mod then answers "live" with a light model over the conversation's text, or waits in a queue for the turn to end, depending on the `liveFallback` option.
- Under each answer, a line with what it cost: time, tokens served from cache, uncached tokens and output tokens.
- `/aside clear`, or the **Clear** button, wipes the pane's history.

Answers come in the language of the question, brief and in prose.

## Options

| Option | Default | What it does |
| --- | --- | --- |
| `liveFallback` | `true` | Answer "live" before the first turn ends. When off, the question waits in a queue. |
| `liveModel` | `haiku` | Model for the "live" answers. The fork always uses the session's model. |
| `maxHistory` | `8` | How many earlier exchanges of the pane ride with each new question (1 to 50). |

## Installation

At the prompt of a terminal session:

```
/plugin install aside --marketplace zrdqns/claude-code-aside
```

Answer `y` to add the marketplace and choose the scope (the user scope loads it in every session, including the desktop app's).

To try it from a local copy, without installing it:

```bash
claude --plugin-dir ./claude-code-aside
```

## Development

```bash
claude plugin validate .
claude plugin test .
```

The module is in [`hooks/register.tsx`](hooks/register.tsx), its state contract in [`types/index.d.ts`](types/index.d.ts) and the tests in [`tests/`](tests).

## License

[MIT](LICENSE)
