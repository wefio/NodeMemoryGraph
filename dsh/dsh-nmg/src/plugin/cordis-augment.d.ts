// Ambient module augmentation for the DSH runtime capabilities this package
// consumes. The registry `@deepseek-ai/cordis` base Context only declares the
// core services (events/logger/reflect/registry); the members below are added
// by DSH ecosystem packages at runtime and are declared here per the standard
// `declare module '@deepseek-ai/cordis'` augmentation pattern used across
// @deepseek-ai/dsh-*. Keeping them local makes this package typecheck in
// isolation and never requires a full DSH install on disk.

import type { Context } from '@deepseek-ai/cordis'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** DSH tools registry (dsh-tools). Registered model tools are callable next step. */
    tools: import('@deepseek-ai/cordis').Context & {
      register(tool: unknown): unknown
      executionMode(exec: unknown): { kind: string }
    }
    /** DSH subprocess service (dsh-subprocess). */
    subprocess: {
      resolveExecutable(name: string): Promise<string>
      exec(command: string, options?: unknown): Promise<unknown>
      spawn(spec: {
        argv: readonly string[]
        cwd: string
        stdio?: unknown
        graceMs?: number
        signal?: AbortSignal
      }): {
        done: Promise<{ exitCode: number }>
        collected: {
          stdout?: { readFrom(offset: number): { text: string } }
          stderr?: { readFrom(offset: number): { text: string } }
        }
      }
    }
    /** DSH sandbox policy (dsh-sandbox-policy). */
    sandboxPolicy: { workspaceRoot: string }
    /** DSH systemPrompt service; `.context` registers named durable context contributions. */
    systemPrompt: {
      context(contribution: unknown): unknown
    }
    /** DSH subagents registry (dsh-subagent): continuable child enumeration + followup. */
    subagents?: {
      listChildren(parentSessionId: string, signal?: AbortSignal): Promise<
        Array<{
          kind: string
          id: string
          mode: string
          label?: string
        }>
      >
      followup(
        parent: unknown,
        childId: string,
        content: Array<{ type: string; text: string }>,
        options: { source: unknown; signal: AbortSignal },
      ): Promise<string>
    }
    /** Timer mixin (cordis-plugin-timer): one-shot delay and periodic interval. */
    timeout(callback: () => void, delay: number): unknown
    interval(callback: () => void, delay: number): unknown
  }

  interface Events {
    /** A message was inserted into an agent's inbox (agent loop). */
    'agent/inbox/inserted'(payload: { message: unknown }): void
    /** An agent was disposed (agent loop). */
    'agent/disposed'(payload: unknown): void
  }
}

export {}