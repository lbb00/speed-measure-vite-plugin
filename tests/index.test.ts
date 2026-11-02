import { describe, it, expect, vi } from 'vitest'
import smvp, { type MeasureReport } from '../src/main'
import type { Plugin, ResolvedConfig } from 'vite'

function createFakePlugin(name: string, delayMs = 0): Plugin {
  return {
    name,
    async transform(code: string, id: string) {
      if (delayMs > 0) {
        await new Promise((r) => setTimeout(r, delayMs))
      }
      return code + `\n/* transformed by ${name} */`
    },
  }
}

describe('speed-measure-vite-plugin', () => {
  it('supports modern plugin usage with custom output handler', async () => {
    let capturedReport: MeasureReport | null = null

    const fakePlugin1 = createFakePlugin('fake-1', 15)
    const fakePlugin2 = createFakePlugin('fake-2', 10)

    const measure = smvp({
      output: (report) => {
        capturedReport = report
      },
    }) as Plugin

    expect(measure.name).toBe('speed-measure-vite-plugin')
    expect(measure.enforce).toBe('post')

    // Simulate Vite configResolved
    const fakeConfig: any = {
      command: 'build',
      plugins: [fakePlugin1, fakePlugin2, measure],
    }

    ;(measure as any).configResolved?.(fakeConfig as ResolvedConfig)

    // Run transform hooks
    await (fakePlugin1.transform as any).call({} as any, 'console.log(1)', 'file1.js')
    await (fakePlugin2.transform as any).call({} as any, 'console.log(2)', 'file2.js')

    // Simulate closeBundle
    await (measure.closeBundle as any).call({} as any)

    expect(capturedReport).not.toBeNull()
    expect(capturedReport!.plugins.length).toBe(2)

    const p1 = capturedReport!.plugins.find((p) => p.pluginName === 'fake-1')
    const p2 = capturedReport!.plugins.find((p) => p.pluginName === 'fake-2')

    expect(p1).toBeDefined()
    expect(p1!.total).toBeGreaterThanOrEqual(10)
    expect(p1!.hooks[0].calls).toBe(1)
    expect(p1!.hooks[0].hookName).toBe('transform')

    expect(p2).toBeDefined()
    expect(p2!.total).toBeGreaterThanOrEqual(8)
    expect(p2!.hooks[0].calls).toBe(1)
  })

  it('supports legacy wrapper usage: smvp([plugins])', async () => {
    let capturedReport: MeasureReport | null = null
    const fakePlugin = createFakePlugin('legacy-plugin', 10)

    const wrappedPlugins = smvp([fakePlugin], {
      output: (report) => {
        capturedReport = report
      },
    })

    expect(Array.isArray(wrappedPlugins)).toBe(true)
    expect(wrappedPlugins.length).toBe(2)

    const measure = wrappedPlugins[1] as Plugin
    expect(measure.name).toBe('speed-measure-vite-plugin')

    const fakeConfig: any = {
      command: 'build',
      plugins: wrappedPlugins,
    }

    ;(measure as any).configResolved?.(fakeConfig)

    await (fakePlugin.transform as any).call({} as any, 'test', 'index.js')
    await (measure.closeBundle as any).call({} as any)

    expect(capturedReport).not.toBeNull()
    expect(capturedReport!.plugins[0].pluginName).toBe('legacy-plugin')
    expect(capturedReport!.plugins[0].hooks[0].calls).toBe(1)
  })

  it('supports single plugin wrapper: smvp(plugin)', async () => {
    let capturedReport: MeasureReport | null = null
    const fakePlugin = createFakePlugin('single-plugin', 10)

    const wrappedPlugins = smvp(fakePlugin, {
      output: (report) => {
        capturedReport = report
      },
    })

    expect(Array.isArray(wrappedPlugins)).toBe(true)
    const measure = wrappedPlugins[1] as Plugin

    ;(measure as any).configResolved?.({ command: 'build', plugins: wrappedPlugins } as any)
    await (fakePlugin.transform as any).call({} as any, 'test', 'index.js')
    await (measure.closeBundle as any).call({} as any)

    expect(capturedReport).not.toBeNull()
    expect(capturedReport!.plugins[0].pluginName).toBe('single-plugin')
  })

  it('handles object hooks syntax ({ order: "pre", handler })', async () => {
    let capturedReport: MeasureReport | null = null

    const objectHookPlugin: Plugin = {
      name: 'object-hook-plugin',
      transform: {
        order: 'pre',
        handler(code: string) {
          return code + ' /* transformed */'
        },
      },
    }

    const measure = smvp({
      output: (report) => {
        capturedReport = report
      },
    }) as Plugin

    ;(measure as any).configResolved?.({
      command: 'build',
      plugins: [objectHookPlugin, measure],
    } as any)

    const handler = (objectHookPlugin.transform as any).handler
    const res = await handler.call({} as any, 'const a = 1', 'test.js')
    expect(res).toContain('/* transformed */')

    await (measure.closeBundle as any).call({} as any)

    expect(capturedReport).not.toBeNull()
    expect(capturedReport!.plugins[0].pluginName).toBe('object-hook-plugin')
    expect(capturedReport!.plugins[0].hooks[0].calls).toBe(1)
  })

  it('handles async Promise hooks and preserves this context', async () => {
    let capturedReport: MeasureReport | null = null
    let capturedContext: any = null

    const asyncPlugin: Plugin = {
      name: 'async-plugin',
      async transform(this: any, code: string) {
        capturedContext = this
        await new Promise((r) => setTimeout(r, 15))
        return code + ' /* async done */'
      },
    }

    const measure = smvp({
      output: (report) => {
        capturedReport = report
      },
    }) as Plugin

    ;(measure as any).configResolved?.({
      command: 'build',
      plugins: [asyncPlugin, measure],
    } as any)

    const fakeThis = { fakeId: 123 }
    const res = await (asyncPlugin.transform as any).call(fakeThis, 'abc', 'abc.js')

    expect(res).toBe('abc /* async done */')
    expect(capturedContext).toBe(fakeThis)

    await (measure.closeBundle as any).call({} as any)

    expect(capturedReport).not.toBeNull()
    expect(capturedReport!.plugins[0].total).toBeGreaterThanOrEqual(12)
  })

  it('records timing and propagates errors when a hook throws', async () => {
    let capturedReport: MeasureReport | null = null

    const errorPlugin: Plugin = {
      name: 'error-plugin',
      transform() {
        throw new Error('Boom!')
      },
    }

    const measure = smvp({
      output: (report) => {
        capturedReport = report
      },
    }) as Plugin

    ;(measure as any).configResolved?.({
      command: 'build',
      plugins: [errorPlugin, measure],
    } as any)

    expect(() => {
      ;(errorPlugin.transform as any).call({} as any, 'code', 'file.js')
    }).toThrow('Boom!')

    await (measure.closeBundle as any).call({} as any)

    expect(capturedReport).not.toBeNull()
    expect(capturedReport!.plugins[0].pluginName).toBe('error-plugin')
    expect(capturedReport!.plugins[0].hooks[0].calls).toBe(1)
  })

  it('respects threshold option to filter out fast plugins', async () => {
    let capturedReport: MeasureReport | null = null

    const fastPlugin = createFakePlugin('fast-plugin', 1)
    const slowPlugin = createFakePlugin('slow-plugin', 25)

    const measure = smvp({
      threshold: 20, // Only show plugins taking >= 20ms
      output: (report) => {
        capturedReport = report
      },
    }) as Plugin

    ;(measure as any).configResolved?.({
      command: 'build',
      plugins: [fastPlugin, slowPlugin, measure],
    } as any)

    await (fastPlugin.transform as any).call({} as any, 'fast', 'fast.js')
    await (slowPlugin.transform as any).call({} as any, 'slow', 'slow.js')

    await (measure.closeBundle as any).call({} as any)

    expect(capturedReport).not.toBeNull()
    expect(capturedReport!.plugins.length).toBe(1)
    expect(capturedReport!.plugins[0].pluginName).toBe('slow-plugin')
  })

  it('supports measuring multiple hooks: resolveId, load, transform', async () => {
    let capturedReport: MeasureReport | null = null

    const multiHookPlugin: Plugin = {
      name: 'multi-hook-plugin',
      resolveId(id) {
        return id === 'virtual:test' ? id : null
      },
      load(id) {
        if (id === 'virtual:test') return 'export default 42'
        return null
      },
      transform(code) {
        return code
      },
    }

    const measure = smvp({
      hooks: ['resolveId', 'load', 'transform'],
      output: (report) => {
        capturedReport = report
      },
    }) as Plugin

    ;(measure as any).configResolved?.({
      command: 'build',
      plugins: [multiHookPlugin, measure],
    } as any)

    await (multiHookPlugin.resolveId as any).call({} as any, 'virtual:test', undefined, {})
    await (multiHookPlugin.load as any).call({} as any, 'virtual:test')
    await (multiHookPlugin.transform as any).call({} as any, 'export default 42', 'virtual:test')

    await (measure.closeBundle as any).call({} as any)

    expect(capturedReport).not.toBeNull()
    const pluginReport = capturedReport!.plugins[0]
    expect(pluginReport.hooks.length).toBe(3)
    const hookNames = pluginReport.hooks.map((h) => h.hookName)
    expect(hookNames).toContain('resolveId')
    expect(hookNames).toContain('load')
    expect(hookNames).toContain('transform')
  })

  it('respects disable option', async () => {
    const fakePlugin = createFakePlugin('disabled-target', 10)
    const originalTransform = fakePlugin.transform

    const measure = smvp({ disable: true }) as Plugin
    expect(measure.name).toBe('speed-measure-vite-plugin:disabled')

    ;(measure as any).configResolved?.({
      command: 'build',
      plugins: [fakePlugin, measure],
    } as any)

    expect(fakePlugin.transform).toBe(originalTransform)
  })

  it('supports Vite 6 Environment API', async () => {
    let capturedReport: MeasureReport | null = null

    const rootPlugin = createFakePlugin('root-plugin', 5)
    const ssrPlugin = createFakePlugin('ssr-plugin', 10)

    const measure = smvp({
      output: (report) => {
        capturedReport = report
      },
    }) as Plugin

    const fakeConfig: any = {
      command: 'build',
      plugins: [rootPlugin, measure],
      environments: {
        ssr: {
          plugins: [ssrPlugin],
        },
      },
    }

    ;(measure as any).configResolved?.(fakeConfig)

    await (rootPlugin.transform as any).call({} as any, 'client', 'app.js')
    await (ssrPlugin.transform as any).call({} as any, 'ssr', 'server.js')

    await (measure.closeBundle as any).call({} as any)

    expect(capturedReport).not.toBeNull()
    const names = capturedReport!.plugins.map((p) => p.pluginName)
    expect(names).toContain('root-plugin')
    expect(names).toContain('ssr-plugin')
  })

  it('flushes debounced metrics in dev mode after idle', async () => {
    vi.useFakeTimers()
    let capturedReport: MeasureReport | null = null

    const fakePlugin: Plugin = {
      name: 'dev-plugin',
      transform(code) {
        return code
      },
    }

    const measure = smvp({
      maxGapTimeOnce: 300,
      output: (report) => {
        capturedReport = report
      },
    }) as Plugin

    ;(measure as any).configResolved?.({
      command: 'serve',
      plugins: [fakePlugin, measure],
    } as any)

    // Execute transform in dev mode
    ;(fakePlugin.transform as any).call({} as any, 'code', 'file.js')

    // Before debounce time
    expect(capturedReport).toBeNull()

    // Advance timers by 350ms
    vi.advanceTimersByTime(350)

    expect(capturedReport).not.toBeNull()
    expect(capturedReport!.plugins[0].pluginName).toBe('dev-plugin')

    vi.useRealTimers()
  })
})
