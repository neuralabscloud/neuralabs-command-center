#!/usr/bin/env python3
# Image checks + slab composition for the news cards image policy (images/policy.js).
# Run isolated so the pip numpy in /usr/local cannot shadow the apt OpenCV build:
#   python3 -I -S images/inspect.py inspect <file>          -> JSON {width, height, faces, watermark: [tokens]}
#   python3 -I -S images/inspect.py slab <in> <out>         -> card image whole inside a slab frame, 4:5, no crop
import sys
sys.path.insert(0, "/usr/lib/python3/dist-packages")
import json, re, subprocess

CASCADES = ["/usr/share/opencv4/haarcascades/haarcascade_frontalface_default.xml",
            "/usr/share/opencv4/haarcascades/haarcascade_profileface.xml"]
# Watermark / credit text. A card's own copyright line (c Pokemon/Nintendo) is not a watermark.
WATERMARK = re.compile(r"(getty|shutterstock|alamy|istock|dreamstime|depositphotos|123rf|adobe ?stock|watermark|"
                       r"\bsample\b|\bpreview\b|photo ?by|photograph(ed)? by|image ?credit|\bcredit\b|"
                       r"@[a-z0-9_]{3,}|\b[a-z0-9-]{3,}\.(com|net|org|io|co|tv|gg|xyz)\b)", re.I)


def faces(path):
    import cv2
    img = cv2.imread(path)
    if img is None:
        return -1
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    h, w = gray.shape
    scale = 1200.0 / max(h, w) if max(h, w) > 1200 else 1.0
    if scale != 1.0:
        gray = cv2.resize(gray, (int(w * scale), int(h * scale)))
    gray = cv2.equalizeHist(gray)
    side = max(40, int(min(gray.shape) * 0.07))
    n = 0
    # OpenCV res10 SSD (CNN; catches profiles and sunglasses that Haar misses). Model files next to this script.
    import os
    md = os.path.join(os.path.dirname(os.path.abspath(__file__)), "models")
    proto, weights = os.path.join(md, "deploy.prototxt"), os.path.join(md, "res10_300x300_ssd_iter_140000.caffemodel")
    if os.path.exists(proto) and os.path.exists(weights):
        net = cv2.dnn.readNetFromCaffe(proto, weights)
        H0, W0 = img.shape[:2]
        found = 0
        # Square tiles at two scales (full short side and half of it), 50% overlap, so small faces in tall images count.
        for t in (min(H0, W0), max(160, min(H0, W0) // 2)):
            step = max(1, t // 2)
            for y in list(range(0, max(1, H0 - t + 1), step)) + [max(0, H0 - t)]:
                for x in list(range(0, max(1, W0 - t + 1), step)) + [max(0, W0 - t)]:
                    tile = img[y:y + t, x:x + t]
                    net.setInput(cv2.dnn.blobFromImage(cv2.resize(tile, (300, 300)), 1.0, (300, 300), (104.0, 177.0, 123.0)))
                    found += int((net.forward()[0, 0, :, 2] > 0.6).sum())
        n += found
    for c in CASCADES:
        det = cv2.CascadeClassifier(c)
        found = det.detectMultiScale(gray, scaleFactor=1.1, minNeighbors=7, minSize=(side, side))
        n += len(found)
    return n


def ocr_tokens(path):
    try:
        out = subprocess.run(["tesseract", path, "stdout", "--psm", "11", "-l", "eng"], capture_output=True, text=True, timeout=60).stdout
    except Exception:
        return ["ocr-fout"]
    return sorted(set(m.group(0).lower() for m in WATERMARK.finditer(out)))[:10]


def inspect(path):
    from PIL import Image
    with Image.open(path) as im:
        w, h = im.size
    return {"width": w, "height": h, "faces": faces(path), "watermark": ocr_tokens(path)}


def slab(src, out, W=1200, H=1500):
    from PIL import Image, ImageDraw
    card = Image.open(src).convert("RGBA")
    bg = Image.new("RGBA", (W, H), (20, 20, 22, 255))
    layer = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    # Slab case in the upper part (headline and labels sit over the lower part of the zone).
    sh = int(H * 0.60); sw = int(sh * 0.62)
    sx = (W - sw) // 2; sy = int(H * 0.07)
    d.rounded_rectangle([sx, sy, sx + sw, sy + sh], radius=26, fill=(255, 255, 255, 22), outline=(205, 210, 218, 190), width=4)
    lh = int(sh * 0.16)
    d.rounded_rectangle([sx + 18, sy + 18, sx + sw - 18, sy + 18 + lh], radius=12, fill=(29, 29, 33, 255), outline=(232, 180, 58, 230), width=3)
    # Window: the whole card, aspect kept, never cropped to the artwork.
    wx0, wy0 = sx + 30, sy + 18 + lh + 22
    ww, wh = sw - 60, sh - (18 + lh + 22) - 30
    card.thumbnail((ww, wh), Image.LANCZOS)
    cx = wx0 + (ww - card.width) // 2; cy = wy0 + (wh - card.height) // 2
    d.rounded_rectangle([wx0 - 6, wy0 - 6, wx0 + ww + 6, wy0 + wh + 6], radius=14, outline=(205, 210, 218, 90), width=2)
    bg.alpha_composite(layer)
    bg.alpha_composite(card, (cx, cy))
    bg.convert("RGB").save(out, "PNG")
    return {"ok": True, "width": W, "height": H}


if __name__ == "__main__":
    mode = sys.argv[1] if len(sys.argv) > 1 else ""
    try:
        if mode == "inspect":
            r = inspect(sys.argv[2])
        elif mode == "slab":
            r = slab(sys.argv[2], sys.argv[3])
        else:
            r = {"error": "mode inspect|slab"}
    except Exception as e:
        r = {"error": str(e)[:200]}
    print(json.dumps(r))
