import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router';
import { useFetch } from '../useFetch.js';

// The chat panel is its own file, downloaded the first time someone opens it.
const Assistant = lazy(() => import('./Assistant.jsx'));
// Pages without the button: the admin panel, checkout, and printable documents.
const HIDDEN_ON = /^\/(admin|checkout)(\/|$)|^\/orders\/[^/]+\/(invoice|credit-notes)/;

// "Ask Bazaar" (stage 63): the shopping assistant's button on shop pages, shown only when an admin has switched it on.
// The conversation lives here, so it survives closing the panel and moving between pages (not a reload).
export default function AssistantButton() {
  const { pathname } = useLocation();
  const { data } = useFetch('/assistant');
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState([]);
  const button = useRef(null);
  // Closing puts focus back on the button, once it's shown again.
  const closedByUser = useRef(false);
  useEffect(() => {
    if (!open && closedByUser.current) {
      closedByUser.current = false;
      button.current?.focus();
    }
  }, [open]);
  if (!data?.enabled || HIDDEN_ON.test(pathname)) return null;

  function close() {
    closedByUser.current = true;
    setOpen(false);
  }

  return (
    <>
      {open && (
        <Suspense fallback={<div className="assistant-panel muted">Opening…</div>}>
          <Assistant messages={messages} setMessages={setMessages} limits={data} onClose={close} />
        </Suspense>
      )}
      {!open && (
        <button ref={button} type="button" className="btn primary assistant-button" onClick={() => setOpen(true)}>
          Ask Bazaar
        </button>
      )}
    </>
  );
}
