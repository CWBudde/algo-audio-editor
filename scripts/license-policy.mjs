// Exact SPDX expressions are evaluated without executing package metadata.
export const defaultPolicy = {
  code: ["MIT", "BSD-1-Clause", "BSD-2-Clause", "BSD-3-Clause", "Apache-2.0"],
  assets: [],
};

export function licenseAllowed(expression, allowed) {
  const tokens = expression.match(/\(|\)|[A-Za-z0-9.+-]+/g) ?? [];
  if (tokens.join("") !== expression.replace(/\s/g, "")) return false;
  let position = 0;
  const primary = () => {
    const token = tokens[position++];
    if (token === "(") {
      const value = or();
      if (tokens[position++] !== ")") throw new Error("Unclosed expression");
      return value;
    }
    if (!token || ["AND", "OR", "WITH", ")"].includes(token)) throw new Error("Invalid license");
    return allowed.includes(token);
  };
  const and = () => {
    let value = primary();
    while (tokens[position] === "AND") {
      position++;
      const right = primary();
      value = value && right;
    }
    return value;
  };
  const or = () => {
    let value = and();
    while (tokens[position] === "OR") {
      position++;
      const right = and();
      value = value || right;
    }
    return value;
  };
  try {
    const value = or();
    return position === tokens.length && value;
  } catch {
    return false;
  }
}

export function policyFindings(entries, policy = defaultPolicy) {
  return entries
    .filter((entry) => entry.scope === "runtime")
    .flatMap((entry) => {
      const findings = [];
      const identity = { name: entry.name, version: entry.version, ecosystem: entry.ecosystem };
      if (!entry.texts?.some((text) => text.text?.trim()))
        findings.push({
          ...identity,
          kind: "missing-text",
          message: "No license text was collected.",
        });
      const allowed = entry.asset ? [...policy.code, ...policy.assets] : policy.code;
      if (!licenseAllowed(entry.license ?? "", allowed))
        findings.push({
          ...identity,
          kind: "policy",
          message: `License ${entry.license || "UNKNOWN"} requires a policy decision or replacement.`,
        });
      return findings;
    });
}
