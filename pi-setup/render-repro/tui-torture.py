#!/usr/bin/env python3
"""
TUI torture test — streams the nastiest possible output to stress pi's renderer.

covers every desync class found during the 2026-07-04 investigation:
- devanagari matras + conjuncts (the class that actually broke Ghostty)
- tamil/bengali spacing marks, arabic, thai
- ZWJ emoji, VS16, flags, skin tones, text-presentation pictographs (🖐 ⚠ ☹)
- zalgo / combining mark storms
- ANSI escape injection (colors, cursor jumps, fake screen clears, DEC modes)
- raw control chars (\r overwrites, backspace, bell, vertical tab, form feed)
- tabs, 2000-char single lines, random-codepoint fuzz across all blocks
- chunk writes split mid-UTF8-multibyte (tests the StringDecoder fix)
- ~8 MB total, bursty timing (tests streaming preview churn)
"""
import random
import sys
import time

w = sys.stdout.buffer
random.seed(1337)

HINDI = "यह एक हिंदी वाक्य है जिसमें संयुक्ताक्षर क्त्र श्र प्र स्त्र हैं और मात्राएँ भी: कि की कु कू के कै को कौ काँ "
EMOJI = "🚀🔥💯🧑‍💻👨‍👩‍👧‍👦🏳️‍🌈❤️⚠️✳️🖐☹⚠🕴🕵🗐 🇺🇸🇯🇵🇮🇳 👍🏽💐🏾x🏻 "
CJK = "日本語のテキストと中文文本が混在している行です 한글과 조합형 자모도 있습니다 "
ARABIC = "هذا نص عربي طويل يمتد على السطر بالكامل مع كلمات كثيرة ومتنوعة "
INDIC2 = "தமிழ் எழுத்துக்கள் বাংলা অক্ষর తెలుగు అక్షరాలు ಕನ್ನಡ ακσαρα "
ZALGO = "z\u0351\u036b\u0343\u036a\u0302a\u0344\u0349\u034dl\u034d\u036bg\u034a\u0349o\u0362\u0327 "
THAI = "ที่นี่มีน้ำและอาหารเต็มไปหมด "
TABS = "col1\tcol2\tcol3\tvery-long-column-value\tanother\tmore\ttabs\t"
ANSI = "\x1b[31mred\x1b[1;42mgreen-bg\x1b[0m \x1b[?25l\x1b[?1049h fake-altscreen \x1b[2J\x1b[H fake-clear \x1b[999;999H cursor-jump \x1b]0;title\x07 "
CTRL = "bell\x07 backspace\x08\x08\x08 carriage\rOVERWRITTEN vtab\x0b formfeed\x0c null\x00 esc-alone\x1b done "

PHASES = [HINDI, EMOJI, CJK, ARABIC, INDIC2, ZALGO, THAI, TABS, ANSI, CTRL]


def fuzz(n: int) -> str:
    out = []
    for _ in range(n):
        r = random.random()
        if r < 0.30:
            cp = random.randint(0x20, 0x7E)          # ascii
        elif r < 0.50:
            cp = random.randint(0x0900, 0x0D7F)      # indic sweep
        elif r < 0.60:
            cp = random.randint(0x0600, 0x06FF)      # arabic
        elif r < 0.70:
            cp = random.randint(0x4E00, 0x9FFF)      # cjk
        elif r < 0.85:
            cp = random.randint(0x1F000, 0x1FAFF)    # emoji/symbols SMP
        elif r < 0.95:
            cp = random.randint(0x0300, 0x036F)      # combining storm
        else:
            cp = random.randint(0x1000, 0xD000)      # anything BMP
        if 0xD800 <= cp <= 0xDFFF:
            cp = 0x41
        out.append(chr(cp))
    return "".join(out)


def chunked_write(data: bytes) -> None:
    """write in random 1-97 byte chunks — deliberately splits multibyte chars"""
    i = 0
    while i < len(data):
        j = i + random.randint(1, 97)
        w.write(data[i:j])
        i = j


total = 0
t0 = time.time()
N = 5000
for i in range(N):
    base = PHASES[i % len(PHASES)]
    reps = (base * 60)[: random.randint(60, 2200)]
    line = f"[{i:05d}] {reps} | fuzz: {fuzz(random.randint(10, 500))}\n"
    b = line.encode("utf-8")
    total += len(b)
    chunked_write(b)
    if i % 37 == 0:
        w.flush()
        time.sleep(0.004)  # bursty streaming — forces many preview re-renders
    if i % 500 == 0:
        w.flush()
        print(f"\n===== checkpoint {i}/{N} — {total/1e6:.1f} MB so far =====\n",
              flush=True)

w.flush()
print(f"\nDONE: {N} lines, {total/1e6:.1f} MB in {time.time()-t0:.1f}s — "
      f"if the screen above is not smeared, the fix holds", flush=True)
