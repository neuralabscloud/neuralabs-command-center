"""Slab cutout for vault posts: background removed (rembg), cropped to the slab itself.

Usage: /root/rembg-env/venv/bin/python -I images/slab_cutout.py <in> <out.png>
Prints one JSON line: {ok, method, w, h, aspect} or {ok:false, error}.

rembg gives the foreground mask (slab plus whatever it stands on, e.g. the Courtyard stand).
A slab is a rigid upright rectangle, so we keep the rows whose mask width matches the slab
body and the columns covered in those rows. Inside that box the alpha is solid (clear
plastic must not turn see-through); the outer edge keeps the mask, so rounded corners stay.
Model files live in U2NET_HOME (default /root/rembg-env/models), no download at run time.
"""
import json
import os
import sys

os.environ.setdefault("U2NET_HOME", "/root/rembg-env/models")
os.environ.setdefault("NUMBA_CACHE_DIR", "/tmp")
import numpy as np  # noqa: E402
from PIL import Image  # noqa: E402
from scipy import ndimage  # noqa: E402

MODEL = os.environ.get("SLAB_REMBG_MODEL", "isnet-general-use")


def slab_box(mask):
    lab, n = ndimage.label(mask)
    if n == 0:
        return None
    sizes = ndimage.sum(mask, lab, range(1, n + 1))
    comp = lab == (int(np.argmax(sizes)) + 1)
    rows = np.where(comp.any(axis=1))[0]
    top, bot = rows[0], rows[-1]
    widths = comp.sum(axis=1)
    ref = int(top + (bot - top) * 0.35)
    w0 = np.median(widths[max(top, ref - 5):ref + 6])
    ok = (widths >= 0.8 * w0) & (widths <= 1.15 * w0)
    # Walk up and down from the reference row, tolerating short gaps (glare, label edge).
    def walk(step):
        r, last, gap = ref, ref, 0
        while top <= r + step <= bot:
            r += step
            if ok[r]:
                last, gap = r, 0
            else:
                gap += 1
                if gap > 6:
                    break
        return last
    y0, y1 = walk(-1), walk(1)
    band = comp[y0:y1 + 1]
    cols = np.where(band.mean(axis=0) >= 0.5)[0]
    if not len(cols):
        return None
    return int(cols[0]), int(y0), int(cols[-1]), int(y1), comp


def plain_border_mask(img):
    """Tight vault photos (Collector Crypt): the slab fills the frame on a plain dark ground.
    rembg sees the clear case as background there, so cut on the ground colour instead."""
    a = np.array(img).astype(np.int16)
    h, w, _ = a.shape
    k = max(4, min(h, w) // 40)
    edge = np.concatenate([a[:k].reshape(-1, 3), a[-k:].reshape(-1, 3), a[:, :k].reshape(-1, 3), a[:, -k:].reshape(-1, 3)])
    ground = np.median(edge, axis=0)
    if np.percentile(np.abs(edge - ground).max(axis=1), 90) > 18:
        return None  # busy background: leave it to rembg
    diff = np.abs(a - ground).max(axis=2) > 28
    diff = ndimage.binary_closing(diff, iterations=3)
    return ndimage.binary_fill_holes(diff).astype(np.uint8) * 255


def main(src, out):
    img = Image.open(src).convert("RGB")
    if max(img.size) > 1600:
        img.thumbnail((1600, 1600))
    method = "ground-colour"
    mask = plain_border_mask(img)
    box = slab_box(mask > 128) if mask is not None else None
    if box and not (1.4 <= (box[3] - box[1] + 1) / (box[2] - box[0] + 1) <= 2.0):
        box = None
    if not box:
        from rembg import new_session, remove
        method = f"rembg:{MODEL}"
        mask = np.array(remove(img, session=new_session(MODEL), only_mask=True).convert("L"))
        box = slab_box(mask > 128)
    if box and not (1.4 <= (box[3] - box[1] + 1) / (box[2] - box[0] + 1) <= 2.0):
        box = None
    if not box and 1.4 <= img.size[1] / img.size[0] <= 2.0:
        # Photo is already cropped tight to the slab (slab fills the frame): keep it whole,
        # the corners are rounded in the template.
        method = "tight-crop"
        w, h = img.size
        box = (0, 0, w - 1, h - 1, np.ones((h, w), bool))
        mask = np.full((h, w), 255, np.uint8)
    if not box:
        print(json.dumps({"ok": False, "error": "no slab-shaped foreground found"}))
        return 2
    x0, y0, x1, y1, comp = box
    w, h = x1 - x0 + 1, y1 - y0 + 1
    aspect = h / w
    if not (1.4 <= aspect <= 2.0) or w < 200:
        print(json.dumps({"ok": False, "error": f"cutout is not slab-shaped ({w}x{h}, aspect {aspect:.2f})"}))
        return 2
    rgb = np.array(img)[y0:y1 + 1, x0:x1 + 1]
    alpha = mask[y0:y1 + 1, x0:x1 + 1].astype(np.uint8)
    inset = max(4, int(min(w, h) * 0.04))
    alpha[inset:-inset, inset:-inset] = 255
    alpha = np.where(comp[y0:y1 + 1, x0:x1 + 1], np.maximum(alpha, 0), 0).astype(np.uint8)
    alpha[inset:-inset, inset:-inset] = 255
    Image.fromarray(np.dstack([rgb, alpha]), "RGBA").save(out, optimize=True)
    print(json.dumps({"ok": True, "method": method, "w": w, "h": h, "aspect": round(aspect, 3)}))
    return 0


if __name__ == "__main__":
    if len(sys.argv) != 3:
        print(json.dumps({"ok": False, "error": "usage: slab_cutout.py <in> <out.png>"}))
        sys.exit(64)
    try:
        sys.exit(main(sys.argv[1], sys.argv[2]))
    except Exception as e:  # noqa: BLE001
        print(json.dumps({"ok": False, "error": str(e)[:300]}))
        sys.exit(1)
