// Security headers on every response: the safety net if text a customer wrote (reviews, questions, help requests, the
// chat) ever slipped into a page as code, and a stop to other sites showing the store (or its admin panel) in a frame.
// Only the production server sends pages through Express; Vite's dev server serves its own, so `npm run dev` is
// unaffected (its hot reload needs inline scripts).

// Razorpay's checkout (loaded only when someone pays online) is the one outside code: its script from
// checkout.razorpay.com opens a frame from api.razorpay.com, which talks to other *.razorpay.com addresses. Razorpay
// publishes no list, so its whole domain is allowed for those uses; anything blocked is reported by the browser to
// Admin → Errors (client/src/errorReports.js).
const RAZORPAY = 'https://*.razorpay.com';

export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  // The built app has no inline scripts; JSON-LD (preview.js) is data, not run, so it needs no permission.
  `script-src 'self' https://checkout.razorpay.com`,
  // Razorpay's checkout adds its own <style> and style attributes. React's style props are set through the DOM and
  // would pass without this, as would our stylesheet.
  "style-src 'self' 'unsafe-inline'",
  // data: for the sample catalog's drawings, the favicon and the two-step QR code; blob: for photos being shrunk.
  `img-src 'self' data: blob: ${RAZORPAY}`,
  "font-src 'self' data:",
  `connect-src 'self' ${RAZORPAY}`,
  `frame-src ${RAZORPAY}`,
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

const HEADERS = {
  'Content-Security-Policy': CONTENT_SECURITY_POLICY,
  // For browsers that don't read frame-ancestors.
  'X-Frame-Options': 'DENY',
  // Files are only what their Content-Type says (an upload can't be read as a script or a page).
  'X-Content-Type-Options': 'nosniff',
  // Other sites see only "bazaar…onrender.com", never the page (order, search or account addresses).
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  // Nothing in the store uses these; a photo picker opens the phone's own camera app, which this doesn't affect.
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), usb=()',
  // Pages opened by other sites can't reach this window; Razorpay's own pop-ups (bank and UPI pages) still can.
  'Cross-Origin-Opener-Policy': 'same-origin-allow-popups',
};

// A year of HTTPS only. Sent only over HTTPS (behind Render's proxy, via trust proxy): browsers ignore it over HTTP,
// and localhost must stay reachable without a certificate.
export const HSTS = 'max-age=31536000';

export function securityHeaders(req, res, next) {
  res.set(HEADERS);
  if (req.secure) res.set('Strict-Transport-Security', HSTS);
  next();
}
