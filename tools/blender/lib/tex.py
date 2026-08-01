"""Procedural texture generation.

Blender's bundled Python has numpy but no PIL, and Blender's own image saving
runs through colour management.  So textures are drawn into a numpy RGBA
buffer and written out as PNG by hand (zlib + CRC).  That gives byte-exact,
colour-managed-free output which we then load back as an sRGB image -- what we
draw is exactly what ends up in the .glb.

Coordinates are y-up (y=0 is the bottom of the image, matching UV v=0);
`write_png` flips on the way out.
"""

import os
import struct
import zlib

import bpy
import numpy as np


# ---------------------------------------------------------------------------
# PNG output
# ---------------------------------------------------------------------------

def write_png(path, rgba_u8, flip=True):
    arr = np.ascontiguousarray(rgba_u8[::-1] if flip else rgba_u8)
    h, w = arr.shape[:2]
    raw = bytearray()
    stride = w * 4
    flat = arr.reshape(h, stride)
    for y in range(h):
        raw.append(0)
        raw += flat[y].tobytes()

    def chunk(tag, data):
        return (struct.pack(">I", len(data)) + tag + data
                + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF))

    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as fh:
        fh.write(b"\x89PNG\r\n\x1a\n")
        fh.write(chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0)))
        fh.write(chunk(b"IDAT", zlib.compress(bytes(raw), 9)))
        fh.write(chunk(b"IEND", b""))
    return path


def load_image(path, name=None, is_data=False):
    img = bpy.data.images.load(path, check_existing=True)
    if name:
        img.name = name
    try:
        img.colorspace_settings.name = "Non-Color" if is_data else "sRGB"
    except Exception:
        pass
    img.alpha_mode = "STRAIGHT"
    return img


# ---------------------------------------------------------------------------
# drawing canvas
# ---------------------------------------------------------------------------

class Canvas:
    """Float RGBA canvas with straight-alpha "over" compositing."""

    def __init__(self, w, h, bg=(0.0, 0.0, 0.0, 0.0)):
        self.w, self.h = int(w), int(h)
        self.buf = np.zeros((self.h, self.w, 4), np.float32)
        self.buf[..., :] = bg

    # -- internals ------------------------------------------------------
    def _region(self, x0, y0, x1, y1, pad=2):
        x0 = max(0, int(np.floor(x0 - pad)))
        y0 = max(0, int(np.floor(y0 - pad)))
        x1 = min(self.w, int(np.ceil(x1 + pad)))
        y1 = min(self.h, int(np.ceil(y1 + pad)))
        if x1 <= x0 or y1 <= y0:
            return None
        ys, xs = np.mgrid[y0:y1, x0:x1]
        return x0, y0, x1, y1, xs.astype(np.float32) + 0.5, ys.astype(np.float32) + 0.5

    def _composite(self, box, alpha, color):
        x0, y0, x1, y1 = box
        a = np.clip(alpha, 0.0, 1.0)[..., None]
        col = np.asarray(color, np.float32)[:3]
        dst = self.buf[y0:y1, x0:x1]
        dst_a = dst[..., 3:4]
        out_a = a + dst_a * (1.0 - a)
        safe = np.maximum(out_a, 1e-6)
        dst[..., :3] = (col * a + dst[..., :3] * dst_a * (1.0 - a)) / safe
        dst[..., 3:4] = out_a

    # -- primitives -----------------------------------------------------
    def capsule(self, a, b, r0, r1=None, color=(0, 0, 0), feather=0.9,
                alpha=1.0):
        """Tapered round-ended stroke: needles, twigs, stems, wires."""
        r1 = r0 if r1 is None else r1
        ax, ay = float(a[0]), float(a[1])
        bx, by = float(b[0]), float(b[1])
        rmax = max(r0, r1)
        reg = self._region(min(ax, bx) - rmax, min(ay, by) - rmax,
                           max(ax, bx) + rmax, max(ay, by) + rmax,
                           pad=feather + 2)
        if reg is None:
            return self
        x0, y0, x1, y1, X, Y = reg
        abx, aby = bx - ax, by - ay
        l2 = abx * abx + aby * aby
        if l2 < 1e-9:
            t = np.zeros_like(X)
        else:
            t = np.clip(((X - ax) * abx + (Y - ay) * aby) / l2, 0.0, 1.0)
        cx, cy = ax + t * abx, ay + t * aby
        d = np.hypot(X - cx, Y - cy)
        r = r0 + (r1 - r0) * t
        cov = np.clip((r - d) / max(feather, 1e-3) + 0.5, 0.0, 1.0) * alpha
        self._composite((x0, y0, x1, y1), cov, color)
        return self

    def leaf(self, center, length, width, angle, color, feather=0.9,
             tip=0.55, base=0.85, alpha=1.0, midrib=None):
        """Ovate leaf blade, pointed at the tip, rounded at the base."""
        cx, cy = float(center[0]), float(center[1])
        rad = max(length, width)
        reg = self._region(cx - rad, cy - rad, cx + rad, cy + rad, pad=feather + 2)
        if reg is None:
            return self
        x0, y0, x1, y1, X, Y = reg
        ca, sa = np.cos(-angle), np.sin(-angle)
        dx, dy = X - cx, Y - cy
        px = dx * ca - dy * sa
        py = dx * sa + dy * ca
        s = np.clip(px / (length * 0.5), -1.0, 1.0)
        # asymmetric half-width profile: fat near base, tapering to a point
        u = (1.0 - s) * 0.5           # 1 at base, 0 at tip
        prof = np.power(np.clip(u, 0, 1), tip) * np.power(np.clip(1.0 - u, 0, 1), 1.0 - base)
        prof = prof / max(prof.max(), 1e-6)
        halfw = prof * (width * 0.5)
        inside = (np.abs(px) <= length * 0.5)
        cov = np.clip((halfw - np.abs(py)) / max(feather, 1e-3) + 0.5, 0.0, 1.0)
        cov = np.where(inside, cov, 0.0) * alpha
        self._composite((x0, y0, x1, y1), cov, color)
        if midrib is not None:
            tipx = cx + np.cos(angle) * length * 0.5
            tipy = cy + np.sin(angle) * length * 0.5
            basex = cx - np.cos(angle) * length * 0.5
            basey = cy - np.sin(angle) * length * 0.5
            self.capsule((basex, basey), (tipx, tipy), width * 0.045,
                         width * 0.012, midrib, feather=0.8, alpha=0.75)
        return self

    def tint_noise(self, rng, amount=0.12, cells=48):
        """Low-frequency multiplicative tint so foliage is not flat."""
        gh = max(2, int(self.h / cells))
        gw = max(2, int(self.w / cells))
        small = np.array([[1.0 + rng.uniform(-amount, amount)
                           for _ in range(gw)] for _ in range(gh)], np.float32)
        ys = (np.linspace(0, gh - 1, self.h)).astype(np.int32)
        xs = (np.linspace(0, gw - 1, self.w)).astype(np.int32)
        big = small[ys][:, xs]
        self.buf[..., :3] *= big[..., None]
        np.clip(self.buf, 0.0, 1.0, out=self.buf)
        return self

    def to_u8(self):
        return (np.clip(self.buf, 0.0, 1.0) * 255.0 + 0.5).astype(np.uint8)

    def save(self, path):
        return write_png(path, self.to_u8())


# ---------------------------------------------------------------------------
# foliage atlases
# ---------------------------------------------------------------------------

SPRUCE_GREENS = [
    (0.113, 0.216, 0.129),
    (0.145, 0.263, 0.145),
    (0.086, 0.176, 0.117),
    (0.180, 0.298, 0.157),
]
BEECH_GREENS = [
    (0.243, 0.396, 0.153),
    (0.302, 0.463, 0.180),
    (0.196, 0.341, 0.137),
    (0.361, 0.510, 0.208),
]
TWIG_BROWN = (0.212, 0.161, 0.106)


def spruce_spray(canvas, rng, cx, cy, w, h, greens=None, dark=0.0):
    """One flat spruce shoot: a main twig, side twigs, radial needles.

    Norway spruce needles sit all round the shoot, so needles are drawn at a
    wide angle spread rather than in a flat comb -- that is what makes it read
    as spruce and not fir at distance.
    """
    greens = greens or SPRUCE_GREENS
    base = (cx, cy - h * 0.46)
    tipy = cy + h * 0.46
    main_len = tipy - base[1]

    def shade(c):
        return tuple(max(0.0, v * (1.0 - dark)) for v in c)

    # main twig
    canvas.capsule(base, (cx, tipy), w * 0.020, w * 0.008, shade(TWIG_BROWN),
                   feather=0.8)

    branches = [(base[0], base[1], cx, tipy, 1.0)]
    nside = rng.randint(4, 6)
    for i in range(nside):
        t = 0.15 + 0.75 * (i / max(1, nside - 1.0)) + rng.uniform(-0.04, 0.04)
        sx = cx
        sy = base[1] + main_len * t
        side = 1 if (i % 2 == 0) else -1
        ln = main_len * (0.46 - 0.30 * t) * rng.uniform(0.85, 1.15)
        ang = rng.uniform(0.55, 0.95) * side
        ex = sx + np.sin(ang) * ln
        ey = sy + np.cos(ang) * ln
        canvas.capsule((sx, sy), (ex, ey), w * 0.014, w * 0.006,
                       shade(TWIG_BROWN), feather=0.8)
        branches.append((sx, sy, ex, ey, 0.62))

    for (sx, sy, ex, ey, scale) in branches:
        length = float(np.hypot(ex - sx, ey - sy))
        axis = np.arctan2(ey - sy, ex - sx)
        count = max(8, int(length / (w * 0.030)))
        for k in range(count):
            t = (k + rng.uniform(0.1, 0.9)) / count
            px = sx + (ex - sx) * t
            py = sy + (ey - sy) * t
            taper = (1.0 - 0.45 * t)
            for side in (-1, 1):
                spread = rng.uniform(0.55, 1.35) * side
                nlen = w * rng.uniform(0.055, 0.088) * scale * taper
                na = axis + spread
                nx = px + np.cos(na) * nlen
                ny = py + np.sin(na) * nlen
                col = shade(rng.choice(greens))
                canvas.capsule((px, py), (nx, ny), w * 0.0075, w * 0.0028,
                               col, feather=0.75)
    return canvas


def beech_cluster(canvas, rng, cx, cy, w, h, greens=None):
    """A beech shoot: leaves alternate along a thin twig, blades flat-ish."""
    greens = greens or BEECH_GREENS
    base = (cx, cy - h * 0.45)
    tipy = cy + h * 0.45
    canvas.capsule(base, (cx, tipy), w * 0.016, w * 0.007, TWIG_BROWN,
                   feather=0.8)

    stems = [(base[0], base[1], cx, tipy, 1.0)]
    for i in range(rng.randint(2, 3)):
        t = 0.25 + 0.5 * i / 2.0
        sy = base[1] + (tipy - base[1]) * t
        side = 1 if i % 2 == 0 else -1
        ln = h * rng.uniform(0.22, 0.32)
        ang = rng.uniform(0.7, 1.1) * side
        stems.append((cx, sy, cx + np.sin(ang) * ln, sy + np.cos(ang) * ln, 0.8))
        canvas.capsule((cx, sy), stems[-1][2:4], w * 0.011, w * 0.005,
                       TWIG_BROWN, feather=0.8)

    for (sx, sy, ex, ey, scale) in stems:
        axis = np.arctan2(ey - sy, ex - sx)
        n = rng.randint(4, 6)
        for k in range(n):
            t = (k + 0.6) / (n + 0.3)
            px = sx + (ex - sx) * t
            py = sy + (ey - sy) * t
            side = 1 if k % 2 == 0 else -1
            ang = axis + rng.uniform(0.65, 1.05) * side
            llen = w * rng.uniform(0.20, 0.29) * scale * (1.0 - 0.25 * t)
            lw = llen * rng.uniform(0.52, 0.66)
            lx = px + np.cos(ang) * llen * 0.5
            ly = py + np.sin(ang) * llen * 0.5
            col = rng.choice(greens)
            canvas.capsule((px, py), (lx, ly), w * 0.006, w * 0.004,
                           TWIG_BROWN, feather=0.7)
            canvas.leaf((lx, ly), llen, lw, ang, col, feather=0.9,
                        midrib=tuple(c * 0.72 for c in col))
    return canvas


def build_atlas(path, rng, draw_fn, size=1024, cells=2, bg=(0, 0, 0, 0)):
    """2x2 (or NxN) atlas of independent foliage sprays.

    Cards pick a cell via their UVs, so one texture gives several distinct
    looks with no extra material or draw call.
    """
    cv = Canvas(size, size, bg)
    cw = size / cells
    for iy in range(cells):
        for ix in range(cells):
            sub = rng.sub("cell%d_%d" % (ix, iy))
            draw_fn(cv, sub, (ix + 0.5) * cw, (iy + 0.5) * cw, cw, cw)
    cv.tint_noise(rng.sub("tint"), 0.10)
    return cv.save(path)


def atlas_uv_rect(index, cells=2, inset=0.004):
    """UV rect (x0, y0, x1, y1) for atlas cell `index`."""
    ix = index % cells
    iy = (index // cells) % cells
    s = 1.0 / cells
    return (ix * s + inset, iy * s + inset,
            (ix + 1) * s - inset, (iy + 1) * s - inset)
