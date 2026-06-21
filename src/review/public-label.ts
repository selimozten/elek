export function publicModelLabelFor(
  internalModelLabel: string,
  env: { ELEK_PUBLIC_MODEL_LABEL?: string } = process.env,
): string {
  const label = env.ELEK_PUBLIC_MODEL_LABEL?.trim();
  return label || internalModelLabel;
}

export function modelLabelRedactionTerms(labels: Array<string | undefined>): string[] {
  const terms = new Set<string>();
  for (const label of labels) {
    const clean = label?.trim();
    if (!clean) continue;
    terms.add(clean);
    const parts = clean.split("/").map((part) => part.trim()).filter(Boolean);
    const tail = parts.at(-1);
    if (tail) terms.add(tail);
  }
  return [...terms].sort((a, b) => b.length - a.length);
}
