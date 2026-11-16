// Headless test of the wake simulation's generic bodies (WakeSim.addBody): with the boat at rest,
// a crate dropped into the water sends out rings and a body towed across it leaves a wake; calm
// water far from both stays calm. Writes a top-down view of the heights.
// usage: node test/ocean-wake-bodies.mjs [out-prefix]
import assert from 'node:assert/strict';
import { writePNG } from './headless.mjs';
import { GPU } from '../src/engine/gpu/GPU.js';
import { RenderTarget } from '../src/engine/gpu/Texture.js';
import { ShaderModule } from '../src/engine/gpu/Shader.js';
import { readTexture } from '../src/engine/gpu/Readback.js';
import { FullscreenPass } from '../src/engine/render/FullscreenPass.js';
import { G } from '../src/engine/render/Frame.js';
import { Vector3, DataUtils } from '../src/engine/index.js';
import { WakeSim, WAKE_BODIES } from '../src/ocean/WakeSim.js';

await GPU.init( { headless: true } );
const out = process.argv[ 2 ] || '/tmp/ocean-wake-bodies';

// deep, open water
const terrainGPU = { module: new ShaderModule( { name: 'terrainStub', code: 'fn terrainHeightAt( xz: vec2f ) -> f32 { return -30.0; }' } ) };
// a boat at rest at the origin (the window is centred on it)
const lines = { zAft: - 3.4, wlEnd: 3.6, bottomAt( x, z ) { return z < this.zAft || z > this.wlEnd || Math.abs( x ) > 1 ? NaN : - 0.3; } };
const boat = { model: { lines }, position: new Vector3( 0, 0, 0 ), velocity: new Vector3(), driven: false, throttle: 0, rpm: 0, forward: ( v ) => v.set( 0, 0, 1 ) };
const wake = new WakeSim( null, { terrainGPU, boat } );
assert.equal( WAKE_BODIES, 16 );
// a patch the grid resolves keeps its head; a narrower one is widened and lowered
assert.equal( wake.bodyHead( 0.2, 1, 2 ), 0.2 );
assert.ok( wake.bodyHead( 0.2, 0.4, 0.4 ) < 0.2 );

const dt = 1 / 60, frames = Number( process.env.FRAMES || 360 );
const crate = { x: - 25, z: 20 }, tow = { x0: 10, z: - 30, speed: 4 };
let towX = tow.x0;
for ( let i = 0; i < frames; i ++ ) {

	G.time.value += dt; G.dt.value = dt;
	GPU.beginFrame();
	// the crate lands after half a second and then floats where it fell
	if ( i > 30 ) wake.addBody( { id: 'crate', x: crate.x, z: crate.z, halfWidth: 0.8, halfLength: 0.8, head: 0.2, churn: i < 45 ? 1 : 0 } );
	// a body towed along +x
	towX = tow.x0 + tow.speed * i * dt;
	wake.addBody( { id: 'tow', x: towX, z: tow.z, yaw: Math.PI / 2, halfWidth: 0.8, halfLength: 1.6, head: 0.25, speed: tow.speed } );
	wake.update( dt );
	GPU.submit();
	if ( i % 30 === 0 ) await GPU.queue.onSubmittedWorkDone();

}

await GPU.queue.onSubmittedWorkDone();
assert.ok( ! wake.sleeping, 'bodies keep the simulation awake' );
assert.ok( wake.inWindow( crate.x, crate.z ) && ! wake.inWindow( 500, 0 ), 'window test' );

// heights over 100 m around the origin, as half floats: r = height (m), g = foam
const W = 512, H = 512, SPAN = 100;
const rt = new RenderTarget( W, H, { colors: [ 'rgba16float' ], label: 'wakeHeights' } );
const pass = new FullscreenPass( { label: 'wake heights', modules: [ wake.module ], colorFormats: [ 'rgba16float' ], code: /* wgsl */`fn fragment( in: FSIn ) -> vec4f {
	let xz = ( in.uv - 0.5 ) * ${ SPAN }.0;
	let fr = wakeFragment( xz );
	return vec4f( wakeHeight( xz ), fr.foam, 0.0, 1.0 );
}` } );
GPU.beginFrame();
pass.render( { colorViews: [ rt.texture ], clear: [ 0, 0, 0, 1 ] } );
GPU.submit();
const raw = new Uint16Array( ( await readTexture( rt.texture ) ).data );
const hAt = ( x, z, ch = 0 ) => DataUtils.fromHalfFloat( raw[ ( Math.round( ( z / SPAN + 0.5 ) * H ) * W + Math.round( ( x / SPAN + 0.5 ) * W ) ) * 4 + ch ] );
const rms = ( cx, cz, r0, r1 ) => {

	let s = 0, n = 0;
	for ( let a = 0; a < 64; a ++ ) for ( let r = r0; r <= r1; r += 0.5 ) {

		const v = hAt( cx + Math.cos( a / 64 * 6.2832 ) * r, cz + Math.sin( a / 64 * 6.2832 ) * r );
		s += v * v; n ++;

	}

	return Math.sqrt( s / n );

};

const under = hAt( crate.x, crate.z ), rings = rms( crate.x, crate.z, 3, 12 ), calm = rms( 30, 35, 0, 6 ), towUnder = hAt( towX, tow.z );
let behind = 0, ahead = 0;
for ( let d = 4; d < 20; d += 0.5 ) behind = Math.max( behind, Math.abs( hAt( towX - d, tow.z + 1.5 ) ), Math.abs( hAt( towX - d, tow.z - 1.5 ) ) );
for ( let d = 8; d < 20; d += 0.5 ) ahead = Math.max( ahead, Math.abs( hAt( towX + d, tow.z ) ) );
console.log( 'under the crate', under.toFixed( 3 ), 'rings rms', rings.toFixed( 4 ), 'calm rms', calm.toFixed( 5 ), 'under the tow', towUnder.toFixed( 3 ), 'wake behind', behind.toFixed( 3 ), 'ahead', ahead.toFixed( 4 ) );
assert.ok( under < - 0.05, 'the crate sits in its own dent' );
assert.ok( rings > 0.002, 'the drop sent out rings' );
assert.ok( towUnder < - 0.05, 'the towed body presses the water down' );
assert.ok( behind > 0.02, 'it leaves a wake behind' );
assert.ok( behind > ahead * 3, 'the wake trails the body' );
assert.ok( calm < rings * 0.5 && calm < 0.01, 'water far from both stays calm' );
for ( const v of raw ) assert.ok( ( v & 0x7c00 ) !== 0x7c00, 'finite heights' );

const png = new Uint8Array( W * H * 4 );
for ( let i = 0; i < W * H; i ++ ) {

	const h = DataUtils.fromHalfFloat( raw[ i * 4 ] ), f = DataUtils.fromHalfFloat( raw[ i * 4 + 1 ] );
	const v = Math.max( 0, Math.min( 255, 128 + h * 900 ) ) + f * 200;
	png[ i * 4 ] = Math.min( 255, v ); png[ i * 4 + 1 ] = Math.min( 255, v ); png[ i * 4 + 2 ] = Math.min( 255, v + 12 ); png[ i * 4 + 3 ] = 255;

}

writePNG( `${ out }.png`, W, H, png );
console.log( 'wrote', `${ out }.png` );
console.log( 'wake bodies passed' );
await new Promise( ( r ) => setTimeout( r, 200 ) );
process.exit( 0 );
