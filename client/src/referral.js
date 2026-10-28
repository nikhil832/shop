// Refer a friend (stage 87): a visitor who arrives through a friend's link (`?ref=<code>`) is remembered in this
// browser for REMEMBER_DAYS, and the code goes with the account they make (sign-up or checkout) and the cart quote.
const KEY = 'bazaar.ref';
const REMEMBER_DAYS = 30;
const CODE = /^[A-Z2-9]{8}$/;

export function rememberReferral() {
  const code = new URLSearchParams(window.location.search).get('ref')?.toUpperCase();
  if (!code || !CODE.test(code)) return;
  try {
    localStorage.setItem(KEY, JSON.stringify({ code, at: Date.now() }));
  } catch {
    // Storage blocked: the welcome can't follow them, nothing else breaks.
  }
}

export function referralCode() {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY));
    return saved && CODE.test(saved.code) && Date.now() - saved.at < REMEMBER_DAYS * 86_400_000 ? saved.code : null;
  } catch {
    return null;
  }
}
