import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { z } from 'zod';
import { HttpError } from './http.js';

// The admin product form's "Write for me" (routes/aiWriter.js), through Claude's API with the official SDK. On only
// with ANTHROPIC_API_KEY (config.ai); every call costs a little, so it runs only when an admin clicks.
export const DEFAULT_AI_MODEL = 'claude-opus-5-5';
export const MAX_HIGHLIGHTS = 8;

const draftSchema = z.object({
  description: z.string(),
  highlights: z.array(z.string()),
});

const SYSTEM = `You write product listings for Bazaar, an online store in India. Given a product's title, brand, \
category, any facts the store gave and possibly a photo, write:
- description: 2 or 3 short paragraphs (60-120 words in all) in plain, friendly British/Indian English, saying what \
the product is, who it suits and what it's good for. Separate paragraphs with a blank line.
- highlights: 3 to 6 short points (2-6 words each, no full stop), like "USB-C fast charging" or "320 pages". Keep every \
fact from the store among them, reworded if needed.

Use only what you are given or can plainly see in the photo. Never invent specifications, materials, sizes, \
certifications, warranties, prices or offers: when something isn't known, leave it out. No emoji, no exclamation \
marks, no ALL CAPS, no "best", "perfect" or other claims you can't back up.`;

function prompt({ title, brand, category, facts }) {
  return [
    `Title: ${title}`,
    `Brand: ${brand}`,
    `Category: ${category}`,
    facts.length ? `Facts from the store:\n${facts.map((f) => `- ${f}`).join('\n')}` : 'Facts from the store: none',
  ].join('\n');
}

// Trims what came back to what the product form accepts.
const tidy = (draft) => ({
  description: draft.description.trim().slice(0, 5000),
  highlights: draft.highlights
    .map((h) => h.trim().replace(/\.$/, ''))
    .filter(Boolean)
    .map((h) => h.slice(0, 100))
    .slice(0, MAX_HIGHLIGHTS),
});

// What the admin sees when a request fails: the cases they can fix themselves, else Anthropic's reason or "try again".
function failureMessage(err, reason, model) {
  if (err.status === 401) return 'The Anthropic API key was refused. Check ANTHROPIC_API_KEY on the server.';
  if (/credit balance/i.test(reason)) {
    return 'The Anthropic account has no credit left. Add some under Billing at console.anthropic.com.';
  }
  if (err.status === 403 || err.status === 404) {
    return `The Anthropic API key can't use ${model}. Check AI_MODEL on the server.`;
  }
  if (err.status === 400) return `Claude refused the request: ${reason}`;
  return "The writing assistant isn't reachable right now. Try again in a minute.";
}

// `config`: { apiKey, model, apiUrl? } or null (then there's no writer). The key never appears in errors or logs.
export function aiClient(config) {
  if (!config) return null;
  const client = new Anthropic({
    apiKey: config.apiKey,
    ...(config.apiUrl && { baseURL: config.apiUrl }),
    maxRetries: 1,
    timeout: 60_000,
  });
  // Claude Opus and Sonnet can hand a declined request to another model on the server; Haiku can't.
  const fallbacks = !config.model.startsWith('claude-haiku');
  return {
    model: config.model,
    // `image`: { contentType, data (Buffer) } of an uploaded photo, or null. Returns { description, highlights }.
    async writeProduct({ title, brand, category, facts, image }) {
      const content = [
        ...(image
          ? [
              {
                type: 'image',
                source: { type: 'base64', media_type: image.contentType, data: image.data.toString('base64') },
              },
            ]
          : []),
        { type: 'text', text: prompt({ title, brand, category, facts }) },
      ];
      let message;
      try {
        message = await client.beta.messages.parse({
          model: config.model,
          max_tokens: 8000,
          system: SYSTEM,
          messages: [{ role: 'user', content }],
          // Short copy needs little thinking.
          output_config: { effort: 'low', format: betaZodOutputFormat(draftSchema) },
          ...(fallbacks && { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' }),
        });
      } catch (err) {
        // Anthropic's own reason (its error bodies never contain the key), for the server log and the admin.
        const reason = err.error?.error?.message ?? err.message;
        console.error(
          `Claude API request failed: ${err.status ?? ''} ${err.error?.error?.type ?? err.name}: ${reason}` +
            (err.requestID ? ` (request ${err.requestID})` : ''),
        );
        throw new HttpError(502, failureMessage(err, reason, config.model), { expose: true });
      }
      if (message.stop_reason === 'refusal' || !message.parsed_output) {
        throw new HttpError(502, "The writing assistant couldn't write this one. Please write it yourself.", {
          expose: true,
        });
      }
      return tidy(message.parsed_output);
    },
  };
}
