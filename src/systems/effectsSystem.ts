// Expires timed status effects each frame (order 10).
// Must run first: oxygen & movement modifiers depend on current status mask.
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
