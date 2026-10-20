"""Compare what was read with what the speech recognizer heard, word by word.

Both sides are turned into the same tokens first: lower case, no punctuation, and numbers as digits whichever way they
were written ("nineteen fifty-nine", "1959" -> "#1959"), so only real differences count.
"""
import difflib
import re

UNITS = {w: i for i, w in enumerate("zero one two three four five six seven eight nine ten eleven twelve thirteen "
                                    "fourteen fifteen sixteen seventeen eighteen nineteen".split())}
TENS = {w: 10 * i for i, w in enumerate("twenty thirty forty fifty sixty seventy eighty ninety".split(), 2)}
# "second" is left out on purpose: it is far more often the time unit ("twenty seconds") than the ordinal
ORDINALS = {"first": 1, "third": 3, "fourth": 4, "fifth": 5, "sixth": 6, "seventh": 7, "eighth": 8,
            "ninth": 9, "tenth": 10, "eleventh": 11, "twelfth": 12, "thirteenth": 13, "fourteenth": 14, "fifteenth": 15,
            "sixteenth": 16, "seventeenth": 17, "eighteenth": 18, "nineteenth": 19, "twentieth": 20, "thirtieth": 30,
            "fortieth": 40, "fiftieth": 50, "sixtieth": 60, "seventieth": 70, "eightieth": 80, "ninetieth": 90}
SCALES = {"hundred": 100, "thousand": 1000, "million": 10 ** 6, "billion": 10 ** 9, "trillion": 10 ** 12}

# words that are the same thing said two ways (script spelling / whisper spelling), or that whisper drops
SAME = {"it's": "its", "percent": "", "%": "", "dollars": "", "dollar": "",
        "fahrenheit": "f", "degrees": "", "okay": "ok", "a.i": "ai",
        # British spelling in the text; whisper small.en writes American
        "kilometres": "kilometers", "metres": "meters", "litres": "liters", "centimetres": "centimeters", "grey": "gray",
        "colour": "color", "colours": "colors", "plough": "plow", "ploughs": "plows", "centre": "center", "programme": "program",
        "favourite": "favorite", "aluminium": "aluminum", "travelled": "traveled", "travelling": "traveling", "fibre": "fiber",
        "theatre": "theater", "defence": "defense", "licence": "license", "neighbour": "neighbor", "honour": "honor",
        "behaviour": "behavior", "catalogue": "catalog", "organise": "organize", "realise": "realize", "recognise": "recognize",
        "analyse": "analyze", "manoeuvre": "maneuver", "sulphur": "sulfur", "practise": "practice", "mould": "mold", "storey": "story"}


def _is_digits(tok):
    return re.fullmatch(r"\d+(?:[.,]\d+)*(?:st|nd|rd|th)?", tok) is not None


def _numeric(tok):
    return tok in UNITS or tok in TENS or tok in ORDINALS or tok in SCALES or _is_digits(tok)


def _compose(run):
    """A run of number tokens (words or digits) as one canonical digit string.

    "sixty eight" -> 68, "nineteen eighty six" -> 1986, "twenty twenty four" -> 2024, "three thirty" -> 330,
    "a hundred and fifty thousand" -> 150000, "one point three million" -> 1300000, "twenty first" -> 21,
    and the same strings from whisper's digits ("68", "1986", "2024", "3:30" -> "3","30", "150,000", "1.3 million", "21st").
    Juxtaposed groups (year, clock time) are concatenated; groups after the first are zero-padded to two digits.
    """
    groups, cur, total, frac, prev = [], 0, 0, None, None   # prev: kind of the last number word

    def fold():
        """Fold the digits heard after "point" into the current number: "one point three" -> 1.3."""
        nonlocal cur, frac
        if frac:
            cur = float(f"{int(cur)}.{frac}")
        frac = None

    for tok in run:
        if tok in ("a", "and"):
            if tok == "a":
                cur, prev = 1, "unit"
            continue
        if tok == "point":
            frac = ""
            continue
        if _is_digits(tok):
            v = re.sub(r"(st|nd|rd|th)$", "", tok).replace(",", "")
            if re.fullmatch(r"\d{1,2}\.[0-5]\d", v):      # whisper writes "three-thirty" as "3.30": a clock time, not 3.3
                v = v.replace(".", "")
            v = float(v) if "." in v else int(v)
            kind = "digits"
        elif tok in SCALES:
            fold()
            m = SCALES[tok]
            if m == 100:
                cur = (cur or 1) * 100
            else:
                total += (cur or 1) * m
                cur = 0
            prev = "scale"
            continue
        else:
            v = UNITS.get(tok, TENS.get(tok, ORDINALS.get(tok)))
            kind = "tens" if tok in TENS else "unit"
        if frac is not None:                       # digits after "point"
            frac += str(v)
            continue
        # a new juxtaposed group when a number follows a number that cannot combine with it (19 | 86, 20 | 24, 3 | 30)
        if prev in ("unit", "tens", "digits") and not (prev == "tens" and kind == "unit" and v < 10):
            groups.append(total + cur)
            total, cur = 0, 0
        cur += v
        prev = kind
    fold()
    groups.append(total + cur)
    if len(groups) == 1:
        v = groups[0]
        return f"{v:.6f}".rstrip("0").rstrip(".") if isinstance(v, float) and v != int(v) else str(int(v))
    out = str(int(groups[0]))
    for g in groups[1:]:
        out += f"{int(g):02d}"
    return out


def toks(s):
    """Lower-case word tokens; runs of number words or digits become one '#digits' token."""
    s = s.lower().replace("’", "'").replace("-", " ").replace(":", " ")
    raw = re.findall(r"\d+(?:[.,]\d+)*(?:st|nd|rd|th)?|[a-z][a-z'.]*", s)
    words = []
    for w in raw:
        w = w.strip("'.")                                  # quote marks and full stops stuck to a word ('pancake')
        if w.endswith("'s") and not _numeric(w[:-2]):
            w = w[:-2]
        w = SAME.get(w, w)
        if w and not _numeric(w) and w.endswith("s"):      # "eighteens" / whisper "18s", "nineties" / "90s", "hundreds"
            stem = w[:-1]
            if stem.endswith("ie") and stem[:-2] + "y" in TENS:
                stem = stem[:-2] + "y"
            if stem in UNITS or stem in TENS or stem in SCALES or _is_digits(stem):   # not ordinals: "thirds", "fifths" are words
                words += [stem, "s"]
                continue
        if w:
            words.append(w)
    out, i = [], 0
    while i < len(words):
        w = words[i]
        nxt = words[i + 1] if i + 1 < len(words) else ""
        starts = _numeric(w) or (w == "a" and nxt in SCALES)
        if not starts:
            out.append(w)
            i += 1
            continue
        run = []
        while i < len(words):
            w, nxt = words[i], (words[i + 1] if i + 1 < len(words) else "")
            if _numeric(w) or (w == "a" and nxt in SCALES and not run) \
                    or (w == "and" and run and _numeric(nxt)) or (w == "point" and run and (nxt in UNITS or _is_digits(nxt))):
                run.append(w)
                i += 1
            else:
                break
        out.append("#" + _compose(run))
    return out


def diff_ops(a, b):
    """Opcodes where the two token lists really differ (joined spellings like 'light day' / 'lightday' are not differences)."""
    return [op for op in difflib.SequenceMatcher(None, a, b, autojunk=False).get_opcodes()
            if op[0] != "equal" and "".join(a[op[1]:op[2]]) != "".join(b[op[3]:op[4]])]



def pair_up(xs, ys, floor=0.4):
    """{index in xs: index in ys}: an in-order pairing that maximises how alike the paired words are
    (difflib ratio; pairs below floor are not made)."""
    sim = [[difflib.SequenceMatcher(None, x, y).ratio() for y in ys] for x in xs]
    best = [[0.0] * (len(ys) + 1) for _ in range(len(xs) + 1)]
    for i in range(len(xs) - 1, -1, -1):
        for j in range(len(ys) - 1, -1, -1):
            take = sim[i][j] + best[i + 1][j + 1] if sim[i][j] >= floor else -1
            best[i][j] = max(take, best[i + 1][j], best[i][j + 1])
    out, i, j = {}, 0, 0
    while i < len(xs) and j < len(ys):
        if sim[i][j] >= floor and best[i][j] == sim[i][j] + best[i + 1][j + 1]:
            out[i] = j
            i, j = i + 1, j + 1
        elif best[i][j] == best[i + 1][j]:
            i += 1
        else:
            j += 1
    return out


def heard_words(text, heard):
    """For each script word: None if whisper heard it, else what it heard instead ("" = nothing).
    Plus the extra words whisper heard after each script word."""
    sw = text.split()
    # which script word owns each token: numbers spelled over several words become one token ("nineteen fifty-nine")
    owner, n = [], 0
    for k in range(len(sw)):
        m = len(toks(" ".join(sw[:k + 1])))
        owner += [k] * (m - n)
        n = max(n, m)
    a, b = toks(text), toks(heard)
    wrong, extra = [None] * len(sw), [""] * len(sw)
    for op, i1, i2, j1, j2 in diff_ops(a, b):
        said = " ".join(b[j1:j2]).replace("#", "")
        if op == "insert":
            k = owner[i1 - 1] if i1 else 0
            extra[k] = (extra[k] + " " + said).strip()
            continue
        if op == "delete":
            for i in range(i1, i2):
                wrong[owner[i]] = ""
            continue
        # a replaced stretch: pair each script token with the heard token that sounds most like it, in order
        # ("suite of about two hundred tests" heard as "suit": only "suite" gets "suit", the rest were not heard)
        pairs = pair_up(a[i1:i2], b[j1:j2])
        for i in range(i1, i2):
            k = owner[i]
            j = pairs.get(i - i1)
            heard_as = b[j1 + j].replace("#", "") if j is not None else ""
            wrong[k] = (wrong[k] + " " + heard_as).strip() if wrong[k] else heard_as
        paired = set(pairs.values())
        for j in range(j2 - j1):
            if j not in paired:      # heard but matching no script word: an extra after the word before it
                before = [i for i, jj in pairs.items() if jj < j]
                k = owner[i1 + max(before)] if before else (owner[i1 - 1] if i1 else owner[i1])
                extra[k] = (extra[k] + " " + b[j1 + j].replace("#", "")).strip()
    # words that own no token of their own share the verdict of the word before (the "fifty-nine" of "nineteen fifty-nine")
    owned = set(owner)
    for k in range(1, len(sw)):
        if k not in owned:
            wrong[k] = wrong[k - 1]
    return wrong, extra


def judge(text, heard, mine, ref):
    """Per-word verdicts: good, unclear (amber) or wrong (red)."""
    wrong, extra = heard_words(text, heard)
    words = []
    for k, w in enumerate(text.split()):
        s, r = mine[k]["score"], (ref[k]["score"] if ref else None)
        status = "good"
        if wrong[k] is not None:
            status = "wrong"
        elif s is not None:
            if r is not None and s < 0.75 and r - s > 0.2:
                status = "unclear"
            elif r is None and s < 0.5:
                status = "unclear"
        words.append({"w": w, "t": mine[k]["t"], "score": s, "ref": r, "status": status,
                      "heard": wrong[k], "extra": extra[k]})
    return words
