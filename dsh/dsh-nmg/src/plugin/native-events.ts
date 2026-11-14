import { AgentAttributionFlow } from '../../../../src/integration/agent-attribution.ts'
import { messageText } from '../../../../src/integration/tool-observation.ts'
import { observeAdapterToolResult } from '../../../../src/integration/adapter-capability-assembly.ts'
import { deriveAnswerOverlapMemoryIds } from '../../../../src/core/feedback.ts'
import type { MemoryContext } from '../../../../src/core/types.ts'

type Agent = { id: string }
type Invoke = (
  method: string,
  params: Record<string, unknown>,
  signal?: AbortSignal,
) => Promise<unknown>
type Turn = { number: number; prompt: string; answer: string; ended: boolean }

/** DSH event translation; observation selection and attribution stay shared. */
export class DshNativeEvents {
  readonly #attribution: AgentAttributionFlow
  readonly #turns = new Map<string, Turn>()
  readonly #writes = new Map<string, Promise<void>>()
  readonly #nudges = new Set<string>()
  readonly #invoke: Invoke
  readonly #projectDir: string
  readonly #live: (agent: Agent) => boolean

  constructor(invoke: Invoke, projectDir: string, live: (agent: Agent) => boolean, attribution = new AgentAttributionFlow(32)) {
    this.#attribution = attribution
    this.#invoke = invoke
    this.#projectDir = projectDir
    this.#live = live
  }

  begin(sessionId: string, turn: number, prompt: string): void {
    if (this.#turns.get(sessionId)?.number === turn) return
    this.#turns.set(sessionId, { number: turn, prompt, answer: '', ended: false })
    this.#attribution.clear(sessionId)
  }

  note(sessionId: string, context: MemoryContext): void {
    this.#attribution.note(sessionId, context)
  }

  takeNudge(sessionId: string): boolean {
    return this.#nudges.delete(sessionId)
  }

  observe(
    exec: { agent?: Agent; name?: string; arguments?: unknown },
    result: { isError?: boolean; content?: unknown },
    observe = observeAdapterToolResult,
  ): Promise<void> {
    const agent = exec?.agent
    if (!agent?.id || !this.#live(agent) || String(exec.name).startsWith('nmg_'))
      return Promise.resolve()
    const name = String(exec.name)
    const observation = {
      toolName: ['shell', 'pwsh'].includes(name) ? 'bash' : name,
      input: exec.arguments,
      isError: result?.isError === true,
      content: result?.content,
    }
    return this.#enqueue(String(agent.id), async () => {
      if (!this.#live(agent)) return
      await observe({
        sessionId: String(agent.id),
        event: observation,
        onCommit: () => { this.#nudges.add(String(agent.id)) },
        invoke: (method, params) => this.#invoke(method, params, AbortSignal.timeout(2000)),
      })
    })
  }

  event(
    session: { id?: string },
    event: {
      type?: string
      data?: {
        turn?: number
        message?: { content?: unknown }
        interrupted?: boolean
        reason?: { kind?: string }
      }
    },
  ): Promise<void> {
    const id = String(session?.id ?? '')
    const data = event?.data
    if (!data) return Promise.resolve()
    const number = data.turn
    if (!id || !Number.isSafeInteger(number)) return Promise.resolve()
    const turn = this.#turns.get(id)
    if (!turn || turn.number !== number || turn.ended) return Promise.resolve()
    if (event.type === 'assistant/message' && !data.interrupted) {
      turn.answer = (turn.answer + '\n' + messageText(data.message?.content)).slice(-32000)
    }
    if (event.type !== 'turn/end') return Promise.resolve()
    return this.#finish(id, turn, data.reason?.kind)
  }

  #finish(id: string, turn: Turn, reason: string | undefined): Promise<void> {
    turn.ended = true
    const traces = this.#attribution.consume(id)
    if (reason !== 'completed' || !turn.answer.trim()) return Promise.resolve()
    const answer = turn.answer
    const prompt = turn.prompt
    return this.#enqueue(id, async () => {
      for (const trace of traces) {
        await this.#invoke(
          'recordActiveGraphAttribution',
          {
            activeGraphId: trace.traceId,
            sessionId: id,
            projectDir: this.#projectDir,
            attributedMemoryIds: deriveAnswerOverlapMemoryIds(answer, trace.results, prompt),
          },
          AbortSignal.timeout(2000),
        )
      }
    })
  }

  async clear(sessionId: string): Promise<void> {
    await this.#writes.get(sessionId)
    this.#turns.delete(sessionId)
    this.#attribution.clear(sessionId)
    this.#nudges.delete(sessionId)
  }

  async close(): Promise<void> {
    await Promise.allSettled(this.#writes.values())
    for (const id of this.#turns.keys()) await this.clear(id)
  }

  #enqueue(id: string, write: () => Promise<void>): Promise<void> {
    const pending = (this.#writes.get(id) ?? Promise.resolve()).then(write).catch(() => undefined)
    this.#writes.set(id, pending)
    void pending.finally(() => {
      if (this.#writes.get(id) === pending) this.#writes.delete(id)
    })
    return pending
  }
}
