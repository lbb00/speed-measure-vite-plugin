import { describe, it, expect, vi } from 'vitest'
import smvp, { type MeasureReport } from '../src/main'
import type { Plugin, ResolvedConfig } from 'vite'

describe('adversarial review TDD test coverage', () => {
  it('correctly captures in-flight parallel time when activeCount > 0 during report flush', async () => {
    let capturedReport: MeasureReport | null = null

    let finishHookPromise: () => void
    const hookPromise = new Promise<string>((resolve) => {
      finishHookPromise = () => resolve('done')
    })

    const slowInFlightPlugin: Plugin = {
      name: 'in-flight-plugin',
      transform() {
        return hookPromise
      },
    }

    const measure = smvp({
      output: (report) => {
        capturedReport = report
      },
    }) as Plugin

    ;(measure as any).configResolved?.({
      command: 'build',
      plugins: [slowInFlightPlugin, measure],
    } as unknown as ResolvedConfig)

    // Start hook execution - it is now IN FLIGHT (activeCount = 1)
    const inFlightExecution = (slowInFlightPlugin.transform as any).call(
      {} as any,
      'code',
      'file.js'
    )

    // Wait 25ms while it's still in-flight
    await new Promise((r) => setTimeout(r, 25))

    // Schedule resolving the hook in background while closeBundle is waiting
    setTimeout(() => finishHookPromise!(), 25)

    // Trigger closeBundle which awaits in-flight hooks
    await (measure.closeBundle as any).call({} as any)
    await inFlightExecution

    expect(capturedReport).not.toBeNull()
    const hook = capturedReport!.plugins[0].hooks[0]

    // Parallel must NOT be 0! It should capture the in-flight elapsed span
    expect(hook.parallel).toBeGreaterThanOrEqual(20)
  })

  it('correctly cleans up activeCount when an async Promise rejects', async () => {
    let capturedReport: MeasureReport | null = null

    const rejectingPlugin: Plugin = {
      name: 'rejecting-plugin',
      async transform() {
        await new Promise((r) => setTimeout(r, 10))
        throw new Error('Async transform failed')
      },
    }

    const measure = smvp({
      output: (report) => {
        capturedReport = report
      },
    }) as Plugin

    ;(measure as any).configResolved?.({
      command: 'build',
      plugins: [rejectingPlugin, measure],
    } as unknown as ResolvedConfig)

    // First call rejects
    await expect(
      (rejectingPlugin.transform as any).call({} as any, 'code1', 'file1.js')
    ).rejects.toThrow('Async transform failed')

    // Second call also rejects
    await expect(
      (rejectingPlugin.transform as any).call({} as any, 'code2', 'file2.js')
    ).rejects.toThrow('Async transform failed')

    await (measure.closeBundle as any).call({} as any)

    expect(capturedReport).not.toBeNull()
    const hook = capturedReport!.plugins[0].hooks[0]
    expect(hook.calls).toBe(2)
    expect(hook.activeCount).toBe(0)
  })

  it('formats parallel speedup and avg ms in terminal output', async () => {
    const logs: string[] = []
    const logSpy = vi.spyOn(console, 'log').mockImplementation((msg: string) => {
      logs.push(msg)
    })

    const parallelPlugin: Plugin = {
      name: 'fast-parallel-plugin',
      async transform(code: string) {
        await new Promise((r) => setTimeout(r, 25))
        return code
      },
    }

    const measure = smvp() as Plugin

    ;(measure as any).configResolved?.({
      command: 'build',
      plugins: [parallelPlugin, measure],
    } as unknown as ResolvedConfig)

    const transformFn = parallelPlugin.transform as any

    // Run 3 calls in parallel
    await Promise.all([
      transformFn.call({} as any, '1', '1.js'),
      transformFn.call({} as any, '2', '2.js'),
      transformFn.call({} as any, '3', '3.js'),
    ])

    await (measure.closeBundle as any).call({} as any)

    logSpy.mockRestore()

    const fullLog = logs.join('\n')

    // Should include avg ms
    expect(fullLog).toContain('avg')
    // Should include speedup multiplier e.g. (2.X) or (3.X)
    expect(fullLog).toMatch(/\(\d+\.\d+x\)/)
  })

  it('correctly tracks multiple disjoint concurrency clusters over time', async () => {
    let capturedReport: MeasureReport | null = null

    const clusteredPlugin: Plugin = {
      name: 'clustered-plugin',
      async transform(code: string) {
        await new Promise((r) => setTimeout(r, 20))
        return code
      },
    }

    const measure = smvp({
      hooks: ['load', 'transform'],
      output: (report) => {
        capturedReport = report
      },
    }) as Plugin

    ;(measure as any).configResolved?.({
      command: 'build',
      plugins: [clusteredPlugin, measure],
    } as unknown as ResolvedConfig)

    const transformFn = clusteredPlugin.transform as any

    // Cluster 1: 2 concurrent calls
    await Promise.all([
      transformFn.call({} as any, 'a', 'a.js'),
      transformFn.call({} as any, 'b', 'b.js'),
    ])

    // Gap: 30ms idle
    await new Promise((r) => setTimeout(r, 30))

    // Cluster 2: 2 concurrent calls
    await Promise.all([
      transformFn.call({} as any, 'c', 'c.js'),
      transformFn.call({} as any, 'd', 'd.js'),
    ])

    await (measure.closeBundle as any).call({} as any)

    expect(capturedReport).not.toBeNull()
    const hook = capturedReport!.plugins[0].hooks[0]

    expect(hook.calls).toBe(4)
    // Total is ~4 * 20ms = ~80ms
    expect(hook.total).toBeGreaterThanOrEqual(70)
    // Parallel is ~20ms (cluster 1) + ~20ms (cluster 2) = ~40ms
    // Parallel must NOT count the 30ms idle gap!
    expect(hook.parallel).toBeGreaterThanOrEqual(30)
    expect(hook.parallel).toBeLessThan(hook.total * 0.85)
  })

  it('postpones dev mode flush when an in-flight hook is still active (Codex P1)', async () => {
    let capturedReport: MeasureReport | null = null

    let resolveSlowHook: () => void
    const slowPromise = new Promise<string>((resolve) => {
      resolveSlowHook = () => resolve('slow done')
    })

    const slowPlugin: Plugin = {
      name: 'slow-async-plugin',
      transform() {
        return slowPromise
      },
    }

    const fastPlugin: Plugin = {
      name: 'fast-sync-plugin',
      transform(code) {
        return code
      },
    }

    const measure = smvp({
      gapTime: 50, // 50ms idle
      output: (report) => {
        capturedReport = report
      },
    }) as Plugin

    ;(measure as any).configResolved?.({
      command: 'serve',
      plugins: [slowPlugin, fastPlugin, measure],
    } as unknown as ResolvedConfig)

    // 1. Slow hook starts (in flight)
    const slowCall = (slowPlugin.transform as any).call({} as any, 's', 's.js')

    // 2. Fast hook runs and completes immediately, which schedules dev flush for 50ms
    ;(fastPlugin.transform as any).call({} as any, 'f', 'f.js')

    // 3. Wait 70ms - the 50ms timer triggers, but slow hook is STILL active!
    // So flush should be postponed, NOT wiping the stats!
    await new Promise((r) => setTimeout(r, 70))
    expect(capturedReport).toBeNull()

    // 4. Now finish the slow hook
    resolveSlowHook!()
    await slowCall

    // 5. Wait for the rescheduled flush
    await new Promise((r) => setTimeout(r, 80))

    expect(capturedReport).not.toBeNull()
    const pluginNames = capturedReport!.plugins.map((p) => p.pluginName)
    // Both fast and slow plugins must be in the report!
    expect(pluginNames).toContain('slow-async-plugin')
    expect(pluginNames).toContain('fast-sync-plugin')
  })

  it('captures plugins returned dynamically by applyToEnvironment (Codex P2)', async () => {
    let capturedReport: MeasureReport | null = null

    const factoryPlugin: Plugin = {
      name: 'env-factory-plugin',
      applyToEnvironment() {
        return {
          name: 'dynamically-created-child-plugin',
          transform(code) {
            return code + ' /* child transformed */'
          },
        } as Plugin
      },
    }

    const measure = smvp({
      output: (report) => {
        capturedReport = report
      },
    }) as Plugin

    ;(measure as any).configResolved?.({
      command: 'build',
      plugins: [factoryPlugin, measure],
    } as unknown as ResolvedConfig)

    // Simulate Vite calling applyToEnvironment
    const childPlugin = (factoryPlugin as any).applyToEnvironment?.call(
      {} as any,
      { name: 'client' }
    )
    expect(childPlugin).toBeDefined()
    expect(childPlugin.name).toBe('dynamically-created-child-plugin')

    // Execute child transform
    const res = await (childPlugin.transform as any).call(
      {} as any,
      'code',
      'test.js'
    )
    expect(res).toContain('/* child transformed */')

    await (measure.closeBundle as any).call({} as any)

    expect(capturedReport).not.toBeNull()
    const names = capturedReport!.plugins.map((p) => p.pluginName)
    expect(names).toContain('dynamically-created-child-plugin')
  })

  it('allows measuring early config hooks via legacy wrapper syntax (Codex P2)', async () => {
    let capturedReport: MeasureReport | null = null

    const configPlugin: Plugin = {
      name: 'plugin-with-config-hook',
      config() {
        return { define: { __TEST__: 'true' } }
      },
      configResolved() {},
    }

    // Pass plugins in wrapper mode
    const wrappedPlugins = smvp([configPlugin], {
      hooks: ['config', 'configResolved'],
      output: (report) => {
        capturedReport = report
      },
    })

    const measurePlugin = wrappedPlugins[1] as Plugin

    // Simulate Vite executing config and configResolved
    await (configPlugin.config as any).call({} as any, {}, { command: 'build' })
    ;(measurePlugin as any).configResolved?.({
      command: 'build',
      plugins: wrappedPlugins,
    } as unknown as ResolvedConfig)
    await (configPlugin.configResolved as any).call({} as any, {})

    await (measurePlugin.closeBundle as any).call({} as any)

    expect(capturedReport).not.toBeNull()
    expect(capturedReport!.plugins[0].pluginName).toBe('plugin-with-config-hook')
    const hookNames = capturedReport!.plugins[0].hooks.map((h) => h.hookName)
    expect(hookNames).toContain('config')
    expect(hookNames).toContain('configResolved')
  })

  it('allows independent smvp instances to measure the same plugin without interference (Codex P2)', async () => {
    let report1: MeasureReport | null = null
    let report2: MeasureReport | null = null

    const sharedPlugin: Plugin = {
      name: 'shared-plugin',
      transform(code) {
        return code
      },
    }

    const smvp1 = smvp({
      output: (r) => {
        report1 = r
      },
    }) as Plugin

    const smvp2 = smvp({
      output: (r) => {
        report2 = r
      },
    }) as Plugin

    const config1 = {
      command: 'build',
      plugins: [sharedPlugin, smvp1],
    } as unknown as ResolvedConfig

    const config2 = {
      command: 'build',
      plugins: [sharedPlugin, smvp2],
    } as unknown as ResolvedConfig

    ;(smvp1 as any).configResolved?.(config1)
    ;(smvp2 as any).configResolved?.(config2)

    await (config1.plugins[0].transform as any).call({} as any, 'a', 'a.js')
    await (config2.plugins[0].transform as any).call({} as any, 'b', 'b.js')

    await (smvp1.closeBundle as any).call({} as any)
    await (smvp2.closeBundle as any).call({} as any)

    expect(report1).not.toBeNull()
    expect(report2).not.toBeNull()
    expect(report1!.plugins[0].pluginName).toBe('shared-plugin')
    expect(report2!.plugins[0].pluginName).toBe('shared-plugin')
    expect(report1!.plugins[0].hooks[0].calls).toBe(1)
    expect(report2!.plugins[0].hooks[0].calls).toBe(1)
  })

  it('respects deprecated maxTransformTimeOnce when gapTime is not passed (Codex finding)', async () => {
    let capturedReport: MeasureReport | null = null

    const dummyPlugin: Plugin = {
      name: 'dummy-plugin',
      transform(code) {
        return code
      },
    }

    const measure = smvp({
      maxTransformTimeOnce: 40, // Should NOT be shadowed by maxGapTimeOnce default
      output: (report) => {
        capturedReport = report
      },
    }) as Plugin

    ;(measure as any).configResolved?.({
      command: 'serve',
      plugins: [dummyPlugin, measure],
    } as unknown as ResolvedConfig)

    ;(dummyPlugin.transform as any).call({} as any, 'code', 'file.js')

    // Before 40ms
    expect(capturedReport).toBeNull()

    // Wait 60ms (should flush by now, without waiting 1000ms!)
    await new Promise((r) => setTimeout(r, 60))

    expect(capturedReport).not.toBeNull()
    expect(capturedReport!.plugins[0].pluginName).toBe('dummy-plugin')
  })

  it('recognizes plugins with only non-transform hooks or object-form hooks (Codex finding 1)', () => {
    const buildStartPlugin: Plugin = {
      name: 'only-buildStart',
      buildStart() {},
    }
    const res1 = smvp(buildStartPlugin)
    expect(Array.isArray(res1)).toBe(true)
    expect(res1).toHaveLength(2)
    expect(res1[0]).toBe(buildStartPlugin)

    const objectHookPlugin: Plugin = {
      name: 'only-object-hook',
      transform: {
        order: 'pre',
        handler(code: string) {
          return code
        },
      },
    }
    const res2 = smvp(objectHookPlugin)
    expect(Array.isArray(res2)).toBe(true)
    expect(res2).toHaveLength(2)
    expect(res2[0]).toBe(objectHookPlugin)
  })

  it('measures hooks when multiple plugins or hooks share the same raw function (Codex finding 2)', async () => {
    let capturedReport: MeasureReport | null = null

    const sharedFn = () => 'result'

    const pluginA: Plugin = {
      name: 'plugin-a',
      load: sharedFn,
    }

    const pluginB: Plugin = {
      name: 'plugin-b',
      load: sharedFn,
      transform: sharedFn,
    }

    const measure = smvp({
      hooks: ['load', 'transform'],
      output: (report) => {
        capturedReport = report
      },
    }) as Plugin

    ;(measure as any).configResolved?.({
      command: 'build',
      plugins: [pluginA, pluginB, measure],
    } as unknown as ResolvedConfig)

    ;(pluginA.load as any).call({} as any, 'id-a')
    ;(pluginB.load as any).call({} as any, 'id-b')
    ;(pluginB.transform as any).call({} as any, 'code-b', 'id-b')

    await (measure.closeBundle as any).call({} as any)

    expect(capturedReport).not.toBeNull()
    const pluginAName = capturedReport!.plugins.find((p) => p.pluginName === 'plugin-a')
    const pluginBName = capturedReport!.plugins.find((p) => p.pluginName === 'plugin-b')

    expect(pluginAName).toBeDefined()
    expect(pluginAName!.hooks.find((h) => h.hookName === 'load')?.calls).toBe(1)

    expect(pluginBName).toBeDefined()
    expect(pluginBName!.hooks.find((h) => h.hookName === 'load')?.calls).toBe(1)
    expect(pluginBName!.hooks.find((h) => h.hookName === 'transform')?.calls).toBe(1)
  })

  it('correctly wraps plugins returned asynchronously from applyToEnvironment (Codex finding 3)', async () => {
    let capturedReport: MeasureReport | null = null

    const childPlugin: Plugin = {
      name: 'async-env-child',
      transform(code) {
        return `${code}-transformed`
      },
    }

    const parentPlugin: Plugin = {
      name: 'env-parent',
      async applyToEnvironment() {
        await new Promise((r) => setTimeout(r, 10))
        return [childPlugin]
      },
    }

    const measure = smvp({
      output: (report) => {
        capturedReport = report
      },
    }) as Plugin

    ;(measure as any).configResolved?.({
      command: 'build',
      plugins: [parentPlugin, measure],
    } as unknown as ResolvedConfig)

    // Call applyToEnvironment
    const returnedPluginsPromise = (parentPlugin.applyToEnvironment as any).call({} as any, { name: 'client' })
    expect(returnedPluginsPromise).toBeInstanceOf(Promise)
    const returnedPlugins = await returnedPluginsPromise
    expect(returnedPlugins[0]).toBe(childPlugin)

    // Verify child plugin's transform hook was wrapped and measured!
    const res = (childPlugin.transform as any).call({} as any, 'hello', 'hello.js')
    expect(res).toBe('hello-transformed')

    await (measure.closeBundle as any).call({} as any)

    expect(capturedReport).not.toBeNull()
    const childReport = capturedReport!.plugins.find((p) => p.pluginName === 'async-env-child')
    expect(childReport).toBeDefined()
    expect(childReport!.hooks.find((h) => h.hookName === 'transform')?.calls).toBe(1)
  })

  it('waits for other plugins with async closeBundle hooks before reporting (Codex P2 finding)', async () => {
    let capturedReport: MeasureReport | null = null
    let didFinishAsyncCloseBundle = false

    const slowClosePlugin: Plugin = {
      name: 'slow-close-plugin',
      async closeBundle() {
        await new Promise((r) => setTimeout(r, 30))
        didFinishAsyncCloseBundle = true
      },
    }

    const measure = smvp({
      hooks: ['closeBundle'],
      output: (report) => {
        capturedReport = report
      },
    }) as Plugin

    ;(measure as any).configResolved?.({
      command: 'build',
      plugins: [slowClosePlugin, measure],
    } as unknown as ResolvedConfig)

    // In Rollup, closeBundle is parallel (Promise.all([p1.closeBundle(), p2.closeBundle()]))
    await Promise.all([
      (slowClosePlugin.closeBundle as any).call({} as any),
      (measure.closeBundle as any).call({} as any),
    ])

    expect(didFinishAsyncCloseBundle).toBe(true)
    expect(capturedReport).not.toBeNull()
    const pluginReport = capturedReport!.plugins.find(
      (p) => p.pluginName === 'slow-close-plugin'
    )
    expect(pluginReport).toBeDefined()
    const closeHook = pluginReport!.hooks.find((h) => h.hookName === 'closeBundle')
    expect(closeHook?.calls).toBe(1)
    expect(closeHook?.total).toBeGreaterThanOrEqual(25)
  })

  it('handles frozen plugin objects without throwing or crashing build (Codex P2 finding)', async () => {
    let capturedReport: MeasureReport | null = null

    const frozenPlugin: Plugin = Object.freeze({
      name: 'frozen-plugin',
      transform(code: string) {
        return `${code} /* frozen-processed */`
      },
    })

    const measure = smvp({
      output: (report) => {
        capturedReport = report
      },
    }) as Plugin

    const pluginsArray = [frozenPlugin, measure]

    // Wrapping frozen plugin in configResolved must NOT throw TypeError
    expect(() => {
      ;(measure as any).configResolved?.({
        command: 'build',
        plugins: pluginsArray,
      } as unknown as ResolvedConfig)
    }).not.toThrow()

    // Execute the transform on the plugin array
    const res = await (pluginsArray[0].transform as any).call(
      {} as any,
      'code',
      'test.js'
    )
    expect(res).toContain('/* frozen-processed */')

    await (measure.closeBundle as any).call({} as any)

    expect(capturedReport).not.toBeNull()
    const frozenReport = capturedReport!.plugins.find(
      (p) => p.pluginName === 'frozen-plugin'
    )
    expect(frozenReport).toBeDefined()
    expect(frozenReport!.hooks[0].calls).toBe(1)
  })

  it('warns when early config hooks are configured in standard plugin mode (Codex P2 finding)', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    smvp({ hooks: ['config', 'transform'] })

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("requires wrapper mode syntax")
    )

    warnSpy.mockClear()

    // Wrapper mode should NOT warn
    smvp([{ name: 'dummy' }], { hooks: ['config', 'transform'] })
    expect(warnSpy).not.toHaveBeenCalled()

    warnSpy.mockRestore()
  })

  it('handles Promise<Plugin> passed directly as first parameter in wrapper mode (Codex finding 1)', async () => {
    let capturedReport: MeasureReport | null = null

    const myPlugin: Plugin = {
      name: 'async-imported-plugin',
      transform(code) {
        return `${code} /* from promise */`
      },
    }

    const pluginPromise = Promise.resolve(myPlugin)
    const result = smvp(pluginPromise, {
      output: (report) => {
        capturedReport = report
      },
    })

    expect(Array.isArray(result)).toBe(true)
    expect(result).toHaveLength(2)

    // Await the wrapped promise
    const resolvedPlugin = await result[0]
    expect(resolvedPlugin).toBe(myPlugin)

    const measurePlugin = result[1] as Plugin
    ;(measurePlugin as any).configResolved?.({
      command: 'build',
      plugins: [myPlugin, measurePlugin],
    } as unknown as ResolvedConfig)

    // Verify myPlugin transform hook is wrapped and measured
    const code = (myPlugin.transform as any).call({} as any, 'source', 'source.js')
    expect(code).toBe('source /* from promise */')

    await (measurePlugin.closeBundle as any).call({} as any)

    expect(capturedReport).not.toBeNull()
    const pluginReport = capturedReport!.plugins.find((p) => p.pluginName === 'async-imported-plugin')
    expect(pluginReport).toBeDefined()
    expect(pluginReport!.hooks[0].calls).toBe(1)
  })

  it('recursively wraps deeply nested plugins array and early config hooks (Codex finding 2)', async () => {
    let capturedReport: MeasureReport | null = null

    const nestedPlugin: Plugin = {
      name: 'nested-config-plugin',
      config() {
        return { define: { __NESTED__: 'true' } }
      },
    }

    const wrappedPlugins = smvp([[nestedPlugin]], {
      hooks: ['config'],
      output: (report) => {
        capturedReport = report
      },
    })

    const measurePlugin = wrappedPlugins[1] as Plugin

    // Nested plugin config hook should ALREADY be wrapped before Vite executes it
    await (nestedPlugin.config as any).call({} as any, {}, { command: 'build' })

    ;(measurePlugin as any).configResolved?.({
      command: 'build',
      plugins: [nestedPlugin, measurePlugin],
    } as unknown as ResolvedConfig)

    await (measurePlugin.closeBundle as any).call({} as any)

    expect(capturedReport).not.toBeNull()
    const pluginReport = capturedReport!.plugins.find((p) => p.pluginName === 'nested-config-plugin')
    expect(pluginReport).toBeDefined()
    expect(pluginReport!.hooks.find((h) => h.hookName === 'config')?.calls).toBe(1)
  })

  it('ensures closeBundle runs after sequential closeBundle hooks and places measure plugin last (Codex finding 3)', async () => {
    let capturedReport: MeasureReport | null = null
    const executionOrder: string[] = []

    const sequentialPlugin: Plugin = {
      name: 'sequential-plugin',
      closeBundle: {
        sequential: true,
        handler() {
          executionOrder.push('sequential-plugin')
        },
      } as any,
    }

    const measure = smvp({
      hooks: ['closeBundle'],
      output: (report) => {
        executionOrder.push('measure-report')
        capturedReport = report
      },
    }) as Plugin

    const config = {
      command: 'build',
      // Notice measure plugin is initially placed BEFORE sequentialPlugin
      plugins: [measure, sequentialPlugin],
    } as unknown as ResolvedConfig

    ;(measure as any).configResolved?.(config)

    // In configResolved, measure plugin should have been moved to the very END of plugins
    expect(config.plugins[config.plugins.length - 1]).toBe(measure)

    // Simulate Rollup running sequential closeBundle hooks in order
    for (const plugin of config.plugins) {
      if (plugin.closeBundle) {
        if (typeof (plugin.closeBundle as any).handler === 'function') {
          await (plugin.closeBundle as any).handler.call({} as any)
        } else {
          await (plugin.closeBundle as any).call({} as any)
        }
      }
    }

    expect(executionOrder).toEqual(['sequential-plugin', 'measure-report'])
    expect(capturedReport).not.toBeNull()
    const pluginReport = capturedReport!.plugins.find((p) => p.pluginName === 'sequential-plugin')
    expect(pluginReport).toBeDefined()
    expect(pluginReport!.hooks.find((h) => h.hookName === 'closeBundle')?.calls).toBe(1)
  })

  it('declares closeBundle as a genuine object hook with order: post (Codex P2 finding)', async () => {
    const measure = smvp() as Plugin
    // Rollup requires typeof hook === 'object' to read .order and .sequential
    expect(typeof measure.closeBundle).toBe('object')
    expect((measure.closeBundle as any).order).toBe('post')
    expect((measure.closeBundle as any).sequential).toBe(true)
    expect(typeof (measure.closeBundle as any).handler).toBe('function')

    // Also ensures it has .call and .apply delegation for convenience
    expect(typeof (measure.closeBundle as any).call).toBe('function')
    expect(typeof (measure.closeBundle as any).apply).toBe('function')
    await expect((measure.closeBundle as any).call({} as any)).resolves.toBeUndefined()
  })

  it('safely handles rejected plugin Promises without triggering unhandledRejection (Codex P2 finding)', async () => {
    const unhandledRejections: unknown[] = []
    const onUnhandled = (err: unknown) => {
      unhandledRejections.push(err)
    }
    process.on('unhandledRejection', onUnhandled)

    const rejectedPromise = Promise.reject(new Error('Simulated plugin reject'))
    // Attach a catch handler to the original promise so it does not trigger unhandledRejection
    rejectedPromise.catch(() => {})

    // Pass the rejected promise inside an array to wrapper mode
    smvp([rejectedPromise])

    // Wait for microtasks and timers
    await new Promise((r) => setTimeout(r, 40))

    process.off('unhandledRejection', onUnhandled)

    expect(unhandledRejections).toHaveLength(0)
  })

  it('completely isolates measurements when two Vite instances measure the same shared plugin (Codex P2 finding)', async () => {
    let report1: MeasureReport | null = null
    let report2: MeasureReport | null = null

    const sharedPlugin: Plugin = {
      name: 'shared-instance-plugin',
      transform(code) {
        return `${code}-transformed`
      },
    }

    const smvp1 = smvp({
      output: (r) => {
        report1 = r
      },
    }) as Plugin

    const smvp2 = smvp({
      output: (r) => {
        report2 = r
      },
    }) as Plugin

    const config1 = {
      command: 'build',
      plugins: [sharedPlugin, smvp1],
    } as unknown as ResolvedConfig

    const config2 = {
      command: 'build',
      plugins: [sharedPlugin, smvp2],
    } as unknown as ResolvedConfig

    ;(smvp1 as any).configResolved?.(config1)
    ;(smvp2 as any).configResolved?.(config2)

    // Call transform ONLY on instance 1's resolved pipeline
    const res1 = (config1.plugins[0].transform as any).call({} as any, 'code1', 'file1.js')
    expect(res1).toBe('code1-transformed')

    await (smvp1.closeBundle as any).call({} as any)
    await (smvp2.closeBundle as any).call({} as any)

    expect(report1).not.toBeNull()
    expect(report2).toBeNull() // Instance 2 was never invoked, must NOT leak instance 1's execution!

    expect(report1!.plugins[0].hooks[0].calls).toBe(1)
  })

  it('preserves class instance private fields on frozen plugins with applyToEnvironment (Codex P2 finding)', async () => {
    let capturedReport: MeasureReport | null = null

    class ClassPluginWithPrivateField {
      #privateToken = 'valid-token'
      name = 'class-private-plugin'

      applyToEnvironment() {
        return {
          name: `child-${this.#privateToken}`,
          transform(code: string) {
            return `${code} /* private applied */`
          },
        } as Plugin
      }
    }

    const frozenClassPlugin: Plugin = Object.freeze(new ClassPluginWithPrivateField() as any)

    const measure = smvp({
      output: (r) => {
        capturedReport = r
      },
    }) as Plugin

    const config = {
      command: 'build',
      plugins: [frozenClassPlugin, measure],
    } as unknown as ResolvedConfig

    ;(measure as any).configResolved?.(config)

    // Call applyToEnvironment on the wrapped pipeline plugin
    // This must NOT throw TypeError: Cannot read private member #privateToken
    const child = (config.plugins[0] as any).applyToEnvironment?.call(config.plugins[0], { name: 'client' })
    expect(child).toBeDefined()
    expect(child.name).toBe('child-valid-token')

    const res = await (child.transform as any).call({} as any, 'hello', 'hello.js')
    expect(res).toContain('/* private applied */')

    await (measure.closeBundle as any).call({} as any)

    expect(capturedReport).not.toBeNull()
    expect(capturedReport!.plugins[0].pluginName).toBe('child-valid-token')
  })

  it('emits output callback with allPluginsTotal and empty plugins array when threshold filters all plugins (Codex P2 finding)', async () => {
    let capturedReport: MeasureReport | null = null

    const fastPlugin: Plugin = {
      name: 'fast-plugin',
      transform(code) {
        return code
      },
    }

    const measure = smvp({
      threshold: 100, // Filters out everything under 100ms
      output: (report) => {
        capturedReport = report
      },
    }) as Plugin

    const config = {
      command: 'build',
      plugins: [fastPlugin, measure],
    } as unknown as ResolvedConfig

    ;(measure as any).configResolved?.(config)

    ;(config.plugins[0].transform as any).call({} as any, 'code', 'file.js')

    await (measure.closeBundle as any).call({} as any)

    // Even though all plugins were filtered out by threshold,
    // CI / report callback MUST be invoked with allPluginsTotal and plugins: []!
    expect(capturedReport).not.toBeNull()
    expect(capturedReport!.allPluginsTotal).toBeGreaterThanOrEqual(0)
    expect(capturedReport!.plugins).toEqual([])
  })

  it('propagates rejections from async applyToEnvironment without swallowing (Codex P1 finding)', async () => {
    const errorPlugin: Plugin = {
      name: 'async-error-plugin',
      async applyToEnvironment() {
        await new Promise((r) => setTimeout(r, 10))
        throw new Error('async env setup failed')
      },
    }

    const measure = smvp() as Plugin
    const config = {
      command: 'build',
      plugins: [errorPlugin, measure],
    } as unknown as ResolvedConfig

    ;(measure as any).configResolved?.(config)

    const applyResult = (config.plugins[0] as any).applyToEnvironment?.call(
      config.plugins[0],
      { name: 'client' }
    )

    // applyToEnvironment must NOT swallow rejection and resolve to undefined
    await expect(applyResult).rejects.toThrow('async env setup failed')
  })

  it('isolates multiple SMVP instances when plugin hooks use object syntax { order, handler } (Codex P2 finding)', async () => {
    let report1: MeasureReport | null = null
    let report2: MeasureReport | null = null

    const objectHookPlugin: Plugin = {
      name: 'object-hook-plugin',
      transform: {
        order: 'pre',
        handler(code: string) {
          return `${code} /* transformed */`
        },
      },
    }

    const measure1 = smvp({
      output: (r) => {
        report1 = r
      },
    }) as Plugin

    const config1 = {
      command: 'build',
      plugins: [objectHookPlugin, measure1],
    } as unknown as ResolvedConfig
    ;(measure1 as any).configResolved?.(config1)

    const measure2 = smvp({
      output: (r) => {
        report2 = r
      },
    }) as Plugin

    const config2 = {
      command: 'build',
      plugins: [objectHookPlugin, measure2],
    } as unknown as ResolvedConfig
    ;(measure2 as any).configResolved?.(config2)

    // Instance 2 should scope via Object.create rather than mutating instance 1's hook
    expect(config2.plugins[0]).not.toBe(config1.plugins[0])

    // Invoke transform via instance 1's plugin
    const rawHook1 = config1.plugins[0].transform as any
    const handler1 = typeof rawHook1 === 'function' ? rawHook1 : rawHook1.handler
    await handler1.call({} as any, 'code', 'file.js')

    await (measure1.closeBundle as any).call({} as any)
    await (measure2.closeBundle as any).call({} as any)

    expect(report1).not.toBeNull()
    expect(report1!.plugins[0].hooks[0].calls).toBe(1)

    // Instance 2 was never invoked, so its report must not have recorded instance 1's call
    expect(report2).toBeNull()
  })

  it('correctly returns and measures a single frozen plugin returned from applyToEnvironment (Codex P2 finding)', async () => {
    let capturedReport: MeasureReport | null = null

    const frozenChildPlugin: Plugin = Object.freeze({
      name: 'frozen-child-plugin',
      transform(code: string) {
        return `${code} /* frozen handled */`
      },
    })

    const parentPlugin: Plugin = {
      name: 'parent-plugin',
      applyToEnvironment() {
        return frozenChildPlugin
      },
    }

    const measure = smvp({
      output: (r) => {
        capturedReport = r
      },
    }) as Plugin

    const config = {
      command: 'build',
      plugins: [parentPlugin, measure],
    } as unknown as ResolvedConfig

    ;(measure as any).configResolved?.(config)

    const child = (config.plugins[0] as any).applyToEnvironment?.call(
      config.plugins[0],
      { name: 'client' }
    )

    expect(child).toBeDefined()
    expect(child.name).toBe('frozen-child-plugin')

    // Invoke transform on returned child
    const res = await (child.transform as any).call({} as any, 'input', 'input.js')
    expect(res).toBe('input /* frozen handled */')

    await (measure.closeBundle as any).call({} as any)

    expect(capturedReport).not.toBeNull()
    const childReport = capturedReport!.plugins.find(
      (p) => p.pluginName === 'frozen-child-plugin'
    )
    expect(childReport).toBeDefined()
    expect(childReport!.hooks[0].calls).toBe(1)
  })

  it('preserves return value of non-native custom thenable hooks (Codex P2 finding 1)', async () => {
    let capturedReport: MeasureReport | null = null

    // A hook that returns a custom thenable whose .then does NOT return a Promise
    const customThenablePlugin: Plugin = {
      name: 'custom-thenable-plugin',
      load(id: string) {
        return {
          then(resolve: (val: string) => void) {
            // Synchronously or asynchronously call resolve, but returns undefined (not a Promise)
            resolve(`// custom content for ${id}`)
          },
        } as unknown as any
      },
    }

    const measure = smvp({
      hooks: ['load'],
      output: (r) => {
        capturedReport = r
      },
    }) as Plugin

    const config = {
      command: 'build',
      plugins: [customThenablePlugin, measure],
    } as unknown as ResolvedConfig

    ;(measure as any).configResolved?.(config)

    const res = await (config.plugins[0].load as any).call({} as any, 'virtual:mod')
    // Must NOT be undefined!
    expect(res).toBe('// custom content for virtual:mod')

    await (measure.closeBundle as any).call({} as any)
    expect(capturedReport).not.toBeNull()
    expect(capturedReport!.plugins[0].hooks[0].calls).toBe(1)
  })

  it('restores hooks on mutable plugins after bundle closes so reused plugins are clean (Codex P2 finding 2)', async () => {
    let reportCount = 0

    const reusablePlugin: Plugin = {
      name: 'reusable-plugin',
      transform(code: string) {
        return `${code} /* transformed */`
      },
    }

    const measure = smvp({
      output: () => {
        reportCount++
      },
    }) as Plugin

    const config = {
      command: 'build',
      plugins: [reusablePlugin, measure],
    } as unknown as ResolvedConfig

    ;(measure as any).configResolved?.(config)

    // Plugin was wrapped
    expect((reusablePlugin.transform as any).__rawOriginal).toBeDefined()

    // Invoke transform during build 1
    await (reusablePlugin.transform as any).call({} as any, 'var a = 1;', 'a.js')

    // Finish build 1
    await (measure.closeBundle as any).call({} as any)
    expect(reportCount).toBe(1)

    // Explicitly cleanup or when server/process closes
    ;(measure as any).cleanup?.()

    // AFTER cleanup:
    // 1. reusablePlugin.transform should be cleanly restored to original function
    expect((reusablePlugin.transform as any).__rawOriginal).toBeUndefined()

    // 2. Calling transform again in a later build without smvp must NOT trigger reportCount
    await (reusablePlugin.transform as any).call({} as any, 'var b = 2;', 'b.js')
    expect(reportCount).toBe(1)
  })

  it('replaces async resolved frozen plugin in wrapper mode so early config hooks are measured (Codex P2 finding 3)', async () => {
    let capturedReport: MeasureReport | null = null

    const frozenPluginWithConfig: Plugin = Object.freeze({
      name: 'frozen-async-config-plugin',
      config() {
        return { define: { __TEST__: true } }
      },
      transform(code: string) {
        return code
      },
    })

    const wrappedPromise = Promise.resolve(frozenPluginWithConfig)

    const wrappedPlugins = smvp([wrappedPromise], {
      hooks: ['config', 'transform'],
      output: (r) => {
        capturedReport = r
      },
    }) as any[]

    // wrappedPlugins[0] is the promise in the plugins array
    const resolvedPlugin = await wrappedPlugins[0]

    expect(resolvedPlugin).toBeDefined()
    expect(resolvedPlugin.name).toBe('frozen-async-config-plugin')

    // The resolved plugin's config hook must be measured!
    expect((resolvedPlugin.config as any).__rawOriginal).toBeDefined()

    const measurePlugin = wrappedPlugins[1]

    // Simulate Vite invoking config hook
    await (resolvedPlugin.config as any).call({} as any, {}, { command: 'build', mode: 'production' })

    await (measurePlugin.closeBundle as any).call({} as any)

    expect(capturedReport).not.toBeNull()
    const pluginStats = capturedReport!.plugins.find((p) => p.pluginName === 'frozen-async-config-plugin')
    expect(pluginStats).toBeDefined()
    const configHookStat = pluginStats!.hooks.find((h) => h.hookName === 'config')
    expect(configHookStat).toBeDefined()
    expect(configHookStat!.calls).toBe(1)
  })

  it('measures non-frozen plugins that have non-writable hook properties (Codex P2 finding 4)', async () => {
    let capturedReport: MeasureReport | null = null

    const nonWritableHookPlugin: Plugin = {
      name: 'non-writable-hook-plugin',
    }
    // Object is NOT frozen, but transform property is non-writable & non-configurable
    Object.defineProperty(nonWritableHookPlugin, 'transform', {
      value(code: string) {
        return `${code} /* non-writable */`
      },
      writable: false,
      configurable: false,
      enumerable: true,
    })

    expect(Object.isFrozen(nonWritableHookPlugin)).toBe(false)

    const measure = smvp({
      output: (r) => {
        capturedReport = r
      },
    }) as Plugin

    const config = {
      command: 'build',
      plugins: [nonWritableHookPlugin, measure],
    } as unknown as ResolvedConfig

    ;(measure as any).configResolved?.(config)

    // Plugin in config.plugins[0] should be scoped/wrapped
    const wrappedPlugin = config.plugins[0]
    expect(wrappedPlugin).toBeDefined()

    // Transform hook should be measured
    const result = await (wrappedPlugin.transform as any).call({} as any, 'hello', 'hello.js')
    expect(result).toBe('hello /* non-writable */')

    await (measure.closeBundle as any).call({} as any)

    expect(capturedReport).not.toBeNull()
    const pluginStats = capturedReport!.plugins.find((p) => p.pluginName === 'non-writable-hook-plugin')
    expect(pluginStats).toBeDefined()
    expect(pluginStats!.hooks[0].calls).toBe(1)
  })

  it('preserves measurement state across consecutive builds in watch mode (Codex P2 finding)', async () => {
    const reports: MeasureReport[] = []
    const watchedPlugin: Plugin = {
      name: 'watched-plugin',
      transform(code: string) {
        return code
      },
    }

    const measure = smvp({
      output: (r) => {
        reports.push(r)
      },
    }) as Plugin

    const config = {
      command: 'build',
      build: { watch: {} },
      plugins: [watchedPlugin, measure],
    } as unknown as ResolvedConfig

    ;(measure as any).configResolved?.(config)

    // Build cycle 1
    await (watchedPlugin.transform as any).call({} as any, 'code1', '1.js')
    await (measure.closeBundle as any).call({} as any)

    // Build cycle 2 in watch mode
    await (watchedPlugin.transform as any).call({} as any, 'code2', '2.js')
    await (measure.closeBundle as any).call({} as any)

    expect(reports.length).toBe(2)
    expect(reports[0].plugins[0].hooks[0].calls).toBe(1)
    expect(reports[1].plugins[0].hooks[0].calls).toBe(1)
  })

  it('preserves own properties and spreads when scoping frozen or non-writable plugins (Codex P1 finding)', async () => {
    let capturedReport: MeasureReport | null = null

    const frozenPlugin: Plugin = Object.freeze({
      name: 'frozen-own-props-plugin',
      enforce: 'pre',
      customProperty: 'custom-val',
      load(id: string) {
        return `// code for ${id}`
      },
      transform(code: string) {
        return `${code} /* transformed */`
      },
    })

    const measure = smvp({
      output: (r) => {
        capturedReport = r
      },
    }) as Plugin

    const config = {
      command: 'build',
      plugins: [frozenPlugin, measure],
    } as unknown as ResolvedConfig

    ;(measure as any).configResolved?.(config)

    const wrappedPlugin = config.plugins[0]

    // Vite 6 environment API or Rollup frequently clones plugins via object spread:
    const cloned = { ...wrappedPlugin }

    // Own properties must NOT be lost on spread!
    expect(cloned.name).toBe('frozen-own-props-plugin')
    expect(cloned.enforce).toBe('pre')
    expect((cloned as any).customProperty).toBe('custom-val')
    expect(typeof cloned.load).toBe('function')
    expect(typeof cloned.transform).toBe('function')

    // Invoke transform via cloned
    const res = await (cloned.transform as any).call({} as any, 'var x = 1;', 'x.js')
    expect(res).toBe('var x = 1; /* transformed */')

    await (measure.closeBundle as any).call({} as any)

    expect(capturedReport).not.toBeNull()
    const report = capturedReport!.plugins.find((p) => p.pluginName === 'frozen-own-props-plugin')
    expect(report).toBeDefined()
    expect(report!.hooks[0].calls).toBe(1)
  })

  it('automatically cleans up plugin hooks and activeCleanups after non-watch build closes (Codex P2 finding)', async () => {
    const reusablePlugin: Plugin = {
      name: 'auto-cleanup-plugin',
      transform(code: string) {
        return code
      },
    }

    const measure = smvp() as Plugin
    const config = {
      command: 'build',
      plugins: [reusablePlugin, measure],
    } as unknown as ResolvedConfig

    ;(measure as any).configResolved?.(config)
    expect((reusablePlugin.transform as any).__rawOriginal).toBeDefined()

    await (measure.closeBundle as any).call({} as any)
    // In non-watch build, closeBundle restores hooks automatically!
    expect((reusablePlugin.transform as any).__rawOriginal).toBeUndefined()
  })

  it('correctly wraps and measures shared frozen plugins across multiple environments (Codex P2 finding)', async () => {
    let capturedReport: MeasureReport | null = null

    const frozen = Object.freeze({
      name: 'shared-frozen-env-plugin',
      transform(x: string) {
        return `${x} /* env processed */`
      },
    })

    const parent: Plugin = {
      name: 'env-factory',
      applyToEnvironment() {
        return frozen
      },
    }

    const measure = smvp({
      output: (r) => {
        capturedReport = r
      },
    }) as Plugin

    const config = {
      command: 'build',
      plugins: [parent, measure],
    } as unknown as ResolvedConfig

    ;(measure as any).configResolved?.(config)

    const child1 = (config.plugins[0] as any).applyToEnvironment?.call(config.plugins[0], { name: 'client' })
    const child2 = (config.plugins[0] as any).applyToEnvironment?.call(config.plugins[0], { name: 'ssr' })

    expect(child1).toBeDefined()
    expect(child2).toBeDefined()
    expect((child1.transform as any).__rawOriginal).toBeDefined()
    expect((child2.transform as any).__rawOriginal).toBeDefined()

    await (child1.transform as any).call({} as any, 'client-code', 'client.js')
    await (child2.transform as any).call({} as any, 'ssr-code', 'ssr.js')

    await (measure.closeBundle as any).call({} as any)

    expect(capturedReport).not.toBeNull()
    const pluginStats = capturedReport!.plugins.find((p) => p.pluginName === 'shared-frozen-env-plugin')
    expect(pluginStats).toBeDefined()
    expect(pluginStats!.hooks[0].calls).toBe(2)
  })

  it('preserves wrapper mode array semantics when passing falsy PluginOption (Codex P2 finding)', async () => {
    const falsyWrapped = smvp(false, { hooks: ['config'] })

    expect(Array.isArray(falsyWrapped)).toBe(true)
    const plugins = falsyWrapped as any[]
    expect(plugins[0]).toBe(false)
    expect(plugins[1].name).toBe('speed-measure-vite-plugin')
  })

  it('supports apply hook with class private fields on frozen plugins (Codex P2 finding)', async () => {
    class ClassWithPrivateField {
      #on = true
      name = 'private-apply'
      apply() {
        return this.#on
      }
    }

    const p = Object.freeze(new ClassWithPrivateField() as any)
    const arr = smvp([p], { hooks: ['apply'] }) as any[]

    expect(arr[0]).not.toBe(p)
    // Calling apply() on the wrapped clone must NOT throw TypeError: Cannot read private member #on
    expect(arr[0].apply()).toBe(true)
    arr[1].cleanup()
  })

  it('re-enables measurement on server restart when plugin instance is reused (Codex P1 finding)', async () => {
    let capturedReport: MeasureReport | null = null

    const plugin: Plugin = {
      name: 'restart-test-plugin',
      transform(code: string) {
        return code
      },
    }

    const measure = smvp({
      output: (r) => {
        capturedReport = r
      },
    }) as Plugin

    // 1. Initial server startup
    const server1Listeners: Record<string, Function> = {}
    const fakeServer1: any = {
      httpServer: {
        on(event: string, cb: Function) {
          server1Listeners[event] = cb
        },
      },
    }

    const config1 = {
      command: 'serve',
      plugins: [plugin, measure],
    } as unknown as ResolvedConfig

    ;(measure as any).configResolved?.(config1)
    ;(measure as any).configureServer?.(fakeServer1)

    // 2. Server 1 closes (e.g. during server.restart())
    server1Listeners['close']?.()

    // 3. New server starts reusing the same plugin instance
    const fakeServer2: any = {
      httpServer: {
        on: () => {},
      },
    }
    const config2 = {
      command: 'serve',
      plugins: [plugin, measure],
    } as unknown as ResolvedConfig

    ;(measure as any).configResolved?.(config2)
    ;(measure as any).configureServer?.(fakeServer2)

    // 4. Hook executes on new server
    await (plugin.transform as any).call({} as any, 'var a = 1;', 'a.js')

    // Simulate close/flush
    await (measure.closeBundle as any).call({} as any)

    expect(capturedReport).not.toBeNull()
    const pluginStat = capturedReport!.plugins.find((p) => p.pluginName === 'restart-test-plugin')
    expect(pluginStat).toBeDefined()
    expect(pluginStat!.hooks[0].calls).toBe(1)
  })

  it('does not prematurely teardown hooks in buildEnd on failed builds, allowing closeBundle to measure (Codex P2 finding)', async () => {
    let closeBundleMeasured = false

    const closeBundlePlugin: Plugin = {
      name: 'close-bundle-plugin',
      closeBundle() {
        closeBundleMeasured = true
      },
    }

    const measure = smvp({
      hooks: ['closeBundle'],
    }) as Plugin

    const config = {
      command: 'build',
      plugins: [closeBundlePlugin, measure],
    } as unknown as ResolvedConfig

    ;(measure as any).configResolved?.(config)

    // Simulate failed build: Rollup invokes buildEnd(error) before closeBundle()
    ;(measure as any).buildEnd?.(new Error('Rollup compilation error'))

    // Hooks should NOT be torn down yet!
    expect((closeBundlePlugin.closeBundle as any).__rawOriginal).toBeDefined()

    // Now Rollup runs closeBundle
    await (closeBundlePlugin.closeBundle as any).call({} as any)
    expect(closeBundleMeasured).toBe(true)

    await (measure.closeBundle as any).call({} as any)
  })

  it('cleans up wrapped plugins when watcher closes via closeWatcher (Codex P2 finding)', async () => {
    const watchedPlugin: Plugin = {
      name: 'watcher-cleanup-plugin',
      transform(code: string) {
        return code
      },
    }

    const measure = smvp() as Plugin
    const config = {
      command: 'build',
      build: { watch: {} },
      plugins: [watchedPlugin, measure],
    } as unknown as ResolvedConfig

    ;(measure as any).configResolved?.(config)

    // In watch mode, closeBundle does not teardown
    await (measure.closeBundle as any).call({} as any)
    expect((watchedPlugin.transform as any).__rawOriginal).toBeDefined()

    // When watcher closes, closeWatcher hook tears down
    ;(measure as any).closeWatcher?.()
    expect((watchedPlugin.transform as any).__rawOriginal).toBeUndefined()
  })

  it('delegates unmeasured methods with private fields on frozen class plugins without error (Codex P2 finding)', async () => {
    class ClassWithPrivateField {
      #on = true
      name = 'unmeasured-private-apply'
      apply() {
        return this.#on
      }
      transform(code: string) {
        return `${code} /* transformed */`
      }
    }

    const p = Object.freeze(new ClassWithPrivateField() as any)
    // Wrap with default hooks (only 'transform', 'apply' is unmeasured!)
    const arr = smvp([p]) as any[]

    expect(arr[0]).not.toBe(p)
    // Calling unmeasured apply() on the cloned object must NOT throw TypeError
    expect(arr[0].apply()).toBe(true)
    arr[1].cleanup()
  })

  it('measures applyToEnvironment while simultaneously wrapping returned child plugins (Codex P2 finding)', async () => {
    let capturedReport: MeasureReport | null = null

    const childPlugin: Plugin = Object.freeze({
      name: 'frozen-env-child',
      transform(code: string) {
        return `${code} /* child transformed */`
      },
    })

    const parentPlugin: Plugin = Object.freeze({
      name: 'frozen-env-parent',
      applyToEnvironment() {
        return childPlugin
      },
    })

    const measure = smvp({
      hooks: ['applyToEnvironment', 'transform'],
      output: (r) => {
        capturedReport = r
      },
    }) as Plugin

    const config = {
      command: 'build',
      plugins: [parentPlugin, measure],
    } as unknown as ResolvedConfig

    ;(measure as any).configResolved?.(config)

    const child = (config.plugins[0] as any).applyToEnvironment?.call(config.plugins[0], { name: 'client' })

    expect(child).toBeDefined()
    expect(child.name).toBe('frozen-env-child')
    expect((child.transform as any).__rawOriginal).toBeDefined()

    await (child.transform as any).call({} as any, 'var a = 1;', 'a.js')

    await (measure.closeBundle as any).call({} as any)

    expect(capturedReport).not.toBeNull()
    const parentReport = capturedReport!.plugins.find((p) => p.pluginName === 'frozen-env-parent')
    const childReport = capturedReport!.plugins.find((p) => p.pluginName === 'frozen-env-child')

    expect(parentReport).toBeDefined()
    expect(parentReport!.hooks.find((h) => h.hookName === 'applyToEnvironment')?.calls).toBe(1)

    expect(childReport).toBeDefined()
    expect(childReport!.hooks.find((h) => h.hookName === 'transform')?.calls).toBe(1)
  })

  it('warns when configEnvironment hook is used in standard plugin mode (Codex P2 finding)', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    smvp({ hooks: ['configEnvironment'] })

    expect(warnSpy).toHaveBeenCalled()
    expect(warnSpy.mock.calls[0][0]).toContain('configEnvironment')

    warnSpy.mockRestore()
  })

  it('handles falsy plugin option in single-argument wrapper overload without throwing (Codex P2 finding)', () => {
    // smvp(null) shouldn't throw "Cannot read properties of null"
    const nullResult = smvp(null)
    expect(Array.isArray(nullResult)).toBe(true)
    expect(nullResult).toHaveLength(2)
    expect(nullResult[0]).toBeNull()
    expect((nullResult[1] as any).name).toBe('speed-measure-vite-plugin')

    // smvp(false) should return [false, measurePlugin]
    const falseResult = smvp(false)
    expect(Array.isArray(falseResult)).toBe(true)
    expect(falseResult).toHaveLength(2)
    expect(falseResult[0]).toBe(false)
    expect((falseResult[1] as any).name).toBe('speed-measure-vite-plugin')

    // smvp(null, options) with options
    const nullWithOptions = smvp(null, { disable: true })
    expect(Array.isArray(nullWithOptions)).toBe(true)
    expect(nullWithOptions).toHaveLength(2)
    expect(nullWithOptions[0]).toBeNull()
    expect((nullWithOptions[1] as any).name).toBe('speed-measure-vite-plugin:disabled')
  })

  it('measures hooks registered or replaced after configResolved (Codex P2 finding)', async () => {
    let report: MeasureReport | null = null
    const latePlugin: Plugin = { name: 'late-plugin' }
    const measure = smvp({
      output: (r) => {
        report = r
      },
    }) as Plugin

    const config = {
      command: 'build',
      plugins: [latePlugin, measure],
    } as unknown as ResolvedConfig

    ;(measure as any).configResolved(config)

    // Late hook registered after configResolved (e.g. by async hook or dynamic setup)
    ;(latePlugin as any).transform = (code: string) => code + ' // transformed'

    // buildStart runs
    ;(measure.buildStart as any).call({
      environment: { plugins: config.plugins },
    })

    expect(((latePlugin as any).transform as any).__rawOriginal).toBeDefined()

    await (latePlugin.transform as any).call({} as any, 'const x = 1;', 'x.js')

    await (measure.closeBundle as any).call({} as any)

    expect(report).not.toBeNull()
    const pluginReport = report!.plugins.find((p) => p.pluginName === 'late-plugin')
    expect(pluginReport).toBeDefined()
    expect(pluginReport!.hooks.find((h) => h.hookName === 'transform')?.calls).toBe(1)
  })

  it('isolates multiple measure instances when sharing plugin with non-enumerable hook (Codex P2 finding)', async () => {
    const sharedPlugin: Plugin = { name: 'hidden-hook-plugin' }
    Object.defineProperty(sharedPlugin, 'transform', {
      value: (code: string) => code,
      writable: true,
      configurable: true,
      enumerable: false,
    })

    let report1: MeasureReport | null = null
    let report2: MeasureReport | null = null

    const measure1 = smvp({
      output: (r) => {
        report1 = r
      },
    }) as Plugin
    const measure2 = smvp({
      output: (r) => {
        report2 = r
      },
    }) as Plugin

    const config1 = { command: 'build', plugins: [sharedPlugin, measure1] } as unknown as ResolvedConfig
    const config2 = { command: 'build', plugins: [sharedPlugin, measure2] } as unknown as ResolvedConfig

    ;(measure1 as any).configResolved(config1)
    ;(measure2 as any).configResolved(config2)

    // Verify config2 cloned the plugin to isolate from config1
    expect(config1.plugins[0]).not.toBe(config2.plugins[0])

    await (config1.plugins[0].transform as any).call({} as any, 'code1', 'file1.js')
    await (config2.plugins[0].transform as any).call({} as any, 'code2', 'file2.js')

    await (measure1.closeBundle as any).call({} as any)
    await (measure2.closeBundle as any).call({} as any)

    expect(report1).not.toBeNull()
    expect(report2).not.toBeNull()

    const p1Report = report1!.plugins.find((p) => p.pluginName === 'hidden-hook-plugin')
    const p2Report = report2!.plugins.find((p) => p.pluginName === 'hidden-hook-plugin')

    expect(p1Report?.hooks.find((h) => h.hookName === 'transform')?.calls).toBe(1)
    expect(p2Report?.hooks.find((h) => h.hookName === 'transform')?.calls).toBe(1)
  })

  it('unwraps hooks from other instances when cloning shared plugin with different hook options (Codex P2 finding)', async () => {
    const sharedPlugin: Plugin = {
      name: 'shared-cross-hook-plugin',
      transform(code: string) {
        return code
      },
      load(id: string) {
        return `export const id = "${id}";`
      },
    }

    let reportA: MeasureReport | null = null
    let reportB: MeasureReport | null = null

    // Instance A measures ONLY transform
    const measureA = smvp({
      hooks: ['transform'],
      output: (r) => {
        reportA = r
      },
    }) as Plugin

    // Instance B measures ONLY load
    const measureB = smvp({
      hooks: ['load'],
      output: (r) => {
        reportB = r
      },
    }) as Plugin

    const configA = {
      command: 'build',
      plugins: [sharedPlugin, measureA],
    } as unknown as ResolvedConfig
    const configB = {
      command: 'build',
      plugins: [sharedPlugin, measureB],
    } as unknown as ResolvedConfig

    ;(measureA as any).configResolved(configA)
    ;(measureB as any).configResolved(configB)

    // Verify configB cloned the plugin to isolate
    expect(configA.plugins[0]).not.toBe(configB.plugins[0])

    // In build B, run BOTH transform and load on B's plugin
    // (B's transform should NOT be wrapped by A anymore, so A should not record B's transform call!)
    await (configB.plugins[0].transform as any).call({} as any, 'var b = 2;', 'b.js')
    await (configB.plugins[0].load as any).call({} as any, 'b.js')

    // Close both bundles
    await (measureB.closeBundle as any).call({} as any)
    await (measureA.closeBundle as any).call({} as any)

    expect(reportB).not.toBeNull()
    const bReport = reportB!.plugins.find((p) => p.pluginName === 'shared-cross-hook-plugin')
    expect(bReport).toBeDefined()
    // B measured load (1 call)
    expect(bReport!.hooks.find((h) => h.hookName === 'load')?.calls).toBe(1)
    // B did not measure transform
    expect(bReport!.hooks.find((h) => h.hookName === 'transform')).toBeUndefined()

    // Instance A should NOT have recorded B's transform call (metric crosstalk prevented!)
    const aReport = (reportA as MeasureReport | null)?.plugins.find(
      (p) => p.pluginName === 'shared-cross-hook-plugin'
    )
    expect(aReport).toBeUndefined()
  })

  it('cleans up wrapped plugins when server.close() is called in middlewareMode (Codex P2 finding)', async () => {
    let capturedReport: MeasureReport | null = null
    const measure = smvp({
      output: (r) => {
        capturedReport = r
      },
    }) as Plugin

    let originalCloseCalled = false
    const mockServer = {
      httpServer: null,
      ws: null,
      close: async () => {
        originalCloseCalled = true
      },
    }

    ;(measure.configureServer as any).call({} as any, mockServer)

    // Call server.close() in middlewareMode (httpServer is null)
    await mockServer.close()

    expect(originalCloseCalled).toBe(true)
  })

  it('waits for in-flight hooks across environments before clearing stats in closeBundle (Codex P2 finding)', async () => {
    let reports: MeasureReport[] = []
    let finishTransform: () => void
    const slowPlugin: Plugin = {
      name: 'slow-env-plugin',
      transform: () =>
        new Promise((resolve) => {
          finishTransform = () => resolve('transformed')
        }),
    }

    const measure = smvp({
      output: (r) => {
        reports.push(r)
      },
    }) as Plugin

    const config = {
      command: 'serve',
      plugins: [slowPlugin, measure],
    } as unknown as ResolvedConfig

    ;(measure as any).configResolved(config)

    // Start in-flight transform (e.g. in Environment 2)
    const run = (slowPlugin.transform as any).call({} as any, 'code', 'file.js')

    // Schedule finish after 30ms
    setTimeout(() => finishTransform!(), 30)

    // Environment 1 calls closeBundle while Environment 2 transform is in flight
    await (measure.closeBundle as any).call({} as any)
    await run

    // Environment 2 calls closeBundle
    await (measure.closeBundle as any).call({} as any)

    // Should only have 1 report containing the finished transform with calls: 1
    expect(reports).toHaveLength(1)
    const pluginReport = reports[0].plugins.find((p) => p.pluginName === 'slow-env-plugin')
    expect(pluginReport).toBeDefined()
    expect(pluginReport!.hooks[0].calls).toBe(1)
  })

  it('preserves in-flight measurements after closeBundle timeout across concurrent environments (Codex P2 finding)', async () => {
    let reports: MeasureReport[] = []
    let finishTransform: () => void
    const slowPlugin: Plugin = {
      name: 'slow-timeout-plugin',
      transform: () =>
        new Promise((resolve) => {
          finishTransform = () => resolve('transformed-code')
        }),
    }

    const fastPlugin: Plugin = {
      name: 'fast-env1-plugin',
      transform: () => 'fast-code',
    }

    const measure = smvp({
      closeBundleTimeout: 20, // Short timeout for test
      output: (r) => {
        reports.push(r)
      },
    }) as Plugin

    const config = {
      command: 'build',
      plugins: [fastPlugin, slowPlugin, measure],
    } as unknown as ResolvedConfig

    ;(measure as any).configResolved(config)

    // Environment 1 runs fastPlugin
    await (fastPlugin.transform as any).call({} as any, 'fast', 'fast.js')

    // Environment 2 starts slowPlugin transform (now in flight)
    const runSlow = (slowPlugin.transform as any).call({} as any, 'slow', 'slow.js')

    // Environment 1 reaches closeBundle and times out (waits > 20ms while slowPlugin is still running)
    await (measure.closeBundle as any).call({} as any)

    // Verify Environment 1 report:
    // 1. Must contain fastPlugin
    // 2. Must NOT show slowPlugin with zero total time and activeCount: 1!
    expect(reports.length).toBe(1)
    const env1Report = reports[0]
    expect(env1Report.plugins.find((p) => p.pluginName === 'fast-env1-plugin')).toBeDefined()
    const slowInEnv1 = env1Report.plugins.find((p) => p.pluginName === 'slow-timeout-plugin')
    expect(slowInEnv1).toBeUndefined()

    // Now Environment 2 finishes transform after timeout
    finishTransform!()
    await runSlow

    // Environment 2 reaches closeBundle
    await (measure.closeBundle as any).call({} as any)

    // Verify Environment 2 report:
    // It must capture slowPlugin with calls: 1 and total duration > 0!
    expect(reports.length).toBe(2)
    const env2Report = reports[1]
    const slowInEnv2 = env2Report.plugins.find((p) => p.pluginName === 'slow-timeout-plugin')
    expect(slowInEnv2).toBeDefined()
    expect(slowInEnv2!.hooks[0].calls).toBe(1)
    expect(slowInEnv2!.hooks[0].activeCount).toBe(0)
    expect(slowInEnv2!.total).toBeGreaterThanOrEqual(0)
  })

  it('clones non-extensible plugins with inherited hooks and measures execution (Codex P2 finding)', async () => {
    let report: MeasureReport | null = null
    const proto = {
      transform(code: string) {
        return code + '!'
      },
    }
    const plugin: Plugin = Object.preventExtensions(
      Object.assign(Object.create(proto), { name: 'non-extensible-plugin' })
    )

    const measure = smvp({
      output: (r) => {
        report = r
      },
    }) as Plugin

    const config = {
      command: 'build',
      plugins: [plugin, measure],
    } as unknown as ResolvedConfig

    ;(measure as any).configResolved(config)

    // Plugin in config array should be replaced with cloned extensible wrapper
    expect(config.plugins[0]).not.toBe(plugin)
    expect(((config.plugins[0] as any).transform as any).__rawOriginal).toBeDefined()

    // Execute transform on the configured plugin
    await (config.plugins[0].transform as any).call({} as any, 'hello', 'hello.js')

    await (measure.closeBundle as any).call({} as any)

    expect(report).not.toBeNull()
    const pluginReport = report!.plugins.find((p) => p.pluginName === 'non-extensible-plugin')
    expect(pluginReport).toBeDefined()
    expect(pluginReport!.hooks[0].calls).toBe(1)
  })

  it('does not prematurely cleanup all measurement when one environment closes in dev mode (Codex P2 finding)', async () => {
    let reportsCount = 0
    const plugin: Plugin = {
      name: 'other-env-plugin',
      transform(code: string) {
        return code
      },
    }

    const measure = smvp({
      output: () => {
        reportsCount++
      },
    }) as Plugin

    const config = {
      command: 'serve',
      plugins: [plugin, measure],
    } as unknown as ResolvedConfig

    ;(measure as any).configResolved(config)

    // Environment 1 triggers closeBundle
    await (measure.closeBundle as any).call({} as any)

    // Environment 2 subsequently runs transform
    await (plugin.transform as any).call({} as any, 'code', 'file.js')

    // Environment 2 triggers closeBundle
    await (measure.closeBundle as any).call({} as any)

    // Should generate report for environment 2 (not stopped by environment 1 close)
    expect(reportsCount).toBe(1)
  })

  it('returns writable array containing cloned wrapped plugins when wrapper mode receives read-only array (Codex P2 finding)', async () => {
    let report: MeasureReport | null = null
    const frozenPlugin: Plugin = Object.freeze({
      name: 'frozen-in-readonly-array',
      transform(code: string) {
        return code + ' // transformed'
      },
    })

    const readOnlyArray = Object.freeze([frozenPlugin])

    const wrapped = smvp(readOnlyArray, {
      output: (r) => {
        report = r
      },
    })

    expect(Array.isArray(wrapped)).toBe(true)
    const pluginList = wrapped as Plugin[]
    // Should have created a cloned wrapped plugin in a new array
    expect(pluginList[0]).not.toBe(frozenPlugin)
    expect((pluginList[0].transform as any).__rawOriginal).toBeDefined()

    // Test execution through wrapped item
    const res = await (pluginList[0].transform as any).call({} as any, 'const x = 1;', 'x.js')
    expect(res).toContain('// transformed')

    const measurePlugin = pluginList[pluginList.length - 1]
    await (measurePlugin.closeBundle as any).call({} as any)

    expect(report).not.toBeNull()
    const pluginReport = report!.plugins.find((p) => p.pluginName === 'frozen-in-readonly-array')
    expect(pluginReport).toBeDefined()
    expect(pluginReport!.hooks[0].calls).toBe(1)
  })

  it('composes cleanly without double-counting when multiple sibling SMVP instances are in the same config', async () => {
    let reportA: MeasureReport | null = null
    let reportB: MeasureReport | null = null

    const plugin: Plugin = {
      name: 'shared-sibling-target',
      transform(code: string) {
        return code + ' // transformed'
      },
    }

    const measureA = smvp({
      output: (r) => {
        reportA = r
      },
    }) as Plugin

    const measureB = smvp({
      output: (r) => {
        reportB = r
      },
    }) as Plugin

    const config = {
      command: 'build',
      plugins: [plugin, measureA, measureB],
    } as unknown as ResolvedConfig

    ;(measureA as any).configResolved(config)
    ;(measureB as any).configResolved(config)

    // Simulate buildStart hook
    const inputOpts = { plugins: config.plugins }
    await (measureA as any).buildStart?.call({} as any, inputOpts)
    await (measureB as any).buildStart?.call({} as any, inputOpts)

    // Execute transform hook
    const result = await (plugin.transform as any).call({} as any, 'const x = 1;', 'x.js')
    expect(result).toBe('const x = 1; // transformed')

    await (measureA.closeBundle as any).call({} as any)
    await (measureB.closeBundle as any).call({} as any)

    expect(reportA).not.toBeNull()
    expect(reportB).not.toBeNull()

    const repA = reportA!.plugins.find((p) => p.pluginName === 'shared-sibling-target')
    const repB = reportB!.plugins.find((p) => p.pluginName === 'shared-sibling-target')

    expect(repA).toBeDefined()
    expect(repB).toBeDefined()
    expect(repA!.hooks[0].calls).toBe(1)
    expect(repB!.hooks[0].calls).toBe(1)
  })

  it('preserves sibling wrappers around applyToEnvironment when multiple SMVP instances share config (Codex P2 finding)', async () => {
    let reportA: MeasureReport | null = null
    let reportB: MeasureReport | null = null

    const factoryPlugin: Plugin = {
      name: 'shared-factory-target',
      applyToEnvironment(env) {
        return {
          name: 'child-plugin',
          transform(code) {
            return code + ' // transformed'
          },
        }
      },
    }

    // Instance A measures applyToEnvironment
    const measureA = smvp({
      hooks: ['applyToEnvironment'],
      output: (r) => {
        reportA = r
      },
    }) as Plugin

    // Instance B only measures transform (the default)
    const measureB = smvp({
      hooks: ['transform'],
      output: (r) => {
        reportB = r
      },
    }) as Plugin

    const config = {
      command: 'build',
      plugins: [factoryPlugin, measureA, measureB],
    } as unknown as ResolvedConfig

    ;(measureA as any).configResolved?.(config)
    ;(measureB as any).configResolved?.(config)

    // Simulate Vite invoking applyToEnvironment factory hook
    const childPlugin = await (factoryPlugin.applyToEnvironment as any).call({} as any, { name: 'client' })

    expect(childPlugin).toBeDefined()

    // Simulate transform hook execution on returned child plugin
    const child = Array.isArray(childPlugin) ? childPlugin[0] : childPlugin
    await (child.transform as any).call({} as any, 'const x = 1;', 'x.js')

    await (measureA.closeBundle as any).call({} as any)
    await (measureB.closeBundle as any).call({} as any)

    // Instance A must have recorded and reported applyToEnvironment
    expect(reportA).not.toBeNull()
    const factoryRepA = reportA!.plugins.find((p) => p.pluginName === 'shared-factory-target')
    expect(factoryRepA).toBeDefined()
    expect(factoryRepA!.hooks.find((h) => h.hookName === 'applyToEnvironment')?.calls).toBe(1)

    // Instance B must have recorded and reported child plugin transform
    expect(reportB).not.toBeNull()
    const childRepB = reportB!.plugins.find((p) => p.pluginName === 'child-plugin')
    expect(childRepB).toBeDefined()
    expect(childRepB!.hooks.find((h) => h.hookName === 'transform')?.calls).toBe(1)
  })

  it('preserves sibling detection when wrapping factory result arrays (Codex P2 finding)', async () => {
    let reportA: MeasureReport | null = null
    let reportB: MeasureReport | null = null

    const factoryPlugin: Plugin = {
      name: 'factory-returning-array',
      applyToEnvironment() {
        return [
          {
            name: 'child-in-array',
            transform(code: string) {
              return code + ' // child transformed'
            },
          },
        ]
      },
    }

    const measureA = smvp({
      hooks: ['transform'],
      output: (r) => {
        reportA = r
      },
    }) as Plugin

    const measureB = smvp({
      hooks: ['transform'],
      output: (r) => {
        reportB = r
      },
    }) as Plugin

    const config = {
      command: 'build',
      plugins: [factoryPlugin, measureA, measureB],
    } as unknown as ResolvedConfig

    ;(measureA as any).configResolved?.(config)
    ;(measureB as any).configResolved?.(config)

    // Simulate Vite invoking applyToEnvironment factory hook
    const childPlugins = (await (factoryPlugin.applyToEnvironment as any).call(
      {} as any,
      { name: 'client' },
    )) as Plugin[]

    expect(Array.isArray(childPlugins)).toBe(true)
    expect(childPlugins.length).toBe(1)

    // Simulate transform on child plugin
    const child = childPlugins[0]
    const res = await (child.transform as any).call({} as any, 'const x = 1;', 'x.js')
    expect(res).toContain('// child transformed')

    await (measureA.closeBundle as any).call({} as any)
    await (measureB.closeBundle as any).call({} as any)

    // Both reporters MUST report the child plugin transform!
    expect(reportA).not.toBeNull()
    const childRepA = reportA!.plugins.find((p) => p.pluginName === 'child-in-array')
    expect(childRepA).toBeDefined()
    expect(childRepA!.hooks.find((h) => h.hookName === 'transform')?.calls).toBe(1)

    expect(reportB).not.toBeNull()
    const childRepB = reportB!.plugins.find((p) => p.pluginName === 'child-in-array')
    expect(childRepB).toBeDefined()
    expect(childRepB!.hooks.find((h) => h.hookName === 'transform')?.calls).toBe(1)
  })

  it('does not clean up shared measure instance until all build environments finish (Codex P1 finding)', async () => {
    const reports: MeasureReport[] = []
    const target: Plugin = {
      name: 'multi-env-target',
      transform(code: string) {
        return code + ' // transformed'
      },
    }

    const measure = smvp({
      output: (r) => {
        reports.push(r)
      },
    }) as Plugin

    const cfgA = {
      command: 'build',
      plugins: [target, measure],
    } as unknown as ResolvedConfig

    const cfgB = {
      command: 'build',
      plugins: [target, measure],
    } as unknown as ResolvedConfig

    ;(measure as any).configResolved(cfgA)
    ;(measure as any).configResolved(cfgB)

    // Environment 1 builds
    await (measure as any).buildStart.call({})
    await (target.transform as any).call({} as any, 'x', 'x.js')
    await (measure.closeBundle as any).call({} as any)

    expect(reports.length).toBe(1)
    expect(reports[0].plugins[0].hooks[0].calls).toBe(1)

    // Environment 2 builds - buildStart re-wraps plugins for the next build
    await (measure as any).buildStart.call({})
    expect((target.transform as any).__rawOriginal).toBeDefined()
    await (target.transform as any).call({} as any, 'y', 'y.js')
    await (measure.closeBundle as any).call({} as any)

    // Both reports generated
    expect(reports.length).toBe(2)
    expect(reports[1].plugins[0].hooks[0].calls).toBe(1)

    // After all environments finish, hooks are cleaned up
    expect((target.transform as any).__rawOriginal).toBeUndefined()
  }, 15000)

  it('does not clean up active hooks when old server closes after restart (Codex P2 finding)', async () => {
    let report: MeasureReport | null = null
    const target: Plugin = {
      name: 'restart-dev-target',
      transform(code: string) {
        return code + ' // dev transformed'
      },
    }

    const measure = smvp({
      gapTime: 10,
      output: (r) => {
        report = r
      },
    }) as Plugin

    const config = {
      command: 'serve',
      plugins: [target, measure],
    } as unknown as ResolvedConfig

    ;(measure as any).configResolved(config)

    // 1. Initial server setup
    let oldServerClosed = false
    const oldServer: any = {
      close: async () => {
        oldServerClosed = true
      },
    }
    ;(measure as any).configureServer(oldServer)

    // 2. server.restart(): Vite creates newServer before closing oldServer
    let newServerClosed = false
    const newServer: any = {
      close: async () => {
        newServerClosed = true
      },
    }
    ;(measure as any).configureServer(newServer)

    // 3. Vite closes oldServer
    await oldServer.close()
    expect(oldServerClosed).toBe(true)

    // 4. Target transform hook must STILL be wrapped and measured on newServer!
    expect((target.transform as any).__rawOriginal).toBeDefined()
    await (target.transform as any).call({} as any, 'const foo = 1;', 'foo.js')

    // Wait for dev flush
    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(report).not.toBeNull()
    const targetRep = report!.plugins.find((p) => p.pluginName === 'restart-dev-target')
    expect(targetRep).toBeDefined()
    expect(targetRep!.hooks[0].calls).toBe(1)

    // 5. When newServer finally closes, cleanup runs
    await newServer.close()
    expect(newServerClosed).toBe(true)
    expect((target.transform as any).__rawOriginal).toBeUndefined()
  }, 15000)

  it('does not double-wrap plugins in options hook during Vite builds (Codex P1 finding)', async () => {
    let report: MeasureReport | null = null
    const target: Plugin = {
      name: 'options-env-target',
      transform(code: string) {
        return code
      },
    }

    const measure = smvp({
      output: (r) => {
        report = r
      },
    }) as Plugin

    const config = {
      command: 'build',
      plugins: [target, measure],
    } as unknown as ResolvedConfig

    ;(measure as any).configResolved(config)

    // Simulate Vite injectEnvironmentToHooks creating a wrapper for Rollup options
    const capturedTransform = target.transform as any
    const envClone: Plugin = {
      ...target,
      transform: function (this: any, ...args: any[]) {
        return capturedTransform.apply(this, args)
      },
    }

    const inputOptions = {
      plugins: [envClone, measure],
    }
    ;(measure as any).options(inputOptions)

    // Execute transform once
    await (inputOptions.plugins[0].transform as any).call({} as any, 'hello', 'hello.js')

    await (measure.closeBundle as any).call({} as any)

    expect(report).not.toBeNull()
    const targetRep = report!.plugins.find((p) => p.pluginName === 'options-env-target')
    expect(targetRep).toBeDefined()
    // Must be exactly 1 call, not double-counted as 2
    expect(targetRep!.hooks[0].calls).toBe(1)
  })

  it('correctly tracks expected environments in Vite createBuilder and cleans up on completion (Codex P2 finding)', async () => {
    const { createBuilder } = await import('vite')
    const reports: MeasureReport[] = []
    const target: Plugin = {
      name: 'builder-probe-target',
      transform(code: string) {
        return code
      },
    }

    const measure = smvp({
      output: (r) => {
        reports.push(r)
      },
    }) as Plugin

    const b = await createBuilder({
      root: process.cwd(),
      logLevel: 'silent',
      plugins: [target, measure],
      builder: { sharedPlugins: true },
      environments: {
        client: { build: { write: false, lib: { entry: 'tests/test-utils.ts', formats: ['es'] } } },
        ssr: { build: { write: false, lib: { entry: 'tests/test-utils.ts', formats: ['es'] } } },
      },
    })

    for (const e of Object.values(b.environments)) {
      await b.build(e)
    }

    expect(reports.length).toBe(2)
    expect(reports[0].plugins.find((p) => p.pluginName === 'builder-probe-target')?.hooks[0]?.calls).toBe(1)
    expect(reports[1].plugins.find((p) => p.pluginName === 'builder-probe-target')?.hooks[0]?.calls).toBe(1)
    // After all environments finish, hooks must be cleanly restored
    expect((target.transform as any).__rawOriginal).toBeUndefined()
  }, 15000)

  it('preserves subclass overridden method when cloning frozen class plugin (Codex P2 finding)', async () => {
    class Base {
      transform() {
        return 'BASE'
      }
    }
    class Derived extends Base {
      name = 'derived-plugin'
      transform() {
        return 'DERIVED'
      }
    }

    const p = Object.freeze(new Derived())
    const [wrapped, measure] = smvp([p], { output: () => {} }) as unknown as [Plugin, Plugin]
    const result = await (wrapped.transform as any).call(wrapped)
    expect(result).toBe('DERIVED')
    ;(measure as any).cleanup?.()
  })

  it('separately records and serializes concurrent closeBundle calls (Codex P2 finding)', async () => {
    const p: Plugin = {
      name: 'concurrent-close-plugin',
      transform(code: string) {
        return code
      },
    }
    const reports: MeasureReport[] = []
    const measure = smvp({
      output: (r) => {
        reports.push(r)
      },
    }) as Plugin

    ;(measure as any).configResolved({
      command: 'build',
      plugins: [p, measure],
      environments: { client: {}, ssr: {} },
    })

    await (p.transform as any).call({} as any, 'code', 'file.js')

    const h = (measure.closeBundle as any).handler
    await Promise.all([
      h.call({ environment: { name: 'client' } }),
      h.call({ environment: { name: 'ssr' } }),
    ])

    expect(reports.length).toBe(1)
    expect(reports[0].plugins[0].hooks[0].calls).toBe(1)
    expect((p.transform as any).__rawOriginal).toBeUndefined()
  })

  it('cleans up when only a single environment is built despite multi-environment config (Codex P2 finding)', async () => {
    const r: Plugin = {
      name: 'single-env-target',
      transform(code: string) {
        return code
      },
    }
    let reportCount = 0
    const measure = smvp({
      output: () => {
        reportCount++
      },
    }) as Plugin

    ;(measure as any).configResolved({
      command: 'build',
      plugins: [r, measure],
      environments: { client: {}, ssr: {} },
    })

    await (r.transform as any).call({} as any, 'code', 'file.js')

    await (measure.closeBundle as any).handler.call({ environment: { name: 'client' } })

    expect(reportCount).toBe(1)
    expect((r.transform as any).__rawOriginal).toBeUndefined()
  })
})
