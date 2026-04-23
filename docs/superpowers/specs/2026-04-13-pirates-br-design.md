# Pirates BR — Sea of Thieves Battle Royale: Design Spec
**Date:** 2026-04-13  
**Stack:** Three.js + TypeScript + Vite + Node.js WebSocket  
**Directory:** `~/pirates-br/`

---

## Architecture

```
pirates-br/
├── src/
│   ├── client/
│   │   ├── core/Game.ts
│   │   ├── input/InputManager.ts
│   │   ├── rendering/
│   │   │   ├── Renderer.ts
│   │   │   ├── OceanRenderer.ts
│   │   │   ├── ShipRenderer.ts
│   │   │   ├── IslandRenderer.ts
│   │   │   ├── StormRenderer.ts
│   │   │   └── EffectsRenderer.ts
│   │   ├── systems/
│   │   │   ├── PlayerController.ts
│   │   │   └── ShipController.ts
│   │   ├── ui/
│   │   │   ├── HUD.ts
│   │   │   └── TradeUI.ts
│   │   ├── network/NetworkClient.ts
│   │   └── main.ts
│   ├── server/
│   │   ├── core/GameServer.ts
│   │   ├── systems/
│   │   │   ├── PhysicsSystem.ts
│   │   │   ├── StormSystem.ts
│   │   │   ├── WeaponSystem.ts
│   │   │   ├── ShipSystem.ts
│   │   │   ├── IslandSystem.ts
│   │   │   ├── TradingSystem.ts
│   │   │   └── BotSystem.ts
│   │   ├── world/MapGenerator.ts
│   │   └── index.ts
│   └── shared/
│       ├── types/index.ts
│       ├── constants/index.ts
│       └── utils/index.ts
├── public/
├── index.html
├── package.json
├── tsconfig.json
├── tsconfig.server.json
└── vite.config.ts
```

---

## World

- **Map**: 2000×2000 units ocean
- **Ocean**: Gerstner wave ShaderMaterial, 4 wave trains, vertex displacement
- **Islands**: 8–12 procedural islands, simplex noise heightmaps, beach/grass/rock layers, palm trees, docks, 2–4 treasure chest spawns each
- **Storm zone**: Dark fog wall + lightning, 7 shrink phases every 2 minutes
- **Lighting**: Directional sun, ambient sky, lantern point lights, shadow maps

---

## Ships

| Ship | Hull HP | Cannons | Max Speed | Turn Rate |
|------|---------|---------|-----------|-----------|
| Sloop | 600 | 2 | 12 kn | fast |
| Brigantine | 900 | 4 | 10 kn | medium |
| Galleon | 1400 | 8 | 7 kn | slow |

- **Sails**: W raises, S lowers. Speed = sail_height × wind × heading_vs_wind
- **Steering**: A/D, turn radius scales with ship size
- **Anchor**: Space, stops over ~3 seconds
- **Hull sections**: 4 (bow, stern, port, starboard). Sectional HP, flooding slows ship
- **Repair**: E at damaged section + wood planks (1 plank = 100 HP)
- **Sinking**: All sections at 0 → 10-second sink animation, crew thrown into water
- **Cannon**: Player walks to cannon mount, E to man it, LMB fires arcing projectile

---

## Player

- **Camera**: 3rd-person default, over-shoulder on RMB (weapons)
- **On ship**: Walk/run on deck with AABB collision, mast ladder, man cannons
- **Swimming**: Slower movement, 60s drowning timer if far from ship/island
- **Boarding**: Swim to enemy ship, E at hull ladder to board
- **Respawn**: On own ship (50 HP). If ship sunk: eliminated.

---

## Weapons

| Weapon | Damage | Special |
|--------|--------|---------|
| Flintlock Pistol | 45 | 1 shot, 1.5s reload |
| Eye of Reach | 80 | Sniper, 2s reload, RMB scope |
| Blunderbuss | 70 spread | Shotgun, 2s reload, short range |
| Flintknock Pistol | 30 | 1 shot, massive knockback (8–15m at close range), 2.5s reload |
| Pistol | 25×2 | 2 shots, fast fire rate |
| Cutlass | 30/swing | LMB attack, LMB+dir dodge-slash, RMB block |
| Ship Cannon | 120 hull / 60 player | Arc projectile, fired from mount |

- Reserve ammo: 5 shots per weapon
- Cannonball types: Regular, Firebomb (5 HP/sec fire), Chainshot (halves enemy sail speed)

---

## Battle Royale

- 16–20 ships (1 player + 15–19 bots in solo mode)
- 7 storm phases, each shrinking safe zone; storm deals 2→20 HP/sec outside
- Win: last ship/crew alive
- HUD: storm timer, ship/player count, compass, kill feed

---

## Treasure & Islands

- Chests: ammo, bananas (heal 25 HP), wood planks, cannonballs, gold coins
- Firebombs set fires, chainshot disables sails
- Player presses E to open chest

---

## Trading

- Within 50m of enemy: T to broadcast request
- UI shows offered items from both sides; both confirm within 10s
- 2-second betrayal window after confirm
- Bots: 30% accept, 20% betray after accepting

---

## HP Logic

- Player: 100 HP, banana = +25, no regen
- Ship: sectional, plank repairs
- Storm: 2 HP/sec → 20 HP/sec (phase 7)
- Drowning: 5 HP/sec after 60s in open water
- Fall damage: enabled (Flintknock knockback can knock off ships)

---

## Graphics

- WebGL2, antialias, shadow maps, MeshStandardMaterial (PBR)
- Ocean ShaderMaterial with Gerstner waves
- Ships: BoxGeometry/CylinderGeometry composites, procedural wood textures
- Islands: PlaneGeometry heightmap with vertex colors
- Post-processing: bloom, fog, SSAO pass
- Collision: AABB for ships, raycasting for player-on-deck and weapon hits
