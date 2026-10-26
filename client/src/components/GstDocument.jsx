import { formatAmount } from '../format.js';

// The parts tax invoices and credit notes share (pages/Invoice.jsx, pages/CreditNote.jsx). `doc` is the server's
// gstInvoice or gstCreditNote (gst.js): seller, place of supply, lines, tax by rate and totals.

const percent = (rate) => `${rate}%`;

// The seller (with GSTIN) and the customer's address, with the place of supply.
export function GstParties({ doc, address, email, to = 'Billed to' }) {
  return (
    <div className="invoice-parties-row">
      {doc && (
        <section className="invoice-parties" aria-label="Sold by">
          <h2>Sold by</h2>
          <address>
            <strong>{doc.seller.legalName}</strong>
            <br />
            <span className="pre-line">{doc.seller.address}</span>
            <br />
            {doc.seller.state}
            <br />
            GSTIN {doc.seller.gstin}
          </address>
        </section>
      )}
      <section className="invoice-parties" aria-label={to}>
        <h2>{to}</h2>
        <address>
          <strong>{address.name}</strong>
          <br />
          {address.line1}
          {address.line2 && (
            <>
              <br />
              {address.line2}
            </>
          )}
          <br />
          {address.city}, {address.state} {address.pincode}
          <br />
          Phone {address.phone}
          {email && (
            <>
              <br />
              {email}
            </>
          )}
        </address>
        {doc && (
          <p className="small">
            Place of supply: {doc.placeOfSupply.name}
            {doc.placeOfSupply.code && ` (${doc.placeOfSupply.code})`}
          </p>
        )}
      </section>
    </div>
  );
}

// Each line's taxable value and tax, the totals, then the tax by rate. Amounts include GST, so the lines add up to
// `total`. `children` go between the totals and the tax by rate (the invoice's coupon note).
export function GstLines({ doc, total, totalLabel = 'Total', children }) {
  const taxes = doc.intraState
    ? [
        ['cgst', 'CGST'],
        ['sgst', 'SGST'],
      ]
    : [['igst', 'IGST']];
  return (
    <>
      <div className="table-wrap">
        <table className="invoice-table gst-lines">
          <thead>
            <tr>
              <th>Item</th>
              <th className="gst-wide">HSN</th>
              <th className="num gst-wide">Qty</th>
              <th className="num">Taxable value</th>
              <th className="num gst-wide">GST</th>
              <th className="num">Tax</th>
              <th className="num">Amount</th>
            </tr>
          </thead>
          <tbody>
            {doc.lines.map((l, i) => (
              <tr key={i}>
                <td>
                  {l.title}
                  {/* On phones the narrow columns are hidden and shown here instead. */}
                  <span className="gst-narrow muted small block">
                    {[l.hsn && `HSN ${l.hsn}`, `GST ${percent(l.rate)}`, `Qty ${l.qty}`].filter(Boolean).join(' · ')}
                  </span>
                </td>
                <td className="gst-wide">{l.hsn}</td>
                <td className="num gst-wide">{l.qty}</td>
                <td className="num">{formatAmount(l.taxable)}</td>
                <td className="num gst-wide">{percent(l.rate)}</td>
                <td className="num">{formatAmount(l.tax)}</td>
                <td className="num">{formatAmount(l.value)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <table className="invoice-table invoice-sums" aria-label="Totals">
        <tbody>
          <tr>
            <th>Taxable value</th>
            <td className="num">{formatAmount(doc.totals.taxable)}</td>
          </tr>
          {taxes.map(([key, label]) => (
            <tr key={key}>
              <th>{label}</th>
              <td className="num">{formatAmount(doc.totals[key])}</td>
            </tr>
          ))}
          <tr className="invoice-total">
            <th>{totalLabel}</th>
            <td className="num">{formatAmount(total)}</td>
          </tr>
        </tbody>
      </table>
      {children}
      <div className="table-wrap">
        <table className="invoice-table invoice-tax-summary" aria-label="Tax by rate">
          <thead>
            <tr>
              <th>GST rate</th>
              <th className="num">Taxable value</th>
              {taxes.map(([key, label]) => (
                <th key={key} className="num">
                  {label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {doc.byRate.map((r) => (
              <tr key={r.rate}>
                <td>{percent(r.rate)}</td>
                <td className="num">{formatAmount(r.taxable)}</td>
                {taxes.map(([key]) => (
                  <td key={key} className="num">
                    {formatAmount(r[key])}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
