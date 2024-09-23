import { defineConfig } from 'vite'
import dts from 'vite-plugin-dts'
import { copyFileSync } from 'node:fs'

export default defineConfig({
  root: '.',
  mode: 'production',
  build: {
    target: 'esnext',
    outDir: './dist',
    minify: false,
    lib: {
      entry: './src/main.ts',
      formats: ['es', 'cjs'],
      fileName: 'main',
    },
  },
  plugins: [
    dts({
      logLevel: 'warn',
      rollupTypes: true,
      include: ['src'],
      afterBuild: () => {
        copyFileSync('dist/main.d.ts', 'dist/main.d.mts')
      },
    }),
  ],
})
