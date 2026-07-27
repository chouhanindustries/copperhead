// Builds the KiCad Plugin and Content Manager addon zip (AC-114B.7, D5).
// Layout per the PCM spec: metadata.json at the root, plugin sources under
// plugins/, icon under resources/. Version comes from package.json so the
// addon can never drift from the npm release it belongs to.
//
// Usage: node scripts/build-pcm-addon.mjs [outDir]   (default: dist/)
// No dependencies: the zip is written with stored (uncompressed) entries,
// which PCM accepts and keeps this script auditable.

import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync } from 'node:zlib';

const root = fileURLToPath(new URL('..', import.meta.url));
const { version } = createRequire(import.meta.url)(path.join(root, 'package.json'));

export function pcmMetadata(pkgVersion) {
  return {
    $schema: 'https://go.kicad.org/pcm/schemas/v1',
    name: 'copperhead',
    description: 'Spec-gated AI agent panel: request board changes, get ERC/DRC-verified commits',
    description_full:
      'Docks a copperhead pane into pcbnew (KiCad 9/10). Type a change request; the agent ' +
      'edits the KiCad files through validated OpenSpec proposals, verifies with ERC/DRC, and ' +
      'commits. Requires the copperhead CLI (npm install -g copperhead). The pane drives ' +
      '"copperhead serve" and forwards the KiCad IPC API connection for live selection context.',
    identifier: 'com.github.chouhanindustries.copperhead',
    type: 'plugin',
    author: { name: 'Animesh Chouhan', contact: { web: 'https://copperhead.sh' } },
    license: 'Apache-2.0',
    resources: { homepage: 'https://github.com/chouhanindustries/copperhead' },
    versions: [
      {
        version: pkgVersion,
        status: 'stable',
        // SWIG action plugins: KiCad 9 and 10 only; the system is removed in 11.
        kicad_version: '9.0',
        kicad_version_max: '10.99',
      },
    ],
  };
}

/** Minimal store-only zip writer (central directory, no compression tricks). */
function buildZip(entries) {
  const chunks = [];
  const central = [];
  let offset = 0;
  // Fixed, valid DOS timestamp (2020-01-01 00:00): reproducible zips.
  const now = { time: 0, date: ((2020 - 1980) << 9) | (1 << 5) | 1 };
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    const deflated = deflateRawSync(data, { level: 9 });
    const useDeflate = deflated.length < data.length;
    const body = useDeflate ? deflated : data;
    const method = useDeflate ? 8 : 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(now.time, 10);
    local.writeUInt16LE(now.date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, nameBuf, body);
    const cdir = Buffer.alloc(46);
    cdir.writeUInt32LE(0x02014b50, 0);
    cdir.writeUInt16LE(20, 4);
    cdir.writeUInt16LE(20, 6);
    cdir.writeUInt16LE(0, 8);
    cdir.writeUInt16LE(method, 10);
    cdir.writeUInt16LE(now.time, 12);
    cdir.writeUInt16LE(now.date, 14);
    cdir.writeUInt32LE(crc, 16);
    cdir.writeUInt32LE(body.length, 20);
    cdir.writeUInt32LE(data.length, 24);
    cdir.writeUInt16LE(nameBuf.length, 28);
    cdir.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([cdir, nameBuf]));
    offset += 30 + nameBuf.length + body.length;
  }
  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, centralBuf, end]);
}

let CRC_TABLE = null;
function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function walk(dir, base = '') {
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    const full = path.join(dir, name);
    const rel = base ? `${base}/${name}` : name;
    if (statSync(full).isDirectory()) out.push(...walk(full, rel));
    else out.push({ rel, full });
  }
  return out;
}

/** The zip's entry list; exported so tests can assert layout without unzipping. */
export function addonEntries() {
  const pluginSrc = path.join(root, 'plugins', 'kicad', 'copperhead_panel');
  const iconSrc = path.join(root, 'plugins', 'kicad', 'resources', 'icon.png');
  return [
    { name: 'metadata.json', data: Buffer.from(JSON.stringify(pcmMetadata(version), null, 2) + '\n') },
    { name: 'resources/icon.png', data: readFileSync(iconSrc) },
    ...walk(pluginSrc)
      .filter(({ rel }) => !rel.includes('__pycache__'))
      .map(({ rel, full }) => ({ name: `plugins/copperhead_panel/${rel}`, data: readFileSync(full) })),
  ];
}

export function buildAddon(outDir) {
  const entries = addonEntries();
  mkdirSync(outDir, { recursive: true });
  const out = path.join(outDir, `copperhead-kicad-addon-${version}.zip`);
  writeFileSync(out, buildZip(entries));
  return out;
}

// Direct invocation: node scripts/build-pcm-addon.mjs [outDir]
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const out = buildAddon(path.resolve(process.argv[2] ?? path.join(root, 'dist')));
  console.log(`built ${out}`);
}
