// Dev tool: dump story-scene placements (position, terrain y, yaw) per island.
import { MapGenerator } from '../src/server/world/MapGenerator.ts';
import { getIslandSurfaceY } from '../src/shared/utils/index.ts';
const STORY = new Set(['smuggler_cache','skull_totem','wrecker_tower','whale_skeleton','rum_still','crow_roost','mermaid_shrine','castaway_camp','kraken_wreck','dig_site','gallows','parley_table','mine_head','widow_memorial','gibbet_cage']);
const gen = new MapGenerator(20260713);
const islands = gen.generateIslands();
for (const isl of islands) {
  for (const p of isl.props ?? []) {
    if (!STORY.has(p.type)) continue;
    const y = getIslandSurfaceY(isl, p.x, p.z);
    const dx = p.x - isl.position.x, dz = p.z - isl.position.z;
    const d = Math.hypot(dx, dz).toFixed(0);
    console.log(`${isl.name.padEnd(18)} ${p.type.padEnd(16)} world(${p.x.toFixed(0)},${p.z.toFixed(0)}) y=${y.toFixed(2)} dCenter=${d} yaw=${p.yaw.toFixed(2)}`);
  }
}
