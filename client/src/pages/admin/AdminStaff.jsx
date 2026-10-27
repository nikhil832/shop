import { useState } from 'react';
import { request } from '../../api.js';
import { useFetch } from '../../useFetch.js';

// What each role may do, for the page's explanation (the server's list is PERMISSIONS in server/src/staff.js).
const ROLE_NOTES = {
  packer: 'Packer: sees orders, marks them shipped or delivered, adds tracking and notes, prints packing slips.',
  support: 'Support: sees orders and their notes, answers questions and help requests, hides or shows reviews.',
};

// Staff accounts (stage 66): admins give existing customer accounts a staff role, change it, or take it away. Admin
// itself is only granted from the command line.
export default function AdminStaff() {
  const [version, setVersion] = useState(0);
  const { data, error } = useFetch('/admin/staff', version);
  const [state, setState] = useState({ busy: false, error: null, done: null });

  async function save(action, done) {
    setState({ busy: true, error: null, done: null });
    try {
      await action();
      setState({ busy: false, error: null, done });
      setVersion((v) => v + 1);
    } catch (err) {
      setState({ busy: false, error: err.message, done: null });
    }
  }

  function add(e) {
    e.preventDefault();
    const form = e.currentTarget;
    const { email, role } = Object.fromEntries(new FormData(form));
    save(async () => {
      await request('/admin/staff', { method: 'POST', body: { email, role } });
      form.reset();
    }, `${email} is now ${data.roles[role]}.`);
  }

  const setRole = (person, role) =>
    save(
      () => request(`/admin/staff/${person.id}`, { method: 'PATCH', body: { role } }),
      role === 'user' ? `${person.name} is no longer staff.` : `${person.name} is now ${data.roles[role]}.`,
    );

  return (
    <section className="panel">
      <div className="admin-head">
        <h1>Staff</h1>
      </div>
      <p className="muted small">
        Give someone a staff role to let them help without the full admin account. They need a Bazaar account first
        (they sign up as a customer). Changes apply straight away.
      </p>
      <ul className="small">
        {Object.entries(ROLE_NOTES).map(([role, note]) => (
          <li key={role}>{note}</li>
        ))}
        <li>Neither can cancel or refund orders, change products, prices, coupons or settings, or see sales.</li>
      </ul>
      {error && <p className="error">{error.message}</p>}
      {data && (
        <div className="table-wrap">
          <table className="admin-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Role</th>
                <th>Two-step login</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((p) => (
                <tr key={p.id}>
                  <td>
                    {p.name}
                    <span className="muted small block">{p.email}</span>
                  </td>
                  <td>
                    {p.role === 'admin' ? (
                      'Admin'
                    ) : (
                      <select
                        aria-label={`Role of ${p.name}`}
                        value={p.role}
                        disabled={state.busy}
                        onChange={(e) => setRole(p, e.target.value)}
                      >
                        {Object.entries(data.roles).map(([role, label]) => (
                          <option key={role} value={role}>
                            {label}
                          </option>
                        ))}
                        <option value="user">Not staff</option>
                      </select>
                    )}
                  </td>
                  <td>{p.twoStep ? 'On' : 'Off'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {data && (
        <form className="staff-form" onSubmit={add} aria-label="Add staff">
          <label>
            Their account&apos;s email
            <input name="email" type="email" required maxLength={254} />
          </label>
          <label>
            Role
            <select name="role" required defaultValue="packer">
              {Object.entries(data.roles).map(([role, label]) => (
                <option key={role} value={role}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <button type="submit" className="btn primary" disabled={state.busy}>
            Add staff
          </button>
        </form>
      )}
      {state.error && (
        <p className="error" role="alert">
          {state.error}
        </p>
      )}
      {state.done && <p role="status">{state.done}</p>}
    </section>
  );
}
