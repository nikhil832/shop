import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Route, Routes } from 'react-router';
import { AuthProvider } from './auth.jsx';
import Layout from './components/Layout.jsx';
import Home from './pages/Home.jsx';
import Search from './pages/Search.jsx';
import Product from './pages/Product.jsx';
import Cart from './pages/Cart.jsx';
import Checkout from './pages/Checkout.jsx';
import Login from './pages/Login.jsx';
import ForgotPassword from './pages/ForgotPassword.jsx';
import ResetPassword from './pages/ResetPassword.jsx';
import ConfirmEmail from './pages/ConfirmEmail.jsx';
import Invoice from './pages/Invoice.jsx';
import ReturnRequest from './pages/ReturnRequest.jsx';
import AdminReturns from './pages/admin/AdminReturns.jsx';
import Order from './pages/Order.jsx';
import Orders from './pages/Orders.jsx';
import Wishlist from './pages/Wishlist.jsx';
import Account from './pages/Account.jsx';
import NotFound from './pages/NotFound.jsx';
import AdminCategories from './pages/admin/AdminCategories.jsx';
import AdminDashboard from './pages/admin/AdminDashboard.jsx';
import AdminLayout from './pages/admin/AdminLayout.jsx';
import AdminOrder from './pages/admin/AdminOrder.jsx';
import AdminOrders from './pages/admin/AdminOrders.jsx';
import AdminProduct from './pages/admin/AdminProduct.jsx';
import AdminProducts from './pages/admin/AdminProducts.jsx';
import AdminReviews from './pages/admin/AdminReviews.jsx';
import AdminCoupons from './pages/admin/AdminCoupons.jsx';
import './styles.css';

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <AuthProvider>
      <BrowserRouter>
        <Routes>
          <Route element={<Layout />}>
            <Route index element={<Home />} />
            <Route path="search" element={<Search />} />
            <Route path="p/:slug" element={<Product />} />
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
            <Route path="orders/:id/return" element={<ReturnRequest />} />
            <Route path="wishlist" element={<Wishlist />} />
            <Route path="account" element={<Account />} />
            <Route path="admin" element={<AdminLayout />}>
              <Route index element={<AdminDashboard />} />
              <Route path="orders" element={<AdminOrders />} />
              <Route path="orders/:id" element={<AdminOrder />} />
              <Route path="orders/:id/invoice" element={<Invoice admin />} />
              <Route path="products" element={<AdminProducts />} />
              <Route path="products/new" element={<AdminProduct />} />
              <Route path="products/:id" element={<AdminProduct />} />
              <Route path="categories" element={<AdminCategories />} />
              <Route path="reviews" element={<AdminReviews />} />
              <Route path="coupons" element={<AdminCoupons />} />
              <Route path="returns" element={<AdminReturns />} />
            </Route>
            <Route path="*" element={<NotFound />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  </StrictMode>,
);
