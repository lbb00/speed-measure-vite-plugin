# speed-measure-vite-plugin

[English](README.md) | 简体中文

[![NPM](https://img.shields.io/npm/v/speed-measure-vite-plugin)](https://www.npmjs.com/package/speed-measure-vite-plugin)
[![NPM Downloads](https://img.shields.io/npm/dm/speed-measure-vite-plugin)](https://www.npmjs.com/package/speed-measure-vite-plugin)
[![License](https://img.shields.io/github/license/lbb00/speed-measure-vite-plugin.svg)](https://github.com/lbb00/speed-measure-vite-plugin/blob/master/LICENSE)

分析 Vite 插件的执行耗时与编译速度，相当于 Vite 版本的 `speed-measure-webpack-plugin`。

支持 Vite 3、4、5、6、7（包含 Vite 6+ Environment API），零运行时依赖。

![snapshot](https://raw.githubusercontent.com/lbb00/speed-measure-vite-plugin/master/docs/vite-build.png)

## 安装

```bash
npm i -D speed-measure-vite-plugin
# 或
pnpm add -D speed-measure-vite-plugin
```

## 使用方式

### 标准插件语法（v3 推荐）

直接将 `smvp()` 作为标准 Vite 插件加入 `plugins` 数组中：

```ts
// vite.config.ts
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import smvp from 'speed-measure-vite-plugin'

export default defineConfig({
  plugins: [
    vue(),
    smvp({
      // 配置项（可选）
    }),
  ],
})
```

### 包装器语法（兼容 v2 老写法）

完全向下兼容旧版本的 `smvp([vue()])` 包裹写法。如果需要测量 `config` 或 `configResolved` 等早期配置阶段的钩子，仍需使用该写法：

```ts
// vite.config.ts
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import smvp from 'speed-measure-vite-plugin'

export default defineConfig({
  plugins: smvp([vue()], {
    // 配置项（可选）
  }),
})
```

## 配置项

```ts
// 标准插件语法：smvp(options)
// 包装器语法兼容：smvp(plugins, options)
smvp({
  // 需要测量的 hook，默认为 ['transform']
  hooks: ['transform', 'resolveId', 'load'],

  // 排序规则，默认为按总耗时倒序
  sort: (a, b) => b - a,

  // 过滤耗时小于该数值（毫秒）的插件，默认为 0
  threshold: 5,

  // 开发模式下，最后一次编译完成后的防抖等待时间（毫秒），默认为 1000
  gapTime: 1000,

  // 自定义输出回调，默认为 'terminal' 控制台打印
  output: (report) => {
    console.log(`插件总耗时: ${report.allPluginsTotal}ms`)
  },

  // 是否禁用测量（如在 CI 中通过环境变量控制）
  disable: process.env.MEASURE === 'false',
})
```

| 配置项 | 类型 | 默认值 | 说明 |
| :--- | :--- | :--- | :--- |
| `hooks` | `string[]` | `['transform']` | 需要测量的 Vite / Rollup 钩子（如 `transform`、`resolveId`、`load` 等）。测量早期钩子（`config`、`configResolved`）需使用包装器语法。 |
| `sort` | `(a: number, b: number) => number` | `(a, b) => b - a` | 终端输出的排序比较函数。 |
| `threshold` | `number` | `0` | 最低耗时阈值（毫秒），低于该值的插件不会打印在控制台中。 |
| `gapTime` | `number` | `1000` | 开发模式下，等待请求空闲多长时间（毫秒）后输出耗时统计（别名：`maxGapTimeOnce`）。 |
| `output` | `'terminal' \| (report) => void` | `'terminal'` | 输出方式。可传入回调函数进行自定义日志上报或 CI 指标监控。 |
| `disable` | `boolean` | `false` | 是否停用测量。 |

## 说明

- **开发模式（Dev）**：由于 Vite 本地开发按需编译模块，耗时会在请求批次结束后防抖打印（由 `gapTime` 控制）。
- **构建模式（Build）**：统计全流程耗时，在 `closeBundle` 阶段统一输出汇总分析。
- **Environment API**：在 Vite 6+ 中，支持独立统计各环境（`client`、`ssr` 等）的插件耗时。

## 开源协议

[UNLICENSE](LICENSE)
