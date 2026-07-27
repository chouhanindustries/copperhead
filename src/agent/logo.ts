/**
 * Terminal block-art mark derived from the website logo
 * (docs/public/favicon.svg and docs.copperhead.sh): a via with a square
 * drilled hole and long copper tracks routed out of both sides, copper
 * #b87333 on dark. (`scripts/gen-logo.mjs` renders the exact favicon
 * geometry at any size for reference.)
 */

import { copper } from './theme.js';

/** 3-row quadrant-block via with long tracks; rows are equal width. */
export function fiducialMark(): string[] {
  return [
    '   ▄▟▙▄  ',
    ' ███  ███',
    '   ▀▜▛▀  ',
  ];
}

/** The mark painted in brand copper. */
export function fiducialLines(): string[] {
  return fiducialMark().map((line) => copper(line));
}
