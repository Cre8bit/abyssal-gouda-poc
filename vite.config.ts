import { defineConfig, type Plugin, type ViteDevServer } from "vite";
import { fileURLToPath } from "node:url";
import { networkInterfaces } from "node:os";

// The local signaling server listens on loopback only; browsers reach it
// through the Vite dev server (see SIGNALING_PATH below), so a joiner only
// ever has to reach ONE port — the one already in the invite link.
const SIGNALING_PORT = 9004;
const SIGNALING_PATH = "/abyssal";

// LAN exposure is OPT-IN: `LAN=1 npm run dev`. Bound to loopback by default
// because a dev server on 0.0.0.0 serves the whole project root — every
// source file, and any secret that ever lands in the tree — to anyone on the
// same wifi, which on a café or office network is not a trade worth making
// silently. Turn it on for the sessions where you genuinely need a second
// device; Vite prints the Network URL when you do.
const LAN_EXPOSED =
  !!process.env.LAN && !["0", "false"].includes(process.env.LAN);

export default defineConfig({
  // Relative base so the build works on GitHub Pages project sites
  // (https://<user>.github.io/<repo>/) without hardcoding the repo name.
  base: "./",
  server: {
    host: LAN_EXPOSED, // other devices can join local dev games (LAN=1)
    // Signaling rides the dev server's own origin (same host, same port,
    // and wss:// automatically behind an https tunnel). Vite's proxy only
    // claims upgrades on this path — HMR's own socket is untouched.
    proxy: {
      [SIGNALING_PATH]: {
        target: `http://127.0.0.1:${SIGNALING_PORT}`,
        ws: true,
      },
    },
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
  plugins: [lanHost(), localPeerServer()],
});

// The first non-internal IPv4 address of this machine, or "" if there is
// none (offline).
function lanIPv4(): string {
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === "IPv4" && !a.internal) return a.address;
    }
  }
  return "";
}

// `virtual:lan-host` exposes that address to the client, so a host browsing
// on http://localhost:5173 still hands out an invite link OTHER DEVICES can
// open — "localhost" in a shared link points at the joiner's own machine.
// A virtual module rather than `define`: Vite 7 does not apply defines to
// client code in dev, which is the only place this matters. Empty in a
// production build (the deployed site has a real origin, and a dev
// machine's LAN address has no business in a public bundle).
// It also stays empty unless the dev server is actually BOUND to the LAN —
// otherwise the invite link would advertise an address where nothing is
// listening, which is a worse failure than handing out "localhost".
const LAN_HOST_ID = "virtual:lan-host";
function lanHost(): Plugin {
  let serving = false;
  return {
    name: "lan-host",
    configResolved: (cfg) => void (serving = cfg.command === "serve"),
    resolveId: (id) => (id === LAN_HOST_ID ? `\0${LAN_HOST_ID}` : null),
    load: (id) =>
      id === `\0${LAN_HOST_ID}`
        ? `export const LAN_HOST = ${JSON.stringify(
            serving && LAN_EXPOSED ? lanIPv4() : "",
          )};`
        : null,
  };
}

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
          port: SIGNALING_PORT,
          // Loopback only: nothing to open in a firewall, nothing exposed
          // to the LAN beyond the dev server itself.
          host: "127.0.0.1",
          path: SIGNALING_PATH,
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
          `  ➜  Local PeerJS signaling server: proxied at ${SIGNALING_PATH} (same port as this dev server)`,
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
