import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as client from '../../client/src/storeFacts.js';
import { FREE_DELIVERY_MIN } from '../src/routes/orders.js';
import { RETURN_DAYS } from '../src/routes/returns.js';
import { DEAL_PERCENT } from '../src/routes/catalog.js';
import { MAX_MESSAGE } from '../src/giftOptions.js';

test('the home page promises what the server does', () => {
  assert.equal(client.FREE_DELIVERY_MIN, FREE_DELIVERY_MIN);
  assert.equal(client.RETURN_DAYS, RETURN_DAYS);
  assert.equal(client.DEAL_PERCENT, DEAL_PERCENT);
  assert.equal(client.GIFT_MESSAGE_MAX, MAX_MESSAGE);
});
