/**
 * A local web UI for the Strands harness.
 *
 * Serves `public/` and a small JSON + Server-Sent Events API. Each browser chat owns one harness
 * agent; its turns stream to the page, and tool calls that can change things wait for approval
 * in the page before they run.
 */

import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { dirname, extname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHarness } from '@strands-agents/harness'
import type { Agent, AgentStreamEvent } from '@strands-agents/sdk'
import { HumanInTheLoop } from '@strands-agents/sdk/vended-interventions/hitl'

const APP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PUBLIC_DIR = join(APP_DIR, 'public')

if (existsSync(join(APP_DIR, '.env'))) process.loadEnvFile(join(APP_DIR, '.env'))

const PORT = Number(process.env.PORT ?? 3000)
const HOST = process.env.HOST ?? '127.0.0.1'
const WORKSPACE = resolve(APP_DIR, process.env.HARNESS_WORKSPACE ?? 'workspace')
const DEFAULT_MODEL = process.env.HARNESS_MODEL ?? 'anthropic/claude-sonnet-5-5'
const APPROVAL = process.env.HARNESS_APPROVAL === 'off' ? 'off' : 'ask'

const SUGGESTED_MODELS = [
  'anthropic/claude-sonnet-5-5',
  'anthropic/claude-opus-5-5',
  'anthropic/claude-haiku-5-5',
  'ollama/qwen3',
  'ollama/llama3.2',
]

// Tools that only read; everything else (shell, write, edit, subagents, code execution) asks first.
const READ_ONLY_TOOLS = ['read', 'web_fetch', 'web_search', 'todo_write']

const TOOL_OUTPUT_LIMIT = 4000

const DENY = 'n'

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
}

type UiEvent = Record<string, unknown> & { type: string }

interface Session {
  id: string
  model: string
  agent: Agent
  busy: boolean
  send: ((event: UiEvent) => void) | null
  approvals: Map<string, (answer: string) => void>
}

const sessions = new Map<string, Session>()

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message)
  }
}

// --- Agents -----------------------------------------------------------------------------------

function approvalHandler(session: () => Session): HumanInTheLoop {
  return new HumanInTheLoop({
    allowedTools: READ_ONLY_TOOLS,
    enableTrust: true,
    ask: (prompt) =>
      new Promise<string>((resolveAnswer) => {
        const current = session()
        if (!current.send) return resolveAnswer(DENY)
        const id = randomUUID()
        current.approvals.set(id, resolveAnswer)
        current.send({ type: 'approval', id, prompt })
      }),
  })
}

async function openSession(model: string, resumeId?: string): Promise<Session> {
  const existing = resumeId ? sessions.get(resumeId) : undefined
  if (existing && existing.model === model) return existing

  let session: Session | undefined
  const agent = await createHarness({
    model,
    session: { dir: join(WORKSPACE, '.agent', 'sessions'), ...(resumeId && { id: resumeId }) },
    interventions: APPROVAL === 'ask' ? [approvalHandler(() => session!)] : 'off',
  })
  // Restores a resumed session's messages now, so the page can show them before the next turn.
  await agent.initialize()
  session = { id: agent.sessionId, model, agent, busy: false, send: null, approvals: new Map() }
  sessions.set(session.id, session)
  console.log(`session=<${session.id}>, model=<${model}> | session opened`)
  return session
}

function denyPendingApprovals(session: Session): void {
  for (const answer of session.approvals.values()) answer(DENY)
  session.approvals.clear()
}

// --- Stream translation ------------------------------------------------------------------------

function toolResultText(content: readonly unknown[]): string {
  const text = content
    .map((block) => {
      const item = block as { text?: unknown; json?: unknown }
      if (typeof item.text === 'string') return item.text
      return item.json === undefined ? '' : JSON.stringify(item.json, null, 2)
    })
    .join('\n')
  return text.length > TOOL_OUTPUT_LIMIT ? `${text.slice(0, TOOL_OUTPUT_LIMIT)}\n… (truncated)` : text
}

function modelUpdate(event: AgentStreamEvent & { type: 'modelStreamUpdateEvent' }): UiEvent | null {
  const update = event.event
  if (update.type !== 'modelContentBlockDeltaEvent') return null
  if (update.delta.type === 'textDelta') return { type: 'text', text: update.delta.text }
  if (update.delta.type === 'reasoningContentDelta' && update.delta.text) {
    return { type: 'thinking', text: update.delta.text }
  }
  return null
}

function toUiEvent(event: AgentStreamEvent): UiEvent | null {
  switch (event.type) {
    case 'modelStreamUpdateEvent':
      return modelUpdate(event)
    case 'beforeToolCallEvent':
      return { type: 'tool_start', id: event.toolUse.toolUseId, name: event.toolUse.name, input: event.toolUse.input }
    case 'afterToolCallEvent':
      return {
        type: 'tool_end',
        id: event.toolUse.toolUseId,
        status: event.result.status,
        output: toolResultText(event.result.content),
      }
    default:
      return null
  }
}

// --- History -----------------------------------------------------------------------------------

interface HistoryEntry {
  role: string
  text: string
}

function messageText(content: readonly unknown[]): string {
  return content
    .map((block) => block as { type?: string; text?: string })
    .filter((block) => block.type === 'textBlock' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
}

function history(agent: Agent): HistoryEntry[] {
  return agent.messages
    .map((message) => ({ role: message.role, text: messageText(message.content) }))
    .filter((entry) => entry.text.trim() !== '')
}

// --- HTTP plumbing -----------------------------------------------------------------------------

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]'])

// The agent can run shell commands, so a request from any other origin (a web page the user happens
// to have open, or a DNS-rebound hostname) must never reach it.
function assertSameOrigin(req: IncomingMessage): void {
  const hostname = new URL(`http://${req.headers.host ?? 'invalid'}`).hostname
  if (!LOCAL_HOSTNAMES.has(hostname) && hostname !== HOST) throw new HttpError(403, 'unexpected host')
  const origin = req.headers.origin
  if (origin && origin !== `http://${req.headers.host}`) throw new HttpError(403, 'cross-origin request refused')
  if (!req.headers['content-type']?.startsWith('application/json')) throw new HttpError(415, 'expected JSON')
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  assertSameOrigin(req)
  let raw = ''
  for await (const chunk of req) raw += chunk
  try {
    return raw ? (JSON.parse(raw) as Record<string, unknown>) : {}
  } catch {
    throw new HttpError(400, 'invalid JSON body')
  }
}

function stringField(body: Record<string, unknown>, key: string): string {
  const value = body[key]
  if (typeof value !== 'string' || value.trim() === '') throw new HttpError(400, `missing "${key}"`)
  return value.trim()
}

function sessionFrom(body: Record<string, unknown>): Session {
  const session = sessions.get(stringField(body, 'sessionId'))
  if (!session) throw new HttpError(404, 'unknown session; start a new chat')
  return session
}

async function serveStatic(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const path = new URL(req.url ?? '/', 'http://localhost').pathname
  const file = resolve(PUBLIC_DIR, `.${path === '/' ? '/index.html' : path}`)
  if (!file.startsWith(PUBLIC_DIR + sep)) throw new HttpError(404, 'not found')
  const body = await readFile(file).catch(() => {
    throw new HttpError(404, 'not found')
  })
  res.writeHead(200, { 'content-type': CONTENT_TYPES[extname(file)] ?? 'application/octet-stream' })
  res.end(body)
}

// --- Routes ------------------------------------------------------------------------------------

function getConfig(_req: IncomingMessage, res: ServerResponse): void {
  sendJson(res, 200, {
    defaultModel: DEFAULT_MODEL,
    models: [...new Set([DEFAULT_MODEL, ...SUGGESTED_MODELS])],
    workspace: WORKSPACE,
    approval: APPROVAL,
    anthropicKey: Boolean(process.env.ANTHROPIC_API_KEY),
  })
}

async function postSession(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJson(req)
  const resumeId = typeof body.resumeId === 'string' && body.resumeId ? body.resumeId : undefined
  const session = await openSession(stringField(body, 'model'), resumeId)
  sendJson(res, 200, { sessionId: session.id, model: session.model, history: history(session.agent) })
}

async function postChat(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJson(req)
  const session = sessionFrom(body)
  const message = stringField(body, 'message')
  if (session.busy) throw new HttpError(409, 'the agent is still working on the previous message')

  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
  const send = (event: UiEvent): void => void res.write(`data: ${JSON.stringify(event)}\n\n`)
  session.busy = true
  session.send = send
  res.on('close', () => {
    if (!session.busy) return
    session.agent.cancel()
    denyPendingApprovals(session)
  })

  try {
    for await (const event of session.agent.stream(message)) {
      const uiEvent = toUiEvent(event)
      if (uiEvent) send(uiEvent)
    }
    send({ type: 'done' })
  } catch (error) {
    send({ type: 'error', message: error instanceof Error ? error.message : String(error) })
  } finally {
    session.busy = false
    session.send = null
    denyPendingApprovals(session)
    res.end()
  }
}

async function postApproval(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJson(req)
  const session = sessionFrom(body)
  const id = stringField(body, 'id')
  const answer = session.approvals.get(id)
  if (!answer) throw new HttpError(404, 'that approval is no longer pending')
  session.approvals.delete(id)
  answer(stringField(body, 'answer'))
  sendJson(res, 200, { ok: true })
}

async function postCancel(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const session = sessionFrom(await readJson(req))
  session.agent.cancel()
  denyPendingApprovals(session)
  sendJson(res, 200, { ok: true })
}

type Route = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>

const ROUTES: Record<string, Route> = {
  'GET /api/config': getConfig,
  'POST /api/session': postSession,
  'POST /api/chat': postChat,
  'POST /api/approval': postApproval,
  'POST /api/cancel': postCancel,
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const path = new URL(req.url ?? '/', 'http://localhost').pathname
  const route = ROUTES[`${req.method} ${path}`]
  try {
    if (route) return await route(req, res)
    if (req.method === 'GET') return await serveStatic(req, res)
    throw new HttpError(404, 'not found')
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 500
    const message = error instanceof Error ? error.message : String(error)
    if (status === 500) console.error(error)
    if (!res.headersSent) sendJson(res, status, { error: message })
    else res.end()
  }
}

await mkdir(WORKSPACE, { recursive: true })
// The harness's shell and file tools work relative to the process directory.
process.chdir(WORKSPACE)

if (HOST !== '127.0.0.1' && HOST !== 'localhost') {
  console.warn(`host=<${HOST}> | listening beyond this machine lets anyone who can reach it run shell commands`)
}

createServer((req, res) => void handle(req, res)).listen(PORT, HOST, () => {
  console.log(`workspace=<${WORKSPACE}>, model=<${DEFAULT_MODEL}>, approval=<${APPROVAL}> | harness chat ui ready`)
  console.log(`open http://${HOST === '127.0.0.1' ? 'localhost' : HOST}:${PORT}`)
})
