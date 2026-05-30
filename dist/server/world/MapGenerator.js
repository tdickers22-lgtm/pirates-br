import { v4 as uuid } from 'uuid';
import { WORLD, SHIP_STATS, CHEST_LOOT_TABLE, BARREL_LOOT_TABLE, ECONOMY, WILDLIFE, SEA_ROCKS } from '../../shared/constants/index.js';
import { directionToYaw, buildSeaRockColliders, getIslandMaxRadius, getIslandSurfacePoint, randRange, randAngle, weightedRandom, randInt, } from '../../shared/utils/index.js';
const SHIP_TYPES = ['sloop', 'brigantine', 'galleon'];
const ISLAND_NAMES = [
    "Smuggler's Rest",
    'Skull Cove',
    'The Crooked Atoll',
    'Dead Man Shoals',
    'Rumrunner Key',
    'Crow\'s Perch',
    'Mermaid\'s Folly',
    'Castaway Reach',
    'Kraken Tooth',
    'Booty Bay',
    'Gallows Sands',
    'Parley Point',
];
export class MapGenerator {
    generateIslands() {
        const islands = [];
        const minDist = 145;
        const attempts = 320;
        for (let i = 0; i < WORLD.ISLAND_COUNT; i++) {
            const radius = i % 5 === 0
                ? randRange(86, 118)
                : i % 3 === 0
                    ? randRange(58, 100)
                    : randRange(34, 82);
            let pos = null;
            for (let a = 0; a < attempts; a++) {
                const candidate = {
                    x: randRange(-800, 800),
                    y: 0,
                    z: randRange(-800, 800),
                };
                let ok = true;
                for (const existing of islands) {
                    const dx = candidate.x - existing.position.x;
                    const dz = candidate.z - existing.position.z;
                    const requiredGap = Math.max(minDist, radius + existing.radius + 46);
                    if (Math.sqrt(dx * dx + dz * dz) < requiredGap) {
                        ok = false;
                        break;
                    }
                }
                if (ok) {
                    pos = candidate;
                    break;
                }
            }
            if (!pos)
                continue;
            const island = {
                id: uuid(),
                name: ISLAND_NAMES[islands.length % ISLAND_NAMES.length],
                position: pos,
                radius,
                profile: this.generateIslandProfile(radius, islands.length),
                dock: null,
                tavern: null,
                caves: [],
                chests: [],
                barrels: [],
                upgradeStations: [],
                npcs: [],
            };
            island.dock = this.generateDock(island);
            island.chests = this.generateChests(island);
            island.barrels = this.generateBarrels(island);
            island.upgradeStations = this.generateUpgradeStations(island);
            island.caves = this.generateCaves(island, islands.length);
            island.tavern = this.generateTavern(island, islands.length);
            island.npcs = this.generateStoryNpcs(island, islands.length);
            islands.push(island);
        }
        return islands;
    }
    generateIslandProfile(radius, islandIndex) {
        const islandHeading = randAngle();
        const ridgeAxis = islandHeading + randRange(-0.48, 0.48);
        // Distribution: more variety, including multi-peak styles
        const styles = [
            'tropical', 'tropical',
            'mountain', 'mountain', 'mountain',
            'plateau', 'plateau',
            'rocky', 'rocky',
            'twin', 'twin',
            'archipelago',
        ];
        let terrainStyle = styles[(islandIndex + Math.floor(Math.random() * 3)) % styles.length];
        if (radius > 96) {
            const largeStyles = ['mountain', 'plateau', 'twin'];
            terrainStyle = largeStyles[(islandIndex + Math.floor(Math.random() * largeStyles.length)) % largeStyles.length];
        }
        else if (radius < 46) {
            const smallStyles = ['tropical', 'rocky', 'archipelago'];
            terrainStyle = smallStyles[(islandIndex + Math.floor(Math.random() * smallStyles.length)) % smallStyles.length];
        }
        let heightProfile = randRange(0.2, 0.48);
        let mesaBias = randRange(0.15, 1);
        let secondaryHillScale = randRange(0.28, 0.72);
        let tertiaryHillScale = Math.random() > 0.5 ? randRange(0.14, 0.46) : 0;
        let peakBoost = 0;
        let footprintX = randRange(1.08, 1.72);
        let footprintZ = randRange(1.08, 1.72);
        let ridgeBias = randRange(-0.24, 0.24);
        let primaryHillOffset = radius * randRange(0.18, 0.34);
        let secondaryHillOffset = radius * randRange(0.16, 0.36);
        let tertiaryHillOffset = radius * randRange(0.12, 0.28);
        let secondaryAngleSpread = Math.PI * randRange(0.72, 1.06);
        if (terrainStyle === 'mountain') {
            heightProfile = randRange(0.68, 1.22);
            peakBoost = randRange(1.05, 2.05);
            mesaBias = randRange(0.05, 0.35);
            secondaryHillScale = randRange(0.4, 0.8);
        }
        else if (terrainStyle === 'plateau') {
            heightProfile = randRange(0.42, 0.74);
            mesaBias = randRange(0.7, 1.0);
            peakBoost = 0;
            ridgeBias = randRange(-0.12, 0.12);
        }
        else if (terrainStyle === 'rocky') {
            heightProfile = randRange(0.28, 0.58);
            tertiaryHillScale = randRange(0.32, 0.64);
            secondaryHillScale = randRange(0.42, 0.78);
            footprintX = randRange(1.0, 1.5);
            footprintZ = randRange(1.0, 1.5);
        }
        else if (terrainStyle === 'twin') {
            // Two distinct peaks of comparable height — ridge running between them
            heightProfile = randRange(0.48, 0.86);
            peakBoost = randRange(0.5, 1.05);
            mesaBias = randRange(0.05, 0.3);
            secondaryHillScale = randRange(0.78, 1.05);
            tertiaryHillScale = 0;
            // Hills sit on opposite sides, well-separated
            primaryHillOffset = radius * randRange(0.36, 0.5);
            secondaryHillOffset = radius * randRange(0.36, 0.5);
            secondaryAngleSpread = Math.PI * randRange(0.92, 1.08);
            footprintX = randRange(1.4, 1.85);
            footprintZ = randRange(1.05, 1.4);
        }
        else if (terrainStyle === 'archipelago') {
            // Three smaller peaks each forming their own islet, water flows between them
            heightProfile = randRange(0.34, 0.56);
            peakBoost = randRange(0.2, 0.55);
            mesaBias = randRange(0.05, 0.25);
            secondaryHillScale = randRange(0.7, 0.95);
            tertiaryHillScale = randRange(0.55, 0.85);
            primaryHillOffset = radius * randRange(0.32, 0.46);
            secondaryHillOffset = radius * randRange(0.34, 0.5);
            tertiaryHillOffset = radius * randRange(0.32, 0.48);
            secondaryAngleSpread = Math.PI * randRange(0.7, 0.95);
            footprintX = randRange(1.5, 2.0);
            footprintZ = randRange(1.5, 2.0);
        }
        const primaryHillAngle = ridgeAxis + randRange(-0.42, 0.42);
        const secondaryHillAngle = primaryHillAngle + secondaryAngleSpread;
        // Tertiary hill: for archipelago, the third peak goes off perpendicular to the ridge
        const tertiaryHillAngle = terrainStyle === 'archipelago'
            ? primaryHillAngle + Math.PI * 0.5 + randRange(-0.18, 0.18)
            : ridgeAxis + Math.PI * 0.5 + randRange(-0.42, 0.42);
        return {
            islandHeading,
            footprintX,
            footprintZ,
            heightProfile,
            beachSpread: randRange(1.08, 1.26),
            ridgeAxis,
            ridgeBias,
            mesaBias,
            primaryHillAngle,
            secondaryHillAngle,
            tertiaryHillAngle,
            primaryHillOffset,
            secondaryHillOffset,
            tertiaryHillOffset,
            secondaryHillScale,
            tertiaryHillScale,
            peakBoost,
            terrainStyle,
        };
    }
    generateCaves(island, islandIndex) {
        const style = island.profile.terrainStyle;
        let count = 0;
        if (style === 'rocky')
            count = 1 + (Math.random() < 0.6 ? 1 : 0);
        else if (style === 'mountain')
            count = Math.random() < 0.7 ? 1 : 0;
        else if (style === 'plateau')
            count = Math.random() < 0.4 ? 1 : 0;
        else
            count = Math.random() < 0.25 ? 1 : 0;
        if (count === 0)
            return [];
        const caves = [];
        for (let i = 0; i < count; i++) {
            let angle = randAngle();
            // Avoid putting cave entrances on top of the dock
            if (island.dock && Math.abs(Math.atan2(Math.sin(angle - island.dock.shoreAngle), Math.cos(angle - island.dock.shoreAngle))) < 0.6) {
                angle += Math.PI * (0.5 + Math.random() * 0.5);
            }
            const distRatio = randRange(0.55, 0.78);
            const pos = getIslandSurfacePoint(island, distRatio, angle, 0);
            const rotation = directionToYaw(Math.cos(angle), Math.sin(angle));
            const interiorRadius = randRange(2.6, 3.6);
            const length = randRange(8, 14);
            caves.push({
                position: pos,
                rotation,
                width: interiorRadius * 2,
                height: randRange(3.4, 5.0),
                length,
                interiorRadius,
                // Floor sits 0.4m below the entrance surface so players step down into the cave
                floorY: pos.y - 0.4,
            });
        }
        void islandIndex;
        return caves;
    }
    generateTavern(island, islandIndex) {
        // Only the bigger islands with docks host taverns, ~3 across the map.
        if (!island.dock)
            return null;
        if (island.radius < 58)
            return null;
        // Deterministic-ish: every third hosting island.
        if (islandIndex % 3 !== 1) {
            // Allow a small extra chance
            if (Math.random() > 0.18)
                return null;
        }
        const dock = island.dock;
        // Place the tavern off the side of the dock, set back inland.
        const sideAngle = dock.shoreAngle + dock.moorSide * 0.55;
        const distRatio = 0.62;
        const pos = getIslandSurfacePoint(island, distRatio, sideAngle, 0);
        const facing = directionToYaw(island.position.x - pos.x, island.position.z - pos.z) + Math.PI; // door faces outward (toward dock)
        const rotation = directionToYaw(dock.position.x - pos.x, dock.position.z - pos.z);
        const width = 7.6;
        const depth = 6.4;
        void facing;
        const cosR = Math.cos(rotation);
        const sinR = Math.sin(rotation);
        // Tavern floor sits 0.18m above the surface — counter Y must match so the
        // bartender stands on planks, not under them.
        const counterPosition = {
            x: pos.x + sinR * (-depth * 0.28),
            y: pos.y + 0.18,
            z: pos.z + cosR * (-depth * 0.28),
        };
        return { position: pos, rotation, width, depth, counterPosition };
    }
    generateDock(island) {
        const dockChance = island.radius > 70 ? 0.82 : island.radius > 55 ? 0.62 : 0.36;
        if (Math.random() > dockChance)
            return null;
        const shoreAngle = randAngle();
        const rotation = directionToYaw(Math.cos(shoreAngle), Math.sin(shoreAngle));
        const length = randRange(Math.max(14, island.radius * 0.3), Math.max(20, island.radius * 0.52));
        const width = randRange(3.6, 5.6);
        const moorSide = (Math.random() < 0.5 ? -1 : 1);
        const shore = getIslandSurfacePoint(island, randRange(0.88, 0.95), shoreAngle, 0.28);
        const forward = { x: Math.sin(rotation), z: Math.cos(rotation) };
        const right = { x: Math.cos(rotation), z: -Math.sin(rotation) };
        const center = {
            x: shore.x + forward.x * length * 0.42,
            y: shore.y + 0.12,
            z: shore.z + forward.z * length * 0.42,
        };
        return {
            position: center,
            rotation,
            shoreAngle,
            length,
            width,
            moorSide,
            respawnPoint: {
                x: shore.x + forward.x * Math.min(length * 0.22, 5.5),
                y: shore.y + 0.38,
                z: shore.z + forward.z * Math.min(length * 0.22, 5.5),
            },
            berthPosition: {
                x: center.x + right.x * moorSide * (width * 0.65 + 3.4),
                y: 0.12,
                z: center.z + right.z * moorSide * (width * 0.65 + 3.4),
            },
            berthRotation: rotation,
        };
    }
    generateChests(island) {
        const count = randInt(2, 4);
        const chests = [];
        for (let i = 0; i < count; i++) {
            let angle = randAngle();
            if (island.dock && Math.abs(Math.atan2(Math.sin(angle - island.dock.shoreAngle), Math.cos(angle - island.dock.shoreAngle))) < 0.55) {
                angle += Math.PI * 0.75;
            }
            const distRatio = randRange(0.16, 0.56);
            const pos = getIslandSurfacePoint(island, distRatio, angle, 0.35);
            const surfaceY = pos.y;
            const buried = Math.random() < 0.78;
            if (buried) {
                pos.y = surfaceY - randRange(0.7, 1.35);
            }
            const mapOffsetX = (pos.x - island.position.x) / Math.max(1, island.radius);
            const mapOffsetZ = (pos.z - island.position.z) / Math.max(1, island.radius);
            chests.push({
                id: uuid(),
                position: pos,
                opened: false,
                value: randInt(ECONOMY.CHEST_VALUE_MIN, ECONOMY.CHEST_VALUE_MAX),
                carriedByPlayerId: null,
                storedOnShipId: null,
                floating: false,
                buried,
                digProgress: buried ? 0 : 1,
                mapOffsetX,
                mapOffsetZ,
                loot: this.rollLoot(),
            });
        }
        return chests;
    }
    generateBarrels(island) {
        const count = randInt(2, 5);
        const barrels = [];
        for (let i = 0; i < count; i++) {
            let angle = randAngle();
            if (island.dock && Math.abs(Math.atan2(Math.sin(angle - island.dock.shoreAngle), Math.cos(angle - island.dock.shoreAngle))) < 0.4) {
                angle += Math.PI * 0.5;
            }
            const distRatio = randRange(0.1, 0.68);
            const pos = getIslandSurfacePoint(island, distRatio, angle, 0.08);
            barrels.push({
                id: uuid(),
                position: pos,
                opened: false,
                loot: this.rollBarrelLoot(),
            });
        }
        return barrels;
    }
    rollBarrelLoot() {
        const rolls = randInt(2, 4);
        const loot = new Map();
        for (let i = 0; i < rolls; i++) {
            const entry = weightedRandom(BARREL_LOOT_TABLE);
            const qty = randInt(entry.minQty, entry.maxQty);
            loot.set(entry.item, (loot.get(entry.item) ?? 0) + qty);
        }
        return Array.from(loot.entries()).map(([item, qty]) => ({ item, qty }));
    }
    generateUpgradeStations(island) {
        const count = island.radius > 70 ? 2 : island.radius > 50 ? 1 : (Math.random() < 0.55 ? 1 : 0);
        if (count === 0)
            return [];
        const allTypes = ['hull_reinforcement', 'charged_cannons', 'swift_sails'];
        const shuffled = [...allTypes].sort(() => Math.random() - 0.5);
        const types = shuffled.slice(0, count);
        return types.map((type, i) => {
            const angle = (island.dock ? island.dock.shoreAngle + Math.PI * (0.6 + i * 0.5) : randAngle());
            const distRatio = randRange(0.12, 0.38);
            const pos = getIslandSurfacePoint(island, distRatio, angle, 0.08);
            return {
                id: uuid(),
                type,
                position: pos,
                claimedByShipId: null,
            };
        });
    }
    generateStoryNpcs(island, islandIndex) {
        const shouldSpawn = islandIndex < 3 || (island.radius > 62 && islandIndex % 4 === 0);
        const npcs = [];
        // Gold hoarders only on a subset of islands — every other dock-hosting island,
        // plus a guaranteed couple early so first-game discovery is fast.
        const hoarderEligible = !!island.dock && island.radius > 50;
        const hoarderHere = hoarderEligible && (islandIndex < 2 || islandIndex % 2 === 0);
        if (hoarderHere) {
            const hoarderAngle = island.dock
                ? island.dock.shoreAngle + island.dock.moorSide * 0.42
                : island.profile.primaryHillAngle - 0.62;
            const hoarderDistRatio = island.dock ? 0.74 : 0.38;
            const hoarderPos = getIslandSurfacePoint(island, hoarderDistRatio, hoarderAngle, 0.08);
            npcs.push({
                id: uuid(),
                role: 'gold_hoarder',
                name: 'Gold Hoarder Darius',
                cutsceneTitle: 'The Hoarder at the Shore',
                line: 'Bring me sealed chests, not loose excuses. I pay gold, and my charts point to the next mark.',
                cue: 'Sell carried chests here or take a treasure map.',
                position: hoarderPos,
                rotation: directionToYaw(island.position.x - hoarderPos.x, island.position.z - hoarderPos.z),
            });
        }
        if (island.tavern) {
            const t = island.tavern;
            const cosR = Math.cos(t.rotation);
            const sinR = Math.sin(t.rotation);
            // Stand the bartender just behind the bar counter, facing the door.
            const barPos = {
                x: t.counterPosition.x + sinR * 0.55,
                y: t.counterPosition.y,
                z: t.counterPosition.z + cosR * 0.55,
            };
            npcs.push({
                id: uuid(),
                role: 'bartender',
                name: 'Tavernkeeper Bess',
                cutsceneTitle: 'A Mug at the Counter',
                line: 'Sit, sailor. Trade rumors keep the rum warm — drink up and the next horizon will feel a touch closer.',
                cue: 'Tavern: rest, restock, and listen for tales.',
                position: barPos,
                rotation: t.rotation + Math.PI,
            });
        }
        if (!shouldSpawn)
            return npcs;
        const cast = [
            {
                role: 'mysterious_stranger',
                name: 'The Stranger',
                cutsceneTitle: 'A Figure at the Shore',
                line: 'The sea is closing in. Read the clouds, keep your bow inside the blue, and do not trust a quiet horizon.',
                cue: 'Storm warnings now point to the nearest safe water.',
            },
            {
                role: 'shipwright',
                name: 'Maeve the Shipwright',
                cutsceneTitle: 'Tools on the Tide',
                line: 'A sound hull wins more fights than a loud cannon. Take planks from barrels, patch low sections, then raise sail.',
                cue: 'Island barrels are the fastest way to restock repairs.',
            },
            {
                role: 'oracle',
                name: 'Old Salt Iona',
                cutsceneTitle: 'The Map Knows',
                line: 'X marks are never alone. Docks, forges, and camps leave scratches on every honest chart.',
                cue: 'Open the map near islands to inspect local details.',
            },
        ];
        const template = cast[islandIndex % cast.length];
        const angle = island.dock
            ? island.dock.shoreAngle + randRange(-0.34, 0.34)
            : island.profile.primaryHillAngle + randRange(-0.42, 0.42);
        const distRatio = island.dock ? randRange(0.66, 0.78) : randRange(0.22, 0.42);
        const pos = getIslandSurfacePoint(island, distRatio, angle, 0.06);
        const rotation = directionToYaw(island.position.x - pos.x, island.position.z - pos.z);
        npcs.push({
            id: uuid(),
            ...template,
            position: pos,
            rotation,
        });
        return npcs;
    }
    rollLoot() {
        const rolls = randInt(3, 6);
        const loot = new Map();
        for (let i = 0; i < rolls; i++) {
            const entry = weightedRandom(CHEST_LOOT_TABLE);
            const qty = randInt(entry.minQty, entry.maxQty);
            loot.set(entry.item, (loot.get(entry.item) ?? 0) + qty);
        }
        return Array.from(loot.entries()).map(([item, qty]) => ({ item, qty }));
    }
    generateWildlife(islands) {
        const animals = [];
        for (const island of islands) {
            const baseCount = island.radius > 96 ? 8 : island.radius > 70 ? 6 : island.radius > 54 ? 5 : 4;
            let placed = 0;
            let attempts = 0;
            while (placed < baseCount && attempts < baseCount * 6) {
                attempts++;
                const roll = Math.random();
                const type = roll < 0.34
                    ? 'crab'
                    : roll < 0.62
                        ? 'chicken'
                        : roll < 0.82
                            ? 'pig'
                            : 'gull';
                let angle = randAngle();
                if (island.dock && Math.abs(Math.atan2(Math.sin(angle - island.dock.shoreAngle), Math.cos(angle - island.dock.shoreAngle))) < 0.32) {
                    angle += Math.PI * 0.55;
                }
                const shoreBias = type === 'crab' ? randRange(0.72, 0.9) : type === 'gull' ? randRange(0.42, 0.76) : randRange(0.22, 0.68);
                const pos = getIslandSurfacePoint(island, shoreBias, angle, type === 'gull' ? 2.2 : 0.08);
                // Skip underwater spawns (archipelago saddles) and inside cave footprints.
                const groundOnly = pos.y - (type === 'gull' ? 2.2 : 0.08);
                if (groundOnly < 4.8)
                    continue;
                let inCave = false;
                for (const cave of island.caves) {
                    const dx = pos.x - cave.position.x;
                    const dz = pos.z - cave.position.z;
                    const cosR = Math.cos(cave.rotation);
                    const sinR = Math.sin(cave.rotation);
                    const lx = dx * cosR - dz * sinR;
                    const lz = dx * sinR + dz * cosR;
                    if (Math.abs(lx) < cave.interiorRadius + 0.5 && lz > -cave.length - 0.5 && lz < 1.0) {
                        inCave = true;
                        break;
                    }
                }
                if (inCave)
                    continue;
                animals.push({
                    id: uuid(),
                    islandId: island.id,
                    type,
                    position: { ...pos },
                    spawnPosition: { ...pos },
                    rotation: randAngle(),
                    velocity: { x: 0, y: 0, z: 0 },
                    health: WILDLIFE.HEALTH[type],
                    wanderAngle: randAngle(),
                    wanderTimer: randRange(0.4, 2.4),
                });
                placed++;
            }
        }
        return animals;
    }
    generateSeaRocks(islands, spawns) {
        const rocks = [];
        const attempts = SEA_ROCKS.COUNT * 36;
        for (let attempt = 0; attempt < attempts && rocks.length < SEA_ROCKS.COUNT; attempt++) {
            const angle = randAngle();
            const dist = randRange(170, WORLD.HALF - 95);
            const radius = randRange(SEA_ROCKS.MIN_RADIUS, SEA_ROCKS.MAX_RADIUS);
            const height = randRange(SEA_ROCKS.MIN_HEIGHT, SEA_ROCKS.MAX_HEIGHT);
            const rotation = randAngle();
            const variant = randInt(0, 2);
            const colliderSet = buildSeaRockColliders(radius, height, rotation, variant);
            const candidate = {
                id: uuid(),
                position: {
                    x: Math.cos(angle) * dist,
                    y: 0,
                    z: Math.sin(angle) * dist,
                },
                radius,
                height,
                rotation,
                variant,
                colliderBoundsRadius: colliderSet.boundsRadius,
                colliders: colliderSet.colliders,
            };
            let blocked = false;
            for (const island of islands) {
                const d = Math.hypot(candidate.position.x - island.position.x, candidate.position.z - island.position.z);
                if (d < getIslandMaxRadius(island) + radius + 38) {
                    blocked = true;
                    break;
                }
            }
            if (blocked)
                continue;
            for (const spawn of spawns) {
                const d = Math.hypot(candidate.position.x - spawn.position.x, candidate.position.z - spawn.position.z);
                if (d < radius + 80) {
                    blocked = true;
                    break;
                }
            }
            if (blocked)
                continue;
            for (const rock of rocks) {
                const d = Math.hypot(candidate.position.x - rock.position.x, candidate.position.z - rock.position.z);
                if (d < candidate.radius + rock.radius + 45) {
                    blocked = true;
                    break;
                }
            }
            if (!blocked)
                rocks.push(candidate);
        }
        return rocks;
    }
    generateShipSpawns(islands) {
        const spawns = [];
        const minDist = 120;
        const attempts = 300;
        for (let i = 0; i < WORLD.SHIP_COUNT; i++) {
            let pos = null;
            for (let a = 0; a < attempts; a++) {
                const angle = randAngle();
                const dist = randRange(200, 900);
                const candidate = {
                    x: Math.cos(angle) * dist,
                    y: 0,
                    z: Math.sin(angle) * dist,
                };
                // Not on an island
                let onIsland = false;
                for (const isl of islands) {
                    const dx = candidate.x - isl.position.x;
                    const dz = candidate.z - isl.position.z;
                    if (Math.sqrt(dx * dx + dz * dz) < getIslandMaxRadius(isl) + 30) {
                        onIsland = true;
                        break;
                    }
                }
                // Not too close to another spawn
                let tooClose = false;
                for (const sp of spawns) {
                    const dx = candidate.x - sp.position.x;
                    const dz = candidate.z - sp.position.z;
                    if (Math.sqrt(dx * dx + dz * dz) < minDist) {
                        tooClose = true;
                        break;
                    }
                }
                if (!onIsland && !tooClose) {
                    pos = candidate;
                    break;
                }
            }
            if (!pos)
                pos = { x: randRange(-700, 700), y: 0, z: randRange(-700, 700) };
            // Distribute ship types: mostly sloops, some brigantines, few galleons
            const typeRoll = Math.random();
            const type = typeRoll < 0.5 ? 'sloop' : typeRoll < 0.8 ? 'brigantine' : 'galleon';
            spawns.push({ position: pos, rotation: randAngle(), type });
        }
        return spawns;
    }
    buildShip(id, ownerId, spawn, teamColor) {
        const stats = SHIP_STATS[spawn.type];
        return {
            id,
            type: spawn.type,
            ownerId,
            crewIds: [ownerId],
            position: { ...spawn.position, y: 0 },
            rotation: spawn.rotation,
            velocity: { x: 0, y: 0, z: 0 },
            angularVelocity: 0,
            sailHeight: 0.5,
            sailAngle: 0,
            anchored: false,
            anchorRaiseProgress: 0,
            hull: { bow: 1, stern: 1, port: 1, starboard: 1 },
            maxHull: stats.maxHull,
            onFire: false,
            fireTimer: 0,
            fireDamageAccum: 0,
            sinkProgress: 0,
            sinking: false,
            cannonCooldowns: Array(stats.cannonCount).fill(0),
            chainshottedUntil: 0,
            sailIntegrity: 1,
            sailRepairWoodTimer: 0,
            gold: 0,
            treasureChestIds: [],
            // SoT-style: most cannon ordnance lives in deck barrels (represented as ship stacks)
            inventory: [
                { item: 'cannonball', qty: 48 },
                { item: 'wood_plank', qty: 16 },
                { item: 'banana', qty: 5 },
                { item: 'firebomb_ball', qty: 4 },
                { item: 'chainshot', qty: 14 },
            ],
            repairCooldown: 0,
            autoRepairProgress: 0,
            teamColor,
            alive: true,
            upgrades: [],
        };
    }
}
