import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import smvp from '../src/main'

export default defineConfig({
  plugins: [
    vue(),
    smvp({
      hooks: ['transform', 'resolveId', 'load'],
      maxGapTimeOnce: 500,
    }),
  ],
})
