import { atom, host, useQuery, useValue } from '@hermes/plugin-sdk'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { jsx, jsxs } from 'react/jsx-runtime'

const ID = 'turn-timings'
const TITLE = 'Turn timings'
const STORAGE_KEY = 'durations-v1'
const MAX_SAVED = 2000
const MAX_LIVE = 64
const MAX_ROWS = 20
const tone = { color: 'var(--ui-text-secondary)' }

const keyFor = (owner, id) => JSON.stringify([owner.connectionId, owner.profile, id])
const validId = id => Number.isSafeInteger(id) && id > 0
const elapsed = start => Math.max(0, performance.now() - start)
const duration = ms => ms != null && Number.isFinite(ms) ? `${(ms / 1000).toFixed(1)} s` : 'Not recorded'

function setRecent(map, key, value, limit) {
  const next = new Map(map)
  next.delete(key)
  next.set(key, value)
  if (next.size > limit) next.delete(next.keys().next().value)
  return next
}

function excerpt(text) {
  if (typeof text !== 'string') return 'Prompt'
  const line = text.slice(0, 300).replace(/\s+/g, ' ').trim()
  return line.length > 96 ? `${line.slice(0, 95)}…` : line || 'Prompt'
}

function completedRows(messages, saved, owner) {
  const rows = []
  let prompt
  let reply
  const addRow = () => {
    if (!prompt || !reply) return
    const userKey = validId(prompt.row_id) ? keyFor(owner, `user:${prompt.row_id}`) : null
    const replyKey = validId(reply.row_id) ? keyFor(owner, `reply:${reply.row_id}`) : null
    rows.push({ label: excerpt(prompt.text), ms: saved.get(replyKey) ?? saved.get(userKey), userKey, replyKey })
  }
  for (const message of messages) {
    if (message?.role === 'user' && message.display_kind !== 'steer') {
      addRow()
      prompt = message
      reply = null
    } else if (message?.role === 'assistant' && typeof message.text === 'string' && message.text.trim()) reply = message
  }
  addRow()
  return rows.slice(-MAX_ROWS)
}

function Clock({ started }) {
  const [ms, setMs] = useState(elapsed(started))
  useEffect(() => {
    const tick = () => setMs(elapsed(started))
    tick()
    const timer = setInterval(tick, 100)
    return () => clearInterval(timer)
  }, [started])
  return duration(ms)
}

function Row({ label, value, featured = false }) {
  return jsxs('div', {
    className: 'flex min-w-0 items-baseline justify-between gap-2 py-2',
    children: [
      jsx('dt', { className: featured ? 'min-w-0 truncate font-medium' : 'min-w-0 truncate', title: label, children: label }),
      jsx('dd', { className: 'shrink-0 tabular-nums', style: tone, children: value })
    ]
  })
}

async function loadHistory(owner, runtime) {
  const routes = await host.profileRoutes()
  const route = routes.find(item => item.connectionId === owner.connectionId && item.profile === owner.profile)
  if (!route && owner.connectionId !== 'local') throw new Error('Chat connection is unavailable')
  const response = await host.requestProfile(route ?? owner.profile, 'session.history', { session_id: runtime })
  if (!Array.isArray(response?.messages)) throw new Error('Chat history is unavailable')
  return response.messages
}

function Pane({ liveAtom, savedAtom }) {
  const owner = useValue(host.state.focusedSessionOwner)
  const runtime = useValue(host.state.focusedSessionId)
  const active = useValue(liveAtom)
  const saved = useValue(savedAtom)
  const chatKey = owner && runtime ? keyFor(owner, runtime) : null
  const turn = chatKey ? active.get(chatKey) : null
  const viewport = useRef(null)
  const { data, isPending, isError } = useQuery({
    queryKey: [ID, owner?.connectionId, owner?.profile, runtime, turn?.completion],
    enabled: Boolean(owner && runtime),
    queryFn: () => loadHistory(owner, runtime),
    placeholderData: (previous, query) =>
      query?.queryKey[1] === owner?.connectionId && query?.queryKey[2] === owner?.profile && query?.queryKey[3] === runtime
        ? previous : undefined,
    retry: false
  })
  // History can arrive after the chat switch or completion has rendered.
  useLayoutEffect(() => {
    const pane = viewport.current
    if (pane) pane.scrollTop = pane.scrollHeight
  }, [chatKey, turn?.running?.started, turn?.completion, data])

  const rows = data && owner ? completedRows(data, saved, owner) : []
  const latestKey = turn?.last?.rowKey
  const matchedLatest = latestKey && rows.some(row => row.replyKey === latestKey || row.userKey === latestKey)
  const pendingCompletion = !matchedLatest ? turn?.last : null
  const hasReplies = rows.length > 0 || pendingCompletion != null
  const note = !runtime ? 'Open a chat to see its timings.'
    : !owner ? 'This chat’s profile is unavailable.'
      : isError ? 'Could not load chat history.'
        : isPending && !turn?.running && !hasReplies ? 'Loading chat history…'
          : !turn?.running && !hasReplies ? 'No replies yet. Send a prompt to start timing.' : null

  return jsxs('section', {
    'aria-label': TITLE,
    className: 'h-full overflow-auto p-3 text-sm',
    ref: viewport,
    children: [
      jsxs('dl', {
        children: [
          rows.map((row, index) => jsx(Row, { label: row.label, value: duration(row.ms) }, row.userKey ?? index)),
          pendingCompletion && jsx(Row, { label: 'Completed turn', featured: true, value: duration(pendingCompletion.ms) }),
          turn?.running && jsx(Row, { label: 'Processing', featured: true, value: jsx(Clock, { started: turn.running.started }) }, turn.running.started)
        ]
      }),
      note && jsx('p', { className: 'py-2', style: tone, children: note })
    ]
  })
}

function ownerFor(event) {
  if (event.connectionId && event.profile) return { connectionId: event.connectionId, profile: event.profile }
  if (host.state.focusedSessionId.get() !== event.session_id) return null
  const owner = host.state.focusedSessionOwner.get()
  if (event.connectionId && event.connectionId !== owner?.connectionId) return null
  if (event.profile && event.profile !== owner?.profile) return null
  return owner
}

export default {
  id: ID,
  name: TITLE,
  register(ctx) {
    const live = atom(new Map())
    const stored = ctx.storage.get(STORAGE_KEY, [])
    const saved = atom(new Map(Array.isArray(stored) ? stored.filter(entry =>
      Array.isArray(entry) && typeof entry[0] === 'string' && Number.isFinite(entry[1])) : []))
    let completion = 0

    const onTurn = event => {
      if (!event.session_id) return
      const owner = ownerFor(event)
      if (!owner) return
      const key = keyFor(owner, event.session_id)
      const state = live.get()
      const current = state.get(key) ?? {}
      const { turn_id: id, status, persisted_turn: receipt } = event.payload ?? {}
      if (event.type === 'message.start') {
        if (id && (id === current.running?.id || id === current.finishedId)) return
        live.set(setRecent(state, key, { ...current, running: { id, started: performance.now() } }, MAX_LIVE))
        return
      }
      if (!current.running || (id && current.running.id && id !== current.running.id)) return
      const next = { ...current, running: null, finishedId: current.running.id, completion: ++completion }
      if (event.type === 'message.complete' && status === 'complete') {
        const ms = elapsed(current.running.started)
        const rowKey = validId(receipt?.final_assistant_row_id) ? keyFor(owner, `reply:${receipt.final_assistant_row_id}`)
          : validId(receipt?.user_row_id) ? keyFor(owner, `user:${receipt.user_row_id}`) : null
        next.last = { ms, rowKey }
        if (rowKey) {
          const timings = setRecent(saved.get(), rowKey, ms, MAX_SAVED)
          saved.set(timings)
          ctx.storage.set(STORAGE_KEY, [...timings])
        }
      }
      live.set(setRecent(state, key, next, MAX_LIVE))
    }

    ctx.onEvent('message.start', onTurn)
    ctx.onEvent('message.complete', onTurn)
    ctx.onEvent('error', onTurn)
    ctx.register({
      id: 'pane',
      area: 'panes',
      title: TITLE,
      data: { placement: 'right', dock: { pane: 'workspace', pos: 'right' }, width: '260px' },
      render: () => jsx(Pane, { liveAtom: live, savedAtom: saved })
    })
  }
}
