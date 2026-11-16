// Ground fog as a simulated field (CPU, no GPU dependencies: usable in node).
//
// A grid over the island holds, per cell, how much fog lies there (density), how thick the layer is,
// and how freshly it arrived. Each step the fog
//   - is fed by sources that follow the terrain and the hour: radiation fog pooling in low ground and
//     over the lagoon around dawn, sea smoke on the shallows, banks on the upper slopes when the air
//     is humid (deep, cloud-like, clinging to the mountain instead of draining off it), a thin mist
//     everywhere when it is saturated,
//   - drifts with the wind and drains downhill along its own surface (it is heavier than clear air),
//   - spreads, levels like a liquid on flat ground, and
//   - burns off in the sun, in dry air and in strong wind.
// pack() turns the state into the texture the fog march reads.
//
// The simulation works in "field units" of FOG_UNIT metres, heights measured from sea level: its
// constants (layer thicknesses of 0.3 to 1.5 units, speeds of a unit per second or so) are tuned for
// a landscape a dozen units across, so the island is scaled into that range instead of retuning them.

export const FOG_UNIT = 25; // metres per field unit
export const FOG_RES = 128; // cells per side

const N = FOG_RES, CELLS = N * N;
const MIN_H = 0.05, START_H = 0.3, MAX_D = 2.2, MAX_H = 3, VISIBLE = 0.018;

const clamp = ( x, a, b ) => ( x < a ? a : x > b ? b : x );
const smooth = ( a, b, x ) => {

	const t = clamp( ( x - a ) / ( b - a ), 0, 1 );
	return t * t * ( 3 - 2 * t );

};

// small seeded generator (mulberry32)
export function fogRandom( seed ) {

	let s = seed >>> 0;
	return () => {

		s = ( s + 0x6d2b79f5 ) >>> 0;
		let t = s;
		t = Math.imul( t ^ ( t >>> 15 ), t | 1 );
		t ^= t + Math.imul( t ^ ( t >>> 7 ), t | 61 );
		return ( ( t ^ ( t >>> 14 ) ) >>> 0 ) / 4294967296;

	};

}

// smooth value noise in -1..1 (the bank source's slow patches)
function hash3( x, y, z ) {

	let h = ( Math.imul( x, 0x27d4eb2d ) ^ Math.imul( y, 0x165667b1 ) ^ Math.imul( z, 0x9e3779b1 ) ) >>> 0;
	h ^= h >>> 15; h = Math.imul( h, 0x2c1b3c6d ) >>> 0; h ^= h >>> 12;
	return ( h >>> 0 ) / 4294967296;

}

function noise3( x, y, z ) {

	const xi = Math.floor( x ), yi = Math.floor( y ), zi = Math.floor( z );
	const fx = x - xi, fy = y - yi, fz = z - zi;
	const u = fx * fx * ( 3 - 2 * fx ), v = fy * fy * ( 3 - 2 * fy ), w = fz * fz * ( 3 - 2 * fz );
	const L = ( a, b, t ) => a + ( b - a ) * t;
	const c = ( i, j, k ) => hash3( xi + i, yi + j, zi + k );
	return L( L( L( c( 0, 0, 0 ), c( 1, 0, 0 ), u ), L( c( 0, 1, 0 ), c( 1, 1, 0 ), u ), v ),
		L( L( c( 0, 0, 1 ), c( 1, 0, 1 ), u ), L( c( 0, 1, 1 ), c( 1, 1, 1 ), u ), v ), w ) * 2 - 1;

}

export class FogField {

	// terrain: { heightAt( x, z ) } in metres. size: side of the square domain (m), centred on the
	// origin. seaLevel: m.
	constructor( terrain, { size = 2048, seaLevel = 0 } = {} ) {

		this.size = size;
		this.origin = - size / 2;
		this.seaLevel = seaLevel;
		this.cell = size / N / FOG_UNIT; // cell size in field units
		const A = () => new Float32Array( CELLS );
		this.d = A(); // density
		this.h = A().fill( START_H ); // layer thickness
		this.fresh = A(); // 1 where fog has just arrived (it billows), fading
		this.vx = A(); this.vz = A(); // own momentum (from addFog)
		this._d = A(); this._hd = A(); this._f = A(); this._t = A(); this._k = A();
		this._vu = A(); this._vw = A(); this._a = A(); this._b = A(); this._c = A(); this._e = A(); this._row = A();
		this._m1 = new Uint8Array( CELLS ); this._m2 = new Uint8Array( CELLS );
		this.ground = A(); // the surface fog rests on: terrain, or the sea
		this.water = A(); // shallow, sheltered water (the lagoon)
		this.valley = A(); // where cold air pools
		this.bank = A(); // upper slopes that catch cloud
		this.cling = A(); // the mountain: cloud there neither drains downhill nor burns off as readily
		this.flat = A();
		this.shore = A(); // land and shallows (1) against the open sea (0)
		this.edge = A(); // 1 inside, fading to 0 at the border of the domain (no straight cut where the field ends)
		this.top = A();
		// rgba per cell: density, layer top (m), ground (m), billow
		this.data = new Float32Array( CELLS * 4 );
		this.amount = 0; // mean density (0..1)
		this.any = false; // something worth drawing
		this.empty = true;
		this.drift = { x: 0, z: 0 }; // mean velocity of the fog (units / s)
		// world bounds of the visible fog (m)
		this.bounds = { minX: 0, maxX: 0, minZ: 0, maxZ: 0, minY: 0, maxY: 0 };
		this._initStatic( terrain );
		this.pack();

	}

	cellX( i ) { return this.origin + ( i + 0.5 ) * this.size / N; }
	cellZ( j ) { return this.origin + ( j + 0.5 ) * this.size / N; }

	_initStatic( terrain ) {

		const bed = this._a, step = this.size / N;
		let peak = 0;
		for ( let j = 0; j < N; j ++ ) for ( let i = 0; i < N; i ++ ) {

			const x = this.cellX( i ), z = this.cellZ( j ), k = j * N + i;
			const hm = terrain.heightAt( x, z ) - this.seaLevel;
			bed[ k ] = hm / FOG_UNIT;
			this.ground[ k ] = Math.max( bed[ k ], 0 );
			if ( bed[ k ] > peak ) peak = bed[ k ];
			// shallows: half a metre to a few metres of water
			this.water[ k ] = smooth( - 8, - 2, hm ) * ( 1 - smooth( - 0.5, 0.3, hm ) );
			const sx = ( terrain.heightAt( x + step, z ) - terrain.heightAt( x - step, z ) ) / ( 2 * step );
			const sz = ( terrain.heightAt( x, z + step ) - terrain.heightAt( x, z - step ) ) / ( 2 * step );
			this.flat[ k ] = 1 - smooth( 0.1, 0.4, Math.hypot( sx, sz ) );
			this.shore[ k ] = Math.max( smooth( - 5, - 0.5, hm ), this.water[ k ] );
			this.edge[ k ] = smooth( 0, 12, Math.min( i, j, N - 1 - i, N - 1 - j ) );

		}

		this.peak = peak;
		// hollows: ground lower than its surroundings (a few cells around), and low ground in general
		const R = 3;
		for ( let j = 0; j < N; j ++ ) for ( let i = 0; i < N; i ++ ) {

			let sum = 0, n = 0;
			for ( let dj = - R; dj <= R; dj ++ ) {

				const jj = j + dj;
				if ( jj < 0 || jj >= N ) continue;
				for ( let di = - R; di <= R; di ++ ) {

					const ii = i + di;
					if ( ii < 0 || ii >= N || di * di + dj * dj > R * R ) continue;
					sum += Math.max( bed[ jj * N + ii ], 0 ); n ++;

				}

			}

			const k = j * N + i, g = this.ground[ k ];
			let p = smooth( - 0.04, 0.3, sum / n - g ) * 0.55 + smooth( 1.1, 0.3, g ) * 0.6;
			p = Math.max( p, this.water[ k ] );
			p *= smooth( 1.7, 1, g );
			// the open sea beyond the shallows holds little of it
			p *= 0.15 + 0.85 * this.shore[ k ];
			this.valley[ k ] = clamp( p, 0, 1 );
			// a band on the upper slopes, below the summit
			// (the summit itself catches less: it shows above its cloud more often than not)
			this.bank[ k ] = smooth( 0.25 * peak, 0.4 * peak, g ) * ( 0.35 + 0.65 * smooth( 0.95 * peak, 0.75 * peak, g ) ) * ( peak > 1 ? 1 : 0 );
			this.cling[ k ] = peak > 1 ? smooth( 0.15 * peak, 0.3 * peak, g ) : 0;

		}

	}

	// Pours fog at world (x, z): radius (m), amount (density added at the centre), thickness of the
	// layer (field units), outward push, and how fresh (billowing) it is.
	addFog( x, z, radius = 60, amount = 0.5, thickness = 0.5, push = 0, fresh = 1 ) {

		if ( ! ( amount > 0 ) || ! ( radius > 0 ) ) return;
		const cs = this.size / N;
		const cx = ( x - this.origin ) / cs - 0.5, cz = ( z - this.origin ) / cs - 0.5, r = radius / cs;
		const i0 = Math.max( 0, Math.floor( cx - r ) ), i1 = Math.min( N - 1, Math.ceil( cx + r ) );
		const j0 = Math.max( 0, Math.floor( cz - r ) ), j1 = Math.min( N - 1, Math.ceil( cz + r ) );
		const { d, h } = this;
		for ( let j = j0; j <= j1; j ++ ) for ( let i = i0; i <= i1; i ++ ) {

			const dx = i - cx, dz = j - cz, q = Math.sqrt( dx * dx + dz * dz ) / r;
			if ( q >= 1 ) continue;
			const w = 1 - smooth( 0.3, 1, q ), k = j * N + i;
			const add = Math.min( amount * w, MAX_D - d[ k ] );
			if ( add <= 0 ) continue;
			const total = d[ k ] + add;
			h[ k ] = ( h[ k ] * d[ k ] + thickness * add ) / total;
			d[ k ] = total;
			this.fresh[ k ] = Math.min( 1, this.fresh[ k ] + w * fresh * Math.min( 1, amount * 3 ) );
			if ( push > 0 && q > 0.02 ) {

				const p = push * w * Math.min( 1, q * 2.2 );
				this.vx[ k ] += dx / ( q * r ) * p;
				this.vz[ k ] += dz / ( q * r ) * p;

			}

		}

		this.empty = false;

	}

	clear() {

		this.d.fill( 0 ); this.h.fill( START_H ); this.fresh.fill( 0 ); this.vx.fill( 0 ); this.vz.fill( 0 );
		this.empty = true;

	}

	// Feeds the field. src: rates and the densities they fill up to (see fogClimate). time: s.
	sources( dt, src, time ) {

		const { d, h, ground, valley, water, bank } = this;
		const banks = src.bank > 1e-4;
		let any = false;
		for ( let k = 0; k < CELLS; k ++ ) {

			const g = ground[ k ];
			let add = 0, thick = 0;
			if ( src.valley > 0 && valley[ k ] > 0.02 ) {

				const a = src.valley * valley[ k ] * Math.max( 0, src.valleyTarget * ( 0.55 + 0.45 * valley[ k ] ) - d[ k ] );
				add += a; thick += a * clamp( src.valleyTop - g, 0.08, 0.55 );

			}

			if ( src.steam > 0 && water[ k ] > 0.05 ) {

				const a = src.steam * water[ k ] * Math.max( 0, src.steamTarget - d[ k ] );
				add += a; thick += a * 0.6;

			}

			if ( banks && bank[ k ] > 0.02 ) {

				// banks form in slow patches that wander over the slopes
				const i = k % N, j = ( k / N ) | 0;
				const patch = smooth( - 0.1, 0.45, noise3( i * 0.11 + time * 0.018, j * 0.14, time * 0.012 ) );
				const a = src.bank * bank[ k ] * patch * Math.max( 0, src.bankTarget - d[ k ] );
				// (deep: 25 to 50 m of cloud lying on the slope)
				add += a; thick += a * ( 1 + patch );

			}

			if ( src.mist > 0 ) {

				// (it hangs over the land and the shallows; the open sea keeps a trace)
				const a = src.mist * ( 0.3 + 0.7 * valley[ k ] ) * ( 0.2 + 0.8 * this.shore[ k ] ) * Math.max( 0, src.mistTarget - d[ k ] ) * ( g < 3.2 ? 1 : 0.3 );
				add += a; thick += a * ( 0.28 + 0.22 * valley[ k ] );

			}

			if ( add <= 0 ) continue;
			const w = add * this.edge[ k ] * dt, total = d[ k ] + w;
			if ( w <= 0 ) continue;
			h[ k ] = ( h[ k ] * d[ k ] + thick / add * w ) / total;
			d[ k ] = total;
			any = true;

		}

		if ( any ) this.empty = false;

	}

	// One step. env: { windX, windZ: drift of the air at fog height (units / s), energy: how hard it
	// blows (about a quarter of the wind in m/s), drain, diffusion, level, base, sun, dry, windK }.
	step( dt, env ) {

		if ( dt <= 0 ) return;
		const { d, h, fresh, vx, vz, ground } = this;
		const c = this._d, hd = this._hd, f = this._f, loss = this._k, cs = this.cell;
		for ( let k = 0; k < CELLS; k ++ ) { c[ k ] = d[ k ]; hd[ k ] = h[ k ] * d[ k ]; f[ k ] = fresh[ k ]; }
		const on = this._activeMask( c );
		const U = this._vu, W = this._vw, top = this._t;
		// the fog's own surface: it flows down this
		for ( let k = 0; k < CELLS; k ++ ) top[ k ] = ground[ k ] + h[ k ] * smooth( 0.02, 0.35, c[ k ] );
		const windLoss = env.windK * Math.max( 0, env.energy - 1.1 );
		let mx = 0, mz = 0, mw = 0;
		for ( let k = 0; k < CELLS; k ++ ) {

			if ( ! on[ k ] ) { U[ k ] = 0; W[ k ] = 0; loss[ k ] = 0; continue; }
			const i = k % N, j = ( k - i ) / N;
			const sx = ( top[ i < N - 1 ? k + 1 : k ] - top[ i > 0 ? k - 1 : k ] ) / ( ( i > 0 && i < N - 1 ? 2 : 1 ) * cs );
			const sz = ( top[ j < N - 1 ? k + N : k ] - top[ j > 0 ? k - N : k ] ) / ( ( j > 0 && j < N - 1 ? 2 : 1 ) * cs );
			const s = Math.sqrt( sx * sx + sz * sz ), lim = s > 1.6 ? 1.6 / s : 1;
			const dk = c[ k ], run = env.drain * smooth( 0.12, 0.9, dk ) * ( 1 - 0.9 * this.cling[ k ] );
			U[ k ] = env.windX - sx * lim * run + vx[ k ];
			W[ k ] = env.windZ - sz * lim * run + vz[ k ];
			if ( dk > 0.02 ) { mx += env.windX * dk; mz += env.windZ * dk; mw += dk; }
			loss[ k ] = windLoss * ( 1 - 0.75 * this.cling[ k ] );

		}

		if ( mw > 0 ) { this.drift.x = mx / mw; this.drift.z = mz / mw; }

		// carry the fog along (semi-Lagrangian); what comes from beyond the domain is clear air
		const kx = dt / cs;
		for ( let j = 0; j < N; j ++ ) for ( let i = 0; i < N; i ++ ) {

			const k = j * N + i;
			if ( ! on[ k ] ) { d[ k ] = 0; fresh[ k ] = 0; continue; }
			let bx = i - U[ k ] * kx, bz = j - W[ k ] * kx;
			const outside = bx < 0 || bz < 0 || bx > N - 1 || bz > N - 1;
			bx = clamp( bx, 0, N - 1.001 ); bz = clamp( bz, 0, N - 1.001 );
			const i0 = bx | 0, j0 = bz | 0, tx = bx - i0, tz = bz - j0, q = j0 * N + i0;
			const w00 = ( 1 - tx ) * ( 1 - tz ), w10 = tx * ( 1 - tz ), w01 = ( 1 - tx ) * tz, w11 = tx * tz;
			let D = outside ? 0 : c[ q ] * w00 + c[ q + 1 ] * w10 + c[ q + N ] * w01 + c[ q + N + 1 ] * w11;
			if ( D > 1e-5 ) h[ k ] = ( hd[ q ] * w00 + hd[ q + 1 ] * w10 + hd[ q + N ] * w01 + hd[ q + N + 1 ] * w11 ) / D;
			fresh[ k ] = outside ? 0 : f[ q ] * w00 + f[ q + 1 ] * w10 + f[ q + N ] * w01 + f[ q + N + 1 ] * w11;
			// where the flow converges the fog piles up: denser and deeper
			const div = ( ( i < N - 1 ? U[ k + 1 ] : 0 ) - ( i > 0 ? U[ k - 1 ] : 0 ) + ( j < N - 1 ? W[ k + N ] : 0 ) - ( j > 0 ? W[ k - N ] : 0 ) ) / ( 2 * cs );
			const g = Math.sqrt( clamp( 1 - div * dt, 0.7, 1.3 ) );
			D *= g;
			let hh = h[ k ] * g;
			if ( D > MAX_D ) { hh *= D / MAX_D; D = MAX_D; }
			h[ k ] = Math.min( hh, MAX_H );
			d[ k ] = D;

		}

		// spread, and level the surface where the ground is flat
		const spread = Math.min( 0.2, env.diffusion * dt ), level = Math.min( 0.45, env.level * dt );
		for ( let k = 0; k < CELLS; k ++ ) { c[ k ] = d[ k ]; hd[ k ] = ground[ k ] + h[ k ]; }
		for ( let j = 0; j < N; j ++ ) for ( let i = 0; i < N; i ++ ) {

			const k = j * N + i;
			if ( ! on[ k ] ) continue;
			const v = c[ k ];
			const l = i > 0 ? k - 1 : k, r = i < N - 1 ? k + 1 : k, u = j > 0 ? k - N : k, b = j < N - 1 ? k + N : k;
			const nv = v + spread * ( c[ l ] + c[ r ] + c[ u ] + c[ b ] - 4 * v );
			d[ k ] = nv;
			if ( nv < VISIBLE * 0.25 ) continue;
			const t0 = hd[ k ];
			// (the cloud on the mountain takes no part: its deep top would lift the mist at its foot)
			const cl = this.cling, wn = ( q ) => c[ q ] / ( c[ q ] + 0.08 ) * ( 1 - cl[ q ] );
			const wl = wn( l ), wr = wn( r ), wu = wn( u ), wb = wn( b );
			const pull = wl * ( hd[ l ] - t0 ) + wr * ( hd[ r ] - t0 ) + wu * ( hd[ u ] - t0 ) + wb * ( hd[ b ] - t0 );
			h[ k ] = Math.max( MIN_H, t0 + level * this.flat[ k ] * ( 1 - cl[ k ] ) * pull * 0.25 - ground[ k ] );

		}

		// burn off
		const freshFade = Math.exp( - dt / 5 ), momentum = Math.exp( - dt * 2.4 ), thin = Math.exp( - env.sun * 0.35 * dt ), wisp = 0.0025 * dt;
		let left = false;
		for ( let k = 0; k < CELLS; k ++ ) {

			if ( ! on[ k ] ) continue;
			vx[ k ] *= momentum; vz[ k ] *= momentum;
			if ( d[ k ] < 1e-5 ) { d[ k ] = 0; continue; }
			// (freshly poured fog shrugs the sun off for a while)
			// (cloud blown off the mountain evaporates as it sinks: the low ground keeps its shallow mist)
			const lee = 0.3 * ( 1 - this.cling[ k ] ) * smooth( 0.7, 1.3, h[ k ] );
			const rate = env.base + env.sun * ( 1 - 0.65 * fresh[ k ] ) * ( 1 - 0.5 * this.cling[ k ] ) + env.dry + loss[ k ] + lee;
			const v = d[ k ];
			// the last wisps go quickly
			const nv = v * Math.exp( - rate * dt ) - ( v < 0.08 ? wisp * ( 1 - v / 0.08 ) : 0 );
			d[ k ] = nv > 0 ? Math.min( nv, MAX_D ) : 0;
			h[ k ] = Math.max( MIN_H, h[ k ] * thin );
			fresh[ k ] *= freshFade;
			if ( d[ k ] > 0 ) left = true;

		}

		this.empty = ! left;

	}

	// cells with fog, grown by three cells (the only ones the step visits)
	_activeMask( c ) {

		const a = this._m1, b = this._m2, R = 3;
		for ( let k = 0; k < CELLS; k ++ ) a[ k ] = c[ k ] > 1e-5 ? 1 : 0;
		for ( let j = 0; j < N; j ++ ) {

			const o = j * N;
			for ( let i = 0; i < N; i ++ ) {

				let v = 0;
				for ( let q = Math.max( 0, i - R ), e = Math.min( N - 1, i + R ); q <= e && ! v; q ++ ) v = a[ o + q ];
				b[ o + i ] = v;

			}

		}

		for ( let j = 0; j < N; j ++ ) {

			const j0 = Math.max( 0, j - R ), j1 = Math.min( N - 1, j + R );
			for ( let i = 0; i < N; i ++ ) {

				let v = 0;
				for ( let q = j0; q <= j1 && ! v; q ++ ) v = b[ q * N + i ];
				a[ j * N + i ] = v;

			}

		}

		return a;

	}

	// Writes this.data (what the march samples) and the bounds of the visible fog.
	pack() {

		const { d, h, ground, top, data, fresh, vx, vz } = this;
		const t = this._t, a = this._a, b = this._b, c = this._c, e = this._e;
		let sum = 0, peak = 0;
		for ( let k = 0; k < CELLS; k ++ ) {

			const v = d[ k ];
			// thin fog lies lower than its nominal thickness
			t[ k ] = ground[ k ] + h[ k ] * ( 0.45 + 0.55 * smooth( 0, 0.8, v ) );
			a[ k ] = v + 0.002;
			b[ k ] = a[ k ] * t[ k ];
			sum += v < 1 ? v : 1;
			if ( v > peak ) peak = v;

		}

		this.amount = sum / CELLS;
		this.empty = peak < 1e-5;
		// the layer top, smoothed over 3 x 3 cells weighted by density (no steps between cells)
		this._box3( a, c ); this._box3( b, e );
		for ( let k = 0; k < CELLS; k ++ ) top[ k ] = e[ k ] / c[ k ];
		this._max3( d, c );
		const g = this.bounds;
		g.minX = g.minZ = g.minY = Infinity; g.maxX = g.maxZ = g.maxY = - Infinity;
		let any = false;
		for ( let j = 0; j < N; j ++ ) {

			const z = this.cellZ( j );
			for ( let i = 0; i < N; i ++ ) {

				const k = j * N + i, gr = ground[ k ];
				if ( c[ k ] > VISIBLE ) {

					any = true;
					const x = this.cellX( i );
					// the billows rise above the layer top by up to 0.6 of its thickness
					const hi = Math.max( top[ k ] + 0.08 + 0.62 * Math.max( 0.08, Math.min( 1, top[ k ] - gr ) ), gr + 0.06 );
					if ( x < g.minX ) g.minX = x; if ( x > g.maxX ) g.maxX = x;
					if ( z < g.minZ ) g.minZ = z; if ( z > g.maxZ ) g.maxZ = z;
					if ( gr < g.minY ) g.minY = gr; if ( hi > g.maxY ) g.maxY = hi;

				}

				const o = k * 4, sp = vx[ k ] * vx[ k ] + vz[ k ] * vz[ k ];
				data[ o ] = d[ k ] * this.edge[ k ];
				data[ o + 1 ] = top[ k ] * FOG_UNIT + this.seaLevel;
				data[ o + 2 ] = gr * FOG_UNIT + this.seaLevel;
				data[ o + 3 ] = Math.min( 1, fresh[ k ] + ( sp > 0 ? Math.sqrt( sp ) * 0.5 : 0 ) );

			}

		}

		this.any = any;
		if ( any ) {

			const pad = 1.5 * this.size / N;
			g.minX -= pad; g.maxX += pad; g.minZ -= pad; g.maxZ += pad;
			g.minY = g.minY * FOG_UNIT + this.seaLevel - 1; g.maxY = g.maxY * FOG_UNIT + this.seaLevel + 2;

		}

	}

	_box3( src, out ) {

		const row = this._row;
		for ( let j = 0; j < N; j ++ ) for ( let i = 0, o = j * N; i < N; i ++ ) row[ o + i ] = src[ o + i ] + ( i > 0 ? src[ o + i - 1 ] : 0 ) + ( i < N - 1 ? src[ o + i + 1 ] : 0 );
		for ( let j = 0; j < N; j ++ ) for ( let i = 0, o = j * N; i < N; i ++ ) out[ o + i ] = row[ o + i ] + ( j > 0 ? row[ o - N + i ] : 0 ) + ( j < N - 1 ? row[ o + N + i ] : 0 );

	}

	_max3( src, out ) {

		const row = this._row;
		for ( let j = 0; j < N; j ++ ) for ( let i = 0, o = j * N; i < N; i ++ ) row[ o + i ] = Math.max( src[ o + i ], i > 0 ? src[ o + i - 1 ] : 0, i < N - 1 ? src[ o + i + 1 ] : 0 );
		for ( let j = 0; j < N; j ++ ) for ( let i = 0, o = j * N; i < N; i ++ ) out[ o + i ] = Math.max( row[ o + i ], j > 0 ? row[ o - N + i ] : 0, j < N - 1 ? row[ o + N + i ] : 0 );

	}

	// Fog density at a world position (0 = clear): with y, inside the layer only.
	densityAt( x, z, y ) {

		const cs = this.size / N;
		const fx = clamp( ( x - this.origin ) / cs - 0.5, 0, N - 1.001 ), fz = clamp( ( z - this.origin ) / cs - 0.5, 0, N - 1.001 );
		const i = fx | 0, j = fz | 0, tx = fx - i, tz = fz - j, o = ( j * N + i ) * 4, D = this.data;
		const at = ( ch ) => ( D[ o + ch ] * ( 1 - tx ) + D[ o + 4 + ch ] * tx ) * ( 1 - tz ) + ( D[ o + N * 4 + ch ] * ( 1 - tx ) + D[ o + N * 4 + 4 + ch ] * tx ) * tz;
		const v = Math.max( 0, at( 0 ) );
		if ( y === undefined || v <= 0 ) return v;
		const top = at( 1 ), gr = at( 2 ), H = top - gr;
		if ( H <= 0 || y < gr ) return 0;
		const soft = Math.max( 0.05 * FOG_UNIT, 0.42 * H );
		return v * smooth( top + 0.5, top - soft, y ) * ( 1.25 - 0.45 * clamp( ( y - gr ) / Math.max( H, 1 ), 0, 1 ) );

	}

}

// The sources and losses for the hour and the air. In: { hour (0..24), humidity (0..1), wind (m/s),
// night (0..1), sunElevation (the key light's sin of elevation by day), cloudCover (0..1) }.
// Writes src (rates and targets for FogField.sources) and env (for FogField.step); returns how
// strongly sea smoke should streak the fog over water (0..1).
export function fogClimate( src, env, { hour, humidity, wind, night, sunElevation, cloudCover = 0, windX = 0, windZ = 0 } ) {

	const day = 1 - night, t = ( ( hour / 24 ) % 1 + 1 ) % 1;
	// the cold hours: around sunrise most of all, a little at dusk and through the night
	const dawn = Math.exp( - ( ( ( t - 0.27 ) / 0.075 ) ** 2 ) ), dusk = 0.6 * Math.exp( - ( ( ( t - 0.79 ) / 0.06 ) ** 2 ) );
	const cool = Math.max( dawn, dusk, night * 0.55 );
	const humid = smooth( 0.5, 0.84, humidity );
	const energy = wind * 0.25;
	const calm = smooth( 2.4, 0.7, energy );
	const sunUp = day * smooth( 0.12, 0.55, sunElevation );
	const chill = 0.5 + 0.5 * cool;

	// radiation fog in the hollows and over the lagoon
	src.valley = 0.06 * cool * humid * chill * calm * ( 1 - sunUp );
	src.valleyTarget = 0.26 + 0.24 * humid;
	src.valleyTop = 0.62 + 0.28 * humid * cool;
	// sea smoke on the shallows in the cold hours
	src.steam = 0.045 * cool * humid * calm;
	src.steamTarget = 0.3;
	// cloud on the mountain: moist air lifted up the slopes (it wants some wind, unlike the mist below),
	// fullest in the cool hours, thinning to wisps under a high sun
	src.bank = 0.07 * smooth( 0.55, 0.9, humidity ) * ( 0.5 + 0.5 * chill ) * ( 0.5 + 0.5 * smooth( 4, 1.5, energy ) ) * ( 1 - 0.6 * day * smooth( 0.3, 0.8, sunElevation ) );
	src.bankTarget = 0.5;
	// a thin mist everywhere when it is saturated
	src.mist = 0.06 * smooth( 0.9, 1, humidity ) * ( 0.4 + 0.6 * humid );
	src.mistTarget = 0.3;

	env.windX = windX; env.windZ = windZ; env.energy = energy;
	env.drain = 0.32; env.diffusion = 0.4; env.level = 1.6; env.base = 0.0015; env.windK = 0.09;
	env.sun = 0.018 * day * Math.pow( Math.max( 0, sunElevation ), 0.8 ) * ( 1 - 0.5 * cloudCover );
	env.dry = 0.06 * Math.max( 0, 0.6 - humidity );
	return clamp( cool * humid * 0.8, 0, 1 );

}

// ---------------------------------------------------------------- noise volume

const sat = ( x ) => clamp( x, 0, 1 );

// tileable Worley noise with `cells` cells per side: 1 at a feature point, 0 a cell away
function worley( cells, rnd ) {

	const pts = new Float32Array( cells * cells * cells * 3 );
	for ( let i = 0; i < pts.length; i ++ ) pts[ i ] = rnd();
	return ( x, y, z ) => {

		const px = x * cells, py = y * cells, pz = z * cells;
		const ix = Math.floor( px ), iy = Math.floor( py ), iz = Math.floor( pz );
		let best = 9;
		for ( let dz = - 1; dz <= 1; dz ++ ) {

			const cz = iz + dz, wz = ( cz % cells + cells ) % cells;
			for ( let dy = - 1; dy <= 1; dy ++ ) {

				const cy = iy + dy, wy = ( cy % cells + cells ) % cells;
				for ( let dx = - 1; dx <= 1; dx ++ ) {

					const cx = ix + dx, wx = ( cx % cells + cells ) % cells, o = ( ( wz * cells + wy ) * cells + wx ) * 3;
					const ax = cx + pts[ o ] - px, ay = cy + pts[ o + 1 ] - py, az = cz + pts[ o + 2 ] - pz;
					const q = ax * ax + ay * ay + az * az;
					if ( q < best ) best = q;

				}

			}

		}

		return 1 - sat( Math.sqrt( best ) );

	};

}

// tileable gradient noise: ( x, y, z, period ) -> about -1..1
function perlin( rnd ) {

	const grad = new Float32Array( 768 );
	for ( let i = 0; i < 256; i ++ ) {

		const u = rnd() * 2 - 1, a = rnd() * Math.PI * 2, s = Math.sqrt( 1 - u * u );
		grad[ i * 3 ] = s * Math.cos( a ); grad[ i * 3 + 1 ] = s * Math.sin( a ); grad[ i * 3 + 2 ] = u;

	}

	const perm = new Uint8Array( 512 );
	for ( let i = 0; i < 256; i ++ ) perm[ i ] = i;
	for ( let i = 255; i > 0; i -- ) { const j = Math.floor( rnd() * ( i + 1 ) ), v = perm[ i ]; perm[ i ] = perm[ j ]; perm[ j ] = v; }
	for ( let i = 0; i < 256; i ++ ) perm[ i + 256 ] = perm[ i ];
	const fade = ( t ) => t * t * t * ( t * ( t * 6 - 15 ) + 10 );
	const dot = ( i, j, k, x, y, z ) => { const o = perm[ perm[ perm[ i ] + j ] + k ] * 3; return grad[ o ] * x + grad[ o + 1 ] * y + grad[ o + 2 ] * z; };
	return ( x, y, z, period ) => {

		const xi = Math.floor( x ), yi = Math.floor( y ), zi = Math.floor( z ), fx = x - xi, fy = y - yi, fz = z - zi;
		const i0 = ( xi % period + period ) % period, i1 = ( i0 + 1 ) % period;
		const j0 = ( yi % period + period ) % period, j1 = ( j0 + 1 ) % period;
		const k0 = ( zi % period + period ) % period, k1 = ( k0 + 1 ) % period;
		const u = fade( fx ), v = fade( fy ), w = fade( fz );
		const L = ( a, b, t ) => a + ( b - a ) * t;
		const a = L( dot( i0, j0, k0, fx, fy, fz ), dot( i1, j0, k0, fx - 1, fy, fz ), u );
		const b = L( dot( i0, j1, k0, fx, fy - 1, fz ), dot( i1, j1, k0, fx - 1, fy - 1, fz ), u );
		const c = L( dot( i0, j0, k1, fx, fy, fz - 1 ), dot( i1, j0, k1, fx - 1, fy, fz - 1 ), u );
		const d = L( dot( i0, j1, k1, fx, fy - 1, fz - 1 ), dot( i1, j1, k1, fx - 1, fy - 1, fz - 1 ), u );
		return L( L( a, b, v ), L( c, d, v ), w ) * 1.5;

	};

}

// The fog's tileable noise volume, size³ rgba8: r = broad smooth rolls, g = rounded puffs (Worley,
// three scales), b = a second smooth field, a = fine puffs. Each channel is stretched to its 1st to
// 99th percentile so the march's thresholds mean the same on every channel.
export function fogNoiseData( size = 32, seed = 3846 ) {

	const rnd = fogRandom( seed ), p = perlin( rnd );
	const w3 = worley( 3, rnd ), w6 = worley( 6, rnd ), w12 = worley( 12, rnd );
	const count = size * size * size, raw = new Float32Array( count * 4 ), inv = 1 / size;
	let o = 0;
	for ( let k = 0; k < size; k ++ ) {

		const z = ( k + 0.5 ) * inv;
		for ( let j = 0; j < size; j ++ ) {

			const y = ( j + 0.5 ) * inv;
			for ( let i = 0; i < size; i ++ ) {

				const x = ( i + 0.5 ) * inv;
				let n0 = 0, n1 = 0, amp = 0.55, f = 2;
				for ( let q = 0; q < 3; q ++ ) { n0 += amp * p( x * f, y * f, z * f, f ); amp *= 0.5; f *= 2; }
				amp = 0.55; f = 4;
				for ( let q = 0; q < 3; q ++ ) { n1 += amp * p( x * f + 7.3, y * f + 1.9, z * f + 4.1, f ); amp *= 0.5; f *= 2; }
				const a = w3( x, y, z ), b = w6( x, y, z ), c = w12( x, y, z );
				raw[ o ++ ] = n0 * 0.5 + 0.5;
				raw[ o ++ ] = a * 0.6 + b * 0.28 + c * 0.12;
				raw[ o ++ ] = n1 * 0.5 + 0.5;
				raw[ o ++ ] = b * 0.65 + c * 0.35;

			}

		}

	}

	const out = new Uint8Array( count * 4 ), hist = new Uint32Array( 512 );
	for ( let ch = 0; ch < 4; ch ++ ) {

		hist.fill( 0 );
		for ( let q = ch; q < raw.length; q += 4 ) hist[ clamp( Math.floor( raw[ q ] * 511 ), 0, 511 ) ] ++;
		let lo = 0, hi = 511, acc = 0;
		for ( let q = 0; q < 512; q ++ ) { acc += hist[ q ]; if ( acc > count * 0.01 ) { lo = q; break; } }
		acc = 0;
		for ( let q = 511; q >= 0; q -- ) { acc += hist[ q ]; if ( acc > count * 0.01 ) { hi = q; break; } }
		const base = lo / 511, scale = 1 / Math.max( 0.001, ( hi - lo ) / 511 );
		for ( let q = ch; q < raw.length; q += 4 ) out[ q ] = Math.round( sat( ( raw[ q ] - base ) * scale ) * 255 );

	}

	return out;

}
