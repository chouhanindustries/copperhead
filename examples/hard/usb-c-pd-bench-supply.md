# Brief: 100W USB-C PD programmable bench supply

![100W USB-C PD bench supply concept render](../images/usb-c-pd-bench-supply.webp)

*AI-generated illustrative concept render, not a KiCad output or placement reference; component selection and layout are intentionally unresolved.*

## What it is

A compact programmable bench supply that turns a USB-C Power Delivery charger into an adjustable constant-voltage or constant-current source for electronics work. It negotiates a safe input contract, converts that input efficiently, and exposes the real cable and charger limits instead of presenting every USB-C source as a generic 100W supply.

## Must do

1. Operate as a USB-C PD 3.0 sink and request fixed 5V, 9V, 12V, 15V, or 20V PDOs offered by the source.
2. Provide an adjustable 3.3V to 18V output with constant-voltage and constant-current regulation.
3. Deliver up to 5A only when the negotiated contract, cable, thermal state, and configured output voltage all permit it.
4. Show negotiated input voltage and current, output set points, measured output, delivered power, and active faults on a small display.
5. Provide a rotary encoder, output-enable control, high-current output connector, and separate sense terminals.
6. Keep the output disabled until negotiation, configuration restore, and self-check complete.
7. Protect against output short circuit, reverse current, input or output overvoltage, and overtemperature.
8. Discharge VBUS and the output rail to safe levels after detach or output disable.

## Budgets

- Maximum PD contract: 20V at 5A, 100W, with a capable source and electronically marked 5A cable.
- Regulated output: 3.3V to 18V, 0.1A to 5A, never exceeding 90W.
- Conversion efficiency: at least 90% from 60W to 90W output.
- Output ripple: under 50mV RMS at steady loads from 1A to 5A.
- Load-step deviation: under 500mV for a 10% to 90% current step, recovering within 2ms.
- Measurement accuracy: output voltage within +/-1% and current within +/-2% across the operating range.
- Thermal limit: no junction above 110C at 25C ambient during continuous 90W operation with the documented cooling arrangement.
- Board area: 100mm x 60mm or smaller, excluding the display height and knob.
- BOM cost: under $35 at qty 100, excluding the external charger and cable.

## Constraints

- Use a 4-layer board with 2oz copper on the outer layers and an uninterrupted ground plane outside the switching node.
- The converter is buck-only. The firmware must restrict the output range to what the negotiated input voltage can regulate with margin.
- A 5A operating point is allowed only when the explicit PD contract grants 5A; otherwise cap input current at the negotiated lower limit. Do not assume cable identity is directly available to sink firmware.
- Present the correct sink terminations before negotiation and never apply the programmable load before a valid contract exists.
- Calculate the USB-C connector, input protection, converter, shunt, fuse, and output connector losses independently at 5A; no single headline current rating is enough.
- All parts exposed to the 20V input must be rated for at least 30V; derate input capacitors so the negotiated rail remains below 70% of their voltage rating.
- Keep the hot switching loop compact, keep the current shunt Kelvin-routed, and keep USB-C CC traces away from the switch node.
- State clearly that the output is not galvanically isolated from the USB-C source.

## Out of scope

- USB PD 3.1 EPR voltages above 20V.
- Programmable Power Supply mode; fixed PDOs are sufficient.
- Battery charging or battery emulation.
- USB data pass-through.
- Galvanic isolation, an enclosure, or a mains input stage.

## Notes

The first deliberate trap is the 100W label. A USB-C connector does not grant 20V or 5A by itself: the source must offer the 20V PDO, the sink must negotiate it, and current above 3A requires a 5A electronically marked cable. The firmware must derive every output limit from the live contract and measured thermal state, then fail safe after detach or renegotiation.

The second trap is the buck-only output. An 18V setting cannot be maintained from a 15V contract, and a 5A output limit can exceed the negotiated input power even at lower voltages once converter loss is included. Clamp voltage and current set points together rather than exposing controls that promise an impossible operating point.

At 90% efficiency, 90W output still leaves about 10W to dissipate. The thermal design must identify where that heat is generated, show copper and airflow assumptions, and derate or shut down before any junction reaches the limit. A room-temperature five-minute demo is not evidence of continuous operation.
