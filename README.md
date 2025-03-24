# speed-measure-vite-plugin

[![NPM](https://img.shields.io/npm/v/speed-measure-vite-plugin)](https://www.npmjs.com/package/speed-measure-vite-plugin)
[![NPM](https://img.shields.io/npm/dw/speed-measure-vite-plugin.svg)](https://www.npmjs.com/package/speed-measure-vite-plugin)
[![License](https://img.shields.io/github/license/lbb00/speed-measure-vite-plugin.svg)](https://github.com/lbb00/speed-measure-vite-plugin/blob/master/LICENSE)
[![Bundlephobia](https://img.shields.io/bundlephobia/minzip/speed-measure-vite-plugin)](https://bundlephobia.com/result?p=speed-measure-vite-plugin)
[![TypeScript](https://img.shields.io/badge/TypeScript-007ACC?style=flat&logo=typescript&logoColor=white)](https://github.com/lbb00/speed-measure-vite-plugin)

Measures your vite plugins transform speed. Support `vite >= v3`.

![snapshot](https://raw.githubusercontent.com/lbb00/speed-measure-vite-plugin/master/docs/vite-build.png)

## Usage

```javascript
// vite.config.js
import smvp from 'speed-measure-vite-plugin'

export default defineConfig({
  plugins: smvp([vue()]), // smvp(plugins, opts)
})
```

## Options

```javascript
smvp(plugins, {
  // Hooks to measure, defaults to ['transform']
  hooks: ['transform', 'resolveId', 'load'],

  // Sort function for output display, defaults to undefined
  // Example: sort by time in descending order
  sort: (a, b) => b - a,

  // Maximum gap time to consider hook process complete (in ms)
  // Used to detect when a hook batch is finished in dev mode
  maxGapTimeOnce: 1000,

  // maxTransformTimeOnce is deprecated, use maxGapTimeOnce instead
})
```

## How it works

This plugin wraps your Vite plugins and measures the execution time of specified hooks. Since Vite doesn't provide direct access to lifecycle hooks for pages or the completion of hot updates in development mode, an approximate indication of the hook process completion is determined using a gap-based approach.
