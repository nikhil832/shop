import { ObjectId } from 'mongodb';

// The address book: `users.addresses` [{ _id, label, name, phone, line1, line2, city, state, pincode }], at most
// MAX_ADDRESSES, the first being the default (checkout picks it, the delivery check starts from its PIN). Accounts
// from before stage 54 had one `users.address`; migrateAddresses() turns it into the first entry at startup.

export const MAX_ADDRESSES = 10;
const FIELDS = ['name', 'phone', 'line1', 'line2', 'city', 'state', 'pincode'];

export const toAddress = (a) => ({
  id: a._id.toString(),
  label: a.label ?? '',
  ...Object.fromEntries(FIELDS.map((f) => [f, a[f] ?? ''])),
});

// The address fields alone (from a parsed `address`), for storing or comparing.
const fieldsOf = (address) => Object.fromEntries(FIELDS.map((f) => [f, address[f] ?? '']));

// Matches an account that already has exactly this address, in a query.
export const hasAddress = (address) => ({ addresses: { $elemMatch: fieldsOf(address) } });

// After an order: an address not in the book is added to it (at the end, so the default stays) when the customer
// asked to save it and there's room. One update, with the checks in its filter; pass `session` inside a transaction.
export async function rememberAddress(users, userId, address, { session } = {}) {
  await users.updateOne(
    {
      _id: userId,
      addresses: { $not: { $elemMatch: fieldsOf(address) } },
      [`addresses.${MAX_ADDRESSES - 1}`]: { $exists: false },
    },
    { $push: { addresses: { _id: new ObjectId(), label: '', ...fieldsOf(address) } } },
    { session },
  );
}

export const newAddress = (address, label = '') => ({ _id: new ObjectId(), label, ...fieldsOf(address) });

// Accounts with the old single `address` get it as their first (default) entry; rerunnable, and an account changed
// meanwhile (it already has `addresses`) is left alone.
export async function migrateAddresses(db) {
  const users = db.collection('users');
  const old = await users
    .find({ address: { $type: 'object' }, addresses: { $exists: false } }, { projection: { address: 1 } })
    .toArray();
  for (const user of old) {
    await users.updateOne(
      { _id: user._id, addresses: { $exists: false } },
      { $set: { addresses: [newAddress(user.address)] }, $unset: { address: '' } },
    );
  }
  return old.length;
}
