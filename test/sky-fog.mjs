// Ground fog field (no GPU): the fog forms where and when it should, moves, burns off, stays finite.
//   node test/sky-fog.mjs
import assert from 'node:assert/strict';
import { TerrainData } from '../src/world/TerrainData.js';
import { FogField, fogClimate, fogNoiseData, FOG_UNIT, FOG_RES } from '../src/sky/FogField.js';

const terrain = new TerrainData();
const field = new FogField( terrain, { size: terrain.size } );
const max = ( a ) => a.reduce( ( m, v ) => Math.max( m, v ), 0 );
const finite = () => { for ( const v of field.data ) assert.ok( Number.isFinite( v ), 'field data is finite' ); };
const air = ( hour, humidity, wind ) => ( {
	hour, humidity, wind, night: hour < 5.5 || hour > 19 ? 1 : 0,
	sunElevation: Math.max( 0, Math.sin( ( hour - 6 ) / 12 * Math.PI ) ) * 0.9,
	windX: 0.35 * wind * 0.6 / FOG_UNIT, windZ: 0.94 * wind * 0.6 / FOG_UNIT,
} );
const run = ( seconds, inputs, feed = true ) => {

	const src = {}, env = {};
	fogClimate( src, env, inputs );
	for ( let t = 0; t < seconds; t += 1 / 15 ) { if ( feed ) field.sources( 1 / 15, src, t ); field.step( 1 / 15, env ); }
	field.pack();
	return src;

};

// the island has hollows, a lagoon and upper slopes for the fog to form on
assert.ok( max( field.valley ) > 0.5 && max( field.water ) > 0.5 && max( field.bank ) > 0.5, 'terrain masks' );
assert.ok( ! field.any, 'starts clear' );

// a calm, humid dawn: mist in the low ground and on the lagoon, none on the summit
run( 90, air( 6.5, 0.8, 3 ) );
finite();
assert.ok( field.any && field.amount > 0.05, 'dawn mist forms' );
let low = 0, lowN = 0, high = 0, highN = 0;
for ( let k = 0; k < FOG_RES * FOG_RES; k ++ ) {

	if ( field.valley[ k ] > 0.5 ) { low += field.d[ k ]; lowN ++; }
	if ( field.ground[ k ] > 0.96 * field.peak ) { high += field.d[ k ]; highN ++; }

}

assert.ok( low / lowN > 0.1, 'it lies in the low ground' );
assert.ok( highN > 0 && high / highN < low / lowN, 'thinner on the summit than in the hollows' );
const g = field.bounds;
assert.ok( g.maxX > g.minX && g.maxY > g.minY && g.minY >= - 2, 'bounds' );
assert.ok( field.densityAt( 0, 0, 5000 ) === 0, 'no fog far above the layer' );

// the midday sun and a breeze burn it off
const dawn = field.amount;
run( 240, air( 13, 0.8, 7 ) );
finite();
assert.ok( field.amount < dawn * 0.1, 'midday burns it off' );

// wind: a strong wind keeps it from forming at all
field.clear();
const src = run( 60, air( 6.5, 0.8, 12 ) );
assert.ok( src.valley === 0 && field.amount < 0.01, 'no radiation fog in a strong wind' );

// poured fog drifts downwind
field.clear();
field.addFog( 0, 0, 80, 1, 0.5 );
field.pack();
const before = field.densityAt( 0, 120 );
run( 20, { ...air( 12, 0.8, 0 ), windX: 0, windZ: 6 / FOG_UNIT }, false );
assert.ok( field.densityAt( 0, 120 ) > before + 0.05, 'fog is carried by the wind' );
finite();

// the noise volume: every channel uses its range
const noise = fogNoiseData( 16 );
for ( let ch = 0; ch < 4; ch ++ ) {

	let lo = 255, hi = 0;
	for ( let i = ch; i < noise.length; i += 4 ) { lo = Math.min( lo, noise[ i ] ); hi = Math.max( hi, noise[ i ] ); }
	assert.ok( lo < 10 && hi > 245, 'noise channel ' + ch + ' spans its range' );

}

console.log( 'ground fog field passed' );
