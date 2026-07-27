/**
 * Generate the terminal block-art mark from the actual brand geometry in
 * docs/public/favicon.svg: circle cx=16 cy=16 r=5.25 stroke-width=2.25 plus
 * four crosshair ticks (5.75->10.75 and 21.25->26.25, width 2.25).
 *
 * Each char cell is 2x2 subpixels; a terminal cell is ~1:2 (w:h), so the
 * subpixel grid uses twice as many columns as rows for an undistorted
 * render. 3x3 supersampling per subpixel, then 2x2 blocks map onto the
 * sixteen quadrant characters.
 *
 *   node scripts/gen-logo.mjs [rows]   (default 3, i.e. 6 subpixel rows)
 */

const rows = Number(process.argv[2] ?? 3);
if (!Number.isInteger(rows) || rows <= 0) {
  console.error(`invalid rows "${process.argv[2]}": expected a positive integer`);
  process.exit(1);
}
const H = rows * 2; // subpixel rows
const W = H * 2; // subpixel cols (aspect-corrected)

// Shape occupies SVG range [5.75, 26.25] in both axes; add a hair of margin.
const MIN = 5.25;
const MAX = 26.75;
const SPAN = MAX - MIN;

const R = 5.25;
const CX = 16;
const CY = 16;
// Hinting: at low resolutions the true 2.25-unit stroke is thinner than a
// subpixel and rasters dashed; thicken it to at least ~1.15 subpixels.
const STROKE = Math.max(2.25, (1.15 * SPAN) / H);

function inked(x, y) {
  // Ring: annulus between r-stroke/2 and r+stroke/2.
  const d = Math.hypot(x - CX, y - CY);
  if (Math.abs(d - R) <= STROKE / 2) return true;
  // Ticks: spanning 5.75..10.75 and 21.25..26.25 on each axis.
  const half = STROKE / 2;
  const inBand = (v) => (v >= 5.75 && v <= 10.75) || (v >= 21.25 && v <= 26.25);
  if (Math.abs(x - CX) <= half && inBand(y)) return true;
  if (Math.abs(y - CY) <= half && inBand(x)) return true;
  return false;
}

const grid = [];
for (let j = 0; j < H; j++) {
  const row = [];
  for (let i = 0; i < W; i++) {
    let hits = 0;
    for (let sy = 0; sy < 3; sy++) {
      for (let sx = 0; sx < 3; sx++) {
        const x = MIN + ((i + (sx + 0.5) / 3) * SPAN) / W;
        const y = MIN + ((j + (sy + 0.5) / 3) * SPAN) / H;
        if (inked(x, y)) hits++;
      }
    }
    row.push(hits >= 5 ? 1 : 0);
  }
  grid.push(row);
}

// UL=1 UR=2 LL=4 LR=8
const QUAD = [' ', '▘', '▝', '▀', '▖', '▌', '▞', '▛', '▗', '▚', '▐', '▜', '▄', '▙', '▟', '█'];
const lines = [];
for (let r = 0; r < rows; r++) {
  let line = '';
  for (let c = 0; c < W / 2; c++) {
    const bits =
      (grid[r * 2][c * 2] ? 1 : 0) |
      (grid[r * 2][c * 2 + 1] ? 2 : 0) |
      (grid[r * 2 + 1][c * 2] ? 4 : 0) |
      (grid[r * 2 + 1][c * 2 + 1] ? 8 : 0);
    line += QUAD[bits];
  }
  lines.push(line);
}

for (const line of lines) console.log(`'${line}',`);
