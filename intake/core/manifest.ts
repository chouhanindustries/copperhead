// Verification manifest: the exportable audit artifact. Pure module.
// The timestamp is injected by the caller; core never reads the clock.

import {
  ChangeDescriptor,
  Constraint,
  ExtractedFact,
  VerificationManifest,
  Verdict,
} from "./model";
import { evaluate } from "./engine";

export interface ManifestInputs {
  timestampISO: string;
  part: string;
  descriptor: ChangeDescriptor;
  constraints: Constraint[];
  checksRun: string[];
  factsUsed: ExtractedFact[];
  verdict: Verdict;
  digitiseModel: string;
  extractorModel: string;
}

export function buildManifest(inputs: ManifestInputs): VerificationManifest {
  return {
    timestampISO: inputs.timestampISO,
    part: inputs.part,
    change: inputs.descriptor.label,
    checksRun: inputs.checksRun,
    factsUsed: inputs.factsUsed,
    verdict: inputs.verdict,
    extraction: {
      digitiseModel: inputs.digitiseModel,
      extractorModel: inputs.extractorModel,
    },
    inputs: {
      descriptor: inputs.descriptor,
      constraints: inputs.constraints,
    },
  };
}

/**
 * Re-run the engine on a manifest's stored inputs. Returns true when the
 * recomputed verdict is identical to the manifest's verdict: every manifest
 * is a reproducible audit record.
 */
export function reproduces(manifest: VerificationManifest): boolean {
  const rerun = evaluate(manifest.inputs.descriptor, manifest.factsUsed, manifest.inputs.constraints);
  return JSON.stringify(rerun.verdict) === JSON.stringify(manifest.verdict);
}
