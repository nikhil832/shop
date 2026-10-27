# Roadmap

Ideas for the store that are suggested but not built yet, and the ones that were set aside. Each idea says why it is
worth doing and what to type to start it. When one is built, it moves to **Done** with its commit.

Live site: https://bazaar-jup1.onrender.com (Render free plan; every push to `main` deploys).

## Next

| #   | Idea                                                                                              | Why                                                                       | To start                |
| --- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | ----------------------- |
| 1   | **Frequently bought together**: on a product page, what other customers bought in the same orders | Uses real orders instead of category alone, which suggests better add-ons | "start bought together" |

## Set aside

- **A domain of your own** (e.g. `bazaar.in`, about ₹800 a year): a nicer address, and emails that land in spam less
  often (Brevo can then sign them for the domain). Postponed on 2026-10-22: nothing to buy for now. To start: "start
  the domain setup".
- **Render Starter plan** ($7 a month): no sleeping after 15 idle minutes, no slow first visit, and the unpaid-order
  sweep runs on time. A switch on Render, no code change.
- **Partial search matches**: every search word must match something, so "wireless earbuds" finds nothing. Showing
  products that match only some words would also bring in weak results; left out on purpose.
- **AI features with the Claude API** (each call costs a little; set aside on 2026-10-26; the product writer was built after all as stage 51, and these can use its
  API key). Each well under ₹1 a call with Claude Haiku 5.5:
  - **AI answer drafts**: "Draft an answer" on an unanswered product question; the admin edits and sends. To start:
    "start ai answers".
  - **Review summary**: "What customers say" on products with enough reviews, rewritten only when they change. To
    start: "start review summary".
  - **Photo descriptions**: suggested alt text for uploaded product photos. To start: "start alt text".
  - **Plain-words search**: when a search finds nothing, turn "running shoes under 2000" into filters; per visitor,
    so it needs an hourly limit. To start: "start smart search".
  - **Shopping assistant chat**: answers questions and suggests products. Every visitor's messages cost money, it's
    open to misuse and it can get prices or stock wrong, so it comes last.

## Done

| What                                                                                                                                          | Commit                                 |
| --------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| Stages 1–5: catalog, accounts and checkout, admin panel, Razorpay (test), reviews                                                             | `480ad9a`                              |
| Deployed on Render, with health check and Secure cookies                                                                                      | `344462a`                              |
| Order emails through Brevo                                                                                                                    | `1e27f0b`                              |
| Password reset by email                                                                                                                       | `e15881c`                              |
| Better search ranking                                                                                                                         | `e6505fe`                              |
| Login protection (5 wrong passwords pause an email for 15 minutes); reset can't reuse the current password                                    | Stage 9 (`git log --grep "Stage 9"`)   |
| Account page: name, saved address, change password (current one needed, no reuse, other devices logged out)                                   | Stage 10 (`git log --grep "Stage 10"`) |
| Back-in-stock alerts: logged-in customers ask on a sold-out product's page and get one email when it's back                                   | Stage 11 (`git log --grep "Stage 11"`) |
| Search suggestions: categories and the top 6 products in a dropdown while typing, with keyboard support                                       | Stage 12 (`git log --grep "Stage 12"`) |
| Coupon codes: % off (with a cap), amount off or free delivery; minimum order, last day, total uses; once per customer                         | Stage 13 (`git log --grep "Stage 13"`) |
| Sales dashboard: revenue per day, totals against the period before, best sellers, orders to ship, low stock                                   | Stage 14 (`git log --grep "Stage 14"`) |
| New-order alerts: admins are emailed each order once it's placed (COD at once, online once paid)                                              | Stage 15 (`git log --grep "Stage 15"`) |
| Unused uploads deleted after a day (photos that products or past orders use are kept)                                                         | Stage 16 (`git log --grep "Stage 16"`) |
| Login limit per network: 20 wrong passwords from one address (or IPv6 /64) in 15 minutes, using Render's `CF-Connecting-IP`                   | Stage 17 (`git log --grep "Stage 17"`) |
| Change email: confirmed by a link to the new address (24 hours), the old address told, old reset links stop                                   | Stage 18 (`git log --grep "Stage 18"`) |
| Printable invoices for customers and admins (print or save as PDF)                                                                            | Stage 19 (`git log --grep "Stage 19"`) |
| Export orders as CSV for a date range (and status) from the admin dashboard                                                                   | Stage 20 (`git log --grep "Stage 20"`) |
| Product variants: one kind of option (size, colour…) with its own price, MRP and stock each                                                   | Stage 21 (`git log --grep "Stage 21"`) |
| Photos per variant, picked from the product's photos                                                                                          | Stage 22 (`git log --grep "Stage 22"`) |
| Back-in-stock alerts for one sold-out size or colour                                                                                          | Stage 23 (`git log --grep "Stage 23"`) |
| Two kinds of option (e.g. colour and size) with a combination grid in the admin form                                                          | Stage 24 (`git log --grep "Stage 24"`) |
| Database backups to a dated folder on your computer, and restore                                                                              | Stage 25 (`git log --grep "Stage 25"`) |
| Tracking numbers: courier, number and tracking link on the order page, shipped email and export                                               | Stage 26 (`git log --grep "Stage 26"`) |
| Link previews: product name, price, brand and photo in shared links (Open Graph), store image otherwise                                       | Stage 27 (`git log --grep "Stage 27"`) |
| Returns: chosen items within 7 days of delivery, admin approve (stock back, refund) or decline                                                | Stage 28 (`git log --grep "Stage 28"`) |
| Delivery PIN check on product pages, areas by PIN prefix in the admin panel, refused at checkout                                              | Stage 29 (`git log --grep "Stage 29"`) |
| Two-step login with an authenticator app, recovery codes, admin reminder                                                                      | Stage 30 (`git log --grep "Stage 30"`) |
| Returns in the sales figures: net revenue, refunds per day, best sellers and export net of returns                                            | Stage 31 (`git log --grep "Stage 31"`) |
| Show up on Google: robots.txt, a sitemap, product data for results (price, stock, rating), Search Console verification tag                    | Stage 32 (`git log --grep "Stage 32"`) |
| Similar products and recently viewed on product pages (and recently viewed on the home page)                                                  | Stage 33 (`git log --grep "Stage 33"`) |
| Daily low-stock email to admins (from 9:00 India time, nothing on days when nothing is low), with an on/off switch on the dashboard           | Stage 34 (`git log --grep "Stage 34"`) |
| Products from a spreadsheet: CSV export, upload with a preview of every change, saved all at once                                             | Stage 35 (`git log --grep "Stage 35"`) |
| Activity log: every admin change (and the admin command-line scripts) with who, when and what changed, kept a year                            | Stage 36 (`git log --grep "Stage 36"`) |
| Questions on products: customers ask, admins answer, answers on the product page and emailed                                                  | Stage 37 (`git log --grep "Stage 37"`) |
| GST invoices: store GSTIN and rates per category in Admin → GST, tax invoices with CGST/SGST or IGST for orders placed while on               | Stage 38 (`git log --grep "Stage 38"`) |
| Faster first visit: admin panel and rarely used pages load on first use; built files cached for a year                                        | Stage 39 (`git log --grep "Stage 39"`) |
| Price-drop emails for wishlist items (5% or more, one email per customer, switch on the account page)                                         | Stage 40 (`git log --grep "Stage 40"`) |
| Cart saved to the account, across devices, with one reminder email for a cart left a day                                                      | Stage 41 (`git log --grep "Stage 41"`) |
| Packing slips for chosen orders, and marking several orders shipped at once                                                                   | Stage 42 (`git log --grep "Stage 42"`) |
| Private notes on orders, optionally printed on the packing slip                                                                               | Stage 43 (`git log --grep "Stage 43"`) |
| Photos in reviews (up to 3, shrunk in the browser, location data removed)                                                                     | Stage 44 (`git log --grep "Stage 44"`) |
| GST in the order export, and a GST summary by place of supply and rate                                                                        | Stage 45 (`git log --grep "Stage 45"`) |
| Accessibility check (axe, WCAG 2.1 AA) on every page in the browser tests, and the contrast and link fixes it found                           | Stage 46 (`git log --grep "Stage 46"`) |
| Storage meter on the dashboard, with emails at 80% and 95% full                                                                               | Stage 47 (`git log --grep "Stage 47"`) |
| "Did you mean…?" for searches that find nothing                                                                                               | Stage 48 (`git log --grep "Stage 48"`) |
| Buy again: a past order's items back in the cart at today's prices, saying what couldn't be added                                             | Stage 49 (`git log --grep "Stage 49"`) |
| Credit notes for returns (GST), printable, and taken off the GST summary                                                                      | Stage 50 (`git log --grep "Stage 50"`) |
| Write for me: Claude drafts a product's description and highlights in the admin form (needs an Anthropic API key; paid per use)               | Stage 51 (`git log --grep "Stage 51"`) |
| Error reports: pages that didn't load or crashed in visitors' browsers, listed for admins by problem, with fixed/reopen                       | Stage 52 (`git log --grep "Stage 52"`) |
| New-browser login alerts: an admin is emailed (and the activity log notes it) when their account logs in from a browser it hasn't used before | Stage 53 (`git log --grep "Stage 53"`) |
| Address book: up to 10 saved addresses with labels and a default, chosen at checkout                                                          | Stage 54 (`git log --grep "Stage 54"`) |
