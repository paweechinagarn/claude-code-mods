import { atom, read, update } from 'claude-code'
import type { EngineInterface, ModelUsage, Register } from 'claude-code'

import type { CacheAdvice, CacheCounts, CachePick, CacheTtl } from '../types'

// Warn this many minutes before the cache lapses.
const WARN_MIN = 5
// Below this many context tokens, re-caching is cheap: just carry on, no fork.
const SMALL_CONTEXT = 30_000
// A request after an idle gap longer than this tells 5-minute from 1-hour caching.
const PROBE_GAP_MIN = 6
// How many recent requests the hit-rate sparkline shows.
const HISTORY = 12
// Below this many columns, the row drops the sparkline and the lifetime.
const NARROW = 72
const PANE = 'cache-watch-handoff'

const freshAt = atom({ plugin: 'cache-watch', key: 'freshAt' } as const, null)
const activeAt = atom({ plugin: 'cache-watch', key: 'activeAt' } as const, null)
const last = atom({ plugin: 'cache-watch', key: 'last' } as const, null)
const total = atom({ plugin: 'cache-watch', key: 'total' } as const, { read: 0, write: 0, uncached: 0 })
const history = atom({ plugin: 'cache-watch', key: 'history' } as const, [])
const ttl = atom({ plugin: 'cache-watch', key: 'ttl' } as const, { minutes: 60, how: 'assumed' })
const now = atom({ plugin: 'cache-watch', key: 'now' } as const, 0)
const advice = atom({ plugin: 'cache-watch', key: 'advice' } as const, null)
const advisedFor = atom({ plugin: 'cache-watch', key: 'advisedFor' } as const, null)
const isExpanded = atom({ plugin: 'cache-watch', key: 'isExpanded' } as const, false)
const isCompacting = atom({ plugin: 'cache-watch', key: 'isCompacting' } as const, false)

const sum = (c: CacheCounts) => c.read + c.write + c.uncached
const pct = (part: number, whole: number) => (whole === 0 ? 0 : Math.round((part / whole) * 100))
const k = (n: number) =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : `${n}`
const span = (ms: number) => {
  const m = Math.max(0, Math.round(ms / 60_000))
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`
}
// One palette for the whole row: red when expired, amber when close, green when fresh.
const RED = '#ef4444'
const AMBER = '#f59e0b'
const GREEN = '#22c55e'
const rgb = (hex: string) => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16))
const blend = (a: string, b: string, t: number) =>
  '#' + rgb(a).map((x, i) => Math.round(x + ((rgb(b)[i] ?? x) - x) * t).toString(16).padStart(2, '0')).join('')
// Red at the left end, amber in the middle, green at the right: a shrinking bar's head drifts into red.
const heat = (t: number) => (t < 0.5 ? blend(RED, AMBER, t * 2) : blend(AMBER, GREEN, (t - 0.5) * 2))

/** Terminal: a thin line over a faint track, each filled cell colored by where it sits. */
const barCells = (fraction: number, cells: number) => {
  const filled = Math.max(0, Math.min(cells, Math.ceil(fraction * cells)))
  return Array.from({ length: cells }, (_, i) =>
    i < filled ? { glyph: '━', color: heat((i + 0.5) / cells) } : { glyph: '─', color: undefined },
  )
}
const SPARK = '▁▂▃▄▅▆▇█'
/** One bar per recent request, height and color by its hit rate; empty slots are a faint baseline. */
const sparkCells = (values: number[]) => [
  ...Array.from({ length: Math.max(0, HISTORY - values.length) }, () => ({ glyph: '▁', color: undefined })),
  ...values.slice(-HISTORY).map(v => ({ glyph: SPARK[Math.round((v / 100) * 7)] ?? '▁', color: heat(v / 100) })),
]

// Surfaces that draw Svg (desktop, editor, phone) get vector bars; text fonts there do not tile glyphs.
const TRACK = 'fill="#808080" fill-opacity="0.22"'
const BAR_W = 120
const BAR_H = 6
const COL_W = 4
const COL_GAP = 2
const SPARK_H = 14
const SPARK_W = HISTORY * (COL_W + COL_GAP) - COL_GAP

/** A rounded pill: the red-to-green gradient spans the whole track, the fill shows the time left. */
const barSvg = (fraction: number) => {
  const w = Math.max(0, Math.min(BAR_W, fraction * BAR_W))
  const fill = w > 0 ? `<rect width="${w.toFixed(1)}" height="${BAR_H}" rx="${BAR_H / 2}" fill="url(#g)"/>` : ''
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${BAR_W}" height="${BAR_H}" viewBox="0 0 ${BAR_W} ${BAR_H}">` +
    `<defs><linearGradient id="g" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="${BAR_W}" y2="0">` +
    `<stop offset="0" stop-color="${RED}"/><stop offset="0.5" stop-color="${AMBER}"/><stop offset="1" stop-color="${GREEN}"/>` +
    `</linearGradient></defs><rect width="${BAR_W}" height="${BAR_H}" rx="${BAR_H / 2}" ${TRACK}/>${fill}</svg>`
  )
}

/** One rounded column per recent request over its own faint track: height and color by hit rate. */
const sparkSvg = (values: number[]) => {
  const slots = [...Array<number | null>(Math.max(0, HISTORY - values.length)).fill(null), ...values.slice(-HISTORY)]
  const cols = slots.map((v, i) => {
    const x = i * (COL_W + COL_GAP)
    const track = `<rect x="${x}" width="${COL_W}" height="${SPARK_H}" rx="${COL_W / 2}" ${TRACK}/>`
    if (v === null) return track
    const h = Math.max(COL_W, (v / 100) * SPARK_H)
    return track + `<rect x="${x}" y="${(SPARK_H - h).toFixed(1)}" width="${COL_W}" height="${h.toFixed(1)}" rx="${COL_W / 2}" fill="${heat(v / 100)}"/>`
  })
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${SPARK_W}" height="${SPARK_H}" viewBox="0 0 ${SPARK_W} ${SPARK_H}">${cols.join('')}</svg>`
}

const lifetimeText = (t: CacheTtl) => {
  const life = t.minutes === 60 ? '1 hour' : '5 minutes'
  if (t.how === 'reported') return `${life}, reported by Claude Code on a model switch.`
  if (t.how === 'observed') {
    return t.minutes === 60
      ? `${life}, confirmed: the cache survived a ${t.gapMin ?? PROBE_GAP_MIN}-minute pause.`
      : `${life}, seen: the cache missed after a ${t.gapMin ?? PROBE_GAP_MIN}-minute pause.`
  }
  return `${life}, assumed. Confirmed after your first pause of ${PROBE_GAP_MIN}+ minutes.`
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
    const gapMin = Math.round((at - prevAt) / 60_000)
    if (gapMin > PROBE_GAP_MIN && gapMin < 60) {
      const seen: CacheTtl = { minutes: hit > 0.5 ? 60 : 5, how: 'observed', gapMin }
      const was = await read($, ttl)
      await update($, ttl, () => seen)
      if (seen.minutes === 5 && was.minutes === 60) {
        $.ui.toast(
          `Cache missed after ${gapMin}m idle: this session now looks like 5-minute caching (usage overage?).`,
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
  await update($, history, h => [...h, pct(counts.read, size)].slice(-HISTORY))
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

async function copyHandoff($: EngineInterface, text: string, surface: Parameters<EngineInterface['ui']['copy']>[0]['surface']) {
  const done = await $.ui.copy({ text, surface })
  $.ui.toast(done.isCopied ? 'Handoff prompt copied. Paste it into a new session.' : 'Could not copy. Use Show prompt and copy it by hand.')
}

async function compactNow($: EngineInterface, focus: string) {
  await update($, isCompacting, () => true)
  try {
    await $.session.compact(focus ? { instructions: focus } : undefined)
    await update($, advice, () => null)
    $.ui.toast('Compacted.')
  } catch {
    $.ui.toast('Cannot compact while a turn runs. Try again when it ends.')
  } finally {
    await update($, isCompacting, () => false)
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
    const hits = await read($, history)
    const at = await read($, now)
    const tip = await read($, advice)
    const isOpen = await read($, isExpanded)
    const isCompactRunning = await read($, isCompacting)
    const elements = $.ui.resolve(e)
    const { Box, Text, Button } = elements
    const Svg = 'Svg' in elements ? elements.Svg : undefined

    const lifeMs = life.minutes * 60_000
    const left = lifeMs - (at - fresh)
    const state = left <= 0 ? 'expired' : left <= WARN_MIN * 60_000 ? 'warn' : 'fresh'
    const tone = state === 'expired' ? RED : state === 'warn' ? AMBER : GREEN
    // A symbol and words carry the state too, never the color alone.
    const icon = state === 'expired' ? '✕' : state === 'warn' ? '▲' : '●'
    const clock =
      state === 'expired'
        ? `expired ${span(-left)} ago`
        : state === 'warn'
          ? `expires in ${span(left)}`
          : `${span(left)} left`
    const isNarrow = (e.props.bodyColumns ?? 80) < NARROW
    const size = sum(counts)

    const row = (label: string, value: string) => (
      <Box>
        <Box width={14} flexShrink={0}>
          <Text dimColor>{label}</Text>
        </Box>
        <Text>{value}</Text>
      </Box>
    )

    return (
      <Box flexDirection="column">
        <Box gap={1} alignItems="center">
          <Text color={tone}>{icon}</Text>
          <Text bold>Cache</Text>
          {Svg ? (
            <Svg source={barSvg(left / lifeMs)} alt={clock} width={BAR_W} height={BAR_H} />
          ) : (
            <Text>
              {barCells(left / lifeMs, isNarrow ? 10 : 16).map(cell => (
                <Text color={cell.color} dimColor={cell.color === undefined}>
                  {cell.glyph}
                </Text>
              ))}
            </Text>
          )}
          <Text color={state === 'fresh' ? undefined : tone} bold={state !== 'fresh'}>
            {clock}
          </Text>
          {!isNarrow && <Text dimColor>of {life.minutes === 60 ? '1h' : '5m'}</Text>}
          {!isNarrow && <Text dimColor>·</Text>}
          {!isNarrow && <Text dimColor>hits</Text>}
          {!isNarrow && Svg && (
            <Svg
              source={sparkSvg(hits)}
              alt={`Cache hit rate of the last ${hits.length} requests`}
              width={SPARK_W}
              height={SPARK_H}
            />
          )}
          {!isNarrow && !Svg && (
            <Text>
              {sparkCells(hits).map(cell => (
                <Text color={cell.color} dimColor={cell.color === undefined}>
                  {cell.glyph}
                </Text>
              ))}
            </Text>
          )}
          <Text color={heat(counts.read / Math.max(1, size))}>{pct(counts.read, size)}%</Text>
          {state === 'expired' && <Text color={RED}>· next message re-caches {k(size)} tokens</Text>}
          <Button
            key="details"
            plain
            hotkey="d"
            label={isOpen ? 'less' : 'more'}
            onPress={() => update($, isExpanded, v => !v)}
          />
        </Box>

        {isOpen && (
          <Box flexDirection="column" marginLeft={2}>
            {row('Lifetime', lifetimeText(life))}
            {row(
              'Last request',
              `${pct(counts.read, size)}% from cache: ${k(counts.read)} read, ${k(counts.write)} written, ${k(counts.uncached)} new`,
            )}
            {row(
              'Session',
              `${pct(sums.read, sum(sums))}% from cache: ${k(sums.read)} tokens served at about a tenth of the price`,
            )}
            {row('If it expires', `the next message re-writes ${k(size)} tokens into the cache`)}
            {row('Advice', `runs ${WARN_MIN}m before expiry, or now with /cache-advice`)}
          </Box>
        )}

        {tip !== null && (
          <Box
            flexDirection="column"
            borderStyle="round"
            borderColor={tip.status === 'failed' ? RED : AMBER}
            paddingX={1}
          >
            {tip.status === 'thinking' ? (
              <Text>◌ Preparing advice: asking the model while the cache is still warm...</Text>
            ) : (
              <Box flexDirection="column">
                <Text bold>
                  {tip.status === 'failed' ? '✕ Advice failed. ' : '▲ '}Suggested: {LABEL[tip.pick]}
                </Text>
                {tip.why !== '' && <Text dimColor>{tip.why}</Text>}
                <Box gap={1} marginTop={1}>
                  {tip.handoff !== '' && (
                    <Button
                      key="copy"
                      hotkey="1"
                      label="Copy handoff prompt"
                      variant={tip.pick === 'handoff' ? 'primary' : 'secondary'}
                      onPress={() => copyHandoff($, tip.handoff, e.surface)}
                    />
                  )}
                  {tip.handoff !== '' && (
                    <Button
                      key="show"
                      hotkey="2"
                      label="Show prompt"
                      onPress={() => void $.ui.open({ id: PANE, title: 'Handoff prompt' })}
                    />
                  )}
                  {(tip.pick !== 'continue' || tip.handoff !== '') && (
                    <Button
                      key="compact"
                      hotkey="3"
                      label={isCompactRunning ? 'Compacting...' : 'Compact now'}
                      variant={tip.pick === 'compact' ? 'primary' : 'secondary'}
                      onPress={() => (isCompactRunning ? undefined : compactNow($, tip.compactFocus))}
                    />
                  )}
                  <Button
                    key="keep"
                    hotkey="4"
                    label="Continue here"
                    variant={tip.pick === 'continue' ? 'primary' : 'secondary'}
                    onPress={() => update($, advice, () => null)}
                  />
                </Box>
              </Box>
            )}
          </Box>
        )}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const tip = await read($, advice)
    const { Box, Markdown, Button } = $.ui.resolve(e)
    const text = tip?.handoff ?? ''

    return (
      <Box flexDirection="column" gap={1}>
        <Markdown text={text || '_No handoff prompt yet. Run /cache-advice to prepare one._'} />
        {text !== '' && (
          <Button key="copy" hotkey="c" label="Copy" variant="primary" onPress={() => copyHandoff($, text, e.surface)} />
        )}
      </Box>
    )
  })
}
