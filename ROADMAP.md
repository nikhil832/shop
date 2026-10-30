# Roadmap

Ideas for the store that are suggested but not built yet, and the ones that were set aside. Each idea says why it is
worth doing and what to type to start it. When one is built, it moves to **Done** with its commit.

Live site: https://bazaar-jup1.onrender.com (Render free plan; every push to `main` deploys).

## Next

Suggested on 2026-10-30, roughly in the order they'd help most. All free (no new services).

- **Product performance**: Admin → Products gains views, add-to-carts and orders per product for 7/30 days, counted per
  day with nothing stored about visitors, so you can see which products are looked at but not bought (price or photos
  to fix). To start: "start product performance".

## Set aside

- **A domain of your own** (e.g. `bazaar.in`, about ₹800 a year): a nicer address, and emails that land in spam less
  often (Brevo can then sign them for the domain). Postponed on 2026-10-22: nothing to buy for now. To start: "start
  the domain setup".
- **Render Starter plan** ($7 a month): no sleeping after 15 idle minutes, no slow first visit, and the unpaid-order
  sweep runs on time. A switch on Render, no code change.
- **Partial search matches**: every search word must match something, so "wireless earbuds" finds nothing. Showing
  products that match only some words would also bring in weak results; left out on purpose.
- **AI features with the Claude API**: all the ideas from 2026-10-26 are built (stages 51 and 56–63), with the same
  API key. New ones go in Next.

## Done

| What                                                                                                                                                                      | Commit                                 |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| Stages 1–5: catalog, accounts and checkout, admin panel, Razorpay (test), reviews                                                                                         | `480ad9a`                              |
| Deployed on Render, with health check and Secure cookies                                                                                                                  | `344462a`                              |
| Order emails through Brevo                                                                                                                                                | `1e27f0b`                              |
| Password reset by email                                                                                                                                                   | `e15881c`                              |
| Better search ranking                                                                                                                                                     | `e6505fe`                              |
| Login protection (5 wrong passwords pause an email for 15 minutes); reset can't reuse the current password                                                                | Stage 9 (`git log --grep "Stage 9"`)   |
| Account page: name, saved address, change password (current one needed, no reuse, other devices logged out)                                                               | Stage 10 (`git log --grep "Stage 10"`) |
| Back-in-stock alerts: logged-in customers ask on a sold-out product's page and get one email when it's back                                                               | Stage 11 (`git log --grep "Stage 11"`) |
| Search suggestions: categories and the top 6 products in a dropdown while typing, with keyboard support                                                                   | Stage 12 (`git log --grep "Stage 12"`) |
| Coupon codes: % off (with a cap), amount off or free delivery; minimum order, last day, total uses; once per customer                                                     | Stage 13 (`git log --grep "Stage 13"`) |
| Sales dashboard: revenue per day, totals against the period before, best sellers, orders to ship, low stock                                                               | Stage 14 (`git log --grep "Stage 14"`) |
| New-order alerts: admins are emailed each order once it's placed (COD at once, online once paid)                                                                          | Stage 15 (`git log --grep "Stage 15"`) |
| Unused uploads deleted after a day (photos that products or past orders use are kept)                                                                                     | Stage 16 (`git log --grep "Stage 16"`) |
| Login limit per network: 20 wrong passwords from one address (or IPv6 /64) in 15 minutes, using Render's `CF-Connecting-IP`                                               | Stage 17 (`git log --grep "Stage 17"`) |
| Change email: confirmed by a link to the new address (24 hours), the old address told, old reset links stop                                                               | Stage 18 (`git log --grep "Stage 18"`) |
| Printable invoices for customers and admins (print or save as PDF)                                                                                                        | Stage 19 (`git log --grep "Stage 19"`) |
| Export orders as CSV for a date range (and status) from the admin dashboard                                                                                               | Stage 20 (`git log --grep "Stage 20"`) |
| Product variants: one kind of option (size, colour…) with its own price, MRP and stock each                                                                               | Stage 21 (`git log --grep "Stage 21"`) |
| Photos per variant, picked from the product's photos                                                                                                                      | Stage 22 (`git log --grep "Stage 22"`) |
| Back-in-stock alerts for one sold-out size or colour                                                                                                                      | Stage 23 (`git log --grep "Stage 23"`) |
| Two kinds of option (e.g. colour and size) with a combination grid in the admin form                                                                                      | Stage 24 (`git log --grep "Stage 24"`) |
| Database backups to a dated folder on your computer, and restore                                                                                                          | Stage 25 (`git log --grep "Stage 25"`) |
| Tracking numbers: courier, number and tracking link on the order page, shipped email and export                                                                           | Stage 26 (`git log --grep "Stage 26"`) |
| Link previews: product name, price, brand and photo in shared links (Open Graph), store image otherwise                                                                   | Stage 27 (`git log --grep "Stage 27"`) |
| Returns: chosen items within 7 days of delivery, admin approve (stock back, refund) or decline                                                                            | Stage 28 (`git log --grep "Stage 28"`) |
| Delivery PIN check on product pages, areas by PIN prefix in the admin panel, refused at checkout                                                                          | Stage 29 (`git log --grep "Stage 29"`) |
| Two-step login with an authenticator app, recovery codes, admin reminder                                                                                                  | Stage 30 (`git log --grep "Stage 30"`) |
| Returns in the sales figures: net revenue, refunds per day, best sellers and export net of returns                                                                        | Stage 31 (`git log --grep "Stage 31"`) |
| Show up on Google: robots.txt, a sitemap, product data for results (price, stock, rating), Search Console verification tag                                                | Stage 32 (`git log --grep "Stage 32"`) |
| Similar products and recently viewed on product pages (and recently viewed on the home page)                                                                              | Stage 33 (`git log --grep "Stage 33"`) |
| Daily low-stock email to admins (from 9:00 India time, nothing on days when nothing is low), with an on/off switch on the dashboard                                       | Stage 34 (`git log --grep "Stage 34"`) |
| Products from a spreadsheet: CSV export, upload with a preview of every change, saved all at once                                                                         | Stage 35 (`git log --grep "Stage 35"`) |
| Activity log: every admin change (and the admin command-line scripts) with who, when and what changed, kept a year                                                        | Stage 36 (`git log --grep "Stage 36"`) |
| Questions on products: customers ask, admins answer, answers on the product page and emailed                                                                              | Stage 37 (`git log --grep "Stage 37"`) |
| GST invoices: store GSTIN and rates per category in Admin → GST, tax invoices with CGST/SGST or IGST for orders placed while on                                           | Stage 38 (`git log --grep "Stage 38"`) |
| Faster first visit: admin panel and rarely used pages load on first use; built files cached for a year                                                                    | Stage 39 (`git log --grep "Stage 39"`) |
| Price-drop emails for wishlist items (5% or more, one email per customer, switch on the account page)                                                                     | Stage 40 (`git log --grep "Stage 40"`) |
| Cart saved to the account, across devices, with one reminder email for a cart left a day                                                                                  | Stage 41 (`git log --grep "Stage 41"`) |
| Packing slips for chosen orders, and marking several orders shipped at once                                                                                               | Stage 42 (`git log --grep "Stage 42"`) |
| Private notes on orders, optionally printed on the packing slip                                                                                                           | Stage 43 (`git log --grep "Stage 43"`) |
| Photos in reviews (up to 3, shrunk in the browser, location data removed)                                                                                                 | Stage 44 (`git log --grep "Stage 44"`) |
| GST in the order export, and a GST summary by place of supply and rate                                                                                                    | Stage 45 (`git log --grep "Stage 45"`) |
| Accessibility check (axe, WCAG 2.1 AA) on every page in the browser tests, and the contrast and link fixes it found                                                       | Stage 46 (`git log --grep "Stage 46"`) |
| Storage meter on the dashboard, with emails at 80% and 95% full                                                                                                           | Stage 47 (`git log --grep "Stage 47"`) |
| "Did you mean…?" for searches that find nothing                                                                                                                           | Stage 48 (`git log --grep "Stage 48"`) |
| Buy again: a past order's items back in the cart at today's prices, saying what couldn't be added                                                                         | Stage 49 (`git log --grep "Stage 49"`) |
| Credit notes for returns (GST), printable, and taken off the GST summary                                                                                                  | Stage 50 (`git log --grep "Stage 50"`) |
| Write for me: Claude drafts a product's description and highlights in the admin form (needs an Anthropic API key; paid per use)                                           | Stage 51 (`git log --grep "Stage 51"`) |
| Error reports: pages that didn't load or crashed in visitors' browsers, listed for admins by problem, with fixed/reopen                                                   | Stage 52 (`git log --grep "Stage 52"`) |
| New-browser login alerts: an admin is emailed (and the activity log notes it) when their account logs in from a browser it hasn't used before                             | Stage 53 (`git log --grep "Stage 53"`) |
| Address book: up to 10 saved addresses with labels and a default, chosen at checkout                                                                                      | Stage 54 (`git log --grep "Stage 54"`) |
| Frequently bought together on product pages, from real orders (at least two customers)                                                                                    | Stage 55 (`git log --grep "Stage 55"`) |
| AI answer drafts: "Draft an answer" on customers' questions, from the product's details, for the admin to check                                                           | Stage 56 (`git log --grep "Stage 56"`) |
| Explain this error: Claude explains a browser error report in plain words and where to look                                                                               | Stage 57 (`git log --grep "Stage 57"`) |
| Weekly note: each Monday, Claude writes admins a note about last week from its figures (figures included)                                                                 | Stage 58 (`git log --grep "Stage 58"`) |
| Photo descriptions for screen readers, typed or suggested by Claude from the photo                                                                                        | Stage 59 (`git log --grep "Stage 59"`) |
| What customers say: an AI summary of a product's reviews, rewritten when they change                                                                                      | Stage 60 (`git log --grep "Stage 60"`) |
| Screening: new reviews and questions checked for abuse, spam and personal details, flagged for admins                                                                     | Stage 61 (`git log --grep "Stage 61"`) |
| Plain-words search: a search that finds nothing is read into filters by Claude and offered as a link                                                                      | Stage 62 (`git log --grep "Stage 62"`) |
| Shopping assistant: "Ask Bazaar" chat that finds products with read-only catalog tools; off until switched on                                                             | Stage 63 (`git log --grep "Stage 63"`) |
| Help requests: "Contact us" and "Get help with this order", answered from an Admin → Help inbox by email                                                                  | Stage 64 (`git log --grep "Stage 64"`) |
| Download or delete my account: a JSON download of the customer's data, and closing the account (orders kept anonymised)                                                   | Stage 65 (`git log --grep "Stage 65"`) |
| Staff accounts: packer and support roles below admin, given on Admin → Staff                                                                                              | Stage 66 (`git log --grep "Stage 66"`) |
| Scheduled sales: a percentage off a category or chosen products between two times, prices back by themselves                                                              | Stage 67 (`git log --grep "Stage 67"`) |
| Lighter product photos: shrunk in the browser at upload, with small versions for cards and lists                                                                          | Stage 68 (`git log --grep "Stage 68"`) |
| Security headers: a Content Security Policy (the store and Razorpay only), no framing, HTTPS-only, strict referrers                                                       | Stage 69 (`git log --grep "Stage 69"`) |
| Stock history: every stock change with its reason (order, cancellation, release, return, edit, import), per product and variant                                           | Stage 70 (`git log --grep "Stage 70"`) |
| Announcement bar: a short message across the top of the shop between two times, with an optional link into the store                                                      | Stage 71 (`git log --grep "Stage 71"`) |
| Store credit: refunds of returns as credit (the customer's choice), goodwill from help requests, spent at checkout before paying                                          | Stage 72 (`git log --grep "Stage 72"`) |
| Compare products: up to three from one category side by side (price, rating, highlights, options, stock), shareable by link                                               | Stage 73 (`git log --grep "Stage 73"`) |
| Customers page: Admin → Customers with orders, money spent, returns, help requests and store credit per account                                                           | Stage 74 (`git log --grep "Stage 74"`) |
| Reorder suggestions: days of stock left at the last 30 days' sales and how many to order, on the dashboard and in the morning email                                       | Stage 75 (`git log --grep "Stage 75"`) |
| Search insights: Admin → Searches with the week's most searched words and the searches that found nothing                                                                 | Stage 76 (`git log --grep "Stage 76"`) |
| Gift cards: bought online for someone by email (now or on a chosen day), redeemed as store credit within a year                                                           | Stage 77 (`git log --grep "Stage 77"`) |
| Install as an app: a web app manifest and the store's own icons, so phones offer "Add to home screen"                                                                     | Stage 78 (`git log --grep "Stage 78"`) |
| Refused deliveries and COD limits: "Returned to sender" for shipped orders, a COD order limit, and online payment after repeated refusals                                 | Stage 79 (`git log --grep "Stage 79"`) |
| Cost prices and profit: admin-only cost per product and option, kept on each order item; profit and margin on the dashboard                                               | Stage 80 (`git log --grep "Stage 80"`) |
| Receiving stock: supplier deliveries add stock, show as "Received" in stock history and average into the cost price                                                       | Stage 81 (`git log --grep "Stage 81"`) |
| Customer notes and tags: VIP / Wholesale / Watch tags and signed notes on the customer page, shown on their orders and help requests                                      | Stage 82 (`git log --grep "Stage 82"`) |
| Product bundles: 2–3 simple products at a bundle price, applied whenever the cart holds the full set, with "Add bundle" on product pages                                  | Stage 83 (`git log --grep "Stage 83"`) |
| Checkout without a password: name and email at checkout make the account; the confirmation brings a link to set a password                                                | Stage 84 (`git log --grep "Stage 84"`) |
| Cashback as store credit: a percentage of kept orders, paid as credit after the return window (off until switched on)                                                     | Stage 85 (`git log --grep "Stage 85"`) |
| Delivery dates: "Arrives between …" at checkout, kept on the order and in the confirmation; late orders on the dashboard                                                  | Stage 86 (`git log --grep "Stage 86"`) |
| Refer a friend: a link per customer; the friend's first order gets money off, the referrer earns credit when it's kept (off until switched on)                            | Stage 87 (`git log --grep "Stage 87"`) |
| Size guides: size charts per category (or product), opened from "Size guide" beside a product's options                                                                   | Stage 88 (`git log --grep "Stage 88"`) |
| Exchanges: another size or colour of the same product at the same price within the return window, set aside at once, approved, shipped and delivered by admins            | Stage 89 (`git log --grep "Stage 89"`) |
| Change the address before shipping: customers or admins correct it until the order ships, checked against delivery areas, new dates, emails, earlier addresses for admins | Stage 90 (`git log --grep "Stage 90"`) |
| Collections: hand-picked product lists with their own page and link, optional start and end, up to three as home page rows in the admin's order                           | Stage 91 (`git log --grep "Stage 91"`) |
| Coming soon: products without stock marked with an expected day, a home page row, "Email me when it arrives", cleared once stock comes                                    | Stage 92 (`git log --grep "Stage 92"`) |
| Supplier orders: printable orders to suppliers, filled from the reorder suggestions, received against under Receiving, on-order stock taken off the suggestions           | Stage 93 (`git log --grep "Stage 93"`) |
| Photo zoom: product photos full screen with next/previous, arrow keys and swipes, tap to zoom in where tapped; swipe the page's photo on phones                           | Stage 94 (`git log --grep "Stage 94"`) |
| Review reminders: one email three days after delivery asking for reviews of the order's products, with a switch on the account page                                       | Stage 95 (`git log --grep "Stage 95"`) |
| Helpful reviews: "Helpful" votes on reviews, sorting by most helpful, filters by stars (from a breakdown) and with photos                                                 | Stage 96 (`git log --grep "Stage 96"`) |
| Cancel some items: customers or admins cancel part of an order before it ships, with the new total shown first, stock back, a part refund or credit back                  | Stage 97 (`git log --grep "Stage 97"`) |
| Stocktake: printable count sheets per category, counted numbers checked against what should be on the shelf, saved as "Stocktake" in stock history                        | Stage 98 (`git log --grep "Stage 98"`) |
| Quantity discounts: "Buy N or more, P% off each" per product, on the product page and in the cart, kept on the order's items                                              | Stage 99 (`git log --grep "Stage 99"`) |
