// systems/registry.ts — deterministic, order-sorted system execution.
//
// main.ts registers systems once at boot, then drives them with ONE
// updateSystems() call per frame. Adding a mechanic = writing a system
// module + one registerSystem() line — not weaving new blocks through the
// render loop, the event switch, and the disconnect handler by hand.
import type { FrameContext, GameSystem } from "./types.ts";

const systems: GameSystem[] = [];

export function registerSystem<T extends GameSystem>(sys: T): T {
  if (systems.some((s) => s.id === sys.id)) {
    throw new Error(`system "${sys.id}" registered twice`);
  }
  systems.push(sys);
  systems.sort((a, b) => a.order - b.order);
  sys.init?.();
  return sys;
}

export function updateSystems(ctx: FrameContext): void {
  for (const sys of systems) sys.update(ctx);
}

// Route event to system that declared its kind; return true if handled.
export function dispatchSystemEvent(
  fromPeerId: string,
  kind: string,
  data: Record<string, unknown>,
): boolean {
  let handled = false;
  for (const sys of systems) {
    if (sys.onEvent && sys.events?.includes(kind)) {
      sys.onEvent(fromPeerId, kind, data);
      handled = true;
    }
  }
  return handled;
}

export function notifySystemsPeerDisconnected(peerId: string): void {
  for (const sys of systems) sys.onPeerDisconnected?.(peerId);
}

export function resetSystems(): void {
  for (const sys of systems) sys.reset?.();
}

export function disposeSystems(): void {
  for (const sys of systems) sys.dispose?.();
  systems.length = 0;
}
