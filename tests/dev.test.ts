import { describe, it, expect } from 'vitest'
import { createServer } from 'vite'
import smvp, { type MeasureReport } from '../src/main'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'

describe('vite dev server integration', () => {
  it('measures plugin transform in real vite dev server during transformRequest', async () => {
    let capturedReport: MeasureReport | null = null

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'smvp-dev-test-'))
    const entryFile = path.join(tmpDir, 'main.js')
    fs.writeFileSync(entryFile, 'export const message = "dev server test";')

    try {
      const server = await createServer({
        root: tmpDir,
        logLevel: 'silent',
        server: {
          port: 0,
        },
        plugins: [
          {
            name: 'dev-custom-transformer',
            transform(code, id) {
              if (id.includes('main.js')) {
                return code + '\n// dev transformed'
              }
            },
          },
          smvp({
            gapTime: 100, // fast debounce for test
            output: (report) => {
              capturedReport = report
            },
          }),
        ],
      })

      // Simulate client requesting main.js
      const transformed = await server.transformRequest('/main.js')
      expect(transformed).not.toBeNull()
      expect(transformed!.code).toContain('// dev transformed')

      // Wait for debounce flush (100ms gapTime + buffer)
      await new Promise((r) => setTimeout(r, 200))

      expect(capturedReport).not.toBeNull()
      const names = capturedReport!.plugins.map((p) => p.pluginName)
      expect(names).toContain('dev-custom-transformer')

      const customReport = capturedReport!.plugins.find(
        (p) => p.pluginName === 'dev-custom-transformer'
      )
      expect(customReport).toBeDefined()
      expect(customReport!.hooks[0].calls).toBeGreaterThanOrEqual(1)

      await server.close()
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })
})
