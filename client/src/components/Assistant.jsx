import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { request } from '../api.js';
import { formatPrice, smallImage } from '../format.js';

// The shopping assistant's chat panel (stage 63). Each question sends the conversation so far (text only) and gets a
// reply with product cards whose prices and stock come from the store, not from the AI. `messages` are
// [{ role: 'user' | 'assistant', text, products? }], kept by AssistantButton.
export default function Assistant({ messages, setMessages, limits, onClose }) {
  const [state, setState] = useState({ busy: false, error: null });
  const input = useRef(null);
  const end = useRef(null);
  const asked = messages.filter((m) => m.role === 'user').length;
  const full = asked >= limits.maxTurns;

  useEffect(() => {
    input.current?.focus();
  }, []);
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'nearest' });
  }, [messages.length, state.busy]);

  async function send(e) {
    e.preventDefault();
    const text = input.current.value.trim();
    if (!text || state.busy) return;
    const next = [...messages, { role: 'user', text }];
    setMessages(next);
    input.current.value = '';
    setState({ busy: true, error: null });
    try {
      const res = await request('/assistant/chat', {
        method: 'POST',
        body: { messages: next.map(({ role, text: t }) => ({ role, text: t })) },
      });
      setMessages([...next, { role: 'assistant', text: res.reply, products: res.products }]);
      setState({ busy: false, error: null });
    } catch (err) {
      // The question is taken back, so it can be sent again.
      setMessages(messages);
      input.current.value = text;
      setState({ busy: false, error: err.message });
    }
  }

  return (
    <section
      className="assistant-panel"
      aria-labelledby="assistant-heading"
      onKeyDown={(e) => e.key === 'Escape' && onClose()}
    >
      <div className="assistant-head">
        <h2 id="assistant-heading">Ask Bazaar</h2>
        <button type="button" className="link" onClick={onClose}>
          Close<span className="sr-only"> the shopping assistant</span>
        </button>
      </div>
      <p className="muted small">
        An AI shopping assistant. It can make mistakes: check the product page before you buy, and don&apos;t share
        personal details.
      </p>
      <div className="assistant-messages" aria-live="polite">
        {messages.length === 0 && (
          <p className="muted">Ask about products, for example &ldquo;a gift for a runner under ₹3,000&rdquo;.</p>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`assistant-message ${m.role}`}>
            <p>
              <span className="sr-only">{m.role === 'user' ? 'You: ' : 'Assistant: '}</span>
              {m.text}
            </p>
            {m.products?.length > 0 && (
              <ul className="assistant-products">
                {m.products.map((p) => (
                  <li key={p.id}>
                    <Link to={`/p/${p.slug}`}>
                      {p.image && <img src={smallImage(p.image)} alt="" width="48" height="48" />}
                      <span>
                        {p.title}
                        <span className="block small">
                          {p.priceFrom && 'From '}
                          {formatPrice(p.price)}
                          {p.stock === 0 && ' · Out of stock'}
                        </span>
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ))}
        {state.busy && <p className="muted small">Looking…</p>}
        <div ref={end} />
      </div>
      {state.error && (
        <p className="error small" role="alert">
          {state.error}
        </p>
      )}
      {full ? (
        <p className="small">
          That&apos;s {limits.maxTurns} questions, the most for one chat.{' '}
          <button type="button" className="link" onClick={() => setMessages([])}>
            Start a new chat
          </button>
        </p>
      ) : (
        <form className="assistant-form" onSubmit={send}>
          <input
            ref={input}
            aria-label="Your question"
            maxLength={limits.maxMessage}
            placeholder="Ask about products…"
            autoComplete="off"
          />
          <button type="submit" className="btn primary small" disabled={state.busy}>
            Send
          </button>
        </form>
      )}
    </section>
  );
}
