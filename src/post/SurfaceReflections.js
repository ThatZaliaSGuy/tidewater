import { FullscreenPass, UniformBlock, ShaderModule, commonModule, SceneLighting } from '../engine/webgpu.js';

// Screen-space reflections on the glossy surfaces of the opaque layer: the film of water on wet
// sand, wet planks and decks, glass, car paint. (The sea has its own, in WaterMaterial.)
//
// Lit materials already reflect the environment probe (the sky). What the probe can't hold is the
// scene itself: the pier's piles standing in the wet sand, a hull, a person, the hills. This pass
// runs once after the opaque layer (SceneRenderer.onBeforeWater), on the copies the water also
// reads: for every pixel a material flagged as glossy (the scene mask's r channel, written by
// MeshShader from the surface's roughness and clearcoat) it marches the mirrored view ray through
// the opaque depth, and where the ray meets the scene it replaces the sky the material reflected
// there by the scene's colour:  + F * gloss * hit * ( scene - sky ).  Additive into the scene
// colour, so no extra target; the difference can be negative (a dark pile in a bright wet beach),
// limited so the pixel never goes below a tenth of what it was.
//
// The normal is rebuilt from the depth (the geometric surface: fine ripples of the shading normal
// are not in it), and the roughness is estimated back from the gloss; rougher surfaces fetch a
// wider footprint of the scene around the hit. The march is the water's (geometric steps in view
// space, a short bisection, fades at the screen edges, for rays coming back to the camera and at
// the end of the range), deterministic: nothing for the temporal resolve to clean up.
//
//   const refl = new SurfaceReflections( { sceneRenderer } );
//   sceneRenderer.onBeforeWater = () => { refl.render(); ... };
//   refl.enabled, refl.strength.value (0..1)

const FALLBACK_ENV = new ShaderModule( {
	name: 'surfaceReflEnvStub',
	deps: [ commonModule ],
	code: 'fn hookEnvSpecular( R: vec3f, roughness: f32 ) -> vec3f { let t = sat( R.y * 0.5 + 0.5 ); return mix( frame.horizonColor * 0.6, frame.skyIrradiance * PI, t ) * frame.envIntensity; }',
} );

export class SurfaceReflections {

	constructor( { sceneRenderer } ) {

		this.sceneRenderer = sceneRenderer;
		this.enabled = true;
		this.uniforms = new UniformBlock( 'SurfaceReflParams', {
			strength: [ 'f32', 1 ],
			range: [ 'f32', 90 ], // m: how far a reflected ray is followed
			debug: [ 'f32', 0 ], // 1: the reconstructed world normal, 2: gloss (r), Fresnel (g), hit weight (b)
		}, { label: 'surfaceRefl' } );
		this.debug = this.uniforms.fields.debug;
		this.strength = this.uniforms.fields.strength;
		this.range = this.uniforms.fields.range;
		this._pass = null;
		this._lightingVersion = - 1;

	}

	_build() {

		const sr = this.sceneRenderer;
		// the probe the lit materials reflected (installed by sky/Environment.js), or the procedural stub
		const env = SceneLighting.hooks.envSpecular || FALLBACK_ENV;
		this._lightingVersion = SceneLighting.version;
		this._pass = new FullscreenPass( {
			label: 'surface reflections',
			colorFormats: [ sr.sceneRT.formats[ 0 ] ],
			blend: 'add',
			modules: [ env ],
			bindings: {
				surfRefl: { uniform: this.uniforms },
				surfReflColor: { texture: () => sr.opaqueCopy.texture },
				surfReflDepth: { texture: () => sr.opaqueCopy.depthTexture, sampleType: 'unfilterable-float' },
				surfReflDepthHalf: { texture: () => sr.opaqueDepthHalf.texture },
				surfReflMask: { texture: () => sr.waterMaskTexture },
			},
			code: /* wgsl */`
// reflectance of a dielectric at normal incidence (water film 0.02, varnish / glass / paint 0.04)
const SURF_REFL_F0: f32 = 0.04;

// exact reversed-Z depth of the opaque layer at a pixel
fn surfReflDepthAt( p: vec2i ) -> f32 {
	let size = vec2i( textureDimensions( surfReflDepth ) );
	return textureLoad( surfReflDepth, clamp( p, vec2i( 0 ), size - 1 ), 0 ).x;
}
fn surfReflViewAt( p: vec2i, size: vec2f ) -> vec3f {
	return viewFromDepth( ( vec2f( p ) + 0.5 ) / size, surfReflDepthAt( p ) );
}
// linear view Z of the opaque scene for the march (the half float copy: the thickness tests allow centimetres)
fn surfReflSceneZ( uv: vec2f ) -> f32 {
	let size = vec2f( textureDimensions( surfReflDepthHalf ) );
	return - viewDepth( textureLoad( surfReflDepthHalf, vec2i( clamp( uv, vec2f( 0.0 ), vec2f( 0.9999 ) ) * size ), 0 ).x );
}
fn surfReflProject( p: vec3f ) -> vec2f {
	let clip = frame.proj * vec4f( p, 1.0 );
	let ndc = clip.xy / max( clip.w, 1e-4 );
	return vec2f( ndc.x * 0.5 + 0.5, ndc.y * -0.5 + 0.5 );
}

fn fragment( in: FSIn ) -> vec4f {
	let px = vec2i( in.pos.xy );
	let m = textureLoad( surfReflMask, px, 0 );
	// (g: a water surface. None is drawn yet when this pass runs; kept for a pass order change)
	let gloss = m.r * ( 1.0 - step( 0.5, m.g ) );
	let d = surfReflDepthAt( px );
	if ( gloss < 0.02 || d <= 0.0 || surfRefl.strength <= 0.0 ) { return vec4f( 0.0 ); }

	let size = vec2f( textureDimensions( surfReflDepth ) );
	let P = surfReflViewAt( px, size );
	// geometric normal from the depth: on each axis the neighbour closer in depth (never across an edge)
	let Pl = surfReflViewAt( px - vec2i( 1, 0 ), size );
	let Pr = surfReflViewAt( px + vec2i( 1, 0 ), size );
	let Pu = surfReflViewAt( px - vec2i( 0, 1 ), size );
	let Pd = surfReflViewAt( px + vec2i( 0, 1 ), size );
	let dx = select( Pr - P, P - Pl, abs( Pl.z - P.z ) < abs( Pr.z - P.z ) );
	let dy = select( Pd - P, P - Pu, abs( Pu.z - P.z ) < abs( Pd.z - P.z ) );
	var N = normalize( cross( dy, dx ) );
	let V = normalize( - P );
	if ( dot( N, V ) < 0.0 ) { N = - N; }
	let NdV = max( dot( N, V ), 1e-3 );
	let R = reflect( - V, N );
	let F = SURF_REFL_F0 + ( 1.0 - SURF_REFL_F0 ) * pow( 1.0 - NdV, 5.0 );
	// (debug views replace the pixel: the pass is additive, so they output the difference to it)
	let own = textureLoad( surfReflColor, px, 0 ).rgb;
	if ( surfRefl.debug == 1.0 ) { return vec4f( ( frame.invView * vec4f( N, 0.0 ) ).xyz * 0.5 + 0.5 - own, 0.0 ); }
	// looking straight down a dielectric reflects 4 %: nothing to see, skip the march
	if ( F * gloss < 0.012 && surfRefl.debug == 0.0 ) { return vec4f( 0.0 ); }

	// ---- march (view space; steps grow with the distance: far away the first ones would all land in one pixel)
	let stepScale = max( - P.z / 60.0, 1.0 );
	let origin = P + N * ( 0.02 * stepScale );
	var t = 0.1 * stepScale;
	var dt = 0.18 * stepScale;
	var prevT = 0.0;
	var hit = false;
	// (steps grow slowly: a step longer than a post or a pile is thick jumps over it, and the missed
	// hits show as bright bands of sky across its reflection)
	for ( var i = 0; i < 22; i++ ) {
		prevT = t;
		if ( prevT >= surfRefl.range ) { break; }
		t += dt;
		dt *= 1.3;
		let p = origin + R * t;
		let uv = surfReflProject( p );
		if ( uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0 || p.z > -0.1 ) { break; }
		let sz = surfReflSceneZ( uv );
		// behind the visible surface, within a thickness covering the last step
		if ( p.z < sz && sz - p.z < max( dt * 1.6, max( t * 0.08, 0.25 ) ) ) { hit = true; break; }
	}
	if ( ! hit ) { return select( vec4f( 0.0 ), vec4f( vec3f( gloss, F, 0.0 ) - own, 0.0 ), surfRefl.debug == 2.0 ); }

	// refine between the last miss and the hit
	var a = prevT;
	var b = t;
	for ( var k = 0; k < 7; k++ ) {
		let mid = ( a + b ) * 0.5;
		let p = origin + R * mid;
		let behind = p.z < surfReflSceneZ( surfReflProject( p ) );
		b = select( b, mid, behind );
		a = select( mid, a, behind );
	}
	let hitV = origin + R * b;
	let uv = surfReflProject( hitV );
	// after refining the ray must really touch the surface there (a ray that only passed far behind
	// a thin or distant object is a false hit)
	let gap = abs( surfReflSceneZ( uv ) - hitV.z );
	let touch = 1.0 - smoothstep( max( b * 0.02, 0.15 ), max( b * 0.04, 0.3 ), gap );
	let edge = smoothstep( 0.0, 0.06, uv.x ) * ( 1.0 - smoothstep( 0.94, 1.0, uv.x ) ) * smoothstep( 0.0, 0.06, uv.y ) * ( 1.0 - smoothstep( 0.94, 1.0, uv.y ) );
	let facing = 1.0 - smoothstep( 0.1, 0.5, R.z ); // rays toward the camera leave the screen
	let weight = edge * facing * touch * ( 1.0 - smoothstep( surfRefl.range * 0.5, surfRefl.range, b ) );
	if ( surfRefl.debug == 2.0 ) { return vec4f( vec3f( gloss, F, weight ) - own, 0.0 ); }
	if ( weight <= 0.0 ) { return vec4f( 0.0 ); }

	// ---- what the ray sees there. Roughness back from the gloss (MeshShader: 0.45 -> 0, 0.12 -> 1);
	// a rough film sees a cone around the mirror direction: a wider footprint around the hit, growing
	// with the distance the ray travelled (five taps: the opaque copy has no mips)
	let rough = mix( 0.45, 0.12, gloss );
	let spread = min( rough * 0.6 * b / max( - hitV.z, 0.5 ) * frame.proj[ 1 ][ 1 ] * 0.5, 0.02 );
	let sx = vec2f( spread * size.y / size.x, 0.0 );
	let sy = vec2f( 0.0, spread );
	var scene = textureSampleLevel( surfReflColor, smpLinearClamp, uv, 0.0 ).rgb * 0.4;
	scene += textureSampleLevel( surfReflColor, smpLinearClamp, uv + sx, 0.0 ).rgb * 0.15;
	scene += textureSampleLevel( surfReflColor, smpLinearClamp, uv - sx, 0.0 ).rgb * 0.15;
	scene += textureSampleLevel( surfReflColor, smpLinearClamp, uv + sy, 0.0 ).rgb * 0.15;
	scene += textureSampleLevel( surfReflColor, smpLinearClamp, uv - sy, 0.0 ).rgb * 0.15;

	// the sky the material reflected in that direction (the same probe lookup)
	let Rw = ( frame.invView * vec4f( R, 0.0 ) ).xyz;
	let sky = hookEnvSpecular( Rw, rough );

	var delta = ( scene - sky ) * ( F * gloss * weight * surfRefl.strength );
	// never below a tenth of the pixel (the material's sky reflection was scaled by terms this pass
	// doesn't know: specular occlusion, the surface's own specular intensity)
	delta = max( delta, own * -0.9 );
	return vec4f( delta, 0.0 );
}`,
		} );

	}

	// after the opaque layer and its copies (SceneRenderer.onBeforeWater), before the water
	render() {

		if ( ! this.enabled || this.strength.value <= 0 ) return;
		if ( ! this._pass || this._lightingVersion !== SceneLighting.version ) this._build();
		this._pass.render( { colorViews: [ this.sceneRenderer.sceneRT.texture ] } );

	}

}
