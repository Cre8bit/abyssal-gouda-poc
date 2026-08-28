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
  now: number;
  game: GameState;
  connected: boolean; // any open mesh link this frame
}

export interface GameSystem {
  id: string;
  // Lower runs first; registry sorts by this (see main.ts)
  order: number;
  // Network event kinds this system consumes (registry routes matching events)
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
  reset?(): void;
  dispose?(): void;
}
