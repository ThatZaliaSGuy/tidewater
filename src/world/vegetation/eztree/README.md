# ez-tree (vendored)

Procedural tree generator by Daniel Greenheck: https://github.com/dgreenheck/ez-tree

- **Version:** 1.1.0, commit `dcf309bd86bd521083d9c70f01f2de45fdc7c457`
- **Licence:** MIT, Copyright (c) 2024 Daniel Greenheck (see `LICENSE` in this folder)

## What is here

The library sources of `src/lib` upstream, run on Tidewater's engine instead of three.js:

| File | Upstream | Changes |
|---|---|---|
| `branch.js`, `trellis.js`, `enums.js`, `rng.js`, `index.js` | same names in `src/lib` | import paths only: `'three'` -> `./three-shim.js`, `.js` extensions added, `./presets/index` -> `./presets.js` |
| `tree.js`, `options.js` | same names in `src/lib` | the import paths, plus the options below. They are the files of the `sea-presets` branch of https://github.com/ThatZaliaSGuy/ez-tree |
| `presets.js` | `src/lib/presets/*.json` + `presets/index.js` | the 16 JSON presets as one JS module (JSON imports need a bundler; Tidewater's tests run the sources in Node). Same data, same `TreePreset` / `loadPreset` |
| `three-shim.js` | new (Tidewater) | the engine's three-compatible classes, plus inert stand-ins for `MeshStandardMaterial`, `Texture`, `LOD`, `RepeatWrapping` and `ShaderChunk` |
| `LICENSE` | `LICENSE` | unchanged |

Nothing else was edited, so upstream fixes can be taken by re-copying the files and re-applying
the import paths and the added options (or by copying the fork's files).

## Added: `branch.whorls`

`options.branch.whorls[level]` (levels 1 to 3, like `start` and `angle`; default 0) groups the
child branches of a level into that many tiers along their parent, instead of spreading them
evenly: the members of a tier start at the same height (a little jitter), are spread evenly around
the parent, and each tier is turned against the one below by the golden angle. It gives the
pagoda tiers of a tropical almond, and the whorls of araucarias and young pines. With 0 the
generator draws the same random numbers as upstream, so every existing preset and seed grows the
same tree as before.

## Added: sea life options

Also off by default, with the same guarantee (the stock presets grow identical trees):

- `branch.planar` (0 to 1): every branch grows in the XY plane, children alternating to either
  side (sea fans).
- `branch.tip` (0 to 1, deciduous growth): the tip keeps that share of its tapered radius and is
  closed with a rounded cap (corals).
- `leaves.width`, `leaves.segments`, `leaves.curl`: narrow ribbon leaves of several quads that
  bend along their length (kelp, seagrass). A leaf `size` of 0 grows no leaves.

The fork also has six sea presets (staghorn and finger coral, sea fan, sea whip, giant kelp,
seagrass) as JSON in `src/lib/presets`; they are not vendored here. Tidewater's reef is built by
its own kit, `src/world/reef/`.

## How Tidewater uses it

Only the generator: the skeleton and its mesh (positions, normals, uvs, indices for the branches
and the leaves). ez-tree's own materials, wind shader and `THREE.LOD` wrapper are not used: the
stand-ins in `three-shim.js` absorb them. `../EzTree.js` is the entry point.
