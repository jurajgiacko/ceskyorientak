/**
 * What a piece of drawn geometry claims to be.
 *
 * The town's drawn ≡ solid gate reads the *scene graph* — not the data the
 * scene was built from — and asks of every mesh in the venue whether the thing
 * it draws should stop the athlete. It cannot ask that of an untagged triangle
 * soup, and the two faults it exists to catch are exactly the ones an untagged
 * mesh hides: geometry drawn with no collider (D-029's 13.8 km of barrier), and
 * a collider with nothing drawn at it (the invisible walls the stamped raster
 * left behind).
 *
 * So every mesh the town adds to the scene carries one of these, and
 * `tools/ci/check-townmodel.mjs` fails on any mesh under the town's groups that
 * carries none. An unclassified mesh is a mesh nobody has decided about, and
 * this venue's history is a history of exactly that.
 *
 * The roles that block are `building`, `barrier`, `structure` and `water`. The
 * roles that deliberately do not are `steps` (ISSprOM 532, runnable), `deck`
 * (the surface of a crossing) and `scenery` (trees, which are run around — a
 * forest is a cost surface, D-002).
 */

import type * as THREE from 'three';

export type TownRole =
  | 'building'
  | 'barrier'
  | 'structure'
  | 'water'
  | 'steps'
  | 'deck'
  | 'scenery';

/** Roles whose geometry, standing in the athlete's way, must also be solid. */
export const BLOCKING_ROLES: readonly TownRole[] = ['building', 'barrier', 'structure', 'water'];

export function tagRole(object: THREE.Object3D, role: TownRole): void {
  object.userData.role = role;
}
