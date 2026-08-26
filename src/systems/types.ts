// systems/types.ts — the contract every game system implements.
//
// A system is a self-contained slice of the game loop (oxygen, catfish,
// items…) that main.ts used to run as an inline block. Systems never import
// main.ts: everything frame-dependent arrives through FrameContext, and
// anything UI-ish (toasts, sounds) is injected at construction — so systems
// stay testable and main.ts stays an orchestrator, not a god-object.
import type { GameState } from "../state.ts";

export interface FrameContext {
  dt: number; // seconds since last frame (clamped upstream)
  now: number; // performance.now() at frame start, ms
  game: GameState;
  connected: boolean; // any open mesh link this frame
}

export interface GameSystem {
  id: string;
  // Lower runs first. The registry sorts by this — execution order is
  // explicit and deterministic, never registration-order luck. Current
  // lineup: effects 10 → oxygen 20 → catfish 30 → items 40, all running in
  // the loop's "systems" slot (after input smoothing, before physics —
  // see main.ts).
  order: number;
  // Network event kinds this system consumes (e.g. ["fish"]). The registry
  // routes matching events here and tells main.ts they were handled.
  events?: readonly string[];

  init?(): void;
  update(ctx: FrameContext): void;
  onEvent?(
    fromPeerId: string,
    kind: string,
    data: Record<string, unknown>,
  ): void;
  // A mesh link died — authority elections and per-peer cleanup live here.
  onPeerDisconnected?(peerId: string): void;
  // resetGameState(): drop anything a fresh world must not inherit.
  reset?(): void;
  dispose?(): void;
}
