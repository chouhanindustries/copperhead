# Brief: USB-C power breakout

## What it is

A small breakout board that takes USB-C 5V from a normal charger and presents it on screw terminals and a 0.1" header, for powering breadboard projects. No data lines, no negotiation beyond default 5V.

## Must do

1. Accept a USB-C receptacle, sink side, 5V only.
2. Present 5V and GND on a 2-pin 3.5mm screw terminal and on a 2x2 0.1" header.
3. Present itself as a plain 5V sink so a USB-C source turns on VBUS.
4. Show a power LED.
5. Protect against a short on the output.

## Budgets

- Output current: the board must be rated for 3A continuous.
- Input voltage: 5V nominal, survive 6V.
- Quiescent current with no load: under 2mA including the LED.
- Board area: 30mm x 20mm or smaller.

## Constraints

- 2-layer, 1oz copper, standard JLCPCB process, no controlled impedance.
- Hand-solderable: nothing finer than 0603, no BGA, no QFN with a thermal pad.
- Target BOM cost under $3 at qty 100.
- Through-hole mounting holes: 2x M3, on a 24mm pitch.

## Out of scope

- USB-PD or any voltage other than 5V.
- Data pass-through.
- Enclosure.

## Notes

The CC pull-down resistors are what make this work at all: without an Rd on each CC line, a compliant USB-C source never turns on VBUS. State the value chosen and why in `docs/DECISIONS.md`, since it is the single thing most likely to be wrong.

Note that a sink does not decide how much current it gets. The source advertises its capability with an Rp on CC, and the sink is expected to read that and stay within it. This board has no MCU to read it, so "3A" here means the copper, connector, and protection are rated for 3A, not that 3A is always available. Say so in `docs/SPEC.md` rather than implying the board negotiates anything.

## Sourced component input for the end-to-end regression

All requirements above remain mandatory. Use GCT USB4125-GF-A-0190 for
the USB-C input, with installed symbol
`Connector:USB_C_Receptacle_PowerOnly_6P` and footprint
`Connector_USB:USB_C_Receptacle_GCT_USB4125-xx-x-0190_6P_TopMnt_Horizontal`.
Use both VBUS contacts and both ground contacts in the 3 A path.

GCT's USB4125/USB4130/USB4135 product specification, revision A3 dated
2024-12-20, section 4.0 (page 2), rates the VBUS pair collectively for 3 A,
the ground pair for 4.25 A, and the family for 48 V DC. Section 6.1.4
specifies the 3 A contact-current test. Source: [GCT product
specification](https://www1.futureelectronics.com/doc/GCT/USB4125ProductSpec.pdf).
The mechanical drawing is the [USB4125 mechanical drawing](https://gct.co/files/drawings/usb4125.pdf).
These are component ratings, not proof that the final PCB carries 3 A.

Preserve this reference in the generated design documentation. Derive the
actual pin numbers from the installed symbol. Verify the selected mechanical
variant, PCB thickness, sourcing and cost; retain explicit UNVERIFIED markers
for anything not established by these references. Do not replace verification
with waivers or change the board area, mounting pitch, connectors or budgets.
