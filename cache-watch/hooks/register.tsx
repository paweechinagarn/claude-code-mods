import { atom, read, update } from 'claude-code'
import type { EngineInterface, ModelUsage, Register } from 'claude-code'

import type { CacheAdvice, CacheCounts, CachePick, CacheTtl } from '../types'

// Warn this many minutes before the cache lapses.
const WARN_MIN = 5
// Below this many context tokens, re-caching is cheap: just carry on, no fork.
const SMALL_CONTEXT = 30_000
// A request after an idle gap longer than this tells 5-minute from 1-hour caching.
const PROBE_GAP_MIN = 6
const PANE = 'cache-watch-handoff'

const freshAt = atom({ plugin: 'cache-watch', key: 'freshAt' } as const, null)
const activeAt = atom({ plugin: 'cache-watch', key: 'activeAt' } as const, null)
const last = atom({ plugin: 'cache-watch', key: 'last' } as const, null)
const total = atom({ plugin: 'cache-watch', key: 'total' } as const, { read: 0, write: 0, uncached: 0 })
const ttl = atom({ plugin: 'cache-watch', key: 'ttl' } as const, { minutes: 60, how: 'assumed' })
const now = atom({ plugin: 'cache-watch', key: 'now' } as const, 0)
const advice = atom({ plugin: 'cache-watch', key: 'advice' } as const, null)
const advisedFor = atom({ plugin: 'cache-watch', key: 'advisedFor' } as const, null)

const sum = (c: CacheCounts) => c.read + c.write + c.uncached
const pct = (part: number, whole: number) => (whole === 0 ? 0 : Math.round((part / whole) * 100))
const k = (n: number) => (n >= 1000 ? `${Math.round(n / 1000)}k` : `${n}`)
const span = (ms: number) => {
  const m = Math.max(0, Math.round(ms / 60_000))
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`
}
const LABEL: Record<CachePick, string> = {
  continue: 'continue here as is',
  compact: 'compact now, while the cache is warm',
  handoff: 'start a new session from a handoff prompt',
}

const advisePrompt = (tokens: number) => `[cache-watch plugin] This is an automated side question from a plugin, not from the person. Do not continue the task and do not call tools.

The prompt cache for this conversation (about ${k(tokens)} tokens) lapses in about ${WARN_MIN} minutes. After that, the next message re-sends the whole conversation at the full cache-write price. Pick the cheapest good way to carry on:
- "continue": the remaining work is short, or it truly needs this full history.
- "compact": the task is mid-flight and the history holds a lot that is no longer needed.
- "handoff": the work has reached a natural break, or what comes next is a different phase.

Reply with ONE JSON object and nothing else, no code fence:
{"pick": "continue" | "compact" | "handoff",
 "why": "one short plain sentence",
 "compactFocus": "what a /compact summary must keep, in one or two sentences",
 "handoff": "a complete, self-contained prompt for a fresh Claude Code session in the same directory: the goal, what is done, decisions made and why, files touched, the exact next steps, and open questions. Write it as the person would paste it."}`

const parseAdvice = (text: string): CacheAdvice | null => {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    const o = JSON.parse(text.slice(start, end + 1))
    const pick: CachePick = ['continue', 'compact', 'handoff'].includes(o.pick) ? o.pick : 'compact'
    return {
      status: 'ready',
      pick,
      why: String(o.why ?? ''),
      compactFocus: String(o.compactFocus ?? ''),
      handoff: String(o.handoff ?? ''),
    }
  } catch {
    return null
  }
}

// Module variables reset on a hot reload; nothing here needs to survive one.
let isBusy = false
// A miss is expected right after a compaction, a model switch or a stale resume.
let expectMiss = false

async function record($: EngineInterface, u: ModelUsage) {
  const at = await $.clock.now()
  const counts: CacheCounts = {
    read: u.cache_read_input_tokens,
    write: u.cache_creation_input_tokens,
    uncached: u.input_tokens,
  }
  const prevAt = await read($, freshAt)
  const prev = await read($, last)
  const size = sum(counts)
  const hit = size === 0 ? 0 : counts.read / size

  if (prevAt !== null && prev !== null && sum(prev) > SMALL_CONTEXT && !expectMiss) {
    const gapMin = (at - prevAt) / 60_000
    if (gapMin > PROBE_GAP_MIN && gapMin < 60) {
      const seen: CacheTtl = { minutes: hit > 0.5 ? 60 : 5, how: 'observed' }
      const was = await read($, ttl)
      await update($, ttl, () => seen)
      if (seen.minutes === 5 && was.minutes === 60) {
        $.ui.toast(
          `Cache missed after ${Math.round(gapMin)}m idle: this session now looks like 5-minute caching (usage overage?).`,
          { timeoutMs: 10_000 },
        )
      }
    } else if (gapMin <= WARN_MIN && hit < 0.1) {
      $.ui.toast(
        `Unexpected cache miss: ${k(counts.write)} tokens re-cached. Something changed the prompt prefix (tools, MCP servers, settings?).`,
        { timeoutMs: 10_000 },
      )
    }
  }
  expectMiss = false

  await update($, freshAt, () => at)
  await update($, activeAt, () => at)
  await update($, now, () => at)
  await update($, last, () => counts)
  await update($, total, t => ({
    read: t.read + counts.read,
    write: t.write + counts.write,
    uncached: t.uncached + counts.uncached,
  }))
  await update($, advice, () => null)
}

async function advise($: EngineInterface, forActive: number) {
  await update($, advisedFor, () => forActive)
  const counts = await read($, last)
  const tokens = counts === null ? 0 : sum(counts)

  if (tokens < SMALL_CONTEXT) {
    await update($, advice, () => ({
      status: 'ready',
      pick: 'continue',
      why: `Only ${k(tokens)} tokens of context: re-caching it costs little.`,
      compactFocus: '',
      handoff: '',
    }))
    return
  }

  $.ui.toast(`Prompt cache lapses in ${WARN_MIN}m. Preparing the cheapest way to carry on.`)
  await update($, advice, () => ({ status: 'thinking', pick: 'compact', why: '', compactFocus: '', handoff: '' }))

  const r = await $.model.fork({ prompt: advisePrompt(tokens) })
  const parsed = r.isAnswered ? parseAdvice(r.text) : null

  // Reading the cache refreshes it: the fork bought another full lifetime.
  if ('usage' in r && r.usage && r.usage.cache_read_input_tokens > tokens / 2) {
    const at = await $.clock.now()
    await update($, freshAt, () => at)
  }

  if (parsed === null) {
    await update($, advice, () => ({
      status: 'failed',
      pick: 'compact',
      why: r.isAnswered ? 'The advice reply did not parse.' : `The advice request failed (${r.reason}).`,
      compactFocus: '',
      handoff: '',
    }))
    $.ui.toast('Cache advice failed. Compacting is the safe default for a large context.')
    return
  }

  await update($, advice, () => parsed)
  $.ui.toast(`Cache advice: ${LABEL[parsed.pick]}.`, { timeoutMs: 10_000 })
}

async function tick($: EngineInterface) {
  const at = await $.clock.now()
  await update($, now, () => at)
  const fresh = await read($, freshAt)
  const active = await read($, activeAt)
  const life = await read($, ttl)
  if (fresh === null || active === null || isBusy || life.minutes !== 60) return

  const leftMin = life.minutes - (at - fresh) / 60_000
  if (leftMin <= WARN_MIN && leftMin > 0 && (await read($, advisedFor)) !== active) {
    await advise($, active)
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    $.clock.every(30_000, () => void tick($))
    await $.command.register({
      name: 'cache-advice',
      description: 'Prepare cache advice now: continue, compact, or hand off to a new session',
    })

    return next(e)
  })

  on('command.run', { command: 'cache-advice' }, async $ => {
    const active = (await read($, activeAt)) ?? (await $.clock.now())
    void advise($, active)

    return { text: 'Preparing cache advice above the prompt.' }
  })

  on('turn.start', ($, e, next) => {
    isBusy = true

    return next(e)
  })

  on('turn.complete', ($, e, next) => {
    if (e.agentId === undefined) isBusy = false

    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    const result = yield* next(e)
    if (e.agentId === undefined && result.usage !== null) await record($, result.usage)

    return result
  })

  on('session.compact', async ($, e, next) => {
    expectMiss = true

    return next(e)
  })

  on('classic.PostModelSwitch', async ($, e, next) => {
    expectMiss = true
    await update($, ttl, () => ({ minutes: e.cache_ttl === '1h' ? 60 : 5, how: 'reported' }))

    return next(e)
  })

  on('classic.SessionStart', ($, e, next) => {
    if (e.prompt_cache_likely_expired) expectMiss = true

    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const fresh = await read($, freshAt)
    const counts = await read($, last)
    if (e.props.hasSurvey || fresh === null || counts === null) return next(e)

    const life = await read($, ttl)
    const sums = await read($, total)
    const at = await read($, now)
    const tip = await read($, advice)
    const left = life.minutes * 60_000 - (at - fresh)
    const lifeLabel = `${life.minutes === 60 ? '1h' : '5m'}${life.how === 'assumed' ? '?' : ''}`
    const clock =
      left > 0
        ? `${span(left)} left`
        : `expired ${span(-left)} ago; next message re-caches ${k(sum(counts))} tokens`
    const color = left <= 0 ? 'red' : left <= WARN_MIN * 60_000 ? 'yellow' : undefined
    const { Box, Text, Button } = $.ui.resolve(e)

    const copy = async () => {
      const done = await $.ui.copy({ text: tip?.handoff ?? '', surface: e.surface })
      $.ui.toast(done.isCopied ? 'Handoff prompt copied. Paste it into a new session.' : 'Could not copy the prompt.')
    }
    const compact = async () => {
      try {
        const focus = tip?.compactFocus
        await $.session.compact(focus ? { instructions: focus } : undefined)
        await update($, advice, () => null)
      } catch {
        $.ui.toast('Cannot compact while a turn runs.')
      }
    }

    return (
      <Box flexDirection="column">
        <Text color={color} dimColor={color === undefined}>
          Cache {lifeLabel} · {clock} · hit {pct(counts.read, sum(counts))}% last,{' '}
          {pct(sums.read, sum(sums))}% session
        </Text>
        {tip?.status === 'thinking' && <Text dimColor>Preparing cache advice...</Text>}
        {tip !== null && tip.status !== 'thinking' && (
          <Box flexDirection="column">
            <Text bold>
              Suggested: {LABEL[tip.pick]}. <Text dimColor>{tip.why}</Text>
            </Text>
            <Box>
              {tip.handoff !== '' && (
                <Button
                  key="copy"
                  label="Copy handoff prompt"
                  variant={tip.pick === 'handoff' ? 'primary' : 'secondary'}
                  onPress={copy}
                />
              )}
              {tip.handoff !== '' && (
                <Button key="show" label="Show prompt" onPress={() => void $.ui.open({ id: PANE, title: 'Handoff prompt' })} />
              )}
              {tip.pick !== 'continue' || tip.handoff !== '' ? (
                <Button
                  key="compact"
                  label="Compact now"
                  variant={tip.pick === 'compact' ? 'primary' : 'secondary'}
                  onPress={compact}
                />
              ) : null}
              <Button
                key="keep"
                label="Continue here"
                variant={tip.pick === 'continue' ? 'primary' : 'secondary'}
                onPress={() => update($, advice, () => null)}
              />
            </Box>
          </Box>
        )}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const tip = await read($, advice)
    const { Box, Markdown, Button } = $.ui.resolve(e)

    return (
      <Box flexDirection="column">
        <Markdown text={tip?.handoff || '_No handoff prompt yet. Run /cache-advice to prepare one._'} />
        <Button
          key="copy"
          label="Copy"
          onPress={async () => {
            const done = await $.ui.copy({ text: tip?.handoff ?? '', surface: e.surface })
            $.ui.toast(done.isCopied ? 'Copied.' : 'Could not copy.')
          }}
        />
      </Box>
    )
  })
}
