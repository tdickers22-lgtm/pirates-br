# Texture sources

Every texture set a shipped model is baked from has one row here (D37, PLAN section 6). Sources are
fetched by id from PolyHaven (`api.polyhaven.com`, all CC0 1.0) by `scripts/blender/_pbr.py` into the
gitignored cache `scripts/blender/.cache/polyhaven/<id>/<res>/` (with a `manifest.json`: name, authors,
md5 per file). Builds call `_pbr.require_licensed([...ids])` before they export, so a source without a
row here fails the build; the first column is the PolyHaven id, backticked, and that is what the check
reads. The baked output (baseColor / normal / ORM) lives inside the GLB; the source JPEGs are never
shipped. CC0 needs no credit; the in-game credits still carry "Textures: Poly Haven (CC0)".

Model kits (Quaternius and similar) are in `LICENSES.md` next to this file.

| id | name | source | authors | license | maps (res) | fetched | used by |
|---|---|---|---|---|---|---|---|
| `brown_planks_03` | Brown Planks 03 | https://polyhaven.com/a/brown_planks_03 | Rob Tuytel | CC0 1.0 | Diffuse, nor_gl, arm (1k) | 2026-09-26 | scripts/blender/test_pipeline_smoke.py (barrel staves); wood source for b3.4c+ trim sheets |
| `rust_coarse_01` | Rust Coarse 01 | https://polyhaven.com/a/rust_coarse_01 | Dimitrios Savva, Rico Cilliers | CC0 1.0 | Diffuse, nor_gl, arm (1k) | 2026-09-26 | scripts/blender/test_pipeline_smoke.py (iron hoops); iron source for b3.4c+ trim sheets |
