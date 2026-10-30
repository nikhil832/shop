import { useState } from 'react';
import { statesForPin } from '../pinStates.js';
import { INDIAN_STATES } from '../states.js';

// The delivery address inputs, shared by checkout and the account page. Uncontrolled: read them with FormData.
// `saved` (the account's address) fills them in; without one, the name defaults to `defaultName`.
const FIELDS = [
  { name: 'name', label: 'Full name', autoComplete: 'name', maxLength: 80 },
  {
    name: 'phone',
    label: 'Mobile number',
    autoComplete: 'tel-national',
    inputMode: 'numeric',
    pattern: '[6-9][0-9]{9}',
    title: '10-digit mobile number',
    maxLength: 10,
  },
  { name: 'line1', label: 'Address (house, street, area)', autoComplete: 'address-line1', maxLength: 120, wide: true },
  {
    name: 'line2',
    label: 'Landmark (optional)',
    autoComplete: 'address-line2',
    maxLength: 120,
    required: false,
    wide: true,
  },
  // Before the city and state: typing it fills in the state when the PIN code has only one (stage 105).
  {
    name: 'pincode',
    label: 'PIN code',
    autoComplete: 'postal-code',
    inputMode: 'numeric',
    pattern: '[1-9][0-9]{5}',
    title: '6-digit PIN code',
    maxLength: 6,
  },
  { name: 'city', label: 'City', autoComplete: 'address-level2', maxLength: 60 },
  // Typed, with the states and union territories as suggestions; the server takes only those (and fixes the case).
  { name: 'state', label: 'State', autoComplete: 'address-level1', maxLength: 60, list: 'indian-states' },
];

// The states a typed PIN code can be in, and whether the typed state is one of them (case aside; names the list
// doesn't know are left to the server).
function pinCheck(pincode, state) {
  const states = statesForPin(pincode.trim());
  if (!states) return null;
  const typed = INDIAN_STATES.find((s) => s.toLowerCase() === state.trim().toLowerCase());
  return { states, mismatch: Boolean(typed) && !states.includes(typed) };
}

export default function AddressFields({ saved, defaultName = '' }) {
  // A warning when the state isn't one the PIN code is in (the server refuses such an address too).
  const [warning, setWarning] = useState(null);
  function onInput(e) {
    const form = e.currentTarget.closest('form') ?? e.currentTarget;
    const pin = form.querySelector('input[name="pincode"]');
    const state = form.querySelector('input[name="state"]');
    if (!pin || !state) return;
    const check = pinCheck(pin.value, state.value);
    // Typing the PIN code fills in an empty state when there's only one it can be.
    if (e.target === pin && check?.states.length === 1 && !state.value.trim()) state.value = check.states[0];
    const after = pinCheck(pin.value, state.value);
    setWarning(after?.mismatch ? `PIN code ${pin.value.trim()} is in ${after.states.join(' or ')}.` : null);
  }
  return (
    <div className="address-grid" onInput={onInput}>
      {FIELDS.map(({ name, label, wide, required = true, ...input }) => (
        <label key={name} className={wide ? 'wide' : ''}>
          {label}
          <input
            name={name}
            defaultValue={saved?.[name] ?? (name === 'name' ? defaultName : '')}
            required={required}
            {...input}
          />
        </label>
      ))}
      {warning && (
        <p className="address-warning wide" role="alert">
          {warning} Check the state or the PIN code.
        </p>
      )}
      <datalist id="indian-states">
        {INDIAN_STATES.map((s) => (
          <option key={s} value={s} />
        ))}
      </datalist>
    </div>
  );
}
