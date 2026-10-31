import { z } from 'zod';

// Specifications (stage 119): facts about a product as name and value pairs ("RAM": "8 GB"), in the admin's order:
// `specs: [{ name, value }]`, shown as a table on the product page, a row each in Compare, given to the shopping
// assistant and in the product data for search engines. "|" separates them in the product spreadsheet, so neither part
// may hold one, and a name can't hold ":" (it separates name and value there and in the admin form).

export const MAX_SPECS = 20;
export const SEPARATOR = ' | ';

const spec = z.object({
  name: z
    .string()
    .trim()
    .min(1, 'Name each specification')
    .max(40, 'A specification name can be at most 40 characters')
    .refine((s) => !s.includes(':'), "A specification name can't contain a colon"),
  value: z
    .string()
    .trim()
    .min(1, 'Give each specification a value')
    .max(100, 'A specification value can be at most 100 characters'),
});

export const specsField = z
  .array(spec)
  .max(MAX_SPECS, `At most ${MAX_SPECS} specifications`)
  .refine(
    (list) => list.every((s) => !s.name.includes('|') && !s.value.includes('|')),
    'Specifications can\'t contain "|"',
  )
  .refine(
    (list) => new Set(list.map((s) => s.name.toLowerCase())).size === list.length,
    'Give each specification a different name',
  );

// "RAM: 8 GB | Battery: 5000 mAh", for the spreadsheet and the activity log.
export const specsText = (specs = []) => specs.map((s) => `${s.name}: ${s.value}`).join(SEPARATOR);

// The spreadsheet's cell back into specifications; a message (string) when it can't be read.
export function specsFromText(text) {
  const list = text
    .split('|')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const at = part.indexOf(':');
      return at < 0 ? { name: part, value: '' } : { name: part.slice(0, at), value: part.slice(at + 1) };
    });
  if (list.some((s) => !s.value.trim())) return 'Write specifications as Name: Value, separated by |';
  const result = specsField.safeParse(list);
  return result.success ? result.data : result.error.issues[0].message;
}
