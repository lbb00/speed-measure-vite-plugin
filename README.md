# speed-measure-vite-plugin

[![NPM](https://img.shields.io/npm/v/speed-measure-vite-plugin)](https://www.npmjs.com/package/speed-measure-vite-plugin)
[![NPM](https://img.shields.io/npm/dw/speed-measure-vite-plugin.svg)](https://www.npmjs.com/package/speed-measure-vite-plugin)
[![License](https://img.shields.io/github/license/lbb00/speed-measure-vite-plugin.svg)](https://github.com/lbb00/speed-measure-vite-plugin/blob/master/LICENSE)
[![Bundlephobia](https://img.shields.io/bundlephobia/minzip/speed-measure-vite-plugin)](https://bundlephobia.com/result?p=speed-measure-vite-plugin)

Measures your vite plugins transform speed.

![snapshot](https://raw.githubusercontent.com/lbb00/speed-measure-vite-plugin/master/docs/vite-build.png)

## Usage

```javascript
// vite.config.js
import smvp from 'speed-measure-vite-plugin'

export default defineConfig({
  plugins: smvp([vue()]), // smvp(plugins, opts)
})
```

### Opts

- sort {function} Default `undefined`. Optional. Sort print by time, like array.sort
- maxTransformTimeOnce {number} Default `1000`. Optional, ms. Since Vite doesn't provide direct access to lifecycle hooks for pages or the completion of hot updates in development mode, an approximate indication of the transform process completion can be determined using a delay-based approach.
