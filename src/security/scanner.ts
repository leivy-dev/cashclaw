/**
 * Sensitive data scanner for content filtering.
 * Provides a second layer of defense to prevent data exfiltration
 * through deliverables, messages, and API calls.
 */

export interface ScanResult {
  blocked: boolean;
  reason?: string;
}

const SENSITIVE_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  // Discord webhook URLs (structural match)
  {
    pattern: /discord\.com\/api\/webhooks\/\d+\/[\w-]+/i,
    label: "Discord webhook URL",
  },
  // PEM-formatted private keys
  {
    pattern: /-----BEGIN\s+[\w\s]{0,20}PRIVATE KEY-----/,
    label: "PEM private key",
  },
  // JWT tokens (three base64url segments)
  {
    pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+/,
    label: "JWT token",
  },
  // OpenAI / Anthropic style API keys (sk-...)
  {
    pattern: /\bsk-[A-Za-z0-9]{20,}/,
    label: "API key (sk-...)",
  },
  // Generic secret/token assignment patterns with real-looking values
  {
    pattern: /(?:api[_-]?key|secret|token)\s*[:=]\s*['"]?[A-Za-z0-9+/]{32,}['"]?/i,
    label: "credential assignment",
  },
];

/**
 * Scan text for sensitive data patterns.
 * Returns { blocked: true, reason } if any pattern matches.
 */
export function scanForSensitiveData(text: string): ScanResult {
  for (const { pattern, label } of SENSITIVE_PATTERNS) {
    if (pattern.test(text)) {
      return {
        blocked: true,
        reason: `Blocked: content contains sensitive data (${label})`,
      };
    }
  }
  return { blocked: false };
}
