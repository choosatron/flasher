# Choosatron flasher

A static page that reinstalls or recovers a Choosatron over USB from Chrome or Edge,
with nothing to install. Served by GitHub Pages at `choosatron.github.io/flasher/`.

It holds no firmware. It reads the release list and recovery images that the release
workflow in `choosatron-esp32` publishes to `choosatron.github.io/firmware/`
(`releases.json`, falling back to `manifest.json`). That site is on the same origin, so no
CORS setup is needed.

## What it does

The page offers the newest stable release, any other published release from a dropdown,
or a recovery image from the computer. It checks the image (file type, Choosatron
firmware, which board it was built for, and the release's SHA-256), then writes it with
[esptool-js](https://github.com/espressif/esptool-js) in one of three modes:

| Mode | Writes | Settings | Stories |
| --- | --- | --- | --- |
| Reinstall | `0x0-0x9000` and `0xE000-end` of the recovery image: everything but NVS | kept | kept |
| Reinstall and reset settings | the whole recovery image from `0x0`; its padding blanks NVS | reset | kept |
| Erase everything | erases the whole chip, then the whole image | erased | erased |

All three were run from this page against a XIAO on 2026-11-06 (cdam-fniz.2), with each
flash region compared before and after. The flash layout is `partitions.csv` in
`choosatron-esp32`; see `docs/firmware-runbook.md` §6 there.

It only lists Espressif USB devices, refuses anything that is not an ESP32-S3 with 16 MB
of flash, and reads every part back to compare it after writing.

## Languages

The page speaks the 15 languages the Choosatron's own web page does. It follows the
browser's language (primary subtag and script; `zh-Hans` and `zh-Hant` apart), and a picker
in the header changes it and remembers the choice in this browser.

The marking conventions are the device page's (`i18n.js` explains them): the English lives
in `index.html` and in `t('key', 'English')` calls, and a sentence with markup keeps its
elements as `$1$`, `$2$`. To change or add text:

    python3 tools/extract_strings.py                 # locales/en.json from the source
    cd ../choosatron-esp32/choosatron
    python3 tools/15_translate_locales.py --all --retranslate-stale \
        --catalog ../../cdam-flasher/locales/en.json --locales ../../cdam-flasher/locales
    cd ../../cdam-flasher
    python3 tools/shared_strings.py                  # words shared with the device page
    python3 tools/extract_strings.py check

`shared_strings.py` copies the device's own translation for the few words both pages use
(the Firmware tab, the Stable channel), so the flasher never names a tab differently from
the Choosatron. The packs are machine translations and welcome a human read.

`locales/held/` holds the 19 languages the Choosatron keeps translated but does not ship
yet (the device's `data/source/locales/held/`): ready, never loaded, not in the picker. To
make one live, move its pack up to `locales/` and add it to `LANGUAGES` in `i18n.js`, at
the same time the device ships it. Refill them with `--held` added to the translate command
above.

## Testing

Web Serial works on `localhost`, so serve a folder that holds this repo as `flasher/`
next to a firmware tree as `firmware/`, and open `/flasher/`. Query parameters for
testing only:

- `?firmware=<url>`: where `releases.json` lives (default `../firmware/`)
- `?board=<name>`: which board's images to offer (default `wroom-v0.1`; `xiao-v0.1` for
  dev units)
- `?lang=<tag>`: start in this language
- `?after=no_reset`: leave the chip in its flasher when done, so the flash can be read
  back before the firmware boots and writes to it

## Vendored

- `vendor/esptool-js-0.7.0/`: `bundle.js` from the npm package, Apache-2.0
- `vendor/spark-md5-3.0.2/`: `spark-md5.min.js`, WTFPL

Kept in the repo rather than loaded from a CDN, so recovery does not depend on one.
