import { growEzTree } from './EzTree.js';

// Tropical trees, brush and foliage for the island, grown with ez-tree's generator (./EzTree.js).
// ez-tree ships temperate presets (oak, ash, aspen, pine); these are Tidewater's own option sets
// for the plants of a tropical shore and its hinterland. Palms are not here: a branching generator
// can't make fronds (see PlantGeometry.js for those).
//
// Each entry: the generator options (in ez-tree's units: only proportions matter, the plant is
// scaled to a height in metres), and what the game needs to place and shade it:
//   kind    'tree' | 'brush' | 'foliage'
//   height  [ min, max ] in metres (a plant's height is picked in this range from its seed)
//   leaf    colour of the foliage (linear-ish sRGB hex, for materials and tests)
//   leafWidth  width of a leaf as a fraction of its length (1 round, 0.5 oval, 0.2 a strap, 0.1 a needle)
//   bark    colour of the bark
//   where   where it grows: 'shore' (the back of the beach), 'coast' (dunes, scrub), 'inland', 'wet' (water's edge)
//   note    what makes the species recognisable, i.e. what its options are after
//
//   const p = growTropical( 'Sea Grape', { seed: 4 } );     // -> growEzTree's result + { name, spec }
//   TROPICAL_PLANTS, TROPICAL_NAMES, tropicalOfKind( 'brush' )

// branch tables: [ level 0 (trunk), 1, 2, 3 ]
const table = ( a ) => Object.fromEntries( a.map( ( v, i ) => [ i, v ] ) );
// tables that start at level 1 (angle, start: a property of a child relative to its parent)
const from1 = ( a ) => Object.fromEntries( a.map( ( v, i ) => [ i + 1, v ] ) );

function plant( { type = 'deciduous', levels = 3, angle, children, length, radius, taper, gnarl, start, twist = [ 0, 0, 0, 0 ],
	force = 0, sections = [ 8, 6, 4, 2 ], segments = [ 7, 5, 4, 3 ], leaves } ) {

	return {
		type,
		branch: {
			levels,
			angle: from1( angle ),
			children: table( children ),
			// (a positive strength pulls the growth up, a negative one lets the branches sag and arch)
			force: { direction: { x: 0, y: 1, z: 0 }, strength: force },
			gnarliness: table( gnarl ),
			length: table( length ),
			radius: table( radius ),
			sections: table( sections ),
			segments: table( segments ),
			start: from1( start ),
			taper: table( taper ),
			twist: table( twist ),
		},
		leaves: { billboard: 'double', sizeVariance: 0.5, start: 0.1, ...leaves },
	};

}

export const TROPICAL_PLANTS = {

	// ------------------------------------------------------------------ trees

	'Sea Grape': {
		kind: 'tree', height: [ 3.5, 6.5 ], leaf: 0x5f8a3a, leafWidth: 1.0, bark: 0x8a7a66, where: 'shore',
		note: 'low and sprawling, wider than tall, on a short leaning trunk; big round leathery leaves',
		options: plant( {
			angle: [ 64, 56, 42 ], children: [ 5, 4, 3 ], length: [ 11, 16, 11, 6 ], radius: [ 1.5, 0.82, 0.7, 0.75 ],
			taper: [ 0.55, 0.6, 0.65, 0.7 ], gnarl: [ 0.22, 0.2, 0.22, 0.1 ], start: [ 0.5, 0.2, 0.1 ], force: 0.002,
			leaves: { count: 8, size: 3.8, angle: 52, start: 0.25, sizeVariance: 0.35 },
		} ),
	},

	'Tropical Almond': {
		kind: 'tree', height: [ 8, 14 ], leaf: 0x4c7d2e, leafWidth: 0.55, bark: 0x6d5f52, where: 'shore',
		note: 'a straight trunk with flat, horizontal tiers of branches (a pagoda); large paddle leaves at the branch ends',
		options: plant( {
			// (evergreen growth: the branches shorten toward the top, the outline of a pagoda; level, and
			// held level: no sag)
			type: 'evergreen', levels: 2, angle: [ 88, 60 ], children: [ 13, 5, 0 ], length: [ 34, 30, 10, 1 ],
			radius: [ 0.95, 0.42, 0.6, 0.7 ], taper: [ 0.6, 0.6, 0.7, 0.7 ], gnarl: [ 0.02, 0.03, 0.06, 0 ], start: [ 0.3, 0.4 ],
			force: 0.001, sections: [ 10, 6, 4, 2 ],
			leaves: { count: 9, size: 3.0, angle: 28, start: 0.4, sizeVariance: 0.3 },
		} ),
	},

	'Frangipani': {
		kind: 'tree', height: [ 2.8, 5 ], leaf: 0x567f34, leafWidth: 0.34, bark: 0x9a9388, where: 'inland',
		note: 'stubby, swollen grey branches forking like a candelabra, bare but for a rosette of leaves at each tip',
		options: plant( {
			angle: [ 50, 46, 44 ], children: [ 3, 3, 2 ], length: [ 7, 7.5, 5.5, 4 ], radius: [ 1.5, 0.95, 0.92, 0.9 ],
			taper: [ 0.3, 0.28, 0.25, 0.2 ], gnarl: [ 0.06, 0.1, 0.1, 0.05 ], start: [ 0.7, 0.68, 0.66 ], force: 0.006,
			leaves: { count: 7, size: 2.9, angle: 62, start: 0.72, sizeVariance: 0.3 },
		} ),
	},

	'Banyan Fig': {
		kind: 'tree', height: [ 10, 16 ], leaf: 0x3d6b2a, leafWidth: 0.6, bark: 0x77695c, where: 'inland',
		note: 'a massive short trunk and long heavy limbs: a dense crown far wider than the tree is tall',
		options: plant( {
			angle: [ 54, 50, 40 ], children: [ 8, 5, 3 ], length: [ 17, 24, 14, 8 ], radius: [ 3.4, 0.5, 0.72, 0.75 ],
			taper: [ 0.45, 0.6, 0.65, 0.7 ], gnarl: [ 0.06, 0.1, 0.16, 0.1 ], start: [ 0.55, 0.2, 0.1 ], force: 0.014,
			leaves: { count: 18, size: 2.7, angle: 40, sizeVariance: 0.5 },
		} ),
	},

	'Flame Tree': {
		kind: 'tree', height: [ 7, 11 ], leaf: 0x5c8f33, leafWidth: 0.36, bark: 0x7b6e60, where: 'inland',
		note: 'an umbrella: limbs leave the top of a clean trunk and level out into a wide, flat, feathery crown',
		options: plant( {
			// (the shoot that continues the bole is a limb like the others: short, with wide side
			// branches of its own, so it is the middle of the crown and not a leader above it. The limbs
			// leave the top of a tall clean bole wide and stay level: a flat top. Fine, dense foliage.)
			angle: [ 70, 72, 50 ], children: [ 7, 6, 3 ], length: [ 26, 15, 15, 7 ], radius: [ 1.4, 0.72, 0.7, 0.7 ],
			taper: [ 0.65, 0.6, 0.65, 0.7 ], gnarl: [ 0.04, 0.08, 0.12, 0.08 ], start: [ 0.82, 0.2, 0.15 ], force: 0.001,
			leaves: { count: 18, size: 1.5, angle: 32, sizeVariance: 0.4 },
		} ),
	},

	'Casuarina': {
		kind: 'tree', height: [ 10, 17 ], leaf: 0x5a7150, leafWidth: 0.1, bark: 0x5f554c, where: 'coast',
		note: 'tall and narrow with a see-through, drooping grey-green crown of needle-like twigs (the beach "pine")',
		options: plant( {
			type: 'evergreen', levels: 2, angle: [ 70, 34 ], children: [ 44, 5, 0 ], length: [ 54, 15, 7, 1 ],
			radius: [ 1.0, 0.3, 0.5, 0.7 ], taper: [ 0.7, 0.7, 0.7, 0.7 ], gnarl: [ 0.04, 0.12, 0.12, 0 ], start: [ 0.24, 0.1 ],
			force: - 0.012, sections: [ 12, 6, 4, 2 ], segments: [ 7, 4, 3, 3 ],
			leaves: { count: 12, size: 1.5, angle: 16, sizeVariance: 0.3 },
		} ),
	},

	'Mangrove': {
		kind: 'tree', height: [ 2.5, 5 ], leaf: 0x4a7a36, leafWidth: 0.5, bark: 0x6a5546, where: 'wet',
		note: 'low and tangled over the water: several arching stems that bend back down, glossy upright leaves',
		options: plant( {
			angle: [ 58, 62, 46 ], children: [ 6, 4, 3 ], length: [ 6, 14, 8, 4.5 ], radius: [ 1.1, 0.8, 0.7, 0.7 ],
			taper: [ 0.5, 0.6, 0.65, 0.7 ], gnarl: [ 0.2, 0.22, 0.25, 0.1 ], start: [ 0.2, 0.2, 0.1 ], force: - 0.02,
			leaves: { count: 12, size: 1.8, angle: 46, sizeVariance: 0.4 },
		} ),
	},

	// ------------------------------------------------------------------ brush

	'Beach Naupaka': {
		kind: 'brush', height: [ 0.8, 1.7 ], leaf: 0x6f9a44, leafWidth: 0.62, bark: 0x8b7d63, where: 'shore',
		note: 'a dense, rounded mound of bright, fleshy leaves right behind the beach',
		options: plant( {
			angle: [ 40, 60, 55 ], children: [ 9, 4, 2 ], length: [ 0.1, 9, 5, 3 ], radius: [ 0.55, 0.9, 0.75, 0.7 ],
			taper: [ 0.7, 0.7, 0.7, 0.7 ], gnarl: [ 0.1, 0.1, 0.08, 0.08 ], start: [ 0.42, 0.25, 0.05 ],
			sections: [ 4, 5, 4, 2 ], segments: [ 4, 4, 3, 3 ],
			leaves: { count: 12, size: 2.7, angle: 55, start: 0.05 },
		} ),
	},

	'Hibiscus': {
		kind: 'brush', height: [ 1.4, 2.6 ], leaf: 0x3f7230, leafWidth: 0.72, bark: 0x6f6252, where: 'inland',
		note: 'an upright, vase-shaped shrub of long canes, dark glossy leaves along them',
		options: plant( {
			angle: [ 20, 50, 55 ], children: [ 6, 4, 2 ], length: [ 0.1, 15, 6, 4 ], radius: [ 0.5, 0.85, 0.7, 0.7 ],
			taper: [ 0.7, 0.75, 0.7, 0.7 ], gnarl: [ 0.08, 0.07, 0.08, 0.06 ], start: [ 0.5, 0.3, 0.05 ], force: 0.004,
			sections: [ 4, 6, 4, 2 ], segments: [ 4, 4, 3, 3 ],
			leaves: { count: 10, size: 2.2, angle: 50 },
		} ),
	},

	'Scrub Tangle': {
		kind: 'brush', height: [ 0.9, 2.0 ], leaf: 0x6b7f45, leafWidth: 0.55, bark: 0x7a6c58, where: 'coast',
		note: 'wind-pruned coastal scrub: wiry, crooked stems splaying sideways, small sparse leaves (twigs show)',
		options: plant( {
			angle: [ 56, 70, 64 ], children: [ 8, 4, 3 ], length: [ 0.1, 12, 8, 5 ], radius: [ 0.45, 0.8, 0.7, 0.7 ],
			taper: [ 0.7, 0.75, 0.75, 0.7 ], gnarl: [ 0.2, 0.36, 0.4, 0.3 ], start: [ 0.4, 0.2, 0.1 ], force: - 0.01,
			sections: [ 4, 6, 5, 3 ], segments: [ 4, 3, 3, 3 ],
			leaves: { count: 6, size: 1.3, angle: 48, sizeVariance: 0.4 },
		} ),
	},

	// ------------------------------------------------------------------ foliage (understory accents)

	'Croton': {
		kind: 'foliage', height: [ 0.6, 1.3 ], leaf: 0xb5862e, leafWidth: 0.5, bark: 0x77664f, where: 'inland',
		note: 'a small bushy accent plant: bold, broad, yellow-to-red variegated leaves',
		options: plant( {
			levels: 2, angle: [ 28, 46 ], children: [ 7, 2, 0 ], length: [ 0.1, 7, 3, 1 ], radius: [ 0.4, 0.8, 0.7, 0.7 ],
			taper: [ 0.7, 0.7, 0.7, 0.7 ], gnarl: [ 0.08, 0.08, 0.06, 0 ], start: [ 0.4, 0.3 ],
			sections: [ 3, 5, 3, 2 ], segments: [ 4, 3, 3, 3 ],
			leaves: { count: 9, size: 3.3, angle: 64, start: 0.2, sizeVariance: 0.4 },
		} ),
	},

	'Ti Plant': {
		kind: 'foliage', height: [ 1.2, 2.6 ], leaf: 0x7a3a52, leafWidth: 0.2, bark: 0x8f8573, where: 'inland',
		note: 'a few slender bare canes, each topped by a rosette of long, arching, wine-red strap leaves',
		options: plant( {
			levels: 1, angle: [ 13 ], children: [ 5, 0, 0 ], length: [ 0.1, 11, 1, 1 ], radius: [ 0.3, 0.95, 0.7, 0.7 ],
			taper: [ 0.2, 0.25, 0.7, 0.7 ], gnarl: [ 0.05, 0.06, 0, 0 ], start: [ 0.5 ],
			sections: [ 3, 6, 2, 2 ], segments: [ 4, 4, 3, 3 ],
			leaves: { count: 18, size: 2.9, angle: 58, start: 0.74, sizeVariance: 0.3 },
		} ),
	},

};

export const TROPICAL_NAMES = Object.keys( TROPICAL_PLANTS );

export function tropicalOfKind( kind ) {

	return TROPICAL_NAMES.filter( ( name ) => TROPICAL_PLANTS[ name ].kind === kind );

}

// A plant of the named species. seed: which individual (shape and, unless `height` is given, its
// height within the species' range). Returns growEzTree's result + { name, spec }.
export function growTropical( name, { seed = 1, height = null, detail = undefined } = {} ) {

	const spec = TROPICAL_PLANTS[ name ];
	if ( ! spec ) throw new Error( `growTropical: unknown plant "${ name }" (${ TROPICAL_NAMES.join( ', ' ) })` );
	// (a cheap hash of the seed: neighbouring seeds shouldn't give neighbouring heights)
	const h01 = ( Math.sin( seed * 12.9898 + 4.1 ) * 43758.5453 ) % 1;
	const h = height ?? spec.height[ 0 ] + ( spec.height[ 1 ] - spec.height[ 0 ] ) * Math.abs( h01 );
	return { ...growEzTree( spec.options, { seed, height: h, detail } ), name, spec };

}
