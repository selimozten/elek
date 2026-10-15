/**
 * Provider credential preflight.
 *
 * Without a key Pi exits with "No API key found … Use /login", after Elek has
 * already posted a tracking comment. On fork pull_request runs GitHub
 * withholds repository secrets and grants a read-only token, so that path
 * also fails to post anything. Checking before any GitHub writes lets fork
 * runs skip cleanly and misconfigured runs fail with the input to fix.
 */

interface ProviderKey {
  /** Env vars Elek forwards to Pi for this provider; any one suffices. */
  envVars: string[];
  /** Action input that populates the env var. */
  input: string;
  /** Conventional repository secret name for the setup hint. */
  secret: string;
}

/**
 * Only providers whose key Elek wires through an action input. Other
 * providers (Bedrock, Vertex, custom models) authenticate in ways Elek cannot
 * see, so Pi stays the authority for them.
 */
const PROVIDER_KEYS: Record<string, ProviderKey> = {
  anthropic: { envVars: ["ANTHROPIC_API_KEY"], input: "anthropic_api_key", secret: "ANTHROPIC_API_KEY" },
  openai: { envVars: ["OPENAI_API_KEY"], input: "openai_api_key", secret: "OPENAI_API_KEY" },
  google: { envVars: ["GEMINI_API_KEY", "GOOGLE_API_KEY"], input: "google_api_key", secret: "GOOGLE_API_KEY" },
  deepseek: { envVars: ["DEEPSEEK_API_KEY"], input: "deepseek_api_key", secret: "DEEPSEEK_API_KEY" },
  groq: { envVars: ["GROQ_API_KEY"], input: "groq_api_key", secret: "GROQ_API_KEY" },
  mistral: { envVars: ["MISTRAL_API_KEY"], input: "mistral_api_key", secret: "MISTRAL_API_KEY" },
  together: { envVars: ["TOGETHER_API_KEY"], input: "together_api_key", secret: "TOGETHER_API_KEY" },
  xai: { envVars: ["XAI_API_KEY"], input: "xai_api_key", secret: "XAI_API_KEY" },
  openrouter: { envVars: ["OPENROUTER_API_KEY"], input: "openrouter_api_key", secret: "OPENROUTER_API_KEY" },
  opencode: { envVars: ["OPENCODE_API_KEY"], input: "opencode_api_key", secret: "OPENCODE_API_KEY" },
  "opencode-go": { envVars: ["OPENCODE_API_KEY"], input: "opencode_api_key", secret: "OPENCODE_API_KEY" },
};

/**
 * Events whose fork-PR runs execute in the fork's context, without secrets.
 * pull_request_target and issue_comment run in the base repository context.
 */
const FORK_CONTEXT_EVENTS = new Set([
  "pull_request",
  "pull_request_review",
  "pull_request_review_comment",
]);

export type CredentialPreflight =
  | { action: "continue" }
  | { action: "skip"; message: string }
  | { action: "fail"; message: string };

export interface CredentialPreflightRequest {
  provider: string;
  env: Record<string, string | undefined>;
  /** Raw GITHUB_EVENT_NAME, before pull_request_target is normalized. */
  rawEventName: string | undefined;
  isForkPR: boolean;
}

export function credentialPreflight(request: CredentialPreflightRequest): CredentialPreflight {
  const key = Object.hasOwn(PROVIDER_KEYS, request.provider)
    ? PROVIDER_KEYS[request.provider]
    : undefined;
  if (key?.envVars.some((name) => Boolean(request.env[name]?.trim()))) {
    return { action: "continue" };
  }

  // Unmapped providers skip too: the read-only fork token cannot post a review.
  if (request.isForkPR && FORK_CONTEXT_EVENTS.has(request.rawEventName ?? "")) {
    return {
      action: "skip",
      message:
        `Skipping elek review: this pull request comes from a fork, and GitHub does not ` +
        `pass repository secrets or a write token to fork workflows. ` +
        `A maintainer can review it from an issue_comment-triggered workflow, which runs ` +
        `with the base repository's secrets.`,
    };
  }

  if (!key) return { action: "continue" };

  return {
    action: "fail",
    message:
      `No API key for provider "${request.provider}": ${key.envVars.join(" / ")} is empty. ` +
      `Add a repository secret (for example ${key.secret}) and pass it to the action with ` +
      `\`${key.input}: \${{ secrets.${key.secret} }}\`.`,
  };
}
