import { z } from 'zod';

// Low stock (stage 131): a product is low when its stock, or any one of its options' stock, is at or below its level:
// its own `lowStockAt`, set in the admin form, or LOW_STOCK. Since stage 135 an option may have its own `lowStockAt`
// too (null: the product's), so a size that sells fast can warn earlier than the rest. Fast sellers can warn earlier and slow ones later. Shared
// by the dashboard, the morning email, the weekly note and the admin products filter; imports nothing of the store's,
// so all of them can use it.
export const LOW_STOCK = 5;
export const MAX_LEVEL = 1000;

export const lowStockAtField = z
  .number()
  .int('Use a whole number for the low-stock level')
  .min(0, 'The low-stock level is 0 or more')
  .max(MAX_LEVEL, `The low-stock level is at most ${MAX_LEVEL}`)
  .nullable();

// A product document's level.
export const levelOf = (p) => p.lowStockAt ?? LOW_STOCK;
// An option's level: its own, else its product's.
export const variantLevelOf = (p, v) => v.lowStockAt ?? levelOf(p);

const LEVEL = { $ifNull: ['$lowStockAt', LOW_STOCK] };
// The filter for low products (a whole-collection scan, fine at this size).
export const LOW = {
  $expr: {
    $or: [
      { $lte: ['$stock', LEVEL] },
      {
        $anyElementTrue: [
          {
            $map: {
              input: { $ifNull: ['$variants', []] },
              as: 'v',
              in: { $lte: ['$$v.stock', { $ifNull: ['$$v.lowStockAt', LEVEL] }] },
            },
          },
        ],
      },
    ],
  },
};
