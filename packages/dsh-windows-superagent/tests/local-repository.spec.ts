/** The local repository a deployment without GitHub works in: created on demand, or rejected when it is not a git repository. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { resolveGithub, resolveLocalRepository, GITHUB_OPTIONAL_CODES } from '../src/deployment.ts'
import type { Machine } from '../src/deployment.ts'
import { NO_HEARTBEAT } from '../src/app/heartbeat.ts'

let dir: string
/** Mutable Volatile stand-in for the machine's live limits. */
const reference = <T>(value: T) => ({ get: () => value, set: () => {} }) as never

const machine = (): Machine => ({
  stateDir: dir, promptMaxChars: reference(100000), admissionContextMaxPages: reference(10),
  admissionContextTimeoutMs: reference(15000), heartbeat: NO_HEARTBEAT,
})

/** A subprocess stand-in that records each argv and answers with the verdict the test chooses. */
function subprocessThat(verdict: (argv: string[]) => boolean, calls: string[][] = []): SubprocessRuntime {
  return {
    spawn: (spec: { argv: readonly string[] }) => {
      calls.push([...spec.argv])
      const ok = verdict([...spec.argv])
      const reader = { readFrom: () => ({ text: ok ? '' : 'fatal: not a git repository' }) }
      return { done: Promise.resolve({ exitCode: ok ? 0 : 1 }), collected: { stdout: reader, stderr: reader } }
    },
  } as unknown as SubprocessRuntime
}

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'local-repo-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe('resolveLocalRepository', () => {
  it('initialises <stateDir>/workspace/repo with one empty commit when it does not exist', async () => {
    const calls: string[][] = []
    const local = await resolveLocalRepository(machine(), '', subprocessThat(() => true, calls), new AbortController().signal)
    expect(local).toEqual({ root: join(dir, 'workspace', 'repo'), created: true })
    expect(calls[0]).toEqual(['git', 'init', '-b', 'main'])
    // The operator's git identity is preferred; the fallback only appears when git has none.
    expect(calls.some(argv => argv[0] === 'git' && argv[1] === 'config' && argv[2] === 'user.name')).toBe(true)
    expect(calls.some(argv => argv.join(' ') === 'git commit --allow-empty -m Initial commit (dsh-windows-superagent)')).toBe(true)
  })

  it('uses the configured repositoryPath instead of the default', async () => {
    const target = join(dir, 'elsewhere', 'repo')
    mkdirSync(target, { recursive: true })
    const local = await resolveLocalRepository(machine(), target, subprocessThat(() => true), new AbortController().signal)
    expect(local).toEqual({ root: target, created: false })
  })

  it('reports localRepositoryInvalid when the directory is not a git repository', async () => {
    const target = join(dir, 'plain')
    mkdirSync(target, { recursive: true })
    writeFileSync(join(target, 'file.txt'), 'x')
    await expect(resolveLocalRepository(machine(), target, subprocessThat(() => false), new AbortController().signal))
      .rejects.toEqual(expect.objectContaining({ place: 'deployment', code: 'localRepositoryInvalid' }))
  })
})

describe('GitHub degradation', () => {
  it('marks the GitHub setup errors optional so setup can continue without GitHub', () => {
    for (const code of ['repositoryUnset', 'agentCliSignedOut', 'repositoryUnreadable', 'repositoryReadOnly'] as const) {
      expect(GITHUB_OPTIONAL_CODES.has(code)).toBe(true)
    }
    expect(GITHUB_OPTIONAL_CODES.has('environmentFailed')).toBe(false)
  })

  it('resolveGithub still rejects a Source that names no repository', async () => {
    const probe = async () => ''
    await expect(resolveGithub(machine(), { repository: '', cli: 'gh' }, probe)).rejects.toEqual(expect.objectContaining({ code: 'repositoryUnset' }))
  })
})
