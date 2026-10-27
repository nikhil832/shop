// A stand-in for Claude's Messages API, so tests (and the e2e demo server) never call the real service or spend money.
// Answers POST /v1/messages with a product or answer draft as structured JSON, recording each request; test-only switches make
// the next answers fail or the next one be a refusal.
// Run directly for the e2e tests: FAKE_ANTHROPIC_PORT=4102 node server/test/fake-anthropic.js
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';

export const FAKE_ANTHROPIC_KEY = 'sk-ant-fake-key-for-tests';

export async function startFakeAnthropic(port = 0) {
  const state = { calls: [], next: null, failures: 0, error: null };

  const message = (body, content, stop) => ({
    id: `msg_fake_${state.calls.length}`,
    type: 'message',
    role: 'assistant',
    model: body.model,
    content,
    stop_reason: stop,
    stop_sequence: null,
    usage: { input_tokens: 400, output_tokens: 120 },
  });

  // The shopping assistant, a conversation with tools: a question is searched for (its words), found products are shown
  // (plus a slug the store doesn't have), then the reply names the first one with the price the search returned.
  // "Ignore your rules…" is declined in words; "refuse" gets a refusal.
  function chat(body) {
    const last = body.messages.at(-1);
    if (typeof last.content === 'string') {
      if (state.next === 'refusal' || /refuse/i.test(last.content)) return message(body, [], 'refusal');
      if (/ignore/i.test(last.content)) {
        return message(body, [{ type: 'text', text: 'I can only help with shopping at Bazaar.' }], 'end_turn');
      }
      const words = last.content
        .toLowerCase()
        .replace(/[^a-z ]/g, '')
        .trim();
      return message(
        body,
        [{ type: 'tool_use', id: `toolu_search_${state.calls.length}`, name: 'search_products', input: { words } }],
        'tool_use',
      );
    }
    const result = last.content.find((c) => c.type === 'tool_result');
    const text = typeof result.content === 'string' ? result.content : result.content.map((c) => c.text).join('');
    if (result.tool_use_id.startsWith('toolu_search_')) {
      const found = JSON.parse(text);
      if (!Array.isArray(found)) {
        return message(body, [{ type: 'text', text: "I couldn't find that here. Try other words." }], 'end_turn');
      }
      const slugs = [found[0].slug, 'no-such-product'];
      return message(
        body,
        [{ type: 'tool_use', id: `toolu_show_${state.calls.length}`, name: 'show_products', input: { slugs } }],
        'tool_use',
      );
    }
    // After show_products: the reply, using the search's own figures.
    const searched = body.messages
      .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
      .find((c) => c.type === 'tool_result' && c.tool_use_id.startsWith('toolu_search_'));
    const searchText = typeof searched.content === 'string' ? searched.content : searched.content[0].text;
    const [first] = JSON.parse(searchText);
    return message(body, [{ type: 'text', text: `Have a look at ${first.title}, at ${first.price}.` }], 'end_turn');
  }

  function answer(body) {
    if (body.tools?.some((t) => t.name === 'search_products')) return chat(body);
    const prompt = body.messages[0].content.find((c) => c.type === 'text').text;
    const title = /^Title: (.*)$/m.exec(prompt)?.[1] ?? 'this product';
    const stop = state.next === 'refusal' ? 'refusal' : 'end_turn';
    // A search reading, a screening check, a review summary, a photo description, a weekly note, an error explanation,
    // an answer draft, or a product draft.
    const product = /^Product: (.*)$/m.exec(prompt)?.[1];
    const kind = /^Kind: (.*)$/m.exec(prompt)?.[1];
    // An explanation names the first file it was given, and repeats a link from the report (the server removes it).
    const place = /^- \w+: (\S+)/m.exec(prompt)?.[1];
    const explained = kind && {
      explanation: `  The page ${kind === 'load' ? "didn't load" : 'crashed'}. See https://example.com/fix for more.  `,
      whereToLook: place ? [`${place}: check the value before using it`] : [],
      urgent: /checkout/.test(prompt),
    };
    // A weekly note quotes the week's sales line back.
    const sales = /^Sales: (.*)$/m.exec(prompt)?.[1];
    const note = /^Week: /.test(prompt) && {
      paragraphs: [`  Last week brought in ${sales}.  `, 'Two orders are waiting to ship.', ' '],
    };
    // A photo description, when asked about a photo with its product title.
    const described = /^Product title: /.test(prompt) && {
      alt: `  Photo of a ${body.messages[0].content[0].source.media_type === 'image/png' ? 'blue' : 'red'} vase, seen from the side  `,
    };
    // A review summary, when given numbered reviews.
    const reviewCount = (prompt.match(/^Review \d+ \(/gm) ?? []).length;
    const summarised = reviewCount > 0 && {
      summary: `  Most of the ${reviewCount} reviewers like it; a few find it small.  `,
    };
    // A screening check: phone numbers are personal details, "buy now" is spam, anything else is fine.
    const post = /^A customer's (?:review|question) of /.test(prompt) && prompt.split('\n\n').slice(1).join('\n\n');
    const reasons = post
      ? [...(/\d{10}/.test(post) ? ['personal_details'] : []), ...(/buy now/i.test(post) ? ['spam'] : [])]
      : [];
    const screened = post !== false && {
      flagged: reasons.length > 0,
      reasons,
      note: reasons.length ? `  Check it: ${reasons.join(' and ')}.  ` : '',
    };
    // A plain-words search: "under N" is a top price, a listed brand or category name is used, the rest are the
    // words; "hello" isn't a search at all.
    const typed = /^The shopper typed: (.*)$/m.exec(prompt)?.[1];
    let reading = null;
    if (typed !== undefined) {
      let rest = typed.toLowerCase();
      const under = /\bunder (?:rs\.? ?|₹)?(\d+)/.exec(rest);
      rest = rest.replace(/\bunder (?:rs\.? ?|₹)?\d+/, '');
      const categories = [...prompt.matchAll(/([a-z-]+): ([^;\n]+)/g)].filter(([, slug]) => slug !== 'Brands');
      const brands = (/^Brands: (.*)$/m.exec(prompt)?.[1] ?? '').split(', ');
      const inStock = /\bin stock\b/.test(rest);
      rest = rest.replace(/\bin stock\b/, '');
      const brand = brands.find((b) => rest.includes(b.toLowerCase()));
      if (brand) rest = rest.replace(brand.toLowerCase(), '');
      const category = categories.find(([, , name]) => rest.includes(name.trim().toLowerCase()))?.[1] ?? null;
      reading = {
        understood: !/^hello/.test(rest.trim()),
        words: rest.replace(/\s+/g, ' ').trim(),
        category: /shoe/.test(rest) ? 'fashion' : category,
        brands: brand ? [brand, 'NoSuchBrand'] : [],
        minPrice: null,
        maxPrice: under ? Number(under[1]) : null,
        inStock,
      };
    }
    const draft = reading
      ? reading
      : screened
        ? screened
        : summarised
          ? summarised
          : described
            ? described
            : note
              ? note
              : explained
                ? explained
                : product
                  ? {
                      answer: `  Yes: ${product} comes with what the description lists.  `,
                      fromDetails: !/warranty/i.test(prompt.split("Customer's question:")[1] ?? ''),
                    }
                  : {
                      description: `${title} is a dependable pick for everyday use.\n\nMade to last, and easy to look after.`,
                      highlights: ['Easy to use', 'Built to last.', '  Great value  '],
                    };
    return {
      id: `msg_fake_${state.calls.length}`,
      type: 'message',
      role: 'assistant',
      model: body.model,
      content: stop === 'refusal' ? [] : [{ type: 'text', text: JSON.stringify(draft) }],
      stop_reason: stop,
      stop_sequence: null,
      usage: { input_tokens: 400, output_tokens: 120 },
    };
  }

  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      const send = (status, data) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
      };
      if (req.method !== 'POST' || req.url !== '/v1/messages') return send(404, { type: 'error' });
      // The SDK sends the key as x-api-key or as a Bearer token, depending on its version.
      const key = req.headers['x-api-key'] ?? req.headers.authorization?.replace(/^Bearer /, '');
      if (key !== FAKE_ANTHROPIC_KEY) {
        return send(401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } });
      }
      const body = JSON.parse(raw);
      state.calls.push({ body, headers: req.headers });
      if (state.failures > 0) {
        state.failures -= 1;
        const [status, type, message] = state.error ?? [500, 'api_error', 'Internal server error'];
        return send(status, { type: 'error', error: { type, message } });
      }
      const result = answer(body);
      state.next = null;
      send(200, result);
    });
  });
  await new Promise((resolve) => server.listen(port, resolve));
  return {
    url: `http://localhost:${server.address().port}`,
    calls: state.calls,
    // The SDK retries once, so failNext(2) makes a whole request fail.
    // `error`: [status, type, message] of Anthropic's error answer (default a 500).
    failNext: (times = 1, error = null) => {
      state.failures = times;
      state.error = error;
    },
    refuseNext: () => (state.next = 'refusal'),
    stop: () => new Promise((resolve) => server.close(resolve)),
  };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const fake = await startFakeAnthropic(Number(process.env.FAKE_ANTHROPIC_PORT) || 4102);
  console.log(`Fake Claude API on ${fake.url}`);
}
