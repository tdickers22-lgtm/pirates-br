// A 2D-canvas stub so client renderers can be instantiated under plain node.
//
// ShipRenderer (and a few factories) paint procedural textures through
// `document.createElement('canvas').getContext('2d')` at construction time.
// Everything else they do is pure three.js scene graph, which node runs fine.
// This shim answers every 2D-context call with a no-op so the geometry census
// gates (test-ship-geometry, test-ship-attitude-frame) can build all three hulls
// in under five seconds with no browser and no GPU — the vertices they grade
// never touch a texture.
//
// Install BEFORE importing anything from src/client (use a dynamic import after
// the call: static imports are hoisted above it).
export function installCanvasStub() {
  if (globalThis.__piratesCanvasStub) return;
  const noop = () => {};
  const ctxStub = new Proxy({}, {
    get: (t, k) => {
      if (k === 'canvas') return null;
      if (typeof k !== 'string') return undefined;
      return t[k] ?? noop;
    },
    set: (t, k, v) => { t[k] = v; return true; },
  });
  ctxStub.createRadialGradient = () => ({ addColorStop: noop });
  ctxStub.createLinearGradient = () => ({ addColorStop: noop });
  ctxStub.getImageData = (x, y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h });
  ctxStub.measureText = () => ({ width: 0 });
  const canvas = () => ({ width: 0, height: 0, getContext: () => ctxStub, toDataURL: () => '' });
  globalThis.document = globalThis.document ?? { createElement: canvas, createElementNS: canvas };
  globalThis.window = globalThis.window ?? globalThis;
  globalThis.__piratesCanvasStub = true;
}
