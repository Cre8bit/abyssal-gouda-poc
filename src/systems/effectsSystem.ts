// systems/effectsSystem.ts — expires timed status effects each frame.
//
// Runs FIRST (order 10): oxygen drain and (future) movement modifiers read
// the local status mask, so it must be current before anything else ticks.
import { updateEffects, resetEffects } from "../game/effects.ts";
import type { GameSystem } from "./types.ts";

export function createEffectsSystem(): GameSystem {
  return {
    id: "effects",
    order: 10,
    update() {
      updateEffects();
    },
    reset() {
      resetEffects();
    },
  };
}
