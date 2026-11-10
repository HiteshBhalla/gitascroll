"""Build the site's data files from the raw Gita dataset and the Shorts.

Inputs:  source/*.json (Sanskrit text, transliteration and chapter names), content/translations/
         (our English + Hindi translations), content/shorts/*.json (Shorts + chapter TL;DRs),
         content/faq/ (chapter FAQs and per-chapter verse FAQs),
         content/i18n/<lang>/ (French, Spanish and Arabic translations, Shorts and FAQs)
Outputs: public/data/chapters.json, public/data/chN.json, public/data/<lang>/ (fr, es, ar), public/genz.js,
         data/gita-context.json (compact text used by the Ask Gita API)

Run: python3 scripts/build_data.py
"""
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "source"
SHORTS = ROOT / "content" / "shorts"
TRANSLATIONS = ROOT / "content" / "translations"
I18N = ROOT / "content" / "i18n"
FAQ = ROOT / "content" / "faq"
PUBLIC = ROOT / "public"

def load(name):
    return json.loads((SRC / name).read_text(encoding="utf-8-sig"))


JUNK = re.compile(r"not translated|no translation|not a sentence|nothing to fix", re.I)


def usable(s):
    s = s.strip()
    return len(s) >= 20 and not JUNK.search(s)


# Extra languages (French, Spanish, Arabic) are written as plain text, one block per verse:
#   ## <verse>  then  T: translation / S: Short / Q: question / A: answer (two Q/A pairs)
# and chapters.txt has  ## <chapter>  then  M: name meaning / L: TL;DR / four Q/A pairs.
EXTRA_LANGS = ("fr", "es", "ar")
SHORT_MAX_WORDS = 40  # a 30-word English Short runs a little longer in these languages


def parse_blocks(path):
    blocks, cur = {}, None
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        if line.startswith("## "):
            cur = blocks.setdefault(int(line[3:]), {"faq": []})
            continue
        tag, _, text = line.partition(": ")
        text = text.strip()
        if tag == "Q":
            cur["faq"].append({"q": text, "a": ""})
        elif tag == "A":
            cur["faq"][-1]["a"] = text
        else:
            cur[{"T": "tr", "S": "short", "M": "mean", "L": "tldr"}[tag]] = text
    return blocks


def build_extra_lang(lang, by_chapter, data_dir):
    src = I18N / lang
    out = data_dir / lang
    out.mkdir(parents=True, exist_ok=True)
    problems = []
    chapters = parse_blocks(src / "chapters.txt")
    ch_out = []
    for c in range(1, 19):
        x = chapters.get(c, {})
        if not (x.get("mean") and x.get("tldr") and len(x["faq"]) == 4 and all(f["q"] and f["a"] for f in x["faq"])):
            problems.append(f"{lang} chapter {c} intro")
        ch_out.append({"mean": x.get("mean", ""), "tldr": x.get("tldr", ""), "faq": x.get("faq", [])})
    (out / "chapters.json").write_text(json.dumps(ch_out, ensure_ascii=False), encoding="utf-8")
    for c, vs in by_chapter.items():
        path = src / f"ch{c}.txt"
        blocks = parse_blocks(path) if path.exists() else {}
        rows = []
        for v in vs:
            x = blocks.get(v["v"], {"faq": []})
            ok = (usable(x.get("tr", "")) and x.get("short") and len(x["short"].split()) <= SHORT_MAX_WORDS
                  and len(x["faq"]) == 2 and all(f["q"] and f["a"] for f in x["faq"]))
            if not ok:
                problems.append(f"{lang} {c}.{v['v']}")
            rows.append({"tr": x.get("tr", ""), "short": x.get("short", ""), "faq": x["faq"]})
        (out / f"ch{c}.json").write_text(json.dumps(rows, ensure_ascii=False), encoding="utf-8")
    return problems


def main():
    chapters = load("chapters.json")
    verses = load("verse.json")

    # Translations are our own: content/translations/chN.json, {"verse": {"en", "hi"}}.
    ours = {}
    for path in TRANSLATIONS.glob("ch*.json"):
        c = int(path.stem[2:])
        for v, tr in json.loads(path.read_text(encoding="utf-8")).items():
            ours[f"{c}.{v}"] = tr

    by_chapter, missing_tr = {}, []
    for v in verses:
        c = v["chapter_number"]
        key = f"{c}.{v['verse_number']}"
        tr = ours.get(key, {})
        if not (usable(tr.get("en", "")) and usable(tr.get("hi", ""))):
            missing_tr.append(key)
            continue
        by_chapter.setdefault(c, []).append({
            "v": v["verse_number"],
            "sa": re.sub(r"\n\s*\n", "\n", re.sub(r"।।[\d\.\-]+।।", "॥", v["text"])).strip(),
            # 11.19's transliteration field holds Devanagari in the source; show none rather than a repeat.
            "tl": "" if re.search(r"[\u0900-\u097F]", v["transliteration"]) else v["transliteration"].strip(),
            "en": tr["en"].strip(),
            "hi": tr["hi"].strip(),
        })
    if missing_tr:
        raise SystemExit(f"Verses without our own English and Hindi translation: {missing_tr}")

    ch_tldr = json.loads((SHORTS / "chapters.json").read_text(encoding="utf-8"))
    index = [{
        "n": c["chapter_number"], "sa": c["name"], "tl": c["name_transliterated"], "en": c["name_translation"],
        "mean": c["name_meaning"], "count": c["verses_count"],
    } for c in sorted(chapters, key=lambda x: x["chapter_number"])]

    # FAQs: {"en": [{"q", "a"}], "hi": [...]} per chapter and, where written, per verse.
    ch_faq = json.loads((FAQ / "chapters.json").read_text(encoding="utf-8"))
    for c in index:
        c["faq"] = ch_faq.get(str(c["n"]))
    for path in sorted((FAQ / "verses").glob("ch*.json")):
        for key, faq in json.loads(path.read_text(encoding="utf-8")).items():
            c, v = map(int, key.split("."))
            by_chapter[c][v - 1]["faq"] = faq
    for c in index:
        for item in (c["faq"] or {}).get("en", []) + (c["faq"] or {}).get("hi", []):
            if not item["q"].strip() or not item["a"].strip():
                raise SystemExit(f"Empty FAQ entry in chapter {c['n']}")

    shorts = {}
    for c in range(1, 19):
        shorts.update(json.loads((SHORTS / f"ch{c}.json").read_text(encoding="utf-8")))
    over = [(k, lang) for k, v in shorts.items() for lang, s in v.items() if len(s.split()) > 30]
    if over:
        raise SystemExit(f"Shorts over 30 words: {over}")
    missing = [f"{c}.{v['v']}" for c, vs in by_chapter.items() for v in vs if f"{c}.{v['v']}" not in shorts]
    if missing:
        raise SystemExit(f"Verses without Shorts: {missing}")
    no_faq = [f"{c}.{v['v']}" for c, vs in by_chapter.items() for v in vs if "faq" not in v]
    if no_faq:
        raise SystemExit(f"Verses without FAQs: {no_faq}")

    data_dir = PUBLIC / "data"
    data_dir.mkdir(parents=True, exist_ok=True)
    (data_dir / "chapters.json").write_text(json.dumps(index, ensure_ascii=False), encoding="utf-8")
    for c, vs in by_chapter.items():
        (data_dir / f"ch{c}.json").write_text(json.dumps(vs, ensure_ascii=False), encoding="utf-8")
    problems = [p for lang in EXTRA_LANGS for p in build_extra_lang(lang, by_chapter, data_dir)]
    if problems:
        raise SystemExit(f"Missing or incomplete translations ({len(problems)}): {problems[:20]}")
    (PUBLIC / "genz.js").write_text(
        "// Generated by scripts/build_data.py from content/shorts. Do not edit by hand.\n"
        f"window.GENZ_CH={json.dumps(ch_tldr, ensure_ascii=False)};\n"
        f"window.GENZ={json.dumps(shorts, ensure_ascii=False)};\n",
        encoding="utf-8",
    )

    # Compact context for Ask Gita: every verse's English translation (goes in the cached
    # system prompt) plus our own FAQ notes, which the API searches to add per-question context.
    context = {
        "chapters": [{"n": c["n"], "name": c["en"], "meaning": c["mean"], "summary": ch_tldr[str(c["n"])]["en"]} for c in index],
        "verses": [{
            "key": f"{c}.{v['v']}", "en": v["en"], "hi": v["hi"], "short": shorts[f"{c}.{v['v']}"]["en"],
            "notes": " ".join(f"{x['q']} {x['a']}" for x in v["faq"]["en"]),
        } for c in sorted(by_chapter) for v in by_chapter[c]],
    }
    out = ROOT / "data"
    out.mkdir(exist_ok=True)
    (out / "gita-context.json").write_text(json.dumps(context, ensure_ascii=False), encoding="utf-8")
    print(f"Built {sum(len(v) for v in by_chapter.values())} verses, {len(shorts)} Shorts")


if __name__ == "__main__":
    main()
