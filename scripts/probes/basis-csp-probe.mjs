// No browser/GPU: exercise the shipped Basis binding factories with string
// code generation forbidden. Optionally compare every decoded mip with the
// pre-patch decoder: node scripts/probes/basis-csp-probe.mjs --reference 459b4cb5
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const decoderPath = 'public/basis/basis_transcoder.js';
const wasmBinary = fs.readFileSync('public/basis/basis_transcoder.wasm');
async function decoder(source, strings) {
  const context = vm.createContext({ console, WebAssembly, setTimeout, clearTimeout, TextDecoder, TextEncoder },
    { codeGeneration: { strings, wasm: true } });
  vm.runInContext(source, context);
  const module = await context.BASIS({ wasmBinary });
  module.initializeBasis();
  return module;
}
const safe = await decoder(fs.readFileSync(decoderPath, 'utf8'), false);
const referenceIndex = process.argv.indexOf('--reference');
const reference = referenceIndex < 0 ? null : await decoder(
  execFileSync('git', ['show', `${process.argv[referenceIndex + 1]}:${decoderPath}`], { encoding: 'utf8' }), true);

function decode(module, bytes, format) {
  const texture = new module.KTX2File(new Uint8Array(bytes));
  try {
    assert.ok(texture.isValid());
    assert.ok(texture.startTranscoding());
    const mips = [];
    for (let mip = 0; mip < texture.getLevels(); mip++) {
      const pixels = new Uint8Array(texture.getImageTranscodedSizeInBytes(mip, 0, 0, format));
      assert.ok(texture.transcodeImage(pixels, mip, 0, 0, format, 0, -1, -1));
      mips.push(createHash('sha256').update(pixels).digest('hex'));
    }
    return mips;
  } finally { texture.close(); texture.delete(); }
}

const directory = 'public/assets/models/packed';
let textures = 0;
let mipCount = 0;
for (const name of ['cutlass', 'crab', 'gull', 'pig', 'shark']) {
  const file = fs.readdirSync(directory).find(f => f.startsWith(`${name}.`) && f.endsWith('.glb'));
  assert.ok(file, `missing packed ${name}`);
  const glb = fs.readFileSync(`${directory}/${file}`);
  const jsonLength = glb.readUInt32LE(12);
  const document = JSON.parse(glb.subarray(20, 20 + jsonLength).toString());
  const binaryStart = 20 + jsonLength + 8;
  for (const image of document.images ?? []) {
    if (image.mimeType !== 'image/ktx2') continue;
    const view = document.bufferViews[image.bufferView];
    const start = binaryStart + (view.byteOffset ?? 0);
    const bytes = glb.subarray(start, start + view.byteLength);
    // RGBA32 fallback and the desktop BC3 GPU format exercise both output paths.
    for (const format of [13, 3]) {
      const mips = decode(safe, bytes, format);
      if (reference) assert.deepEqual(mips, decode(reference, bytes, format), `${name}, format ${format}`);
      mipCount += mips.length;
    }
    textures++;
  }
}
assert.ok(textures >= 5, `only ${textures} textures exercised`);
console.log(`basis-csp-probe PASS: ${textures} textures, ${mipCount} mip/format outputs, string code generation disabled${reference ? ', byte-identical to reference' : ''}`);
