# speed-measure-vite-plugin

[![NPM](https://img.shields.io/npm/v/speed-measure-vite-plugin)](https://www.npmjs.com/package/speed-measure-vite-plugin)
[![NPM](https://img.shields.io/npm/dw/speed-measure-vite-plugin.svg)](https://www.npmjs.com/package/speed-measure-vite-plugin)
[![License](https://img.shields.io/github/license/lbb00/speed-measure-vite-plugin.svg)](https://github.com/lbb00/speed-measure-vite-plugin/blob/master/LICENSE)
[![Bundlephobia](https://img.shields.io/bundlephobia/minzip/speed-measure-vite-plugin)](https://bundlephobia.com/result?p=speed-measure-vite-plugin)
[![TypeScript](https://img.shields.io/badge/TypeScript-007ACC?style=flat&logo=typescript&logoColor=white)](https://github.com/lbb00/speed-measure-vite-plugin)

Measures your Vite plugins execution and transform speed. The lightweight Vite equivalent of `speed-measure-webpack-plugin`.

Supports **`vite >= v3`** (including Vite 3, 4, 5, 6, and Vite 6 Environment API). **Zero runtime dependencies**.

![snapshot](https://raw.githubusercontent.com/lbb00/speed-measure-vite-plugin/master/docs/vite-build.png)

## ✨ Features

- 🚀 **Standard Vite Plugin**: Simply add `smvp()` directly to your `plugins` array.
- 🔄 **100% Backwards Compatible**: Legacy `smvp([plugins])` wrapper syntax continues to work seamlessly.
- 🎯 **Full Plugin Coverage**: Intercepts 100% of plugins — your own plugins, framework plugins (e.g., `@dcloudio/vite-plugin-uni`, `@vitejs/plugin-vue`, `@vitejs/plugin-react`), and Vite internal plugins (`vite:css`, `vite:esbuild`, `vite:json`, etc.).
- ⚡️ **Zero Runtime Dependencies**: Pure TypeScript, minimal overhead.
- 🛡️ **Broad Compatibility**: Works with Vite 3, 4, 5, 6+ (including Vite 6 Environment API) and Rollup 2/3/4 hook formats (functions and `{ order, handler }` objects).
- ⏱️ **Debounced Dev Mode**: No CPU-hogging polling or timer leaks. Metrics flush cleanly after request batches or HMR.
- 📊 **Detailed Metrics**: Wall-clock parallel time, total time, and per-hook invocation call counts.
- 🎛️ **CI/CD Ready**: Supports `output` callback for programmatic performance tracking and benchmarking.

## 📦 Installation

```bash
# npm
npm i -D speed-measure-vite-plugin

# pnpm
pnpm add -D speed-measure-vite-plugin

# yarn
yarn add -D speed-measure-vite-plugin
```

## 🚀 Usage

### 1. Standard Plugin Usage (Recommended)

Just add `smvp()` to your Vite plugins list:

```typescript
// vite.config.ts
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import smvp from 'speed-measure-vite-plugin'

export default defineConfig({
  plugins: [
    vue(),
    smvp(), // 👈 Standard Vite plugin
  ],
})
```

### 2. Framework Usage (e.g. UniApp / Nuxt)

For frameworks like UniApp where builds run in headless CLI terminals:

```typescript
// vite.config.ts
import { defineConfig } from 'vite'
import uni from '@dcloudio/vite-plugin-uni'
import smvp from 'speed-measure-vite-plugin'

export default defineConfig({
  plugins: [
    uni(),
    smvp({
      // Filter out microsecond plugins to keep terminal output clean
      threshold: 5,
    }),
  ],
})
```

### 3. Legacy Wrapper Usage (Backwards Compatible)

Existing configurations using the v2 wrapper syntax continue to work without changes:

```typescript
// vite.config.ts
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import smvp from 'speed-measure-vite-plugin'

export default defineConfig({
  plugins: smvp([vue()]), // smvp(plugins, options)
})
```

## ⚙️ Options

```typescript
smvp({
  // Hooks to measure. Defaults to ['transform']
  hooks: ['transform', 'resolveId', 'load'],

  // Sort function for output display. Defaults to descending by time
  sort: (a, b) => b - a,

  // Minimum total duration (ms) for a plugin to be displayed. Defaults to 0
  // Useful for filtering out trivial plugins in large projects
  threshold: 5,

  // Idle gap time before flushing metrics in dev mode (ms). Defaults to 1000
  gapTime: 1000, // or maxGapTimeOnce

  // Custom report handler (defaults to 'terminal')
  // Ideal for CI/CD benchmarks or custom logging
  output: (report) => {
    console.log(`Total plugin time: ${report.allPluginsTotal}ms`)
  },

  // Toggle measuring on/off (e.g. via environment variable)
  disable: process.env.MEASURE === 'false',
})
```

### Options Reference

| Option | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `hooks` | `(keyof Plugin \| string)[]` | `['transform']` | List of Vite/Rollup hooks to measure (e.g. `transform`, `resolveId`, `load`). Early lifecycle hooks (`config`, `configResolved`) require wrapper mode syntax `plugins: smvp([...], { hooks: [...] })`. |
| `sort` | `(a: number, b: number) => number` | `(a, b) => b - a` | Sort comparator for ranking plugins in terminal output. |
| `threshold` | `number` | `0` | Minimum execution time (in ms) required for a plugin to appear in the report. |
| `gapTime` / `maxGapTimeOnce` | `number` | `1000` | In dev mode, debounce duration (in ms) after the last hook execution before printing results. |
| `output` | `'terminal' \| ((report: MeasureReport) => void)` | `'terminal'` | Output destination. Pass a callback function to handle metrics programmatically. |
| `disable` | `boolean` | `false` | When `true`, bypasses all hook wrapping and measurements. |

## 🔬 How It Works

1. **`configResolved` Hook**: Captures the fully resolved Vite plugin pipeline, including framework-injected plugins and Vite's internal plugins (`vite:css`, `vite:esbuild`, etc.).
2. **Robust Hook Interception**: Seamlessly handles both function-based hooks (`transform(code, id)`) and object-based hooks (`{ order: 'pre', handler }`).
3. **Multi-Environment Support**: Fully compatible with Vite 6's Environment API (`config.environments`), tracking plugins across `client`, `ssr`, and custom runtimes.
4. **Dev & Build Life Cycles**:
   - **Build Mode**: Gathers hook timings across the entire build and outputs an aggregated terminal report on `closeBundle`.
   - **Dev Mode**: Uses an idle debounce timer after on-demand module transformations, outputting a consolidated batch report without infinite polling loops.

## 📄 License

[UNLICENSE](LICENSE)
