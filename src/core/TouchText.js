// What the game says about its controls, reworded for a touch screen. The game's hints are written
// for a keyboard and a mouse ("Press E", a keycap in the prompt, "hold the left mouse button"); on a
// touch screen they name the on-screen buttons of core/TouchControls.js instead. One place, so the
// game's own text stays as it is.
import { wantsTouch } from './TouchControls.js';

// touch controls are on (or will be: this device's main pointer is a finger)
export function isTouch() {

	return globalThis.document?.documentElement.classList.contains( 'is-touch' ) || wantsTouch();

}

// a key the game names -> the button that does it
const KEYS = { E: 'Use', R: 'Rod', LMB: 'Cast', RMB: 'Reel in', Click: 'Tap', Space: 'Jump', I: 'Bag', V: 'View', C: 'Dive', S: 'Stick back', Shift: 'Stick to the rim', Esc: 'Close' };

export function touchKey( key ) {

	return isTouch() ? KEYS[ key ] ?? key : key;

}

const RULES = [
	// a second key tacked on after a dot ("Leave helm   ·   V  camera"): its button is on screen
	[ /\s+·\s+[A-Z]\s{1,3}[a-z][^·]*$/, '' ],
	[ /\s*·\s*right-click to reel the line in/, ' · Reel in brings the line back' ],
	[ /Rod out · hold left mouse to cast/, 'Rod out · hold Cast to wind up' ],
	[ /Hold the left mouse button to wind up/, 'Hold Cast to wind up' ],
	[ /Hold the left mouse button to reel/, 'Hold Cast to reel' ],
	[ /click the left mouse button that moment/, 'tap Cast that moment' ],
	[ /then click to strike/, 'then tap Cast to strike' ],
	[ /Press E at the wheel to drive \(W\/S throttle, A\/D steer\)/i, 'tap Use at the wheel to drive (the stick is the throttle and the wheel)' ],
	[ /\bPress E\b/g, 'Tap Use' ],
	[ /\bpress E\b/g, 'tap Use' ],
	[ /\bPress R to recover\b/, 'Tap Recover' ],
	[ /Move, mouse to look, <kbd>Shift<\/kbd> to run/, 'Move with the stick (to its rim to run), drag the view to look' ],
	[ /Press H to hide the panel, F1 for controls/, '' ],
];

export function touchText( text ) {

	if ( ! isTouch() || ! text ) return text;
	for ( const [ from, to ] of RULES ) text = text.replace( from, to );
	return text;

}
