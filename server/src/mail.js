// Sends email through Brevo's transactional API over fetch (no SDK). Without an API key, emails are printed to the
// server log instead, so development and the demo show what would have gone out.
export function mailClient(config) {
  if (!config?.apiKey) {
    return {
      enabled: false,
      send: async ({ to, subject }) => console.log(`Email not sent (no BREVO_API_KEY): "${subject}" to ${to.email}`),
    };
  }
  const { apiKey, from, fromName, apiUrl } = config;
  return {
    enabled: true,
    async send({ to, subject, html, text }) {
      const res = await fetch(`${apiUrl}/v3/smtp/email`, {
        method: 'POST',
        headers: { 'api-key': apiKey, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          sender: { email: from, name: fromName },
          to: [to],
          subject,
          htmlContent: html,
          textContent: text,
        }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(`Brevo returned ${res.status}: ${data.message ?? 'no reason given'}`);
      }
    },
  };
}
