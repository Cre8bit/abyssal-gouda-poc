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
  plugins: [localPeerServer()],
});

// Dev-only: start a local PeerJS signaling server alongside the dev server,
// so local multiplayer testing doesn't depend on the public PeerJS cloud.
// The client uses it automatically in dev (see src/network.js).
let peerServerStarted = false;
function localPeerServer() {
  return {
    name: 'local-peer-server',
    apply: 'serve',
    async configureServer() {
      if (peerServerStarted) return;
      try {
        const { PeerServer } = await import('peer');
        PeerServer({ port: 9001, path: '/abyssal' });
        peerServerStarted = true;
        console.log('  ➜  Local PeerJS signaling server: ws://localhost:9001/abyssal');
      } catch (err) {
        console.warn(
          '  ➜  Local PeerJS server not started (' +
            (err.code === 'ERR_MODULE_NOT_FOUND' ? 'run: npm install' : err.message) +
            ') — falling back to the public PeerJS cloud.',
        );
      }
    },
  };
}
