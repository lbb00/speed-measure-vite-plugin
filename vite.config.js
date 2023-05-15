import { defineConfig } from 'vite'

export default defineConfig({
  root: '.',
  mode: 'production',
  build: {
    target: 'esnext',
    outDir: './dist',
    minify: 'false',
    lib: {
      entry: './src/main.js',
      formats: ['es', 'cjs'],
      fileName: 'main',
    },
  },
})
