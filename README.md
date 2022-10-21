# speed-measure-vite-plugin

[![NPM](https://badgen.net/npm/v/speed-measure-vite-plugin)](https://www.npmjs.com/package/speed-measure-vite-plugin)
[![License](https://img.shields.io/github/license/lbb00/speed-measure-vite-plugin.svg)](https://github.com/lbb00/speed-measure-vite-plugin/blob/master/LICENSE)
[![NPM](https://img.shields.io/npm/dt/speed-measure-vite-plugin.svg)](https://www.npmjs.com/package/speed-measure-vite-plugin)

Measures your vite plugin transform speed.

![snapshot](https://github.com/lbb00/speed-measure-vite-plugin/blob/docs/snapshot.png)

## Usage

```javascript
// vite.config.js
import smvp from 'speed-measure-vite-plugin'

export default defineConfig({
  plugins: smvp([vue()]), // smvp(plugins,opts)
})
```

### Opts

- sort {function} Default `undefined`. Optional. Sort print by time, like array.sort
- maxTransformTimeOnce {number} Default `1000`. Optional. The max time to transform once, ms
