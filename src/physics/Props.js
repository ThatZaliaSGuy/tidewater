import { Matrix4, Matrix3, Vector3, Quaternion } from '../engine/index.js';

// Loose props with physics that costs nothing until something comes near.
//
// The world builders stamp crates, barrels and lobster pots (InstancedProps) and fence panels
// (fence) into merged static batches, as before. Each one also registers here, and the batch
// tells it which vertex range it owns (GeoBuilder tagSpans). Every prop starts dormant: no body
// in the car physics, just an entry in a coarse grid. Near the moving car or the walker (the
// activation bubble, wider with speed) a prop wakes as an Avian body (rally-physics props.rs);
// its pose comes back once a frame and is written into its vertex range, so the merged batch
// draws it where it went. Once it rests and everyone is well away it goes back to sleep: the body
// goes, the pose stays. Fence panels wake as sensors and break into loose pieces when the car
// hits them fast enough; a slow push meets a solid fence.
//
// Water: a loose prop over the sea floats. Each awake prop over water takes one of a few wave
// queries (FLOAT_SLOTS), and the height, slope and rise of the sea at it go to the physics
// (set_prop_water, props.rs float_props). A prop in the water is also a body of the wake
// simulation (WakeSim.addBody): it sends out rings when it drops in and as it bobs. A floating
// prop never comes to rest, so it sleeps by distance instead (FLOAT_SLEEP), where it floats.

// Proxy volume density (air gaps included, kg/m^3), friction and bounce per material.
const MATERIALS = {
	wood: { density: 170, friction: 0.6, bounce: 0.2 },
	plastic: { density: 70, friction: 0.45, bounce: 0.3 },
	steel: { density: 590, friction: 0.5, bounce: 0.1 }, // a mostly full drum, about 150 kg
	picket: { density: 90, friction: 0.6, bounce: 0.15 },
};
// Prop type: material and proxy shape (0 box, 1 upright cylinder).
const TYPES = { crate: [ 'wood', 0 ], trap: [ 'plastic', 0 ], barrel: [ 'steel', 1 ], fence: [ 'picket', 0 ] };
// Walker colliders of prop stacks (DebrisPlacement) handed over to the props they cover.
const LINKED = new Set( [ 'crate', 'trap', 'barrel' ] );
const CELL = 8;
const MAX_AWAKE = 80;
const BREAK_SPEED = 4; // m/s of the hitter
const REST = 0.6; // seconds at rest before a prop may sleep
const EPS = 1e-4;
const REACH = 0.15; // how far the walker may get ahead of their stopped body (m)
const FLOAT_SLOTS = 12; // wave queries for props over water (one each; further props sink)
const FLOAT_SLEEP = 45; // m from everyone at which a floating prop goes to sleep
const SEA_DENSITY = 1025;

const _m = new Matrix4(), _d = new Matrix4(), _inv = new Matrix4(), _n = new Matrix3();
const _p = new Vector3(), _q = new Quaternion(), _s = new Vector3( 1, 1, 1 ), _v = new Vector3(), _c = new Vector3();
const UP = new Vector3( 0, 1, 0 );

class Prop {

	constructor( id, type, matrix, local, group = null ) {

		this.id = id;
		this.type = type;
		this.m0 = matrix.clone(); // the pose the batch was built with
		this.m = matrix.clone(); // the pose drawn now
		this.local = local; // proxy { c: centre offset, half: half extents } in the prop's frame
		this.group = group;
		this.spans = [];
		this.walker = []; // stack colliders to drop when it first wakes
		this.box = null; // its own walker box once it has moved
		this.rest = 0;
		this.cell = null;
		this._pos = new Vector3();

	}

	// GeoBuilder Batch.build: this prop's vertices are [start, start + count) of geo.
	bind( geo, start, count ) {

		const last = this.spans[ this.spans.length - 1 ];
		if ( last && last.geo === geo && last.start + last.count === start ) last.count += count;
		else this.spans.push( { geo, start, count, pos: null, nrm: null } );

	}

	get position() {

		return this._pos.setFromMatrixPosition( this.m );

	}

}

// A breakable fence panel: a sensor while dormant pieces draw it whole.
class Panel {

	constructor( id, centre, yaw, half ) {

		this.id = id;
		this.panel = true;
		this.centre = centre.clone();
		this.q = new Quaternion().setFromAxisAngle( UP, yaw );
		this.half = half.clone();
		this.pieces = [];
		this.box = null;
		this.broken = false;
		this.solid = false;
		this.cell = null;

	}

	get position() {

		return this.centre;

	}

}

class Registry {

	constructor() {

		this.all = [];
		this.bounds = new Map();

	}

	// A loose prop stamped from a prototype batch set (InstancedProps).
	add( type, matrix, protos ) {

		let local = this.bounds.get( protos );
		if ( ! local ) {

			const lo = new Vector3( Infinity, Infinity, Infinity ), hi = new Vector3( - Infinity, - Infinity, - Infinity );
			for ( const key in protos ) {

				const P = protos[ key ].pos;
				for ( let i = 0; i < P.length; i += 3 ) {

					lo.min( _v.set( P[ i ], P[ i + 1 ], P[ i + 2 ] ) );
					hi.max( _v );

				}

			}
			local = { c: lo.clone().add( hi ).multiplyScalar( 0.5 ), half: hi.clone().sub( lo ).multiplyScalar( 0.5 ) };
			this.bounds.set( protos, local );

		}
		const prop = new Prop( this.all.length, type, matrix, local );
		this.all.push( prop );
		return prop;

	}

	panel( centre, yaw, half ) {

		const panel = new Panel( this.all.length, centre, yaw, half );
		this.all.push( panel );
		return panel;

	}

	// One of a panel's pre-split pieces: a box centred on its frame.
	piece( panel, centre, yaw, half ) {

		const m = new Matrix4().compose( centre, _q.setFromAxisAngle( UP, yaw ), _s );
		const prop = new Prop( this.all.length, 'fence', m, { c: new Vector3(), half: half.clone() }, panel );
		panel.pieces.push( prop );
		this.all.push( prop );
		return prop;

	}

}

export const PROPS = new Registry();

export class PropPhysics {

	constructor( app ) {

		this.app = app;
		this.physics = null;
		this.grid = new Map();
		this.awake = new Map(); // id -> prop or panel
		this.stats = { props: 0, panels: 0, awake: 0, wakes: 0, sleeps: 0, breaks: 0, ms: 0 };
		this._dims = new Float32Array( 3 );
		this._state = new Float32Array( 10 );
		// wave queries for the props over water: slot -> prop, and each prop's `float` record
		this.floatSlot = - 1;
		this.floats = new Array( FLOAT_SLOTS ).fill( null );
		this.stats.afloat = 0;

	}

	// File every drawn prop in the grid and hand prop-stack walker colliders to their props.
	// Runs before the car physics exports the static world, which skips anything marked `prop`.
	link( colliders ) {

		const loose = [];
		for ( const p of PROPS.all ) {

			if ( p.panel ) {

				if ( p.pieces.every( q => q.spans.length ) ) {

					this.file( p );
					this.stats.panels ++;

				} else if ( p.box ) p.box.prop = false;
				continue;

			}
			if ( p.group || ! p.spans.length ) continue;
			this.file( p );
			loose.push( p );
			this.stats.props ++;

		}

		const near = ( x, z, reach ) => loose.filter( p => {

			const o = p.position;
			return ( o.x - x ) ** 2 + ( o.z - z ) ** 2 < reach * reach;

		} );
		for ( const b of colliders.boxes ) {

			if ( ! LINKED.has( b.tag ) ) continue;
			const props = near( b.center.x, b.center.z, b.radius + 0.2 );
			if ( ! props.length ) continue;
			b.prop = true;
			for ( const p of props ) p.walker.push( b );

		}
		for ( const c of colliders.cylinders ) {

			if ( ! LINKED.has( c.tag ) ) continue;
			const props = near( c.x, c.z, c.radius + 0.1 );
			if ( ! props.length ) continue;
			c.prop = true;
			for ( const p of props ) p.walker.push( c );

		}
		this.colliders = colliders;

	}

	attach( physics ) {

		this.physics = physics?.wake_prop ? physics : null;

	}

	file( p ) {

		const o = p.position;
		const key = Math.floor( o.x / CELL ) + ',' + Math.floor( o.z / CELL );
		if ( key === p.cell ) return;
		if ( p.cell ) {

			const list = this.grid.get( p.cell );
			list.splice( list.indexOf( p ), 1 );

		}
		p.cell = key;
		if ( ! this.grid.has( key ) ) this.grid.set( key, [] );
		this.grid.get( key ).push( p );

	}

	// The car when it moves, the walker on foot: each wakes what is within its radius.
	pushers() {

		const { rally, player } = this.app;
		const out = [];
		const s = rally?.state;
		if ( s ) {

			const speed = Math.abs( s[ 7 ] ) / 3.6;
			if ( speed > 0.3 || rally.active ) {

				_q.set( s[ 3 ], s[ 4 ], s[ 5 ], s[ 6 ] );
				const v = new Vector3( 0, 0, 1 ).applyQuaternion( _q ).multiplyScalar( s[ 7 ] / 3.6 );
				out.push( { x: s[ 0 ], y: s[ 1 ], z: s[ 2 ], r: 4 + speed * 0.45, car: true, speed, v } );

			}

		}
		const walking = player && player.mode === 'walk' && ! rally?.active && ! rally?.bailout?.active && ! this.app.freeCam;
		if ( walking ) {

			const v = player.velocity;
			const speed = Math.hypot( v.x, v.z );
			out.push( { x: player.position.x, y: player.position.y, z: player.position.z, r: 2.2 + speed * 0.4, car: false, speed, v } );

		}
		// The walker's body pushes with a person's strength (props.rs). Where it has been stopped by a
		// prop too heavy to shove, hold the walker within reach of it instead of letting them walk in.
		const body = walking && this.awake.size ? this.physics.pusher_position() : null;
		if ( body?.length === 3 ) {

			const dx = player.position.x - body[ 0 ], dz = player.position.z - body[ 2 ], gap = Math.hypot( dx, dz );
			if ( gap > REACH && gap < 1.5 ) {

				player.position.x = body[ 0 ] + dx / gap * REACH;
				player.position.z = body[ 2 ] + dz / gap * REACH;
				const into = ( player.velocity.x * dx + player.velocity.z * dz ) / gap;
				if ( into > 0 ) { player.velocity.x -= dx / gap * into; player.velocity.z -= dz / gap * into; }
				this.stats.held = ( this.stats.held || 0 ) + 1;

			}

		}
		this.physics.set_pusher( player?.position.x ?? 0, player?.position.y ?? 0, player?.position.z ?? 0,
			player?.velocity.x ?? 0, player?.velocity.y ?? 0, player?.velocity.z ?? 0, 0.3, 1.8, !! walking );
		return out;

	}

	update( dt ) {

		if ( ! this.physics ) return;
		const t0 = performance.now();
		const pushers = this.pushers();
		for ( const h of pushers ) this.wakeAround( h );
		if ( this.awake.size ) this.readBack( dt, pushers );
		this.float( dt );
		this.stats.awake = this.awake.size;
		this.stats.ms = performance.now() - t0;

	}

	wakeAround( h ) {

		const c0 = Math.floor( ( h.x - h.r ) / CELL ), c1 = Math.floor( ( h.x + h.r ) / CELL );
		const r0 = Math.floor( ( h.z - h.r ) / CELL ), r1 = Math.floor( ( h.z + h.r ) / CELL );
		for ( let cx = c0; cx <= c1; cx ++ ) for ( let cz = r0; cz <= r1; cz ++ ) {

			const list = this.grid.get( cx + ',' + cz );
			if ( ! list ) continue;
			for ( const p of list ) {

				const o = p.position;
				const d2 = ( o.x - h.x ) ** 2 + ( o.y - h.y ) ** 2 + ( o.z - h.z ) ** 2;
				if ( d2 > h.r * h.r ) continue;
				if ( this.awake.has( p.id ) ) {

					// Avian may have it asleep; the walker is about to touch it
					if ( ! h.car && ! p.panel && d2 < 1.5 * 1.5 ) this.physics.wake_prop( p.id, 0, this._dims, this._state, 1, 0, 0, false );
					continue;

				}
				if ( this.awake.size >= MAX_AWAKE ) return;
				if ( p.panel ) { if ( h.car && ! p.broken ) this.wakePanel( p ); } else this.wake( p );

			}

		}

	}

	wake( p, velocity = null ) {

		const [ material, shape ] = TYPES[ p.type ];
		const { density, friction, bounce } = MATERIALS[ material ];
		const { c, half } = p.local;
		p.m.decompose( _v, _q, _c );
		_p.copy( c ).applyMatrix4( p.m );
		const state = this._state;
		state.set( [ _p.x, _p.y, _p.z, _q.x, _q.y, _q.z, _q.w, velocity?.x ?? 0, velocity?.y ?? 0, velocity?.z ?? 0 ] );
		let volume;
		if ( shape === 1 ) {

			const r = Math.max( half.x, half.z );
			this._dims.set( [ r, half.y, r ] );
			volume = Math.PI * r * r * half.y * 2;

		} else {

			this._dims.set( [ half.x, half.y, half.z ] );
			volume = 8 * half.x * half.y * half.z;

		}
		if ( ! this.physics.wake_prop( p.id, shape, this._dims, state, Math.max( 0.5, volume * density ), friction, bounce, false ) ) return;
		p.mass = Math.max( 0.5, volume * density );
		p.spanY = Math.cbrt( volume ) * 0.5; // the half extent the physics floats it by (props.rs)
		this.awake.set( p.id, p );
		p.rest = 0;
		this.stats.wakes ++;
		for ( const w of p.walker ) this.dropWalker( w );
		p.walker.length = 0;
		if ( p.box ) p.box.solid = false;

	}

	wakePanel( panel ) {

		const o = panel.centre, q = panel.q;
		this._dims.set( [ panel.half.x, panel.half.y, panel.half.z ] );
		this._state.set( [ o.x, o.y, o.z, q.x, q.y, q.z, q.w, 0, 0, 0 ] );
		if ( ! this.physics.wake_prop( panel.id, 0, this._dims, this._state, 1, 0.6, 0.1, true ) ) return;
		this.awake.set( panel.id, panel );
		panel.solid = false;
		this.stats.wakes ++;

	}

	dropWalker( w ) {

		if ( w.center ) w.solid = false;
		else { w.yMin = - 1e9; w.yMax = - 1e9; }

	}

	readBack( dt, pushers ) {

		const poses = this.physics.prop_poses();
		for ( let i = 0; i < poses.length; i += 10 ) {

			const p = PROPS.all[ poses[ i ] ];
			if ( ! p || ! this.awake.has( p.id ) ) continue;
			const speed = poses[ i + 8 ], flag = poses[ i + 9 ];
			if ( p.panel ) {

				this.panelContact( p, speed, flag, pushers );
				continue;

			}
			_p.set( poses[ i + 1 ], poses[ i + 2 ], poses[ i + 3 ] );
			_q.set( poses[ i + 4 ], poses[ i + 5 ], poses[ i + 6 ], poses[ i + 7 ] );
			// the body is centred on the proxy; the drawn frame sits at -c from it
			_m.compose( _p, _q, _s );
			_v.copy( p.local.c ).negate().applyMatrix4( _m );
			_m.setPosition( _v.x, _v.y, _v.z );
			if ( ! near( _m, p.m ) ) {

				p.m.copy( _m );
				this.draw( p );

			}
			p.rest = flag === 1 || speed < 0.08 ? p.rest + dt : 0;

		}

		// Sleep what rests with nobody near. A prop leaning on one still moving waits for it.
		for ( const p of this.awake.values() ) {

			const o = p.position;
			const far = pushers.every( h => ( o.x - h.x ) ** 2 + ( o.z - h.z ) ** 2 > ( h.r + 3 ) ** 2 );
			if ( ! far ) continue;
			if ( p.panel ) { this.sleep( p ); continue; }
			// afloat: it never rests, so it sleeps once everyone is a long way off
			if ( p.float && p.float.wet > 0 ) {

				if ( pushers.every( h => ( o.x - h.x ) ** 2 + ( o.z - h.z ) ** 2 > FLOAT_SLEEP * FLOAT_SLEEP ) ) this.sleep( p );
				continue;

			}
			if ( p.rest < REST ) continue;
			let leaning = false;
			for ( const other of this.awake.values() ) {

				if ( other === p || other.panel || other.rest >= REST ) continue;
				if ( other.position.distanceToSquared( o ) < 1.5 * 1.5 ) { leaning = true; break; }

			}
			if ( ! leaning ) this.sleep( p );

		}

	}

	panelContact( panel, speed, flag, pushers ) {

		if ( flag === 3 && speed > BREAK_SPEED ) {

			this.breakPanel( panel, pushers.find( h => h.car ) );
			return;

		}
		const solid = flag === 3;
		if ( solid !== panel.solid ) {

			panel.solid = solid;
			this.physics.set_prop_solid( panel.id, solid );

		}

	}

	// The panel's sensor goes; its pre-split pieces wake loose, thrown along with the car.
	breakPanel( panel, car ) {

		this.physics.sleep_prop( panel.id );
		this.awake.delete( panel.id );
		panel.broken = true;
		if ( panel.box ) panel.box.solid = false;
		this.stats.breaks ++;
		const v = new Vector3();
		for ( const piece of panel.pieces ) {

			if ( car ) v.copy( car.v ).multiplyScalar( 0.6 + Math.random() * 0.25 );
			v.y += 1 + Math.random() * 1.5;
			v.x += ( Math.random() - 0.5 ) * 1.5;
			v.z += ( Math.random() - 0.5 ) * 1.5;
			this.wake( piece, v );
			this.file( piece );

		}

	}

	sleep( p ) {

		this.physics.sleep_prop( p.id );
		this.awake.delete( p.id );
		this.dropFloat( p );
		this.stats.sleeps ++;
		if ( p.panel ) return;
		this.file( p );
		this.walkerBox( p );

	}

	// ---- water

	dropFloat( p ) {

		if ( ! p.float ) return;
		this.floats[ p.float.slot ] = null;
		p.float = null;

	}

	// Props over water: give each a wave query, hand the sea at it to the physics, and make it a body
	// of the wake simulation while it is in the water.
	float( dt ) {

		const { query, terrainData, wake } = this.app;
		if ( ! query || ! terrainData || ! this.physics.set_prop_water ) return;
		if ( this.floatSlot < 0 ) {

			try { this.floatSlot = query.allocate( 'props', FLOAT_SLOTS ); } catch ( e ) { this.floatSlot = - 2; }

		}

		if ( this.floatSlot < 0 ) return;
		// who is over water (the sea bed below sea level under it, and not high above it on the pier)
		for ( const p of this.awake.values() ) {

			if ( p.panel ) continue;
			const o = p.position;
			const over = terrainData.heightAt( o.x, o.z ) < 0.3 && o.y < 2.5;
			if ( over && ! p.float ) {

				const slot = this.floats.indexOf( null );
				if ( slot < 0 ) continue; // no query to spare: it sinks
				p.float = { slot, age: 0, h: 0, t: - 1, rate: 0, wet: 0, y: o.y, x: o.x, z: o.z, splash: 0 };
				this.floats[ slot ] = p;

			} else if ( ! over && p.float ) {

				this.physics.set_prop_water( p.id, NaN, 0, 0, 0 );
				this.dropFloat( p );

			}

		}

		let afloat = 0;
		const fresh = query.cpuValid && query.version !== this._floatVersion;
		this._floatVersion = query.version;
		for ( const p of this.floats ) {

			if ( ! p ) continue;
			const f = p.float, o = p.position, s = this.floatSlot + f.slot;
			query.setPoint( s, o.x, o.z );
			f.age ++;
			// the first results after taking the slot belong to whoever had it before
			if ( fresh && f.age > 4 ) {

				const h = query.cpu[ s * 4 ], nx = query.cpu[ s * 4 + 1 ], nz = query.cpu[ s * 4 + 2 ];
				const ny = Math.sqrt( Math.max( 0.05, 1 - nx * nx - nz * nz ) );
				if ( f.t >= 0 && query.resultTime > f.t ) f.rate += ( Math.max( - 3, Math.min( 3, ( h - f.h ) / ( query.resultTime - f.t ) ) ) - f.rate ) * 0.5;
				f.h = h; f.t = query.resultTime;
				f.sx = - nx / ny; f.sz = - nz / ny;
				f.ready = true;

			}

			if ( ! f.ready ) continue;
			// the proxy's footprint on the water, and the head it presses down with: its weight over
			// that footprint, but no more than it is actually immersed
			const half = p.local.half, hw = Math.max( 0.15, half.x ), hl = Math.max( 0.15, half.z );
			const sinkage = p.mass / ( SEA_DENSITY * 4 * hw * hl );
			// the still water under a floating body lies lower by the head of its own patch: add it
			// back, or the prop would sink into the dent it makes
			const inWake = wake && ! wake.sleeping && wake.inWindow( o.x, o.z );
			const own = inWake && f.wet > 0 ? wake.bodyHead( Math.min( sinkage, f.depth || 0 ), hw, hl ) : 0;
			const level = f.h + own;
			this.physics.set_prop_water( p.id, level, f.sx, f.sz, f.rate );
			f.depth = Math.max( 0, level - ( o.y - p.spanY ) );
			const wet = Math.min( 1, f.depth / ( 2 * p.spanY ) );
			const vy = ( o.y - f.y ) / Math.max( dt, 1e-3 ), speed = Math.hypot( o.x - f.x, o.z - f.z ) / Math.max( dt, 1e-3 );
			// dropping in throws up white water for a moment
			if ( wet > 0 && f.wet <= 0 && vy < - 1 ) f.splash = Math.min( 1, - vy / 4 );
			f.splash = Math.max( 0, f.splash - dt * 2.5 );
			f.wet = wet; f.y = o.y; f.x = o.x; f.z = o.z;
			if ( wet <= 0 ) continue;
			afloat ++;
			if ( wake ) wake.addBody( { id: 'prop' + p.id, x: o.x, z: o.z, halfWidth: hw, halfLength: hl, head: Math.min( sinkage, f.depth ), churn: f.splash, speed } );

		}

		this.stats.afloat = afloat;

	}

	// A prop that has moved gets its own walker box where it came to rest (world-aligned bounds of
	// its proxy), added after the car physics took the static world, so only the walker sees it.
	walkerBox( p ) {

		if ( ! this.colliders || p.type === 'fence' ) return;
		const { c, half } = p.local;
		const e = p.m.elements;
		const hx = Math.abs( e[ 0 ] ) * half.x + Math.abs( e[ 4 ] ) * half.y + Math.abs( e[ 8 ] ) * half.z;
		const hy = Math.abs( e[ 1 ] ) * half.x + Math.abs( e[ 5 ] ) * half.y + Math.abs( e[ 9 ] ) * half.z;
		const hz = Math.abs( e[ 2 ] ) * half.x + Math.abs( e[ 6 ] ) * half.y + Math.abs( e[ 10 ] ) * half.z;
		_c.copy( c ).applyMatrix4( p.m );
		if ( ! p.box ) p.box = this.colliders.addBox( _c, _v.set( hx, hy, hz ), 0, { tag: 'prop' } );
		const b = p.box;
		b.center.copy( _c );
		b.half.set( hx, hy, hz );
		b.top = _c.y + hy;
		b.bottom = _c.y - hy;
		b.radius = Math.hypot( hx, hz );
		b.solid = true;

	}

	// Rewrite the prop's vertex range: the built vertices moved rigidly from m0 to m.
	draw( p ) {

		_d.multiplyMatrices( p.m, _inv.copy( p.m0 ).invert() );
		_n.getNormalMatrix( _d );
		const e = _d.elements, ne = _n.elements;
		for ( const s of p.spans ) {

			const pos = s.geo.attributes.position, nrm = s.geo.attributes.normal;
			const a = s.start * 3, n = s.count * 3;
			if ( ! s.pos ) {

				s.pos = pos.array.slice( a, a + n );
				s.nrm = nrm.array.slice( a, a + n );

			}
			const P = pos.array, N = nrm.array, P0 = s.pos, N0 = s.nrm;
			for ( let k = 0; k < n; k += 3 ) {

				const x = P0[ k ], y = P0[ k + 1 ], z = P0[ k + 2 ];
				P[ a + k ] = e[ 0 ] * x + e[ 4 ] * y + e[ 8 ] * z + e[ 12 ];
				P[ a + k + 1 ] = e[ 1 ] * x + e[ 5 ] * y + e[ 9 ] * z + e[ 13 ];
				P[ a + k + 2 ] = e[ 2 ] * x + e[ 6 ] * y + e[ 10 ] * z + e[ 14 ];
				const nx = N0[ k ], ny = N0[ k + 1 ], nz = N0[ k + 2 ];
				N[ a + k ] = ne[ 0 ] * nx + ne[ 3 ] * ny + ne[ 6 ] * nz;
				N[ a + k + 1 ] = ne[ 1 ] * nx + ne[ 4 ] * ny + ne[ 7 ] * nz;
				N[ a + k + 2 ] = ne[ 2 ] * nx + ne[ 5 ] * ny + ne[ 8 ] * nz;

			}
			pos.addUpdateRange( a, n );
			nrm.addUpdateRange( a, n );
			pos.needsUpdate = true;
			nrm.needsUpdate = true;

		}

	}

}

function near( a, b ) {

	const x = a.elements, y = b.elements;
	for ( let i = 0; i < 16; i ++ ) if ( Math.abs( x[ i ] - y[ i ] ) > EPS ) return false;
	return true;

}
