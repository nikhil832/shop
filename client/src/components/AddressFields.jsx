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
  { name: 'city', label: 'City', autoComplete: 'address-level2', maxLength: 60 },
  { name: 'state', label: 'State', autoComplete: 'address-level1', maxLength: 60 },
  {
    name: 'pincode',
    label: 'PIN code',
    autoComplete: 'postal-code',
    inputMode: 'numeric',
    pattern: '[1-9][0-9]{5}',
    title: '6-digit PIN code',
    maxLength: 6,
  },
];

export default function AddressFields({ saved, defaultName = '' }) {
  return (
    <div className="address-grid">
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
    </div>
  );
}
