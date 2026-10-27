import { randomBytes } from 'node:crypto';
import { hashToken, readCookie, sessionCookieOptions } from './auth.js';
import { logActivity } from './activity.js';
import { newLoginEmail } from './emails.js';
import { isStaff } from './staff.js';

// New-browser login alerts for admins. An admin's browser gets a long-lived random cookie (DEVICE_COOKIE) on its first
// login; `knownDevices` holds a hash of it per account { userId, deviceHash, firstAt, lastAt, browser, ip }. A
// login from a browser the account hasn't used before (no cookie, someone else's, or cookies cleared) emails that admin
// and goes in the activity log. A new IP address alone doesn't: phones change address all the time, and a stolen password
// is always used from a browser the account hasn't seen. Customers get no cookie and no alerts.

export const DEVICE_COOKIE = 'bazaar_device';
const DEVICE_DAYS = 400; // the longest a browser keeps a cookie
export const DEVICE_FORGET_DAYS = 365; // a browser unused this long counts as new again (TTL on lastAt)

// "Chrome on Windows", from the user agent; good enough for a person to recognise their own browser.
export function describeBrowser(userAgent = '') {
  const browser =
    [
      [/Edg\//, 'Edge'],
      [/OPR\/|Opera/, 'Opera'],
      [/SamsungBrowser\//, 'Samsung Internet'],
      [/Firefox\/|FxiOS\//, 'Firefox'],
      [/Chrome\/|CriOS\//, 'Chrome'],
      [/Safari\//, 'Safari'],
    ].find(([re]) => re.test(userAgent))?.[1] ?? 'An unknown browser';
  const system = [
    [/iPhone/, 'iPhone'],
    [/iPad/, 'iPad'],
    [/Android/, 'Android'],
    [/CrOS/, 'ChromeOS'],
    [/Windows/, 'Windows'],
    [/Mac OS X|Macintosh/, 'Mac'],
    [/Linux/, 'Linux'],
  ].find(([re]) => re.test(userAgent))?.[1];
  return system ? `${browser} on ${system}` : browser;
}

// Called after every successful login (password, two-step code, or reset link). For admins: makes sure this browser
// has a device cookie, records it for the account, and alerts when it's new. Never throws: the login stands.
export async function noteAdminLogin(ctx, req, res, user, ip) {
  if (!isStaff(user)) return;
  try {
    let token = readCookie(req, DEVICE_COOKIE);
    if (!token || !/^[\w-]{43}$/.test(token)) {
      token = randomBytes(32).toString('base64url');
      res.cookie(DEVICE_COOKIE, token, { ...sessionCookieOptions(req), maxAge: DEVICE_DAYS * 86_400_000 });
    }
    const now = new Date();
    const browser = describeBrowser(req.get('user-agent'));
    // One upsert: only the request that creates the record alerts, even if two logins arrive together.
    const result = await ctx.db
      .collection('knownDevices')
      .updateOne(
        { userId: user._id, deviceHash: hashToken(`device:${token}`) },
        { $set: { lastAt: now, browser, ip }, $setOnInsert: { firstAt: now } },
        { upsert: true },
      );
    if (!result.upsertedCount) return;
    await logActivity(ctx.db, user, {
      area: 'accounts',
      action: 'Logged in from a new browser',
      target: { label: user.email, path: null },
      changes: [
        { field: 'Browser', to: browser },
        { field: 'IP address', to: ip },
      ],
    });
    try {
      await ctx.mail.send({
        to: { email: user.email, name: user.name },
        ...newLoginEmail(user, { at: now, browser, ip }, ctx.config.mail?.publicUrl),
      });
    } catch (err) {
      console.error('Could not send a new-browser login alert:', err.message);
    }
  } catch (err) {
    console.error('Could not check the login for a new browser:', err.message);
  }
}
