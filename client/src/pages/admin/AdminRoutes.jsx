import { Navigate, Route, Routes } from 'react-router';
import { useAuth } from '../../auth.jsx';
import { can } from '../../permissions.js';
import AdminActivity from './AdminActivity.jsx';
import AdminCategories from './AdminCategories.jsx';
import AdminCoupons from './AdminCoupons.jsx';
import AdminDashboard from './AdminDashboard.jsx';
import AdminDelivery from './AdminDelivery.jsx';
import AdminErrors from './AdminErrors.jsx';
import AdminGst from './AdminGst.jsx';
import AdminHelp from './AdminHelp.jsx';
import AdminImport from './AdminImport.jsx';
import AdminLayout, { ADMIN_TABS } from './AdminLayout.jsx';
import AdminStaff from './AdminStaff.jsx';
import AdminOrder from './AdminOrder.jsx';
import AdminOrders from './AdminOrders.jsx';
import AdminPackingSlips from './AdminPackingSlips.jsx';
import AdminProduct from './AdminProduct.jsx';
import AdminProducts from './AdminProducts.jsx';
import AdminQuestions from './AdminQuestions.jsx';
import AdminReturns from './AdminReturns.jsx';
import AdminReviews from './AdminReviews.jsx';
import Invoice from '../Invoice.jsx';
import CreditNote from '../CreditNote.jsx';

// /admin: the dashboard for admins; staff start on their first tab (the dashboard shows sales).
function AdminHome() {
  const { user } = useAuth();
  if (can(user, '*')) return <AdminDashboard />;
  const first = ADMIN_TABS.find((tab) => can(user, tab.permission));
  return <Navigate to={first.to} replace />;
}

// Every admin page, under /admin/*. main.jsx loads this file the first time an admin page opens, so shoppers never
// download the admin panel; once loaded, moving between admin pages needs nothing more.
export default function AdminRoutes() {
  return (
    <Routes>
      <Route element={<AdminLayout />}>
        <Route index element={<AdminHome />} />
        <Route path="orders" element={<AdminOrders />} />
        <Route path="orders/slips" element={<AdminPackingSlips />} />
        <Route path="orders/:id" element={<AdminOrder />} />
        <Route path="orders/:id/invoice" element={<Invoice admin />} />
        <Route path="orders/:id/credit-notes/:returnId" element={<CreditNote admin />} />
        <Route path="products" element={<AdminProducts />} />
        <Route path="products/new" element={<AdminProduct />} />
        <Route path="products/import" element={<AdminImport />} />
        <Route path="products/:id" element={<AdminProduct />} />
        <Route path="categories" element={<AdminCategories />} />
        <Route path="reviews" element={<AdminReviews />} />
        <Route path="questions" element={<AdminQuestions />} />
        <Route path="coupons" element={<AdminCoupons />} />
        <Route path="returns" element={<AdminReturns />} />
        <Route path="delivery" element={<AdminDelivery />} />
        <Route path="gst" element={<AdminGst />} />
        <Route path="activity" element={<AdminActivity />} />
        <Route path="errors" element={<AdminErrors />} />
        <Route path="help" element={<AdminHelp />} />
        <Route path="staff" element={<AdminStaff />} />
      </Route>
    </Routes>
  );
}
