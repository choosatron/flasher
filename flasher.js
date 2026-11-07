// Choosatron flasher: install a recovery image over USB with Web Serial.
//
// The firmware comes from the artifact site next door (choosatron.github.io/
// firmware/, written by the release workflow in choosatron-esp32), on the same
// origin, so there is no CORS to arrange and no binary is duplicated here.
//
// Every release publishes one recovery image per board, choosatron-factory.bin:
// bootloader, partition table, otadata and app merged from 0x0. The three modes
// write different parts of that one file:
//
//   reinstall   0x0-0x9000 and 0xE000-end: everything but NVS. Settings and
//               stories stay. (What `idf.py flash` writes.)
//   settings    the whole image from 0x0. Its padding blanks NVS, so settings
//               go back to new; stories stay, because the image ends long
//               before the filesystem and the firmware's first start no longer
//               formats a filesystem that mounts (choosatron-esp32 c4c3868).
//   wipe        erase the whole chip, then the whole image. Stories go too.
//
// Measured from this page on hardware in cdam-fniz.2; the README has the table.
//
// Words go through t() (i18n.js); tools/extract_strings.py collects them.
//
// Query parameters, for testing only:
//   ?firmware=<url>   where releases.json lives (default ../firmware/)
//   ?board=<name>     which board's images to offer (default wroom-v0.1)
//   ?after=no_reset   leave the chip in the flasher when done, so the flash can
//                     be read back before the firmware boots and writes to it
//   ?lang=<tag>       start in this language

import { ESPLoader, Transport } from './vendor/esptool-js-0.7.0/bundle.js';
import { t, use, match, current, LANGUAGES } from './i18n.js';

const params = new URLSearchParams( location.search );
const FIRMWARE_BASE = new URL( params.get( 'firmware' ) || '../firmware/', location.href ).href;
const BOARD = params.get( 'board' ) || 'wroom-v0.1';
const AFTER = params.get( 'after' ) === 'no_reset' ? 'no_reset' : 'hard_reset';
const KNOWN_BOARDS = [ 'wroom-v0.1', 'xiao-v0.1' ];
const ESPRESSIF_VID = 0x303a; // the S3's built-in USB-Serial-JTAG
const LANG_KEY = 'choosatron-flasher-lang';

// The flash layout (choosatron-esp32 partitions.csv). Frozen once devices ship.
const PART_TABLE = 0x8000;
const NVS_START = 0x9000;
const NVS_END = 0xe000;
const APP = 0x10000;
const FS_START = 0x790000;
const APP_DESC = APP + 0x20; // image header (24) + first segment header (8)
const APP_DESC_MAGIC = 0xabcd5432;

const $ = ( id ) => document.getElementById( id );

let releases = [];   // usable releases for BOARD, newest first
let releasesError = null;
let image = null;    // { bytes, version, board, sha256 } once chosen and checked
let installing = false;
let loadSeq = 0;     // guards against an older download finishing after a newer pick

/* ---------------- small helpers ---------------- */

function esc( s ) {
   return String( s ?? '' ).replace( /[&<>"']/g, ( c ) =>
      ( { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' } )[c] );
}

function mb( n ) { return t( 'size_mb', '$SIZE$ MB', { size: ( n / 1048576 ).toFixed( 1 ) } ); }

function log( line ) {
   const pre = $( 'log' );
   pre.textContent += line + '\n';
   pre.scrollTop = pre.scrollHeight;
}

function status( kind, html ) {
   const el = $( 'status' );
   el.className = 'status ' + kind;
   el.innerHTML = html;
   el.hidden = false;
}

function clearRun() {
   if (installing) return;
   $( 'status' ).hidden = true;
   progress( null );
   $( 'log' ).textContent = '';
}

function progress( fraction, text ) {
   $( 'progress' ).hidden = fraction === null;
   if (fraction === null) return;
   $( 'progress-fill' ).style.width = Math.round( fraction * 100 ) + '%';
   $( 'progress-text' ).textContent = text || '';
}

async function sha256Hex( bytes ) {
   const digest = await crypto.subtle.digest( 'SHA-256', bytes );
   return [ ...new Uint8Array( digest ) ].map( ( b ) => b.toString( 16 ).padStart( 2, '0' ) ).join( '' );
}

function indexOfBytes( hay, needle ) {
   outer: for (let i = 0; i <= hay.length - needle.length; i++) {
      for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
      return i;
   }
   return -1;
}

const notFoundHelp = () => t( 'see_not_found',
   'If it cannot connect, see "If the Choosatron is not found" below.' );

/* ---------------- what is in an image ---------------- */

// Reads the image itself rather than trusting a file name or a list: a wrong
// image is the one mistake this page can make worse.
function inspect( bytes ) {
   if (bytes.length < APP + 0x100) {
      throw new Error( t( 'image.too_small', 'This file is too small to be a recovery image.' ) );
   }
   if (bytes[0] !== 0xe9 || bytes[APP] !== 0xe9 || bytes[PART_TABLE] !== 0xaa || bytes[PART_TABLE + 1] !== 0x50) {
      if (bytes[0] === 0xe9) {
         throw new Error( t( 'image.is_update',
            'This is an update image ($UPDATE$), not a recovery image. Pick $RECOVERY$, or install ' +
            'this one from the Firmware tab of the Choosatron’s own web page.',
            { update: 'choosatron.bin', recovery: 'choosatron-factory.bin' } ) );
      }
      throw new Error( t( 'image.not_recovery', 'This file is not a Choosatron recovery image.' ) );
   }
   if (bytes.length > FS_START) {
      throw new Error( t( 'image.too_big',
         'This image reaches into the story storage, so it is not a Choosatron recovery image.' ) );
   }
   const dv = new DataView( bytes.buffer, bytes.byteOffset );
   let version = null;
   let project = null;
   if (dv.getUint32( APP_DESC, true ) === APP_DESC_MAGIC) {
      const text = ( off, len ) => new TextDecoder().decode( bytes.subarray( APP_DESC + off, APP_DESC + off + len ) ).split( '\0' )[0];
      version = text( 16, 32 );
      project = text( 48, 32 );
   }
   if (project && project !== 'choosatron') {
      throw new Error( t( 'image.other_project', 'This image is "$NAME$", not Choosatron firmware.',
                          { name: project } ) );
   }
   // The firmware names its pin map with one string per board; a build holds
   // only its own.
   const enc = new TextEncoder();
   const found = KNOWN_BOARDS.filter( ( b ) => indexOfBytes( bytes, enc.encode( b ) ) >= 0 );
   return { version, board: found.length === 1 ? found[0] : null };
}

function showImage( img ) {
   const info = $( 'fw-info' );
   const unknown = t( 'unknown', 'unknown' );
   let rows = `<dt>${esc( t( 'info.version', 'Version' ) )}</dt><dd>${esc( img.version || unknown )}</dd>` +
              `<dt>${esc( t( 'info.size', 'Size' ) )}</dt><dd>${esc( mb( img.bytes.length ) )}</dd>` +
              `<dt>${esc( t( 'info.board', 'Built for' ) )}</dt><dd>${esc( img.board || unknown )}</dd>`;
   if (img.sha256) rows += `<dt>SHA-256</dt><dd>${esc( img.sha256 )} &#10003;</dd>`;
   let note = '';
   if (img.board && img.board !== BOARD) {
      note = `<p class="warn-text">${esc( t( 'image.wrong_board',
         'This image was built for $BUILT$, not $WANTED$. On the wrong board the buttons and ' +
         'printer do not work until the right image is installed.',
         { built: img.board, wanted: BOARD } ) )}</p>`;
   } else if (!img.board) {
      note = `<p class="warn-text">${esc( t( 'image.board_unknown',
         'Could not tell which board this image was built for.' ) )}</p>`;
   }
   info.innerHTML = `<dl>${rows}</dl>${note}`;
   info.hidden = false;
}

function showError( message ) {
   const info = $( 'fw-info' );
   info.innerHTML = `<p class="bad-text">${esc( message )}</p>`;
   info.hidden = false;
}

/* ---------------- the release list ---------------- */

async function getJson( name ) {
   const res = await fetch( new URL( name, FIRMWARE_BASE ), { cache: 'no-store' } );
   if (res.status === 404) return null;
   if (!res.ok) throw new Error( `${name}: HTTP ${res.status}` );
   return res.json();
}

// releases.json lists every version; manifest.json only the newest per channel,
// and is the fallback while the history file does not exist yet.
async function loadReleases() {
   let list = [];
   const history = await getJson( 'releases.json' );
   if (history && Array.isArray( history.releases )) {
      list = history.releases;
   } else {
      const manifest = await getJson( 'manifest.json' );
      const channels = ( manifest && manifest.channels ) || {};
      list = Object.keys( channels ).map( ( ch ) => ( { ...channels[ch], channel: ch } ) );
   }
   return list.filter( ( r ) => r.boards && r.boards[BOARD] && r.boards[BOARD].factory_url );
}

function channelName( ch ) {
   return ch === 'stable' ? t( 'channel.stable', 'Stable' )
        : ch === 'beta' ? t( 'channel.beta', 'Beta' ) : ch;
}

function recommendedRelease() {
   return releases.find( ( r ) => r.channel === 'stable' ) || releases[0];
}

function renderLatest() {
   const latest = $( 'fw-latest' );
   const rec = recommendedRelease();
   if (releasesError) {
      latest.innerHTML = `<p class="bad-text">${esc( t( 'releases.unreadable',
         'Could not read the list of releases: $ERROR$', { error: releasesError } ) )}</p>`;
   } else if (!rec) {
      latest.innerHTML = `<p class="dim">${esc( t( 'releases.none',
         'No firmware has been published for this board yet. You can still install a recovery image from this computer.' ) )}</p>`;
   } else {
      const beta = releases.find( ( r ) => r.channel === 'beta' );
      const newerBeta = beta && releases.indexOf( beta ) < releases.indexOf( rec );
      latest.innerHTML =
         `<div class="dim small">${esc( t( 'releases.recommended', 'Recommended' ) )}</div>` +
         `<div class="ver" translate="no">${esc( rec.version )}<span class="chan ${rec.channel === 'beta' ? 'beta' : ''}">${esc( channelName( rec.channel ) )}</span></div>` +
         `<div class="dim small">${esc( t( 'releases.released', 'Released $DATE$', { date: rec.released || '—' } ) )}</div>` +
         ( newerBeta ? `<div class="dim small">${esc( t( 'releases.newer_beta', 'A newer beta is in the list below.' ) )}</div>` : '' );
   }
}

function renderOptions() {
   const pick = $( 'fw-pick' );
   const keep = pick.value;
   const rec = recommendedRelease();
   pick.innerHTML = releases.map( ( r, i ) => {
      const v = { version: r.version, channel: channelName( r.channel ), date: r.released || '—' };
      const label = r === rec
         ? t( 'releases.option_recommended', '$VERSION$ — $CHANNEL$, $DATE$ (recommended)', v )
         : t( 'releases.option', '$VERSION$ — $CHANNEL$, $DATE$', v );
      return `<option value="${i}">${esc( label )}</option>`;
   } ).join( '' ) + `<option value="file">${esc( t( 'releases.option_file', 'A file on this computer…' ) )}</option>`;
   pick.value = keep || ( rec ? String( releases.indexOf( rec ) ) : 'file' );
   pick.disabled = installing;
}

async function onPick() {
   const seq = ++loadSeq;
   const value = $( 'fw-pick' ).value;
   image = null;
   $( 'fw-info' ).hidden = true;
   $( 'fw-file-row' ).hidden = value !== 'file';
   updateInstall();
   if (value === 'file') {
      if ($( 'fw-file' ).files[0]) onFile();
      return;
   }
   const r = releases[+value];
   const b = r.boards[BOARD];
   const info = $( 'fw-info' );
   info.innerHTML = `<p class="dim">${esc( t( 'releases.downloading', 'Downloading $VERSION$ ($SIZE$)…',
                                               { version: r.version, size: mb( b.factory_size || 0 ) } ) )}</p>`;
   info.hidden = false;
   try {
      const res = await fetch( b.factory_url, { cache: 'no-store' } );
      if (!res.ok) {
         throw new Error( t( 'releases.download_http', 'The download failed (HTTP $STATUS$).', { status: res.status } ) );
      }
      const bytes = new Uint8Array( await res.arrayBuffer() );
      if (seq !== loadSeq) return;
      const sha = await sha256Hex( bytes );
      if (b.factory_sha256 && sha !== b.factory_sha256) {
         throw new Error( t( 'releases.damaged',
            'The download is damaged: it does not match the release. Reload the page and try again.' ) );
      }
      const found = inspect( bytes );
      image = { bytes, version: found.version || r.version, board: found.board, sha256: b.factory_sha256 ? sha : null };
      showImage( image );
   } catch (e) {
      if (seq !== loadSeq) return;
      showError( e instanceof TypeError
         ? t( 'releases.download_failed', 'The download failed. Check the internet connection and try again.' )
         : e.message );
   }
   updateInstall();
}

async function onFile() {
   const seq = ++loadSeq;
   const file = $( 'fw-file' ).files[0];
   image = null;
   updateInstall();
   if (!file) return;
   try {
      const bytes = new Uint8Array( await file.arrayBuffer() );
      if (seq !== loadSeq) return;
      const found = inspect( bytes );
      image = { bytes, version: found.version, board: found.board, sha256: null };
      showImage( image );
   } catch (e) {
      showError( e.message );
   }
   updateInstall();
}

/* ---------------- mode and the button ---------------- */

function mode() { return document.querySelector( 'input[name=mode]:checked' ).value; }

function updateInstall() {
   const m = mode();
   $( 'wipe-confirm-row' ).hidden = m !== 'wipe';
   const btn = $( 'install' );
   btn.classList.toggle( 'danger', m === 'wipe' );
   btn.textContent = m === 'wipe' ? t( 'install.wipe', 'Erase everything and install' )
                   : m === 'settings' ? t( 'install.settings', 'Install and reset settings' )
                   : t( 'install.button', 'Install' );
   btn.disabled = installing || !image || ( m === 'wipe' && !$( 'wipe-confirm' ).checked );
   for (const el of document.querySelectorAll( '#fw-file, input[name=mode], #wipe-confirm, #lang' )) {
      el.disabled = installing;
   }
   $( 'fw-pick' ).disabled = installing || !$( 'fw-pick' ).options.length;
}

function partsFor( m, bytes ) {
   if (m === 'reinstall') {
      // Everything but NVS: bootloader and partition table, then otadata and app.
      return [ { data: bytes.slice( 0, NVS_START ), address: 0 },
               { data: bytes.slice( NVS_END ), address: NVS_END } ];
   }
   return [ { data: bytes.slice(), address: 0 } ];
}

/* ---------------- installing ---------------- */

const terminal = {
   clean() {},
   writeLine( data ) { log( data ); },
   write( data ) { log( data ); },
};

const strong = ( s ) => `<strong>${esc( s )}</strong>`;

async function install() {
   const m = mode();
   const img = image;
   if (!img) return;

   let port;
   try {
      port = await navigator.serial.requestPort( { filters: [ { usbVendorId: ESPRESSIF_VID } ] } );
   } catch (e) {
      // NotFoundError is the person closing the chooser, or there being nothing to choose.
      status( 'bad', e.name === 'NotFoundError'
         ? esc( t( 'install.none_chosen', 'No Choosatron was chosen.' ) + ' ' + notFoundHelp() )
         : esc( e.message ) );
      return;
   }

   installing = true;
   updateInstall();
   $( 'log' ).textContent = '';
   progress( 0, '' );
   const transport = new Transport( port, false );
   try {
      status( 'busy', esc( t( 'install.connecting', 'Connecting to the Choosatron…' ) ) );
      const loader = new ESPLoader( { transport, baudrate: 921600, romBaudrate: 921600, terminal } );
      await loader.main( 'default_reset' );

      const chip = loader.chip && loader.chip.CHIP_NAME;
      if (!/ESP32-S3/.test( chip || '' )) {
         throw new Error( t( 'install.wrong_chip',
            'This device is $CHIP$, not a Choosatron (ESP32-S3). Nothing was written.',
            { chip: chip || t( 'unknown', 'unknown' ) } ) );
      }
      const size = await loader.detectFlashSize();
      if (size && size !== '16MB') {
         throw new Error( t( 'install.wrong_flash',
            'This board has $SIZE$ of flash; a Choosatron has 16MB. Nothing was written.', { size } ) );
      }

      const parts = partsFor( m, img.bytes );
      const total = parts.reduce( ( n, p ) => n + p.data.length, 0 );
      const before = parts.map( ( _, i ) => parts.slice( 0, i ).reduce( ( n, p ) => n + p.data.length, 0 ) );
      const writing = esc( t( 'install.writing', 'Installing. Leave the cable connected…' ) );
      status( 'busy', m === 'wipe'
         ? esc( t( 'install.erasing', 'Erasing the whole memory. This takes up to a minute…' ) )
         : writing );
      await loader.writeFlash( {
         fileArray: parts,
         flashMode: 'keep', flashFreq: 'keep', flashSize: 'keep',
         eraseAll: m === 'wipe',
         compress: true,
         reportProgress( fileIndex, written ) {
            if (m === 'wipe') status( 'busy', writing );
            const done = before[fileIndex] + written;
            progress( done / total, t( 'install.progress', '$DONE$ of $TOTAL$', { done: mb( done ), total: mb( total ) } ) );
         },
         // Each part is read back from the flash and compared.
         calculateMD5Hash: ( data ) => SparkMD5.ArrayBuffer.hash(
            data.buffer.slice( data.byteOffset, data.byteOffset + data.byteLength ) ),
      } );
      progress( 1, t( 'install.verified', '$TOTAL$ written and verified', { total: mb( total ) } ) );
      await loader.after( AFTER );
      if (AFTER === 'no_reset') log( 'Left in the flasher (?after=no_reset): press RESET to start it.' );

      const v = { version: img.version || '' };
      status( 'ok', strong( t( 'done.title', 'Done.' ) ) + ' ' + esc( m === 'reinstall'
         ? t( 'done.reinstall',
              '$VERSION$ is installed and the Choosatron is restarting. Its stories, playlists and settings are as they were.', v )
         : m === 'settings'
         ? t( 'done.settings',
              '$VERSION$ is installed and the Choosatron is restarting with its settings as new. It comes up as its own open Wi-Fi network, named Choosatron-, to set up again. Its stories and playlists are kept.', v )
         : t( 'done.wipe',
              '$VERSION$ is installed on an erased Choosatron, which is restarting as new. It prints its setup slip and comes up as its own open Wi-Fi network, named Choosatron-.', v ) ) );
   } catch (e) {
      log( String( e && e.stack || e ) );
      status( 'bad', strong( t( 'failed.title', 'The install did not finish.' ) ) + ' ' +
         esc( e.message || e ) + '<br>' +
         esc( t( 'failed.retry', 'Nothing is lost by trying again: reconnect the cable and press the button again.' ) +
              ' ' + notFoundHelp() ) );
   } finally {
      try { await transport.disconnect(); } catch (e) { /* already gone */ }
      installing = false;
      updateInstall();
   }
}

/* ---------------- language ---------------- */

function storedLanguage() {
   try { return localStorage.getItem( LANG_KEY ); } catch (e) { return null; }
}

async function setLanguage( tag, remember ) {
   const got = await use( tag );
   if (remember) {
      try { localStorage.setItem( LANG_KEY, got ); } catch (e) { /* private mode: fine */ }
   }
   $( 'lang' ).value = got;
   document.title = t( 'page_title', 'Choosatron Flasher' );
   renderLatest();
   if ($( 'fw-pick' ).options.length) renderOptions();
   if (image) showImage( image );
   updateInstall();
}

/* ---------------- wiring ---------------- */

async function start() {
   const langSel = $( 'lang' );
   langSel.innerHTML = LANGUAGES.map( ( [ tag, name ] ) => `<option value="${tag}">${esc( name )}</option>` ).join( '' );
   const startTag = params.get( 'lang' ) || storedLanguage() ||
                    match( navigator.languages && navigator.languages.length ? navigator.languages : [ navigator.language ] );
   await setLanguage( startTag, false );
   langSel.addEventListener( 'change', () => { clearRun(); setLanguage( langSel.value, true ); } );

   if (!( 'serial' in navigator ) || !window.isSecureContext) {
      $( 'no-serial' ).hidden = false;
      $( 'app' ).hidden = true;
      return;
   }

   // Changing any choice starts a new run: the last run's progress and result
   // describe something that is no longer on screen. The erase confirmation is
   // given again every time "Erase everything" is chosen.
   const fresh = ( fn ) => () => { clearRun(); fn(); };
   $( 'fw-pick' ).addEventListener( 'change', fresh( onPick ) );
   $( 'fw-file' ).addEventListener( 'change', fresh( onFile ) );
   for (const r of document.querySelectorAll( 'input[name=mode]' )) {
      r.addEventListener( 'change', fresh( () => { $( 'wipe-confirm' ).checked = false; updateInstall(); } ) );
   }
   $( 'wipe-confirm' ).addEventListener( 'change', fresh( updateInstall ) );
   $( 'install' ).addEventListener( 'click', install );
   window.addEventListener( 'beforeunload', ( e ) => { if (installing) e.preventDefault(); } );

   $( 'fw-latest' ).textContent = t( 'releases.loading', 'Loading the list of releases…' );
   try {
      releases = await loadReleases();
   } catch (e) {
      releases = [];
      releasesError = e.message;
   }
   renderLatest();
   renderOptions();
   onPick();
}

start();
