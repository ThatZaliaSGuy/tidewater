// Floating props, renderer side (physics/Props.js float()): props over water take a wave query each,
// the sea at them goes to the physics, a prop in the water is a body of the wake simulation, and
// props on land or beyond the queries get no water. Stubs stand in for the physics, the wave
// queries, the terrain and the wake simulation.
//   node test/props-float.mjs
import assert from 'node:assert/strict';
import { Vector3 } from '../src/engine/index.js';
import { PropPhysics } from '../src/physics/Props.js';

const sea = { level: 0.2, nx: 0.1 };
const query = {
	cpuValid: true, version: 0, resultTime: 0, cpu: new Float32Array( 128 * 4 ), points: new Map(), next: 1,
	allocate( name, n ) { const s = this.next; this.next += n; return s; },
	setPoint( slot, x, z ) { this.points.set( slot, [ x, z ] ); },
	// a new result: the same sea everywhere, tilted along x
	tick( t ) { this.version ++; this.resultTime = t; for ( const s of this.points.keys() ) this.cpu.set( [ sea.level, sea.nx, 0, - 5 ], s * 4 ); },
};
const water = new Map(); // prop id -> last set_prop_water arguments
const physics = { wake_prop: () => true, sleep_prop: () => true, set_prop_water: ( id, h, sx, sz, rate ) => { water.set( id, { h, sx, sz, rate } ); return true; } };
const bodies = [];
const wake = { sleeping: false, inWindow: () => true, bodyHead: ( head ) => head * 0.5, addBody: ( b ) => bodies.push( b ) };
// sea bed 5 m down for x > 0, a 1 m high beach for x < 0
const terrainData = { heightAt: ( x ) => ( x > 0 ? - 5 : 1 ) };

const props = new PropPhysics( { query, terrainData, wake } );
props.attach( physics );
const make = ( id, x, y ) => ( { id, panel: false, position: new Vector3( x, y, 0 ), local: { half: new Vector3( 0.3, 0.3, 0.3 ) }, mass: 37, spanY: 0.3, float: null } );
const crate = make( 1, 10, 0.1 ), dry = make( 2, - 10, 1.3 ), high = make( 3, 12, 4 );
for ( const p of [ crate, dry, high ] ) props.awake.set( p.id, p );

let t = 0;
const frame = () => { t += 1 / 60; query.tick( t ); bodies.length = 0; props.float( 1 / 60 ); };
for ( let i = 0; i < 12; i ++ ) frame();

// only the crate over the water has a query; the one on the beach and the one high above do not
assert.ok( crate.float && ! dry.float && ! high.float, 'queries go to props over water' );
assert.ok( water.has( 1 ) && ! water.has( 2 ) && ! water.has( 3 ), 'only it is given water' );
const w = water.get( 1 );
// the level is the sea plus the dent of its own patch (it must not sink into it); the slope follows the normal
assert.ok( w.h > sea.level && w.h < sea.level + 0.2, 'level ' + w.h );
assert.ok( Math.abs( w.sx + 0.1 / Math.sqrt( 1 - 0.01 ) ) < 1e-3 && w.sz === 0, 'slope from the normal' );
assert.ok( Math.abs( w.rate ) < 1e-3, 'calm water has no rise' );
// it is in the water, so it pushes the wake simulation
assert.equal( props.stats.afloat, 1 );
assert.equal( bodies.length, 1 );
assert.ok( bodies[ 0 ].id === 'prop1' && bodies[ 0 ].head > 0 && bodies[ 0 ].head <= 37 / ( 1025 * 4 * 0.3 * 0.3 ) + 1e-6, 'its body presses with its weight at most' );

// the sea rises: the rate follows
for ( let i = 0; i < 20; i ++ ) { sea.level += 0.01; frame(); }
assert.ok( water.get( 1 ).rate > 0.2, 'rise rate ' + water.get( 1 ).rate );

// washed ashore: its water is taken away and the query freed
crate.position.set( - 5, 1.2, 0 );
frame();
assert.ok( ! crate.float && Number.isNaN( water.get( 1 ).h ), 'ashore: no water' );
assert.ok( props.floats.every( ( p ) => p === null ), 'query freed' );

// more props over water than queries: the rest get none (they sink), and nothing throws
for ( let i = 0; i < 20; i ++ ) props.awake.set( 100 + i, make( 100 + i, 20 + i, 0 ) );
for ( let i = 0; i < 8; i ++ ) frame();
assert.equal( props.floats.filter( Boolean ).length, 12 );
assert.equal( [ ...props.awake.values() ].filter( ( p ) => p.float ).length, 12 );

// sleeping a floating prop frees its query
const first = props.floats[ 0 ];
props.file = () => {}; props.walkerBox = () => {};
props.sleep( first );
assert.ok( props.floats[ 0 ] === null && ! first.float, 'sleep frees the query' );
console.log( 'props float passed' );
