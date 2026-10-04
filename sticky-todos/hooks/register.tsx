import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Todo } from '../types'

const PANE = 'sticky-todos'
const TITLE = 'Todos'
const todos = atom({ plugin: 'sticky-todos', key: 'todos' } as const, [])

type Loose = Record<string, unknown>
const asStatus = (s: unknown): Todo['status'] =>
  s === 'completed' || s === 'in_progress' ? s : 'pending'

// Colours that read on the desktop app's light and dark themes alike.
const GREEN = '#22c55e'
const ACCENT = '#d97757'

// Surfaces that draw Svg (desktop, editor, phone) get a ring and a stepper; the terminal gets glyphs.
// docs/sticky-todos/mockup.html holds a copy of these builders: change both together.
const TRACK = 'stroke="#808080" stroke-opacity="0.3"'
const RING = 36
const STEP_W = 18
const STEP_H = 30

/** The header ring: the share done, as an arc over a faint track, with the count inside. */
const ringSvg = (done: number, total: number) => {
  const r = 15
  const c = 2 * Math.PI * r
  const f = total ? done / total : 0
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${RING}" height="${RING}" viewBox="0 0 36 36">` +
    `<circle cx="18" cy="18" r="${r}" fill="none" stroke-width="3.5" ${TRACK}/>` +
    `<circle cx="18" cy="18" r="${r}" fill="none" stroke="${GREEN}" stroke-width="3.5" stroke-linecap="round" ` +
    `stroke-dasharray="${(f * c).toFixed(2)} ${c.toFixed(2)}" transform="rotate(-90 18 18)"/>` +
    `<text x="18" y="22" text-anchor="middle" font-family="Segoe UI, system-ui, sans-serif" font-size="11" ` +
    `font-weight="600" fill="${GREEN}">${done}/${total}</text></svg>`
  )
}

/** One step of the stepper: a status mark, with rail segments joining it to its neighbours. */
const stepSvg = (status: Todo['status'], isFirst: boolean, isLast: boolean, isPrevDone: boolean) => {
  const mid = STEP_H / 2
  const x = STEP_W / 2
  const rail = (y1: number, y2: number, isLit: boolean) =>
    `<line x1="${x}" y1="${y1}" x2="${x}" y2="${y2}" stroke-width="2" ` +
    (isLit ? `stroke="${GREEN}" stroke-opacity="0.6"` : TRACK) +
    '/>'
  const up = isFirst ? '' : rail(0, mid - 8, isPrevDone)
  const down = isLast ? '' : rail(mid + 8, STEP_H, status === 'completed')
  const mark =
    status === 'completed'
      ? `<circle cx="${x}" cy="${mid}" r="7" fill="${GREEN}"/>` +
        `<path d="M${x - 3.2} ${mid} l2.2 2.3 l4.2 -4.6" fill="none" stroke="#1d1d1b" stroke-width="2" ` +
        `stroke-linecap="round" stroke-linejoin="round"/>`
      : status === 'in_progress'
        ? `<circle cx="${x}" cy="${mid}" r="6.5" fill="none" stroke-width="2" stroke="${ACCENT}" stroke-opacity="0.3"/>` +
          `<circle class="spin" cx="${x}" cy="${mid}" r="6.5" fill="none" stroke-width="2" stroke="${ACCENT}" ` +
          `stroke-linecap="round" stroke-dasharray="12 29"/><circle cx="${x}" cy="${mid}" r="2.5" fill="${ACCENT}"/>`
        : `<circle cx="${x}" cy="${mid}" r="6.5" fill="none" stroke-width="2" ${TRACK}/>`
  const motion =
    status === 'in_progress'
      ? `<style>.spin{transform-origin:${x}px ${mid}px;animation:s 1.1s linear infinite}` +
        `@keyframes s{to{transform:rotate(360deg)}}@media (prefers-reduced-motion:reduce){.spin{animation:none}}</style>`
      : ''
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${STEP_W}" height="${STEP_H}" viewBox="0 0 ${STEP_W} ${STEP_H}">` +
    `${motion}${up}${down}${mark}</svg>`
  )
}

const GLYPH: Record<Todo['status'], string> = { completed: '✔', in_progress: '◐', pending: '○' }
const STATUS_WORD: Record<Todo['status'], string> = { completed: 'Done', in_progress: 'In progress', pending: 'To do' }

// The whole list in TodoWrite's shape: { content, status, activeForm? }[].
const fromTodoWrite = (items: Loose[]): Todo[] =>
  items.map((t, i) => ({
    id: String(i),
    text: String(t.status === 'in_progress' && t.activeForm ? t.activeForm : t.content ?? ''),
    status: asStatus(t.status),
  }))

// The mod's own tool, for sessions whose model has no built-in todo tool (the desktop app's, for one).
const OWN_TOOL = 'mcp__sticky-todos__set_todos'
const OWN_SCHEMA = {
  type: 'object',
  properties: {
    todos: {
      type: 'array',
      description: 'The whole list, in order. Send an empty array to clear it.',
      items: {
        type: 'object',
        properties: {
          content: { type: 'string', description: 'The task, in the imperative: "Run the tests".' },
          status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
          activeForm: { type: 'string', description: 'Shown while in progress: "Running the tests".' },
        },
        required: ['content', 'status'],
      },
    },
  },
  required: ['todos'],
}

// Writes the list, then opens the pane when it gains its first item and closes it when it empties.
// Opening only on that change means a pane the person closed stays closed until the list restarts.
const setTodos = async ($: EngineInterface, fn: (list: Todo[]) => Todo[]) => {
  const before = (await read($, todos)).length
  await update($, todos, fn)
  const after = (await read($, todos)).length

  if (before === 0 && after > 0) {
    void $.ui.open({ id: PANE, title: TITLE })
  } else if (before > 0 && after === 0) {
    void $.ui.close({ id: PANE })
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'todos', description: 'Show the sticky todo pane' })
    await $.tool.register({
      name: 'set_todos',
      description:
        'Replace the todo checklist shown in the side pane. Use it for multi-step work when you have ' +
        'no built-in todo tool (TodoWrite or TaskCreate); keep one item in_progress at a time.',
      inputSchema: OWN_SCHEMA,
    })

    // A reload or resume keeps the list: show it again if it has items.
    if ((await read($, todos)).length > 0) {
      void $.ui.open({ id: PANE, title: TITLE })
    }

    return next(e)
  })

  on('command.run', { command: 'todos' }, async $ => {
    await $.ui.open({ id: PANE, title: TITLE })

    return { text: 'Todo pane opened.' }
  })

  // Claude's todo tools are not typed in every build, so read their arguments loosely.
  on('tool.call', async ($, e, next) => {
    const tool = e.tool as string
    const input = e as unknown as Loose

    // The mod's own tool: nothing beneath serves it, so answer here.
    if (tool === OWN_TOOL) {
      const items = Array.isArray(input.todos) ? (input.todos as Loose[]) : []
      const list = fromTodoWrite(items)
      await setTodos($, () => list)
      const done = list.filter(t => t.status === 'completed').length

      return { result: `Todo list updated: ${done} of ${list.length} done.` }
    }

    // Older tool: the whole list is rewritten on every call.
    if (tool === 'TodoWrite' && Array.isArray(input.todos)) {
      const list = fromTodoWrite(input.todos as Loose[])
      await setTodos($, () => list)

      return next(e)
    }

    // Newer tools: one task created or updated per call.
    if (tool === 'TaskCreate') {
      const ran = await next(e)
      const text = 'text' in ran && typeof ran.text === 'string' ? ran.text : ''
      const id = /#?(\d+)/.exec(text)?.[1] ?? String(Date.now())
      await setTodos($, list => [
        ...list,
        { id, text: String(input.subject ?? ''), status: 'pending' as const },
      ])

      return ran
    }

    if (tool === 'TaskUpdate') {
      const id = String(input.taskId ?? '')
      await setTodos($, list =>
        input.status === 'deleted'
          ? list.filter(t => t.id !== id)
          : list.map(t =>
              t.id === id
                ? {
                    ...t,
                    text: typeof input.subject === 'string' ? input.subject : t.text,
                    status: input.status ? asStatus(input.status) : t.status,
                  }
                : t,
            ),
      )
    }

    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const elements = $.ui.resolve(e)
    const { Box, Text, Button } = elements
    const Svg = 'Svg' in elements ? elements.Svg : undefined
    const list = await read($, todos)
    const done = list.filter(t => t.status === 'completed').length
    const now = list.filter(t => t.status === 'in_progress').length
    const summary =
      list.length === 0
        ? "No todos yet. Claude's checklist appears here."
        : `${done} of ${list.length} done` + (now ? ` · ${now} in progress` : '')

    return (
      <Box flexDirection="column">
        <Box gap={1} alignItems="center" marginBottom={1}>
          {Svg && list.length > 0 && (
            <Svg
              source={ringSvg(done, list.length)}
              alt={`${done} of ${list.length} done`}
              width={RING}
              height={RING}
            />
          )}
          <Box flexDirection="column">
            <Text bold>{TITLE}</Text>
            <Text dimColor>{summary}</Text>
          </Box>
        </Box>
        {list.map((t, i) => (
          <Box key={t.id} gap={1} alignItems="center">
            {Svg ? (
              <Svg
                source={stepSvg(t.status, i === 0, i === list.length - 1, list[i - 1]?.status === 'completed')}
                alt={STATUS_WORD[t.status]}
                width={STEP_W}
                height={STEP_H}
                // Only the running step animates, and only an interactive Svg plays CSS animation.
                isInteractive={t.status === 'in_progress' || undefined}
              />
            ) : (
              <Text
                color={t.status === 'completed' ? GREEN : t.status === 'in_progress' ? ACCENT : undefined}
                dimColor={t.status === 'pending'}
              >
                {GLYPH[t.status]}
              </Text>
            )}
            <Text
              wrap="truncate-end"
              bold={t.status === 'in_progress'}
              color={t.status === 'in_progress' ? ACCENT : undefined}
              dimColor={t.status === 'completed'}
              strikethrough={t.status === 'completed'}
            >
              {t.text}
            </Text>
          </Box>
        ))}
        {done > 0 && (
          <Box marginTop={1}>
            <Button
              key="clear"
              label="Clear done"
              onPress={() => setTodos($, l => l.filter(t => t.status !== 'completed'))}
            />
          </Box>
        )}
      </Box>
    )
  })
}
