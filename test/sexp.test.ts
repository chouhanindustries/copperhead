import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { listSymbols, listNets, pinNets, parseSexp, listFootprints} from '../src/kicad/sexp.js';
import { FIXTURE } from './helpers.js';


const SCH = path.join(FIXTURE, 'hardware', 'open-key.kicad_sch');
const PCB = path.join(FIXTURE, '..', 'footprint-enumerator/board-with-footprints.kicad_pcb');

describe('sexp parser', () => {
  it('parses quoted strings with escapes', () => {
    const [node] = parseSexp('(a "b \\"c\\"" d)');
    expect(node).toEqual(['a', 'b "c"', 'd']);
  });

  it('lists real symbols with refdes, value, footprint (AC-1.2 source)', async () => {
    const syms = await listSymbols(SCH);
    expect(syms.map((s) => s.ref)).toEqual(['R1', 'R2', 'U1']);
    const r1 = syms.find((s) => s.ref === 'R1')!;
    expect(r1.value).toBe('10k');
    expect(r1.footprint).toBe('Resistor_SMD:R_0603_1608Metric');
    const u1 = syms.find((s) => s.ref === 'U1')!;
    expect(u1.value).toBe('ESP32-S3-MINI');
  });

  it('lists nets from labels', async () => {
    const nets = await listNets(SCH);
    expect(nets).toEqual(['3V3', 'EN', 'GND', 'KEY_DAH']);
  });

  it("lists board footprints", async () => {
    const footprints = await listFootprints(PCB);

    expect(footprints).toHaveLength(3);

    const r1 = footprints.find((footprint) => footprint.ref === "R1");
    expect(r1?.footprint).toBe("Resistor_SMD:R_0603_1608Metric");
    expect(r1?.side).toBe("front");
    expect(r1?.at).toEqual({ x: 125.73, y: 82.55, rot: 90 });

    const missingRef = footprints.find((footprint) => footprint.ref === "?");
    expect(missingRef?.footprint).toBe("Capacitor_SMD:C_0603_1608Metric");
    expect(missingRef?.side).toBe("back");

    const unknownSide = footprints.find((footprint) => footprint.ref === "J1");
    expect(unknownSide?.footprint).toBe("Connector_PinHeader_2.00mm:PinHeader_1x2_P2.00mm_Vertical");
    expect(unknownSide?.side).toBe("unknown");
    expect(unknownSide?.at).toEqual({ x: 135, y: 90, rot: 0 });
  });

  it('maps pins to nets geometrically (AC-1.3 source)', async () => {
    const pins = await pinNets(SCH);
    const u1 = new Map(pins.filter((p) => p.ref === 'U1').map((p) => [p.pinName, p.net]));
    expect(u1.get('GPIO14')).toBe('KEY_DAH');
    expect(u1.get('3V3')).toBe('3V3');
    expect(u1.get('GND')).toBe('GND');
    expect(u1.get('EN')).toBe('EN');
    expect(u1.get('GPIO0')).toBeNull();
    const r2 = new Map(pins.filter((p) => p.ref === 'R2').map((p) => [p.pinNumber, p.net]));
    expect(r2.get('1')).toBe('KEY_DAH');
    expect(r2.get('2')).toBe('GND');
  });
});
