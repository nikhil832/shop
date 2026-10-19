import { Outlet } from 'react-router';
import Header from './Header.jsx';

export default function Layout() {
  return (
    <>
      <Header />
      <main className="page">
        <Outlet />
      </main>
      <footer className="footer">Bazaar · a demo store · prices in ₹</footer>
    </>
  );
}
