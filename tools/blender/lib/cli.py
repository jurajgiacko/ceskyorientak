"""Shared entry-point plumbing for asset scripts.

Every asset script is run as::

    Blender --background --python assets/<name>.py -- --out <dir> [--seed N]

so argument parsing has to start after the ``--`` separator.
"""

import argparse
import os
import sys

from . import mesh as M
from .rng import DRNG, seed_blender_noise

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
DEFAULT_OUT = os.path.join(ROOT, "public", "models")
CACHE = os.path.join(ROOT, "tools", "blender", ".cache")


def bootstrap():
    """Put tools/blender on sys.path so `from lib import ...` works when the
    script is launched by absolute path."""
    here = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
    if here not in sys.path:
        sys.path.insert(0, here)
    return here


def parse(defaults=None):
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    p = argparse.ArgumentParser()
    p.add_argument("--out", default=DEFAULT_OUT)
    p.add_argument("--seed", type=int, default=20260805)
    p.add_argument("--draco", dest="draco", action="store_true", default=None)
    p.add_argument("--no-draco", dest="draco", action="store_false")
    p.add_argument("--cache", default=CACHE)
    args = p.parse_args(argv)
    if args.draco is None:
        args.draco = (defaults or {}).get("draco", True)
    os.makedirs(args.out, exist_ok=True)
    os.makedirs(args.cache, exist_ok=True)
    return args


def setup(seed, path="asset"):
    """Clean scene + deterministic RNG.  Call once at the top of an asset."""
    M.reset_scene()
    seed_blender_noise(seed)
    return DRNG(seed, path)


def out_path(args, filename):
    return os.path.join(args.out, filename)


def cache_path(args, filename):
    p = os.path.join(args.cache, filename)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    return p
