#!/usr/bin/env python3
"""Copy the Choosatron web page's translations for words this page shares with it.

The flasher names things the owner also sees on the Choosatron's own page - the
Firmware tab, the Stable channel - and the two must agree in every language, or
the flasher points at a tab by a name the device does not use. Machine
translation of a single word also goes wrong without context ("Board" came back
as a wooden plank). So for these keys the device's packs are the authority:
this overwrites them in locales/<tag>.json after each translation run.

    python3 tools/shared_strings.py [path to choosatron-esp32/choosatron]
"""

import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEVICE = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, "..", "choosatron-esp32", "choosatron")
DEVICE_LOCALES = os.path.join(DEVICE, "data", "source", "locales")

# flasher key -> device key with the same English and the same meaning
SHARED = {
    "intro.firmware_tab": "nav.firmware",
    "channel.stable": "fw.stable",
    "info.size": "image.size",
    "language": "catalog.language",
}


def main():
    en = json.load(open(os.path.join(ROOT, "locales", "en.json"), encoding="utf-8"))
    dev_en = json.load(open(os.path.join(DEVICE, "data", "generated", "locales", "en.json"), encoding="utf-8"))
    for ours, theirs in SHARED.items():
        if en[ours]["message"] != dev_en[theirs]["message"]:
            sys.exit("%s (%r) no longer matches the device's %s (%r)"
                     % (ours, en[ours]["message"], theirs, dev_en[theirs]["message"]))
    changed = 0
    for name in sorted(os.listdir(os.path.join(ROOT, "locales"))):
        if not name.endswith(".json") or name == "en.json":
            continue
        path = os.path.join(ROOT, "locales", name)
        pack = json.load(open(path, encoding="utf-8"))
        device = json.load(open(os.path.join(DEVICE_LOCALES, name), encoding="utf-8"))
        for ours, theirs in SHARED.items():
            if theirs in device and pack.get(ours, {}).get("message") != device[theirs]["message"]:
                pack[ours] = {"message": device[theirs]["message"], "source": device[theirs].get("source")}
                changed += 1
        with open(path, "w", encoding="utf-8") as f:
            f.write(json.dumps(pack, ensure_ascii=False, indent=2) + "\n")
    print("%d shared strings taken from the device's packs" % changed)


if __name__ == "__main__":
    main()
