import { ShaderModule, UniformBlock } from '../engine/gpu/Shader.js';
import { Texture, RenderTarget } from '../engine/gpu/Texture.js';
import { FullscreenPass } from '../engine/render/FullscreenPass.js';
import { G } from '../engine/render/Frame.js';
import { Vector2, Vector3, Vector4, DataUtils } from '../engine/math/index.js';
import { FogField, fogClimate, fogNoiseData, FOG_UNIT, FOG_RES } from './FogField.js';

// Ground fog: mist that pools in the hollows and on the lagoon around dawn, sea smoke on the
// shallows, banks on the upper slopes in very humid air. A simulated field (FogField: it drifts with
// the wind, drains downhill, levels and burns off) drawn as a ray-marched volume:
//  - the march runs at half resolution (with the haze passes) through the layer the field describes,
//    with a billowing top and eroded body from a tileable 3D noise that drifts with the fog,
//  - lit by the key light through the fog itself (a few taps toward the light), the shadow cascades,
//    the hill shadow and the cloud shadow (so palms and ridges cast shafts into it), plus the sky,
//  - accumulated over time and composited over the hazed scene by AirHaze (hazeApply).
// Nothing is drawn, and no pass runs, while the field is empty.
//
// WGSL (prefix `fog`): paramsModule (the uniforms alone, for the composite). Consumed: the haze
// module (camera rays, hazeVisibilityRest, hazeLayerDepth), the engine shadow module's sunShadowHard.

const STEPS = 48;
const CLR = [ 0, 0, 0, 0 ];
const STEP_S = 1 / 15; // field step (s)

const f = ( x ) => {

	const s = String( x );
	return s.includes( '.' ) || s.includes( 'e' ) ? s : s + '.0';

};

export class GroundFog {

	// terrain: TerrainData (heightAt, size). clouds: optional (coverage dims the sun's burn-off).
	constructor( { terrain, clouds = null } ) {

		this.clouds = clouds;
		this.haze = null; // set by AirHaze
		this.field = new FogField( terrain, { size: terrain.size, seaLevel: G.seaLevel.value } );
		// how much fog the air makes: 0 none, 0.6 mist at dawn and in the night, 1 banks and standing mist
		this.amount = 0.6;
		this.hour = 12;
		this._src = {}; this._env = {};
		this._acc = 0; this._dirty = true; this._steamLook = 0;

		this.fieldTexture = new Texture( { label: 'fogField', width: FOG_RES, height: FOG_RES, format: 'rgba16float', usage: [ 'sample', 'copyDst' ] } );
		this._half = new Uint16Array( FOG_RES * FOG_RES * 4 );
		this.noiseTexture = new Texture( { label: 'fogNoise', width: 32, height: 32, depth: 32, dimension: '3d', format: 'rgba8unorm', data: fogNoiseData( 32 ), sampler: 'linearRepeat' } );

		this.uniforms = new UniformBlock( 'FogParams', {
			boxMin: [ 'vec3f', new Vector3() ],
			any: [ 'f32', 0 ], // there is fog to draw
			boxMax: [ 'vec3f', new Vector3() ],
			steam: [ 'f32', 0 ], // sea smoke styling over water (0..1)
			// x extinction per field unit at density 1, y sun gain, z sky gain, w extra sun gain at night
			look: [ 'vec4f', new Vector4( 3.6, 0.17, 0.85, 0.6 ) ],
			drift0: [ 'vec4f', new Vector4() ], // xyz: offset of the broad noise (texture space), w: rise of the sea smoke
			drift1: [ 'vec4f', new Vector4() ], // xyz: offset of the detail noise
			origin: [ 'vec2f', new Vector2( this.field.origin, this.field.origin ) ],
			size: [ 'f32', this.field.size ],
			frame: [ 'f32', 0 ],
			histValid: [ 'f32', 0 ],
		}, { label: 'fog' } );
		this.paramsModule = new ShaderModule( { name: 'fog-params', uniforms: this.uniforms, uniformName: 'fogParams', code: '' } );

		// half resolution: colour (premultiplied) + alpha, and the distance of the fog along the ray
		this.low = new RenderTarget( 1, 1, { colors: [ 'rgba16float', 'r16float' ], label: 'fogMarch' } );
		this.hist = [ 0, 1 ].map( ( i ) => new RenderTarget( 1, 1, { colors: [ 'rgba16float' ], label: 'fogHistory' + i } ) );
		this._hc = 0;
		this._histValid = false;
		this._passes = null;
		this._upload();

	}

	// the accumulated fog (what the composite reads)
	get texture() { return this.hist[ this._hc ].texture; }

	get active() { return this.field.any && this.amount > 0; }

	setSize( w, h ) {

		this.low.setSize( w, h );
		for ( const r of this.hist ) r.setSize( w, h );
		this._histValid = false;

	}

	// Pours fog at a world position (see FogField.addFog).
	addFog( x, z, radius, amount, thickness, push, fresh ) {

		this.field.addFog( x, z, radius, amount, thickness, push, fresh );
		this._dirty = true;

	}

	clear() { this.field.clear(); this._dirty = true; }

	_inputs() {

		const wind = G.windSpeed.value, dir = G.windDir.value, night = G.night.value;
		// the air at fog height moves at about 0.6 of the 10 m wind
		const k = wind * 0.6 / FOG_UNIT;
		return {
			hour: this.hour, humidity: 0.5 + 0.5 * Math.min( 1, this.amount ), wind, night,
			sunElevation: night > 0.5 ? 0 : Math.max( 0, G.sunDir.value.y ),
			cloudCover: this.clouds?.coverage?.value ?? 0,
			windX: dir.x * k, windZ: dir.y * k,
		};

	}

	// Lets the field settle for `seconds` of the current hour and air (a session that starts at dawn
	// starts with its mist).
	prime( seconds = 40 ) {

		const steam = fogClimate( this._src, this._env, this._inputs() );
		const s = this._src;
		if ( this.amount <= 0 || ! this.field.empty || s.valley + s.steam + s.bank + s.mist < 1e-4 ) return;
		for ( let t = 0; t < seconds; t += 0.1 ) { this.field.sources( 0.1, s, t ); this.field.step( 0.1, this._env ); }
		this._steamLook = steam;
		this._dirty = true;

	}

	// per frame. hour: the clock (0..24).
	update( dt, hour ) {

		this.hour = hour;
		if ( ! this._primed ) { this._primed = true; this.prime(); }
		const field = this.field, U = this.uniforms.fields;
		if ( dt > 0 ) {

			const steam = fogClimate( this._src, this._env, this._inputs() );
			this._steamLook += ( steam - this._steamLook ) * Math.min( 1, dt * 0.5 );
			this._acc += dt;
			if ( this._acc >= STEP_S ) {

				const step = Math.min( this._acc, 0.1 );
				this._acc = 0;
				const s = this._src, feeding = this.amount > 0 && s.valley + s.steam + s.bank + s.mist > 1e-5;
				if ( feeding || ! field.empty ) {

					if ( feeding ) field.sources( step, s, G.time.value );
					field.step( step, this._env );
					this._dirty = true;

				}

			}

			// the noise travels with the fog
			const e = this._env, w = field.any ? 0.6 : 0;
			const vx = e.windX * ( 1 - w ) + field.drift.x * w, vz = e.windZ * ( 1 - w ) + field.drift.z * w;
			const a = U.drift0.value, b = U.drift1.value, fr = ( v ) => v - Math.floor( v );
			a.x = fr( a.x + vx * 0.85 * 0.42 * dt ); a.z = fr( a.z + vz * 0.85 * 0.42 * dt );
			a.y = fr( a.y - 0.006 * dt ); a.w = fr( a.w + 0.07 * dt );
			b.x = fr( b.x + vx * 0.8 * dt ); b.z = fr( b.z + vz * 0.8 * dt ); b.y = fr( b.y - 0.035 * dt );

		}

		if ( this._dirty ) { field.pack(); this._upload(); this._dirty = false; }
		U.any.value = this.active && G.cameraUnderwater.value < 0.5 ? 1 : 0;
		U.steam.value = this._steamLook;
		U.frame.value = ( U.frame.value + 1 ) % 1024;
		const g = field.bounds;
		if ( field.any ) { U.boxMin.value.set( g.minX, g.minY, g.minZ ); U.boxMax.value.set( g.maxX, g.maxY, g.maxZ ); }

	}

	_upload() {

		const src = this.field.data, dst = this._half;
		for ( let i = 0; i < src.length; i ++ ) dst[ i ] = DataUtils.toHalfFloat( src[ i ] );
		this.fieldTexture.upload( dst );

	}

	// record the march and its accumulation (AirHaze.render calls this, before the composite)
	render() {

		const on = this.uniforms.fields.any.value > 0.5;
		if ( ! on ) { this._histValid = false; return; }
		if ( ! this._passes ) this._build();
		const p = this._passes;
		p.march.render( { colorViews: [ this.low.textures[ 0 ], this.low.textures[ 1 ] ], clear: CLR } );
		this.uniforms.fields.histValid.value = this._histValid ? 1 : 0;
		p.temporal[ this._hc ].render( { colorViews: [ this.hist[ 1 - this._hc ].texture ], clear: CLR } );
		this._hc = 1 - this._hc;
		this._histValid = true;

	}

	get module() {

		if ( this._module ) return this._module;
		this._module = new ShaderModule( {
			name: 'fog',
			deps: [ this.haze.module, this.paramsModule ],
			bindings: {
				fogFieldTex: { texture: this.fieldTexture },
				fogNoiseTex: { texture: this.noiseTexture },
			},
			code: /* wgsl */`
const FG_U: f32 = ${ f( FOG_UNIT ) };      // metres per field unit: the march works in field units above sea level
const FG_NB: vec3f = vec3f( 0.42, 0.9, 0.42 );  // broad rolls (one tile = 2.4 units)
const FG_ND: vec3f = vec3f( 0.8, 1.3, 0.8 );    // detail wisps (one tile = 1.25 units)

// the field at world xz (m): x density, y layer top, z ground (both in field units above sea level), w billow
fn fogAt( xz: vec2f ) -> vec4f {
	let s = textureSampleLevel( fogFieldTex, smpLinearClamp, clamp( ( xz - fogParams.origin ) / fogParams.size, vec2f( 0.0 ), vec2f( 1.0 ) ), 0.0 );
	return vec4f( s.x, ( s.y - frame.seaLevel ) / FG_U, ( s.z - frame.seaLevel ) / FG_U, s.w );
}

fn fogNoise( p: vec3f ) -> vec4f { return textureSampleLevel( fogNoiseTex, smpLinearRepeat, p, 0.0 ); }

fn fogHG( c: f32, g: f32 ) -> f32 { let g2 = g * g; return ( 1.0 - g2 ) / pow( max( 1.0 + g2 - 2.0 * g * c, 1e-3 ), 1.5 ); }

// sun visibility at a point in field units: cascades, hills, clouds
fn fogSunAt( p: vec3f ) -> f32 {
	let P = p * FG_U + vec3f( 0.0, frame.seaLevel, 0.0 );
	return sunShadowHard( P );
}
`,
		} );
		return this._module;

	}

	_build() {

		const defines = this.haze._defines();
		const march = new FullscreenPass( {
			label: 'fog march',
			modules: [ this.module ],
			defines,
			colorFormats: [ 'rgba16float', 'r16float' ],
			code: /* wgsl */`
struct FogOut { @location( 0 ) color: vec4f, @location( 1 ) dist: vec4f };
@fragment fn fs( in: FSIn ) -> FogOut {
	let R = hazeRay( in.uv );
	var out: FogOut;
	out.color = vec4f( 0.0 );
	out.dist = vec4f( R.dist, 0.0, 0.0, 1.0 );
	if ( fogParams.any < 0.5 ) { return out; }

	let cam = underwaterParams.camPos;
	let rd = R.dir;
	let safe = select( rd, vec3f( 1e-5 ), abs( rd ) < vec3f( 1e-5 ) );
	let ta = ( fogParams.boxMin - cam ) / safe; let tb = ( fogParams.boxMax - cam ) / safe;
	let tmn = min( ta, tb ); let tmx = max( ta, tb );
	let tEntryM = max( max( max( tmn.x, tmn.y ), tmn.z ), 0.0 );
	let tMaxM = min( min( min( tmx.x, tmx.y ), tmx.z ), R.dist );
	if ( tMaxM <= tEntryM ) { return out; }

	// field units above sea level from here on
	let ro = ( cam - vec3f( 0.0, frame.seaLevel, 0.0 ) ) / FG_U;
	let tEntry = tEntryM / FG_U; let tMax = tMaxM / FG_U;
	// the step follows the local layer depth along the ray (fine through thin sheets, coarse through
	// deep banks), and grows with the distance
	let invY = 1.0 / max( abs( rd.y ), 0.22 );
	let dsMin = 0.022; let dsMax = 0.15;

	let L = frame.sunDir;
	let cosT = dot( rd, L );
	let ph0 = mix( fogHG( cosT, -0.2 ), fogHG( cosT, 0.72 ), 0.55 );   // single scatter: a glow toward the sun
	let ph1 = mix( fogHG( cosT, -0.1 ), fogHG( cosT, 0.4 ), 0.5 );
	let ph2 = mix( fogHG( cosT, -0.05 ), fogHG( cosT, 0.18 ), 0.5 );
	let look = fogParams.look;
	let sunCol = frame.sunColor * look.y * ( 1.0 + frame.night * look.w );
	let skyCol = frame.skyIrradiance * look.z;
	// light off the ground and the water under the fog
	let bounce = ( frame.skyIrradiance * vec3f( 0.5, 0.48, 0.4 ) + frame.sunColor * 0.05 * max( L.y, 0.0 ) * vec3f( 1.0, 0.82, 0.66 ) ) * look.z;
	let vertK = 0.5 / max( L.y, 0.14 );   // optical path out through the layer top, per unit depth
	let sT1 = normalize( cross( L, select( vec3f( 1.0, 0.0, 0.0 ), vec3f( 0.0, 1.0, 0.0 ), abs( L.y ) < 0.95 ) ) );
	let sT2 = cross( L, sT1 );
	let sigma = look.x;
	let albedo = vec3f( 0.95, 0.96, 0.98 );

	var T = 1.0;
	var col = vec3f( 0.0 );
	let jit = fract( interleavedGradientNoise( in.pos.xy ) + fogParams.frame * 0.61803398875 );
	var t = tEntry;
	var tFirst = -1.0;

	for ( var i = 0; i < ${ STEPS }; i++ ) {
		if ( t > tMax || T < 0.03 ) { break; }
		let p0 = ro + rd * t;
		let fd = fogAt( p0.xz * FG_U );
		let D = fd.x; let topY = fd.y; let floorY = fd.z; let billow = fd.w;
		let H = topY - floorY;                                 // layer thickness here
		// (half as fast inside dense fog: a deep bank on the mountain gets several samples, while thin
		// mist around the camera does not use up the steps that have to reach it)
		var ds = max( clamp( ( max( H, 0.0 ) + 0.08 ) * invY * 0.125, dsMin, dsMax ), t * mix( 0.14, 0.07, smoothstep( 0.15, 0.4, D ) ) );
		// clear air between the patches: a third of a cell at a time
		if ( D < 0.004 ) { ds = max( ds, 0.2 ); }
		// empty space above the highest possible billow: drop straight to the layer top
		let ceilY = topY + 0.6 * clamp( H, 0.08, 1.0 ) + 0.03;
		if ( rd.y < -0.05 && p0.y > ceilY + ds ) {
			t += ( p0.y - ceilY ) / - rd.y;
			continue;
		}
		// a step longer than the way through the layer would mostly land outside it (a thin sheet seen
		// from far above turned to a dither pattern): one step spans the layer instead
		if ( rd.y < -0.05 && p0.y <= ceilY + ds ) { ds = min( ds, max( ( p0.y - floorY ) / - rd.y, dsMin ) ); }
		if ( rd.y > 0.05 && p0.y < ceilY ) { ds = min( ds, max( ( ceilY - p0.y ) / rd.y, dsMin ) ); }
		let p = ro + rd * ( t + ds * jit );                    // jittered sample inside this segment
		t += ds;
		if ( p.y < floorY || D <= 0.004 || H <= 0.0 ) { continue; }

		let h = p.y - floorY;
		let hf = clamp( h / max( H, 0.05 ), 0.0, 1.0 );
		// far away the rolls and wisps are smaller than a pixel and a step: they fade to their mean
		// (the tiling noise read as a regular pattern over the sea from the summit)
		// (a deep bank keeps its shapes further out than a thin sheet)
		let far = 1.0 + 2.0 * clamp( H, 0.0, 2.0 );
		let nb = mix( vec4f( 0.5 ), fogNoise( p * FG_NB - fogParams.drift0.xyz ), 1.0 - smoothstep( 10.0 * far, 36.0 * far, t ) );
		let nd = mix( vec4f( 0.5 ), fogNoise( p * FG_ND - fogParams.drift1.xyz + ( nb.gbr - 0.5 ) * 0.22 ), 1.0 - smoothstep( 5.0 * far, 18.0 * far, t ) );

		// billowing, soft top: broad rolls + small curls, livelier where fog has just arrived
		let amp = clamp( H, 0.08, 1.0 ) * ( 0.55 + 0.45 * billow );
		let topN = topY + ( ( nb.r - 0.5 ) * 1.1 + ( nd.r - 0.5 ) * 0.18 ) * amp;
		let soft = max( 0.035, 0.3 * H );
		var prof = smoothstep( topN + 0.015, topN - soft, p.y );
		prof *= mix( 1.22, 0.85, hf );                         // settles toward the ground
		prof *= smoothstep( 0.0, 0.03, h );                    // no hard seam at the soil

		// erosion: settled fog is silky, fresh fog rolls in rounded puffs, thin mist breaks up into
		// drifting tendrils. Far away, where a step spans whole puffs, it fades to its mean.
		let bodyThick = mix( nb.b * 0.55 + nd.b * 0.45, mix( nb.g, nd.g, 0.35 ), 0.25 + 0.6 * billow );
		let body = mix( nb.b * 0.78 + nd.b * 0.22, bodyThick, smoothstep( 0.12, 0.6, D ) );
		let thr = mix( 0.62, 0.1, clamp( D * 0.95, 0.0, 1.0 ) );
		let m = mix( smoothstep( thr - 0.17, thr + 0.24, body ), 0.55, smoothstep( 0.5, 2.0, ds ) );
		// inside thick fog the erosion only modulates gently (it is opaque there)
		var dens = D * prof * mix( 0.15 + 0.95 * m, 0.72 + 0.38 * m, smoothstep( 0.35, 1.0, D ) );

		// sea smoke off the water: rising, streaky wisps
		let st = fogParams.steam * ( 1.0 - smoothstep( 0.0, 0.02, floorY ) ) * ( 1.0 - billow );
		if ( st > 0.02 ) {
			let ns = fogNoise( vec3f( p.x * 1.7, p.y * 0.55 - fogParams.drift0.w, p.z * 1.7 ) + nb.rgb * 0.25 );
			let wisp = smoothstep( 0.42, 0.8, ns.a ) * exp( - h * 2.4 / max( H, 0.15 ) );
			let sd = D * ( 0.35 + 1.4 * wisp ) * smoothstep( topN + 0.1, topN - soft * 1.5, p.y );
			dens = mix( dens, sd, st );
		}
		if ( dens <= 0.003 ) { continue; }
		if ( tFirst < 0.0 ) { tFirst = t; }

		// optical depth toward the light. Near tap: depth under the billowing top one step toward the
		// light (with a low sun the crests catch it and the troughs fall into their shade). Far taps:
		// through the bank; while the bank continues toward the light, the path out through the top
		// dominates (a thin, bright skin over a cool body); near a sun-facing edge light pours in
		// from the side instead.
		var lp = p + L * 0.22;
		var lf = fogAt( lp.xz * FG_U );
		let lTop = lf.y + ( ( fogNoise( lp * FG_NB - fogParams.drift0.xyz ).r - 0.5 ) * 1.1 + ( nd.r - 0.5 ) * 0.18 ) * amp;
		let lDepth = max( lTop - lp.y, 0.0 ) * lf.x * 1.5;
		var od = lf.x * 0.22 * smoothstep( lTop + 0.015, lTop - soft, lp.y );
		lp = p + L * 0.5;
		lf = fogAt( lp.xz * FG_U );
		var bank = lf.x * smoothstep( lf.y + 0.03, lf.y - 0.35 * max( lf.y - floorY, 0.1 ), lp.y );
		od += bank * 0.34;
		lp = p + L * 1.1;
		lf = fogAt( lp.xz * FG_U );
		bank = max( bank * 0.5, lf.x * smoothstep( lf.y + 0.03, lf.y - 0.35 * max( lf.y - floorY, 0.1 ), lp.y ) );
		od += bank * 0.6;
		let inBank = clamp( bank / max( D, 0.05 ), 0.0, 1.0 );
		od = ( od + inBank * lDepth * vertK ) * sigma;
		let depth = max( topN - p.y, 0.0 );

		// shadow maps, hills and clouds. Two taps on a rotating diameter across the light direction:
		// soft penumbrae, thin occluders fade to faint bands while crowns and ridges carve clear shafts
		let ang = jit * 6.2832 + f32( i ) * 2.39996;
		let so = ( sT1 * cos( ang ) + sT2 * sin( ang ) ) * 0.09;
		let sp = p + L * 0.03;
		let vis = hazeVisibilityRest( p * FG_U + vec3f( 0.0, frame.seaLevel, 0.0 ), 0.5 * ( fogSunAt( sp + so ) + fogSunAt( sp - so ) ) );
		// multiple-scattering octaves keep the deep body luminous instead of muddy grey, and partly
		// fill the shadow volumes (light diffusing in from the sides)
		let lum = vis * ( exp( - od ) * ph0 + 0.5 * exp( - od * 0.3 ) * ph1 ) + mix( vis, 1.0, 0.45 ) * 0.25 * exp( - od * 0.1 ) * ph2;

		let open = exp( - depth * D * 2.4 );                   // how much open sky this sample still sees
		let amb = mix( bounce, skyCol, 0.3 + 0.7 * hf ) * ( 0.4 + 0.6 * open );
		let Lin = sunCol * lum + amb;

		let Tr = exp( - dens * sigma * ds );
		col += T * albedo * Lin * ( 1.0 - Tr );
		T *= Tr;
	}

	let alpha = 1.0 - T;
	if ( alpha < 0.003 ) { return out; }
	// the air between the eye and the fog hazes it like anything else at that distance
	let dist = max( tFirst, tEntry ) * FG_U;
	let camH = max( cam.y - frame.seaLevel, 0.0 );
	let tau = ( hazeLayerDepth( HZ_MARINE_SIGMA, HZ_MARINE_H, camH, rd.y, dist ) + hazeLayerDepth( HZ_AEROSOL_SIGMA, HZ_AEROSOL_H, camH, rd.y, dist ) ) * hazeParams.density;
	let Th = exp( - tau );
	out.color = vec4f( col * Th + frame.horizonColor * alpha * ( 1.0 - Th ), alpha );
	out.dist = vec4f( min( dist, R.dist ), 0.0, 0.0, 1.0 );
	return out;
}
`,
		} );

		// accumulation: last frame's fog at the point where this pixel's ray meets the fog, clamped to
		// this frame's 3x3 neighbourhood, blended with the new march (the jittered steps are noisy)
		const temporal = [ 0, 1 ].map( ( src ) => new FullscreenPass( {
			label: 'fog temporal',
			modules: [ this.haze.module, this.paramsModule ],
			defines,
			bindings: {
				fogCur: { texture: () => this.low.textures[ 0 ] },
				fogDist: { texture: () => this.low.textures[ 1 ] },
				fogPrev: { texture: () => this.hist[ src ].texture },
			},
			colorFormats: [ 'rgba16float' ],
			code: /* wgsl */`
fn fragment( in: FSIn ) -> vec4f {
	let size = vec2i( textureDimensions( fogCur ) );
	let p = vec2i( in.pos.xy );
	let cur = textureLoad( fogCur, p, 0 );
	var out = cur;
	if ( fogParams.histValid > 0.5 ) {
		var lo = cur; var hi = cur;
		for ( var k = 0; k < 9; k++ ) {
			let s = textureLoad( fogCur, clamp( p + vec2i( k % 3 - 1, k / 3 - 1 ), vec2i( 0 ), size - 1 ), 0 );
			lo = min( lo, s ); hi = max( hi, s );
		}
		let dir = underwaterWorldDir( in.uv );
		let world = underwaterParams.camPos + dir * textureLoad( fogDist, p, 0 ).r;
		let clip = frame.prevViewProjNoJitter * vec4f( world, 1.0 );
		if ( clip.w > 1e-4 ) {
			let puv = clip.xy / clip.w * vec2f( 0.5, -0.5 ) + 0.5;
			if ( all( puv >= vec2f( 0.0 ) ) && all( puv <= vec2f( 1.0 ) ) ) {
				let prev = textureSampleLevel( fogPrev, smpLinearClamp, puv, 0.0 );
				out = mix( clamp( prev, lo, hi ), cur, 0.14 );
			}
		}
	}
	return out;
}
`,
		} ) );

		this._passes = { march, temporal };

	}

}
