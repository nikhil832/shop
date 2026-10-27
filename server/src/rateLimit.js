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

const IST_OFFSET = 330 * 60_000;
// Today in India time, as the day the daily allowances below count.
export const indiaDay = (now) => new Date(now.getTime() + IST_OFFSET).toISOString().slice(0, 10);

// "At most `cap` a day" for the whole store, counted on a `settings` document (`{ _id, day, used }`, next to whatever
// else it holds): one atomic pipeline update that starts again on a new India-time day. Returns true when this use is
// allowed (and counted).
export async function takeDailyCall(db, settingsId, cap, now = new Date()) {
  const day = indiaDay(now);
  const doc = await db.collection('settings').findOneAndUpdate(
    { _id: settingsId },
    [
      {
        $set: {
          used: {
            $cond: [{ $ne: ['$day', day] }, 1, { $cond: [{ $lt: ['$used', cap] }, { $add: ['$used', 1] }, '$used'] }],
          },
          taken: { $or: [{ $ne: ['$day', day] }, { $lt: ['$used', cap] }] },
          day,
        },
      },
    ],
    { upsert: true, returnDocument: 'after' },
  );
  return doc.taken;
}

// How many of today's calls have been used, from the same document.
export const usedToday = (doc, now = new Date()) => (doc?.day === indiaDay(now) ? doc.used : 0);
