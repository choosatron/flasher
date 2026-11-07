// The page's words in the reader's language.
//
// The same conventions as the Choosatron's own web page (choosatron-esp32,
// data/source/www/js/i18n.js), so one translation tool serves both:
//
//   data-i18n="key"         the element's text is the English; a pack replaces it
//   data-i18n-parts="key"   a sentence interrupted by markup: its child elements
//                           become $1$, $2$... and go back wherever the
//                           translation puts them. No markup from a pack is ever
//                           parsed.
//   t(key, english, values) in code; $NAME$ is substituted from values
//
// The English lives at the call site, so the page is right before any pack
// loads and a missing key falls back on its own. tools/extract_strings.py
// writes locales/en.json from these marks.

// The languages the Choosatron ships, with their own names for themselves.
export const LANGUAGES = [
   [ 'en', 'English' ], [ 'de', 'Deutsch' ], [ 'es', 'Español' ], [ 'fr', 'Français' ],
   [ 'it', 'Italiano' ], [ 'ja', '日本語' ], [ 'ko', '한국어' ], [ 'nl', 'Nederlands' ],
   [ 'pl', 'Polski' ], [ 'pt', 'Português' ], [ 'ru', 'Русский' ], [ 'sv', 'Svenska' ],
   [ 'tr', 'Türkçe' ], [ 'zh-Hans', '简体中文' ], [ 'zh-Hant', '繁體中文' ],
];

let pack = {};
let tag = 'en';

function substitute( message, values ) {
   if (!values) return message;
   return message.replace( /\$([A-Z0-9_]+)\$/g, ( whole, name ) => {
      const key = Object.keys( values ).find( ( k ) => k.toUpperCase() === name );
      const v = key === undefined ? undefined : values[key];
      return v === undefined || v === null ? whole : String( v );
   } );
}

export function t( key, english, values ) {
   const entry = pack[key];
   return substitute( entry && entry.message ? entry.message : english, values );
}

export function current() { return tag; }

// Languages match on primary subtag and script, region ignored; Chinese is
// told apart by script (zh-TW, zh-HK and zh-Hant are Traditional).
export function match( wanted ) {
   const have = LANGUAGES.map( ( l ) => l[0] );
   for (const raw of wanted) {
      const lower = String( raw || '' ).toLowerCase();
      const primary = lower.split( '-' )[0];
      if (primary === 'zh') {
         return /hant|-tw|-hk|-mo/.test( lower ) ? 'zh-Hant' : 'zh-Hans';
      }
      if (have.includes( primary )) return primary;
   }
   return 'en';
}

const originals = new WeakMap();

function parts( el, key ) {
   let saved = originals.get( el );
   if (!saved) {
      const kids = [];
      let english = '';
      for (const node of el.childNodes) {
         if (node.nodeType === 1) { kids.push( node ); english += '$' + kids.length + '$'; }
         else if (node.nodeType === 3) english += node.nodeValue;
      }
      saved = { kids, english: english.replace( /\s+/g, ' ' ).trim() };
      originals.set( el, saved );
   }
   const pieces = t( key, saved.english ).split( /\$(\d+)\$/ );
   el.replaceChildren();
   pieces.forEach( ( piece, i ) => {
      if (i % 2 === 1) {
         const kid = saved.kids[Number( piece ) - 1];
         if (kid) el.appendChild( kid );
      } else if (piece) {
         el.appendChild( document.createTextNode( piece ) );
      }
   } );
}

export function apply( root = document ) {
   for (const el of root.querySelectorAll( '[data-i18n]' )) {
      if (!originals.has( el )) originals.set( el, el.textContent.replace( /\s+/g, ' ' ).trim() );
      el.textContent = t( el.getAttribute( 'data-i18n' ), originals.get( el ) );
   }
   for (const el of root.querySelectorAll( '[data-i18n-parts]' )) {
      parts( el, el.getAttribute( 'data-i18n-parts' ) );
   }
   document.documentElement.lang = tag;
}

// Loads a pack and re-renders the marked markup. English needs no pack.
export async function use( wanted ) {
   let next = {};
   if (wanted !== 'en') {
      try {
         const res = await fetch( `locales/${wanted}.json` );
         if (res.ok) next = await res.json();
         else wanted = 'en';
      } catch (e) {
         wanted = 'en';
      }
   }
   pack = next;
   tag = wanted;
   apply();
   return tag;
}
