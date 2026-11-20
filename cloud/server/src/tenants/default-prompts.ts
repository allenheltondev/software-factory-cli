// The prompts the CLI package ships (examples/prompts/), as text: what a new workflow starts from
// in the console. `?raw` is Vite's text import (tests); scripts/bundle.mjs gives esbuild the same.
import implement from '../../../../examples/prompts/implement-issue.md?raw';
import review from '../../../../examples/prompts/review-pr.md?raw';
import revise from '../../../../examples/prompts/revise-pr.md?raw';

export const DEFAULT_PROMPTS = { implement, review, revise } as const;
