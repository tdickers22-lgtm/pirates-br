# Basis transcoder

The JavaScript and WebAssembly pair is vendored from three.js 0.160.0
(`examples/jsm/libs/basis/`), under the upstream Basis Universal Apache-2.0 license:
https://github.com/BinomialLLC/basis_universal/blob/master/LICENSE

Local CSP compatibility patch (2026-10-03): the four Emscripten binding factories
`createNamedFunction`, `craftInvokerFunction`, `__emval_get_method_caller`, and
`craftEmvalAllocator` use closures instead of compiling JavaScript strings.
Argument conversion, receiver binding, return conversion, and destructor handling
follow the original generated bindings. The WebAssembly bytes are unchanged.
This lets KTX2 workers run with `script-src 'self' 'wasm-unsafe-eval'`.

After changing the JavaScript, regenerate its `.br` and `.gz` siblings with
`node --input-type=module -e "import {compressTree} from './scripts/postbuild-compress.mjs'; compressTree('public/basis')"`. Verify real KTX2 loading under
the production CSP with `scripts/probes/csp-boot-probe.mjs` after building.
Keep this patch when refreshing the vendored pair, or replace it with an upstream
build made with Emscripten `DYNAMIC_EXECUTION=0`.
