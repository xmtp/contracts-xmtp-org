import { defineConfig } from 'vite'

export default defineConfig(({ command }) => ({
  // In dev mode, prevent index.html from being processed as a JS module when
  // Vite builds its module graph. Without this, vite:import-analysis tries to
  // parse the HTML as JS and errors. The HTML serving middleware is unaffected.
  // Scoped to dev only — during build, index.html must remain the entry point.
  assetsInclude: command === 'serve' ? ['**/*.html'] : [],
  build: {
    outDir: 'dist',
  },
  server: {
    // Proxy API calls to the Vercel dev server so the full stack works locally.
    // Run `vercel dev` (port 3000) alongside `yarn dev`, or just use `vercel dev` alone.
    proxy: {
      '/api': 'http://localhost:3000',
    },
  },
}))
