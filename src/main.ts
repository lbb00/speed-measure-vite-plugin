import { log, colorPrimary, colorGreen } from './log'
import type { PluginOption, Plugin } from 'vite'
import { decorateVitePluginOption } from 'decorate-vite-plugin'
import { performance } from 'node:perf_hooks'

type Stats = {
  total: number
  parallel: number
  runAt: number
  runCount: number
}

export default function speedMeasureWrap(
  plugins: PluginOption[],
  {
    hooks = ['transform'],
    sort = (a, b) => b - a,
    maxGapTimeOnce = 1000,
    maxTransformTimeOnce,
  }: {
    hooks?: (keyof Plugin)[]
    sort?: (a: number, b: number) => number
    maxGapTimeOnce?: number
    /**
     * @deprecated Use maxGapTimeOnce instead
     */
    maxTransformTimeOnce?: number
  } = {}
): PluginOption[] {
  let statsMap: Map<string, Map<string, Stats>> = new Map()
  let lastTransformRunAt: number | null = null
  let interval: number | null = null

  const gapTimeOnce = maxGapTimeOnce || maxTransformTimeOnce
  function checkProcessDone() {
    if (lastTransformRunAt && lastTransformRunAt < performance.now() - gapTimeOnce) {
      printResults(statsMap, sort)
      statsMap = new Map()
    }
  }

  function printResults(statsMap: Map<string, Map<string, Stats>>, sort?: (a: number, b: number) => number) {
    if (statsMap.size === 0) {
      return
    }

    log(colorPrimary('[SMVP]'))

    const pluginTotals: Map<string, number> = new Map()
    let allPluginsTotal = 0

    statsMap.forEach((hookStats, pluginName) => {
      let pluginTotal = 0
      hookStats.forEach((stats) => {
        pluginTotal += stats.total
      })
      pluginTotals.set(pluginName, pluginTotal)
      allPluginsTotal += pluginTotal
    })

    const pluginEntries = Array.from(pluginTotals.entries())
    if (typeof sort === 'function') {
      pluginEntries.sort((a, b) => sort(a[1], b[1]))
    }

    pluginEntries.forEach(([pluginName, pluginTotal], index) => {
      if (index > 0) {
        log('')
      }

      log(`${pluginName}: ${colorGreen(`${pluginTotal / 1000}s`)}`)

      const hookStats = statsMap.get(pluginName)
      if (!hookStats || hookStats.size === 0) return

      let maxHookNameLength = 0
      hookStats.forEach((_, hookName) => {
        maxHookNameLength = Math.max(maxHookNameLength, hookName.length)
      })

      const table: {
        hookName: string
        total: number
        parallel: number
        totalS: string
        parallelS: string
      }[] = []
      hookStats.forEach((stats, hookName) => {
        const { total, parallel } = stats
        table.push({
          hookName,
          total,
          parallel,
          totalS: `${total / 1000}s`,
          parallelS: `${parallel / 1000}s`,
        })
      })

      if (typeof sort === 'function') {
        table.sort((a, b) => sort(a.total, b.total))
      }

      table.forEach(({ hookName, totalS, parallelS }) => {
        const paddedHookName = hookName.padEnd(maxHookNameLength, ' ')
        log(`  ${paddedHookName}  Total: ${colorGreen(totalS)}  Parallel: ${colorGreen(parallelS)}`)
      })
    })

    log(colorPrimary(`All plugins total time: ${allPluginsTotal / 1000}s`))
  }

  const createHookDecorator = (hookName: string) => {
    return (originalHook: any, plugin: Plugin) => {
      if (typeof originalHook !== 'function') {
        return originalHook
      }

      const name = plugin.name || `unnamed_${Math.random().toString(36).substring(2, 15)}`

      return function decoratedHook(...args) {
        if (!interval) {
          interval = setInterval(checkProcessDone, 1000)
        }

        let pluginStats = statsMap.get(name)
        if (!pluginStats) {
          pluginStats = new Map()
          statsMap.set(name, pluginStats)
        }

        let hookStats = pluginStats.get(hookName)
        if (!hookStats) {
          hookStats = {
            total: 0,
            parallel: 0,
            runAt: 0,
            runCount: 0,
          }
          pluginStats.set(hookName, hookStats)
        }

        hookStats.runCount++
        const startAt = performance.now()

        if (hookName === 'transform') {
          lastTransformRunAt = startAt
        }

        if (hookStats.runAt === 0) {
          hookStats.runAt = startAt
        }

        const res = originalHook.apply(this, args)

        function writeTime() {
          if (!hookStats) return
          const endAt = performance.now()
          hookStats.total += endAt - startAt
          hookStats.runCount--
          if (hookStats.runCount === 0) {
            hookStats.parallel += endAt - hookStats.runAt
            hookStats.runAt = 0
          }
        }

        if (res instanceof Promise) {
          res.then(writeTime)
        } else {
          writeTime()
        }

        return res
      }
    }
  }

  let wrappedPlugins = plugins
  hooks.forEach((hookName) => {
    wrappedPlugins = decorateVitePluginOption(wrappedPlugins, hookName, createHookDecorator(hookName as string))
  })

  const closeBundlePlugin: Plugin = {
    name: 'smvp:closeBundleWatcher',
    closeBundle: () => {
      printResults(statsMap, sort)
      if (interval) {
        clearInterval(interval)
        interval = null
      }
    },
  }

  return Array.isArray(wrappedPlugins) ? [...wrappedPlugins, closeBundlePlugin] : [wrappedPlugins, closeBundlePlugin]
}
