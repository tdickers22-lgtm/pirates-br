// COMPACT ISLAND PROPS ON THE FULL-STATICS WIRE (b4 gate, test-snapshot-size).
//
// b4.7's canopy put ~3,600 props on the islands, and as JSON objects
// ({"id":412,"type":"tall_grass","x":-123.45,"z":67.89,"yaw":1.234,"scale":0.87})
// they cost ~79 B each: 283 KB of a 457 KB static-world full against the 250 KB
// ceiling. Seed-capable clients never see this (they regenerate the world), but
// the world_sync fallback, legacy joins and the periodic static resend do.
//
// The full wire therefore carries each island's props as one base64 block of
// fixed-width columns (type index u8, id u16, x/z i16 centimetres relative to
// the island centre, yaw i16 in the wire's own angle precision, scale i16
// hundredths) plus a type table. Every value is the SAME integer the 2/3-decimal
// wire quantiser already produced, so unpacking gives back the exact doubles the
// JSON wire carried: (C + k) / 100 === Math.round(x * 100) / 100.
//
// An island whose props do not fit (unknown keys, out-of-range values, > 255
// types) keeps its plain JSON props: the codec never guesses.
import type { Island, IslandProp, IslandPropType } from './types/index.js';

export interface PackedIslandProps {
  /** Type table, indexed by the u8 column. */
  t: string[];
  /** Island centre in integer centimetres (x, z): the origin of the i16 columns. */
  c: [number, number];
  /** Prop count. */
  n: number;
  /** Yaw scale (100 or 1000, whatever the wire quantiser used for `yaw`). */
  y: number;
  /** Columns: u8 type[n], u16 id[n] (0xffff = no id), i16 x[n], z[n], yaw[n], scale[n], little-endian. */
  b: string;
}

const PROP_KEYS = new Set(['id', 'type', 'x', 'z', 'yaw', 'scale']);
const NO_ID = 0xffff;
const fitsI16 = (v: number) => Number.isInteger(v) && v >= -32768 && v <= 32767;

function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function fromBase64(text: string): Uint8Array {
  const s = atob(text);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

/** Pack an island's ALREADY-QUANTISED props (x/z/scale at 2 decimals, yaw at
 *  `yawScale`). Returns null when any prop does not fit the columns. */
export function packIslandProps(props: IslandProp[], centre: { x: number; z: number }, yawScale: number): PackedIslandProps | null {
  const n = props.length;
  const types: string[] = [];
  const typeIndex = new Map<string, number>();
  const cx = Math.round(centre.x * 100);
  const cz = Math.round(centre.z * 100);
  const buf = new ArrayBuffer(n * 11);
  const view = new DataView(buf);
  const oT = 0; const oId = n; const oX = n * 3; const oZ = n * 5; const oY = n * 7; const oS = n * 9;
  for (let i = 0; i < n; i++) {
    const p = props[i] as unknown as Record<string, unknown>;
    for (const key of Object.keys(p)) if (!PROP_KEYS.has(key) || (key !== 'id' && p[key] === undefined)) return null;
    if (typeof p.type !== 'string') return null;
    let ti = typeIndex.get(p.type);
    if (ti === undefined) { ti = types.length; if (ti > 255) return null; types.push(p.type); typeIndex.set(p.type, ti); }
    const id = p.id === undefined ? NO_ID : p.id;
    if (typeof id !== 'number' || !Number.isInteger(id) || id < 0 || id > NO_ID || (id === NO_ID && p.id !== undefined)) return null;
    const x = Math.round((p.x as number) * 100) - cx;
    const z = Math.round((p.z as number) * 100) - cz;
    const yaw = Math.round((p.yaw as number) * yawScale);
    const scale = Math.round((p.scale as number) * 100);
    if (![x, z, yaw, scale].every(fitsI16)) return null;
    // Exactness guard: the column must give back the very double the JSON wire had.
    if ((cx + x) / 100 !== p.x || (cz + z) / 100 !== p.z || yaw / yawScale !== p.yaw || scale / 100 !== p.scale) return null;
    view.setUint8(oT + i, ti);
    view.setUint16(oId + i * 2, id, true);
    view.setInt16(oX + i * 2, x, true);
    view.setInt16(oZ + i * 2, z, true);
    view.setInt16(oY + i * 2, yaw, true);
    view.setInt16(oS + i * 2, scale, true);
  }
  return { t: types, c: [cx, cz], n, y: yawScale, b: toBase64(new Uint8Array(buf)) };
}

export function unpackIslandProps(packed: PackedIslandProps): IslandProp[] {
  const { n, c: [cx, cz], y } = packed;
  const bytes = fromBase64(packed.b);
  if (bytes.length !== n * 11) throw new Error(`propWire: ${bytes.length} B for ${n} props`);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out: IslandProp[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const id = view.getUint16(n + i * 2, true);
    const prop: IslandProp = id === NO_ID
      ? { type: packed.t[view.getUint8(i)] as IslandPropType, x: 0, z: 0, yaw: 0, scale: 0 }
      : { id, type: packed.t[view.getUint8(i)] as IslandPropType, x: 0, z: 0, yaw: 0, scale: 0 };
    prop.x = (cx + view.getInt16(n * 3 + i * 2, true)) / 100;
    prop.z = (cz + view.getInt16(n * 5 + i * 2, true)) / 100;
    prop.yaw = view.getInt16(n * 7 + i * 2, true) / y;
    prop.scale = view.getInt16(n * 9 + i * 2, true) / 100;
    out[i] = prop;
  }
  return out;
}

type WireIsland = Island & { propsPacked?: PackedIslandProps };

/** Server: swap an already-quantised wire island's props for the packed block. */
export function packWireIsland(island: Island, yawScale: number): Island {
  const props = island.props;
  if (!Array.isArray(props) || props.length === 0) return island;
  const packed = packIslandProps(props, island.position, yawScale);
  if (!packed) return island;
  const { props: _drop, ...rest } = island;
  return { ...rest, propsPacked: packed } as WireIsland;
}

/** Client: restore plain props in place on every island that carries a packed
 *  block (idempotent; islands without one are left alone). */
export function unpackWireIslands<T extends { islands?: Island[] } | null | undefined>(holder: T): T {
  const islands = holder?.islands;
  if (!Array.isArray(islands)) return holder;
  for (const island of islands as WireIsland[]) {
    if (!island?.propsPacked) continue;
    island.props = unpackIslandProps(island.propsPacked);
    delete island.propsPacked;
  }
  return holder;
}
