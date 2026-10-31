import { useId, useRef, useState } from 'react';
import { reportSeen } from '../productStats.js';
import { ShareIcon } from './Icons.jsx';

// "Share" on the product page (stage 121). Phones (and browsers with a share sheet) open their own share menu, where
// WhatsApp and the rest are; elsewhere a small menu offers Copy link, WhatsApp and Email. The link is the product's
// page, whose preview (preview.js) shows its name, price and photo. A finished share is counted for the product's
// performance (only the count; nothing about the visitor), and a closed share sheet isn't.
export default function ShareButton({ product }) {
  const menuId = useId();
  const button = useRef(null);
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState('');
  const url = `${window.location.origin}/p/${product.slug}`;
  const text = `${product.title} on Bazaar`;
  const sheet = typeof navigator.share === 'function';

  const done = () => {
    reportSeen(product.slug, 'share');
    setOpen(false);
  };
  const close = () => {
    setOpen(false);
    button.current?.focus();
  };

  async function share() {
    setNote('');
    if (!sheet) {
      setOpen(!open);
      return;
    }
    try {
      await navigator.share({ title: product.title, text, url });
      done();
    } catch {
      // Closed without sharing, or the browser refused: nothing to count.
    }
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      setNote('Link copied');
      done();
    } catch {
      setNote('Copying is blocked here: copy the address from the address bar.');
      setOpen(false);
    }
    button.current?.focus();
  }

  return (
    <div
      className="share"
      onKeyDown={(e) => open && e.key === 'Escape' && close()}
      // Focus moving outside (a click elsewhere, or Tab past the last choice) closes the menu.
      onBlur={(e) => open && !e.currentTarget.contains(e.relatedTarget) && setOpen(false)}
    >
      <button
        ref={button}
        type="button"
        className="btn share-btn"
        onClick={share}
        {...(!sheet && { 'aria-expanded': open, 'aria-controls': menuId })}
      >
        <ShareIcon size={18} />
        Share<span className="sr-only"> {product.title}</span>
      </button>
      {open && (
        <div id={menuId} className="share-menu">
          <button type="button" onClick={copy}>
            Copy link
          </button>
          <a
            href={`https://wa.me/?text=${encodeURIComponent(`${text} ${url}`)}`}
            target="_blank"
            rel="noreferrer"
            onClick={done}
          >
            WhatsApp
          </a>
          <a
            href={`mailto:?subject=${encodeURIComponent(product.title)}&body=${encodeURIComponent(`${text}\n${url}`)}`}
            onClick={done}
          >
            Email
          </a>
        </div>
      )}
      {/* Read out when it changes (not role="status": tests find the page's own status messages). */}
      <span className="share-note small" aria-live="polite">
        {note}
      </span>
    </div>
  );
}
