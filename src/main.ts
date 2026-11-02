import type { PluginOption, Plugin, ResolvedConfig } from "vite"
import { performance } from "node:perf_hooks"
import { log, colorPrimary, colorGreen, colorDim } from "./log"

export interface HookStats {
	total: number
	calls: number
	activeCount: number
	activeStart: number
	parallel: number
}

export interface PluginItemReport {
	pluginName: string
	total: number
	hooks: {
		hookName: string
		total: number
		parallel: number
		calls: number
		activeCount: number
	}[]
}

export interface MeasureReport {
	allPluginsTotal: number
	plugins: PluginItemReport[]
}

export interface SpeedMeasureOptions {
	/**
	 * Hooks to measure.
	 * @default ['transform']
	 */
	/**
	 * Hooks to measure.
	 * Default: ['transform']
	 *
	 * Note: Early lifecycle hooks ('config', 'configResolved') require wrapper syntax
	 * `plugins: smvp([...], { hooks: ['config', 'configResolved'] })`
	 * because Vite executes them before standard plugins can intercept them.
	 */
	hooks?: (keyof Plugin | string)[]
	/**
	 * Sort function for output display.
	 * @default (a, b) => b - a (descending by total time)
	 */
	sort?: (a: number, b: number) => number
	/**
	 * Maximum idle time in ms before flushing metrics in dev mode.
	 * @default 1000
	 */
	maxGapTimeOnce?: number
	/**
	 * Alias for maxGapTimeOnce.
	 */
	gapTime?: number
	/**
	 * @deprecated Use maxGapTimeOnce instead
	 */
	maxTransformTimeOnce?: number
	/**
	 * Minimum total time (in ms) for a plugin to be displayed in the report.
	 * @default 0
	 */
	threshold?: number
	/**
	 * Custom report output handler or format.
	 * @default 'terminal'
	 */
	output?: "terminal" | ((report: MeasureReport) => void)
	/**
	 * Force watch mode behavior (do not teardown hooks on closeBundle).
	 * Automatically inferred from `vite build --watch` or `vite dev`.
	 */
	watch?: boolean
	/**
	 * Whether to disable speed measurement.
	 * @default false
	 */
	disable?: boolean
}

type UnknownRecord = Record<string | symbol, unknown>
type GenericFunction = (this: unknown, ...args: unknown[]) => unknown

interface HookObject {
	order?: "pre" | "post"
	handler: GenericFunction
	[key: string]: unknown
}

function isObject(val: unknown): val is UnknownRecord {
	return val !== null && typeof val === "object"
}

function isPromise(val: unknown): val is Promise<unknown> {
	return isObject(val) && typeof (val as { then?: unknown }).then === "function"
}

function isPlugin(val: unknown): boolean {
	if (!isObject(val) || isPromise(val)) return false
	if (typeof val.name === "string") return true
	return (
		"transform" in val ||
		"resolveId" in val ||
		"load" in val ||
		"config" in val ||
		"configResolved" in val ||
		"buildStart" in val ||
		"buildEnd" in val ||
		"configureServer" in val ||
		"configurePreviewServer" in val ||
		"handleHotUpdate" in val ||
		"applyToEnvironment" in val ||
		"configEnvironment" in val
	)
}

function formatDuration(ms: number): string {
	return `${(ms / 1000).toFixed(3)}s`
}

const activeCleanups = new Set<() => void>()
if (typeof process !== "undefined" && typeof process.once === "function") {
	process.once("exit", () => {
		for (const cleanup of activeCleanups) {
			cleanup()
		}
		activeCleanups.clear()
	})
}

function hasWrapperInSet(fn: unknown, set: Set<object>): boolean {
	let cur: unknown = fn
	while (cur && (typeof cur === "function" || typeof cur === "object")) {
		if (set.has(cur as object)) return true
		if (typeof cur === "function") {
			cur = (cur as unknown as { __rawOriginal?: unknown }).__rawOriginal
		} else if (
			isObject(cur) &&
			typeof (cur as unknown as HookObject).handler === "function"
		) {
			cur = (cur as unknown as HookObject).handler
		} else {
			break
		}
	}
	return false
}

function unwrapRawOriginal<T>(fn: T): T {
	let cur: unknown = fn
	while (
		cur &&
		(typeof cur === "function" || typeof cur === "object") &&
		(cur as unknown as { __rawOriginal?: unknown }).__rawOriginal
	) {
		cur = (cur as unknown as { __rawOriginal?: unknown }).__rawOriginal
	}
	return cur as T
}

function clonePlugin(
	plugin: Plugin,
	thisWrappedHooks?: Set<object>,
	isSiblingHook?: (h: unknown) => boolean,
): Plugin {
	const proto = Object.getPrototypeOf(plugin)
	const target = Object.create(proto)

	// Delegate prototype methods to original plugin so class private fields and methods work
	let cur = proto
	while (cur && cur !== Object.prototype) {
		for (const key of Reflect.ownKeys(cur)) {
			if (key === "constructor") continue
			if (Object.prototype.hasOwnProperty.call(target, key)) continue
			const desc = Object.getOwnPropertyDescriptor(cur, key)
			if (!desc) continue
			if (typeof desc.value === "function") {
				const fn = desc.value
				const effectiveFn =
					(fn as unknown as { __rawOriginal?: GenericFunction })
						.__rawOriginal &&
					(!thisWrappedHooks || !thisWrappedHooks.has(fn as object)) &&
					(!isSiblingHook || !isSiblingHook(fn))
						? unwrapRawOriginal(fn as GenericFunction)
						: fn
				Object.defineProperty(target, key, {
					value: function (this: unknown, ...args: unknown[]) {
						const ctx = this === target ? plugin : this
						return effectiveFn.apply(ctx, args)
					},
					writable: true,
					configurable: true,
					enumerable: desc.enumerable,
				})
			} else if (desc.get || desc.set) {
				Object.defineProperty(target, key, {
					get: desc.get
						? function (this: unknown) {
								const ctx = this === target ? plugin : this
								return desc.get?.call(ctx)
						  }
						: undefined,
					set: desc.set
						? function (this: unknown, val: unknown) {
								const ctx = this === target ? plugin : this
								return desc.set?.call(ctx, val)
						  }
						: undefined,
					configurable: true,
					enumerable: desc.enumerable,
				})
			}
		}
		cur = Object.getPrototypeOf(cur)
	}

	const descriptors = Object.getOwnPropertyDescriptors(plugin)
	for (const key of Reflect.ownKeys(descriptors)) {
		const desc = descriptors[key as string]
		if (!desc) continue
		if ("value" in desc) {
			if (typeof desc.value === "function") {
				const fn = desc.value
				const effectiveFn =
					(fn as unknown as { __rawOriginal?: GenericFunction })
						.__rawOriginal &&
					(!thisWrappedHooks || !thisWrappedHooks.has(fn as object)) &&
					(!isSiblingHook || !isSiblingHook(fn))
						? unwrapRawOriginal(fn as GenericFunction)
						: fn
				Object.defineProperty(target, key, {
					value: function (this: unknown, ...args: unknown[]) {
						const ctx = this === target ? plugin : this
						return effectiveFn.apply(ctx, args)
					},
					writable: true,
					configurable: true,
					enumerable: desc.enumerable,
				})
			} else if (
				isObject(desc.value) &&
				typeof (desc.value as unknown as HookObject).handler === "function"
			) {
				const hookObj = desc.value as unknown as HookObject
				const handler = hookObj.handler
				const effectiveHandler =
					(handler as unknown as { __rawOriginal?: GenericFunction })
						.__rawOriginal &&
					(!thisWrappedHooks || !thisWrappedHooks.has(handler as object)) &&
					(!isSiblingHook || !isSiblingHook(handler))
						? unwrapRawOriginal(handler)
						: handler
				Object.defineProperty(target, key, {
					value: {
						...hookObj,
						handler: effectiveHandler,
					},
					writable: true,
					configurable: true,
					enumerable: desc.enumerable,
				})
			} else {
				Object.defineProperty(target, key, {
					value: desc.value,
					writable: true,
					configurable: true,
					enumerable: desc.enumerable,
				})
			}
		} else {
			Object.defineProperty(target, key, {
				get: desc.get
					? function (this: unknown) {
							const ctx = this === target ? plugin : this
							return desc.get?.call(ctx)
					  }
					: undefined,
				set: desc.set
					? function (this: unknown, val: unknown) {
							const ctx = this === target ? plugin : this
							return desc.set?.call(ctx, val)
					  }
					: undefined,
				configurable: true,
				enumerable: desc.enumerable,
			})
		}
	}
	return target as Plugin
}

function getEffectiveParallel(stats: HookStats): number {
	let p = stats.parallel
	if (stats.activeCount > 0 && stats.activeStart > 0) {
		p += Math.max(0, performance.now() - stats.activeStart)
	}
	return p
}

function printResults(
	statsMap: Map<string, Map<string, HookStats>>,
	options: SpeedMeasureOptions = {},
) {
	if (statsMap.size === 0) return

	const sortFn = options.sort ?? ((a, b) => b - a)
	const threshold = options.threshold ?? 0

	const pluginTotals = new Map<string, number>()
	let allPluginsTotal = 0

	statsMap.forEach((hookMap, pluginName) => {
		let pluginTotal = 0
		hookMap.forEach((stat) => {
			pluginTotal += stat.total
		})
		pluginTotals.set(pluginName, pluginTotal)
		allPluginsTotal += pluginTotal
	})

	let pluginEntries = Array.from(pluginTotals.entries())
	if (threshold > 0) {
		pluginEntries = pluginEntries.filter(([_, total]) => total >= threshold)
	}

	if (typeof options.output === "function") {
		pluginEntries.sort((a, b) => sortFn(a[1], b[1]))
		const report: MeasureReport = {
			allPluginsTotal,
			plugins: pluginEntries.map(([pluginName, total]) => {
				const hookMap = statsMap.get(pluginName)
				const hooks: PluginItemReport["hooks"] = []
				if (hookMap) {
					hookMap.forEach((stat, hookName) => {
						hooks.push({
							hookName,
							total: stat.total,
							parallel: getEffectiveParallel(stat),
							calls: stat.calls,
							activeCount: stat.activeCount,
						})
					})
					hooks.sort((a, b) => sortFn(a.total, b.total))
				}
				return {
					pluginName,
					total,
					hooks,
				}
			}),
		}
		options.output(report)
		return
	}

	if (pluginEntries.length === 0) return

	pluginEntries.sort((a, b) => sortFn(a[1], b[1]))

	log(colorPrimary("[SMVP]"))

	pluginEntries.forEach(([pluginName, pluginTotal], index) => {
		if (index > 0) {
			log("")
		}

		log(`${pluginName}: ${colorGreen(formatDuration(pluginTotal))}`)

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
			calls: number
			totalS: string
			parallelS: string
		}[] = []

		hookStats.forEach((stats, hookName) => {
			const effectiveParallel = getEffectiveParallel(stats)
			table.push({
				hookName,
				total: stats.total,
				parallel: effectiveParallel,
				calls: stats.calls,
				totalS: formatDuration(stats.total),
				parallelS: formatDuration(effectiveParallel),
			})
		})

		table.sort((a, b) => sortFn(a.total, b.total))

		table.forEach(({ hookName, total, parallel, totalS, parallelS, calls }) => {
			const paddedHookName = hookName.padEnd(maxHookNameLength, " ")
			const avgMs = calls > 0 ? (total / calls).toFixed(1) : "0.0"
			const speedup =
				total > 10 && parallel > 0 && total / parallel >= 1.2
					? ` (${(total / parallel).toFixed(1)}x)`
					: ""
			const callsStr = colorDim(
				`(${calls} call${calls === 1 ? "" : "s"}, avg ${avgMs}ms)`,
			)
			log(
				`  ${paddedHookName}  Total: ${colorGreen(
					totalS,
				)}  Parallel: ${colorGreen(parallelS + speedup)}  ${callsStr}`,
			)
		})
	})

	log(
		colorPrimary(`All plugins total time: ${formatDuration(allPluginsTotal)}`),
	)
}

interface MeasurePluginInstance extends Plugin {
	wrapPluginsArray: (plugins: readonly Plugin[] | Plugin[]) => void
	wrapPlugin: (plugin: Plugin) => Plugin
	wrapPluginsOption: <T = unknown>(option: T) => T
	cleanup: () => void
	wrappedHooks: Set<object>
}

function createMeasurePlugin(
	options: SpeedMeasureOptions = {},
	isWrapperMode = false,
): MeasurePluginInstance {
	const opts = options ?? {}
	const { hooks = ["transform"], disable = false } = opts

	if (disable) {
		const disabledPlugin = {
			name: "speed-measure-vite-plugin:disabled",
			wrapPluginsArray: () => {},
			wrapPlugin: (p: Plugin) => p,
			wrapPluginsOption: <T>(opt: T) => opt,
			cleanup: () => {},
			wrappedHooks: new Set<object>(),
		}
		return disabledPlugin as MeasurePluginInstance
	}

	const effectiveGapTime =
		opts.gapTime ?? opts.maxGapTimeOnce ?? opts.maxTransformTimeOnce ?? 1000
	const hooksToMeasure = hooks as string[]

	if (
		!isWrapperMode &&
		(hooksToMeasure.includes("config") ||
			hooksToMeasure.includes("configResolved") ||
			hooksToMeasure.includes("configEnvironment"))
	) {
		console.warn(
			"[SMVP] Measuring 'config', 'configResolved', or 'configEnvironment' hooks requires wrapper mode syntax: `plugins: smvp([plugins], { hooks: [...] })` because Vite runs early config hooks before standard plugins can wrap them.",
		)
	}

	const statsMap = new Map<string, Map<string, HookStats>>()
	const wrappedHooks = new Set<object>()
	const wrappedPlugins = new Set<object>()
	const clonedPlugins = new WeakMap<Plugin, Plugin>()
	const activeServers = new Set<unknown>()
	const activeBuildEnvironments = new Set<string>()
	let activeBuildsCount = 0
	let pendingCloseBundleCount = 0
	const trackedPluginLists = new Set<Plugin[]>()
	let trackedPlugins: Plugin[] | null = null
	let trackedEnvironments: Record<string, { plugins?: Plugin[] }> | null = null
	let isSiblingHook: ((h: unknown) => boolean) | undefined

	let devTimer: NodeJS.Timeout | null = null
	let isDevMode = false
	let isWatchMode = Boolean(opts.watch)
	let isClosed = false
	let hasConfigResolved = false
	let closeBundlePromise: Promise<void> | null = null
	const cleanupActions: (() => void)[] = []

	function cleanup() {
		if (isClosed) return
		isClosed = true
		hasConfigResolved = false
		activeCleanups.delete(cleanup)
		closeBundlePromise = null
		activeBuildEnvironments.clear()
		activeBuildsCount = 0
		pendingCloseBundleCount = 0
		activeServers.clear()
		if (devTimer) {
			clearTimeout(devTimer)
			devTimer = null
		}
		for (const action of cleanupActions) {
			action()
		}
		cleanupActions.length = 0
		wrappedPlugins.clear()
		wrappedHooks.clear()
		isSiblingHook = undefined
	}

	function updateSiblingHooks(plugins?: unknown) {
		if (!plugins || !Array.isArray(plugins)) return
		const siblings = plugins.filter(
			(p) =>
				p &&
				(p as unknown as MeasurePluginInstance).name ===
					"speed-measure-vite-plugin" &&
				(p as unknown as MeasurePluginInstance).wrappedHooks &&
				(p as unknown as MeasurePluginInstance).wrappedHooks !== wrappedHooks,
		) as MeasurePluginInstance[]
		isSiblingHook = (h) => siblings.some((s) => s.wrappedHooks.has(h as object))
	}

	activeCleanups.add(cleanup)

	function getHookStats(pluginName: string, hookName: string): HookStats {
		let pluginStats = statsMap.get(pluginName)
		if (!pluginStats) {
			pluginStats = new Map()
			statsMap.set(pluginName, pluginStats)
		}
		let hookStats = pluginStats.get(hookName)
		if (!hookStats) {
			hookStats = {
				total: 0,
				calls: 0,
				activeCount: 0,
				activeStart: 0,
				parallel: 0,
			}
			pluginStats.set(hookName, hookStats)
		}
		return hookStats
	}

	function hasActiveHooks(): boolean {
		for (const hookMap of statsMap.values()) {
			for (const stat of hookMap.values()) {
				if (stat.activeCount > 0) return true
			}
		}
		return false
	}

	function scheduleDevFlush() {
		if (!isDevMode) return

		if (devTimer) {
			clearTimeout(devTimer)
		}

		devTimer = setTimeout(() => {
			// If an in-flight hook is still running, do not wipe statsMap! Postpone flush!
			if (hasActiveHooks()) {
				scheduleDevFlush()
				return
			}
			printResults(statsMap, opts)
			statsMap.clear()
			devTimer = null
		}, effectiveGapTime)

		if (devTimer && typeof devTimer.unref === "function") {
			devTimer.unref()
		}
	}

	function createWrappedFunction(
		original: GenericFunction,
		pluginName: string,
		hookName: string,
		targetPlugin?: Plugin,
		originalPlugin?: Plugin,
	): GenericFunction {
		const rawOriginal = original

		const wrapped = function (this: unknown, ...args: unknown[]) {
			const context =
				targetPlugin && originalPlugin && this === targetPlugin
					? originalPlugin
					: this

			if (isClosed) {
				return rawOriginal.apply(context, args)
			}

			const stats = getHookStats(pluginName, hookName)
			const startAt = performance.now()
			if (stats.activeCount === 0) {
				stats.activeStart = startAt
			}
			stats.activeCount++
			stats.calls++

			const finish = () => {
				const endAt = performance.now()
				stats.total += Math.max(0, endAt - startAt)
				stats.activeCount--
				if (stats.activeCount === 0) {
					stats.parallel += Math.max(0, endAt - stats.activeStart)
					stats.activeStart = 0
				}
				scheduleDevFlush()
			}

			let res: unknown
			try {
				res = rawOriginal.apply(context, args)
			} catch (err) {
				finish()
				throw err
			}

			if (
				isObject(res) &&
				typeof (res as unknown as Promise<unknown>).then === "function"
			) {
				return Promise.resolve(res).then(
					(val: unknown) => {
						finish()
						return val
					},
					(err: unknown) => {
						finish()
						throw err
					},
				)
			}

			finish()
			return res
		}
		;(wrapped as unknown as { __rawOriginal: GenericFunction }).__rawOriginal =
			rawOriginal
		wrappedHooks.add(wrapped as object)
		return wrapped
	}

	function isHookWrappedByAnotherInstance(
		raw: unknown,
		thisWrappedHooks: Set<object>,
		siblingHookCheck?: (h: unknown) => boolean,
	): boolean {
		if (!raw) return false
		if (typeof raw === "function") {
			const rawOriginal = (raw as unknown as { __rawOriginal?: unknown })
				.__rawOriginal
			return (
				rawOriginal !== undefined &&
				!thisWrappedHooks.has(raw as object) &&
				(!siblingHookCheck || !siblingHookCheck(raw))
			)
		}
		if (isObject(raw)) {
			const handler = (raw as unknown as HookObject).handler
			if (typeof handler === "function") {
				const rawOriginal = (handler as unknown as { __rawOriginal?: unknown })
					.__rawOriginal
				return (
					rawOriginal !== undefined &&
					!thisWrappedHooks.has(handler as object) &&
					(!siblingHookCheck || !siblingHookCheck(handler))
				)
			}
		}
		return false
	}

	function isPluginFullyWrapped(p: Plugin): boolean {
		const rawApply = (p as unknown as UnknownRecord).applyToEnvironment
		if (
			typeof rawApply === "function" &&
			!hasWrapperInSet(rawApply, wrappedHooks)
		) {
			return false
		}
		for (const h of hooksToMeasure) {
			const rawHook = (p as unknown as UnknownRecord)[h]
			if (!rawHook) continue
			if (typeof rawHook === "function") {
				if (!hasWrapperInSet(rawHook, wrappedHooks)) return false
			} else if (isObject(rawHook)) {
				const handler = (rawHook as unknown as HookObject).handler
				if (
					typeof handler === "function" &&
					!hasWrapperInSet(handler, wrappedHooks)
				) {
					return false
				}
			}
		}
		return true
	}

	function wrapPlugin(
		plugin: Plugin,
		replaceInArray?: (newPlugin: Plugin) => void,
	): Plugin {
		if (!plugin || typeof plugin !== "object") return plugin
		if (
			plugin.name === "speed-measure-vite-plugin" ||
			plugin.name === "speed-measure-vite-plugin:disabled" ||
			plugin.name === "smvp:closeBundleWatcher"
		) {
			return plugin
		}

		if (wrappedPlugins.has(plugin) && isPluginFullyWrapped(plugin)) {
			return plugin
		}

		const isNonExtensible = !Object.isExtensible(plugin)
		const isAlreadyWrappedByAnotherInstance =
			isHookWrappedByAnotherInstance(
				(plugin as unknown as UnknownRecord).applyToEnvironment,
				wrappedHooks,
				isSiblingHook,
			) ||
			Reflect.ownKeys(plugin).some((k) => {
				const desc = Object.getOwnPropertyDescriptor(plugin, k)
				return isHookWrappedByAnotherInstance(
					desc?.value,
					wrappedHooks,
					isSiblingHook,
				)
			}) ||
			hooksToMeasure.some((h) => {
				const raw = (plugin as unknown as UnknownRecord)[h]
				return isHookWrappedByAnotherInstance(raw, wrappedHooks, isSiblingHook)
			})

		const hasNonWritableHook = hooksToMeasure
			.concat(["applyToEnvironment"])
			.some((h) => {
				let cur: object | null = plugin
				while (cur && cur !== Object.prototype) {
					const desc = Object.getOwnPropertyDescriptor(cur, h)
					if (desc) {
						return !desc.writable && !desc.set
					}
					cur = Object.getPrototypeOf(cur)
				}
				return false
			})

		const shouldScope =
			isNonExtensible || isAlreadyWrappedByAnotherInstance || hasNonWritableHook

		let targetPlugin: Plugin
		if (shouldScope) {
			const existingClone = clonedPlugins.get(plugin)
			if (existingClone) {
				targetPlugin = existingClone
			} else {
				targetPlugin = clonePlugin(plugin, wrappedHooks, isSiblingHook)
				clonedPlugins.set(plugin, targetPlugin)
			}
		} else {
			targetPlugin = plugin
		}
		const pluginRecord = targetPlugin as unknown as UnknownRecord

		const pluginName =
			plugin.name || `unnamed_${Math.random().toString(36).substring(2, 9)}`

		// Handle Vite 6/7 applyToEnvironment plugin factory hook
		const rawApply =
			(targetPlugin as unknown as UnknownRecord).applyToEnvironment ??
			(plugin as unknown as UnknownRecord).applyToEnvironment
		if (
			typeof rawApply === "function" &&
			!wrappedHooks.has(rawApply as object)
		) {
			const rawOriginalApply = unwrapRawOriginal(rawApply as GenericFunction)

			const shouldMeasureApply = hooksToMeasure.includes("applyToEnvironment")

			const wrappedApply = function (this: unknown, env: unknown) {
				// If this is the wrapper, delegate to the original plugin instance so class private fields work!
				const context = shouldScope && this === targetPlugin ? plugin : this
				if (isClosed) {
					const res = rawOriginalApply.call(context, env)
					return wrapPluginsOption(res)
				}

				if (shouldMeasureApply) {
					const stats = getHookStats(pluginName, "applyToEnvironment")
					const startAt = performance.now()
					if (stats.activeCount === 0) {
						stats.activeStart = startAt
					}
					stats.activeCount++
					stats.calls++

					const finish = () => {
						const endAt = performance.now()
						stats.total += Math.max(0, endAt - startAt)
						stats.activeCount--
						if (stats.activeCount === 0) {
							stats.parallel += Math.max(0, endAt - stats.activeStart)
							stats.activeStart = 0
						}
						scheduleDevFlush()
					}

					let res: unknown
					try {
						res = rawOriginalApply.call(context, env)
					} catch (err) {
						finish()
						throw err
					}

					if (isPromise(res)) {
						return Promise.resolve(res).then(
							(asyncRes) => {
								finish()
								return wrapPluginsOption(asyncRes)
							},
							(err) => {
								finish()
								throw err
							},
						)
					}
					finish()
					return wrapPluginsOption(res)
				}

				const res = rawOriginalApply.call(context, env)
				if (isPromise(res)) {
					return (res as Promise<unknown>).then((asyncRes) =>
						wrapPluginsOption(asyncRes),
					)
				}
				return wrapPluginsOption(res)
			}
			;(
				wrappedApply as unknown as { __rawOriginal: GenericFunction }
			).__rawOriginal = rawOriginalApply
			wrappedHooks.add(wrappedApply as object)

			if (shouldScope) {
				Object.defineProperty(targetPlugin, "applyToEnvironment", {
					value: wrappedApply,
					writable: true,
					configurable: true,
					enumerable: true,
				})
			} else {
				try {
					const originalApply = pluginRecord.applyToEnvironment
					pluginRecord.applyToEnvironment = wrappedApply
					cleanupActions.push(() => {
						try {
							if (pluginRecord.applyToEnvironment === wrappedApply) {
								pluginRecord.applyToEnvironment = originalApply
							}
						} catch {
							// Ignore
						}
					})
				} catch {
					// Ignore if property is non-writable
				}
			}
		}

		for (const hookName of hooksToMeasure) {
			if (hookName === "applyToEnvironment") continue
			const rawHook =
				(targetPlugin as unknown as UnknownRecord)[hookName] ??
				(plugin as unknown as UnknownRecord)[hookName]
			if (!rawHook) continue

			if (typeof rawHook === "function") {
				if (hasWrapperInSet(rawHook, wrappedHooks)) continue
				const unwrappedHook =
					shouldScope &&
					(rawHook as unknown as { __rawOriginal?: GenericFunction })
						.__rawOriginal &&
					(!isSiblingHook || !isSiblingHook(rawHook))
						? unwrapRawOriginal(rawHook as GenericFunction)
						: rawHook
				const wrapped = createWrappedFunction(
					unwrappedHook as GenericFunction,
					pluginName,
					hookName,
					targetPlugin,
					plugin,
				)
				if (shouldScope) {
					Object.defineProperty(targetPlugin, hookName, {
						value: wrapped,
						writable: true,
						configurable: true,
						enumerable: true,
					})
				} else {
					try {
						const originalValue = pluginRecord[hookName]
						pluginRecord[hookName] = wrapped
						cleanupActions.push(() => {
							try {
								if (pluginRecord[hookName] === wrapped) {
									pluginRecord[hookName] = originalValue
								}
							} catch {
								// Ignore
							}
						})
					} catch {
						// Ignore if property is non-writable
					}
				}
			} else if (
				isObject(rawHook) &&
				typeof (rawHook as unknown as HookObject).handler === "function"
			) {
				const hookObj = rawHook as unknown as HookObject
				if (hasWrapperInSet(hookObj.handler, wrappedHooks)) continue
				const unwrappedHandler =
					shouldScope &&
					(hookObj.handler as unknown as { __rawOriginal?: GenericFunction })
						.__rawOriginal &&
					(!isSiblingHook || !isSiblingHook(hookObj.handler))
						? unwrapRawOriginal(hookObj.handler as GenericFunction)
						: hookObj.handler
				const wrappedHandler = createWrappedFunction(
					unwrappedHandler,
					pluginName,
					hookName,
					targetPlugin,
					plugin,
				)
				const newHookObj = {
					...hookObj,
					handler: wrappedHandler,
				}
				if (shouldScope) {
					Object.defineProperty(targetPlugin, hookName, {
						value: newHookObj,
						writable: true,
						configurable: true,
						enumerable: true,
					})
				} else {
					try {
						const originalValue = pluginRecord[hookName]
						pluginRecord[hookName] = newHookObj
						cleanupActions.push(() => {
							try {
								if (pluginRecord[hookName] === newHookObj) {
									pluginRecord[hookName] = originalValue
								}
							} catch {
								// Ignore
							}
						})
					} catch {
						// Ignore if property is non-writable
					}
				}
			}
		}

		if (!shouldScope) {
			wrappedPlugins.add(plugin)
		}
		wrappedPlugins.add(targetPlugin)

		if (shouldScope && replaceInArray) {
			try {
				replaceInArray(targetPlugin)
			} catch {
				// Ignore if array is read-only
			}
		}

		return targetPlugin
	}

	function wrapPluginsOption<T>(option: T): T {
		if (!option) return option
		if (Array.isArray(option)) {
			const isReadOnly = Object.isFrozen(option) || !Object.isExtensible(option)
			let arr: unknown[] = isReadOnly ? [...option] : option
			for (let i = 0; i < option.length; i++) {
				const item = option[i]
				if (!item) continue
				if (Array.isArray(item)) {
					const wrappedSub = wrapPluginsOption(item)
					try {
						arr[i] = wrappedSub
					} catch {
						if (arr === option) arr = [...option]
						arr[i] = wrappedSub
					}
				} else if (isPromise(item)) {
					const wrappedItem = (item as Promise<unknown>).then((resolved) =>
						wrapPluginsOption(resolved),
					)
					// Prevent Node.js unhandledRejection if consumer or Vite has not awaited it yet
					wrappedItem.catch(() => {})
					try {
						arr[i] = wrappedItem
					} catch {
						if (arr === option) arr = [...option]
						arr[i] = wrappedItem
					}
				} else if (isObject(item)) {
					const wrapped = wrapPlugin(item as unknown as Plugin, (cloned) => {
						try {
							arr[i] = cloned
						} catch {
							if (arr === option) arr = [...option]
							arr[i] = cloned
						}
					})
					if ((wrapped as unknown) !== item) {
						try {
							arr[i] = wrapped
						} catch {
							if (arr === option) arr = [...option]
							arr[i] = wrapped
						}
					}
				}
			}
			return arr as unknown as T
		}
		if (isPromise(option)) {
			return (option as Promise<unknown>).then((resolved) =>
				wrapPluginsOption(resolved),
			) as unknown as T
		}
		if (isObject(option)) {
			return wrapPlugin(option as unknown as Plugin) as unknown as T
		}
		return option
	}

	function wrapPluginsArray(plugins: readonly Plugin[] | Plugin[]) {
		wrapPluginsOption(plugins)
	}

	function movePluginToEnd(plugins: Plugin[], pluginName: string) {
		const idx = plugins.findIndex((p) => p && p.name === pluginName)
		if (idx !== -1 && idx !== plugins.length - 1) {
			const [target] = plugins.splice(idx, 1)
			plugins.push(target)
		}
	}

	return {
		name: "speed-measure-vite-plugin",
		enforce: "post",
		wrappedHooks,
		wrapPluginsArray,
		wrapPlugin,
		wrapPluginsOption,

		configResolved(config: ResolvedConfig) {
			isClosed = false
			hasConfigResolved = true
			activeCleanups.add(cleanup)
			updateSiblingHooks(config.plugins)
			if (config.command === "serve") {
				isDevMode = true
			} else if (config.command === "build") {
				isDevMode = false
				isWatchMode =
					isWatchMode ||
					Boolean((config as { build?: { watch?: unknown } })?.build?.watch) ||
					Boolean(process.env.ROLLUP_WATCH)
			}

			if (Array.isArray(config.plugins)) {
				trackedPlugins = config.plugins as Plugin[]
				trackedPluginLists.add(config.plugins as Plugin[])
				wrapPluginsOption(config.plugins)
				movePluginToEnd(config.plugins as Plugin[], "speed-measure-vite-plugin")
			}

			// Vite 6 Environment API support
			const envConfig = config as unknown as {
				environments?: Record<string, { plugins?: Plugin[] }>
			}
			if (
				envConfig.environments &&
				typeof envConfig.environments === "object"
			) {
				trackedEnvironments = envConfig.environments
				for (const env of Object.values(envConfig.environments)) {
					if (env && Array.isArray(env.plugins)) {
						trackedPluginLists.add(env.plugins as Plugin[])
						updateSiblingHooks(env.plugins)
						wrapPluginsOption(env.plugins)
						movePluginToEnd(
							env.plugins as Plugin[],
							"speed-measure-vite-plugin",
						)
					}
				}
			}
		},

		buildStart() {
			isClosed = false
			activeCleanups.add(cleanup)
			updateSiblingHooks(trackedPlugins)
			// Re-scan plugins in case any plugin registered or mutated hooks in async configResolved
			if (trackedPlugins && Array.isArray(trackedPlugins)) {
				wrapPluginsOption(trackedPlugins)
			}
			for (const list of trackedPluginLists) {
				if (Array.isArray(list)) {
					updateSiblingHooks(list)
					wrapPluginsOption(list)
				}
			}
			if (trackedEnvironments && typeof trackedEnvironments === "object") {
				for (const env of Object.values(trackedEnvironments)) {
					if (env && Array.isArray(env.plugins)) {
						updateSiblingHooks(env.plugins)
						wrapPluginsOption(env.plugins)
					}
				}
			}
			// In Vite 6, catch any late environment plugins attached to this.environment
			const selfContext = this as unknown as {
				environment?: { name?: string; plugins?: Plugin[] }
			}
			if (selfContext?.environment?.name) {
				activeBuildEnvironments.add(selfContext.environment.name)
			} else {
				activeBuildsCount++
			}
			if (
				selfContext?.environment &&
				Array.isArray(selfContext.environment.plugins)
			) {
				updateSiblingHooks(selfContext.environment.plugins)
				wrapPluginsOption(selfContext.environment.plugins)
				movePluginToEnd(
					selfContext.environment.plugins as Plugin[],
					"speed-measure-vite-plugin",
				)
			}
		},

		cleanup,

		configureServer(server) {
			isDevMode = true
			isClosed = false
			activeCleanups.add(cleanup)
			if (server) {
				activeServers.add(server)
			}
			if (typeof server?.close === "function") {
				const originalServerClose = server.close.bind(server)
				server.close = async () => {
					try {
						return await originalServerClose()
					} finally {
						activeServers.delete(server)
						if (activeServers.size === 0) {
							cleanup()
						}
					}
				}
			}
			return () => {
				if (trackedPlugins && Array.isArray(trackedPlugins)) {
					updateSiblingHooks(trackedPlugins)
					wrapPluginsOption(trackedPlugins)
				}
			}
		},

		closeWatcher() {
			cleanup()
		},

		options(inputOptions) {
			updateSiblingHooks(inputOptions.plugins)
			// Only wrap in options hook for pure Rollup usage where configResolved was not called
			if (!hasConfigResolved && Array.isArray(inputOptions.plugins)) {
				trackedPlugins = inputOptions.plugins as Plugin[]
				trackedPluginLists.add(inputOptions.plugins as Plugin[])
				wrapPluginsOption(inputOptions.plugins as Plugin[])
				movePluginToEnd(
					inputOptions.plugins as Plugin[],
					"speed-measure-vite-plugin",
				)
			}
			return inputOptions
		},

		closeBundle: Object.assign(
			{
				order: "post" as const,
				sequential: true,
				async handler() {
					pendingCloseBundleCount++
					while (closeBundlePromise) {
						await closeBundlePromise
					}
					let releaseLock: () => void = () => {}
					closeBundlePromise = new Promise<void>((resolve) => {
						releaseLock = resolve
					})
					try {
						if (hasActiveHooks()) {
							let waited = 0
							while (hasActiveHooks() && waited < 10000) {
								await new Promise((resolve) => setTimeout(resolve, 10))
								waited += 10
							}
						}
						printResults(statsMap, opts)
						statsMap.clear()
						if (devTimer) {
							clearTimeout(devTimer)
							devTimer = null
						}

						const selfContext = this as unknown as {
							environment?: { name?: string }
						}
						const currentEnvName = selfContext?.environment?.name
						if (currentEnvName) {
							activeBuildEnvironments.delete(currentEnvName)
						} else {
							activeBuildsCount = Math.max(0, activeBuildsCount - 1)
						}
						pendingCloseBundleCount--

						const hasMoreWork =
							pendingCloseBundleCount > 0 ||
							activeBuildEnvironments.size > 0 ||
							activeBuildsCount > 0 ||
							hasActiveHooks()

						if (!isWatchMode && !isDevMode && !hasMoreWork) {
							cleanup()
						}
					} finally {
						releaseLock()
						closeBundlePromise = null
					}
				},
			},
			{
				call(this: unknown, thisArg: unknown, ...args: unknown[]) {
					return (this as unknown as HookObject).handler.apply(thisArg, args)
				},
				apply(this: unknown, thisArg: unknown, args: unknown[]) {
					return (this as unknown as HookObject).handler.apply(
						thisArg,
						(args as unknown[]) ?? [],
					)
				},
			},
		),
	}
}

/**
 * Speed Measure Vite Plugin.
 *
 * Supports both:
 * 1. Standard plugin usage: `plugins: [vue(), smvp()]`
 * 2. Legacy wrapper usage: `plugins: smvp([vue()], options)`
 */
function speedMeasurePlugin(
	plugins: readonly PluginOption[] | PluginOption[] | PluginOption,
	options?: SpeedMeasureOptions,
): PluginOption[]
function speedMeasurePlugin(options?: SpeedMeasureOptions): Plugin
function speedMeasurePlugin(
	pluginsOrOptions?:
		| readonly PluginOption[]
		| PluginOption[]
		| PluginOption
		| SpeedMeasureOptions,
	maybeOptions?: SpeedMeasureOptions,
): Plugin | PluginOption[] {
	if (
		maybeOptions !== undefined ||
		Array.isArray(pluginsOrOptions) ||
		isPlugin(pluginsOrOptions) ||
		isPromise(pluginsOrOptions) ||
		pluginsOrOptions === false ||
		pluginsOrOptions === null
	) {
		const plugin = createMeasurePlugin(maybeOptions, true)

		if (isPromise(pluginsOrOptions)) {
			const wrappedPromise = (pluginsOrOptions as Promise<PluginOption>).then(
				(resolved) => {
					return plugin.wrapPluginsOption(resolved) as PluginOption
				},
			)
			return [wrappedPromise, plugin]
		}

		const rawPlugins = Array.isArray(pluginsOrOptions)
			? pluginsOrOptions
			: [pluginsOrOptions]
		const plugins = rawPlugins as PluginOption[]
		// Early wrap plugins passed in wrapper mode so config/configResolved can be measured
		const wrappedPlugins = plugin.wrapPluginsOption(plugins)
		const pluginList = Array.isArray(wrappedPlugins)
			? wrappedPlugins
			: [wrappedPlugins]
		return [...pluginList, plugin]
	}

	return createMeasurePlugin(
		pluginsOrOptions as SpeedMeasureOptions | undefined,
		false,
	)
}

// Attach named aliases to default export for maximum CJS/ESM interop
speedMeasurePlugin.default = speedMeasurePlugin
speedMeasurePlugin.smvp = speedMeasurePlugin
speedMeasurePlugin.printResults = printResults

export default speedMeasurePlugin
