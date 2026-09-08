// A STATIC FILL-COST MODEL FOR ONE FRAGMENT SHADER.
//
// Not nanoseconds and not a claim about any GPU: an ALU/fetch op count over the
// shader source, with user functions expanded at their call sites and constant
// loops unrolled. It exists because the two things that decide what the ocean
// costs — how many times the Gerstner field is solved and how many hashes the
// foam field takes — are compile-time facts of the GLSL, so they can be graded
// without a rasteriser, deterministically, in 30 ms.
//
// What it deliberately does NOT model: texture filtering, the shadow chunk
// (three's own, gated by receiveShadow), branch coherence, or anything the
// driver folds. A runtime `if` is counted at its WORST case — the near band of
// the ocean is most of the frame, so the worst case is the honest case here.
const OPS = {
  sin: 4, cos: 4, tan: 6, pow: 6, exp: 4, log: 4, sqrt: 2, inversesqrt: 2,
  normalize: 5, length: 4, distance: 5, smoothstep: 4, clamp: 2, mix: 2,
  dot: 2, cross: 3, reflect: 4, refract: 6, fract: 1, floor: 1, ceil: 1,
  abs: 1, sign: 1, mod: 2, min: 1, max: 1, step: 1, texture2D: 8, texture: 8,
  dFdx: 2, dFdy: 2, fwidth: 3, matrixCompMult: 3,
};
const ARITH = /[+\-*/]/g;

/** Strip comments so `// pow(x)` in prose costs nothing. */
function decomment(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

/**
 * Evaluate the OCEAN_TIER / HULL_MASK preprocessor by hand. Only the forms this
 * shader actually uses; anything else throws rather than guessing, so a new
 * directive cannot silently drop a block out of the count.
 */
export function preprocess(src, defines) {
  const out = [];
  const stack = []; // { taken, done, active }
  const val = (expr) => {
    const m = expr.match(/^OCEAN_TIER\s*(>=|==|<=|<|>)\s*(\d+)$/);
    if (m) {
      const t = defines.OCEAN_TIER;
      const n = Number(m[2]);
      return m[1] === '>=' ? t >= n : m[1] === '==' ? t === n : m[1] === '<=' ? t <= n : m[1] === '<' ? t < n : t > n;
    }
    if (/^defined\s*\(/.test(expr) || /NUM_DIR_LIGHT_SHADOWS/.test(expr)) return defines.SHADOW === true;
    throw new Error(`glsl-ops: unhandled #if expression "${expr}"`);
  };
  for (const line of src.split('\n')) {
    const t = line.trim();
    const active = stack.every((f) => f.active);
    if (t.startsWith('#ifdef ')) {
      const on = !!defines[t.slice(7).trim()];
      stack.push({ taken: on, active: on });
    } else if (t.startsWith('#ifndef ')) {
      const on = !defines[t.slice(8).trim()];
      stack.push({ taken: on, active: on });
    } else if (t.startsWith('#if ')) {
      const on = val(t.slice(4).trim());
      stack.push({ taken: on, active: on });
    } else if (t.startsWith('#elif ')) {
      const f = stack[stack.length - 1];
      const on = !f.taken && val(t.slice(6).trim());
      f.active = on; f.taken = f.taken || on;
    } else if (t === '#else') {
      const f = stack[stack.length - 1];
      f.active = !f.taken; f.taken = true;
    } else if (t === '#endif') {
      stack.pop();
    } else if (t.startsWith('#include') || t.startsWith('#pragma') || t.startsWith('#define')) {
      // three's own chunks and unroll pragmas: not ours to count.
    } else if (active) {
      out.push(line);
    }
  }
  return out.join('\n');
}

/** Split top-level function definitions out of preprocessed GLSL. */
function functions(src) {
  const defs = new Map();
  const re = /(?:^|\n)\s*(?:float|vec2|vec3|vec4|mat2|mat3|bool|int|void)\s+(\w+)\s*\([^)]*\)\s*\{/g;
  let m;
  while ((m = re.exec(src))) {
    let depth = 1;
    let i = re.lastIndex;
    while (i < src.length && depth > 0) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') depth--;
      i++;
    }
    defs.set(m[1], src.slice(re.lastIndex, i - 1));
    re.lastIndex = i;
  }
  return defs;
}

/** Leaf ops in one body with constant `for` loops unrolled, plus the text with
 *  loop bodies removed so the caller counts each user call exactly once. */
function selfCost(body, defs, seen) {
  const loop = /for\s*\(\s*int\s+(\w+)\s*=\s*(\d+)\s*;\s*\w+\s*<\s*(\d+)\s*;/g;
  const loops = [];
  let m;
  while ((m = loop.exec(body))) {
    let depth = 0, i = body.indexOf('{', loop.lastIndex), j = i;
    do { if (body[j] === '{') depth++; else if (body[j] === '}') depth--; j++; } while (j < body.length && depth > 0);
    loops.push({ trips: Number(m[3]) - Number(m[2]), body: body.slice(i + 1, j - 1), from: m.index, to: j });
    loop.lastIndex = j;
  }
  let total = 0;
  let flat = body;
  for (const l of loops.reverse()) {
    total += cost(l.body, defs, seen) * l.trips;
    flat = flat.slice(0, l.from) + flat.slice(l.to);
  }
  for (const [name, w] of Object.entries(OPS)) {
    const hits = flat.match(new RegExp(`\\b${name}\\s*\\(`, 'g'));
    if (hits) total += hits.length * w;
  }
  total += (flat.match(ARITH) ?? []).length;
  return { total, flat };
}

/** Full cost of a body: leaf ops plus every user call expanded. */
function cost(body, defs, seen = new Set()) {
  const { total, flat } = selfCost(body, defs, seen);
  let sum = total;
  for (const [name, fnBody] of defs) {
    if (name === 'main' || seen.has(name)) continue;
    const hits = flat.match(new RegExp(`\\b${name}\\s*\\(`, 'g'));
    if (!hits) continue;
    const next = new Set(seen); next.add(name);
    sum += hits.length * cost(fnBody, defs, next);
  }
  return sum;
}

/** Ops per fragment for one shader source under one set of defines. */
export function fragmentOps(src, defines) {
  const pre = preprocess(decomment(src), defines);
  const defs = functions(pre);
  const main = defs.get('main');
  if (!main) throw new Error('glsl-ops: no main()');
  return Math.round(cost(main, defs));
}
