import { lstatSync, readlinkSync, realpathSync } from 'node:fs';
import path from 'node:path';

export class SandboxError extends Error {
  constructor(public readonly attempted: string) {
    super(`path escapes repo root: ${attempted}`);
    this.name = 'SandboxError';
  }
}

/**
 * Resolve symlinks as far as the path actually exists.
 *
 * A write target legitimately does not exist yet, so we walk up to the deepest
 * existing ancestor, resolve that, and re-attach the remaining segments. Those
 * trailing segments are already lexically normalised by `path.resolve`, so they
 * cannot contain `..`.
 *
 * A *dangling* symlink is the exception: `realpathSync` fails on it exactly as
 * it does on a path that simply doesn't exist, so treating the two the same way
 * would rebuild the link under the repo root and let a write follow it out of
 * the sandbox. `lstat` describes the link itself, so it still succeeds where
 * `realpath` gave up — that's how the two cases are told apart. When we find
 * one, resolve its target manually and keep checking from there.
 */
function realpathDeepest(abs: string): string {
  let head = abs;
  const tail: string[] = [];
  // A dangling link can point at another dangling link; bound the chase so a
  // cycle cannot spin here.
  let hops = 0;
  for (;;) {
    try {
      return path.join(realpathSync(head), ...tail);
    } catch {
      // A link whose target is missing: follow it lexically so containment is
      // judged on where it points, not on where the link happens to live.
      let link: string | null = null;
      try {
        if (hops < 32 && lstatSync(head).isSymbolicLink()) {
          link = path.resolve(path.dirname(head), readlinkSync(head));
        }
      } catch {
        // head does not exist at all; fall through to the parent walk.
      }
      if (link !== null) {
        hops++;
        head = link;
        continue;
      }

      const parent = path.dirname(head);
      // Reached the filesystem root without finding anything that exists.
      if (parent === head) return abs;
      tail.unshift(path.basename(head));
      head = parent;
    }
  }
}

/**
 * Resolve a repo-relative path and reject anything that escapes the repo root
 * (AC-4.2). All file tools must go through this.
 *
 * The containment check runs on the symlink-resolved path: `path.resolve` is
 * purely lexical, so a symlink inside the repo pointing outside it would resolve
 * to something that still starts with the repo root and slip through, and the
 * following `fs` call would then follow the link out of the sandbox.
 */
export function resolveInRepo(repoRoot: string, p: string): string {
  const abs = path.resolve(repoRoot, p);
  const root = path.resolve(repoRoot);
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw new SandboxError(p);
  }

  // The repo root itself may sit under a symlink (on macOS /tmp is /private/tmp),
  // so both sides have to be resolved or every path under it would look external.
  const realRoot = realpathDeepest(root);
  const realAbs = realpathDeepest(abs);
  if (realAbs !== realRoot && !realAbs.startsWith(realRoot + path.sep)) {
    throw new SandboxError(p);
  }

  return abs;
}

export function isKicadFile(p: string): boolean {
  return /\.(kicad_sch|kicad_pcb|kicad_pro|kicad_sym|kicad_mod)$/.test(p);
}
