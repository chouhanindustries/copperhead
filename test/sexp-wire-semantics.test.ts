import { describe, it, expect, afterAll } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pinNets, listNets } from '../src/kicad/sexp.js';

/**
 * KiCad wire-semantics tests for the geometric net extraction in pinNets():
 * labels attach anywhere along a wire (not only at endpoints), junctions
 * bridge crossing wires, and power:PWR_FLAG never names a net.
 */

const LIB_SYMBOLS = `(lib_symbols
    (symbol "Device:R"
      (property "Reference" "R" (at 2.032 0 90))
      (property "Value" "R" (at 0 0 90))
      (symbol "R_1_1"
        (pin passive line (at 0 3.81 270) (length 1.27)
          (name "~" (effects (font (size 1.27 1.27))))
          (number "1" (effects (font (size 1.27 1.27))))
        )
        (pin passive line (at 0 -3.81 90) (length 1.27)
          (name "~" (effects (font (size 1.27 1.27))))
          (number "2" (effects (font (size 1.27 1.27))))
        )
      )
    )
    (symbol "power:GND"
      (property "Reference" "#PWR" (at 0 -6.35 0))
      (property "Value" "GND" (at 0 -3.81 0))
      (symbol "GND_1_1"
        (pin power_in line (at 0 0 270) (length 0)
          (name "GND" (effects (font (size 1.27 1.27))))
          (number "1" (effects (font (size 1.27 1.27))))
        )
      )
    )
    (symbol "power:PWR_FLAG"
      (property "Reference" "#FLG" (at 0 1.905 0))
      (property "Value" "PWR_FLAG" (at 0 3.81 0))
      (symbol "PWR_FLAG_1_1"
        (pin power_out line (at 0 0 90) (length 0)
          (name "pwr" (effects (font (size 1.27 1.27))))
          (number "1" (effects (font (size 1.27 1.27))))
        )
      )
    )
  )`;

function resistor(ref: string, x: number, y: number): string {
  return `(symbol (lib_id "Device:R") (at ${x} ${y} 0) (unit 1)
    (uuid "00000000-0000-4000-8000-0000000000${ref === 'R1' ? '10' : '20'}")
    (property "Reference" "${ref}" (at 0 0 0))
    (property "Value" "10k" (at 0 0 0))
    (property "Footprint" "" (at 0 0 0))
  )`;
}

function powerSym(lib: string, value: string, x: number, y: number, ref: string): string {
  return `(symbol (lib_id "${lib}") (at ${x} ${y} 0) (unit 1)
    (uuid "00000000-0000-4000-8000-0000000000${ref.replace(/\D/g, '').padStart(2, '9')}")
    (property "Reference" "${ref}" (at 0 0 0))
    (property "Value" "${value}" (at 0 0 0))
    (property "Footprint" "" (at 0 0 0))
  )`;
}

function sch(body: string): string {
  return `(kicad_sch
  (version 20231120)
  (generator "eeschema")
  (generator_version "8.0")
  (uuid "0b0b0b0b-0000-4000-8000-000000000001")
  (paper "A4")
  ${LIB_SYMBOLS}
  ${body}
)\n`;
}

let dirs: string[] = [];
afterAll(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

async function writeSch(body: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'copperhead-sexp-'));
  dirs.push(dir);
  const file = path.join(dir, 'case.kicad_sch');
  await writeFile(file, sch(body), 'utf8');
  return file;
}

describe('pinNets wire semantics', () => {
  it('a label placed mid-segment names the net for a pin at the far endpoint', async () => {
    // R1 at (100,100): pin 1 at (100, 96.19). Wire runs (100,96.19)->(100,80);
    // the label sits at (100,90), strictly inside the segment.
    const file = await writeSch(`
      ${resistor('R1', 100, 100)}
      (wire (pts (xy 100 96.19) (xy 100 80)) (uuid "aaaa0000-0000-4000-8000-000000000001"))
      (label "SIG" (at 100 90 0) (uuid "aaaa0000-0000-4000-8000-000000000002"))
    `);
    const pins = await pinNets(file);
    const r1 = new Map(pins.filter((p) => p.ref === 'R1').map((p) => [p.pinNumber, p.net]));
    expect(r1.get('1')).toBe('SIG');
    expect(r1.get('2')).toBeNull();
  });

  it('keeps endpoint-attached labels working on plain wires', async () => {
    // R1 pin 2 at (100, 103.81); label sits exactly on the far wire endpoint.
    const file = await writeSch(`
      ${resistor('R1', 100, 100)}
      (wire (pts (xy 100 103.81) (xy 100 110)) (uuid "bbbb0000-0000-4000-8000-000000000001"))
      (label "OTHER" (at 100 110 0) (uuid "bbbb0000-0000-4000-8000-000000000002"))
    `);
    const pins = await pinNets(file);
    const r1 = new Map(pins.filter((p) => p.ref === 'R1').map((p) => [p.pinNumber, p.net]));
    expect(r1.get('2')).toBe('OTHER');
    expect(r1.get('1')).toBeNull();
  });

  it('a junction bridges two crossing wires into one net', async () => {
    // Wire A (50,50)->(70,50) and wire B (60,40)->(60,60) cross at (60,50),
    // interior to both. The label names wire A at an endpoint; R1 pin 1 sits
    // on wire B's endpoint (60,60). Only the junction connects A and B.
    const body = (junction: string) => `
      ${resistor('R1', 60, 63.81)}
      (wire (pts (xy 50 50) (xy 70 50)) (uuid "cccc0000-0000-4000-8000-000000000001"))
      (wire (pts (xy 60 40) (xy 60 60)) (uuid "cccc0000-0000-4000-8000-000000000002"))
      (label "NETX" (at 50 50 0) (uuid "cccc0000-0000-4000-8000-000000000003"))
      ${junction}
    `;
    const withJunction = await writeSch(body('(junction (at 60 50) (diameter 0) (color 0 0 0 0))'));
    const joined = await pinNets(withJunction);
    expect(joined.find((p) => p.ref === 'R1' && p.pinNumber === '1')?.net).toBe('NETX');

    // Without the junction, crossing wires must stay unconnected (KiCad
    // semantics: crossing wires touch only via an explicit junction).
    const withoutJunction = await writeSch(body(''));
    const split = await pinNets(withoutJunction);
    expect(split.find((p) => p.ref === 'R1' && p.pinNumber === '1')?.net).toBeNull();
  });

  it('PWR_FLAG on a net does not rename it', async () => {
    // Wire (100,100)->(120,100) labeled VCC5 at one endpoint; a PWR_FLAG pin
    // lands on the other endpoint; R1 pin 1 touches the wire mid-segment.
    const file = await writeSch(`
      ${resistor('R1', 110, 103.81)}
      (wire (pts (xy 100 100) (xy 120 100)) (uuid "dddd0000-0000-4000-8000-000000000001"))
      (label "VCC5" (at 100 100 0) (uuid "dddd0000-0000-4000-8000-000000000002"))
      ${powerSym('power:PWR_FLAG', 'PWR_FLAG', 120, 100, '#FLG01')}
    `);
    const pins = await pinNets(file);
    expect(pins.find((p) => p.ref === 'R1' && p.pinNumber === '1')?.net).toBe('VCC5');
    const nets = await listNets(file);
    expect(nets).not.toContain('PWR_FLAG');
    expect(nets).toContain('VCC5');
  });

  it('a power symbol still names its net via its value', async () => {
    // Regression guard for the PWR_FLAG exclusion: ordinary power symbols
    // (power:GND) must keep naming nets from their value.
    const file = await writeSch(`
      ${resistor('R1', 100, 100)}
      (wire (pts (xy 100 103.81) (xy 100 110)) (uuid "eeee0000-0000-4000-8000-000000000001"))
      ${powerSym('power:GND', 'GND', 100, 110, '#PWR01')}
    `);
    const pins = await pinNets(file);
    expect(pins.find((p) => p.ref === 'R1' && p.pinNumber === '2')?.net).toBe('GND');
  });
});
