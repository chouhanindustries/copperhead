type JsonObject = Record<string, unknown>;

const SEVERITY_RANK: Readonly<Record<string, number>> = {
  ignore: 0,
  warning: 1,
  error: 2,
};

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseProject(text: string): unknown {
  return JSON.parse(text) as unknown;
}

function arrayItemPath(value: unknown, index: number): string {
  if (isObject(value) && typeof value.name === 'string') return `[name=${JSON.stringify(value.name)}]`;
  return `[${index}]`;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (isObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

interface PolicyValues {
  severities: Map<string, string>;
  clearances: Map<string, number>;
  exclusions: Map<string, Set<string>>;
}

function collectPolicyValues(root: unknown): PolicyValues {
  const values: PolicyValues = {
    severities: new Map(),
    clearances: new Map(),
    exclusions: new Map(),
  };

  function visit(value: unknown, at: string): void {
    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, `${at}${arrayItemPath(item, index)}`));
      return;
    }
    if (!isObject(value)) return;

    for (const [key, child] of Object.entries(value)) {
      const childPath = at ? `${at}.${key}` : key;
      if (key === 'rule_severities' && isObject(child)) {
        for (const [rule, severity] of Object.entries(child)) {
          if (typeof severity === 'string') values.severities.set(`${childPath}.${rule}`, severity);
        }
      }
      if (/clearance/i.test(key) && typeof child === 'number') {
        values.clearances.set(childPath, child);
      }
      if (/_exclusions$/i.test(key) && Array.isArray(child)) {
        values.exclusions.set(childPath, new Set(child.map(canonical)));
      }
      visit(child, childPath);
    }
  }

  visit(root, '');
  return values;
}

function severityRegression(before: Map<string, string>, after: Map<string, string>): string | null {
  const paths = new Set([...before.keys(), ...after.keys()]);
  for (const policyPath of [...paths].sort()) {
    const oldValue = before.get(policyPath);
    const newValue = after.get(policyPath);
    if (oldValue === newValue) continue;

    if (oldValue === undefined) {
      if (newValue !== 'error') {
        return `${policyPath} introduces severity ${JSON.stringify(newValue)}; new verification severities must be error`;
      }
      continue;
    }
    if (newValue === undefined) {
      if (oldValue !== 'ignore') return `${policyPath} removes severity ${JSON.stringify(oldValue)}`;
      continue;
    }

    const oldRank = SEVERITY_RANK[oldValue];
    const newRank = SEVERITY_RANK[newValue];
    if (oldRank === undefined || newRank === undefined) {
      return `${policyPath} changes an unknown severity from ${JSON.stringify(oldValue)} to ${JSON.stringify(newValue)}`;
    }
    if (newRank < oldRank) {
      return `${policyPath} lowers severity from ${oldValue} to ${newValue}`;
    }
  }
  return null;
}

function clearanceRegression(before: Map<string, number>, after: Map<string, number>): string | null {
  for (const [policyPath, oldValue] of [...before.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const newValue = after.get(policyPath);
    if (newValue === undefined) return `${policyPath} removes clearance ${oldValue}`;
    if (newValue < oldValue) return `${policyPath} lowers clearance from ${oldValue} to ${newValue}`;
  }
  return null;
}

function exclusionRegression(before: Map<string, Set<string>>, after: Map<string, Set<string>>): string | null {
  for (const [policyPath, newValues] of [...after.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const oldValues = before.get(policyPath) ?? new Set<string>();
    for (const value of newValues) {
      if (!oldValues.has(value)) return `${policyPath} adds a verification exclusion`;
    }
  }
  return null;
}

/**
 * Reject agent-authored project edits that weaken verification settings.
 *
 * This is deliberately a semantic JSON comparison rather than a KiCad load
 * probe: kicad-cli does not load `.kicad_pro` as a schematic or board. Existing
 * ignores remain usable, while tightening policy and repairing invalid JSON are
 * allowed. The comparison covers project severities, explicit clearances, and
 * exclusion lists; it is not a general validator for every KiCad policy file.
 */
export function validateKicadProjectPolicy(beforeText: string, afterText: string): string | null {
  let after: unknown;
  try {
    after = parseProject(afterText);
  } catch (err) {
    return `project JSON would be invalid: ${(err as Error).message}`;
  }

  let before: unknown;
  try {
    before = parseProject(beforeText);
  } catch {
    // Permit an anchored edit that repairs a pre-existing invalid project. A
    // subsequent edit will have a valid baseline and receive normal comparison.
    return null;
  }

  const oldPolicy = collectPolicyValues(before);
  const newPolicy = collectPolicyValues(after);
  return (
    severityRegression(oldPolicy.severities, newPolicy.severities) ??
    clearanceRegression(oldPolicy.clearances, newPolicy.clearances) ??
    exclusionRegression(oldPolicy.exclusions, newPolicy.exclusions)
  );
}
