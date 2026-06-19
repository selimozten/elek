export const INTERNAL_DELIVERY_PATTERNS: readonly RegExp[] = [
  /\belek_review_[a-z_]+\b/i,
  /\bargs\s*:\s*must be string\b/i,
  /\bpi-mcp-adapter\b/i,
  /\bMCP\s+call\s+(?:validation\s+)?(?:error|failure|failed)\b/i,
  /\b(?:gateway|transport)(?:-level)?\s+(?:validation\s+)?(?:error|failure|failed)\b/i,
  /\btool[-\s]?call\s+(?:validation\s+)?(?:error|failure|failed)\b/i,
  /\b(?:failed|failing|unable|cannot|could not)\s+to\s+(?:post|create|update).{0,80}\bcomment\b/i,
  /\bconsole output is discarded\b/i,
  /\b(?:I need to|I should|I will|I'll|Let me|I have read|I've read|I have now|I've now)\b/i,
  /^#{2,3}\s+(?:analysis|tool status|internal(?:\s+reasoning)?|scratch(?:\s+work)?|thinking(?:\s+trace)?)\b/im,
] as const;

export function hasInternalDeliveryMarker(text: string): boolean {
  return INTERNAL_DELIVERY_PATTERNS.some((pattern) => pattern.test(text));
}
