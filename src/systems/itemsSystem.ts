// systems/itemsSystem.ts — drives the item registry (items.ts) each frame
// and consumes its replication events. Runs LAST (order 40) so item behavior
// sees this frame's statuses and fish state.
import {
  updateItems,
  clearItems,
  applyItemEvent,
  sendItemSnapshotTo,
} from "../game/items.ts";
import type { GameSystem } from "./types.ts";

export function createItemsSystem(): GameSystem {
  return {
    id: "items",
    order: 40,
    events: ["item+", "item-", "item*", "items?"],
    update(ctx) {
      updateItems(ctx);
    },
    onEvent(fromPeerId, kind, data) {
      // "items?" asks for snapshot; peer rebuilt world.
      if (kind === "items?") sendItemSnapshotTo(fromPeerId);
      else applyItemEvent(kind, data);
    },
    reset() {
      clearItems();
    },
  };
}
