// What the store promises and shows, in the server's own numbers (server/test/storeFacts.test.js keeps them equal to
// FREE_DELIVERY_MIN in routes/orders.js, RETURN_DAYS in routes/returns.js and DEAL_PERCENT in routes/catalog.js).
export const FREE_DELIVERY_MIN = 49900; // paise
export const RETURN_DAYS = 7;
// What counts as a deal besides a running sale (DEAL_PERCENT in routes/catalog.js), for the search filter's label.
export const DEAL_PERCENT = 40;
