import { describe, it, expect } from 'vitest'
import smvp, { type MeasureReport } from '../src/main'
import type { Plugin, ResolvedConfig } from 'vite'

describe('edge cases & robust concurrency', () => {
  it('correctly distinguishes total vs parallel time for concurrent hooks', async () => {
    let capturedReport: MeasureReport | null = null

    const concurrentPlugin: Plugin = {
      name: 'concurrent-plugin',
      async transform(code: string) {
        // Each call takes ~30ms
        await new Promise((r) => setTimeout(r, 30))
        return code
      },
    }

    const measure = smvp({
      output: (report) => {
        capturedReport = report
      },
    }) as Plugin

    ;(measure as any).configResolved?.({
      command: 'build',
      plugins: [concurrentPlugin, measure],
    } as unknown as ResolvedConfig)

    const transformFn = concurrentPlugin.transform as any

    // Run 3 transforms concurrently
    await Promise.all([
      transformFn.call({} as any, 'code1', 'file1.js'),
      transformFn.call({} as any, 'code2', 'file2.js'),
      transformFn.call({} as any, 'code3', 'file3.js'),
    ])

    await (measure.closeBundle as any).call({} as any)

    expect(capturedReport).not.toBeNull()
    const hook = capturedReport!.plugins[0].hooks[0]

    expect(hook.calls).toBe(3)
    // Total is the sum of all 3 calls (approx 3 * 30ms = ~90ms)
    expect(hook.total).toBeGreaterThanOrEqual(70)
    // Parallel is the wall-clock time (approx ~30-50ms)
    expect(hook.parallel).toBeGreaterThanOrEqual(25)
    expect(hook.parallel).toBeLessThan(hook.total)
  })

  it('prevents double-wrapping if configResolved runs multiple times', async () => {
    let capturedReport: MeasureReport | null = null

    const targetPlugin: Plugin = {
      name: 'target-plugin',
      transform(code) {
        return code + ' /* transformed */'
      },
    }

    const measure = smvp({
      output: (report) => {
        capturedReport = report
      },
    }) as Plugin

    const config = {
      command: 'build',
      plugins: [targetPlugin, measure],
    } as unknown as ResolvedConfig

    // Run configResolved twice
    ;(measure as any).configResolved?.(config)
    ;(measure as any).configResolved?.(config)

    // Call transform once
    await (targetPlugin.transform as any).call({} as any, 'test', 'test.js')
    await (measure.closeBundle as any).call({} as any)

    expect(capturedReport).not.toBeNull()
    const hook = capturedReport!.plugins[0].hooks[0]
    // Call count must be exactly 1, not 2
    expect(hook.calls).toBe(1)
  })

  it('supports pure Rollup mode via options hook fallback', async () => {
    let capturedReport: MeasureReport | null = null

    const rollupPlugin: Plugin = {
      name: 'rollup-only-plugin',
      transform(code) {
        return code + ' /* rollup */'
      },
    }

    const measure = smvp({
      output: (report) => {
        capturedReport = report
      },
    }) as Plugin

    // Simulate pure Rollup: no configResolved, only options() hook
    ;(measure.options as any)?.call({} as any, {
      plugins: [rollupPlugin, measure],
    } as any)

    await (rollupPlugin.transform as any).call({} as any, 'input', 'input.js')
    await (measure.closeBundle as any).call({} as any)

    expect(capturedReport).not.toBeNull()
    expect(capturedReport!.plugins[0].pluginName).toBe('rollup-only-plugin')
    expect(capturedReport!.plugins[0].hooks[0].calls).toBe(1)
  })

  it('handles unnamed plugins gracefully', async () => {
    let capturedReport: MeasureReport | null = null

    const unnamedPlugin = {
      transform(code: string) {
        return code
      },
    } as unknown as Plugin

    const measure = smvp({
      output: (report) => {
        capturedReport = report
      },
    }) as Plugin

    ;(measure as any).configResolved?.({
      command: 'build',
      plugins: [unnamedPlugin, measure],
    } as unknown as ResolvedConfig)

    await (unnamedPlugin.transform as any).call({} as any, 'code', 'file.js')
    await (measure.closeBundle as any).call({} as any)

    expect(capturedReport).not.toBeNull()
    expect(capturedReport!.plugins[0].pluginName).toMatch(/^unnamed_/)
  })

  it('handles non-Error exceptions in hooks gracefully', async () => {
    let capturedReport: MeasureReport | null = null

    const strangePlugin: Plugin = {
      name: 'strange-throw-plugin',
      transform() {
        throw 'Custom string error'
      },
    }

    const measure = smvp({
      output: (report) => {
        capturedReport = report
      },
    }) as Plugin

    ;(measure as any).configResolved?.({
      command: 'build',
      plugins: [strangePlugin, measure],
    } as unknown as ResolvedConfig)

    expect(() => {
      ;(strangePlugin.transform as any).call({} as any, 'code', 'file.js')
    }).toThrow('Custom string error')

    await (measure.closeBundle as any).call({} as any)

    expect(capturedReport).not.toBeNull()
    expect(capturedReport!.plugins[0].pluginName).toBe('strange-throw-plugin')
    expect(capturedReport!.plugins[0].hooks[0].calls).toBe(1)
  })
})
