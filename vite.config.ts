import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import wasm from 'vite-plugin-wasm'
import topLevelAwait from 'vite-plugin-top-level-await'
import dts from 'vite-plugin-dts'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    wasm(),
    topLevelAwait(),
    dts({
      outDir: 'dist',
      include: ['src'],
      entryRoot: 'src',
    }),
  ],
  build: {
    lib: {
      formats: ['es'],
      name: 'loro-slate',
      entry: 'src/index.ts',
    },
    sourcemap: true,
    rollupOptions: {
      external: [
        'loro-crdt',
        'slate',
        'slate-react',
        'react',
        'react/jsx-runtime',
        'react-dom',
      ],
    },
  },
})
