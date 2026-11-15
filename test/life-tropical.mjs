// Tidewater's tropical species on ez-tree's generator (src/world/vegetation/TropicalPlants.js): every
// species grows into valid geometry inside its height range and with the silhouette its note
// describes, the same seed gives the same plant, and two line-ups are rendered with plain engine
// materials (the species' bark and leaf colours, leaves as alpha-tested ovals: not the game's
// vegetation materials).
//   node test/life-tropical.mjs [outDir]      -> tropical-sheet.png (each species framed), tropical-trees.png, tropical-brush.png
import assert from 'node:assert/strict';
import { writePNG } from './headless.mjs';
import { GPU } from '../src/engine/gpu/GPU.js';
import { RenderTarget } from '../src/engine/gpu/Texture.js';
import { readTexture } from '../src/engine/gpu/Readback.js';
import { G, setFrameCamera } from '../src/engine/render/Frame.js';
import { Material } from '../src/engine/render/Material.js';
import { MeshRenderer } from '../src/engine/render/MeshRenderer.js';
import { SunShadows } from '../src/engine/render/Shadows.js';
import { FullscreenPass } from '../src/engine/render/FullscreenPass.js';
import * as E from '../src/engine/index.js';
import { growTropical, TROPICAL_PLANTS, TROPICAL_NAMES, tropicalOfKind } from '../src/world/vegetation/TropicalPlants.js';

const outDir = process.argv[ 2 ] || '.';

// ---- every species, a few individuals each
assert.equal( TROPICAL_NAMES.length, 12 );
assert.deepEqual( [ tropicalOfKind( 'tree' ).length, tropicalOfKind( 'brush' ).length, tropicalOfKind( 'foliage' ).length ], [ 7, 3, 2 ] );
const aspect = {};
for ( const name of TROPICAL_NAMES ) {

	const spec = TROPICAL_PLANTS[ name ];
	let sum = 0;
	for ( const seed of [ 1, 2, 3, 4 ] ) {

		const t = growTropical( name, { seed } );
		for ( const [ part, g ] of [ [ 'branches', t.branches ], [ 'leaves', t.leaves ] ] ) {

			const p = g.getAttribute( 'position' ), n = g.getAttribute( 'normal' ), uv = g.getAttribute( 'uv' );
			assert.ok( p.count > 0 && p.count < 65536, `${ name } ${ part }: ${ p.count } vertices (16 bit indices)` );
			assert.ok( n.count === p.count && uv.count === p.count, `${ name } ${ part }: a normal and a uv per vertex` );
			assert.ok( p.array.every( Number.isFinite ) && n.array.every( Number.isFinite ), `${ name } ${ part }: finite attributes` );
			let maxIndex = 0;
			for ( let i = 0; i < g.index.count; i ++ ) maxIndex = Math.max( maxIndex, g.index.array[ i ] );
			assert.ok( g.index.count % 3 === 0 && maxIndex < p.count, `${ name } ${ part }: indexed triangles in range` );

		}
		assert.ok( t.height >= spec.height[ 0 ] - 1e-3 && t.height <= spec.height[ 1 ] + 1e-3, `${ name }: ${ t.height.toFixed( 2 ) } m inside ${ spec.height }` );
		// a budget a whole stand of them can afford (the largest crowns are the banyan's)
		assert.ok( t.stats.branchTriangles + t.stats.leafTriangles < 32000, `${ name }: ${ t.stats.branchTriangles + t.stats.leafTriangles } triangles` );
		sum += 2 * t.radius / t.height;

	}
	aspect[ name ] = sum / 4;

}
// silhouettes (crown width over height, averaged over the individuals): what makes each species read
const A = aspect;
assert.ok( A[ 'Sea Grape' ] > 1.3, `sea grape: wider than tall (${ A[ 'Sea Grape' ].toFixed( 2 ) })` );
assert.ok( A[ 'Banyan Fig' ] > 1.2, `banyan: a crown wider than the tree is tall (${ A[ 'Banyan Fig' ].toFixed( 2 ) })` );
assert.ok( A[ 'Casuarina' ] < 0.7, `casuarina: tall and narrow (${ A[ 'Casuarina' ].toFixed( 2 ) })` );
assert.ok( A[ 'Mangrove' ] > 1.3, `mangrove: low and spreading (${ A[ 'Mangrove' ].toFixed( 2 ) })` );
assert.ok( A[ 'Flame Tree' ] > 1.15, `flame tree: a crown wider than the tree is tall (${ A[ 'Flame Tree' ].toFixed( 2 ) })` );
assert.ok( A[ 'Tropical Almond' ] > 0.85, `tropical almond: long level branches (${ A[ 'Tropical Almond' ].toFixed( 2 ) })` );
assert.ok( A[ 'Casuarina' ] < A[ 'Tropical Almond' ] && A[ 'Tropical Almond' ] < A[ 'Banyan Fig' ], 'casuarina < tropical almond < banyan in spread' );
// the tropical almond's tiers: its 20 main branches leave the trunk in 4 whorls of 5 (the generator's
// `whorls` option): 4 tight groups of heights, with clear trunk between them
{

	const t = growTropical( 'Tropical Almond', { seed: 5 } );
	const trunk = t.tree.skeleton.branches[ 0 ].sections;
	const top = trunk[ trunk.length - 1 ].origin.y;
	// (a main branch: one that starts on the trunk's axis; the skeleton keeps no level)
	const onTrunk = ( o ) => trunk.some( ( s, i ) => i + 1 < trunk.length && o.y >= s.origin.y - 1e-6 && o.y <= trunk[ i + 1 ].origin.y + 1e-6
		&& Math.hypot( o.x - s.origin.x, o.z - s.origin.z ) < 0.08 * top );
	const ys = t.tree.skeleton.branches.slice( 1 ).map( ( b ) => b.sections[ 0 ].origin ).filter( onTrunk ).map( ( o ) => o.y / top ).sort( ( a, b ) => a - b );
	const tiers = [ [ ys[ 0 ] ] ];
	for ( let i = 1; i < ys.length; i ++ ) { if ( ys[ i ] - ys[ i - 1 ] > 0.06 ) tiers.push( [] ); tiers[ tiers.length - 1 ].push( ys[ i ] ); }
	assert.equal( tiers.length, 4, `tropical almond: 4 tiers of branches (${ tiers.map( ( g ) => g.length ).join( ', ' ) })` );
	assert.ok( tiers.every( ( g ) => g.length >= 4 && g[ g.length - 1 ] - g[ 0 ] < 0.05 ), 'tropical almond: each tier a tight whorl' );

}
// the same seed gives the same plant, another seed another one
{

	const a = growTropical( 'Flame Tree', { seed: 9 } ), b = growTropical( 'Flame Tree', { seed: 9 } ), c = growTropical( 'Flame Tree', { seed: 10 } );
	const pa = a.branches.getAttribute( 'position' ).array, pb = b.branches.getAttribute( 'position' ).array, pc = c.branches.getAttribute( 'position' ).array;
	assert.ok( pa.length === pb.length && pa.every( ( v, i ) => v === pb[ i ] ), 'same seed: identical plant' );
	assert.ok( pa.length !== pc.length || pa.some( ( v, i ) => v !== pc[ i ] ), 'another seed: another plant' );

}
console.log( 'tropical plants: 12 species valid;', TROPICAL_NAMES.map( ( n ) => `${ n } ${ aspect[ n ].toFixed( 2 ) }` ).join( ', ' ) );

// ---- line-ups
await GPU.init( { headless: true } );
let errors = 0;
GPU.device.addEventListener( 'uncapturederror', ( e ) => { errors ++; console.error( e.error?.message?.slice( 0, 300 ) ); } );
const W = 1800, H = 760;
G.sunDir.value.set( 0.45, 0.62, 0.55 ).normalize();
G.sunColor.value.setRGB( 3, 2.9, 2.7 );
G.skyIrradiance.value.setRGB( 0.25, 0.32, 0.45 );
const mr = new MeshRenderer();
const shadows = new SunShadows();
const rt = new RenderTarget( W, H, { colors: [ 'rgba16float', 'rgba16float', 'rgba8unorm' ], depth: 'depth32float', label: 'scene' } );
const ldr = new RenderTarget( W, H, { colors: [ 'rgba8unorm' ], label: 'ldr' } );
const tonemap = new FullscreenPass( { label: 'tonemap', colorFormats: [ 'rgba8unorm' ], bindings: { hdr: { texture: () => rt.texture } },
	code: `fn fragment( in: FSIn ) -> vec4f {
		let c = textureLoad( hdr, vec2i( in.pos.xy ), 0 ).rgb;
		let a = c * 0.8; let t = ( a * ( 2.51 * a + 0.03 ) ) / ( a * ( 2.43 * a + 0.59 ) + 0.14 );
		return vec4f( linearToSrgb( sat3( t ) ), 1.0 ); }` } );
// a leaf on its quad: an ellipse as long as the quad and width times as wide (the species'
// leafWidth: round, oval, strap, needle), with a midrib a little darker
const leafSurfaceOf = ( width ) => `
	let q = in.uv - vec2f( 0.5 );
	s.alpha = 1.0 - step( 0.47, length( vec2f( q.x / ${ Math.max( width, 0.06 ).toFixed( 3 ) }, q.y ) ) );
	s.albedo *= mix( 0.72, 1.0, smoothstep( 0.0, ${ ( 0.07 * Math.max( width, 0.06 ) ).toFixed( 4 ) }, abs( q.x ) ) );`;
const barkOf = ( t ) => new Material( { name: 'bark-' + t.name, color: t.spec.bark, roughness: 0.9 } );
const leafOf = ( t ) => new Material( { name: 'leaf-' + t.name, color: t.spec.leaf, roughness: 0.65, side: 'double', alphaTest: 0.5, surface: leafSurfaceOf( t.spec.leafWidth ) } );

// names: left to right; spacing between plants and the camera are in metres
async function lineup( file, names, { spacing, eye, target, fov = 38, post = 1.8 } ) {

	const scene = new E.Scene();
	scene.add( new E.Mesh( new E.PlaneGeometry( 600, 600 ).rotateX( - Math.PI / 2 ), new Material( { name: 'sand', color: 0xc9b98f, roughness: 0.95 } ) ) );
	let triangles = 0;
	names.forEach( ( name, i ) => {

		const t = growTropical( name, { seed: 3 + i } );
		triangles += t.stats.branchTriangles + t.stats.leafTriangles;
		const x = ( i - ( names.length - 1 ) / 2 ) * spacing;
		const b = new E.Mesh( t.branches, barkOf( t ) );
		const l = new E.Mesh( t.leaves, leafOf( t ) );
		for ( const m of [ b, l ] ) { m.position.set( x, 0, 0 ); m.castShadow = true; scene.add( m ); }
		// a person-high post beside each plant, for scale
		const p = new E.Mesh( new E.BoxGeometry( 0.12, post, 0.12 ), new Material( { name: 'post-' + name, color: 0xd8d2c4, roughness: 0.8 } ) );
		p.position.set( x + spacing * 0.42, post / 2, 0.6 ); p.castShadow = true; scene.add( p );

	} );
	const camera = new E.PerspectiveCamera( fov, W / H, 0.1, 1000 );
	camera.position.set( ...eye ); camera.lookAt( ...target );
	for ( let f = 0; f < 2; f ++ ) {

		GPU.beginFrame();
		setFrameCamera( camera, W, H );
		shadows.render( scene, mr, shadows.update( camera, G.sunDir.value ) );
		mr.render( scene, { camera, kind: 'main', colorViews: rt.textures.map( ( t ) => t.view() ), colorFormats: rt.formats,
			clearColors: [ [ 0.45, 0.62, 0.86, 1 ], [ 0, 0, 0, 0 ], [ 0, 0, 0, 0 ] ], depthView: rt.depthTexture.view(), depthFormat: 'depth32float', clearDepth: 0 } );
		tonemap.render( { colorViews: [ ldr.texture ] } );
		GPU.submit();

	}
	const img = await readTexture( ldr.texture );
	writePNG( `${ outDir }/${ file }`, W, H, new Uint8Array( img.data ) );
	console.log( 'wrote', file, names.join( ' | ' ), 'triangles', triangles );

}

// A contact sheet: every species in its own cell, the camera fitted to the plant (so a croton fills
// its cell like a banyan does), a 1.8 m post beside it for scale. seedOf( i ): which individual.
async function sheet( file, names, { cols = 4, CW = 600, CH = 520, seedOf = ( i ) => 3 + i } = {} ) {

	const rows = Math.ceil( names.length / cols );
	const crt = new RenderTarget( CW, CH, { colors: [ 'rgba16float', 'rgba16float', 'rgba8unorm' ], depth: 'depth32float', label: 'cell' } );
	const cldr = new RenderTarget( CW, CH, { colors: [ 'rgba8unorm' ], label: 'cellLdr' } );
	const ctone = new FullscreenPass( { label: 'cell tonemap', colorFormats: [ 'rgba8unorm' ], bindings: { hdr: { texture: () => crt.texture } },
		code: `fn fragment( in: FSIn ) -> vec4f {
			let c = textureLoad( hdr, vec2i( in.pos.xy ), 0 ).rgb;
			let a = c * 0.8; let t = ( a * ( 2.51 * a + 0.03 ) ) / ( a * ( 2.43 * a + 0.59 ) + 0.14 );
			return vec4f( linearToSrgb( sat3( t ) ), 1.0 ); }` } );
	const out = new Uint8Array( cols * CW * rows * CH * 4 );
	for ( let i = 0; i < names.length; i ++ ) {

		const t = growTropical( names[ i ], { seed: seedOf( i ) } );
		const scene = new E.Scene();
		scene.add( new E.Mesh( new E.PlaneGeometry( 400, 400 ).rotateX( - Math.PI / 2 ), new Material( { name: 'sand' + i, color: 0xc9b98f, roughness: 0.95 } ) ) );
		for ( const m of [ new E.Mesh( t.branches, barkOf( t ) ), new E.Mesh( t.leaves, leafOf( t ) ) ] ) { m.castShadow = true; scene.add( m ); }
		const postH = Math.min( 1.8, t.height * 0.9 );
		const post = new E.Mesh( new E.BoxGeometry( 0.1, postH, 0.1 ), new Material( { name: 'post' + i, color: 0xe6e0d2, roughness: 0.8 } ) );
		post.position.set( t.radius + 0.5, postH / 2, 0 ); post.castShadow = true; scene.add( post );
		// fit: the plant's height and its width (plus the post) inside the cell
		const fov = 34, tan = Math.tan( fov * Math.PI / 360 );
		const dist = Math.max( t.height * 1.25 / ( 2 * tan ), ( 2 * t.radius + 1.6 ) * 1.15 / ( 2 * tan * CW / CH ) );
		const camera = new E.PerspectiveCamera( fov, CW / CH, 0.05, 1000 );
		camera.position.set( dist * 0.26, t.height * 0.52 + dist * 0.1, dist * 0.96 ); camera.lookAt( 0.25, t.height * 0.46, 0 );
		for ( let f = 0; f < 2; f ++ ) {

			GPU.beginFrame();
			setFrameCamera( camera, CW, CH );
			shadows.render( scene, mr, shadows.update( camera, G.sunDir.value ) );
			mr.render( scene, { camera, kind: 'main', colorViews: crt.textures.map( ( x ) => x.view() ), colorFormats: crt.formats,
				clearColors: [ [ 0.45, 0.62, 0.86, 1 ], [ 0, 0, 0, 0 ], [ 0, 0, 0, 0 ] ], depthView: crt.depthTexture.view(), depthFormat: 'depth32float', clearDepth: 0 } );
			ctone.render( { colorViews: [ cldr.texture ] } );
			GPU.submit();

		}
		const img = new Uint8Array( ( await readTexture( cldr.texture ) ).data );
		const ox = ( i % cols ) * CW, oy = Math.floor( i / cols ) * CH;
		for ( let y = 0; y < CH; y ++ ) out.set( img.subarray( y * CW * 4, ( y + 1 ) * CW * 4 ), ( ( oy + y ) * cols * CW + ox ) * 4 );

	}
	writePNG( `${ outDir }/${ file }`, cols * CW, rows * CH, out );
	console.log( 'wrote', file, `${ cols } x ${ rows }:`, names.join( ' | ' ) );

}

await sheet( 'tropical-sheet.png', TROPICAL_NAMES );
await lineup( 'tropical-trees.png', tropicalOfKind( 'tree' ), { spacing: 17, eye: [ 4, 7, 74 ], target: [ 0, 6, 0 ] } );
await lineup( 'tropical-brush.png', [ ...tropicalOfKind( 'brush' ), ...tropicalOfKind( 'foliage' ) ], { spacing: 4.2, eye: [ 0, 1.9, 15.5 ], target: [ 0, 1.0, 0 ] } );
console.log( 'gpu errors', errors );
await new Promise( ( r ) => setTimeout( r, 200 ) );
process.exit( errors ? 1 : 0 );
