import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import { v4 as uuid } from 'uuid';
import { SERVER_TICK_MS, SNAPSHOT_RATE, ECONOMY, PLAYER, POCKET, SHIP, SHARK, SHIP_UPGRADES, SHIP_STATS, WEAPONS, WORLD } from '../../shared/constants/index.js';
import { MapGenerator } from '../world/MapGenerator.js';
import { PhysicsSystem } from '../systems/PhysicsSystem.js';
import { WeaponSystem } from '../systems/WeaponSystem.js';
import { StormSystem } from '../systems/StormSystem.js';
import { IslandSystem } from '../systems/IslandSystem.js';
import { TradingSystem } from '../systems/TradingSystem.js';
import { BotSystem } from '../systems/BotSystem.js';
import { getNearestShipBoardingLadder, getIslandSurfacePoint, getIslandSurfaceY, isPointInsideIslandFootprint, dockLocalToWorld, randRange, randAngle, dist2D, angleWrap, getMainMastLocalZ, getCrowNestStandingY, getCrowNestLadderInteractionBounds, getSailStationLocal, } from '../../shared/utils/index.js';
const TEAM_COLORS = [
    0xFF4444, 0x44AAFF, 0x44FF88, 0xFFAA44,
    0xFF44FF, 0x44FFFF, 0xFFFF44, 0xFF8844,
    0x8844FF, 0x44FF44, 0xFF4488, 0x88FF44,
    0x4488FF, 0xFF8888, 0x88FFFF, 0xFFFF88,
];
const PROJECT_ROOT = join(fileURLToPath(new URL('../../..', import.meta.url)));
const CLIENT_DIST_ROOT = join(PROJECT_ROOT, 'dist/client');
const MIME_TYPES = {
    '.css': 'text/css; charset=utf-8',
    '.html': 'text/html; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.map': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
};
export class GameServer {
    constructor() {
        this.httpServer = createServer((req, res) => this.handleHttp(req, res));
        this.clients = new Map();
        this.playersById = new Map();
        this.shipsById = new Map();
        this.t = 0;
        this.tickCount = 0;
        this.sharkSpawnCooldown = 0;
        this.configuredBotCount = 0;
        // Systems
        this.physics = new PhysicsSystem();
        this.weapons = new WeaponSystem();
        this.storm = new StormSystem();
        this.islands = new IslandSystem();
        this.trading = new TradingSystem();
        this.bots = new BotSystem();
        this.mapGen = new MapGenerator();
        this.skeletonHomes = new Map();
        /** Per-player: previous frame had jump key held — used for reliable cannon self-launch edge detection. */
        this.lastJumpHeldByPlayer = new Map();
    }
    init(port, botCount) {
        this.configuredBotCount = botCount;
        this.setupWorld(botCount);
        this.wss = new WebSocketServer({ server: this.httpServer, path: '/ws' });
        this.httpServer.listen(port, () => {
            console.log(`[Server] HTTP + WebSocket listening on port ${port}`);
        });
        this.wss.on('connection', (ws) => this.onConnect(ws));
        // Game loop
        setInterval(() => this.tick(), SERVER_TICK_MS);
        console.log(`[Server] Game started. Bots: ${botCount}`);
    }
    setupWorld(botCount) {
        const islandList = this.mapGen.generateIslands();
        const spawns = this.mapGen.generateShipSpawns(islandList);
        const ships = [];
        const players = [];
        // Create bot ships
        for (let i = 0; i < Math.min(botCount, spawns.length); i++) {
            const spawn = spawns[i];
            const botId = uuid();
            const shipId = uuid();
            const ship = this.mapGen.buildShip(shipId, botId, spawn, TEAM_COLORS[i % TEAM_COLORS.length]);
            ships.push(ship);
            const bot = this.createPlayer(botId, `Pirate_${i + 1}`, shipId, true);
            bot.position = {
                x: spawn.position.x,
                y: ship.position.y + SHIP_STATS[spawn.type].height + 0.5,
                z: spawn.position.z,
            };
            bot.onShipId = shipId;
            players.push(bot);
            const diff = i < 5 ? 'easy' : i < 12 ? 'medium' : 'hard';
            this.bots.registerBot(bot, ship, diff);
        }
        this.spawnIslandSkeletons(players, islandList);
        this.state = {
            phase: 'waiting',
            tick: 0,
            shipsAlive: ships.length,
            storm: this.storm.buildInitialState(),
            ships,
            players,
            projectiles: [],
            kegs: [],
            islands: islandList,
            tradeSessions: [],
            sharks: [],
            winnerId: null,
        };
        this.rebuildEntityIndexes();
    }
    resetWorld(botCount = this.configuredBotCount) {
        this.physics = new PhysicsSystem();
        this.weapons = new WeaponSystem();
        this.storm = new StormSystem();
        this.islands = new IslandSystem();
        this.trading = new TradingSystem();
        this.bots = new BotSystem();
        this.mapGen = new MapGenerator();
        this.skeletonHomes.clear();
        this.lastJumpHeldByPlayer.clear();
        this.sharkSpawnCooldown = 0;
        this.t = 0;
        this.tickCount = 0;
        this.setupWorld(botCount);
    }
    createPlayer(id, name, shipId, isBot) {
        return {
            id,
            name,
            shipId,
            position: { x: 0, y: 1, z: 0 },
            rotation: { x: 0, y: 0 },
            velocity: { x: 0, y: 0, z: 0 },
            health: PLAYER.MAX_HEALTH,
            state: 'alive',
            weapons: this.weapons.createDefaultWeapons(),
            activeSlot: 0,
            reloading: false,
            reloadTimer: 0,
            knockbackVelocity: { x: 0, y: 0, z: 0 },
            isBot,
            kills: 0,
            gold: 0,
            carryingChestId: null,
            treasureMapIslandId: null,
            swimTimer: 0,
            atCannon: false,
            atHelm: false,
            atSails: false,
            sailControlMode: null,
            atCrowNest: false,
            cannonIndex: 0,
            nearChestId: null,
            nearShipId: null,
            onShipId: shipId,
            respawnTimer: 0,
            respawnProtectionTimer: 0,
            shipBoundaryGraceTimer: 0,
            lastDamagedById: null,
            lastDamageWasHeadshot: false,
            selectedCannonAmmo: 'cannonball',
            kegs: PLAYER.STARTING_KEGS,
            kegCooldown: 0,
            cannonFlightTimer: 0,
            cannonBallistic: false,
            pocketBanana: 4,
            pocketWood: 0,
            pocketCoconut: 0,
            pocketMango: 0,
            hasShovel: true,
            nearBarrelId: null,
        };
    }
    rebuildEntityIndexes() {
        this.playersById = new Map(this.state.players.map((player) => [player.id, player]));
        this.shipsById = new Map(this.state.ships.map((ship) => [ship.id, ship]));
    }
    getPlayer(playerId) {
        return playerId ? this.playersById.get(playerId) ?? null : null;
    }
    getShip(shipId) {
        return shipId ? this.shipsById.get(shipId) ?? null : null;
    }
    getAliveShip(shipId) {
        const ship = this.getShip(shipId);
        return ship && ship.alive && !ship.sinking ? ship : null;
    }
    pruneDisconnectedHumans() {
        const connectedPlayerIds = new Set(this.clients.keys());
        this.state.ships = this.state.ships.filter((ship) => {
            if (!ship.alive || ship.sinking)
                return false;
            const owner = this.playersById.get(ship.ownerId);
            if (owner?.isBot && owner.state !== 'eliminated')
                return true;
            return connectedPlayerIds.has(ship.ownerId) || ship.crewIds.some((id) => connectedPlayerIds.has(id));
        });
        const liveShipIds = new Set(this.state.ships.map((ship) => ship.id));
        this.state.players = this.state.players.filter((player) => {
            const hasLiveShip = player.shipId === null || liveShipIds.has(player.shipId);
            if (player.isBot)
                return player.state !== 'eliminated' && hasLiveShip;
            return connectedPlayerIds.has(player.id) && hasLiveShip;
        });
        const livePlayerIds = new Set(this.state.players.map((player) => player.id));
        for (const ship of this.state.ships) {
            ship.crewIds = ship.crewIds.filter((id) => livePlayerIds.has(id));
        }
        this.state.tradeSessions = this.state.tradeSessions.filter((session) => (livePlayerIds.has(session.initiatorId)
            && livePlayerIds.has(session.targetPlayerId)
            && liveShipIds.has(session.initiatorShipId)
            && liveShipIds.has(session.targetShipId)));
        this.state.kegs = this.state.kegs.filter((keg) => liveShipIds.has(keg.shipId));
        this.state.shipsAlive = this.state.ships.filter((ship) => ship.alive && !ship.sinking).length;
        this.rebuildEntityIndexes();
    }
    pickHumanSpawn(spawns) {
        let bestSpawn = null;
        let bestDistance = -Infinity;
        for (const spawn of spawns) {
            let nearestShipDistance = Infinity;
            for (const ship of this.state.ships) {
                if (!ship.alive || ship.sinking)
                    continue;
                nearestShipDistance = Math.min(nearestShipDistance, dist2D(spawn.position.x, spawn.position.z, ship.position.x, ship.position.z));
            }
            if (nearestShipDistance > bestDistance) {
                bestDistance = nearestShipDistance;
                bestSpawn = spawn;
            }
        }
        return bestSpawn ?? spawns[0] ?? null;
    }
    pickSafeSpawnDock() {
        const candidates = [];
        const { centerX, centerZ, safeRadius } = this.state.storm;
        for (const island of this.state.islands) {
            const dock = island.dock;
            if (!dock)
                continue;
            if (dist2D(dock.respawnPoint.x, dock.respawnPoint.z, centerX, centerZ) >= safeRadius - 50)
                continue;
            const occupied = this.state.ships.some((ship) => (ship.alive
                && !ship.sinking
                && dist2D(ship.position.x, ship.position.z, dock.berthPosition.x, dock.berthPosition.z) < 42));
            if (!occupied)
                candidates.push(dock);
        }
        return candidates.length > 0
            ? candidates[Math.floor(Math.random() * candidates.length)]
            : null;
    }
    getNextTeamColor() {
        const usedColors = new Set(this.state.ships.map((ship) => ship.teamColor));
        return TEAM_COLORS.find((color) => !usedColors.has(color))
            ?? TEAM_COLORS[this.state.ships.length % TEAM_COLORS.length];
    }
    shouldStartFreshMatchForConnection() {
        const activeHuman = this.state.players.some((player) => !player.isBot && player.state !== 'eliminated');
        return this.clients.size === 0 || this.state.phase === 'ended' || !activeHuman;
    }
    closeExistingClientsForFreshMatch() {
        for (const client of this.clients.values()) {
            client.ws.close();
        }
        this.clients.clear();
    }
    onConnect(ws) {
        const startsFreshSoloMatch = this.shouldStartFreshMatchForConnection();
        if (startsFreshSoloMatch) {
            this.closeExistingClientsForFreshMatch();
            this.resetWorld(this.configuredBotCount);
        }
        const playerId = uuid();
        const client = { ws, playerId, lastInput: null, lastPing: Date.now() };
        this.clients.set(playerId, client);
        console.log(`[Server] Player connected: ${playerId}`);
        this.pruneDisconnectedHumans();
        // If the round ended, reset win state and give a fresh storm.
        if (this.state.phase === 'ended') {
            this.state.storm = this.storm.buildInitialState();
        }
        this.state.winnerId = null;
        // Find a free spawn that is as far as possible from current ships.
        const spawns = this.mapGen.generateShipSpawns(this.state.islands);
        const spawn = this.pickHumanSpawn(spawns) ?? {
            position: { x: randRange(-600, 600), y: 0, z: randRange(-600, 600) },
            rotation: randAngle(),
            type: 'sloop',
        };
        const shipId = uuid();
        const ship = this.mapGen.buildShip(shipId, playerId, spawn, this.getNextTeamColor());
        ship.crewIds = [playerId];
        this.state.ships.push(ship);
        const player = this.createPlayer(playerId, 'You', shipId, false);
        // Try to spawn the player at a dock that is comfortably inside the initial storm circle.
        // The ship is parked at the dock's berth so they can immediately board it.
        const spawnDock = this.pickSafeSpawnDock();
        if (spawnDock) {
            this.parkShipAtDock(ship, spawnDock);
            player.position = {
                x: spawnDock.respawnPoint.x,
                y: spawnDock.respawnPoint.y + 0.2,
                z: spawnDock.respawnPoint.z,
            };
            player.onShipId = null; // player walks across the dock to board their ship
        }
        else {
            player.position = {
                x: spawn.position.x,
                y: ship.position.y + SHIP_STATS[spawn.type].height + 0.5,
                z: spawn.position.z,
            };
            player.onShipId = shipId;
        }
        this.state.players.push(player);
        this.state.shipsAlive = this.state.ships.filter(s => s.alive && !s.sinking).length;
        this.state.phase = 'playing';
        this.rebuildEntityIndexes();
        // Send initial snapshot
        this.send(ws, {
            type: 'join',
            ts: Date.now(),
            payload: {
                playerId,
                shipId,
                snapshot: this.buildSnapshot(),
            },
        });
        ws.on('message', (data) => {
            try {
                const msg = JSON.parse(data.toString());
                this.handleMessage(client, msg);
            }
            catch { }
        });
        ws.on('close', () => {
            this.clients.delete(playerId);
            const removedShipIds = new Set(this.state.ships
                .filter((ship) => ship.ownerId === playerId)
                .map((ship) => ship.id));
            for (const other of this.state.players) {
                if (other.id === playerId || !other.onShipId || !removedShipIds.has(other.onShipId))
                    continue;
                other.onShipId = null;
                other.nearShipId = null;
                other.state = other.state === 'eliminated' || other.state === 'respawning' ? other.state : 'swimming';
                this.clearStationFlags(other);
            }
            this.state.ships = this.state.ships.filter(s => s.ownerId !== playerId);
            this.state.players = this.state.players.filter(p => p.id !== playerId);
            this.state.kegs = this.state.kegs.filter((keg) => !removedShipIds.has(keg.shipId));
            this.state.tradeSessions = this.state.tradeSessions.filter((session) => (session.initiatorId !== playerId
                && session.targetPlayerId !== playerId
                && !removedShipIds.has(session.initiatorShipId)
                && !removedShipIds.has(session.targetShipId)));
            this.lastJumpHeldByPlayer.delete(playerId);
            this.state.shipsAlive = this.state.ships.filter(s => s.alive && !s.sinking).length;
            this.rebuildEntityIndexes();
            console.log(`[Server] Player disconnected: ${playerId}`);
        });
    }
    handleMessage(client, msg) {
        switch (msg.type) {
            case 'player_input':
                client.lastInput = msg.payload;
                break;
            case 'trade_action':
                this.handleTradeAction(client.playerId, msg.payload);
                break;
            case 'ping':
                this.send(client.ws, { type: 'pong', ts: Date.now(), payload: msg.payload });
                break;
        }
    }
    clearStationFlags(player) {
        player.atCannon = false;
        player.atHelm = false;
        player.atSails = false;
        player.sailControlMode = null;
        player.atCrowNest = false;
    }
    isStationOccupied(ship, station, playerId, cannonIndex = null) {
        return this.state.players.some((other) => {
            if (other.id === playerId || other.onShipId !== ship.id)
                return false;
            if (other.state === 'eliminated' || other.state === 'respawning')
                return false;
            switch (station) {
                case 'helm':
                    return other.atHelm;
                case 'sails':
                    return other.atSails;
                case 'crow':
                    return other.atCrowNest;
                case 'cannon':
                    return other.atCannon && other.cannonIndex === cannonIndex;
            }
        });
    }
    enterHelm(player, ship) {
        if (this.isStationOccupied(ship, 'helm', player.id))
            return false;
        this.clearStationFlags(player);
        player.atHelm = true;
        this.snapPlayerToHelm(player, ship);
        return true;
    }
    enterSails(player, ship) {
        if (this.isStationOccupied(ship, 'sails', player.id))
            return false;
        this.clearStationFlags(player);
        player.atSails = true;
        player.sailControlMode = null;
        this.snapPlayerToSails(player, ship);
        return true;
    }
    enterCrowNest(player, ship) {
        if (this.isStationOccupied(ship, 'crow', player.id))
            return false;
        this.clearStationFlags(player);
        player.atCrowNest = true;
        this.snapPlayerToCrowNest(player, ship);
        return true;
    }
    enterCannon(player, ship, cannonIndex, yaw, pitch) {
        if (this.isStationOccupied(ship, 'cannon', player.id, cannonIndex))
            return false;
        this.clearStationFlags(player);
        player.atCannon = true;
        player.cannonIndex = cannonIndex;
        const aim = this.getCannonAim(ship, cannonIndex, yaw, pitch);
        player.rotation.x = aim.yaw;
        player.rotation.y = aim.pitch;
        this.snapPlayerToCannon(player, ship, cannonIndex);
        return true;
    }
    tick() {
        const dt = SERVER_TICK_MS / 1000;
        this.t += dt;
        this.tickCount++;
        this.state.tick++;
        if (this.state.phase !== 'playing')
            return;
        this.updateRespawns(dt);
        for (const player of this.state.players) {
            if (player.kegCooldown > 0)
                player.kegCooldown = Math.max(0, player.kegCooldown - dt);
        }
        // Apply player inputs
        for (const [, client] of this.clients) {
            if (client.lastInput) {
                this.applyInput(client.playerId, client.lastInput, dt);
            }
        }
        for (const ship of this.state.ships) {
            if (!ship.alive || ship.sinking)
                continue;
            const helmed = this.state.players.some((p) => p.atHelm && p.onShipId === ship.id);
            if (!helmed)
                ship.angularVelocity *= Math.exp(-dt * SHIP.RUDDER_DECAY);
        }
        // Update bots
        this.bots.update(dt, this.t, this.state.players, this.state.ships, this.state.islands, this.state.storm, this.weapons);
        this.updateIslandSkeletons(dt);
        this.processBotLooting();
        // Update weapon reloads
        this.weapons.update(dt, this.state.players);
        this.weapons.tickCannons(dt, this.state.ships);
        // Flush new projectiles
        const newProjs = this.weapons.flushProjectiles();
        this.state.projectiles.push(...newProjs);
        // Physics
        this.syncTreasureChests();
        this.physics.update(dt, this.t, this.state.ships, this.state.players, this.state.projectiles, this.state.islands);
        this.relayPendingCombatEvents();
        this.syncTreasureChests();
        this.updateSharks(dt);
        // Storm
        this.storm.update(dt, this.state.storm, this.state.ships, this.state.players);
        this.syncTreasureChests();
        this.updateKegs(dt);
        this.updateFieldRepairs(dt);
        // Trading
        const tradeEvents = this.trading.update(dt, this.state.tradeSessions, this.state.ships, this.state.players);
        for (const event of tradeEvents) {
            if (event.type === 'trade_update' && event.session) {
                this.broadcast({ type: 'trade_update', ts: Date.now(), payload: event.session });
            }
            else {
                this.broadcast({ type: 'trade_result', ts: Date.now(), payload: event });
            }
        }
        // Check player deaths
        for (const player of this.state.players) {
            if (player.state !== 'eliminated' && player.state !== 'respawning' && player.health <= 0) {
                this.handlePlayerDeath(player);
            }
        }
        // Check ship sunk
        for (const ship of this.state.ships) {
            if (!ship.alive || ship.sinking)
                continue;
            const sections = [ship.hull.bow, ship.hull.stern, ship.hull.port, ship.hull.starboard];
            const avg = sections.reduce((sum, value) => sum + value, 0) / sections.length;
            if (sections.some((value) => value <= 0) || avg <= 0.18) {
                this.startShipSinking(ship);
            }
        }
        // Clean dead projectiles
        this.state.projectiles = this.state.projectiles.filter(p => p.alive && p.age < p.maxAge);
        this.state.kegs = this.state.kegs.filter((keg) => keg.timer > 0);
        // Count alive ships
        this.state.shipsAlive = this.state.ships.filter(s => s.alive && !s.sinking).length;
        // Check win condition
        this.checkWinCondition();
        // Send snapshot/delta
        if (this.tickCount % SNAPSHOT_RATE === 0) {
            const snap = this.buildSnapshot();
            this.broadcast({ type: 'state_snapshot', ts: Date.now(), payload: snap });
        }
    }
    applyInput(playerId, input, dt) {
        const player = this.getPlayer(playerId);
        if (!player || player.state === 'eliminated' || player.state === 'respawning')
            return;
        const ship = this.getAliveShip(player.onShipId);
        if (!ship) {
            this.clearStationFlags(player);
        }
        const cannonAim = ship && player.atCannon
            ? this.getCannonAim(ship, player.cannonIndex, input.yaw, input.pitch)
            : null;
        const prevJumpHeld = this.lastJumpHeldByPlayer.get(playerId) ?? false;
        const jumpEdge = input.jumpPressed || (!!input.jump && !prevJumpHeld);
        this.lastJumpHeldByPlayer.set(playerId, !!input.jump);
        player.rotation.x = player.atHelm && ship ? ship.rotation : (cannonAim?.yaw ?? input.yaw);
        player.rotation.y = cannonAim?.pitch ?? input.pitch;
        // Weapon switch
        if (input.slot !== null && input.slot !== player.activeSlot) {
            player.activeSlot = input.slot;
        }
        if (input.cannonAmmo) {
            player.selectedCannonAmmo = input.cannonAmmo;
        }
        // Reload
        if (input.reload) {
            this.weapons.startReload(player);
        }
        if (ship && player.atCannon && jumpEdge) {
            this.launchPlayerFromCannon(player, ship, cannonAim ?? this.getCannonAim(ship, player.cannonIndex, input.yaw, input.pitch));
            return;
        }
        if (input.placeKeg && ship && ship.id !== player.shipId && player.kegs > 0 && player.kegCooldown <= 0 && !player.atCannon && !player.atHelm && !player.atSails && !player.atCrowNest) {
            const kegPlacement = this.getKegPlacement(player, ship);
            if (kegPlacement) {
                this.state.kegs.push({
                    id: uuid(),
                    shipId: ship.id,
                    plantedById: player.id,
                    section: kegPlacement.section,
                    position: kegPlacement.position,
                    localPosition: kegPlacement.localPosition,
                    timer: SHIP.KEG_FUSE_TIME,
                });
                player.kegs -= 1;
                player.kegCooldown = player.kegs > 0 ? PLAYER.KEG_REPLENISH_COOLDOWN : 0;
            }
        }
        // Interact (X key) — exit current station always wins
        if (input.interact) {
            if (player.atCannon) {
                player.atCannon = false;
                return;
            }
            if (player.atHelm) {
                player.atHelm = false;
                return;
            }
            if (player.atSails) {
                player.atSails = false;
                player.sailControlMode = null;
                return;
            }
            if (player.atCrowNest) {
                player.atCrowNest = false;
                return;
            }
            if (input.interactIntent) {
                if (this.tryInteractIntent(player, input, ship ?? null))
                    return;
                return;
            }
            if (this.tryClimbIslandDockFromWater(player))
                return;
            if (this.returnPlayerByMermaid(player))
                return;
            // Legacy (bots / old clients): fixed priority chain
            const keg = ship ? this.getNearbyKeg(player, ship) : null;
            if (keg) {
                this.diffuseKeg(keg);
                return;
            }
            if (player.nearBarrelId) {
                const barrelEvent = this.islands.tryOpenBarrel(player, this.state.islands, this.state.ships);
                if (barrelEvent) {
                    this.broadcast({ type: 'barrel_opened', ts: Date.now(), payload: barrelEvent });
                }
                return;
            }
            if (player.nearChestId) {
                const event = this.tryTakeChest(player);
                if (event) {
                    this.broadcast({ type: 'chest_opened', ts: Date.now(), payload: event });
                }
                return;
            }
            if (this.tryBoardFromLadder(player))
                return;
            if (this.handleGoldHoarderInteraction(player))
                return;
            const homeShip = this.getAliveShip(player.shipId);
            const upgradeStation = this.getNearbyUpgradeStation(player);
            if (upgradeStation
                && homeShip
                && upgradeStation.claimedByShipId !== homeShip.id
                && !homeShip.upgrades.some(upgrade => upgrade.type === upgradeStation.type)) {
                upgradeStation.claimedByShipId = homeShip.id;
                this.applyShipUpgrade(homeShip, upgradeStation.type);
                this.broadcast({ type: 'ship_upgraded', ts: Date.now(), payload: { shipId: homeShip.id, type: upgradeStation.type } });
                return;
            }
            if (ship) {
                const repairSection = this.getRepairableHullSection(player, ship);
                if (repairSection && this.consumeRepairPlank(player, ship)) {
                    this.physics.repairHullSection(ship, repairSection, SHIP.REPAIR_HP);
                    if (ship.onFire) {
                        ship.fireTimer = Math.max(0, ship.fireTimer - SHIP.FIRE_REPAIR_DOUSE_TIME);
                        if (ship.fireTimer <= 0) {
                            ship.onFire = false;
                            ship.fireTimer = 0;
                            ship.fireDamageAccum = 0;
                        }
                    }
                    return;
                }
                if (player.carryingChestId && this.tryStowCarriedChest(player, ship))
                    return;
                if (this.isNearAnchor(player, ship)) {
                    if (!ship.anchored) {
                        ship.anchored = true;
                        ship.anchorRaiseProgress = 0;
                    }
                    this.clearStationFlags(player);
                    return;
                }
                if (this.isNearCrowNestLadder(player, ship)) {
                    if (this.enterCrowNest(player, ship))
                        return;
                }
                if (this.isNearSailStation(player, ship)) {
                    if (this.enterSails(player, ship))
                        return;
                }
                if (this.isNearHelm(player, ship)) {
                    if (this.enterHelm(player, ship))
                        return;
                }
                const nearbyCannon = this.getNearbyCannonIndex(player, ship);
                if (nearbyCannon !== null) {
                    this.enterCannon(player, ship, nearbyCannon, input.yaw, input.pitch);
                }
            }
        }
        // Trade request
        if (input.trade && ship) {
            let nearest = null;
            let nearestDist = Infinity;
            for (const other of this.state.ships) {
                if (other.id === ship.id || !other.alive)
                    continue;
                const dx = other.position.x - ship.position.x;
                const dz = other.position.z - ship.position.z;
                const d = Math.sqrt(dx * dx + dz * dz);
                if (d < 50 && d < nearestDist) {
                    nearestDist = d;
                    nearest = other;
                }
            }
            if (nearest) {
                const session = this.trading.requestTrade(player, nearest, this.state.tradeSessions);
                if (session) {
                    this.broadcast({ type: 'trade_request', ts: Date.now(), payload: session });
                }
            }
        }
        // Ship controls
        if (ship && player.onShipId === ship.id) {
            const stats = SHIP_STATS[ship.type];
            if (player.atSails) {
                if (input.sailRaise)
                    ship.sailHeight = Math.min(1, ship.sailHeight + 0.8 * dt);
                if (input.sailLower)
                    ship.sailHeight = Math.max(0, ship.sailHeight - 0.8 * dt);
                if (input.sailLeft)
                    ship.sailAngle = Math.max(-SHIP.MAX_SAIL_ANGLE, ship.sailAngle - SHIP.SAIL_TRIM_RATE * dt);
                if (input.sailRight)
                    ship.sailAngle = Math.min(SHIP.MAX_SAIL_ANGLE, ship.sailAngle + SHIP.SAIL_TRIM_RATE * dt);
            }
            if (ship.anchored
                && input.interactHeld
                && !player.atCannon
                && !player.atHelm
                && !player.atSails
                && !player.atCrowNest
                && this.isNearAnchor(player, ship)) {
                ship.anchorRaiseProgress = Math.min(1, ship.anchorRaiseProgress + dt / SHIP.ANCHOR_RAISE_TIME);
                if (ship.anchorRaiseProgress >= 1) {
                    ship.anchored = false;
                    ship.anchorRaiseProgress = 0;
                }
            }
            else if (!ship.anchored && ship.anchorRaiseProgress !== 0) {
                ship.anchorRaiseProgress = 0;
            }
            // Repair torn sails (hold interact + wood at sail station)
            if (player.atSails && ship.sailIntegrity < 1 && input.interactHeld) {
                const plankStack = ship.inventory.find(entry => entry.item === 'wood_plank' && entry.qty > 0);
                if (plankStack) {
                    ship.sailRepairWoodTimer += dt;
                    while (ship.sailRepairWoodTimer >= SHIP.SAIL_REPAIR_WOOD_INTERVAL && ship.sailIntegrity < 1) {
                        if (!this.consumeShipItem(ship, 'wood_plank', 1))
                            break;
                        ship.sailRepairWoodTimer -= SHIP.SAIL_REPAIR_WOOD_INTERVAL;
                        ship.sailIntegrity = Math.min(1, ship.sailIntegrity + 0.28);
                    }
                }
            }
            else if (!player.atSails) {
                ship.sailRepairWoodTimer = 0;
            }
            // Helm: A/D or arrow keys steer; W/S or arrow up/down trims sail while driving.
            if (player.atHelm) {
                let steerInput = 0;
                if (input.left)
                    steerInput -= 1;
                if (input.right)
                    steerInput += 1;
                if (input.forward)
                    ship.sailHeight = Math.min(1, ship.sailHeight + 0.48 * dt);
                if (input.back)
                    ship.sailHeight = Math.max(0, ship.sailHeight - 0.6 * dt);
                const chainshotted = Date.now() / 1000 < ship.chainshottedUntil;
                const speed = Math.sqrt(ship.velocity.x * ship.velocity.x + ship.velocity.z * ship.velocity.z);
                const speedTurnFactor = Math.max(0.42, Math.min(1, speed / Math.max(1, stats.maxSpeed * 0.36)));
                const maxOmega = stats.turnRate * (0.5 + ship.sailHeight * 0.5)
                    * (chainshotted ? 0.88 : 1)
                    * (ship.sailIntegrity < 0.5 ? 0.9 : 1)
                    * speedTurnFactor;
                const targetOmega = -steerInput * maxOmega;
                const rudderBlend = 1 - Math.exp(-dt * SHIP.RUDDER_SLEW);
                ship.angularVelocity += (targetOmega - ship.angularVelocity) * rudderBlend;
                if (steerInput === 0) {
                    ship.angularVelocity *= Math.exp(-dt * SHIP.RUDDER_DECAY * 0.35);
                }
                ship.rotation += ship.angularVelocity * dt;
            }
        }
        if (player.atHelm && ship) {
            this.snapPlayerToHelm(player, ship);
            player.velocity.x = 0;
            player.velocity.z = 0;
        }
        else if (player.atSails && ship) {
            this.snapPlayerToSails(player, ship);
            player.velocity.x = 0;
            player.velocity.z = 0;
        }
        else if (player.atCrowNest && ship) {
            this.snapPlayerToCrowNest(player, ship);
            player.velocity.x = 0;
            player.velocity.z = 0;
        }
        else if (player.atCannon && ship) {
            const aim = this.getCannonAim(ship, player.cannonIndex, input.yaw, input.pitch);
            player.rotation.x = aim.yaw;
            player.rotation.y = aim.pitch;
            this.snapPlayerToCannon(player, ship, player.cannonIndex);
            player.velocity.x = 0;
            player.velocity.z = 0;
        }
        else {
            if (ship && player.onShipId === ship.id) {
                this.armShipExitGrace(player, ship, input);
            }
            // On-foot / swim movement
            const yaw = input.yaw;
            const jumpBlocked = !!ship && (player.atHelm || player.atSails || player.atCrowNest);
            const moveX = (input.right ? 1 : 0) - (input.left ? 1 : 0);
            const moveZ = (input.forward ? 1 : 0) - (input.back ? 1 : 0);
            if (player.state === 'swimming') {
                const pitch = input.pitch;
                const forwardScale = Math.cos(pitch);
                const forwardX = Math.sin(yaw) * forwardScale;
                const forwardY = Math.sin(pitch);
                const forwardZ = Math.cos(yaw) * forwardScale;
                const rightX = -Math.cos(yaw);
                const rightZ = Math.sin(yaw);
                const forwardIntent = (input.forward ? 1 : 0) - (input.back ? 0.58 : 0);
                const strafeIntent = (input.right ? 0.72 : 0) - (input.left ? 0.72 : 0);
                let wishX = 0;
                let wishY = 0;
                let wishZ = 0;
                if (forwardIntent !== 0) {
                    const forwardScaleY = forwardIntent > 0 ? 1.18 : 0.6;
                    wishX += forwardX * forwardIntent;
                    wishY += forwardY * forwardScaleY * Math.abs(forwardIntent);
                    wishZ += forwardZ * forwardIntent;
                }
                if (strafeIntent !== 0) {
                    wishX += rightX * strafeIntent;
                    wishZ += rightZ * strafeIntent;
                }
                if (input.jump)
                    wishY += 0.95;
                if (input.sailLower)
                    wishY -= 0.95;
                const swimLen = Math.sqrt(wishX * wishX + wishY * wishY + wishZ * wishZ);
                if (swimLen > 0.001) {
                    const swimSpeed = PLAYER.SWIM_SPEED * (input.forward ? 1.06 : 1);
                    player.velocity.x = (wishX / swimLen) * swimSpeed;
                    player.velocity.y = (wishY / swimLen) * PLAYER.SWIM_SPEED * 0.92;
                    player.velocity.z = (wishZ / swimLen) * swimSpeed;
                    player.position.x += player.velocity.x * dt;
                    player.position.z += player.velocity.z * dt;
                }
                else {
                    player.velocity.x = 0;
                    player.velocity.z = 0;
                    player.velocity.y *= 0.82;
                }
            }
            else {
                const len = Math.sqrt(moveX * moveX + moveZ * moveZ) || 1;
                const nx = moveX / len, nz = moveZ / len;
                const speed = PLAYER.MOVE_SPEED;
                if (moveX !== 0 || moveZ !== 0) {
                    const cosY = Math.cos(yaw);
                    const sinY = Math.sin(yaw);
                    player.velocity.x = (sinY * nz - cosY * nx) * speed;
                    player.velocity.z = (cosY * nz + sinY * nx) * speed;
                    player.position.x += player.velocity.x * dt;
                    player.position.z += player.velocity.z * dt;
                }
                else {
                    player.velocity.x = 0;
                    player.velocity.z = 0;
                }
                const verticalReady = player.velocity.y <= 0.2;
                let grounded = false;
                if (ship && player.onShipId === ship.id) {
                    const floorY = this.getShipFloorY(player.position, ship);
                    grounded = verticalReady && Math.abs(player.position.y - floorY) < 0.24;
                }
                else {
                    for (const island of this.state.islands) {
                        if (isPointInsideIslandFootprint(island, player.position.x, player.position.z, 1.0)) {
                            grounded = verticalReady && Math.abs(player.position.y - getIslandSurfaceY(island, player.position.x, player.position.z)) < 0.24;
                            if (grounded)
                                break;
                        }
                        if (island.dock) {
                            const dx = player.position.x - island.dock.position.x;
                            const dz = player.position.z - island.dock.position.z;
                            const cos = Math.cos(island.dock.rotation);
                            const sin = Math.sin(island.dock.rotation);
                            const localX = dx * cos - dz * sin;
                            const localZ = dx * sin + dz * cos;
                            if (Math.abs(localX) <= island.dock.width * 0.5 + 0.45 && Math.abs(localZ) <= island.dock.length * 0.5 + 0.45) {
                                grounded = verticalReady && Math.abs(player.position.y - (island.dock.position.y + 0.14)) < 0.22;
                                if (grounded)
                                    break;
                            }
                        }
                    }
                }
                // Jump
                if (input.jumpPressed && !jumpBlocked && grounded) {
                    player.velocity.y = PLAYER.JUMP_FORCE;
                }
            }
        }
        // Fire
        if (input.fire) {
            if (player.respawnProtectionTimer > 0) {
                player.respawnProtectionTimer = 0;
            }
            const activeWeapon = player.weapons[player.activeSlot];
            if (activeWeapon && WEAPONS[activeWeapon.weaponId].melee) {
                if (!activeWeapon.reloading) {
                    const hits = this.weapons.tryMeleeAttack(player, this.state.players, input.yaw);
                    for (const hit of hits) {
                        const target = this.getPlayer(hit.targetId);
                        if (!target)
                            continue;
                        if (target.respawnProtectionTimer > 0 || target.state === 'respawning')
                            continue;
                        target.lastDamagedById = player.id;
                        target.lastDamageWasHeadshot = false;
                        target.health -= hit.damage;
                        this.awardPlayerHitGold(player.id, hit.damage);
                        this.notifyPlayerHit(player.id, {
                            targetId: target.id,
                            damage: hit.damage,
                            position: {
                                x: target.position.x,
                                y: target.position.y + PLAYER.HEIGHT * 0.72,
                                z: target.position.z,
                            },
                            kill: target.health <= 0,
                            remainingHealth: Math.max(0, target.health),
                            weaponId: activeWeapon.weaponId,
                        });
                        const dx = target.position.x - player.position.x;
                        const dz = target.position.z - player.position.z;
                        const len = Math.sqrt(dx * dx + dz * dz) || 1;
                        target.knockbackVelocity.x += (dx / len) * hit.knockback;
                        target.knockbackVelocity.y += hit.knockback * 0.2;
                        target.knockbackVelocity.z += (dz / len) * hit.knockback;
                    }
                    activeWeapon.reloading = true;
                    activeWeapon.reloadTimer = WEAPONS[activeWeapon.weaponId].reloadTime;
                }
            }
            else {
                const activeWeapon = player.weapons[player.activeSlot];
                const aimPoint = activeWeapon && !WEAPONS[activeWeapon.weaponId].melee
                    ? this.getFirearmAimPoint(player, ship ?? null, input, activeWeapon.weaponId)
                    : null;
                const fireYaw = cannonAim?.yaw ?? input.yaw;
                const firePitch = cannonAim?.pitch ?? input.pitch;
                const traces = this.weapons.tryFire(player, ship ?? null, fireYaw, firePitch, player.cannonIndex, { aiming: input.aim, aimPoint });
                if (traces.length > 0) {
                    this.resolveFirearmHits(player, traces);
                }
            }
        }
        this.tryDigChest(player, input, dt);
        this.tryUsePocketWheel(player, ship ?? null, input);
    }
    tryDigChest(player, input, dt) {
        if (!player.nearChestId || !input.interactHeld)
            return;
        if (!player.hasShovel)
            return;
        for (const island of this.state.islands) {
            for (const chest of island.chests) {
                if (chest.id !== player.nearChestId || chest.opened)
                    continue;
                if (!chest.buried || chest.digProgress >= 1)
                    return;
                chest.digProgress = Math.min(1, chest.digProgress + POCKET.DIG_RATE * dt);
                if (chest.digProgress >= 1) {
                    chest.position.y = getIslandSurfaceY(island, chest.position.x, chest.position.z) + 0.32;
                }
                return;
            }
        }
    }
    tryUsePocketWheel(player, ship, input) {
        if (!input.useWheelItem || input.wheelIndex === null)
            return;
        if (player.state === 'eliminated' || player.state === 'respawning')
            return;
        const crewShip = ship ??
            this.getAliveShip(player.shipId);
        const ix = input.wheelIndex;
        if (ix === 0) {
            if (player.pocketBanana <= 0)
                return;
            player.pocketBanana -= 1;
            player.health = Math.min(PLAYER.MAX_HEALTH, player.health + PLAYER.BANANA_HEAL);
        }
        else if (ix === 1) {
            if (player.pocketWood <= 0 || !crewShip)
                return;
            player.pocketWood -= 1;
            this.islands.addItemToShipInventory(crewShip, 'wood_plank', 1);
        }
        else if (ix === 2) {
            if (player.pocketCoconut <= 0)
                return;
            player.pocketCoconut -= 1;
            player.health = Math.min(PLAYER.MAX_HEALTH, player.health + POCKET.FRUIT_HEAL);
        }
        else if (ix === 3) {
            if (player.pocketMango <= 0)
                return;
            player.pocketMango -= 1;
            player.health = Math.min(PLAYER.MAX_HEALTH, player.health + POCKET.FRUIT_HEAL);
        }
    }
    getChestById(chestId) {
        if (!chestId)
            return null;
        for (const island of this.state.islands) {
            const chest = island.chests.find((candidate) => candidate.id === chestId);
            if (chest)
                return { chest, island };
        }
        return null;
    }
    syncTreasureChests() {
        for (const island of this.state.islands) {
            for (const chest of island.chests) {
                if (chest.opened)
                    continue;
                if (chest.carriedByPlayerId) {
                    const carrier = this.getPlayer(chest.carriedByPlayerId);
                    if (!carrier || carrier.state === 'eliminated' || carrier.state === 'respawning') {
                        chest.carriedByPlayerId = null;
                        chest.floating = true;
                        chest.position.y = 0.45;
                        continue;
                    }
                    const yaw = carrier.rotation.x;
                    chest.position.x = carrier.position.x - Math.sin(yaw) * 0.52 + Math.cos(yaw) * 0.36;
                    chest.position.y = carrier.position.y + (carrier.state === 'swimming' ? 0.45 : 0.72);
                    chest.position.z = carrier.position.z - Math.cos(yaw) * 0.52 - Math.sin(yaw) * 0.36;
                    chest.storedOnShipId = null;
                    chest.floating = false;
                    continue;
                }
                if (chest.storedOnShipId) {
                    const ship = this.getShip(chest.storedOnShipId);
                    if (!ship || !ship.alive || ship.sinking) {
                        chest.storedOnShipId = null;
                        chest.floating = true;
                        chest.position.y = 0.45;
                        continue;
                    }
                    const index = Math.max(0, ship.treasureChestIds.indexOf(chest.id));
                    const stats = SHIP_STATS[ship.type];
                    const localX = (index % 3 - 1) * 0.62;
                    const localZ = -stats.length * 0.24 - Math.floor(index / 3) * 0.58;
                    const world = this.toShipWorld(localX, localZ, ship);
                    chest.position.x = world.x;
                    chest.position.y = ship.position.y + stats.height + 0.42;
                    chest.position.z = world.z;
                    chest.floating = false;
                    continue;
                }
                if (chest.floating) {
                    chest.position.y = 0.45 + Math.sin(this.t * 1.8 + chest.value * 0.01) * 0.06;
                }
            }
        }
    }
    tryTakeChest(player) {
        if (!player.nearChestId || player.carryingChestId)
            return null;
        const found = this.getChestById(player.nearChestId);
        if (!found)
            return null;
        const { chest, island } = found;
        if (chest.opened)
            return null;
        if (chest.buried && chest.digProgress < 1)
            return null;
        const dx = player.position.x - chest.position.x;
        const dy = player.position.y - chest.position.y;
        const dz = player.position.z - chest.position.z;
        if (Math.sqrt(dx * dx + dy * dy + dz * dz) > PLAYER.INTERACT_RANGE + 0.7)
            return null;
        if (chest.carriedByPlayerId && chest.carriedByPlayerId !== player.id) {
            const previous = this.getPlayer(chest.carriedByPlayerId);
            if (previous && previous.carryingChestId === chest.id)
                previous.carryingChestId = null;
        }
        if (chest.storedOnShipId) {
            const storedShip = this.getShip(chest.storedOnShipId);
            if (storedShip) {
                storedShip.treasureChestIds = storedShip.treasureChestIds.filter((id) => id !== chest.id);
            }
        }
        chest.carriedByPlayerId = player.id;
        chest.storedOnShipId = null;
        chest.floating = false;
        player.carryingChestId = chest.id;
        this.syncTreasureChests();
        return {
            playerId: player.id,
            chestId: chest.id,
            islandId: island.id,
            islandName: island.name,
            value: chest.value,
            action: 'pickup',
            loot: [],
        };
    }
    tryStowCarriedChest(player, ship) {
        if (!player.carryingChestId || player.onShipId !== ship.id)
            return false;
        const found = this.getChestById(player.carryingChestId);
        if (!found || found.chest.opened) {
            player.carryingChestId = null;
            return false;
        }
        const chest = found.chest;
        chest.carriedByPlayerId = null;
        chest.storedOnShipId = ship.id;
        chest.floating = false;
        player.carryingChestId = null;
        if (!ship.treasureChestIds.includes(chest.id))
            ship.treasureChestIds.push(chest.id);
        this.syncTreasureChests();
        this.broadcast({
            type: 'chest_opened',
            ts: Date.now(),
            payload: { playerId: player.id, chestId: chest.id, value: chest.value, action: 'stow' },
        });
        return true;
    }
    dropCarriedChest(player) {
        if (!player.carryingChestId)
            return;
        const found = this.getChestById(player.carryingChestId);
        if (!found) {
            player.carryingChestId = null;
            return;
        }
        const chest = found.chest;
        chest.carriedByPlayerId = null;
        chest.storedOnShipId = null;
        chest.floating = player.position.y < 1.1 || player.state === 'swimming';
        chest.position = {
            x: player.position.x,
            y: chest.floating ? 0.45 : player.position.y + 0.25,
            z: player.position.z,
        };
        player.carryingChestId = null;
    }
    getNearbyGoldHoarder(player) {
        let closest = null;
        for (const island of this.state.islands) {
            for (const npc of island.npcs ?? []) {
                if (npc.role !== 'gold_hoarder')
                    continue;
                const distance = dist2D(player.position.x, player.position.z, npc.position.x, npc.position.z);
                if (distance < PLAYER.INTERACT_RANGE + 0.8 && (!closest || distance < closest.distance)) {
                    closest = { npc, island, distance };
                }
            }
        }
        return closest ? { npc: closest.npc, island: closest.island } : null;
    }
    handleGoldHoarderInteraction(player) {
        const hoarder = this.getNearbyGoldHoarder(player);
        if (!hoarder)
            return false;
        if (player.carryingChestId) {
            return this.sellCarriedChest(player, hoarder.island);
        }
        return this.grantTreasureMap(player);
    }
    sellCarriedChest(player, island) {
        const found = this.getChestById(player.carryingChestId);
        if (!found || found.chest.opened) {
            player.carryingChestId = null;
            return false;
        }
        const chest = found.chest;
        chest.opened = true;
        chest.carriedByPlayerId = null;
        chest.storedOnShipId = null;
        chest.floating = false;
        player.carryingChestId = null;
        player.gold += chest.value;
        this.broadcast({
            type: 'treasure_sold',
            ts: Date.now(),
            payload: {
                playerId: player.id,
                playerName: player.name,
                chestId: chest.id,
                islandName: island.name,
                gold: chest.value,
                totalGold: player.gold,
            },
        });
        this.grantTreasureMap(player);
        this.checkWinCondition();
        return true;
    }
    grantTreasureMap(player) {
        const isBuriedMapChest = (chest) => chest.buried
            && chest.digProgress < 1
            && !chest.opened
            && !chest.carriedByPlayerId
            && !chest.storedOnShipId
            && !chest.floating;
        const candidates = this.state.islands.filter((island) => island.chests.some(isBuriedMapChest));
        if (candidates.length === 0) {
            player.treasureMapIslandId = null;
            return false;
        }
        const current = player.treasureMapIslandId
            ? candidates.find((island) => island.id === player.treasureMapIslandId)
            : null;
        const target = current ?? candidates
            .map((island) => ({
            island,
            distance: dist2D(player.position.x, player.position.z, island.position.x, island.position.z),
        }))
            .sort((a, b) => a.distance - b.distance)[0].island;
        player.treasureMapIslandId = target.id;
        const client = this.clients.get(player.id);
        if (client) {
            this.send(client.ws, {
                type: 'treasure_map',
                ts: Date.now(),
                payload: {
                    islandId: target.id,
                    islandName: target.name,
                    chestCount: target.chests.filter(isBuriedMapChest).length,
                },
            });
        }
        return true;
    }
    updateKegs(dt) {
        for (const keg of this.state.kegs) {
            const ship = this.syncKegPosition(keg);
            if (!ship || !ship.alive || ship.sinking) {
                keg.timer = 0;
                continue;
            }
            keg.timer -= dt;
            if (keg.timer <= 0) {
                this.explodeKeg(keg);
            }
        }
    }
    explodeKeg(keg) {
        this.syncKegPosition(keg);
        const ship = this.getAliveShip(keg.shipId);
        const attacker = this.getPlayer(keg.plantedById);
        if (ship) {
            const splashSections = ['bow', 'stern', 'port', 'starboard'];
            for (const section of splashSections) {
                const damageRatio = section === keg.section ? SHIP.KEG_PRIMARY_DAMAGE_RATIO : SHIP.KEG_SPLASH_DAMAGE_RATIO;
                this.physics.damageHullSection(ship, section, damageRatio);
            }
            ship.onFire = true;
            ship.fireTimer = Math.max(ship.fireTimer, SHIP.FIRE_DURATION);
        }
        for (const player of this.state.players) {
            if (player.state === 'eliminated' || player.state === 'respawning' || player.respawnProtectionTimer > 0)
                continue;
            const dx = player.position.x - keg.position.x;
            const dy = (player.position.y + PLAYER.HEIGHT * 0.4) - keg.position.y;
            const dz = player.position.z - keg.position.z;
            const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
            if (distance > SHIP.KEG_PLAYER_RADIUS)
                continue;
            const damageScale = 1 - Math.min(1, distance / SHIP.KEG_PLAYER_RADIUS);
            const damage = SHIP.KEG_PLAYER_MIN_DAMAGE + (SHIP.KEG_PLAYER_DAMAGE - SHIP.KEG_PLAYER_MIN_DAMAGE) * Math.pow(damageScale, 1.7);
            player.lastDamagedById = attacker?.id ?? null;
            player.lastDamageWasHeadshot = false;
            player.health -= damage;
            if (attacker) {
                this.notifyPlayerHit(attacker.id, {
                    targetId: player.id,
                    damage,
                    position: {
                        x: player.position.x,
                        y: player.position.y + PLAYER.HEIGHT * 0.72,
                        z: player.position.z,
                    },
                    kill: player.health <= 0,
                    remainingHealth: Math.max(0, player.health),
                    weaponId: 'powder_keg',
                });
            }
            const force = Math.max(3.5, SHIP.KEG_BLAST_FORCE * Math.pow(damageScale, 1.2));
            const inv = distance > 0.001 ? 1 / distance : 0;
            player.knockbackVelocity.x += dx * inv * force;
            player.knockbackVelocity.y += Math.max(2.5, force * 0.55);
            player.knockbackVelocity.z += dz * inv * force;
        }
        this.broadcast({
            type: 'keg_exploded',
            ts: Date.now(),
            payload: {
                position: { ...keg.position },
                radius: SHIP.KEG_PLAYER_RADIUS,
            },
        });
        keg.timer = 0;
    }
    updateFieldRepairs(dt) {
        for (const ship of this.state.ships) {
            if (!ship.alive || ship.sinking)
                continue;
            ship.repairCooldown = Math.max(0, ship.repairCooldown - dt);
            const weakestSection = this.getWeakestHullSection(ship);
            const plankStack = ship.inventory.find((entry) => entry.item === 'wood_plank' && entry.qty > 0);
            if (!ship.anchored || ship.onFire || ship.repairCooldown > 0 || !weakestSection || !plankStack) {
                ship.autoRepairProgress = 0;
                continue;
            }
            ship.autoRepairProgress += dt;
            if (ship.autoRepairProgress < SHIP.FIELD_REPAIR_INTERVAL)
                continue;
            ship.autoRepairProgress = 0;
            if (!this.consumeShipItem(ship, 'wood_plank', 1))
                continue;
            this.physics.repairHullSection(ship, weakestSection, SHIP.FIELD_REPAIR_HP);
        }
    }
    getWeakestHullSection(ship) {
        let weakest = null;
        let weakestValue = Infinity;
        for (const section of ['bow', 'stern', 'port', 'starboard']) {
            if (ship.hull[section] < weakestValue) {
                weakestValue = ship.hull[section];
                weakest = section;
            }
        }
        return weakest && weakestValue < 0.98 ? weakest : null;
    }
    getNearbyKeg(player, ship) {
        let closest = null;
        let closestDistance = SHIP.KEG_DIFFUSE_RANGE;
        for (const keg of this.state.kegs) {
            if (keg.shipId !== ship.id || keg.timer <= 0)
                continue;
            this.syncKegPosition(keg);
            const dx = player.position.x - keg.position.x;
            const dy = player.position.y - keg.position.y;
            const dz = player.position.z - keg.position.z;
            const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
            if (distance < closestDistance) {
                closestDistance = distance;
                closest = keg;
            }
        }
        return closest;
    }
    diffuseKeg(keg) {
        keg.timer = 0;
    }
    getNearbyUpgradeStation(player) {
        for (const island of this.state.islands) {
            for (const station of island.upgradeStations) {
                const dx = player.position.x - station.position.x;
                const dz = player.position.z - station.position.z;
                if (Math.sqrt(dx * dx + dz * dz) < PLAYER.INTERACT_RANGE)
                    return station;
            }
        }
        return null;
    }
    applyShipUpgrade(ship, type) {
        ship.upgrades.push({ type });
        if (type === 'hull_reinforcement') {
            const ratio = SHIP_UPGRADES.HULL_HP_MULT;
            ship.maxHull = Math.round(ship.maxHull * ratio);
            ship.hull.bow = Math.min(1, ship.hull.bow * ratio);
            ship.hull.stern = Math.min(1, ship.hull.stern * ratio);
            ship.hull.port = Math.min(1, ship.hull.port * ratio);
            ship.hull.starboard = Math.min(1, ship.hull.starboard * ratio);
        }
    }
    getKegPlacement(player, ship) {
        if (player.onShipId !== ship.id)
            return null;
        const stats = SHIP_STATS[ship.type];
        const local = this.toShipLocal(player.position, ship);
        if (Math.abs(local.x) > stats.width * 0.42 || Math.abs(local.z) > stats.length * 0.42)
            return null;
        const belowDeck = player.position.y < ship.position.y + stats.height - 0.25;
        const section = Math.abs(local.x) > Math.abs(local.z)
            ? (local.x >= 0 ? 'starboard' : 'port')
            : (local.z >= 0 ? 'bow' : 'stern');
        const clampedLocal = {
            x: Math.max(-stats.width * 0.34, Math.min(stats.width * 0.34, local.x)),
            z: Math.max(-stats.length * 0.34, Math.min(stats.length * 0.34, local.z)),
        };
        const world = this.toShipWorld(clampedLocal.x, clampedLocal.z, ship);
        return {
            section,
            localPosition: {
                x: clampedLocal.x,
                y: belowDeck ? 0.55 : stats.height + 0.14,
                z: clampedLocal.z,
            },
            position: {
                x: world.x,
                y: ship.position.y + (belowDeck ? 0.55 : stats.height + 0.14),
                z: world.z,
            },
        };
    }
    launchPlayerFromCannon(player, ship, aim) {
        const muzzle = this.getCannonMuzzlePosition(ship, player.cannonIndex, aim.yaw, aim.pitch);
        const dir = {
            x: Math.sin(aim.yaw) * Math.cos(aim.pitch),
            y: Math.sin(aim.pitch),
            z: Math.cos(aim.yaw) * Math.cos(aim.pitch),
        };
        this.clearStationFlags(player);
        player.onShipId = null;
        player.cannonBallistic = true;
        player.cannonFlightTimer = SHIP.CANNON_PLAYER_FLIGHT_MAX;
        player.state = 'alive';
        player.position = { ...muzzle };
        player.velocity = {
            x: dir.x * SHIP.CANNON_LAUNCH_SPEED,
            y: dir.y * SHIP.CANNON_LAUNCH_SPEED + SHIP.CANNON_LAUNCH_VERTICAL_BIAS,
            z: dir.z * SHIP.CANNON_LAUNCH_SPEED,
        };
        player.knockbackVelocity = { x: 0, y: 0, z: 0 };
        player.shipBoundaryGraceTimer = PLAYER.SHIP_EXIT_GRACE_TIME + 0.8;
        player.nearShipId = null;
        player.nearChestId = null;
        ship.cannonCooldowns[player.cannonIndex] = Math.max(ship.cannonCooldowns[player.cannonIndex], SHIP.CANNON_RELOAD * 0.75);
    }
    syncKegPosition(keg) {
        const ship = this.getShip(keg.shipId);
        if (!ship)
            return null;
        const world = this.toShipWorld(keg.localPosition.x, keg.localPosition.z, ship);
        keg.position.x = world.x;
        keg.position.y = ship.position.y + keg.localPosition.y;
        keg.position.z = world.z;
        return ship;
    }
    getCannonAim(ship, cannonIndex, yaw, pitch) {
        const stats = SHIP_STATS[ship.type];
        const cannonsPerSide = Math.max(1, stats.cannonCount / 2);
        const broadsideYaw = ship.rotation + (cannonIndex < cannonsPerSide ? Math.PI * 0.5 : -Math.PI * 0.5);
        return {
            yaw: broadsideYaw + Math.max(-SHIP.CANNON_YAW_ARC, Math.min(SHIP.CANNON_YAW_ARC, angleWrap(yaw - broadsideYaw))),
            pitch: Math.max(SHIP.CANNON_PITCH_MIN, Math.min(SHIP.CANNON_PITCH_MAX, pitch)),
        };
    }
    getCannonMuzzlePosition(ship, cannonIndex, yaw, pitch) {
        const stats = SHIP_STATS[ship.type];
        const cannon = this.getCannonDeckPosition(ship, cannonIndex);
        return {
            x: ship.position.x + cannon.x * Math.cos(ship.rotation) + cannon.z * Math.sin(ship.rotation) + Math.sin(yaw) * Math.cos(pitch) * 1.04,
            y: ship.position.y + stats.height + 0.28 + Math.sin(pitch) * 0.32,
            z: ship.position.z + cannon.z * Math.cos(ship.rotation) - cannon.x * Math.sin(ship.rotation) + Math.cos(yaw) * Math.cos(pitch) * 1.04,
        };
    }
    getShipFloorY(position, ship) {
        const stats = SHIP_STATS[ship.type];
        const deckY = ship.position.y + stats.height + 0.1;
        const holdFloor = ship.position.y + 0.35;
        return position.y < deckY - 0.25 ? holdFloor : deckY;
    }
    getAnchorControlLocal(stats) {
        return {
            x: 0,
            z: stats.length * 0.42,
        };
    }
    getSailControlLocal(stats) {
        return getSailStationLocal(stats);
    }
    resolveFirearmHits(shooter, traces) {
        const hitFeedback = new Map();
        const sharkHitFeedback = new Map();
        for (const trace of traces) {
            const playerHit = this.findClosestFirearmHit(shooter, trace);
            const sharkHit = this.findClosestSharkHit(trace);
            let usePlayer = !!playerHit;
            let useShark = !!sharkHit;
            if (playerHit && sharkHit) {
                if (sharkHit.distance < playerHit.distance)
                    usePlayer = false;
                else
                    useShark = false;
            }
            let tracerDistance = trace.range;
            let showImpact = false;
            if (useShark && sharkHit) {
                tracerDistance = sharkHit.distance;
                showImpact = true;
                const damage = trace.damage * SHARK.GUN_DAMAGE_MULT;
                sharkHit.shark.health -= damage;
                const existing = sharkHitFeedback.get(sharkHit.shark.id);
                const position = {
                    x: sharkHit.shark.position.x,
                    y: sharkHit.shark.position.y + 0.35,
                    z: sharkHit.shark.position.z,
                };
                if (existing) {
                    existing.damage += damage;
                    existing.kill = sharkHit.shark.health <= 0;
                    existing.remainingHealth = Math.max(0, sharkHit.shark.health);
                    existing.position = position;
                    existing.weaponId = trace.weaponId;
                }
                else {
                    sharkHitFeedback.set(sharkHit.shark.id, {
                        targetId: sharkHit.shark.id,
                        damage,
                        kill: sharkHit.shark.health <= 0,
                        remainingHealth: Math.max(0, sharkHit.shark.health),
                        position,
                        weaponId: trace.weaponId,
                        targetType: 'shark',
                    });
                }
            }
            else if (usePlayer && playerHit) {
                const hit = playerHit;
                tracerDistance = hit.distance;
                showImpact = true;
                const damage = trace.damage * (hit.headshot ? this.getHeadshotMultiplier(trace.weaponId) : 1);
                const preserveCritical = hit.player.lastDamagedById === shooter.id && hit.player.lastDamageWasHeadshot;
                hit.player.lastDamagedById = shooter.id;
                hit.player.lastDamageWasHeadshot = hit.headshot || preserveCritical;
                hit.player.health -= damage;
                const existing = hitFeedback.get(hit.player.id);
                if (existing) {
                    existing.damage += damage;
                    existing.headshot = existing.headshot || hit.headshot;
                    existing.kill = hit.player.health <= 0;
                    existing.remainingHealth = Math.max(0, hit.player.health);
                    existing.weaponId = existing.weaponId ?? trace.weaponId;
                    existing.position = {
                        x: hit.player.position.x,
                        y: hit.player.position.y + PLAYER.HEIGHT * 0.72,
                        z: hit.player.position.z,
                    };
                }
                else {
                    hitFeedback.set(hit.player.id, {
                        targetId: hit.player.id,
                        damage,
                        headshot: hit.headshot,
                        kill: hit.player.health <= 0,
                        remainingHealth: Math.max(0, hit.player.health),
                        position: {
                            x: hit.player.position.x,
                            y: hit.player.position.y + PLAYER.HEIGHT * 0.72,
                            z: hit.player.position.z,
                        },
                        weaponId: trace.weaponId,
                    });
                }
                if (trace.knockback > 0) {
                    const heavyKnockback = trace.knockback >= 20;
                    const impulse = (heavyKnockback ? 1.18 : 1) * trace.knockback * (hit.headshot ? 1.08 : 1);
                    hit.player.knockbackVelocity.x += trace.direction.x * impulse;
                    hit.player.knockbackVelocity.y += impulse * (heavyKnockback ? 0.62 : 0.4);
                    hit.player.knockbackVelocity.z += trace.direction.z * impulse;
                }
            }
            else {
                const waterImpactDistance = this.getWaterImpactDistance(trace.origin, trace.direction, trace.range);
                if (waterImpactDistance !== null) {
                    tracerDistance = waterImpactDistance;
                    showImpact = true;
                }
            }
            this.spawnHitscanTracer(shooter, trace, tracerDistance, showImpact);
        }
        for (const feedback of hitFeedback.values()) {
            this.awardPlayerHitGold(shooter.id, feedback.damage);
            this.notifyPlayerHit(shooter.id, feedback);
        }
        for (const feedback of sharkHitFeedback.values()) {
            this.notifyPlayerHit(shooter.id, feedback);
        }
    }
    findClosestFirearmHit(shooter, trace) {
        let closest = null;
        for (const target of this.state.players) {
            if (target.id === shooter.id
                || target.state === 'eliminated'
                || target.state === 'respawning'
                || target.respawnProtectionTimer > 0) {
                continue;
            }
            const hit = this.intersectPlayerHitboxes(trace.origin, trace.direction, trace.range, target);
            if (!hit)
                continue;
            if (!closest || hit.distance < closest.distance) {
                closest = { player: target, distance: hit.distance, headshot: hit.headshot };
            }
        }
        return closest;
    }
    findClosestSharkHit(trace) {
        let best = null;
        const r = SHARK.HIT_RADIUS;
        for (const shark of this.state.sharks) {
            if (shark.health <= 0)
                continue;
            const center = { x: shark.position.x, y: shark.position.y + 0.35, z: shark.position.z };
            const t = this.raySphereIntersection(trace.origin, trace.direction, center, r);
            if (t === null || t > trace.range)
                continue;
            if (!best || t < best.distance)
                best = { shark, distance: t };
        }
        return best;
    }
    intersectPlayerHitboxes(origin, direction, range, target) {
        const swimming = target.state === 'swimming';
        const headCenter = {
            x: target.position.x,
            y: target.position.y + (swimming ? 0.52 : PLAYER.HEIGHT * 0.9),
            z: target.position.z,
        };
        const upperBodyCenter = {
            x: target.position.x,
            y: target.position.y + (swimming ? 0.14 : PLAYER.HEIGHT * 0.58),
            z: target.position.z,
        };
        const lowerBodyCenter = {
            x: target.position.x,
            y: target.position.y + (swimming ? -0.12 : PLAYER.HEIGHT * 0.28),
            z: target.position.z,
        };
        const hitboxes = [
            { center: headCenter, radius: swimming ? 0.22 : 0.24, headshot: true },
            { center: upperBodyCenter, radius: swimming ? 0.46 : 0.5, headshot: false },
            { center: lowerBodyCenter, radius: swimming ? 0.34 : 0.38, headshot: false },
        ];
        let closest = null;
        for (const hitbox of hitboxes) {
            const distance = this.raySphereIntersection(origin, direction, hitbox.center, hitbox.radius);
            if (distance === null || distance > range)
                continue;
            if (!closest || distance < closest.distance || (Math.abs(distance - closest.distance) < 0.001 && hitbox.headshot)) {
                closest = { distance, headshot: hitbox.headshot };
            }
        }
        return closest;
    }
    raySphereIntersection(origin, direction, center, radius) {
        const ox = origin.x - center.x;
        const oy = origin.y - center.y;
        const oz = origin.z - center.z;
        const b = ox * direction.x + oy * direction.y + oz * direction.z;
        const c = ox * ox + oy * oy + oz * oz - radius * radius;
        const discriminant = b * b - c;
        if (discriminant < 0)
            return null;
        const sqrtDisc = Math.sqrt(discriminant);
        const near = -b - sqrtDisc;
        const far = -b + sqrtDisc;
        if (near >= 0)
            return near;
        if (far >= 0)
            return far;
        return null;
    }
    spawnHitscanTracer(shooter, trace, distance, showImpact) {
        const clampedDistance = Math.max(0.45, Math.min(trace.range, distance));
        const maxAge = Math.max(0.08, Math.min(0.14, clampedDistance / 260));
        const speed = clampedDistance / maxAge;
        const projectile = {
            id: uuid(),
            type: 'bullet',
            ownerId: shooter.id,
            ownerShipId: shooter.shipId,
            position: { ...trace.origin },
            velocity: {
                x: trace.direction.x * speed,
                y: trace.direction.y * speed,
                z: trace.direction.z * speed,
            },
            alive: true,
            age: 0,
            maxAge,
            damage: 0,
            knockback: 0,
            visualOnly: true,
            showImpact,
        };
        this.weapons.queueProjectile(projectile);
    }
    getWaterImpactDistance(origin, direction, maxDistance) {
        if (origin.y <= 0 || direction.y >= -0.0001)
            return null;
        const distance = origin.y / -direction.y;
        return distance <= maxDistance ? distance : null;
    }
    getFirearmAimPoint(player, ship, input, weaponId) {
        const swimming = player.state === 'swimming';
        const aimingFirearm = !WEAPONS[weaponId].melee && (input.aim || input.fire);
        const scoped = input.aim && !!WEAPONS[weaponId].scopeFov;
        const yaw = player.atHelm && ship ? ship.rotation : input.yaw;
        const pitch = input.pitch;
        const forward = this.normalizeVec3({
            x: Math.sin(yaw) * Math.cos(pitch),
            y: Math.sin(pitch),
            z: Math.cos(yaw) * Math.cos(pitch),
        });
        const cameraPos = {
            x: player.position.x,
            y: player.position.y + (swimming ? PLAYER.HEIGHT * 0.56 : PLAYER.HEIGHT * 0.84),
            z: player.position.z,
        };
        const lookTarget = {
            x: cameraPos.x + forward.x * (scoped ? 64 : aimingFirearm ? 28 : swimming ? 18 : 14),
            y: cameraPos.y + forward.y * (scoped ? 64 : aimingFirearm ? 28 : swimming ? 18 : 14) + (swimming ? -0.04 : scoped ? 0.05 : 0),
            z: cameraPos.z + forward.z * (scoped ? 64 : aimingFirearm ? 28 : swimming ? 18 : 14),
        };
        const rayDir = this.normalizeVec3({
            x: lookTarget.x - cameraPos.x,
            y: lookTarget.y - cameraPos.y,
            z: lookTarget.z - cameraPos.z,
        });
        return {
            x: cameraPos.x + rayDir.x * WEAPONS[weaponId].range,
            y: cameraPos.y + rayDir.y * WEAPONS[weaponId].range,
            z: cameraPos.z + rayDir.z * WEAPONS[weaponId].range,
        };
    }
    getHeadshotMultiplier(weaponId) {
        switch (weaponId) {
            case 'eye_of_reach':
                return 1.65;
            case 'flintlock':
                return 1.45;
            case 'flintknock':
            case 'pistol':
                return 1.35;
            case 'blunderbuss':
                return 1.18;
            default:
                return 1;
        }
    }
    normalizeVec3(vector) {
        const length = Math.hypot(vector.x, vector.y, vector.z) || 1;
        return {
            x: vector.x / length,
            y: vector.y / length,
            z: vector.z / length,
        };
    }
    tryClimbIslandDockFromWater(player) {
        if (player.state !== 'swimming')
            return false;
        for (const island of this.state.islands) {
            if (!island.dock)
                continue;
            const dock = island.dock;
            const dx = player.position.x - dock.position.x;
            const dz = player.position.z - dock.position.z;
            const cos = Math.cos(dock.rotation);
            const sin = Math.sin(dock.rotation);
            const localX = dx * cos + dz * sin;
            const localZ = -dx * sin + dz * cos;
            if (Math.abs(localX) > dock.width * 0.42)
                continue;
            if (localZ > -dock.length * 0.08 || localZ < -dock.length * 0.58)
                continue;
            const targetDist = Math.hypot(localX, localZ + dock.length * 0.34);
            if (targetDist > 4.2)
                continue;
            const top = dockLocalToWorld(dock, 0, 0.55, -dock.length * 0.12);
            player.position.x = top.x;
            player.position.z = top.z;
            player.position.y = dock.position.y + 0.52;
            player.velocity.x = 0;
            player.velocity.y = 0;
            player.velocity.z = 0;
            player.state = 'alive';
            return true;
        }
        return false;
    }
    getMermaidReturnShip(player) {
        if (player.state !== 'swimming' || !player.shipId)
            return null;
        const homeShip = this.getAliveShip(player.shipId);
        if (!homeShip || homeShip.sinking)
            return null;
        const distance = dist2D(player.position.x, player.position.z, homeShip.position.x, homeShip.position.z);
        return distance >= 45 ? homeShip : null;
    }
    returnPlayerByMermaid(player) {
        const homeShip = this.getMermaidReturnShip(player);
        if (!homeShip)
            return false;
        this.dropCarriedChest(player);
        const deckPosition = this.getRespawnDeckPosition(homeShip);
        player.position = deckPosition;
        player.velocity = { x: 0, y: 0, z: 0 };
        player.knockbackVelocity = { x: 0, y: 0, z: 0 };
        player.onShipId = homeShip.id;
        player.state = 'alive';
        player.swimTimer = 0;
        player.shipBoundaryGraceTimer = 0;
        player.cannonFlightTimer = 0;
        player.cannonBallistic = false;
        player.respawnProtectionTimer = Math.max(player.respawnProtectionTimer, 1.5);
        player.nearShipId = null;
        player.nearChestId = null;
        this.clearStationFlags(player);
        this.broadcast({ type: 'player_spawned', ts: Date.now(), payload: { playerId: player.id, shipId: homeShip.id, mermaid: true } });
        return true;
    }
    tryBoardFromLadder(player) {
        if (!player.nearShipId || (player.state !== 'swimming' && player.onShipId !== null))
            return false;
        const targetShip = this.getAliveShip(player.nearShipId);
        if (!targetShip)
            return false;
        const ladder = getNearestShipBoardingLadder(targetShip, player.position);
        if (!ladder)
            return false;
        const stats = SHIP_STATS[targetShip.type];
        player.onShipId = targetShip.id;
        const boardPoint = this.toShipWorld(Math.sign(ladder.localX) * stats.width * 0.34, ladder.localZ + 0.18, targetShip);
        player.position.x = boardPoint.x;
        player.position.z = boardPoint.z;
        player.position.y = targetShip.position.y + stats.height + 0.45;
        player.velocity.y = 0;
        player.state = 'alive';
        this.clearStationFlags(player);
        player.shipBoundaryGraceTimer = 0;
        player.cannonFlightTimer = 0;
        player.cannonBallistic = false;
        if (!targetShip.crewIds.includes(player.id))
            targetShip.crewIds.push(player.id);
        return true;
    }
    /** Resolves [X] to the action the client HUD selected; each branch validates range / state. */
    tryInteractIntent(player, input, ship) {
        const intent = input.interactIntent;
        if (!intent)
            return false;
        switch (intent) {
            case 'barrel': {
                if (!player.nearBarrelId)
                    return false;
                const barrelEvent = this.islands.tryOpenBarrel(player, this.state.islands, this.state.ships);
                if (barrelEvent) {
                    this.broadcast({ type: 'barrel_opened', ts: Date.now(), payload: barrelEvent });
                    return true;
                }
                return false;
            }
            case 'chest': {
                const event = this.tryTakeChest(player);
                if (event) {
                    this.broadcast({ type: 'chest_opened', ts: Date.now(), payload: event });
                    return true;
                }
                return false;
            }
            case 'stow_chest': {
                if (!ship || player.onShipId !== ship.id)
                    return false;
                return this.tryStowCarriedChest(player, ship);
            }
            case 'gold_hoarder':
                return this.handleGoldHoarderInteraction(player);
            case 'board':
                return this.tryBoardFromLadder(player);
            case 'dock':
                return this.tryClimbIslandDockFromWater(player);
            case 'mermaid':
                return this.returnPlayerByMermaid(player);
            case 'keg_diffuse': {
                const keg = ship ? this.getNearbyKeg(player, ship) : null;
                if (!keg)
                    return false;
                this.diffuseKeg(keg);
                return true;
            }
            case 'upgrade': {
                const homeShip = this.getAliveShip(player.shipId);
                const upgradeStation = this.getNearbyUpgradeStation(player);
                if (!upgradeStation
                    || !homeShip
                    || upgradeStation.claimedByShipId === homeShip.id
                    || homeShip.upgrades.some(upgrade => upgrade.type === upgradeStation.type)) {
                    return false;
                }
                upgradeStation.claimedByShipId = homeShip.id;
                this.applyShipUpgrade(homeShip, upgradeStation.type);
                this.broadcast({ type: 'ship_upgraded', ts: Date.now(), payload: { shipId: homeShip.id, type: upgradeStation.type } });
                return true;
            }
            case 'repair': {
                if (!ship || player.onShipId !== ship.id)
                    return false;
                const repairSection = this.getRepairableHullSection(player, ship);
                if (!repairSection || !this.consumeRepairPlank(player, ship))
                    return false;
                this.physics.repairHullSection(ship, repairSection, SHIP.REPAIR_HP);
                if (ship.onFire) {
                    ship.fireTimer = Math.max(0, ship.fireTimer - SHIP.FIRE_REPAIR_DOUSE_TIME);
                    if (ship.fireTimer <= 0) {
                        ship.onFire = false;
                        ship.fireTimer = 0;
                        ship.fireDamageAccum = 0;
                    }
                }
                return true;
            }
            case 'anchor': {
                if (!ship || player.onShipId !== ship.id)
                    return false;
                if (!this.isNearAnchor(player, ship))
                    return false;
                if (!ship.anchored) {
                    ship.anchored = true;
                    ship.anchorRaiseProgress = 0;
                }
                this.clearStationFlags(player);
                return true;
            }
            case 'crow': {
                if (!ship || player.onShipId !== ship.id)
                    return false;
                if (!this.isNearCrowNestLadder(player, ship))
                    return false;
                return this.enterCrowNest(player, ship);
            }
            case 'sails':
            case 'sail_hoist': {
                if (!ship || player.onShipId !== ship.id)
                    return false;
                if (!this.isNearSailStation(player, ship))
                    return false;
                return this.enterSails(player, ship);
            }
            case 'sail_angle': {
                if (!ship || player.onShipId !== ship.id)
                    return false;
                if (!this.isNearSailStation(player, ship))
                    return false;
                return this.enterSails(player, ship);
            }
            case 'helm': {
                if (!ship || player.onShipId !== ship.id)
                    return false;
                if (!this.isNearHelm(player, ship))
                    return false;
                return this.enterHelm(player, ship);
            }
            case 'cannon': {
                if (!ship || player.onShipId !== ship.id)
                    return false;
                const nearbyCannon = this.getNearbyCannonIndex(player, ship);
                if (nearbyCannon === null)
                    return false;
                return this.enterCannon(player, ship, nearbyCannon, input.yaw, input.pitch);
            }
            default:
                return false;
        }
    }
    updateSharks(dt) {
        const { sharks, players, islands } = this.state;
        this.sharkSpawnCooldown = Math.max(0, this.sharkSpawnCooldown - dt);
        if (sharks.length < SHARK.MAX_WORLD && this.sharkSpawnCooldown <= 0 && Math.random() < SHARK.SPAWN_CHANCE_PER_TICK) {
            const swimmers = players.filter(p => p.state === 'swimming' && p.swimTimer >= SHARK.SPAWN_SWIM_GRACE);
            if (swimmers.length) {
                const p = swimmers[Math.floor(Math.random() * swimmers.length)];
                const ang = Math.random() * Math.PI * 2;
                const dist = randRange(SHARK.SPAWN_MIN_DIST, SHARK.SPAWN_MAX_DIST);
                const x = p.position.x + Math.sin(ang) * dist;
                const z = p.position.z + Math.cos(ang) * dist;
                if (Math.abs(x) < WORLD.HALF - 24 && Math.abs(z) < WORLD.HALF - 24) {
                    let blocked = false;
                    for (const island of islands) {
                        if (isPointInsideIslandFootprint(island, x, z, 2.8)) {
                            blocked = true;
                            break;
                        }
                    }
                    for (const shark of sharks) {
                        if (dist2D(shark.position.x, shark.position.z, x, z) < SHARK.SPAWN_MIN_DIST) {
                            blocked = true;
                            break;
                        }
                    }
                    if (!blocked) {
                        sharks.push({
                            id: uuid(),
                            position: { x, y: 0.38, z },
                            rotation: 0,
                            velocity: { x: 0, y: 0, z: 0 },
                            health: SHARK.HEALTH,
                            biteCooldown: 1.2,
                            targetId: p.id,
                        });
                        this.sharkSpawnCooldown = randRange(SHARK.SPAWN_COOLDOWN_MIN, SHARK.SPAWN_COOLDOWN_MAX);
                    }
                }
            }
        }
        for (let i = sharks.length - 1; i >= 0; i--) {
            const s = sharks[i];
            if (s.health <= 0) {
                sharks.splice(i, 1);
                continue;
            }
            s.biteCooldown = Math.max(0, s.biteCooldown - dt);
            let target = this.getPlayer(s.targetId);
            if (target?.state !== 'swimming')
                target = null;
            if (!target) {
                const candidates = players.filter(pl => pl.state === 'swimming');
                target = candidates
                    .map(pl => ({
                    pl,
                    d: dist2D(pl.position.x, pl.position.z, s.position.x, s.position.z),
                }))
                    .sort((a, b) => a.d - b.d)[0]?.pl ?? null;
                s.targetId = target?.id ?? null;
            }
            if (!target) {
                s.velocity.x *= 0.92;
                s.velocity.z *= 0.92;
                s.position.x += s.velocity.x * dt;
                s.position.z += s.velocity.z * dt;
                continue;
            }
            const dx = target.position.x - s.position.x;
            const dz = target.position.z - s.position.z;
            const d = Math.sqrt(dx * dx + dz * dz) || 1;
            s.rotation = Math.atan2(dx, dz);
            const sp = SHARK.CHASE_SPEED;
            s.velocity.x = (dx / d) * sp;
            s.velocity.z = (dz / d) * sp;
            s.position.x += s.velocity.x * dt;
            s.position.z += s.velocity.z * dt;
            s.position.y = 0.38;
            if (d < SHARK.BITE_RANGE && s.biteCooldown <= 0) {
                target.health -= SHARK.BITE_DAMAGE;
                target.lastDamagedById = null;
                target.lastDamageWasHeadshot = false;
                s.biteCooldown = SHARK.BITE_COOLDOWN;
            }
        }
    }
    startShipSinking(ship, rapid = false) {
        if (!ship.alive || ship.sinking)
            return;
        this.dropShipTreasure(ship);
        ship.sinking = true;
        ship.anchored = true;
        ship.anchorRaiseProgress = 0;
        ship.sailHeight = 0;
        ship.sailAngle = 0;
        ship.onFire = false;
        ship.fireTimer = 0;
        ship.fireDamageAccum = 0;
        ship.chainshottedUntil = 0;
        ship.sailIntegrity = Math.min(ship.sailIntegrity, 0.12);
        ship.velocity.x *= 0.3;
        ship.velocity.y = 0;
        ship.velocity.z *= 0.3;
        ship.angularVelocity *= 0.35;
        ship.sinkProgress = Math.max(ship.sinkProgress, rapid ? 0.22 : 0);
        ship.hull.bow = Math.min(ship.hull.bow, 0.04);
        ship.hull.stern = Math.min(ship.hull.stern, 0.04);
        ship.hull.port = Math.min(ship.hull.port, 0.04);
        ship.hull.starboard = Math.min(ship.hull.starboard, 0.04);
        for (const player of this.state.players) {
            if (player.onShipId !== ship.id || player.state === 'eliminated' || player.state === 'respawning' || player.health <= 0) {
                continue;
            }
            player.onShipId = null;
            player.state = 'swimming';
            this.dropCarriedChest(player);
            this.clearStationFlags(player);
            player.nearShipId = null;
            player.nearChestId = null;
            player.swimTimer = 0;
            player.shipBoundaryGraceTimer = 0;
            player.cannonFlightTimer = 0;
            player.cannonBallistic = false;
            player.velocity.y = Math.max(player.velocity.y, rapid ? 4 : 3);
            player.knockbackVelocity = {
                x: (Math.random() - 0.5) * (rapid ? 7 : 5),
                y: rapid ? 5.5 : 4.2,
                z: (Math.random() - 0.5) * (rapid ? 7 : 5),
            };
        }
        ship.crewIds = [];
        this.state.kegs = this.state.kegs.filter((keg) => keg.shipId !== ship.id);
    }
    dropShipTreasure(ship) {
        if (ship.treasureChestIds.length === 0)
            return;
        const chestIds = [...ship.treasureChestIds];
        const stats = SHIP_STATS[ship.type];
        chestIds.forEach((chestId, index) => {
            const found = this.getChestById(chestId);
            if (!found || found.chest.opened)
                return;
            const chest = found.chest;
            const angle = ship.rotation + (index / Math.max(1, chestIds.length)) * Math.PI * 2;
            const scatter = stats.width * 0.45 + 1.2 + (index % 3) * 0.8;
            chest.carriedByPlayerId = null;
            chest.storedOnShipId = null;
            chest.floating = true;
            chest.position = {
                x: ship.position.x + Math.sin(angle) * scatter,
                y: 0.45,
                z: ship.position.z + Math.cos(angle) * scatter,
            };
        });
        ship.treasureChestIds = [];
    }
    isBoardingKill(killer, victim) {
        return !!killer.shipId
            && !!victim.shipId
            && killer.shipId !== victim.shipId
            && killer.onShipId === victim.shipId;
    }
    /** Home ship must be afloat and inside the storm safe circle for respawn / mid-respawn validity. */
    isShipInStormSafeZone(ship) {
        if (!ship.alive || ship.sinking)
            return false;
        const d = dist2D(ship.position.x, ship.position.z, this.state.storm.centerX, this.state.storm.centerZ);
        return d <= this.state.storm.safeRadius - 35;
    }
    applyEliminatedPlayerFields(player) {
        this.dropCarriedChest(player);
        player.health = 0;
        player.respawnTimer = 0;
        player.respawnProtectionTimer = 0;
        player.shipBoundaryGraceTimer = 0;
        player.onShipId = null;
        this.clearStationFlags(player);
        player.nearShipId = null;
        player.nearChestId = null;
        player.velocity = { x: 0, y: 0, z: 0 };
        player.knockbackVelocity = { x: 0, y: 0, z: 0 };
        player.swimTimer = 0;
        player.cannonFlightTimer = 0;
        player.cannonBallistic = false;
        player.lastDamageWasHeadshot = false;
    }
    /** Eliminate other crew on the same ship, then sink it (caller must already have marked one player eliminated). */
    eliminateRemainingCrewAndSinkShip(ship, alreadyEliminatedPlayerId) {
        for (const p of this.state.players) {
            if (p.shipId !== ship.id)
                continue;
            if (p.id === alreadyEliminatedPlayerId)
                continue;
            if (p.state === 'eliminated')
                continue;
            p.state = 'eliminated';
            this.applyEliminatedPlayerFields(p);
            if (p.isBot) {
                this.bots.removeBot(p.id);
            }
            else {
                const client = this.clients.get(p.id);
                if (client) {
                    this.send(client.ws, {
                        type: 'game_over',
                        ts: Date.now(),
                        payload: { winnerId: null, died: true, kills: p.kills, gold: p.gold },
                    });
                }
            }
        }
        this.startShipSinking(ship, true);
    }
    handlePlayerDeath(player) {
        let killer = player.lastDamagedById
            ? this.getPlayer(player.lastDamagedById)
            : null;
        if (killer?.id === player.id)
            killer = null;
        const headshot = !!killer && player.lastDamageWasHeadshot;
        const boardingKill = !!killer && this.isBoardingKill(killer, player);
        let stolenGold = 0;
        let healed = 0;
        this.dropCarriedChest(player);
        if (killer) {
            killer.kills += 1;
            killer.gold += PLAYER.KILL_GOLD_REWARD + (headshot ? PLAYER.HEADSHOT_GOLD_BONUS : 0);
            if (boardingKill) {
                const previousHealth = killer.health;
                stolenGold = Math.min(player.gold, PLAYER.BOARDING_GOLD_STEAL_CAP);
                if (stolenGold > 0) {
                    player.gold -= stolenGold;
                    killer.gold += stolenGold;
                }
                killer.health = Math.min(PLAYER.MAX_HEALTH, killer.health + PLAYER.BOARDING_KILL_HEAL);
                healed = Math.max(0, killer.health - previousHealth);
            }
        }
        const occupiedShip = this.state.ships.find(s => s.crewIds.includes(player.id) && s.alive);
        if (occupiedShip) {
            occupiedShip.crewIds = occupiedShip.crewIds.filter(id => id !== player.id);
        }
        const homeShip = this.getAliveShip(player.shipId);
        const canRespawn = !!homeShip && this.isShipInStormSafeZone(homeShip);
        if (canRespawn) {
            player.state = 'respawning';
            player.health = 0;
            player.respawnTimer = PLAYER.RESPAWN_TIME;
            player.respawnProtectionTimer = 0;
            player.shipBoundaryGraceTimer = 0;
            player.onShipId = null;
            this.clearStationFlags(player);
            player.nearShipId = null;
            player.nearChestId = null;
            player.velocity = { x: 0, y: 0, z: 0 };
            player.knockbackVelocity = { x: 0, y: 0, z: 0 };
            player.swimTimer = 0;
            player.cannonFlightTimer = 0;
            player.cannonBallistic = false;
            player.lastDamageWasHeadshot = false;
        }
        else {
            player.state = 'eliminated';
            this.applyEliminatedPlayerFields(player);
        }
        if (player.state === 'eliminated' && player.shipId) {
            const shipToDestroy = this.getAliveShip(player.shipId);
            if (shipToDestroy) {
                this.eliminateRemainingCrewAndSinkShip(shipToDestroy, player.id);
            }
        }
        if (player.isBot && player.state === 'eliminated') {
            this.bots.removeBot(player.id);
        }
        else if (!player.isBot && player.state === 'eliminated') {
            const client = this.clients.get(player.id);
            if (client) {
                this.send(client.ws, {
                    type: 'game_over',
                    ts: Date.now(),
                    payload: { winnerId: null, died: true, kills: player.kills, gold: player.gold },
                });
            }
        }
        this.broadcast({
            type: 'kill_event',
            ts: Date.now(),
            payload: {
                victimId: player.id,
                victimName: player.name,
                killerId: killer?.id ?? null,
                killerName: killer?.name ?? null,
                respawning: player.state === 'respawning',
                headshot,
                boardingKill,
                stolenGold,
                healed,
            },
        });
    }
    checkWinCondition() {
        if (this.state.phase !== 'playing')
            return;
        const goldWinner = this.state.players.find((player) => !player.isBot
            && player.state !== 'eliminated'
            && player.gold >= ECONOMY.GOLD_WIN_TARGET);
        if (goldWinner) {
            this.state.phase = 'ended';
            this.state.winnerId = goldWinner.id;
            this.broadcast({
                type: 'game_over',
                ts: Date.now(),
                payload: {
                    winnerId: this.state.winnerId,
                    reason: 'gold',
                    gold: goldWinner.gold,
                    targetGold: ECONOMY.GOLD_WIN_TARGET,
                },
            });
            return;
        }
        const aliveShips = this.state.ships.filter((ship) => ship.alive && !ship.sinking);
        this.state.shipsAlive = aliveShips.length;
        if (aliveShips.length <= 1 && this.state.ships.length > 1) {
            this.state.phase = 'ended';
            this.state.winnerId = aliveShips[0]?.ownerId ?? null;
            this.broadcast({ type: 'game_over', ts: Date.now(), payload: { winnerId: this.state.winnerId } });
        }
    }
    buildSnapshot() {
        return {
            ...this.state,
            projectiles: this.state.projectiles.filter(p => p.alive),
            kegs: this.state.kegs.filter((keg) => keg.timer > 0),
        };
    }
    relayPendingCombatEvents() {
        for (const event of this.physics.flushCombatEvents()) {
            if (event.type === 'player_hit') {
                this.awardPlayerHitGold(event.attackerId, event.damage);
                this.notifyPlayerHit(event.attackerId, {
                    targetId: event.targetId,
                    damage: event.damage,
                    position: event.position,
                    kill: event.kill,
                    remainingHealth: Math.max(0, this.getPlayer(event.targetId)?.health ?? 0),
                    weaponId: event.projectileType,
                });
            }
            else {
                this.notifyShipHit(event.attackerId, {
                    targetId: event.targetId,
                    damage: event.damage,
                    position: event.position,
                    section: event.section,
                    remainingSection: event.remainingSection,
                    remainingHull: event.remainingHull,
                    shipHealthMilestone: event.milestone,
                    weaponId: event.projectileType,
                });
            }
        }
    }
    awardPlayerHitGold(attackerId, damage) {
        if (!attackerId || damage <= 0)
            return;
        const attacker = this.getPlayer(attackerId);
        if (!attacker || attacker.state === 'eliminated')
            return;
        const raw = Math.round(damage * ECONOMY.PLAYER_HIT_GOLD_RATIO);
        const award = Math.max(ECONOMY.PLAYER_HIT_GOLD_MIN, Math.min(ECONOMY.PLAYER_HIT_GOLD_MAX, raw));
        attacker.gold += award;
        this.checkWinCondition();
    }
    notifyPlayerHit(attackerId, payload) {
        const client = this.clients.get(attackerId);
        if (!client)
            return;
        this.send(client.ws, {
            type: 'player_hit',
            ts: Date.now(),
            payload,
        });
    }
    notifyShipHit(attackerId, payload) {
        const client = this.clients.get(attackerId);
        if (!client)
            return;
        this.send(client.ws, {
            type: 'ship_hit',
            ts: Date.now(),
            payload,
        });
    }
    broadcast(msg) {
        const data = JSON.stringify(msg);
        for (const [, client] of this.clients) {
            if (client.ws.readyState === WebSocket.OPEN) {
                client.ws.send(data);
            }
        }
    }
    send(ws, msg) {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(msg));
        }
    }
    processBotLooting() {
        for (const player of this.state.players) {
            if (!player.isBot || player.shipId === null || !player.nearChestId || player.state === 'eliminated')
                continue;
            for (const island of this.state.islands) {
                const chest = island.chests.find((c) => c.id === player.nearChestId);
                if (chest && chest.buried && chest.digProgress < 1)
                    chest.digProgress = 1;
            }
            const event = this.tryTakeChest(player);
            if (event) {
                this.broadcast({ type: 'chest_opened', ts: Date.now(), payload: event });
            }
        }
    }
    spawnIslandSkeletons(players, islands) {
        let skeletonIndex = 1;
        for (const island of islands) {
            const skeletonCount = island.radius > 72 ? 2 : island.radius > 54 ? 1 : 0;
            for (let i = 0; i < skeletonCount; i++) {
                const skeletonId = uuid();
                const skeleton = this.createPlayer(skeletonId, `Skeleton_${skeletonIndex++}`, null, true);
                skeleton.health = 70;
                skeleton.weapons = [
                    { weaponId: 'cutlass', ammo: 0, reserve: 0, reloading: false, reloadTimer: 0 },
                    null,
                    null,
                    null,
                ];
                skeleton.activeSlot = 0;
                const angle = randAngle();
                const spawnPoint = getIslandSurfacePoint(island, 0.22 + Math.random() * 0.28, angle, 0.06);
                skeleton.position = spawnPoint;
                skeleton.rotation.x = angle + Math.PI;
                skeleton.rotation.y = 0;
                players.push(skeleton);
                this.skeletonHomes.set(skeletonId, island.id);
            }
        }
    }
    updateIslandSkeletons(dt) {
        for (const skeleton of this.state.players) {
            if (!skeleton.isBot || skeleton.shipId !== null || skeleton.state === 'eliminated' || skeleton.state === 'respawning') {
                continue;
            }
            const homeIslandId = this.skeletonHomes.get(skeleton.id);
            const island = this.state.islands.find(candidate => candidate.id === homeIslandId);
            if (!island)
                continue;
            skeleton.onShipId = null;
            this.clearStationFlags(skeleton);
            skeleton.nearChestId = null;
            skeleton.nearShipId = null;
            skeleton.state = 'alive';
            const target = this.state.players
                .filter(candidate => !candidate.isBot
                && candidate.state !== 'eliminated'
                && candidate.state !== 'respawning'
                && dist2D(candidate.position.x, candidate.position.z, skeleton.position.x, skeleton.position.z) < 22)
                .sort((a, b) => dist2D(a.position.x, a.position.z, skeleton.position.x, skeleton.position.z)
                - dist2D(b.position.x, b.position.z, skeleton.position.x, skeleton.position.z))[0] ?? null;
            if (target) {
                const dx = target.position.x - skeleton.position.x;
                const dz = target.position.z - skeleton.position.z;
                const distance = Math.sqrt(dx * dx + dz * dz) || 1;
                skeleton.rotation.x = Math.atan2(dx, dz);
                skeleton.rotation.y = 0;
                if (distance > 2.0) {
                    // Skeletons sprint at 38% player speed — fast enough to be threatening
                    const moveSpeed = PLAYER.MOVE_SPEED * 0.38;
                    const nextX = skeleton.position.x + (dx / distance) * moveSpeed * dt;
                    const nextZ = skeleton.position.z + (dz / distance) * moveSpeed * dt;
                    if (isPointInsideIslandFootprint(island, nextX, nextZ, 1.4)) {
                        skeleton.position.x = nextX;
                        skeleton.position.z = nextZ;
                        skeleton.velocity.x = (dx / distance) * moveSpeed;
                        skeleton.velocity.z = (dz / distance) * moveSpeed;
                    }
                }
                else {
                    skeleton.velocity.x = 0;
                    skeleton.velocity.z = 0;
                    const weapon = skeleton.weapons[skeleton.activeSlot];
                    if (weapon && !weapon.reloading) {
                        const hits = this.weapons.tryMeleeAttack(skeleton, [target], skeleton.rotation.x);
                        for (const hit of hits) {
                            target.lastDamagedById = skeleton.id;
                            target.lastDamageWasHeadshot = false;
                            // 65% weapon damage — skeletons are a real threat now
                            target.health -= hit.damage * 0.65;
                            const len = Math.sqrt(dx * dx + dz * dz) || 1;
                            target.knockbackVelocity.x += (dx / len) * hit.knockback * 0.72;
                            target.knockbackVelocity.y += hit.knockback * 0.18;
                            target.knockbackVelocity.z += (dz / len) * hit.knockback * 0.72;
                        }
                        weapon.reloading = true;
                        weapon.reloadTimer = WEAPONS.cutlass.reloadTime * 1.5;
                    }
                }
            }
            else {
                const roamSeed = skeleton.id.charCodeAt(0) * 0.17 + skeleton.id.charCodeAt(skeleton.id.length - 1) * 0.11;
                const patrolAngle = (this.t * 0.22 + roamSeed) % (Math.PI * 2);
                const patrolRadius = 0.2 + ((Math.sin(this.t * 0.13 + roamSeed) + 1) * 0.5) * 0.24;
                const patrolPoint = getIslandSurfacePoint(island, patrolRadius, patrolAngle, 0.04);
                const dx = patrolPoint.x - skeleton.position.x;
                const dz = patrolPoint.z - skeleton.position.z;
                const distance = Math.sqrt(dx * dx + dz * dz) || 1;
                if (distance > 0.35) {
                    const moveSpeed = PLAYER.MOVE_SPEED * 0.18;
                    skeleton.position.x += (dx / distance) * moveSpeed * dt;
                    skeleton.position.z += (dz / distance) * moveSpeed * dt;
                    skeleton.velocity.x = (dx / distance) * moveSpeed;
                    skeleton.velocity.z = (dz / distance) * moveSpeed;
                    skeleton.rotation.x = Math.atan2(dx, dz);
                }
                else {
                    skeleton.velocity.x = 0;
                    skeleton.velocity.z = 0;
                }
            }
            skeleton.position.y = getIslandSurfaceY(island, skeleton.position.x, skeleton.position.z);
        }
    }
    handleTradeAction(playerId, payload) {
        let session = null;
        switch (payload.action) {
            case 'offer':
                session = this.trading.setOffer(payload.sessionId, playerId, payload.offer ?? [], this.state.tradeSessions, this.state.ships, this.state.players);
                if (session) {
                    this.broadcast({ type: 'trade_update', ts: Date.now(), payload: session });
                }
                break;
            case 'confirm':
                session = this.trading.confirmTrade(payload.sessionId, playerId, this.state.tradeSessions);
                if (session) {
                    this.broadcast({ type: 'trade_update', ts: Date.now(), payload: session });
                }
                break;
            case 'cancel': {
                const event = this.trading.cancelTrade(payload.sessionId, playerId, this.state.tradeSessions);
                if (event) {
                    this.broadcast({ type: 'trade_result', ts: Date.now(), payload: event });
                }
                break;
            }
        }
    }
    updateRespawns(dt) {
        for (const player of this.state.players) {
            if (player.state !== 'respawning')
                continue;
            const homeShip = this.getAliveShip(player.shipId);
            if (!homeShip) {
                player.state = 'eliminated';
                this.applyEliminatedPlayerFields(player);
                if (player.isBot) {
                    this.bots.removeBot(player.id);
                }
                else {
                    const client = this.clients.get(player.id);
                    if (client) {
                        this.send(client.ws, {
                            type: 'game_over',
                            ts: Date.now(),
                            payload: { winnerId: null, died: true, kills: player.kills, gold: player.gold },
                        });
                    }
                }
                continue;
            }
            if (!this.isShipInStormSafeZone(homeShip)) {
                player.state = 'eliminated';
                this.applyEliminatedPlayerFields(player);
                this.eliminateRemainingCrewAndSinkShip(homeShip, player.id);
                if (player.isBot) {
                    this.bots.removeBot(player.id);
                }
                else {
                    const client = this.clients.get(player.id);
                    if (client) {
                        this.send(client.ws, {
                            type: 'game_over',
                            ts: Date.now(),
                            payload: { winnerId: null, died: true, kills: player.kills, gold: player.gold },
                        });
                    }
                }
                continue;
            }
            player.respawnTimer -= dt;
            if (player.respawnTimer > 0)
                continue;
            const respawnPlan = this.getRespawnPlan(homeShip);
            player.state = 'alive';
            player.health = PLAYER.RESPAWN_HEALTH;
            player.onShipId = respawnPlan.onShipId;
            player.position = respawnPlan.position;
            player.velocity = { x: 0, y: 0, z: 0 };
            player.knockbackVelocity = { x: 0, y: 0, z: 0 };
            this.clearStationFlags(player);
            player.nearChestId = null;
            player.nearShipId = null;
            player.lastDamagedById = null;
            player.lastDamageWasHeadshot = false;
            player.respawnTimer = 0;
            player.swimTimer = 0;
            player.cannonFlightTimer = 0;
            player.cannonBallistic = false;
            player.respawnProtectionTimer = respawnPlan.protectionTime;
            player.shipBoundaryGraceTimer = 0;
            if (respawnPlan.dock) {
                this.parkShipAtDock(homeShip, respawnPlan.dock);
            }
            if (!homeShip.crewIds.includes(player.id)) {
                homeShip.crewIds.push(player.id);
            }
            this.broadcast({ type: 'player_spawned', ts: Date.now(), payload: { playerId: player.id, shipId: homeShip.id } });
        }
    }
    getNearbyCannonIndex(player, ship) {
        if (player.onShipId !== ship.id)
            return null;
        const stats = SHIP_STATS[ship.type];
        const local = this.toShipLocal(player.position, ship);
        const cannonOffsetX = stats.width * 0.5 + 0.1;
        const cannonReach = 1.1;
        const maxDeckZ = stats.length * 0.35;
        if (Math.abs(local.z) > maxDeckZ)
            return null;
        if (Math.abs(Math.abs(local.x) - cannonOffsetX) > cannonReach)
            return null;
        const cannonsPerSide = Math.max(1, stats.cannonCount / 2);
        const minZ = -stats.length * 0.3;
        const maxZ = stats.length * 0.2;
        const span = Math.max(0.001, maxZ - minZ);
        const normalized = Math.max(0, Math.min(1, (maxZ - local.z) / span));
        const slotWithinSide = cannonsPerSide === 1
            ? 0
            : Math.round(normalized * (cannonsPerSide - 1));
        const sideOffset = local.x >= 0 ? 0 : cannonsPerSide;
        return sideOffset + slotWithinSide;
    }
    isNearHelm(player, ship) {
        if (player.onShipId !== ship.id)
            return false;
        const local = this.toShipLocal(player.position, ship);
        return Math.abs(local.x) < 0.9 && Math.abs(local.z + SHIP_STATS[ship.type].length * 0.37) < 1.15;
    }
    isNearSailStation(player, ship) {
        if (player.onShipId !== ship.id)
            return false;
        const stats = SHIP_STATS[ship.type];
        if (player.position.y < ship.position.y + stats.height - 0.35)
            return false;
        const local = this.toShipLocal(player.position, ship);
        const station = this.getSailControlLocal(stats);
        return Math.abs(local.x - station.x) < 0.78 && Math.abs(local.z - station.z) < 0.92;
    }
    isNearAnchor(player, ship) {
        if (player.onShipId !== ship.id)
            return false;
        const local = this.toShipLocal(player.position, ship);
        const anchor = this.getAnchorControlLocal(SHIP_STATS[ship.type]);
        return Math.abs(local.x - anchor.x) < 0.95 && Math.abs(local.z - anchor.z) < 1.0;
    }
    snapPlayerToHelm(player, ship) {
        const stats = SHIP_STATS[ship.type];
        const local = { x: 0, z: -stats.length * 0.37 };
        const cos = Math.cos(ship.rotation);
        const sin = Math.sin(ship.rotation);
        player.position.x = ship.position.x + local.x * cos + local.z * sin;
        player.position.z = ship.position.z + local.z * cos - local.x * sin;
        player.position.y = ship.position.y + stats.height + 0.1;
    }
    snapPlayerToSails(player, ship) {
        const stats = SHIP_STATS[ship.type];
        const local = this.getSailControlLocal(stats);
        const world = this.toShipWorld(local.x, local.z, ship);
        player.position.x = world.x;
        player.position.z = world.z;
        player.position.y = ship.position.y + stats.height + 0.1;
    }
    isNearCrowNestLadder(player, ship) {
        if (player.onShipId !== ship.id)
            return false;
        const stats = SHIP_STATS[ship.type];
        const local = this.toShipLocal(player.position, ship);
        const { mastZ, maxAbsX, maxAbsZ } = getCrowNestLadderInteractionBounds(stats);
        const deckY = ship.position.y + stats.height + 0.1;
        return Math.abs(local.x) < maxAbsX
            && Math.abs(local.z - mastZ) < maxAbsZ
            && player.position.y >= deckY - 0.35
            && player.position.y < deckY + stats.height * 4.2;
    }
    snapPlayerToCrowNest(player, ship) {
        const stats = SHIP_STATS[ship.type];
        const mastZ = getMainMastLocalZ(stats);
        const world = this.toShipWorld(0, mastZ, ship);
        player.position.x = world.x;
        player.position.z = world.z;
        player.position.y = ship.position.y + getCrowNestStandingY(stats);
    }
    getRepairableHullSection(player, ship) {
        if (this.getRepairPlankCount(player, ship) <= 0)
            return null;
        const local = this.toShipLocal(player.position, ship);
        const candidate = Math.abs(local.x) > Math.abs(local.z)
            ? (local.x >= 0 ? 'starboard' : 'port')
            : (local.z >= 0 ? 'bow' : 'stern');
        const closeEnough = candidate === 'bow' || candidate === 'stern'
            ? Math.abs(local.z) > SHIP_STATS[ship.type].length * 0.34
            : Math.abs(local.x) > SHIP_STATS[ship.type].width * 0.38;
        if (!closeEnough)
            return null;
        return ship.hull[candidate] < 0.98 ? candidate : null;
    }
    getRepairPlankCount(player, ship) {
        const shipPlanks = ship.inventory.find(entry => entry.item === 'wood_plank')?.qty ?? 0;
        return player.pocketWood + shipPlanks;
    }
    consumeRepairPlank(player, ship) {
        if (player.pocketWood > 0) {
            player.pocketWood -= 1;
            return true;
        }
        return this.consumeShipItem(ship, 'wood_plank', 1);
    }
    consumeShipItem(ship, item, qty) {
        const stack = ship.inventory.find(entry => entry.item === item && entry.qty >= qty);
        if (!stack)
            return false;
        stack.qty -= qty;
        if (stack.qty <= 0) {
            ship.inventory = ship.inventory.filter(entry => entry !== stack);
        }
        return true;
    }
    snapPlayerToCannon(player, ship, cannonIndex) {
        const local = this.getCannonDeckPosition(ship, cannonIndex);
        const cos = Math.cos(ship.rotation);
        const sin = Math.sin(ship.rotation);
        player.position.x = ship.position.x + local.x * cos + local.z * sin;
        player.position.z = ship.position.z + local.z * cos - local.x * sin;
        player.position.y = ship.position.y + SHIP_STATS[ship.type].height + 0.1;
    }
    getCannonDeckPosition(ship, cannonIndex) {
        const stats = SHIP_STATS[ship.type];
        const cannonsPerSide = Math.max(1, stats.cannonCount / 2);
        const side = cannonIndex < cannonsPerSide ? 0 : 1;
        const slotWithinSide = cannonIndex % cannonsPerSide;
        const cannonSpacing = cannonsPerSide <= 1
            ? 0
            : stats.length * 0.5 / (cannonsPerSide - 1);
        const z = stats.length * 0.2 - slotWithinSide * cannonSpacing;
        const x = (side === 0 ? 1 : -1) * (stats.width * 0.5 - 0.65);
        return { x, z };
    }
    getRespawnDeckPosition(ship) {
        const stats = SHIP_STATS[ship.type];
        const local = {
            x: 0,
            z: -stats.length * 0.12,
        };
        const cos = Math.cos(ship.rotation);
        const sin = Math.sin(ship.rotation);
        return {
            x: ship.position.x + local.x * cos + local.z * sin,
            y: ship.position.y + stats.height + 0.18,
            z: ship.position.z + local.z * cos - local.x * sin,
        };
    }
    getRespawnPlan(homeShip) {
        return {
            position: this.getRespawnDeckPosition(homeShip),
            onShipId: homeShip.id,
            protectionTime: PLAYER.RESPAWN_PROTECTION_TIME + 1.5,
            dock: null,
        };
    }
    parkShipAtDock(ship, dock) {
        const stats = SHIP_STATS[ship.type];
        const rightX = Math.cos(dock.rotation);
        const rightZ = -Math.sin(dock.rotation);
        const lateralOffset = dock.moorSide * (dock.width * 0.5 + stats.width * 0.62 + 0.8);
        ship.position.x = dock.position.x + rightX * lateralOffset;
        ship.position.z = dock.position.z + rightZ * lateralOffset;
        ship.rotation = dock.berthRotation;
        ship.velocity = { x: 0, y: 0, z: 0 };
        ship.angularVelocity = 0;
        ship.anchored = true;
        ship.anchorRaiseProgress = 0;
        ship.sailHeight = 0;
        ship.sailAngle = 0;
        ship.onFire = false;
        ship.fireTimer = 0;
        ship.fireDamageAccum = 0;
        ship.chainshottedUntil = 0;
        ship.sailIntegrity = 1;
        ship.sailRepairWoodTimer = 0;
        ship.sinking = false;
        ship.sinkProgress = 0;
        ship.repairCooldown = 0;
        ship.autoRepairProgress = 0;
        ship.hull.bow = Math.max(ship.hull.bow, 0.5);
        ship.hull.stern = Math.max(ship.hull.stern, 0.5);
        ship.hull.port = Math.max(ship.hull.port, 0.5);
        ship.hull.starboard = Math.max(ship.hull.starboard, 0.5);
    }
    armShipExitGrace(player, ship, input) {
        if (!input.jumpPressed || player.atHelm || player.atCannon || player.atSails || player.atCrowNest || player.onShipId !== ship.id)
            return;
        const moveX = (input.right ? 1 : 0) - (input.left ? 1 : 0);
        const moveZ = (input.forward ? 1 : 0) - (input.back ? 1 : 0);
        if (moveX === 0 && moveZ === 0)
            return;
        const local = this.toShipLocal(player.position, ship);
        const stats = SHIP_STATS[ship.type];
        const nearSideRail = Math.abs(local.x) > stats.width * 0.35;
        const nearEndRail = Math.abs(local.z) > stats.length * 0.36;
        if (!nearSideRail && !nearEndRail)
            return;
        const len = Math.sqrt(moveX * moveX + moveZ * moveZ) || 1;
        const nx = moveX / len;
        const nz = moveZ / len;
        const cosY = Math.cos(input.yaw);
        const sinY = Math.sin(input.yaw);
        const worldMoveX = (sinY * nz + cosY * nx);
        const worldMoveZ = (cosY * nz - sinY * nx);
        const cos = Math.cos(ship.rotation);
        const sin = Math.sin(ship.rotation);
        const localMoveX = worldMoveX * cos - worldMoveZ * sin;
        const localMoveZ = worldMoveX * sin + worldMoveZ * cos;
        const movingOutPortStarboard = nearSideRail
            && Math.sign(localMoveX) === Math.sign(local.x)
            && Math.abs(localMoveX) > 0.25;
        const movingOutBowStern = nearEndRail
            && Math.sign(localMoveZ) === Math.sign(local.z)
            && Math.abs(localMoveZ) > 0.25;
        if (movingOutPortStarboard || movingOutBowStern) {
            player.shipBoundaryGraceTimer = PLAYER.SHIP_EXIT_GRACE_TIME;
        }
    }
    toShipLocal(position, ship) {
        const dx = position.x - ship.position.x;
        const dz = position.z - ship.position.z;
        const cos = Math.cos(ship.rotation);
        const sin = Math.sin(ship.rotation);
        return {
            x: dx * cos - dz * sin,
            z: dx * sin + dz * cos,
        };
    }
    toShipWorld(x, z, ship) {
        const cos = Math.cos(ship.rotation);
        const sin = Math.sin(ship.rotation);
        return {
            x: ship.position.x + x * cos + z * sin,
            z: ship.position.z + z * cos - x * sin,
        };
    }
    handleHttp(req, res) {
        if ((req.url ?? '').startsWith('/ws')) {
            res.writeHead(426, { 'content-type': 'text/plain; charset=utf-8' });
            res.end('Upgrade Required');
            return;
        }
        if (!existsSync(join(CLIENT_DIST_ROOT, 'index.html'))) {
            res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' });
            res.end('Pirates BR WebSocket server is running. Build the client bundle or use Vite on port 3000.');
            return;
        }
        const rawPath = new URL(req.url ?? '/', 'http://localhost').pathname;
        const normalizedPath = normalize(decodeURIComponent(rawPath === '/' ? '/index.html' : rawPath))
            .replace(/^(\.\.(\/|\\|$))+/, '');
        let filePath = join(CLIENT_DIST_ROOT, normalizedPath);
        if (!filePath.startsWith(CLIENT_DIST_ROOT)) {
            filePath = join(CLIENT_DIST_ROOT, 'index.html');
        }
        else if (!existsSync(filePath) || statSync(filePath).isDirectory()) {
            filePath = join(CLIENT_DIST_ROOT, 'index.html');
        }
        const ext = extname(filePath);
        res.writeHead(200, {
            'content-type': MIME_TYPES[ext] ?? 'application/octet-stream',
            'cache-control': ext === '.html' ? 'no-cache' : 'public, max-age=31536000, immutable',
        });
        createReadStream(filePath).pipe(res);
    }
}
