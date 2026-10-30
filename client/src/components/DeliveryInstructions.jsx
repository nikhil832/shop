import { useState } from 'react';
import { request } from '../api.js';

// An order's delivery instructions (stage 113): shown, and changeable until it ships (`path` is the customer's or
// the admin's change address; `onSaved(order)` shows the changed order).
export default function DeliveryInstructions({ order, path, editable, onSaved }) {
  const [editing, setEditing] = useState(false);
  const [state, setState] = useState({ busy: false, error: null });
  const current = order.deliveryInstructions;

  async function save(e) {
    e.preventDefault();
    const { instructions } = Object.fromEntries(new FormData(e.currentTarget));
    setState({ busy: true, error: null });
    try {
      onSaved(await request(path, { method: 'POST', body: { instructions } }));
      setState({ busy: false, error: null });
      setEditing(false);
    } catch (err) {
      setState({ busy: false, error: err.message });
    }
  }

  if (editing) {
    return (
      <form className="instructions-form" onSubmit={save} aria-label="Delivery instructions">
        <label>
          Delivery instructions
          <textarea name="instructions" rows={2} maxLength={200} defaultValue={current} autoFocus />
        </label>
        {state.error && (
          <p className="error" role="alert">
            {state.error}
          </p>
        )}
        <div className="form-actions">
          <button type="submit" className="btn primary small" disabled={state.busy}>
            Save instructions
          </button>
          <button type="button" className="btn small" onClick={() => setEditing(false)}>
            Cancel
          </button>
        </div>
      </form>
    );
  }
  return (
    <div className="instructions">
      {current ? (
        <p>
          <strong>Delivery instructions:</strong> {current}
        </p>
      ) : (
        editable && <p className="muted small">No delivery instructions.</p>
      )}
      {editable && (
        <button type="button" className="link small" onClick={() => setEditing(true)}>
          {current ? 'Change instructions' : 'Add delivery instructions'}
        </button>
      )}
    </div>
  );
}
