// node --import ./scripts/lib/packed-glb-hook.mjs scripts/test-X.mjs
//
// Runs a node-side GLB consumer on the SHIPPED bytes (b3.1a): every read of a
// source public/assets/models/<name>.glb answers with packed/<name>.glb after
// meshopt decode (EXT_meshopt_compression removed, KHR_mesh_quantization kept:
// int8 normals, uint8 colours, uint16 UVs, reordered vertices), i.e. what
// GLTFLoader + MeshoptDecoder hands the client. Used by
// test-model-transport --consumers so test-asset-merge, test-far-lod-integrity,
// test-asset-bounds and test-hero-assets grade the packed files without
// editing their parsers.
import fs from 'node:fs';
import path from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { packIO, SRC_DIR, PACKED_DIR, listSources } from '../pack-models.mjs';

const io = await packIO();
const decoded = new Map();
for (const name of listSources()) {
  const file = path.join(PACKED_DIR, `${name}.glb`);
  if (!fs.existsSync(file)) continue;
  const doc = await io.readBinary(new Uint8Array(fs.readFileSync(file)));
  for (const ext of doc.getRoot().listExtensionsUsed()) if (ext.extensionName === 'EXT_meshopt_compression') ext.dispose();
  decoded.set(path.join(SRC_DIR, `${name}.glb`), Buffer.from(await io.writeBinary(doc)));
}
const hit = (p) => (typeof p === 'string' || p instanceof URL) ? decoded.get(path.resolve(p instanceof URL ? p.pathname : p)) : undefined;
const origSync = fs.readFileSync;
fs.readFileSync = function (p, ...rest) {
  const b = hit(p);
  if (!b) return origSync.call(this, p, ...rest);
  const enc = typeof rest[0] === 'string' ? rest[0] : rest[0]?.encoding;
  return enc ? b.toString(enc) : Buffer.from(b);
};
const origAsync = fs.promises.readFile;
fs.promises.readFile = async function (p, ...rest) { const b = hit(p); return b ? Buffer.from(b) : origAsync.call(this, p, ...rest); };
syncBuiltinESMExports();
process.env.PIRATES_PACKED_GLB_HOOK = String(decoded.size);
