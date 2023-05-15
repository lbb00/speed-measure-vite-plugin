import { log, colorPrimary, colorGreen } from "./log.js"

function print(statsMap, sort) {
	if (statsMap.size === 0) {
		return
	}
	const arr = []
	let allPluginsTotal = 0
	let printMaxSize = [0, 0, 0]
	statsMap.forEach(({ total, parallel }, name) => {
		allPluginsTotal += total
		const totalS = `${total / 1000}s`
		const parallelS = `${parallel / 1000}s`
		printMaxSize = [name.length, totalS.length, parallelS.length].map(
			(i, index) => Math.max(i, printMaxSize[index]),
		)
		arr.push({
			name,
			total,
			parallel,
			totalS,
			parallelS,
		})
	})
	arr.sort((a, b) =>
		typeof sort === "function" ? sort(a.total, b.total) : null,
	)

	log(colorPrimary("SMVP:"))
	arr.unshift({
		name: "",
		totalS: "Total",
		parallelS: "Parallel",
	})
	arr.forEach(({ name, totalS, parallelS }) => {
		name = name.padEnd(printMaxSize[0], " ")
		totalS = totalS.padEnd(printMaxSize[1], " ")
		parallelS = parallelS.padEnd(printMaxSize[2], " ")
		log(`${name}  ${colorGreen(totalS)}  ${colorGreen(parallelS)}`)
	})
	log(colorPrimary(`All vite plugins took ${allPluginsTotal / 1000}s`))
}

export default function speedMeasureWrap(
	plugins,
	{ sort, maxTransformTimeOnce = 1000 } = {},
) {
	let statsMap = new Map()
	let lastTransformRunAt = null
	let interval = null

	function checkProcessDone() {
		if (
			lastTransformRunAt &&
			lastTransformRunAt < Date.now() - maxTransformTimeOnce
		) {
			print(statsMap, sort)
			statsMap = new Map()
		}
	}

	function wrap(plugin) {
		if (typeof plugin.transform !== "function") {
			return plugin
		}

		const { name, transform } = plugin
		plugin.transform = function (...args) {
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
			function write() {
				const endAt = Date.now()
				data.total += endAt - startAt
				data.runCount--
				if (data.runCount === 0) {
					data.parallel += endAt - data.runAt
					data.runAt = 0
				}
			}
			if (res instanceof Promise) {
				res.then(write)
			} else {
				write()
			}

			return res
		}
		return plugin
	}

	const wrapPlugins = plugins.map((i) => {
		if (Array.isArray(i)) {
			return i.map((i) => wrap(i))
		}
		return wrap(i)
	})

	wrapPlugins.push({
		name: "smvp:closeBundleWatcher",
		closeBundle: () => {
			print(statsMap, sort)
			if (interval) {
				clearInterval(interval)
				interval = null
			}
		},
	})

	return wrapPlugins
}
