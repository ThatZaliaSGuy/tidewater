// What ez-tree imports as 'three', on Tidewater's engine.
//
// The engine's CPU side is three-compatible (math, Object3D / Group / Mesh, BufferGeometry and its
// attributes, CylinderGeometry), which is everything ez-tree's generator needs to grow a skeleton
// and mesh it. The rest of what it touches is three's own material / LOD layer: it builds a
// MeshStandardMaterial for the bark and the leaves and can wrap its levels in a THREE.LOD. Tidewater
// shades vegetation with its own materials (VegMaterials.js) and has its own LOD (InstanceLOD.js),
// so those are inert stand-ins here: they hold what ez-tree sets on them and do nothing. Take the
// geometry with tree.createGeometry() (see ../EzTree.js) and give it Tidewater materials.

import * as E from '../../../engine/index.js';

export * from '../../../engine/index.js';

// three's wrapping constant (only ever assigned to the stand-in textures' wrapS / wrapT)
export const RepeatWrapping = 1000;

// ez-tree patches three's normal chunk for its leaf shader: an empty chunk makes that a no-op
export const ShaderChunk = { normal_fragment_begin: '' };

// a caller-supplied map (ez-tree only stores it and sets its wrapping)
export class Texture {

	constructor() {

		this.isTexture = true;
		this.wrapS = 0;
		this.wrapT = 0;
		this.needsUpdate = false;

	}

	dispose() {}

}

// holds the parameters ez-tree gives its bark / leaf material; never rendered
export class MeshStandardMaterial {

	constructor( params = {} ) {

		this.isEzTreeMaterialStub = true;
		this.userData = {};
		this.onBeforeCompile = null;
		this.customProgramCacheKey = null;
		Object.assign( this, params );

	}

	dispose() {}

}

// ez-tree's flat meshes start empty (new THREE.Mesh()) and it disposes their geometry and material
// before replacing them: three gives a bare Mesh a default of both, the engine only a geometry
export class Mesh extends E.Mesh {

	constructor( geometry = new E.BufferGeometry(), material = new MeshStandardMaterial() ) {

		super( geometry, material );

	}

}

// three's distance LOD container: a group that remembers its levels (Tidewater switches levels
// itself, per instance, in the vertex shader)
export class LOD extends E.Group {

	constructor() {

		super();
		this.isLOD = true;
		this.levels = [];

	}

	addLevel( object, distance = 0, hysteresis = 0 ) {

		this.levels.push( { object, distance, hysteresis } );
		this.levels.sort( ( a, b ) => a.distance - b.distance );
		this.add( object );
		return this;

	}

}
