// verifyWorker.ts — the route verifier off the bench's main thread (WG-14).
// verify.ts is a pure data module (no DOM, no GL), so it runs in a module
// worker as-is; a full verifyWorld pass is seconds of solid search, and the
// bench stays interactive while it runs. One request per worker: the bench
// terminates and respawns to cancel a run a newer rebuild superseded.
import { verifyWorld, type VerifyResult } from "../world/verify.ts";
import type { WorldRecipe } from "../world/recipes.ts";

export interface VerifyRequest {
  token: number; // stamps the request; the bench drops mismatched replies
  seed: number;
  difficulty: number;
  world: WorldRecipe;
}

export interface VerifyReply {
  token: number;
  result?: VerifyResult;
  error?: string;
}

const ctx = self as unknown as {
  onmessage: ((e: MessageEvent<VerifyRequest>) => void) | null;
  postMessage(msg: VerifyReply): void;
};

ctx.onmessage = (e) => {
  const { token, seed, difficulty, world } = e.data;
  try {
    ctx.postMessage({ token, result: verifyWorld(seed, difficulty, world) });
  } catch (err) {
    ctx.postMessage({ token, error: (err as Error).message });
  }
};
