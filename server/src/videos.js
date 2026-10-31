import { z } from 'zod';

// Product videos (stage 118): a YouTube video per product, stored as its id only (`video: { youtubeId } | null`), so
// the store decides how it's shown: the product page loads YouTube's privacy-enhanced player
// (www.youtube-nocookie.com, the one frame the security policy allows besides Razorpay) only when "Watch the video" is
// pressed, so nothing reaches Google before that.

const ID = /^[A-Za-z0-9_-]{11}$/;
const HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'youtube-nocookie.com',
  'www.youtube-nocookie.com',
]);

// The video id in a YouTube link: watch?v=, youtu.be/, /shorts/, /embed/, /live/ (with or without https://). Null when
// it isn't one.
export function youtubeId(link) {
  let url;
  try {
    url = new URL(/^https?:\/\//i.test(link) ? link : `https://${link}`);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  let id = null;
  if (host === 'youtu.be' || host === 'www.youtu.be') id = url.pathname.split('/')[1];
  else if (HOSTS.has(host)) {
    const [first, second] = url.pathname.split('/').filter(Boolean);
    if (first === 'watch') id = url.searchParams.get('v');
    else if (['shorts', 'embed', 'live', 'v'].includes(first)) id = second;
  }
  return id && ID.test(id) ? id : null;
}

export const watchUrl = (video) => (video ? `https://www.youtube.com/watch?v=${video.youtubeId}` : null);

// The admin form's field: a YouTube link, or '' / null for none.
export const videoField = z
  .string()
  .trim()
  .max(300)
  .nullable()
  .transform((link, ctx) => {
    if (!link) return null;
    const id = youtubeId(link);
    if (!id) {
      ctx.addIssue({ code: 'custom', message: 'Paste a link to a YouTube video' });
      return z.NEVER;
    }
    return { youtubeId: id };
  });
