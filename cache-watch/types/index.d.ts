/** Token counts of the main thread's last request, or summed over the session. */
export type CacheCounts = { read: number; write: number; uncached: number }

/** How long a cache entry lives, and how the mod knows. */
export type CacheTtl = {
  minutes: 5 | 60
  /**
   * assumed: no evidence yet; observed: a request after a long gap showed it;
   * reported: the engine said so on a model switch.
   */
  how: 'assumed' | 'observed' | 'reported'
  /** The idle gap, in minutes, of the request that showed it. */
  gapMin?: number
}

export type CachePick = 'continue' | 'compact' | 'handoff'

/** The advice prepared shortly before the cache lapses. */
export type CacheAdvice = {
  /** thinking: the fork is running; ready: it answered; failed: it did not. */
  status: 'thinking' | 'ready' | 'failed'
  pick: CachePick
  why: string
  /** What to tell /compact to keep, when the pick is compact. */
  compactFocus: string
  /** A self-contained prompt for a new session, when the pick is handoff. */
  handoff: string
}

declare module 'claude-code' {
  interface PluginState {
    'cache-watch': {
      /** When the main thread's cache was last read or written, in ms. */
      freshAt: number | null
      /** When the person last ran a turn, in ms: the idle stretch starts here. */
      activeAt: number | null
      last: CacheCounts | null
      total: CacheCounts
      /** Hit percentages of the recent main-thread requests, oldest first. */
      history: number[]
      ttl: CacheTtl
      /** The clock, ticked so the countdown redraws. */
      now: number
      advice: CacheAdvice | null
      /** The activeAt the advice was prepared for, so it runs once per idle stretch. */
      advisedFor: number | null
      isExpanded: boolean
      isCompacting: boolean
    }
  }
}
