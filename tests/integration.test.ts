import { describe, it, expect } from 'vitest'
import { build } from 'vite'
import smvp, { type MeasureReport } from '../src/main'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'

describe('vite build integration', () => {
  it('measures real vite build plugins', async () => {
    let capturedReport: MeasureReport | null = null

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'smvp-test-'))
    const entryFile = path.join(tmpDir, 'main.js')
    fs.writeFileSync(entryFile, 'console.log("hello vite")')

    try {
      await build({
        root: tmpDir,
        logLevel: 'silent',
        build: {
          write: false,
          lib: {
            entry: entryFile,
            formats: ['es'],
          },
        },
        plugins: [
          {
            name: 'my-custom-test-plugin',
            transform(code) {
              return code + '\n// custom transform'
            },
          },
          smvp({
            output: (report) => {
              capturedReport = report
            },
          }),
        ],
      })

      expect(capturedReport).not.toBeNull()
      expect(capturedReport!.plugins.length).toBeGreaterThan(0)

      const names = capturedReport!.plugins.map((p) => p.pluginName)
      // Custom plugin should be present
      expect(names).toContain('my-custom-test-plugin')

      // Vite's internal plugins (like vite:esbuild) should also be captured!
      const hasInternalPlugin = names.some((n) => n.startsWith('vite:'))
      expect(hasInternalPlugin).toBe(true)

      const customReport = capturedReport!.plugins.find(
        (p) => p.pluginName === 'my-custom-test-plugin'
      )
      expect(customReport).toBeDefined()
      expect(customReport!.hooks[0].calls).toBeGreaterThanOrEqual(1)
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('measures real vite build with legacy smvp wrapper usage', async () => {
    let capturedReport: MeasureReport | null = null

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'smvp-legacy-test-'))
    const entryFile = path.join(tmpDir, 'main.js')
    fs.writeFileSync(entryFile, 'console.log("hello legacy")')

    try {
      await build({
        root: tmpDir,
        logLevel: 'silent',
        build: {
          write: false,
          lib: {
            entry: entryFile,
            formats: ['es'],
          },
        },
        plugins: smvp(
          [
            {
              name: 'legacy-test-plugin',
              transform(code) {
                return code + '\n// legacy'
              },
            },
          ],
          {
            output: (report) => {
              capturedReport = report
            },
          }
        ),
      })

      expect(capturedReport).not.toBeNull()
      const names = capturedReport!.plugins.map((p) => p.pluginName)
      expect(names).toContain('legacy-test-plugin')
      expect(names.some((n) => n.startsWith('vite:'))).toBe(true)
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })
})
