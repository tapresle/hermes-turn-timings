import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'

const url = new URL('../desktop/plugin.js', import.meta.url)
const source = await readFile(url, 'utf8')
const sdk = `
const performance = { now: () => globalThis.turnTimingsNow ?? 0 }
const atom = initial => { let value = initial; return {get: () => value, set: next => { value = next }} }
const host = {
  state: {focusedSessionOwner: atom({connectionId:'local',profile:'default'}), focusedSessionId: atom('chat-a')},
  profileRoutes: async () => [{connectionId:'local',profile:'default',mode:'local',targetProfile:'default'}],
  requestProfile: (...args) => globalThis.turnTimingsRequest(...args)
}
const useValue = value => value === host.state.focusedSessionId
  ? globalThis.turnTimingsRender?.session ?? value.get() : value.get()
const useState = initial => [initial, () => {}]
const useEffect = () => {}
const useRef = initial => globalThis.turnTimingsRender?.ref ?? {current: initial}
const useLayoutEffect = (effect, deps) => globalThis.turnTimingsRender?.effects.push({effect, deps})
const useQuery = options => { globalThis.turnTimingsQuery = options; return globalThis.turnTimingsQueryState || {} }
const jsx = (type, props) => typeof type === 'function' ? type(props) : {type, ...props}
const jsxs = jsx
`
const { default: plugin } = await import(`data:text/javascript,${encodeURIComponent(sdk + source.replace(/^import .*\n/gm, ''))}`)

function load(storage = new Map()) {
  const listeners = new Map()
  let pane
  plugin.register({
    register: value => { if (value.area === 'panes') pane = value },
    onEvent: (type, listener) => listeners.set(type, listener),
    storage: { get: (key, fallback) => storage.get(key) ?? fallback, set: (key, value) => storage.set(key, structuredClone(value)) }
  })
  return { pane, storage, emit: (type, payload, session_id = 'chat-a', profile = 'default') =>
    listeners.get(type)?.({ type, session_id, connectionId: 'local', profile, payload }) }
}
const receipt = { status: 'complete', persisted_turn: { user_row_id: 3, final_assistant_row_id: 4 } }
const snapshot = [
  { role:'user', row_id:1, text:'Older prompt' }, {role:'assistant', row_id:2, text:'Older answer'},
  { role:'user', row_id:3, text:'New prompt' }, {role:'assistant', row_id:4, text:'New answer'}
]
const text = pane => JSON.stringify(pane.render())

function renderWithScroll(pane, verify) {
  const viewport = { scrollTop: 0, scrollHeight: 400, clientHeight: 120 }
  const renderState = { ref: { current: null }, effects: [], session: 'chat-a' }
  let previous = []
  function render(session, data) {
    renderState.session = session
    renderState.effects = []
    globalThis.turnTimingsQueryState = { data }
    const tree = pane.render()
    if (tree.ref) tree.ref.current = viewport
    const next = renderState.effects
    next.forEach(({effect, deps}, i) => {
      if (!previous[i] || deps.some((dep, index) => !Object.is(dep, previous[i][index]))) effect()
    })
    previous = next.map(({deps}) => deps)
  }
  globalThis.turnTimingsRender = renderState
  try { verify(viewport, render) } finally {
    delete globalThis.turnTimingsRender
    delete globalThis.turnTimingsQueryState
  }
}

test('scrolls the pane to the bottom when its turn starts or completes, but not for another chat', () => {
  const {pane, emit} = load()
  renderWithScroll(pane, (viewport, render) => {
    render('chat-a', snapshot)
    viewport.scrollTop = 12
    emit('message.start', {}, 'chat-b')
    emit('message.complete', {status:'complete'}, 'chat-b')
    render('chat-a', snapshot)
    assert.equal(viewport.scrollTop, 12)
    emit('message.start', {turn_id:'turn-a'})
    render('chat-a', snapshot)
    assert.ok(viewport.scrollTop >= viewport.scrollHeight - viewport.clientHeight)
    viewport.scrollTop = 12
    emit('message.start', {turn_id:'turn-a'})
    render('chat-a', snapshot)
    assert.equal(viewport.scrollTop, 12)
    emit('message.complete', receipt)
    render('chat-a', snapshot)
    assert.ok(viewport.scrollTop >= viewport.scrollHeight - viewport.clientHeight)
    viewport.scrollHeight = 650
    render('chat-a', [...snapshot])
    assert.ok(viewport.scrollTop >= viewport.scrollHeight - viewport.clientHeight)
  })
})

test('scrolls to the bottom when history loads after switching chats', () => {
  const {pane} = load()
  renderWithScroll(pane, (viewport, render) => {
    render('chat-a', snapshot)
    viewport.scrollTop = 12
    render('chat-b', undefined)
    viewport.scrollTop = 0
    viewport.scrollHeight = 850
    render('chat-b', [...snapshot])
    assert.ok(viewport.scrollTop >= viewport.scrollHeight - viewport.clientHeight)
  })
})

test('registers a right-side pane and switches from live to completed timing', () => {
  assert.ok(plugin, 'plugin must export its registration')
  const {pane, emit} = load()
  assert.equal(pane.data.placement, 'right')
  globalThis.turnTimingsNow = 1000
  try {
    emit('message.start', { turn_id:'turn-a' })
    globalThis.turnTimingsNow = 6500
    assert.match(text(pane), /Processing.*5\.5 s/)
    emit('message.start', { turn_id:'turn-a' })
    globalThis.turnTimingsNow = 13400
    emit('message.complete', receipt)
    globalThis.turnTimingsNow = 20000
    assert.match(text(pane), /Completed turn.*12\.4 s/)
    assert.doesNotMatch(text(pane), /Processing|Latest reply/)
  } finally { delete globalThis.turnTimingsNow }
})

test('pairs saved duration with the correct history row after reload', () => {
  const {emit, storage} = load()
  emit('message.start', { turn_id:'turn-a' })
  emit('message.complete', receipt)
  globalThis.turnTimingsQueryState = {data:snapshot}
  try {
    const restored = load(storage)
    const rendered = text(restored.pane)
    const section = restored.pane.render()
    assert.equal(section['aria-label'], 'Turn timings')
    assert.equal(restored.pane.title, 'Turn timings')
    assert.ok(!section.children.some(child => child?.type === 'h2'), 'no heading in the pane body')
    assert.match(rendered, /Older prompt.*New prompt.*0\.0 s/)
    assert.doesNotMatch(rendered, /Latest reply|Completed turn/)
    assert.equal((rendered.match(/Not recorded/g) || []).length, 1)
    restored.emit('message.start', { turn_id:'turn-b' })
    assert.match(text(restored.pane), /Older prompt.*New prompt.*Processing/)
  } finally { delete globalThis.turnTimingsQueryState }
})

test('ignores unmatched completions and events from a different chat or profile', () => {
  const {emit, pane, storage} = load()
  emit('message.complete', receipt)
  emit('message.start', {}, 'chat-b')
  emit('message.start', {}, 'chat-a', 'other')
  assert.doesNotMatch(text(pane), /Processing/)
  assert.equal(storage.size, 0)
})

test('loads history through the focused connection and runtime session', async () => {
  const {pane} = load()
  globalThis.turnTimingsRequest = async (route, method, params) => {
    assert.equal(route.connectionId, 'local')
    assert.equal(method, 'session.history')
    assert.deepEqual(params, {session_id:'chat-a'})
    return {messages: snapshot}
  }
  try {
    text(pane)
    const rows = await globalThis.turnTimingsQuery.queryFn()
    assert.deepEqual(rows.map(row => row.row_id), [1, 2, 3, 4])
  } finally { delete globalThis.turnTimingsRequest }
})

test('stopped turns do not overwrite the most recent reply', () => {
  const {emit, pane, storage} = load()
  emit('message.start', {})
  emit('message.complete', { status:'interrupted' })
  assert.doesNotMatch(text(pane), /Processing|Latest reply/)
  assert.equal(storage.size, 0)
})
