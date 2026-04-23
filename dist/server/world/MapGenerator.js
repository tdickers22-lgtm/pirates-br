import { v4 as uuid } from 'uuid';
import { WORLD, SHIP_STATS, CHEST_LOOT_TABLE, BARREL_LOOT_TABLE, ECONOMY } from '../../shared/constants/index.js';
import { directionToYaw, getIslandMaxRadius, getIslandSurfacePoint, randRange, randAngle, weightedRandom, randInt, } from '../../shared/utils/index.js';
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
        const minDist = 160;
        const attempts = 200;
        for (let i = 0; i < WORLD.ISLAND_COUNT; i++) {
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
                    if (Math.sqrt(dx * dx + dz * dz) < minDist) {
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
            const radius = randRange(40, 90);
            const island = {
                id: uuid(),
                name: ISLAND_NAMES[islands.length % ISLAND_NAMES.length],
                position: pos,
                radius,
                profile: this.generateIslandProfile(radius),
                dock: null,
                chests: [],
                barrels: [],
                upgradeStations: [],
                npcs: [],
            };
            island.dock = this.generateDock(island);
            island.chests = this.generateChests(island);
            island.barrels = this.generateBarrels(island);
            island.upgradeStations = this.generateUpgradeStations(island);
            island.npcs = this.generateStoryNpcs(island, islands.length);
            islands.push(island);
        }
        return islands;
    }
    generateIslandProfile(radius) {
        const islandHeading = randAngle();
        const ridgeAxis = islandHeading + randRange(-0.48, 0.48);
        const secondaryHillScale = randRange(0.28, 0.72);
        const tertiaryHillScale = Math.random() > 0.5 ? randRange(0.14, 0.46) : 0;
        const primaryHillAngle = ridgeAxis + randRange(-0.42, 0.42);
        return {
            islandHeading,
            footprintX: randRange(1.08, 1.72),
            footprintZ: randRange(1.08, 1.72),
            heightProfile: randRange(0.18, 0.42),
            beachSpread: randRange(1.08, 1.26),
            ridgeAxis,
            ridgeBias: randRange(-0.24, 0.24),
            mesaBias: randRange(0.15, 1),
            primaryHillAngle,
            secondaryHillAngle: primaryHillAngle + Math.PI * randRange(0.72, 1.06),
            tertiaryHillAngle: ridgeAxis + Math.PI * 0.5 + randRange(-0.42, 0.42),
            primaryHillOffset: radius * randRange(0.18, 0.34),
            secondaryHillOffset: radius * randRange(0.16, 0.36),
            tertiaryHillOffset: radius * randRange(0.12, 0.28),
            secondaryHillScale,
            tertiaryHillScale,
        };
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
