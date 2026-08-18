import { defineConfig } from 'vite';

export default defineConfig({
  // Relative base so the build works on GitHub Pages project sites
  // (https://<user>.github.io/<repo>/) without hardcoding the repo name.
  base: './',
  server: {
    host: true, // expose on LAN so other devices can join local dev games
  },
  build: {
    target: 'es2020',
  },
});
