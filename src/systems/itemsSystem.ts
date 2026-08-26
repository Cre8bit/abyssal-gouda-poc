// systems/itemsSystem.ts — drives the item registry (items.ts) each frame
// and consumes its replication events. Runs LAST (order 40) so item behavior
// sees this frame's statuses and fish state.
import { updateItems, clearItems, applyItemEvent } from "../game/items.ts";
import type { GameSystem } from "./types.ts";

export function createItemsSystem(): GameSystem {
  return {
    id: "items",
    order: 40,
    events: ["item+", "item-", "item*"],
    update(ctx) {
      updateItems(ctx);
    },
    onEvent(_fromPeerId, kind, data) {
      applyItemEvent(kind, data);
    },
    reset() {
      clearItems();
    },
  };
}
