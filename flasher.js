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
// Measured on hardware in cdam-fniz.3; docs/firmware-runbook.md section 6 in
// choosatron-esp32 has the table.
//
// Query parameters, for testing only:
//   ?firmware=<url>   where releases.json lives (default ../firmware/)
//   ?board=<name>     which board's images to offer (default wroom-v0.1)
//   ?after=no_reset   leave the chip in the flasher when done, so the flash can
//                     be read back before the firmware boots and writes to it

import { ESPLoader, Transport } from './vendor/esptool-js-0.7.0/bundle.js';

const params = new URLSearchParams( location.search );
const FIRMWARE_BASE = new URL( params.get( 'firmware' ) || '../firmware/', location.href ).href;
const BOARD = params.get( 'board' ) || 'wroom-v0.1';
const AFTER = params.get( 'after' ) === 'no_reset' ? 'no_reset' : 'hard_reset';
const KNOWN_BOARDS = [ 'wroom-v0.1', 'xiao-v0.1' ];
const ESPRESSIF_VID = 0x303a; // the S3's built-in USB-Serial-JTAG

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
let image = null;    // { bytes, label, version, board } once chosen and checked
let installing = false;
let loadSeq = 0;     // guards against an older download finishing after a newer pick

/* ---------------- small helpers ---------------- */

function esc( s ) {
   return String( s ?? '' ).replace( /[&<>"']/g, ( c ) =>
      ( { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' } )[c] );
}

function mb( n ) { return ( n / 1048576 ).toFixed( 1 ) + ' MB'; }

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

/* ---------------- what is in an image ---------------- */

// Reads the image itself rather than trusting a file name or a list: a wrong
// image is the one mistake this page can make worse.
function inspect( bytes ) {
   if (bytes.length < APP + 0x100) throw new Error( 'This file is too small to be a recovery image.' );
   if (bytes[0] !== 0xe9 || bytes[APP] !== 0xe9 || bytes[PART_TABLE] !== 0xaa || bytes[PART_TABLE + 1] !== 0x50) {
      if (bytes[0] === 0xe9) {
         throw new Error( 'This is an update image (choosatron.bin), not a recovery image. Pick ' +
                          'choosatron-factory.bin, or install this one from the Firmware tab of the ' +
                          'Choosatron’s own web page.' );
      }
      throw new Error( 'This file is not a Choosatron recovery image.' );
   }
   if (bytes.length > FS_START) {
      throw new Error( 'This image reaches into the story storage, so it is not a Choosatron recovery image.' );
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
      throw new Error( `This image is "${project}", not Choosatron firmware.` );
   }
   // The firmware names its pin map with one string per board; a build holds
   // only its own.
   const enc = new TextEncoder();
   const found = KNOWN_BOARDS.filter( ( b ) => indexOfBytes( bytes, enc.encode( b ) ) >= 0 );
   return { version, board: found.length === 1 ? found[0] : null };
}

function showImage( img ) {
   const info = $( 'fw-info' );
   let rows = `<dt>Version</dt><dd>${esc( img.version || 'unknown' )}</dd>` +
              `<dt>Size</dt><dd>${mb( img.bytes.length )}</dd>` +
              `<dt>Board</dt><dd>${esc( img.board || 'unknown' )}</dd>`;
   if (img.sha256) rows += `<dt>SHA-256</dt><dd>${esc( img.sha256 )} &#10003;</dd>`;
   let note = '';
   if (img.board && img.board !== BOARD) {
      note = `<p class="warn-text">This image was built for <strong>${esc( img.board )}</strong>, not ` +
             `<strong>${esc( BOARD )}</strong>. On the wrong board the buttons and printer do ` +
             `not work until the right image is installed.</p>`;
   } else if (!img.board) {
      note = '<p class="warn-text">Could not tell which board this image was built for.</p>';
   }
   info.innerHTML = `<dl>${rows}</dl>${note}`;
   info.hidden = false;
}

/* ---------------- the release list ---------------- */

async function getJson( name ) {
   const res = await fetch( new URL( name, FIRMWARE_BASE ), { cache: 'no-store' } );
   if (res.status === 404) return null;
   if (!res.ok) throw new Error( `${name} answered HTTP ${res.status}` );
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

function chanBadge( ch ) {
   return `<span class="chan ${ch === 'beta' ? 'beta' : ''}">${esc( ch )}</span>`;
}

function renderReleases() {
   const pick = $( 'fw-pick' );
   const latest = $( 'fw-latest' );
   const recommended = releases.find( ( r ) => r.channel === 'stable' ) || releases[0];

   if (!recommended) {
      latest.innerHTML = '<p class="dim">No firmware has been published for this board yet. ' +
                         'You can still install a recovery image from this computer.</p>';
   } else {
      const newerBeta = releases.find( ( r ) => r.channel === 'beta' ) &&
                        releases.indexOf( releases.find( ( r ) => r.channel === 'beta' ) ) <
                        releases.indexOf( recommended );
      latest.innerHTML =
         `<div class="dim small">Recommended</div>` +
         `<div class="ver">${esc( recommended.version )}${chanBadge( recommended.channel )}</div>` +
         `<div class="dim small">Released ${esc( recommended.released || '—' )}` +
         ( recommended.notes ? ` &middot; ${esc( recommended.notes )}` : '' ) + '</div>' +
         ( newerBeta ? '<div class="dim small">A newer beta is in the list below.</div>' : '' );
   }

   pick.innerHTML = releases.map( ( r, i ) =>
      `<option value="${i}">${esc( r.version )} — ${esc( r.channel )}` +
      ( r.released ? `, ${esc( r.released )}` : '' ) +
      ( r === recommended ? ' (recommended)' : '' ) + '</option>' ).join( '' ) +
      '<option value="file">A file on this computer…</option>';
   pick.value = recommended ? String( releases.indexOf( recommended ) ) : 'file';
   pick.disabled = false;
   onPick();
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
   info.innerHTML = `<p class="dim">Downloading ${esc( r.version )} (${mb( b.factory_size || 0 )})&hellip;</p>`;
   info.hidden = false;
   try {
      const res = await fetch( b.factory_url, { cache: 'no-store' } );
      if (!res.ok) throw new Error( `The download answered HTTP ${res.status}.` );
      const bytes = new Uint8Array( await res.arrayBuffer() );
      if (seq !== loadSeq) return;
      const sha = await sha256Hex( bytes );
      if (b.factory_sha256 && sha !== b.factory_sha256) {
         throw new Error( 'The download is damaged (its SHA-256 does not match the release). Reload the page and try again.' );
      }
      const found = inspect( bytes );
      image = { bytes, version: found.version || r.version, board: found.board, sha256: b.factory_sha256 ? sha : null };
      showImage( image );
   } catch (e) {
      if (seq !== loadSeq) return;
      info.innerHTML = `<p class="bad-text">${esc( e.message )}</p>`;
   }
   updateInstall();
}

async function onFile() {
   const seq = ++loadSeq;
   const file = $( 'fw-file' ).files[0];
   image = null;
   updateInstall();
   if (!file) return;
   const info = $( 'fw-info' );
   try {
      const bytes = new Uint8Array( await file.arrayBuffer() );
      if (seq !== loadSeq) return;
      const found = inspect( bytes );
      image = { bytes, version: found.version, board: found.board, sha256: null, file: file.name };
      showImage( image );
   } catch (e) {
      info.innerHTML = `<p class="bad-text">${esc( e.message )}</p>`;
      info.hidden = false;
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
   btn.textContent = m === 'wipe' ? 'Erase everything and install'
                   : m === 'settings' ? 'Install and reset settings' : 'Install';
   btn.disabled = installing || !image || ( m === 'wipe' && !$( 'wipe-confirm' ).checked );
   for (const el of document.querySelectorAll( '#fw-pick, #fw-file, input[name=mode], #wipe-confirm' )) {
      el.disabled = installing || ( el.id === 'fw-pick' && !releases.length && !$( 'fw-pick' ).options.length );
   }
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
         ? 'No Choosatron was chosen. If none was listed, see <strong>If the Choosatron is not found</strong> below.'
         : esc( e.message ) );
      return;
   }

   installing = true;
   updateInstall();
   $( 'log' ).textContent = '';
   progress( 0, '' );
   const transport = new Transport( port, false );
   try {
      status( 'busy', 'Connecting to the Choosatron&hellip;' );
      const loader = new ESPLoader( { transport, baudrate: 921600, romBaudrate: 921600, terminal } );
      await loader.main( 'default_reset' );

      const chip = loader.chip && loader.chip.CHIP_NAME;
      if (!/ESP32-S3/.test( chip || '' )) {
         throw new Error( `This device is ${chip || 'not recognised'}, not a Choosatron (ESP32-S3). Nothing was written.` );
      }
      const size = await loader.detectFlashSize();
      if (size && size !== '16MB') {
         throw new Error( `This board has ${size} of flash; a Choosatron has 16MB. Nothing was written.` );
      }

      const parts = partsFor( m, img.bytes );
      const total = parts.reduce( ( n, p ) => n + p.data.length, 0 );
      const before = parts.map( ( _, i ) => parts.slice( 0, i ).reduce( ( n, p ) => n + p.data.length, 0 ) );
      status( 'busy', m === 'wipe'
         ? 'Erasing the whole memory. This takes up to a minute&hellip;'
         : 'Installing. Leave the cable connected&hellip;' );
      await loader.writeFlash( {
         fileArray: parts,
         flashMode: 'keep', flashFreq: 'keep', flashSize: 'keep',
         eraseAll: m === 'wipe',
         compress: true,
         reportProgress( fileIndex, written ) {
            if (m === 'wipe') status( 'busy', 'Installing. Leave the cable connected&hellip;' );
            const done = before[fileIndex] + written;
            progress( done / total, `${mb( done )} of ${mb( total )}` );
         },
         // Each part is read back from the flash and compared.
         calculateMD5Hash: ( data ) => SparkMD5.ArrayBuffer.hash(
            data.buffer.slice( data.byteOffset, data.byteOffset + data.byteLength ) ),
      } );
      progress( 1, `${mb( total )} written and verified` );
      await loader.after( AFTER );
      if (AFTER === 'no_reset') log( 'Left in the flasher (?after=no_reset): press RESET to start it.' );

      const v = esc( img.version || 'The firmware' );
      status( 'ok', m === 'reinstall'
         ? `<strong>Done.</strong> ${v} is installed and the Choosatron is restarting. Its stories, ` +
           'playlists and settings are as they were.'
         : m === 'settings'
         ? `<strong>Done.</strong> ${v} is installed and the Choosatron is restarting with its ` +
           'settings as new. It comes up as its own open Wi-Fi network, named Choosatron-, to set up ' +
           'again. Its stories and playlists are kept.'
         : `<strong>Done.</strong> ${v} is installed on an erased Choosatron, which is restarting as ` +
           'new. It prints its setup slip and comes up as its own open Wi-Fi network, named Choosatron-.' );
   } catch (e) {
      log( String( e && e.stack || e ) );
      status( 'bad', `<strong>The install did not finish.</strong> ${esc( e.message || e )}<br>` +
         'Nothing is lost by trying again: reconnect the cable and press the button again. If it ' +
         'cannot connect, see <strong>If the Choosatron is not found</strong> below.' );
   } finally {
      try { await transport.disconnect(); } catch (e) { /* already gone */ }
      installing = false;
      updateInstall();
   }
}

/* ---------------- wiring ---------------- */

function start() {
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

   loadReleases().then( ( list ) => {
      releases = list;
      renderReleases();
   } ).catch( ( e ) => {
      releases = [];
      renderReleases();
      $( 'fw-latest' ).innerHTML = `<p class="bad-text">Could not read the list of releases: ${esc( e.message )}</p>`;
   } );
   updateInstall();
}

start();
