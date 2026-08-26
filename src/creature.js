// creature.js — the thing out there. It patrols slowly on its own noise track,
// never attacks, and has no body: what it is for is being HEARD and not placed.
//
// It used to be drawn — a 78 m silhouette gliding past in the dark — and that
// was the mistake. Seen, it was plainly inert, and being spawned per player it
// was never even the same animal in two windows. Unseen, the moan it carries is
// the whole effect. Pure state, no renderer, no network.
const PATROL_RADIUS = 150; // how far from the bell it roams
const SPEED = 4.5;

export function createRoamer() {
  const position = { x: 0, y: 0, z: 0 };
  const centre = { x: 0, y: 0, z: 0 };
  let heading = 0;
  const seed = Math.random() * 100;

  // Called each time the bell settles at a new depth.
  function spawn(at) {
    centre.x = at.x;
    centre.y = at.y;
    centre.z = at.z;
    const a = Math.random() * Math.PI * 2;
    const d = PATROL_RADIUS * (0.5 + Math.random() * 0.5);
    position.x = at.x + Math.cos(a) * d;
    position.y = at.y + (Math.random() - 0.5) * 60;
    position.z = at.z + Math.sin(a) * d;
    heading = Math.random() * Math.PI * 2;
  }

  function update(delta, elapsed, noise) {
    // Wander, but lean back toward the patrol centre so it never leaves for good.
    heading += noise.noise(elapsed * 0.07, seed, 0) * 0.5 * delta;
    const away = Math.hypot(position.x - centre.x, position.y - centre.y, position.z - centre.z);
    if (away > PATROL_RADIUS) {
      const home = Math.atan2(centre.z - position.z, centre.x - position.x);
      heading += angleTo(heading, home) * 0.6 * delta;
    }
    const climb = noise.noise(0, elapsed * 0.05, seed) * 0.35;
    position.x += Math.cos(heading) * SPEED * delta;
    position.y += climb * SPEED * delta;
    position.z += Math.sin(heading) * SPEED * delta;
  }

  return { spawn, update, position };
}

// Shortest signed turn from a to b.
function angleTo(a, b) {
  return Math.atan2(Math.sin(b - a), Math.cos(b - a));
}
