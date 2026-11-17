#!/usr/bin/env python3
# Image checks + slab composition for the news cards image policy (images/policy.js).
# Run isolated so the pip numpy in /usr/local cannot shadow the apt OpenCV build:
#   python3 -I -S images/inspect.py inspect <file>          -> JSON {width, height, faces, watermark: [tokens]}
#   python3 -I -S images/inspect.py slab <in> <out> [name] [grade] -> card whole inside a slab frame, 4:5, no crop;
#                                                             label shows the card name and the real grade (or none)
#   python3 -I -S images/inspect.py web <file>              -> inspect + blur (Laplacian variance) + text_ratio (OCR word area)
#   python3 -I -S images/inspect.py thumb <in> <out> [long]  -> JPEG copy for the vision model (default 1024 px long side)
#   python3 -I -S images/inspect.py crop <in> <out> x0 y0 x1 y1 <aspect|object>
#        subject bbox (0..1) centered in the largest crop of that aspect (w/h); "object" = tight crop around the
#        bbox with padding. Downscale only, never upscale or stretch.
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


def blur(path):
    # Sharpness = Laplacian variance per tile on a 1000 px copy; the score is the mean of the sharpest quarter of the tiles,
    # so a sharp slab on a plain studio background is not called blurry because of its empty background.
    import cv2
    img = cv2.imread(path, cv2.IMREAD_GRAYSCALE)
    if img is None:
        return -1
    h, w = img.shape
    s = 1000.0 / max(h, w)
    img = cv2.resize(img, (max(1, int(w * s)), max(1, int(h * s))), interpolation=cv2.INTER_AREA)
    h, w = img.shape
    vals = []
    for ty in range(4):
        for tx in range(4):
            t = img[ty * h // 4:(ty + 1) * h // 4, tx * w // 4:(tx + 1) * w // 4]
            if t.size:
                vals.append(float(cv2.Laplacian(t, cv2.CV_64F).var()))
    vals.sort(reverse=True)
    top = vals[:max(1, len(vals) // 4)]
    return round(sum(top) / len(top), 1)


def text_ratio(path):
    # Share of the image covered by OCR'd words (confidence >= 60, 2+ characters). Screenshots, tweets and text graphics
    # score high; a photographed card with its small attack text scores low.
    from PIL import Image
    import tempfile, os
    with Image.open(path) as im:
        im = im.convert("RGB")
        s = min(1.0, 1600.0 / max(im.size))
        if s < 1.0:
            im = im.resize((int(im.width * s), int(im.height * s)))
        W, H = im.size
        fd, tmp = tempfile.mkstemp(suffix=".png")
        os.close(fd)
        im.save(tmp)
    try:
        out = subprocess.run(["tesseract", tmp, "stdout", "--psm", "11", "-l", "eng", "tsv"], capture_output=True, text=True, timeout=60).stdout
    except Exception:
        return -1
    finally:
        os.remove(tmp)
    area = 0
    for line in out.splitlines()[1:]:
        c = line.split("\t")
        if len(c) < 12:
            continue
        try:
            conf = float(c[10])
        except ValueError:
            continue
        if conf >= 60 and len(c[11].strip()) >= 2:
            area += int(c[8]) * int(c[9])
    return round(area / float(W * H), 3)


def web(path):
    r = inspect(path)
    r["blur"] = blur(path)
    r["text_ratio"] = text_ratio(path)
    return r


def thumb(src, out, long=1024):
    from PIL import Image
    with Image.open(src) as im:
        im = im.convert("RGB")
        im.thumbnail((long, long), Image.LANCZOS)
        im.save(out, "JPEG", quality=85)
        return {"ok": True, "width": im.width, "height": im.height}


def crop(src, out, x0, y0, x1, y1, aspect, max_long=1800):
    from PIL import Image
    with Image.open(src) as im:
        im = im.convert("RGB")
        W, H = im.size
        bx0, by0, bx1, by1 = [max(0.0, min(1.0, float(v))) for v in (x0, y0, x1, y1)]
        if bx1 <= bx0 or by1 <= by0:
            bx0, by0, bx1, by1 = 0.0, 0.0, 1.0, 1.0
        cx, cy = (bx0 + bx1) / 2 * W, (by0 + by1) / 2 * H
        if aspect == "object":
            pw, ph = (bx1 - bx0) * W * 0.08, (by1 - by0) * H * 0.08
            box = [max(0, bx0 * W - pw), max(0, by0 * H - ph), min(W, bx1 * W + pw), min(H, by1 * H + ph)]
        else:
            a = float(aspect)
            cw, ch = (W, W / a) if W / a <= H else (H * a, H)
            left = min(max(0, cx - cw / 2), W - cw)
            top = min(max(0, cy - ch / 2), H - ch)
            box = [left, top, left + cw, top + ch]
        c = im.crop(tuple(int(round(v)) for v in box))
        if max(c.size) > max_long:
            c.thumbnail((max_long, max_long), Image.LANCZOS)
        c.save(out, "PNG")
        return {"ok": True, "width": c.width, "height": c.height, "box": [int(v) for v in box], "subject_center": [round(cx / W, 3), round(cy / H, 3)]}


def slab(src, out, name="", grade="", W=1200, H=1500):
    from PIL import Image, ImageDraw, ImageFont
    card = Image.open(src).convert("RGBA")
    # Transparent background: the card template lays the slab on its own pattern, sized above the headline.
    bg = Image.new("RGBA", (W, H), (0, 0, 0, 0))
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
    # Label: card name left, the real grade from the story right (no grade = name only). No grader logo or branding.
    import os
    fd = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "assets", "fonts")
    def font(f, size):
        try:
            return ImageFont.truetype(os.path.join(fd, f), size)
        except Exception:
            return ImageFont.load_default()
    lx0, ly0, lx1, ly1 = sx + 18, sy + 18, sx + sw - 18, sy + 18 + lh
    if grade:
        fg = font("Inter-Bold.ttf", int(lh * 0.42))
        gw = d.textlength(grade, font=fg)
        d.text((lx1 - 22 - gw, (ly0 + ly1) / 2), grade, font=fg, fill=(232, 180, 58, 255), anchor="lm")
        room = lx1 - lx0 - gw - 66
    else:
        room = lx1 - lx0 - 44
    if name:
        fn = font("Inter-Medium.ttf", int(lh * 0.24))
        txt = name
        while txt and d.textlength(txt, font=fn) > room:
            txt = txt[:-1]
        if txt != name:
            txt = txt.rstrip()[:-1] + "…"
        d.text((lx0 + 22, (ly0 + ly1) / 2), txt, font=fn, fill=(240, 236, 228, 255), anchor="lm")
    bg.alpha_composite(layer)
    bg.alpha_composite(card, (cx, cy))
    box = bg.getbbox() or (0, 0, W, H)
    bg = bg.crop((max(0, box[0] - 8), max(0, box[1] - 8), min(W, box[2] + 8), min(H, box[3] + 8)))
    bg.save(out, "PNG")
    return {"ok": True, "width": bg.width, "height": bg.height}


if __name__ == "__main__":
    mode = sys.argv[1] if len(sys.argv) > 1 else ""
    try:
        if mode == "inspect":
            r = inspect(sys.argv[2])
        elif mode == "slab":
            r = slab(sys.argv[2], sys.argv[3], *(sys.argv[4:6]))
        elif mode == "web":
            r = web(sys.argv[2])
        elif mode == "thumb":
            r = thumb(sys.argv[2], sys.argv[3], int(sys.argv[4]) if len(sys.argv) > 4 else 1024)
        elif mode == "crop":
            r = crop(sys.argv[2], sys.argv[3], *sys.argv[4:9])
        else:
            r = {"error": "mode inspect|slab|web|thumb|crop"}
    except Exception as e:
        r = {"error": str(e)[:200]}
    print(json.dumps(r))
