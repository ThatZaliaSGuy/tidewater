# ez-tree (vendored)

Procedural tree generator by Daniel Greenheck: https://github.com/dgreenheck/ez-tree

- **Version:** 1.1.0, commit `dcf309bd86bd521083d9c70f01f2de45fdc7c457`
- **Licence:** MIT, Copyright (c) 2024 Daniel Greenheck (see `LICENSE` in this folder)

## What is here

The library sources of `src/lib` upstream, run on Tidewater's engine instead of three.js:

| File | Upstream | Changes |
|---|---|---|
| `tree.js`, `branch.js`, `trellis.js`, `options.js`, `enums.js`, `rng.js`, `index.js` | same names in `src/lib` | import paths only: `'three'` -> `./three-shim.js`, `.js` extensions added, `./presets/index` -> `./presets.js` |
| `presets.js` | `src/lib/presets/*.json` + `presets/index.js` | the 16 JSON presets as one JS module (JSON imports need a bundler; Tidewater's tests run the sources in Node). Same data, same `TreePreset` / `loadPreset` |
| `three-shim.js` | new (Tidewater) | the engine's three-compatible classes, plus inert stand-ins for `MeshStandardMaterial`, `Texture`, `LOD`, `RepeatWrapping` and `ShaderChunk` |
| `LICENSE` | `LICENSE` | unchanged |

Nothing else was edited, so upstream fixes can be taken by re-copying the files and re-applying
the import paths.

## How Tidewater uses it

Only the generator: the skeleton and its mesh (positions, normals, uvs, indices for the branches
and the leaves). ez-tree's own materials, wind shader and `THREE.LOD` wrapper are not used: the
stand-ins in `three-shim.js` absorb them. `../EzTree.js` is the entry point.
