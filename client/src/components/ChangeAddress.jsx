import { useState } from 'react';
import AddressFields from './AddressFields.jsx';

// "Change address" on an order that hasn't shipped (stage 90), for its customer or an admin: opens the address
// fields filled with the current one. `save(address)` sends it (and shows the changed order); the form closes once it
// worked and shows the server's reason when it didn't (an area the store doesn't deliver to, already shipped…).
export default function ChangeAddress({ address, save }) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState({ busy: false, error: null });
  if (!open) {
    return (
      <button type="button" className="btn small" onClick={() => setOpen(true)}>
        Change address
      </button>
    );
  }
  async function submit(e) {
    e.preventDefault();
    setState({ busy: true, error: null });
    try {
      await save(Object.fromEntries(new FormData(e.currentTarget)));
      setState({ busy: false, error: null });
      setOpen(false);
    } catch (err) {
      setState({ busy: false, error: err.message });
    }
  }
  return (
    <form className="change-address" onSubmit={submit} aria-label="New delivery address">
      <AddressFields saved={address} />
      {state.error && (
        <p className="error" role="alert">
          {state.error}
        </p>
      )}
      <div className="form-actions">
        <button type="submit" className="btn primary" disabled={state.busy}>
          Save address
        </button>
        <button type="button" className="btn" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </form>
  );
}
