/** One question asked aside, and what came of it. */
export type Exchange = {
  /** When it was asked, in `$.clock.now()`'s milliseconds; its identity too. */
  id: number
  question: string
  /** The answer's markdown; null until the model has answered. */
  answer: string | null
  /** Why there is no answer, in words for the person; null when there is one. */
  failure: string | null
  /**
   * How it was answered: `fork`, over the session's own cached transcript;
   * `live`, a plain completion over the transcript's text, before any turn
   * has ended. Null until answered.
   */
  kind: 'fork' | 'live' | null
  /** Waiting for the turn in flight to end, to be answered by a fork then. */
  isQueued: boolean
  /** How long the answer took. */
  ms: number
  /** Input tokens the prompt cache served. */
  cacheRead: number
  /** Input tokens paid in full: uncached, plus those the call cached. */
  fresh: number
  output: number
}

declare module 'claude-code' {
  interface PluginState {
    aparte: { asked: Exchange[] }
  }
}
