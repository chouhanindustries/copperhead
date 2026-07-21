# Branding assets

Two colors only: dark `#15181c`, copper `#b87333`. The mark is the fiducial from `../public/favicon.svg`.

## Masters (SVG)

- `../public/favicon.svg`: rounded tile, source for all favicon and PWA icons
- `icon-square.svg`: full-bleed square, source for apple-touch, maskable, and profile pics
- `icon-transparent.svg`: copper mark alone, no tile, for use on any background
- `social-card.svg`: lockup layout reference for the social cards
- `favicon-*.svg`: earlier mark explorations, kept for reference

## Rendered outputs

In `../public/` (served at the docs site root, wired in `astro.config.mjs`):

- `favicon.ico` (16/32/48), `icon-192.png`, `icon-512.png`
- `apple-touch-icon.png` (180), `icon-maskable-512.png`, `site.webmanifest`
- `og.png` (1200x630): Open Graph and Twitter card image

Here:

- `profile-pic-1024.png`, `profile-pic-400.png`: social media avatars, safe under circular crops
- `github-social-preview.png` (1280x640): upload in GitHub repo Settings, Social preview
- `icon-transparent-256.png` / `-512.png` / `-1024.png`: copper mark on transparent background
- `lockup-transparent.png`: mark plus wordmark on transparent background, for headers and slides

## Regenerating

Rasterize with ImageMagick from the SVG masters, e.g.
`convert -background none -density 1536 ../public/favicon.svg -resize 512x512 icon-512.png`.
The social card PNGs are composed with the Fira Mono Medium font file directly because
ImageMagick's SVG renderer does not resolve fontconfig families.
