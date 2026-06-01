export type { Tokenizer } from "./tokenizer.js";
export { registerTokenizer, getTokenizer, listTokenizers } from "./tokenizer.js";
export { o200kTokenizer } from "./o200k.js";
export { lengthFallbackTokenizer } from "./length-fallback.js";

// Auto-register built-in tokenizers on import
import { registerTokenizer } from "./tokenizer.js";
import { o200kTokenizer } from "./o200k.js";
import { lengthFallbackTokenizer } from "./length-fallback.js";

registerTokenizer(o200kTokenizer);
registerTokenizer(lengthFallbackTokenizer);
