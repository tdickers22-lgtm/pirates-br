// A cave census must stand inside the sloping passage it claims to measure.
import assert from 'node:assert/strict';
import { MapGenerator } from '../src/server/world/MapGenerator.ts';
import { getCaveInteriorAt } from '../src/shared/utils/index.ts';
import { planScenes, readWorld } from './perf-probe.mjs';

const islands = new MapGenerator(20260801).generateIslands();
globalThis.window = { __piratesBR: { state: { islands, ships: [] } } };
try {
  const world = await readWorld({ evaluate: (read) => read() });
  for (const island of world.islands.filter((i) => i.caves.length)) {
    const stand = planScenes({ ...world, islands: [island] })['cave-interior'];
    const source = islands.find((i) => i.id === island.id);
    const interior = getCaveInteriorAt(source, stand.x, stand.z);
    assert.ok(interior, `${island.name}: probe must be over a cave floor`);
    assert.ok(stand.y > interior.floorY && stand.y < interior.ceilingY,
      `${island.name}: camera y=${stand.y} outside cave ${interior.floorY}..${interior.ceilingY}`);
    assert.ok(Math.abs(stand.y - interior.floorY - 1.55) < 0.02,
      `${island.name}: camera must follow the ramp at eye height`);
    console.log(`✓ ${island.name}: cave camera inside the passage at eye height`);
  }
} finally {
  delete globalThis.window;
}
