// systems/oxygenSystem.ts — O₂ drain/refill per frame, HUD bar sync.
// Feeds frame conditions (sprinting, status, refill zone distance) to the
// survival math in oxygen.ts and syncs result to the HUD bar.
import { updateOxygen, refillOxygen, isDead } from "../game/oxygen.ts";
import { getLocalStatus } from "../game/effects.ts";
import { isSprinting } from "../input/input.ts";
import type { GameSystem } from "./types.ts";

const RECHARGE_RADIUS = 16;

export interface OxygenHudElements {
  o2Fill: HTMLElement;
  o2Bar: HTMLElement;
}

export function createOxygenSystem({
  o2Fill,
  o2Bar,
}: OxygenHudElements): GameSystem {
  return {
    id: "oxygen",
    order: 20,
    update({ dt, game }) {
      const p = game.localPosition;
      const s = game.spawnPoint;
      const distToSpawn = Math.hypot(p.x - s.x, p.y - s.y, p.z - s.z);
      const inRefillZone = distToSpawn < RECHARGE_RADIUS;
      const frac = updateOxygen(dt, {
        sprinting: isSprinting(),
        status: getLocalStatus(),
        inRefillZone,
      });
      o2Fill.style.width = `${Math.round(frac * 100)}%`;
      o2Bar.classList.toggle("low", frac < 0.25 && !isDead());
      o2Bar.classList.toggle("refilling", inRefillZone && frac < 1);
    },
    reset() {
      refillOxygen();
    },
  };
}
