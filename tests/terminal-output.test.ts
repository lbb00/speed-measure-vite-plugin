import { describe, it, expect, vi } from 'vitest'
import smvp from '../src/main'
import type { Plugin, ResolvedConfig } from 'vite'

describe('terminal output & formatting', () => {
  it('prints formatted report to console by default', async () => {
    const logs: string[] = []
    const logSpy = vi.spyOn(console, 'log').mockImplementation((msg: string) => {
      logs.push(msg)
    })

    const slowPlugin: Plugin = {
      name: 'vite:slow-plugin',
      async transform(code) {
        await new Promise((r) => setTimeout(r, 20))
        return code
      },
    }

    const fastPlugin: Plugin = {
      name: 'vite:fast-plugin',
      async transform(code) {
        await new Promise((r) => setTimeout(r, 5))
        return code
      },
    }

    const measure = smvp() as Plugin

    ;(measure as any).configResolved?.({
      command: 'build',
      plugins: [slowPlugin, fastPlugin, measure],
    } as unknown as ResolvedConfig)

    await (slowPlugin.transform as any).call({} as any, 'slow', 'slow.js')
    await (fastPlugin.transform as any).call({} as any, 'fast', 'fast.js')

    await (measure.closeBundle as any).call({} as any)

    logSpy.mockRestore()

    const fullLog = logs.join('\n')
    // Check [SMVP] header
    expect(fullLog).toContain('[SMVP]')
    // Check plugin names
    expect(fullLog).toContain('vite:slow-plugin')
    expect(fullLog).toContain('vite:fast-plugin')
    // Check transform hook breakdown
    expect(fullLog).toContain('transform')
    expect(fullLog).toContain('Total:')
    expect(fullLog).toContain('Parallel:')
    expect(fullLog).toContain('1 call')
    expect(fullLog).toContain('avg')
    // Check footer
    expect(fullLog).toContain('All plugins total time:')

    // By default, descending sort: slow plugin should appear before fast plugin
    const slowIndex = fullLog.indexOf('vite:slow-plugin')
    const fastIndex = fullLog.indexOf('vite:fast-plugin')
    expect(slowIndex).toBeLessThan(fastIndex)
  })

  it('supports custom sorting (e.g. ascending sort)', async () => {
    const logs: string[] = []
    const logSpy = vi.spyOn(console, 'log').mockImplementation((msg: string) => {
      logs.push(msg)
    })

    const slowPlugin: Plugin = {
      name: 'plugin-slow',
      async transform(code) {
        await new Promise((r) => setTimeout(r, 25))
        return code
      },
    }

    const fastPlugin: Plugin = {
      name: 'plugin-fast',
      async transform(code) {
        await new Promise((r) => setTimeout(r, 5))
        return code
      },
    }

    const measure = smvp({
      // Ascending sort: faster first
      sort: (a, b) => a - b,
    }) as Plugin

    ;(measure as any).configResolved?.({
      command: 'build',
      plugins: [slowPlugin, fastPlugin, measure],
    } as unknown as ResolvedConfig)

    await (slowPlugin.transform as any).call({} as any, 'a', 'a.js')
    await (fastPlugin.transform as any).call({} as any, 'b', 'b.js')

    await (measure.closeBundle as any).call({} as any)

    logSpy.mockRestore()

    const fullLog = logs.join('\n')
    const slowIndex = fullLog.indexOf('plugin-slow')
    const fastIndex = fullLog.indexOf('plugin-fast')

    // Ascending: fast plugin should appear before slow plugin
    expect(fastIndex).toBeLessThan(slowIndex)
  })

  it('does not print anything if statsMap is empty', async () => {
    const logs: string[] = []
    const logSpy = vi.spyOn(console, 'log').mockImplementation((msg: string) => {
      logs.push(msg)
    })

    const measure = smvp() as Plugin
    ;(measure as any).configResolved?.({
      command: 'build',
      plugins: [measure],
    } as unknown as ResolvedConfig)

    // closeBundle without any hook execution
    await (measure.closeBundle as any).call({} as any)

    logSpy.mockRestore()

    expect(logs.length).toBe(0)
  })
})
