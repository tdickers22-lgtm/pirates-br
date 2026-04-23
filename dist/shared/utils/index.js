import { SHIP_STATS } from '../constants/index.js';
export function lerp(a, b, t) {
    return a + (b - a) * t;
}
export function clamp(v, lo, hi) {
    return Math.max(lo, Math.min(hi, v));
}
export function dist2D(ax, az, bx, bz) {
    const dx = ax - bx, dz = az - bz;
    return Math.sqrt(dx * dx + dz * dz);
}
export function dist3D(a, b) {
    const dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z;
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
}
export function normalize2D(v) {
    const len = Math.sqrt(v.x * v.x + v.y * v.y);
    if (len < 0.0001)
        return { x: 0, y: 0 };
    return { x: v.x / len, y: v.y / len };
}
export function normalize3D(v) {
    const len = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
    if (len < 0.0001)
        return { x: 0, y: 0, z: 0 };
    return { x: v.x / len, y: v.y / len, z: v.z / len };
}
export function dot3D(a, b) {
    return a.x * b.x + a.y * b.y + a.z * b.z;
}
export function cross3D(a, b) {
    return {
        x: a.y * b.z - a.z * b.y,
        y: a.z * b.x - a.x * b.z,
        z: a.x * b.y - a.y * b.x,
    };
}
export function add3D(a, b) {
    return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}
export function scale3D(v, s) {
    return { x: v.x * s, y: v.y * s, z: v.z * s };
}
export function len3D(v) {
    return Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
}
export function randRange(lo, hi) {
    return lo + Math.random() * (hi - lo);
}
export function randInt(lo, hi) {
    return Math.floor(randRange(lo, hi + 1));
}
export function randAngle() {
    return Math.random() * Math.PI * 2;
}
export function angleWrap(a) {
    while (a > Math.PI)
        a -= Math.PI * 2;
    while (a < -Math.PI)
        a += Math.PI * 2;
    return a;
}
export function degreesToRad(d) {
    return d * Math.PI / 180;
}
export function weightedRandom(items) {
    const totalWeight = items.reduce((s, i) => s + i.weight, 0);
    let r = Math.random() * totalWeight;
    for (const item of items) {
        r -= item.weight;
        if (r <= 0)
            return item;
    }
    return items[items.length - 1];
}
/** Simple Gerstner wave height at world position */
export function gerstnerHeight(x, z, t, waves) {
    let height = 0;
    for (const w of waves) {
        const k = (2 * Math.PI) / w.wavelength;
        const c = w.speed;
        const d = normalize2D(w.direction);
        const f = k * (d.x * x + d.y * z - c * t);
        height += w.amplitude * Math.sin(f);
    }
    return height;
}
export const WAVE_PARAMS = [
    { amplitude: 0.24, wavelength: 86, direction: { x: 1, y: 0.4 }, speed: 5.6 },
    { amplitude: 0.14, wavelength: 52, direction: { x: -0.5, y: 1 }, speed: 4.6 },
    { amplitude: 0.08, wavelength: 34, direction: { x: 0.8, y: -0.6 }, speed: 6.5 },
    { amplitude: 0.04, wavelength: 20, direction: { x: -0.3, y: -0.9 }, speed: 7.4 },
];
export function sampleWind(t) {
    const direction = angleWrap(-Math.PI * 0.26 +
        Math.sin(t * 0.013) * 0.22 +
        Math.sin(t * 0.005 + 1.2) * 0.12);
    const strength = clamp(0.9 + Math.sin(t * 0.008 - 0.35) * 0.08, 0.78, 0.98);
    return { direction, strength };
}
export function directionToYaw(dx, dz) {
    return Math.atan2(dx, dz);
}
function islandAngleDelta(a, b) {
    return Math.atan2(Math.sin(a - b), Math.cos(a - b));
}
function islandAngleMask(angle, center, width) {
    return Math.exp(-Math.pow(islandAngleDelta(angle, center) / width, 2));
}
function getIslandShapeTerms(island, angle) {
    const profile = island.profile;
    const primaryMask = islandAngleMask(angle, profile.primaryHillAngle, 0.8);
    const secondaryMask = islandAngleMask(angle, profile.secondaryHillAngle, 0.68) * profile.secondaryHillScale;
    const tertiaryMask = profile.tertiaryHillScale > 0
        ? islandAngleMask(angle, profile.tertiaryHillAngle, 0.62) * profile.tertiaryHillScale
        : 0;
    const bulge = 1
        + Math.cos(angle - profile.ridgeAxis) * profile.ridgeBias * 0.4
        + primaryMask * 0.1
        + secondaryMask * 0.08
        + tertiaryMask * 0.06;
    return { primaryMask, secondaryMask, tertiaryMask, bulge };
}
export function getIslandDistRatio(island, x, z) {
    const dx = x - island.position.x;
    const dz = z - island.position.z;
    const angle = Math.atan2(dz, dx);
    const { bulge } = getIslandShapeTerms(island, angle);
    const scaleX = island.radius * island.profile.footprintX * bulge;
    const scaleZ = island.radius * island.profile.footprintZ * bulge;
    const distRatio = Math.sqrt((dx / Math.max(scaleX, 0.001)) ** 2 + (dz / Math.max(scaleZ, 0.001)) ** 2);
    return { angle, distRatio, bulge };
}
export function getIslandSurfaceY(island, x, z) {
    const { angle, distRatio } = getIslandDistRatio(island, x, z);
    const { primaryMask, secondaryMask, tertiaryMask } = getIslandShapeTerms(island, angle);
    const profile = island.profile;
    const localX = x - island.position.x;
    const localZ = z - island.position.z;
    const shoreline = Math.max(0, 1 - distRatio / 1.04);
    const innerShelf = Math.max(0, 1 - distRatio / (0.62 + profile.mesaBias * 0.12));
    const crownShelf = Math.max(0, 1 - distRatio / (0.34 + profile.mesaBias * 0.08));
    const ridgeWave = 1
        + Math.cos(angle - profile.ridgeAxis) * profile.ridgeBias
        + Math.sin(angle * 2.6 + profile.ridgeAxis) * 0.04;
    const hillContribution = (hillAngle, hillOffset, radiusScale, heightScale) => {
        const centerX = Math.cos(hillAngle) * hillOffset * profile.footprintX;
        const centerZ = Math.sin(hillAngle) * hillOffset * profile.footprintZ;
        const dx = localX - centerX;
        const dz = localZ - centerZ;
        const radius = Math.max(4, island.radius * radiusScale);
        return Math.exp(-(dx * dx + dz * dz) / (radius * radius)) * island.radius * heightScale;
    };
    const beachRise = Math.pow(shoreline, 1.12) * island.radius * 0.032;
    const cliffRise = Math.pow(Math.max(0, 1 - distRatio / 0.9), 1.35)
        * island.radius
        * 0.048
        * (0.86 + profile.heightProfile * 0.32)
        * ridgeWave;
    const plateauRise = Math.pow(innerShelf, 1.42)
        * island.radius
        * 0.042
        * (0.92 + profile.mesaBias * 0.22 + primaryMask * 0.1 + secondaryMask * 0.08 + tertiaryMask * 0.06);
    const crownRise = Math.pow(crownShelf, 2.05)
        * island.radius
        * 0.008
        * (0.28 + primaryMask * 0.16 + secondaryMask * 0.1 + tertiaryMask * 0.08);
    const primaryHill = hillContribution(profile.primaryHillAngle, profile.primaryHillOffset, 0.34 + profile.mesaBias * 0.08, 0.018 + profile.heightProfile * 0.022);
    const secondaryHill = hillContribution(profile.secondaryHillAngle, profile.secondaryHillOffset, 0.3 + profile.secondaryHillScale * 0.1, 0.01 + profile.secondaryHillScale * 0.018);
    const tertiaryHill = profile.tertiaryHillScale > 0
        ? hillContribution(profile.tertiaryHillAngle, profile.tertiaryHillOffset, 0.26 + profile.tertiaryHillScale * 0.1, 0.006 + profile.tertiaryHillScale * 0.014)
        : 0;
    const angleNoise = (Math.sin(angle * 2 + profile.islandHeading) * 0.009 +
        Math.cos(angle * 4 - profile.islandHeading * 1.6) * 0.006) * island.radius;
    const seaLift = 5.15 + island.radius * 0.0085;
    return Math.max(0.08, seaLift + beachRise + cliffRise + plateauRise + crownRise + primaryHill + secondaryHill + tertiaryHill + angleNoise);
}
export function getIslandSurfacePoint(island, distRatio, angle, extraY = 0) {
    const { bulge } = getIslandShapeTerms(island, angle);
    return {
        x: island.position.x + Math.cos(angle) * island.radius * distRatio * island.profile.footprintX * bulge,
        y: getIslandSurfaceY(island, island.position.x + Math.cos(angle) * island.radius * distRatio * island.profile.footprintX * bulge, island.position.z + Math.sin(angle) * island.radius * distRatio * island.profile.footprintZ * bulge) + extraY,
        z: island.position.z + Math.sin(angle) * island.radius * distRatio * island.profile.footprintZ * bulge,
    };
}
export function isPointInsideIslandFootprint(island, x, z, margin = 0) {
    const { distRatio } = getIslandDistRatio(island, x, z);
    return distRatio <= 1 + margin / Math.max(island.radius, 1);
}
export function getIslandMaxRadius(island) {
    const profile = island.profile;
    return island.radius
        * Math.max(profile.footprintX, profile.footprintZ)
        * (1.08 + Math.abs(profile.ridgeBias) * 0.18 + profile.secondaryHillScale * 0.08 + profile.tertiaryHillScale * 0.05);
}
/** Main mast base Z (matches client ShipRenderer mast layout). */
export function getMainMastLocalZ(stats) {
    return stats.length * 0.22;
}
/** Standing height in crow's nest (ship-local Y above waterline). */
export function getCrowNestStandingY(stats) {
    const H = stats.height;
    const mastH = H * (stats.mastCount === 1 ? 3.6 : 3.1);
    return H + mastH * 0.72 + 0.42;
}
/** Climb prompt zone for the crow's-nest ladder (main mast is at x=0 in ship-local space). */
export function getCrowNestLadderInteractionBounds(stats) {
    return {
        mastZ: getMainMastLocalZ(stats),
        maxAbsX: 0.88,
        maxAbsZ: 1.38,
    };
}
/** Shared sail ring for raising / reefing and angling canvas, kept clear of ladders, anchor, helm, and cannon rails. */
export function getSailStationLocal(stats) {
    return {
        x: 0,
        z: -stats.length * 0.08,
    };
}
/** Back-compat: old hoist callers now resolve to the shared sail ring. */
export function getSailHoistStationLocal(stats) {
    return getSailStationLocal(stats);
}
/** Back-compat: old angle callers now resolve to the shared sail ring. */
export function getSailAngleStationLocal(stats) {
    return getSailStationLocal(stats);
}
export function getShipBoardingLadderLocals(type) {
    const stats = SHIP_STATS[type];
    const ladderX = stats.width * 0.56;
    const ladderZ = -stats.length * 0.18;
    return [
        { x: -ladderX, z: ladderZ },
        { x: ladderX, z: ladderZ },
    ];
}
export function getShipBoardingLadderWorldPoints(ship) {
    const cos = Math.cos(ship.rotation);
    const sin = Math.sin(ship.rotation);
    return getShipBoardingLadderLocals(ship.type).map((ladder) => ({
        x: ship.position.x + ladder.x * cos + ladder.z * sin,
        y: ship.position.y,
        z: ship.position.z + ladder.z * cos - ladder.x * sin,
        localX: ladder.x,
        localZ: ladder.z,
    }));
}
export function getNearestShipBoardingLadder(ship, point) {
    let nearest = null;
    for (const ladder of getShipBoardingLadderWorldPoints(ship)) {
        const distance = dist2D(point.x, point.z, ladder.x, ladder.z);
        if (!nearest || distance < nearest.distance) {
            nearest = { ...ladder, distance };
        }
    }
    return nearest;
}
/** Dock-local space: +Z is inland, seaward ladder is at negative Z. */
export function dockLocalToWorld(dock, lx, ly, lz) {
    const cos = Math.cos(dock.rotation);
    const sin = Math.sin(dock.rotation);
    return {
        x: dock.position.x + lx * cos - lz * sin,
        y: dock.position.y + ly,
        z: dock.position.z + lx * sin + lz * cos,
    };
}
/** World point at the seaward swim-up ladder (for prompts / climb checks). */
export function getIslandDockSwimLadderPoint(dock) {
    return dockLocalToWorld(dock, 0, 0.38, -dock.length * 0.44);
}
