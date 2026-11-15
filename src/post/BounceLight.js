import { FullscreenPass, RenderTarget, UniformBlock } from '../engine/webgpu.js';

// Screen-space bounce light (one diffuse bounce from what is on screen): a red hull tints the planks
// beside it, sunlit sand lights the shaded side of a post, the inside of a shop picks up the colour
// of its floor. The baked ground bounce (materials/GroundBounce.js) only knows the terrain; this
// knows every lit surface in view, moving ones included, within a few metres.
//
// Runs next to the ambient occlusion, at its resolution and on its depth copy, with the same
// slice structure (GTAO): a few directions through the pixel, marched both ways in view space.
// Along each half slice the horizon above the pixel's tangent plane only rises; a sample that
// raises it is visible from the pixel, and fills the wedge between the old horizon and the new
// one with its colour. With h = cos( angle to the normal ) of the horizon, the cosine-weighted
// share of that wedge in the slice is ( h_new^2 - h_old^2 ) / 2, so a slice whose two halves see a
// uniform colour L all the way up returns L: the result is the incoming light as "the average
// colour seen", ready to be multiplied by the surface's albedo. Samples fade out toward the
// radius (beyond it the environment lighting and the ground bounce take over).
//
// The pass is noisy by design (rotated per pixel and per frame like the AO): two depth-aware
// separable blurs follow, and the temporal resolve averages the rest.
//
//   const bounce = new BounceLight( { depth: () => aoDepthTexture, color: () => opaqueColorTexture, camera: gtao.uniforms } );
//   bounce.setSize( w, h ); bounce.render();   // after GTAO.render() (it updates the shared camera uniforms)
//   bounce.texture: rgba16float, rgb = incoming bounce light (average colour seen, 0 where nothing is near)

const DIRECTIONS = 4;
const STEPS = 6;

export class BounceLight {

	// depth: () => the AO depth copy (r16float colour, reversed-Z, negative where the water covers the opaque surface)
	// color: () => the lit opaque scene (HDR); camera: the GTAO pass's UniformBlock (proj, invProj, temporal terms)
	constructor( { depth, color, camera } ) {

		this.depth = depth;
		this.color = color;
		this.enabled = true;
		this.uniforms = new UniformBlock( 'BounceParams', {
			radius: [ 'f32', 4.0 ], // m: how far a surface can light another
			maxRadiance: [ 'f32', 6.0 ], // per-channel cap on a sample (a sun glint would otherwise sparkle through the blur)
		}, { label: 'bounce' } );
		this.radius = this.uniforms.fields.radius;
		this.target = new RenderTarget( 1, 1, { colors: [ 'rgba16float' ], label: 'bounce' } );
		this.blurX = new RenderTarget( 1, 1, { colors: [ 'rgba16float' ], label: 'bounceBlurX' } );
		this.blurY = new RenderTarget( 1, 1, { colors: [ 'rgba16float' ], label: 'bounceBlurY' } );

		const depthFns = /* wgsl */`
fn bounceDepthRaw( uv: vec2f ) -> f32 {
	let s = vec2i( textureDimensions( bounceDepth ) );
	return textureLoad( bounceDepth, clamp( vec2i( floor( uv * vec2f( s ) ) ), vec2i( 0 ), s - 1 ), 0 ).x;
}`;

		this._pass = new FullscreenPass( {
			label: 'bounce light',
			colorFormats: [ 'rgba16float' ],
			bindings: {
				gtao: { uniform: camera },
				bounce: { uniform: this.uniforms },
				bounceDepth: { texture: () => this.depth() },
				bounceColor: { texture: () => this.color() },
			},
			code: /* wgsl */`
const BOUNCE_DIRECTIONS: i32 = ${ DIRECTIONS };
const BOUNCE_STEPS: i32 = ${ STEPS };
${ depthFns }
fn bounceView( uv: vec2f, depth: f32 ) -> vec3f {
	let v = gtao.invProj * vec4f( uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, depth, 1.0 );
	return v.xyz / v.w;
}
fn bounceUv( viewPos: vec3f ) -> vec2f {
	let c = gtao.proj * vec4f( viewPos, 1.0 );
	let n = c.xy / max( c.w, 1e-4 );
	return vec2f( n.x * 0.5 + 0.5, 0.5 - n.y * 0.5 );
}

fn fragment( in: FSIn ) -> vec4f {
	let uv = in.uv;
	let raw = bounceDepthRaw( uv );
	// sky, or under the water (never shown there: see PostFX)
	if ( raw <= 0.0 ) { return vec4f( 0.0 ); }
	let texel = 1.0 / vec2f( textureDimensions( bounceDepth ) );
	let P = bounceView( uv, raw );
	// geometric normal: on each axis the neighbour closer in depth (never across an edge)
	let dl = abs( bounceDepthRaw( uv - vec2f( texel.x, 0.0 ) ) );
	let dr = abs( bounceDepthRaw( uv + vec2f( texel.x, 0.0 ) ) );
	let du = abs( bounceDepthRaw( uv - vec2f( 0.0, texel.y ) ) );
	let dd = abs( bounceDepthRaw( uv + vec2f( 0.0, texel.y ) ) );
	let Pl = bounceView( uv - vec2f( texel.x, 0.0 ), dl );
	let Pr = bounceView( uv + vec2f( texel.x, 0.0 ), dr );
	let Pu = bounceView( uv - vec2f( 0.0, texel.y ), du );
	let Pd = bounceView( uv + vec2f( 0.0, texel.y ), dd );
	let dx = select( Pr - P, P - Pl, abs( dl - raw ) < abs( dr - raw ) );
	let dy = select( Pd - P, P - Pu, abs( du - raw ) < abs( dd - raw ) );
	var N = normalize( cross( dy, dx ) );
	if ( dot( N, P ) > 0.0 ) { N = - N; }

	// rotation of the slices and phase of the steps: per pixel, changing every frame (the AO's sequences)
	let rot = interleavedGradientNoise( in.pos.xy + gtao.temporalOffset ) + gtao.temporalDirection;
	let jitter = interleavedGradientNoise( in.pos.yx * 1.37 + gtao.temporalOffset * 7.0 + 11.0 );
	let radius = bounce.radius;

	var sum = vec3f( 0.0 );
	for ( var i = 0; i < BOUNCE_DIRECTIONS; i++ ) {
		let angle = ( f32( i ) + rot ) / f32( BOUNCE_DIRECTIONS ) * PI;
		// (in the view plane: the slice plane contains the view axis, as in GTAO)
		let dir = vec3f( cos( angle ), sin( angle ), 0.0 );
		for ( var side = 0; side < 2; side++ ) {
			let sgn = select( -1.0, 1.0, side == 0 );
			// h: cosine to the normal of the horizon found so far on this half slice (0: the tangent plane)
			var h = 0.0;
			for ( var j = 0; j < BOUNCE_STEPS; j++ ) {
				// quadratic distribution: more samples close by, where the bounce is strongest
				let t = ( f32( j ) + 0.35 + jitter * 0.65 ) / f32( BOUNCE_STEPS );
				let suv = bounceUv( P + dir * ( sgn * t * t * radius ) );
				if ( suv.x < 0.0 || suv.x > 1.0 || suv.y < 0.0 || suv.y > 1.0 ) { break; }
				let sd = abs( bounceDepthRaw( suv ) );
				if ( sd <= 0.0 ) { continue; }
				let delta = bounceView( suv, sd ) - P;
				let len = length( delta );
				if ( len < 1e-3 ) { continue; }
				let c = dot( N, delta ) / len;
				if ( c <= h ) { continue; }
				// visible above the old horizon: its colour fills the wedge up to the new one
				let fall = 1.0 - pow2( min( len / radius, 1.0 ) );
				let L = min( textureSampleLevel( bounceColor, smpLinearClamp, suv, 0.0 ).rgb, vec3f( bounce.maxRadiance ) );
				sum += L * ( ( c * c - h * h ) * 0.5 * fall );
				h = c;
			}
		}
	}
	return vec4f( sum / f32( BOUNCE_DIRECTIONS ), 1.0 );
}`,
		} );

		// depth-aware separable blur (the AO's: 5 + 5 taps, weights by the relative depth difference)
		const blur = ( src, dx, dy ) => {

			let taps = '';
			for ( let k = - 2; k <= 2; k ++ ) taps += /* wgsl */`
	{
		let uvK = in.uv + vec2f( ${ dx * k }.0, ${ dy * k }.0 ) / size;
		let rel = abs( abs( bounceDepthRaw( uvK ) ) - dC ) / max( dC, 1e-7 );
		let w = 1.0 / pow2( rel * 40.0 + 1.0 );
		sum += textureSampleLevel( bounceSrc, smpLinearClamp, uvK, 0.0 ).rgb * w;
		wSum += w;
	}`;
			return new FullscreenPass( {
				label: 'bounce blur ' + ( dx ? 'x' : 'y' ),
				colorFormats: [ 'rgba16float' ],
				bindings: { bounceSrc: { texture: src }, bounceDepth: { texture: () => this.depth() } },
				code: /* wgsl */`
${ depthFns }
fn fragment( in: FSIn ) -> vec4f {
	let size = vec2f( textureDimensions( bounceSrc ) );
	let dC = abs( bounceDepthRaw( in.uv ) );
	var sum = vec3f( 0.0 ); var wSum = 0.0;
${ taps }
	return vec4f( sum / wSum, 1.0 );
}`,
			} );

		};
		this._blurXPass = blur( this.target.texture, 1, 0 );
		this._blurYPass = blur( this.blurX.texture, 0, 1 );

	}

	// the blurred result (rgb: the average colour seen around the pixel)
	get texture() {

		return this.blurY.texture;

	}

	// the AO's resolution (one texel per texel of the depth copy)
	setSize( width, height ) {

		this.target.setSize( width, height );
		this.blurX.setSize( width, height );
		this.blurY.setSize( width, height );

	}

	render() {

		const CLR = [ 0, 0, 0, 0 ];
		if ( ! this.enabled ) return; // (the composite skips it: PostFX sets its strength to 0)
		this._pass.render( { colorViews: [ this.target.texture ], clear: CLR } );
		this._blurXPass.render( { colorViews: [ this.blurX.texture ], clear: CLR } );
		this._blurYPass.render( { colorViews: [ this.blurY.texture ], clear: CLR } );

	}

}
