import { defineConfig } from 'vite';

export default defineConfig({
  // Relative base so the build works on GitHub Pages project sites
  // (https://<user>.github.io/<repo>/) without hardcoding the repo name.
  base: './',
  build: {
    target: 'es2020',
  },
});
