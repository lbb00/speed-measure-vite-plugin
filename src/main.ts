import { log, colorPrimary, colorGreen } from './log'
import type { PluginOption, Plugin } from 'vite'

type Stats = { total: number; parallel: number; runAt: number; runCount: number }
type StatsMap = Map<string, Stats>

function print(statsMap: StatsMap, sort?: (a: number, b: number) => number) {
  if (statsMap.size === 0) {
    return
  }
  const table: { name: string; total: number; parallel: number; totalS: string; parallelS: string }[] = []
  let allPluginsTotal = 0
  let printMaxSize = [0, 0, 0]
  statsMap.forEach(({ total, parallel }, name) => {
    allPluginsTotal += total
    const totalS = `${total / 1000}s`
    const parallelS = `${parallel / 1000}s`
    printMaxSize = [name.length, totalS.length, parallelS.length].map((i, index) => Math.max(i, printMaxSize[index]))
    table.push({
      name,
      total,
      parallel,
      totalS,
      parallelS,
    })
  })

  if (typeof sort === 'function') {
    table.sort((a, b) => sort(a.total, b.total))
  }

  log(colorPrimary('SMVP:'))

  table.unshift({
    name: '',
    total: 0,
    parallel: 0,
    totalS: 'Total',
    parallelS: 'Parallel',
  })

  table.forEach(({ name, totalS, parallelS }) => {
    name = name.padEnd(printMaxSize[0], ' ')
    totalS = totalS.padEnd(printMaxSize[1], ' ')
    parallelS = parallelS.padEnd(printMaxSize[2], ' ')
    log(`${name}  ${colorGreen(totalS)}  ${colorGreen(parallelS)}`)
  })
  log(colorPrimary(`All vite plugins took ${allPluginsTotal / 1000}s`))
}

export default function speedMeasureWrap(
  plugins: PluginOption[],
  { sort, maxTransformTimeOnce = 1000 }: { sort?: (a: number, b: number) => number; maxTransformTimeOnce?: number } = {}
): Promise<PluginOption[]> {
  let statsMap: StatsMap = new Map()
  let lastTransformRunAt: number | null = null
  let interval: number | null = null

  function checkProcessDone() {
    if (lastTransformRunAt && lastTransformRunAt < Date.now() - maxTransformTimeOnce) {
      print(statsMap, sort)
      statsMap = new Map()
    }
  }

  function wrap(plugin: Plugin) {
    if (typeof plugin.transform !== 'function') {
      return plugin
    }

    const transform = plugin.transform
    const name = plugin.name || `unnamed_${Math.random().toString(36).substring(2, 15)}`

    plugin.transform = function warpTransform(...args) {
      if (!interval) {
        interval = setInterval(checkProcessDone, 1000)
      }
      let data = statsMap.get(name)
      if (!data) {
        data = {
          total: 0,
          parallel: 0,
          runAt: 0,
          runCount: 0,
        }
        statsMap.set(name, data)
      }
      data.runCount++
      const startAt = Date.now()
      lastTransformRunAt = startAt
      if (data.runAt === 0) {
        data.runAt = startAt
      }
      const _this = this
      const res = transform.apply(_this, args)
      function writeTime() {
        if (!data) return
        const endAt = Date.now()
        data.total += endAt - startAt
        data.runCount--
        if (data.runCount === 0) {
          data.parallel += endAt - data.runAt
          data.runAt = 0
        }
      }
      if (res instanceof Promise) {
        res.then(writeTime)
      } else {
        writeTime()
      }

      return res
    }
    return plugin
  }

  function handlePlugin(plugin: PluginOption) {
    if (plugin === null || plugin === undefined || typeof plugin === 'boolean') {
      return plugin
    }
    if (typeof plugin === 'function') {
      return () => handlePlugin(plugin)
    }
    if (Array.isArray(plugin)) {
      return plugin.map((i) => handlePlugin(i))
    }
    if (plugin instanceof Promise) {
      return plugin.then((plugin) => handlePlugin(plugin))
    }

    return wrap(plugin)
  }

  const pluginsWrapped = handlePlugin(plugins)

  pluginsWrapped.push({
    name: 'smvp:closeBundleWatcher',
    closeBundle: () => {
      print(statsMap, sort)
      if (interval) {
        clearInterval(interval)
        interval = null
      }
    },
  })

  return pluginsWrapped
}
