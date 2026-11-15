import { Tree, TreePreset } from './eztree/index.js';

// Trees grown with ez-tree's generator (vendored in ./eztree, see its README.md) on Tidewater's
// engine. Only the generator is used: a skeleton of branches grown from a preset's options and a
// seed, meshed into two plain geometries (position, normal, uv, 16 bit indices; base at the origin,
// +Y up). ez-tree works in its own units (its presets are 20 to 110 units tall): pass `height` to
// get the tree in metres, scaled so its top is that high.
//   branches: tapered tubes for the trunk and every branch level
//   leaves:   one quad per leaf (two crossed quads with the preset's "double" billboard)
// ez-tree's own materials, wind shader and LOD wrapper are not used (the stand-ins in
// ./eztree/three-shim.js absorb them): give the geometries Tidewater materials.
//
//   const t = growEzTree( 'Oak Medium', { seed: 7, height: 14 } );
//   t.branches, t.leaves      BufferGeometry
//   t.height, t.radius        top of the tree and the widest horizontal reach of its leaves / branches
//                             (metres with `height`, ez-tree units without)
//   t.scale                   the factor applied to ez-tree's units (1 without `height`)
//   t.stats                   { branchTriangles, leafTriangles, leaves }
//   t.options                 the options the tree was grown from (a copy of the preset, with the seed)

// the names of ez-tree's presets ('Ash Small', 'Oak Large', 'Pine Medium', 'Bush 1', ...)
export const EZ_TREE_PRESETS = Object.keys( TreePreset ).filter( ( name ) => name !== 'Trellis' );

// detail: ez-tree's mesh detail, e.g. for a coarser far level of the same tree:
//   { sectionStride (keep every Nth ring of a branch), segmentFactor (fraction of the radial segments),
//     leafStride (keep every Nth leaf), leafScale (enlarge the kept ones) }
// preset: the name of one of ez-tree's presets, or an options object (any subset of ez-tree's
// TreeOptions: missing fields keep its defaults; see TropicalPlants.js for Tidewater's own species)
export function growEzTree( preset = 'Oak Medium', { seed = null, height = null, detail = undefined } = {} ) {

	const tree = new Tree();
	if ( typeof preset === 'string' ) {

		if ( ! TreePreset[ preset ] ) throw new Error( `growEzTree: unknown preset "${ preset }" (${ EZ_TREE_PRESETS.join( ', ' ) })` );
		tree.options.copy( structuredClone( TreePreset[ preset ] ) );

	} else {

		tree.options.copy( structuredClone( preset ) );

	}
	// (not tree.loadPreset(): it grows and meshes a tree at once, from the preset's own seed, with
	// ez-tree's materials. Here the skeleton is grown by createGeometry(), from this seed.)
	if ( seed !== null ) tree.options.seed = seed;
	tree.skeleton = null;
	const { branches, leaves } = tree.createGeometry( detail );
	let m = measure( branches, leaves );
	let scale = 1;
	if ( height !== null && m.height > 0 ) {

		scale = height / m.height;
		for ( const g of [ branches, leaves ] ) {

			const a = g.getAttribute( 'position' ).array;
			for ( let i = 0; i < a.length; i ++ ) a[ i ] *= scale;
			g.getAttribute( 'position' ).needsUpdate = true;
			g.computeBoundingSphere();

		}
		m = measure( branches, leaves );

	}
	return { tree, options: tree.options, branches, leaves, scale, ...m };

}

function measure( branches, leaves ) {

	let height = 0, radius = 0;
	for ( const g of [ branches, leaves ] ) {

		const p = g.getAttribute( 'position' );
		for ( let i = 0; i < p.count; i ++ ) {

			height = Math.max( height, p.getY( i ) );
			radius = Math.max( radius, Math.hypot( p.getX( i ), p.getZ( i ) ) );

		}

	}
	const tris = ( g ) => ( g.index ? g.index.count : g.getAttribute( 'position' ).count ) / 3;
	const leafTriangles = tris( leaves );
	return { height, radius, stats: { branchTriangles: tris( branches ), leafTriangles, leafVertices: leaves.getAttribute( 'position' ).count } };

}
