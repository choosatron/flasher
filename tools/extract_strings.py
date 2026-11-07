#!/usr/bin/env python3
"""Write locales/en.json: every translatable string on the page, from its source.

    index.html   data-i18n="key"        the element's text
                 data-i18n-parts="key"  a sentence with markup; child elements
                                        become $1$, $2$... (see i18n.js)
    *.js         t('key', 'English' + 'more', {...})

en.json is generated, never edited: the English lives where it is used. It is
the catalog the Choosatron's translation tool reads -

    choosatron-esp32/choosatron/tools/15_translate_locales.py --all \\
        --catalog <this repo>/locales/en.json --locales <this repo>/locales

- which writes locales/<tag>.json in the same format the device's own page
uses, and keeps $NAME$ and $1$ placeholders intact.

    python3 tools/extract_strings.py          write locales/en.json
    python3 tools/extract_strings.py check    fail if it is out of date, or a
                                              pack has a key en.json does not
"""

import html.parser
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EN = os.path.join(ROOT, "locales", "en.json")
JS_FILES = ["flasher.js"]

T_CALL = re.compile(r"""\bt\(\s*'([a-z0-9_.]+)'\s*,\s*((?:'(?:[^'\\]|\\.)*'\s*\+?\s*)+)""")
JS_STR = re.compile(r"'((?:[^'\\]|\\.)*)'")
PARTS_NOTE = ("A sentence that contains markup. $1$, $2$ and so on are the page's own elements "
              "(bold text, links, names) - move them where the sentence needs them, but do not "
              "translate or drop the markers.")
VALUE_NOTE = "Words between dollar signs, like $VERSION$, are filled in by the page; keep them as they are."


def js_unescape(s):
    return re.sub(r"\\u([0-9a-fA-F]{4})|\\(.)",
                  lambda m: chr(int(m.group(1), 16)) if m.group(1) else m.group(2), s)


def collapse(text):
    return re.sub(r"\s+", " ", text).strip()


class Marks(html.parser.HTMLParser):
    """Collects data-i18n text and data-i18n-parts templates."""

    VOID = {"br", "img", "input", "meta", "link", "hr"}

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.found = {}
        self.stack = []  # [key, kind, depth, text, kids]
        self.depth = 0

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if self.stack and self.stack[-1][1] == "parts" and self.depth == self.stack[-1][2]:
            frame = self.stack[-1]
            frame[4] += 1
            frame[3] += "$%d$" % frame[4]
        if tag in self.VOID:
            return
        self.depth += 1
        if "data-i18n" in attrs:
            self.stack.append([attrs["data-i18n"], "text", self.depth, "", 0])
        elif "data-i18n-parts" in attrs:
            self.stack.append([attrs["data-i18n-parts"], "parts", self.depth, "", 0])

    def handle_endtag(self, tag):
        if tag in self.VOID:
            return
        if self.stack and self.stack[-1][2] == self.depth:
            key, kind, _, text, _ = self.stack.pop()
            self.add(key, collapse(text), PARTS_NOTE if kind == "parts" else None)
        self.depth -= 1

    def handle_data(self, data):
        for frame in self.stack:
            # A parts sentence keeps only its own text; its children are slots.
            if frame[1] == "parts" and self.depth != frame[2]:
                continue
            frame[3] += data

    def add(self, key, message, note):
        if key in self.found and self.found[key]["message"] != message:
            sys.exit("%s: two different English texts" % key)
        self.found[key] = {"message": message}
        if note:
            self.found[key]["description"] = note


def extract():
    marks = Marks()
    with open(os.path.join(ROOT, "index.html"), encoding="utf-8") as f:
        marks.feed(f.read())
    catalog = dict(marks.found)
    for name in JS_FILES:
        with open(os.path.join(ROOT, name), encoding="utf-8") as f:
            source = f.read()
        for m in T_CALL.finditer(source):
            key = m.group(1)
            message = "".join(js_unescape(s) for s in JS_STR.findall(m.group(2)))
            if key in catalog and catalog[key]["message"] != message:
                sys.exit("%s: two different English texts" % key)
            catalog[key] = {"message": message}
    for entry in catalog.values():
        if re.search(r"\$[A-Z_]+\$", entry["message"]):
            entry["description"] = (entry.get("description", "") + " " + VALUE_NOTE).strip()
    return dict(sorted(catalog.items()))


def main():
    catalog = extract()
    text = json.dumps(catalog, ensure_ascii=False, indent=2) + "\n"
    if len(sys.argv) > 1 and sys.argv[1] == "check":
        problems = []
        if not os.path.exists(EN) or open(EN, encoding="utf-8").read() != text:
            problems.append("locales/en.json is out of date: run tools/extract_strings.py")
        for name in sorted(os.listdir(os.path.dirname(EN))):
            if name.endswith(".json") and name != "en.json":
                pack = json.load(open(os.path.join(os.path.dirname(EN), name), encoding="utf-8"))
                extra = sorted(set(pack) - set(catalog))
                missing = sorted(set(catalog) - set(pack))
                if extra:
                    problems.append("%s: keys no longer on the page: %s" % (name, ", ".join(extra)))
                if missing:
                    print("%s: %d of %d keys not translated yet (English is used)" % (name, len(missing), len(catalog)))
        if problems:
            sys.exit("\n".join(problems))
        print("clean: %d keys" % len(catalog))
        return
    os.makedirs(os.path.dirname(EN), exist_ok=True)
    with open(EN, "w", encoding="utf-8") as f:
        f.write(text)
    print("wrote locales/en.json (%d keys)" % len(catalog))


if __name__ == "__main__":
    main()
