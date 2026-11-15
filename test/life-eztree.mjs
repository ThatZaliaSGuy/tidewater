// ez-tree's generator on the engine (src/world/vegetation/EzTree.js, vendored library in
// src/world/vegetation/eztree): every preset grows into valid geometry, the same seed gives the
// same tree, and a line-up is rendered with plain engine materials (bark colour, leaves as
// alpha-tested ovals: not the game's vegetation materials, which come with the canopy integration).
//   node test/life-eztree.mjs [out.png]
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
import { growEzTree, EZ_TREE_PRESETS } from '../src/world/vegetation/EzTree.js';

// ---- every preset: finite positions, unit normals, indices in range, a sensible size
assert.equal( EZ_TREE_PRESETS.length, 15 );
for ( const name of EZ_TREE_PRESETS ) {

	const t = growEzTree( name, { seed: 7, height: 12 } );
	for ( const [ part, g ] of [ [ 'branches', t.branches ], [ 'leaves', t.leaves ] ] ) {

		const p = g.getAttribute( 'position' ), n = g.getAttribute( 'normal' ), uv = g.getAttribute( 'uv' );
		assert.ok( p.count > 0 && p.count < 65536, `${ name } ${ part }: ${ p.count } vertices (16 bit indices)` );
		assert.equal( n.count, p.count, `${ name } ${ part }: a normal per vertex` );
		assert.equal( uv.count, p.count, `${ name } ${ part }: a uv per vertex` );
		assert.ok( p.array.every( Number.isFinite ) && n.array.every( Number.isFinite ) && uv.array.every( Number.isFinite ), `${ name } ${ part }: finite attributes` );
		assert.ok( g.index && g.index.count % 3 === 0, `${ name } ${ part }: indexed triangles` );
		let maxIndex = 0;
		for ( let i = 0; i < g.index.count; i ++ ) maxIndex = Math.max( maxIndex, g.index.array[ i ] );
		assert.ok( maxIndex < p.count, `${ name } ${ part }: indices in range` );

	}
	assert.ok( Math.abs( t.height - 12 ) < 1e-3, `${ name }: scaled to the height asked for (${ t.height })` );
	assert.ok( t.radius > 0.3 && t.radius < 14, `${ name }: crown radius ${ t.radius.toFixed( 2 ) } m` );

}

// ---- deterministic: the same preset and seed give the same tree, another seed another one
{

	const a = growEzTree( 'Oak Medium', { seed: 3 } ), b = growEzTree( 'Oak Medium', { seed: 3 } ), c = growEzTree( 'Oak Medium', { seed: 4 } );
	const pa = a.branches.getAttribute( 'position' ).array, pb = b.branches.getAttribute( 'position' ).array, pc = c.branches.getAttribute( 'position' ).array;
	assert.equal( pa.length, pb.length );
	assert.ok( pa.every( ( v, i ) => v === pb[ i ] ), 'same seed: identical branches' );
	assert.ok( pa.length !== pc.length || pa.some( ( v, i ) => v !== pc[ i ] ), 'another seed: another tree' );
	// a coarser mesh of the same tree (a far level) has fewer triangles
	const far = growEzTree( 'Oak Medium', { seed: 3, detail: { sectionStride: 2, segmentFactor: 0.5, leafStride: 2 } } );
	assert.ok( far.stats.branchTriangles < a.stats.branchTriangles && far.stats.leafTriangles < a.stats.leafTriangles, 'coarser detail: fewer triangles' );

}
console.log( 'ez-tree: 15 presets valid, deterministic' );

// ---- a line-up, rendered
await GPU.init( { headless: true } );
let errors = 0;
GPU.device.addEventListener( 'uncapturederror', ( e ) => { errors ++; console.error( e.error?.message?.slice( 0, 300 ) ); } );
const W = 1600, H = 700;
const scene = new E.Scene();
const ground = new E.Mesh( new E.PlaneGeometry( 400, 400 ).rotateX( - Math.PI / 2 ), new Material( { name: 'ground', color: 0x6f7f4a, roughness: 0.95 } ) );
scene.add( ground );
const bark = new Material( { name: 'ezBark', color: 0x5a4636, roughness: 0.9 } );
const leafSurface = `
	// an oval leaf on the quad, a midrib a little darker
	let q = in.uv - vec2f( 0.5 );
	s.alpha = 1.0 - step( 0.46, length( q * vec2f( 1.25, 1.0 ) ) );
	s.albedo *= mix( 0.75, 1.0, smoothstep( 0.0, 0.06, abs( q.x ) ) );`;
const leafColours = { Ash: 0x4f7a2c, Aspen: 0x8aa23a, Bush: 0x3f6b2f, Oak: 0x3d6a26, Pine: 0x2c5230 };
const lineup = [ 'Oak Medium', 'Ash Medium', 'Aspen Medium', 'Pine Medium', 'Bush 1', 'Oak Small', 'Pine Small' ];
let triangles = 0;
lineup.forEach( ( name, i ) => {

	const height = name.startsWith( 'Bush' ) ? 3.5 : name.endsWith( 'Small' ) ? 8 : 13;
	const t = growEzTree( name, { seed: 11 + i, height } );
	triangles += t.stats.branchTriangles + t.stats.leafTriangles;
	const x = ( i - ( lineup.length - 1 ) / 2 ) * 11;
	const b = new E.Mesh( t.branches, bark );
	const l = new E.Mesh( t.leaves, new Material( { name: 'ezLeaf' + i, color: leafColours[ name.split( ' ' )[ 0 ] ], roughness: 0.7, side: 'double', alphaTest: 0.5, surface: leafSurface } ) );
	for ( const m of [ b, l ] ) { m.position.set( x, 0, 0 ); m.castShadow = true; scene.add( m ); }

} );

const camera = new E.PerspectiveCamera( 40, W / H, 0.1, 1000 );
camera.position.set( 4, 9, 62 ); camera.lookAt( 0, 6, 0 );
G.sunDir.value.set( 0.45, 0.62, 0.55 ).normalize();
G.sunColor.value.setRGB( 3, 2.9, 2.7 );
G.skyIrradiance.value.setRGB( 0.25, 0.32, 0.45 );

const rt = new RenderTarget( W, H, { colors: [ 'rgba16float', 'rgba16float', 'rgba8unorm' ], depth: 'depth32float', label: 'scene' } );
const mr = new MeshRenderer();
const shadows = new SunShadows();
const tonemap = new FullscreenPass( { label: 'tonemap', colorFormats: [ 'rgba8unorm' ], bindings: { hdr: { texture: () => rt.texture } },
	code: `fn fragment( in: FSIn ) -> vec4f {
		let c = textureLoad( hdr, vec2i( in.pos.xy ), 0 ).rgb;
		let a = c * 0.8; let t = ( a * ( 2.51 * a + 0.03 ) ) / ( a * ( 2.43 * a + 0.59 ) + 0.14 );
		return vec4f( linearToSrgb( sat3( t ) ), 1.0 ); }` } );
const ldr = new RenderTarget( W, H, { colors: [ 'rgba8unorm' ], label: 'ldr' } );
for ( let f = 0; f < 2; f ++ ) {

	GPU.beginFrame();
	setFrameCamera( camera, W, H );
	shadows.render( scene, mr, shadows.update( camera, G.sunDir.value ) );
	mr.render( scene, { camera, kind: 'main', colorViews: rt.textures.map( ( t ) => t.view() ), colorFormats: rt.formats,
		clearColors: [ [ 0.45, 0.6, 0.85, 1 ], [ 0, 0, 0, 0 ], [ 0, 0, 0, 0 ] ], depthView: rt.depthTexture.view(), depthFormat: 'depth32float', clearDepth: 0 } );
	tonemap.render( { colorViews: [ ldr.texture ] } );
	GPU.submit();

}
const img = await readTexture( ldr.texture );
const out = process.argv[ 2 ] || 'life-eztree.png';
writePNG( out, W, H, new Uint8Array( img.data ) );
console.log( 'wrote', out, 'trees', lineup.length, 'triangles', triangles, 'draws', mr.stats.draws, 'gpu errors', errors );
await new Promise( ( r ) => setTimeout( r, 200 ) );
process.exit( errors ? 1 : 0 );
