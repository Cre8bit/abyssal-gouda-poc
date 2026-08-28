import { defineConfig, type Plugin, type ViteDevServer } from "vite";
import { fileURLToPath } from "node:url";

export default defineConfig({
  // Relative base so the build works on GitHub Pages project sites
  // (https://<user>.github.io/<repo>/) without hardcoding the repo name.
  base: "./",
  server: {
    host: true, // expose on LAN so other devices can join local dev games
  },
  build: {
    target: "es2020",
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL("./index.html", import.meta.url)),
        // Model/animation bench (src/bench/preview.ts) — ships with the
        // build so the deployed site exposes it at /preview.html too.
        preview: fileURLToPath(new URL("./preview.html", import.meta.url)),
        // Worldgen bench (src/bench/worldgen.ts) — the cheese kit (M2).
        worldgen: fileURLToPath(new URL("./worldgen.html", import.meta.url)),
      },
    },
  },
  plugins: [localPeerServer()],
});

// Dev-only: start a local PeerJS signaling server alongside the dev server,
// so local multiplayer testing doesn't depend on the public PeerJS cloud.
// The client uses it automatically in dev (see src/net/mesh.ts).
// (The `peer` package ships no types — the shape we rely on is tiny.)
interface StoppablePeerServer {
  close(): void;
  on(event: "error", cb: (err: NodeJS.ErrnoException) => void): void;
}
let peerServerInstance: StoppablePeerServer | null = null;
function localPeerServer(): Plugin {
  return {
    name: "local-peer-server",
    apply: "serve",
    async configureServer(server: ViteDevServer) {
      if (peerServerInstance) return;
      try {
        const { PeerServer } = await import("peer");
        const peerServer = PeerServer({
          port: 9004,
          path: "/abyssal",
        }) as unknown as StoppablePeerServer;
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
        const e = err as NodeJS.ErrnoException;
        console.warn(
          "  ➜  Local PeerJS server not started (" +
            (e.code === "ERR_MODULE_NOT_FOUND"
              ? "run: npm install"
              : e.message) +
            ") — falling back to the public PeerJS cloud.",
        );
      }
    },
  };
}
