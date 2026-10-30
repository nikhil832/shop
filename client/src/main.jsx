import { lazy, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Route, Routes } from 'react-router';
import { AuthProvider } from './auth.jsx';
import Layout from './components/Layout.jsx';
import CartSync from './cartSync.jsx';
import Home from './pages/Home.jsx';
import Search from './pages/Search.jsx';
import Collection from './pages/Collection.jsx';
import Product from './pages/Product.jsx';
import Cart from './pages/Cart.jsx';
import Checkout from './pages/Checkout.jsx';
import Login from './pages/Login.jsx';
import ForgotPassword from './pages/ForgotPassword.jsx';
import ResetPassword from './pages/ResetPassword.jsx';
import ConfirmEmail from './pages/ConfirmEmail.jsx';
import Order from './pages/Order.jsx';
import Orders from './pages/Orders.jsx';
import Wishlist from './pages/Wishlist.jsx';
import NotFound from './pages/NotFound.jsx';
import { watchSecurityPolicy } from './errorReports.js';
import { rememberReferral } from './referral.js';
import './styles.css';

// After a deploy, an open tab may ask for a page file the new build no longer has: reload once to get the new build.
// Not again within a minute, so a real outage shows Layout's "didn't load" message instead of looping.
function reloadOnce() {
  try {
    const last = Number(sessionStorage.getItem('bazaar.reloadedAt')) || 0;
    if (Date.now() - last < 60_000) return false;
    sessionStorage.setItem('bazaar.reloadedAt', String(Date.now()));
  } catch {
    // Storage blocked: reload anyway (a loop needs storage to be blocked and the file to stay missing).
  }
  window.location.reload();
  return true;
}
// A page loaded on first use. Once its file is in, it renders straight away; `preload()` fetches it before the first
// render when the browser opens on that page, so there's no "Loading…" step (React shows one for at least 300 ms).
function lazyPage(load) {
  let loaded = null;
  const fetchPage = () =>
    load().then((m) => {
      loaded = m.default;
      return m;
    });
  const Lazy = lazy(() =>
    fetchPage().catch((err) => {
      if (reloadOnce()) return new Promise(() => {}); // the page is reloading
      err.pageLoad = true; // reported as a page that didn't load, not a crash (Layout.jsx)
      throw err;
    }),
  );
  function Page(props) {
    const Loaded = loaded;
    return Loaded ? <Loaded {...props} /> : <Lazy {...props} />;
  }
  Page.preload = fetchPage;
  return Page;
}

// Loaded when first opened, so shoppers don't download them: the admin panel (one file with its own routes, so a fresh
// admin page waits for one load, not two), and pages most visitors never see.
const AdminRoutes = lazyPage(() => import('./pages/admin/AdminRoutes.jsx'));
const Invoice = lazyPage(() => import('./pages/Invoice.jsx'));
const CreditNote = lazyPage(() => import('./pages/CreditNote.jsx'));
const ReturnRequest = lazyPage(() => import('./pages/ReturnRequest.jsx'));
const ExchangeRequest = lazyPage(() => import('./pages/ExchangeRequest.jsx'));
const Account = lazyPage(() => import('./pages/Account.jsx'));
const Help = lazyPage(() => import('./pages/Help.jsx'));
const HelpRequest = lazyPage(() => import('./pages/HelpRequest.jsx'));
const Compare = lazyPage(() => import('./pages/Compare.jsx'));
const GiftCards = lazyPage(() => import('./pages/GiftCards.jsx'));
const SharedWishlist = lazyPage(() => import('./pages/SharedWishlist.jsx'));
const Track = lazyPage(() => import('./pages/Track.jsx'));
// Which of them the browser opened on, if any.
const OPENED_ON = [
  [/^\/admin(\/|$)/, AdminRoutes],
  [/^\/orders\/[^/]+\/invoice$/, Invoice],
  [/^\/orders\/[^/]+\/credit-notes\/[^/]+$/, CreditNote],
  [/^\/orders\/[^/]+\/return$/, ReturnRequest],
  [/^\/orders\/[^/]+\/exchange$/, ExchangeRequest],
  [/^\/account$/, Account],
  [/^\/help$/, Help],
  [/^\/help\/[^/]+$/, HelpRequest],
  [/^\/compare$/, Compare],
  [/^\/gift-cards$/, GiftCards],
  [/^\/w\/[^/]+$/, SharedWishlist],
  [/^\/track$/, Track],
].find(([path]) => path.test(window.location.pathname))?.[1];

watchSecurityPolicy();
rememberReferral();

// A failed preload is left to the page itself (it reloads once, or says it didn't load).
Promise.resolve(OPENED_ON?.preload())
  .catch(() => {})
  .finally(() =>
    createRoot(document.getElementById('root')).render(
      <StrictMode>
        <AuthProvider>
          <CartSync />
          <BrowserRouter>
            <Routes>
              <Route element={<Layout />}>
                <Route index element={<Home />} />
                <Route path="search" element={<Search />} />
                <Route path="p/:slug" element={<Product />} />
                <Route path="c/:slug" element={<Collection />} />
                <Route path="cart" element={<Cart />} />
                <Route path="checkout" element={<Checkout />} />
                <Route path="login" element={<Login />} />
                <Route path="register" element={<Login key="register" mode="register" />} />
                <Route path="forgot-password" element={<ForgotPassword />} />
                <Route path="reset-password" element={<ResetPassword />} />
                <Route path="confirm-email" element={<ConfirmEmail />} />
                <Route path="orders" element={<Orders />} />
                <Route path="orders/:id" element={<Order />} />
                <Route path="orders/:id/invoice" element={<Invoice />} />
                <Route path="orders/:id/credit-notes/:returnId" element={<CreditNote />} />
                <Route path="orders/:id/return" element={<ReturnRequest />} />
                <Route path="orders/:id/exchange" element={<ExchangeRequest />} />
                <Route path="wishlist" element={<Wishlist />} />
                <Route path="w/:token" element={<SharedWishlist />} />
                <Route path="track" element={<Track />} />
                <Route path="compare" element={<Compare />} />
                <Route path="gift-cards" element={<GiftCards />} />
                <Route path="account" element={<Account />} />
                <Route path="help" element={<Help />} />
                <Route path="help/:id" element={<HelpRequest />} />
                <Route path="admin/*" element={<AdminRoutes />} />
                <Route path="*" element={<NotFound />} />
              </Route>
            </Routes>
          </BrowserRouter>
        </AuthProvider>
      </StrictMode>,
    ),
  );
