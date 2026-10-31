// Browser side of the harness chat UI. No build step and no dependencies: the page is served as-is.

const $ = (id) => document.getElementById(id)
const log = $('log')
const input = $('input')
const modelInput = $('model')

const state = { sessionId: null, controller: null }

// --- Rendering ---------------------------------------------------------------------------------

function escapeHtml(text) {
  return text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
}

function inlineMarkdown(text) {
  return text
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
}

function blockMarkdown(block) {
  const heading = /^(#{1,4})\s+(.*)$/.exec(block)
  if (heading) return `<h${heading[1].length + 2}>${inlineMarkdown(heading[2])}</h${heading[1].length + 2}>`
  const lines = block.split('\n')
  if (lines.every((line) => /^\s*[-*]\s+/.test(line))) {
    return `<ul>${lines.map((line) => `<li>${inlineMarkdown(line.replace(/^\s*[-*]\s+/, ''))}</li>`).join('')}</ul>`
  }
  if (lines.every((line) => /^\s*\d+\.\s+/.test(line))) {
    return `<ol>${lines.map((line) => `<li>${inlineMarkdown(line.replace(/^\s*\d+\.\s+/, ''))}</li>`).join('')}</ol>`
  }
  return `<p>${inlineMarkdown(block).replace(/\n/g, '<br>')}</p>`
}

// A deliberately small Markdown subset; input is escaped first so model output can never inject HTML.
function renderMarkdown(text) {
  const parts = escapeHtml(text).split(/```[^\n]*\n?/)
  return parts
    .map((part, i) => {
      if (i % 2 === 1) return `<pre><code>${part}</code></pre>`
      return part
        .split(/\n{2,}/)
        .map((block) => block.replace(/^\n+|\n+$/g, ''))
        .filter((block) => block.trim())
        .map(blockMarkdown)
        .join('')
    })
    .join('')
}

function add(element) {
  log.append(element)
  log.scrollTop = log.scrollHeight
  return element
}

function el(tag, className, text) {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

function details(className, title, body) {
  const node = el('details', className)
  node.append(el('summary', '', title), body)
  return node
}

// --- One agent turn ----------------------------------------------------------------------------

function createTurn() {
  const tools = new Map()
  let text = null
  let thinking = null

  const flushText = () => {
    text = null
    thinking = null
  }

  return {
    text(delta) {
      thinking = null
      text ??= add(el('div', 'msg agent'))
      text.dataset.raw = (text.dataset.raw ?? '') + delta
      text.innerHTML = renderMarkdown(text.dataset.raw)
      log.scrollTop = log.scrollHeight
    },
    thinking(delta) {
      if (!thinking) {
        const body = el('div')
        thinking = { body, node: add(details('thinking', 'thinking', body)) }
      }
      thinking.body.textContent += delta
    },
    toolStart({ id, name, input: toolInput }) {
      flushText()
      const node = add(details('tool running', name, el('pre', '', JSON.stringify(toolInput, null, 2))))
      tools.set(id, node)
    },
    toolEnd({ id, status, output }) {
      const node = tools.get(id)
      if (!node) return
      node.classList.remove('running')
      node.classList.toggle('error', status === 'error')
      node.querySelector('summary').textContent += status === 'error' ? ' — failed' : ' — done'
      if (output) node.append(el('pre', '', output))
    },
    approval({ id, prompt }) {
      flushText()
      const card = $('approval-template').content.firstElementChild.cloneNode(true)
      card.querySelector('.approval-prompt').textContent = prompt
      card
        .querySelectorAll('button')
        .forEach((button) => button.addEventListener('click', () => answerApproval(card, id, button.dataset.answer)))
      add(card)
    },
    error({ message }) {
      add(el('div', 'msg error', message))
    },
  }
}

const HANDLERS = {
  text: (turn, event) => turn.text(event.text),
  thinking: (turn, event) => turn.thinking(event.text),
  tool_start: (turn, event) => turn.toolStart(event),
  tool_end: (turn, event) => turn.toolEnd(event),
  approval: (turn, event) => turn.approval(event),
  error: (turn, event) => turn.error(event),
}

// --- Server calls ------------------------------------------------------------------------------

async function post(path, body, signal) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  })
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `${res.status} ${res.statusText}`)
  return res
}

async function answerApproval(card, id, answer) {
  card.classList.add('answered')
  const label = { y: 'approved', t: 'approved — tool trusted for this chat', n: 'denied' }[answer]
  card.querySelector('.approval-title').textContent = label
  await post('/api/approval', { sessionId: state.sessionId, id, answer }).catch((error) =>
    add(el('div', 'msg error', error.message))
  )
}

async function readEvents(res, onEvent) {
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader()
  let buffer = ''
  for (;;) {
    const { value, done } = await reader.read()
    if (done) return
    buffer += value
    const frames = buffer.split('\n\n')
    buffer = frames.pop()
    for (const frame of frames) {
      if (frame.startsWith('data: ')) onEvent(JSON.parse(frame.slice(6)))
    }
  }
}

function setBusy(busy) {
  $('send').disabled = busy
  $('stop').hidden = !busy
  input.disabled = busy
  if (!busy) input.focus()
}

async function send(message) {
  add(el('div', 'msg user', message))
  const turn = createTurn()
  state.controller = new AbortController()
  setBusy(true)
  try {
    const res = await post('/api/chat', { sessionId: state.sessionId, message }, state.controller.signal)
    await readEvents(res, (event) => HANDLERS[event.type]?.(turn, event))
  } catch (error) {
    if (error.name !== 'AbortError') turn.error(error)
  } finally {
    state.controller = null
    setBusy(false)
  }
}

async function startSession(model, resumeId) {
  const res = await post('/api/session', { model, resumeId })
  const { sessionId, history } = await res.json()
  state.sessionId = sessionId
  localStorage.setItem('harness-chat', JSON.stringify({ sessionId, model }))
  log.querySelectorAll('.msg, .tool, .thinking, .approval').forEach((node) => node.remove())
  for (const entry of history) {
    const node = add(el('div', `msg ${entry.role === 'user' ? 'user' : 'agent'}`))
    if (entry.role === 'user') node.textContent = entry.text
    else node.innerHTML = renderMarkdown(entry.text)
  }
}

// --- Wiring ------------------------------------------------------------------------------------

$('composer').addEventListener('submit', (event) => {
  event.preventDefault()
  const message = input.value.trim()
  if (!message || !state.sessionId) return
  input.value = ''
  send(message)
})

input.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter' || event.shiftKey) return
  event.preventDefault()
  $('composer').requestSubmit()
})

$('stop').addEventListener('click', () => {
  post('/api/cancel', { sessionId: state.sessionId }).catch(() => {})
  state.controller?.abort()
})

$('model-form').addEventListener('submit', (event) => {
  event.preventDefault()
  startSession(modelInput.value.trim()).catch((error) => add(el('div', 'msg error', error.message)))
})

async function init() {
  const config = await (await fetch('/api/config')).json()
  $('workspace').textContent = config.workspace
  $('key-warning').hidden = config.anthropicKey
  $('models').replaceChildren(...config.models.map((model) => Object.assign(el('option'), { value: model })))

  const saved = JSON.parse(localStorage.getItem('harness-chat') ?? 'null')
  modelInput.value = saved?.model ?? config.defaultModel
  await startSession(modelInput.value, saved?.sessionId)
  input.focus()
}

init().catch((error) => add(el('div', 'msg error', error.message)))
