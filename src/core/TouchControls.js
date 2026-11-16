// Touch controls (phones and tablets): a stick under the left thumb, look by dragging anywhere
// else, and buttons under the right thumb. The game reads the keyboard and mouse through
// core/Input.js and a few raw key listeners (ui/UI.js, rally/DriveHUD.js), so the controls speak
// that language: the stick and the buttons send real key events, the look drag adds to
// Input.look, a pinch turns the wheel, and the cast and reel buttons are the mouse buttons.
// Nothing else in the game knows about touch.
//
// On when the device's main pointer is a finger, or with ?touch (off with ?touch=0). A device with
// both a mouse and a touch screen gets them at the first touch on the view.
import { t } from '../i18n/index.js';

const STICK_R = 56; // stick travel (CSS px)
const DEAD = 0.28; // of the travel: no direction inside it
const RUN = 0.92; // pushed to the rim: sprint (the boat's full throttle)
const LOOK = 1.7; // mouse counts per CSS px of drag
const PINCH = 22; // CSS px of pinch per wheel notch
const KEY_NAMES = { Space: ' ', Escape: 'Escape', Enter: 'Enter', Tab: 'Tab', F1: 'F1', Backquote: '`' };

// What the buttons are, by what the player is doing. `main` are the large ones under the thumb
// (first is nearest the corner), `more` the drawer. key: a KeyboardEvent code, or 'lmb' / 'rmb'.
const B = ( key, label, hint = '' ) => ( { key, label, hint } );
const COMMON = [ B( 'KeyL', 'Torch' ), B( 'KeyT', 'Time' ), B( 'KeyM', 'Sound' ), B( 'KeyH', 'HUD' ), B( 'KeyP', 'Panel' ), B( 'F1', 'Help' ), B( 'Escape', 'Close' ) ];
const SETS = {
	foot: { main: [ B( 'Space', 'Jump' ), B( 'KeyE', 'Use', 'E' ), B( 'KeyR', 'Rod', 'R' ) ],
		more: [ B( 'KeyI', 'Bag' ), B( 'KeyV', 'View' ), B( 'KeyB', 'Whistle' ), B( 'Backquote', 'Car' ), ...COMMON ] },
	swim: { main: [ B( 'Space', 'Up' ), B( 'KeyC', 'Dive' ), B( 'KeyE', 'Use', 'E' ) ],
		more: [ B( 'KeyI', 'Bag' ), B( 'KeyV', 'View' ), ...COMMON ] },
	fish: { main: [ B( 'lmb', 'Cast' ), B( 'rmb', 'Reel in' ), B( 'KeyE', 'Use', 'E' ), B( 'KeyR', 'Rod', 'R' ) ],
		more: [ B( 'Space', 'Jump' ), B( 'KeyI', 'Bag' ), B( 'KeyV', 'View' ), ...COMMON ] },
	boat: { main: [ B( 'KeyE', 'Leave', 'E' ), B( 'KeyR', 'Rod', 'R' ), B( 'KeyV', 'View' ) ],
		more: [ B( 'KeyI', 'Bag' ), ...COMMON ] },
	car: { main: [ B( 'Space', 'Brake' ), B( 'KeyE', 'Leave', 'E' ), B( 'KeyR', 'Recover', 'R' ) ],
		more: [ B( 'KeyT', 'Repair' ), B( 'KeyY', 'Bail out' ), B( 'KeyK', 'Keys' ), B( 'KeyM', 'Sound' ), B( 'F1', 'Help' ), B( 'Escape', 'Close' ) ] },
	ski: { main: [ B( 'Space', 'Hop' ), B( 'KeyX', 'Boost' ), B( 'KeyE', 'Leave', 'E' ) ],
		more: [ B( 'ShiftLeft', 'Tuck' ), B( 'KeyC', 'Camera' ), B( 'KeyG', 'Mate' ), ...COMMON ] },
	helm: { main: [ B( 'KeyE', 'Leave', 'E' ), B( 'KeyL', 'Lines' ), B( 'KeyH', 'Horn' ) ],
		more: [ B( 'KeyR', 'Ramp' ), B( 'KeyX', 'Engine stop' ), B( 'KeyC', 'Wheel centre' ), B( 'KeyV', 'View' ), B( 'F1', 'Help' ), B( 'Escape', 'Close' ) ] },
	fly: { main: [ B( 'Space', 'Up' ), B( 'KeyC', 'Down' ), B( 'KeyF', 'Walk' ) ], more: [ B( 'ShiftLeft', 'Fast' ), ...COMMON ] },
};

// the finger keeps its element when it slides off it (a pointer that is already gone throws)
function capture( el, id ) {

	try { el.setPointerCapture?.( id ); } catch ( e ) { /* gone */ }

}

export function wantsTouch( search = globalThis.location?.search || '' ) {

	const m = /[?&]touch(?:=([^&]*))?/.exec( search );
	if ( m ) return m[ 1 ] !== '0';
	return !! globalThis.matchMedia?.( '(pointer: coarse)' ).matches;

}

export class TouchControls {

	// input: core/Input.js; dom: the view (canvas); state: () => one of the SETS keys
	constructor( { input, dom, state = () => 'foot', root = document.body } ) {

		this.input = input;
		this.dom = dom;
		this.state = state;
		this.root = root;
		this.on = false;
		this.held = new Set(); // key codes held by the stick
		this.stick = null; // { id, x0, y0 }
		this.looks = new Map(); // pointer id -> { x, y }
		this.pinch = 0;
		this.set = '';
		this.open = false;

		if ( wantsTouch() ) this.enable();
		else if ( ! /[?&]touch=0/.test( location.search ) ) {

			const first = ( e ) => {

				if ( e.pointerType !== 'touch' ) return;
				dom.removeEventListener( 'pointerdown', first, true );
				this.enable();

			};
			dom.addEventListener( 'pointerdown', first, true );

		}

	}

	enable() {

		if ( this.on ) return;
		this.on = true;
		document.documentElement.classList.add( 'is-touch' );
		const el = this.el = document.createElement( 'div' );
		el.className = 'tw-touch';
		el.innerHTML = '<div class="tw-touch-stick" hidden><i></i></div><div class="tw-touch-main"></div><div class="tw-touch-more" hidden></div>'
			+ '<div class="tw-touch-tools"><button type="button" data-tool="more" aria-label="More">⋯</button><button type="button" data-tool="full" aria-label="Full screen">⛶</button></div>';
		this.root.appendChild( el );
		this.stickEl = el.querySelector( '.tw-touch-stick' );
		this.mainEl = el.querySelector( '.tw-touch-main' );
		this.moreEl = el.querySelector( '.tw-touch-more' );

		const dom = this.dom;
		// no mouse events made up from touches (they would hold the game's left button down), no
		// long-press menu, no page zoom
		dom.addEventListener( 'touchstart', ( e ) => e.preventDefault(), { passive: false } );
		el.addEventListener( 'touchstart', ( e ) => e.preventDefault(), { passive: false } );
		el.addEventListener( 'contextmenu', ( e ) => e.preventDefault() );
		dom.addEventListener( 'pointerdown', ( e ) => this.viewDown( e ) );
		dom.addEventListener( 'pointermove', ( e ) => this.viewMove( e ) );
		for ( const type of [ 'pointerup', 'pointercancel' ] ) dom.addEventListener( type, ( e ) => this.viewUp( e ) );
		el.addEventListener( 'pointerdown', ( e ) => this.buttonDown( e ) );
		for ( const type of [ 'pointerup', 'pointercancel' ] ) el.addEventListener( type, ( e ) => this.buttonUp( e ) );
		// leaving the page mid-press must not leave a key down
		window.addEventListener( 'blur', () => this.releaseAll() );
		document.addEventListener( 'visibilitychange', () => document.hidden && this.releaseAll() );
		this.sync();
		this.timer = setInterval( () => this.sync(), 200 );

	}

	// ---- keys

	key( code, down ) {

		if ( code === 'lmb' ) { this.input.mouseDown = down; return; }
		if ( code === 'rmb' ) { this.input.rightDown = down; return; }
		const key = KEY_NAMES[ code ] ?? ( code.startsWith( 'Key' ) ? code.slice( 3 ).toLowerCase() : code.startsWith( 'Shift' ) ? 'Shift' : code );
		( document.body || window ).dispatchEvent( new KeyboardEvent( down ? 'keydown' : 'keyup', { code, key, bubbles: true, cancelable: true } ) );

	}

	releaseAll() {

		for ( const code of this.held ) this.key( code, false );
		this.held.clear();
		if ( this.el ) for ( const b of this.el.querySelectorAll( '.is-down' ) ) this.release( b );
		this.stick = null;
		if ( this.stickEl ) this.stickEl.hidden = true;
		this.looks.clear();

	}

	// ---- the view: stick on the left, look and pinch elsewhere

	viewDown( e ) {

		if ( e.pointerType === 'mouse' ) return;
		capture( this.dom, e.pointerId );
		const w = window.innerWidth;
		if ( ! this.stick && e.clientX < w * 0.42 ) {

			this.stick = { id: e.pointerId, x0: e.clientX, y0: e.clientY };
			this.stickEl.hidden = false;
			this.stickEl.style.transform = `translate(${ e.clientX }px, ${ e.clientY }px)`;
			this.stickEl.firstChild.style.transform = '';
			return;

		}

		this.looks.set( e.pointerId, { x: e.clientX, y: e.clientY } );
		this.pinch = 0;

	}

	viewMove( e ) {

		const s = this.stick;
		if ( s && e.pointerId === s.id ) {

			let x = ( e.clientX - s.x0 ) / STICK_R, y = ( e.clientY - s.y0 ) / STICK_R;
			const len = Math.hypot( x, y );
			if ( len > 1 ) { x /= len; y /= len; }
			this.stickEl.firstChild.style.transform = `translate(${ x * STICK_R }px, ${ y * STICK_R }px)`;
			this.steer( x, y, Math.min( len, 1 ) );
			return;

		}

		const p = this.looks.get( e.pointerId );
		if ( ! p ) return;
		if ( this.looks.size >= 2 ) {

			// two fingers on the view: their spread is the wheel (camera distance)
			const before = this.spread();
			p.x = e.clientX; p.y = e.clientY;
			this.pinch += before - this.spread();
			const notches = Math.trunc( this.pinch / PINCH );
			if ( notches ) { this.input.wheel += notches; this.pinch -= notches * PINCH; }
			return;

		}

		this.input.look.x += ( e.clientX - p.x ) * LOOK;
		this.input.look.y += ( e.clientY - p.y ) * LOOK;
		p.x = e.clientX; p.y = e.clientY;

	}

	viewUp( e ) {

		if ( this.stick && e.pointerId === this.stick.id ) {

			this.stick = null;
			this.stickEl.hidden = true;
			this.steer( 0, 0, 0 );

		}

		this.looks.delete( e.pointerId );

	}

	spread() {

		const [ a, b ] = [ ...this.looks.values() ];
		return Math.hypot( a.x - b.x, a.y - b.y );

	}

	// stick position (x right, y down, length 0..1) -> the keys it holds
	steer( x, y, len ) {

		const want = new Set();
		if ( len > DEAD ) {

			// eight directions: an axis counts when it is more than a third of the push
			if ( y < - 0.38 * len ) want.add( 'KeyW' );
			if ( y > 0.38 * len ) want.add( 'KeyS' );
			if ( x < - 0.38 * len ) want.add( 'KeyA' );
			if ( x > 0.38 * len ) want.add( 'KeyD' );
			if ( len > RUN ) want.add( 'ShiftLeft' );

		}

		for ( const code of this.held ) if ( ! want.has( code ) ) { this.held.delete( code ); this.key( code, false ); }
		for ( const code of want ) if ( ! this.held.has( code ) ) { this.held.add( code ); this.key( code, true ); }

	}

	// ---- buttons

	buttonDown( e ) {

		const b = e.target.closest?.( 'button' );
		if ( ! b ) return;
		e.preventDefault();
		if ( b.dataset.tool === 'more' ) { this.open = ! this.open; this.moreEl.hidden = ! this.open; b.classList.toggle( 'is-on', this.open ); return; }
		if ( b.dataset.tool === 'full' ) { this.fullscreen(); return; }
		capture( b, e.pointerId );
		b.classList.add( 'is-down' );
		this.key( b.dataset.key, true );

	}

	buttonUp( e ) {

		const b = e.target.closest?.( 'button.is-down' );
		if ( b ) this.release( b );

	}

	release( b ) {

		b.classList.remove( 'is-down' );
		if ( b.dataset.key ) this.key( b.dataset.key, false );

	}

	// Full screen, on its side: a phone's browser bars take a third of a landscape view.
	fullscreen( on = ! document.fullscreenElement ) {

		try {

			if ( on ) document.documentElement.requestFullscreen?.( { navigationUI: 'hide' } )?.then( () => screen.orientation?.lock?.( 'landscape' )?.catch( () => {} ) ).catch( () => {} );
			else document.exitFullscreen?.();

		} catch ( e ) { /* not allowed here: play in the page */ }

	}

	// the buttons follow what the player is doing
	sync() {

		let name = 'foot';
		try { name = this.state() || 'foot'; } catch ( e ) { /* the game is still loading */ }
		if ( ! SETS[ name ] ) name = 'foot';
		if ( name === this.set ) return;
		for ( const b of this.el.querySelectorAll( '.tw-touch-main .is-down, .tw-touch-more .is-down' ) ) this.release( b );
		this.set = name;
		const html = ( list ) => list.map( ( b ) => `<button type="button" data-key="${ b.key }"><b>${ t( b.label ) }</b>${ b.hint ? `<kbd>${ b.hint }</kbd>` : '' }</button>` ).join( '' );
		this.mainEl.innerHTML = html( SETS[ name ].main );
		this.moreEl.innerHTML = html( SETS[ name ].more );
		this.el.dataset.set = name;

	}

}
