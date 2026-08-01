"""Deterministic, hierarchical RNG.

Every random draw in the pipeline goes through a DRNG derived from the build
seed plus a *path* string.  Two consequences:

  * A build is byte-reproducible: same seed -> same geometry.
  * Adding a new random draw in one part of an asset does not shift the
    numbers seen by any other part, because each part owns its own stream
    (derived by hashing seed + path).  This keeps diffs local.
"""

import hashlib
import math
import random


def _mix(seed, path):
    h = hashlib.sha256(("%d\x00%s" % (int(seed), path)).encode("utf-8")).digest()
    return int.from_bytes(h[:8], "little")


class DRNG:
    def __init__(self, seed=0, path="root"):
        self.seed = int(seed)
        self.path = path
        self._r = random.Random(_mix(seed, path))

    def sub(self, tag):
        """Derive an independent child stream."""
        return DRNG(self.seed, "%s/%s" % (self.path, tag))

    # -- scalars ---------------------------------------------------------
    def uniform(self, a, b):
        return self._r.uniform(a, b)

    def randint(self, a, b):
        return self._r.randint(a, b)

    def gauss(self, mu, sigma):
        return self._r.gauss(mu, sigma)

    def chance(self, p):
        return self._r.random() < p

    def jitter(self, v, amt):
        """v +/- amt (absolute)."""
        return v + self._r.uniform(-amt, amt)

    def vary(self, v, frac):
        """v scaled by 1 +/- frac (relative)."""
        return v * (1.0 + self._r.uniform(-frac, frac))

    # -- sequences -------------------------------------------------------
    def choice(self, seq):
        return self._r.choice(seq)

    def sample(self, seq, k):
        return self._r.sample(list(seq), k)

    def shuffled(self, seq):
        out = list(seq)
        self._r.shuffle(out)
        return out

    # -- vectors ---------------------------------------------------------
    def unit3(self):
        """Uniformly distributed point on the unit sphere."""
        z = self._r.uniform(-1.0, 1.0)
        t = self._r.uniform(0.0, 2.0 * math.pi)
        r = math.sqrt(max(0.0, 1.0 - z * z))
        return (r * math.cos(t), r * math.sin(t), z)

    def in_disc(self, radius=1.0):
        """Uniformly distributed point in a disc (not clustered at centre)."""
        r = radius * math.sqrt(self._r.random())
        t = self._r.uniform(0.0, 2.0 * math.pi)
        return (r * math.cos(t), r * math.sin(t))

    def offset3(self, amt):
        return (self._r.uniform(-amt, amt),
                self._r.uniform(-amt, amt),
                self._r.uniform(-amt, amt))


def seed_blender_noise(seed):
    """mathutils.noise keeps global state; pin it so turbulence is stable."""
    from mathutils import noise
    noise.seed_set(int(seed) & 0x7FFFFFFF)
