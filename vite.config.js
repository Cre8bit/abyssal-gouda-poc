import { defineConfig } from "vite";

export default defineConfig({
  // Relative base so the build works on GitHub Pages project sites
  // (https://<user>.github.io/<repo>/) without hardcoding the repo name.
  base: "./",
  server: {
    host: true, // expose on LAN so other devices can join local dev games
  },
  build: {
    target: "es2020",
  },
  plugins: [localPeerServer()],
});

// Dev-only: start a local PeerJS signaling server alongside the dev server,
// so local multiplayer testing doesn't depend on the public PeerJS cloud.
// The client uses it automatically in dev (see src/network.js).
let peerServerInstance = null;
function localPeerServer() {
  return {
    name: "local-peer-server",
    apply: "serve",
    async configureServer(server) {
      if (peerServerInstance) return;
      try {
        const { PeerServer } = await import("peer");
        const peerServer = PeerServer({ port: 9004, path: "/abyssal" });
        // Without this, a bind failure (e.g. EADDRINUSE from a stale
        // process left over by a previous crashed/killed dev server) is an
        // unhandled 'error' event that throws and crashes the whole Vite
        // process — not just the peer server.
        peerServer.on("error", (err) => {
          peerServerInstance = null;
          console.warn(
            "  ➜  Local PeerJS server error (" +
              (err.code === "EADDRINUSE"
                ? "port 9004 already in use — is another `npm run dev` still running?"
                : err.message) +
              ") — falling back to the public PeerJS cloud.",
          );
        });
        peerServerInstance = peerServer;
        console.log(
          "  ➜  Local PeerJS signaling server: ws://localhost:9004/abyssal",
        );
        // Release the port on dev server shutdown/restart so it doesn't
        // linger as a zombie process blocking the next `npm run dev`.
        server.httpServer?.once("close", () => {
          peerServerInstance?.close();
          peerServerInstance = null;
        });
      } catch (err) {
        console.warn(
          "  ➜  Local PeerJS server not started (" +
            (err.code === "ERR_MODULE_NOT_FOUND"
              ? "run: npm install"
              : err.message) +
            ") — falling back to the public PeerJS cloud.",
        );
      }
    },
  };
}
