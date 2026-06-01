/**
 * Tokenizer interface for token-budget enforcement (G4).
 *
 * Implementations count tokens in a string. The frame's max_token_budget
 * is enforced using the tokenizer specified in the frame config.
 *
 * @see spec/schemas/frame.schema.json — "tokenizer" field
 * @see cbp-architecture.html Section VII — "Token budget enforcement"
 */

export interface Tokenizer {
  readonly name: string;
  countTokens(text: string): number;
}

/**
 * Registry of available tokenizers. Implementations register by name.
 * The resolver looks up the tokenizer by the frame config's tokenizer field.
 */
const registry = new Map<string, Tokenizer>();

export function registerTokenizer(tokenizer: Tokenizer): void {
  registry.set(tokenizer.name, tokenizer);
}

export function getTokenizer(name: string): Tokenizer {
  const tokenizer = registry.get(name);
  if (!tokenizer) {
    throw new Error(
      `Unknown tokenizer: "${name}". Registered: [${[...registry.keys()].join(", ")}]`
    );
  }
  return tokenizer;
}

export function listTokenizers(): string[] {
  return [...registry.keys()];
}
