import chalk from 'chalk'

const mainColor = chalk.hex('#674CFF')
function log(text) {
  return console.log(`${text}`)
}

export default function speedMeasureWrap(
  plugins,
  { sort, maxTransformTimeOnce = 1000 } = {}
) {
  let pluginsMap = {}
  let runAt = null
  let interval = null

  function checkProcessDone() {
    if (runAt && runAt < Date.now() - maxTransformTimeOnce) {
      print()
    }
  }

  function print() {
    if (Object.keys(pluginsMap).length === 0) return
    log(mainColor('SMVP:'))
    const arr = Object.keys(pluginsMap)
      .map((name) => {
        return {
          name,
          time: pluginsMap[name],
        }
      })
      .sort((a, b) => {
        return typeof sort === 'function' ? sort(a.time, b.time) : null
      })
    arr.forEach((i) => {
      log(`${i.name} ${chalk.green(i.time / 1000 + 's')}`)
    })
    log(
      mainColor(
        `All vite plugins took ${chalk.green(
          arr.reduce((total, { time }) => total + time, 0) / 1000 + 's'
        )}`
      )
    )
    pluginsMap = {}
  }

  function wrap(plugin) {
    const transform = plugin.transform

    plugin.transform = function (...args) {
      if (!interval) {
        interval = setInterval(checkProcessDone, 1000)
      }
      const _this = this
      const start = Date.now()
      runAt = start
      if (!transform) {
        return
      }
      let res = transform.apply(_this, args)
      if (!pluginsMap[plugin.name]) {
        pluginsMap[plugin.name] = 0
      }
      if (!(res instanceof Promise)) {
        pluginsMap[plugin.name] += Date.now() - start
        return res
      }

      return res.then(function (res) {
        pluginsMap[plugin.name] += Date.now() - start
        return res
      })
    }
    return plugin
  }

  const wrapPlugins = plugins.map((i) => {
    if (Array.isArray(i)) {
      return i.map((i) => {
        return wrap(i)
      })
    }
    return wrap(i)
  })
  wrapPlugins.push({
    name: 'smvp:closeBundleWatcher',
    closeBundle: () => {
      print()
      if (interval) {
        clearInterval(interval)
        interval = null
      }
    },
  })

  return wrapPlugins
}
