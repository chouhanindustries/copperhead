# Brief: Dual brushed-DC motor driver

![Dual brushed-DC motor driver concept render](../images/dual-brushed-dc-motor-driver.webp)

*AI-generated illustrative concept render, not a KiCad output or placement reference; component selection and layout are intentionally unresolved.*

## What it is

A controller-less dual brushed-DC motor driver for a small battery-powered robot. It accepts independent logic-level commands from an external controller, drives two motors from a 2S or 3S battery, and exposes current and fault signals for both channels. The interesting parts are sizing the power path for simultaneous stalls and handling energy returned by braking, not adding local intelligence.

## Must do

1. Drive two brushed-DC motors independently in forward and reverse.
2. Provide independent brake and coast states for each motor.
3. Accept 20kHz PWM and direction or equivalent control signals from 3.3V logic on both channels.
4. Measure each motor's current independently and provide an analog current-sense output to the external controller.
5. Report driver faults to the external controller, independently per channel where the chosen driver supports it.
6. Protect the battery input against reverse polarity.
7. Suppress motor and supply transients, including energy returned to the supply during braking and rapid reversal.
8. Remain safe when powered from a bench supply that cannot sink current.

## Budgets

- Motor supply: 6V to 13V operating range, covering 2S and 3S battery packs.
- Continuous motor current: 3A per channel, with both channels loaded simultaneously.
- Stall current: 8A per channel for 500ms, including simultaneous 16A combined stalls.
- Thermal rise: less than 50C above ambient for every component at the continuous rating, in still air.
- Disabled current: under 100uA total from the motor supply.
- Current-sense accuracy: within +/-10% from 0.5A to 8A on each channel.
- Board area: no more than 60mm x 40mm.
- BOM cost: under $18 at qty 100.

## Constraints

- No onboard MCU. All command, PWM, current measurement, and fault handling interfaces go to an external controller.
- Control inputs must be proven compatible with 3.3V logic from their datasheet VIH limits. A part described only as "5V tolerant" is not sufficient evidence.
- Use a 4-layer board with 2oz copper on the outer layers.
- Size the complete high-current path, including connectors, protection, copper, vias, and driver package, for a 16A combined 500ms pulse as well as the continuous load.
- All parts connected to a motor output or the motor supply must be rated for at least 24V.
- The PCB assembly process must support exposed-pad power packages, including the required paste pattern, thermal vias, and underside copper spreading.
- Keep the high-di/dt motor-current loops compact and separated from the logic connector, current-sense signals, and their return paths.
- Provide a local path to absorb or clamp regenerative energy so that braking or rapid reversal cannot depend on the source sinking current. Justify the worst-case supply-rail rise against every voltage rating.

## Out of scope

- Motor encoders or position control.
- Closed-loop speed or torque control.
- Battery charging or cell balancing.
- The external controller, its firmware, and robot wiring beyond the board connectors.
- Driving stepper, brushless, or more than two brushed-DC motors.

## Notes

These numbers are intended to close with roughly 20% design margin, but only if the peak case is treated as a first-class operating condition. The generated design rationale must show the pulse-current path, I-squared-R loss, component and copper temperature rise, and regenerative-energy arithmetic before selecting footprints or laying out the board. Modern integrated dual H-bridge devices can cover this operating region, but the brief does not mandate a particular part or topology.

The motor's 3A running current is not its driver rating. Each channel must carry an 8A stall for 500ms, and both motors can stall together, so a nominal "3A driver" or a connector and input path sized only for 6A combined is not acceptable. Check peak limits, over-current trip behavior, package transient thermal impedance, MOSFET resistance at temperature, connector ratings, and copper loss against the simultaneous-stall case.

Braking and rapid reversal turn the motors into generators. A battery may absorb that returned energy, but a bench supply often cannot; without enough local absorption, the supply rail rises until protection trips or a component fails. Estimate the energy from the motor and load inertia, then show how bulk capacitance, a clamp, a dump path, or another justified mechanism holds the rail below the rated limit with margin.

Logic compatibility also needs a number, not a label. "5V tolerant" describes the maximum safe input voltage and says nothing about whether 3.3V is guaranteed to read high. Compare the external controller's worst-case VOH with the selected driver's VIH requirement for every command and PWM input.
