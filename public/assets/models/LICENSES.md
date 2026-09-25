# Third-party model sources

Every third-party kit a shipped model is built from has one row (D37, characters-10). Built GLBs also
have a PROVENANCE.json row naming the `scripts/blender` script that writes them; this table is the
licence side. The kits are vendored under `assets-src/quaternius/` by `node assets-src/quaternius/fetch.mjs`
(headless itch.io "No thanks" download, no account, each zip sha256-pinned) with their own licence text
next to them. CC0 needs no credit; the in-game credits still carry "Characters and animation base:
Quaternius (CC0)".

| id | files | source | author | license | fetched | used by |
|---|---|---|---|---|---|---|
| quaternius-universal-base-characters | assets-src/quaternius/ubc/ (Superhero_Male/Female_FullBody, Rigged-to-Head hair, beard, brows, eyes) | https://quaternius.itch.io/universal-base-characters | Quaternius | CC0 1.0 | 2026-09-23, Standard, sha256 fdbf1804c90d... | scripts/blender/build_pirates.py (stage base, b3.2a) |
| quaternius-modular-character-outfits-fantasy | assets-src/quaternius/mco/ (Peasant, Ranger outfits, Regular body textures) | https://quaternius.itch.io/modular-character-outfits-fantasy | Quaternius | CC0 1.0 | 2026-09-23, Standard, sha256 c3468b18871c... | scripts/blender/build_pirates.py (wardrobe stages, b3.2c/d) |
| quaternius-universal-animation-library | assets-src/quaternius/ual1/ (UAL1_Standard.glb, UAL1_Standard_RM.glb) | https://quaternius.itch.io/universal-animation-library | Quaternius | CC0 1.0 | 2026-09-23, Standard, sha256 cc73fc4e495b... | scripts/blender/build_pirates.py (clips stage, b3.2b) |
| quaternius-universal-animation-library-2 | assets-src/quaternius/ual2/ (UAL2_Standard.glb, UAL2_Standard_RM.glb) | https://quaternius.itch.io/universal-animation-library-2 | Quaternius | CC0 1.0 | 2026-09-23, Standard, sha256 4008ea208a60... | scripts/blender/build_pirates.py (clips stage, b3.2b) |
