import { beforeEach, describe, expect, it, vi } from 'vitest'

type InvokeCall = [string, Record<string, unknown>?]
const invoke = vi.fn(async (..._args: unknown[]) => undefined as unknown)
const listen = vi.fn(async (..._args: unknown[]) => () => {})

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invoke(...(args as [])),
  isTauri: () => true,
}))
vi.mock('@tauri-apps/api/event', () => ({
  listen: (...args: unknown[]) => listen(...(args as [])),
}))

import { tauriBridge } from '../../src/services/platform/tauriBridge'

/**
 * The renderer and the Rust commands only meet through these payloads, so the
 * field names are pinned here: a rename on one side would otherwise only
 * show up as a silent no-op at runtime.
 */
describe('tauri bridge', () => {
  beforeEach(() => {
    invoke.mockClear()
    listen.mockClear()
  })

  it('sends the live TTS session in the shape the Rust command expects', async () => {
    tauriBridge.fish.start({
      token: 'token-1',
      baseUrl: 'https://api.fish.audio',
      apiKey: 'key-1',
      model: 's2.1-pro-free',
      referenceId: 'ref-1',
      format: 'pcm',
      latency: 'balanced',
      sampleRate: 24000,
    })
    await new Promise((resolve) => setTimeout(resolve, 0))

    const call = invoke.mock.calls.find((entry) => entry[0] === 'fish_start') as InvokeCall | undefined
    expect(call).toBeTruthy()
    const args = call?.[1] as { payload: Record<string, unknown> }
    expect(args.payload).toEqual({
      token: 'token-1',
      baseUrl: 'https://api.fish.audio',
      apiKey: 'key-1',
      model: 's2.1-pro-free',
      referenceId: 'ref-1',
      format: 'pcm',
      latency: 'balanced',
      sampleRate: 24000,
    })
  })

  it('sends the live TTS follow-ups with the session token', async () => {
    tauriBridge.fish.text({ token: 'token-1', text: '你好' })
    tauriBridge.fish.flush({ token: 'token-1' })
    tauriBridge.fish.stop({ token: 'token-1' })
    await new Promise((resolve) => setTimeout(resolve, 0))

    const names = invoke.mock.calls.map((entry) => entry[0] as string)
    expect(names).toContain('fish_text')
    expect(names).toContain('fish_flush')
    expect(names).toContain('fish_stop')
    const text = invoke.mock.calls.find((entry) => entry[0] === 'fish_text') as InvokeCall | undefined
    expect(text?.[1]).toEqual({ token: 'token-1', text: '你好' })
  })

  it('reads the provider settings from the native database', async () => {
    invoke.mockResolvedValueOnce('{"providers":[]}' as never)
    const value = await tauriBridge.db.settings.get('providers')
    expect(value).toBe('{"providers":[]}')
    const call = invoke.mock.calls.find((entry) => entry[0] === 'db_settings_get') as InvokeCall | undefined
    expect(call?.[1]).toEqual({ key: 'providers' })
  })

  it('turns byte buffers into plain arrays for the Rust side', async () => {
    invoke.mockResolvedValueOnce({ saved: true, path: '/tmp/a.bin' } as never)
    await tauriBridge.saveFile({
      defaultName: 'a.bin',
      bytes: new Uint8Array([1, 2, 3]),
    })
    const call = invoke.mock.calls.find((entry) => entry[0] === 'file_save') as InvokeCall | undefined
    const args = call?.[1] as unknown as { bytes: number[]; defaultName: string }
    expect(args.bytes).toEqual([1, 2, 3])
    expect(args.defaultName).toBe('a.bin')
  })
})
