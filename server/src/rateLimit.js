import { randomUUID } from 'node:crypto';

// "At most `max` per hour" for one key (e.g. reset emails for one account), race-free: one `rateLimits` document per
// key holds the recent uses, and a single update keeps those from the last hour and adds this one only if there's
// room. One document's update is atomic, so requests arriving together can't all get past a count taken before any of
// them was recorded. Returns true when this use is allowed (and counted).
export async function takeHourlySlot(db, key, max) {
  const now = new Date();
  const id = randomUUID();
  const hourAgo = new Date(now.getTime() - 3_600_000);
  const doc = await db.collection('rateLimits').findOneAndUpdate(
    { _id: key },
    [
      {
        $set: {
          uses: {
            $let: {
              vars: {
                recent: { $filter: { input: { $ifNull: ['$uses', []] }, cond: { $gt: ['$$this.at', hourAgo] } } },
              },
              in: {
                $cond: [
                  { $lt: [{ $size: '$$recent' }, max] },
                  { $concatArrays: ['$$recent', [{ at: now, id }]] },
                  '$$recent',
                ],
              },
            },
          },
          // Removed by a TTL index once the last use is an hour old.
          expiresAt: new Date(now.getTime() + 3_600_000),
        },
      },
    ],
    { upsert: true, returnDocument: 'after' },
  );
  return doc.uses.some((u) => u.id === id);
}
