# Roadmap

Ideas for the store that are suggested but not built yet, and the ones that were set aside. Each idea says why it is
worth doing and what to type to start it. When one is built, it moves to **Done** with its commit.

Live site: https://bazaar-jup1.onrender.com (Render free plan; every push to `main` deploys).

## Next

| #   | Idea                         | Why                                                                                                                                             | To start                 |
| --- | ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| 1   | Returns in the sales figures | The dashboard and export count an order's full total even after part of it was returned and refunded; they should show refunds and net revenue. | "count returns in sales" |

## Set aside

- **A domain of your own** (e.g. `bazaar.in`, about ₹800 a year): a nicer address, and emails that land in spam less
  often (Brevo can then sign them for the domain). Postponed on 2026-10-22: nothing to buy for now. To start: "start
  the domain setup".
- **Render Starter plan** ($7 a month): no sleeping after 15 idle minutes, no slow first visit, and the unpaid-order
  sweep runs on time. A switch on Render, no code change.
- **Partial search matches**: every search word must match something, so "wireless earbuds" finds nothing. Showing
  products that match only some words would also bring in weak results; left out on purpose.

## Done

| What                                                                                                                        | Commit                                 |
| --------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| Stages 1–5: catalog, accounts and checkout, admin panel, Razorpay (test), reviews                                           | `480ad9a`                              |
| Deployed on Render, with health check and Secure cookies                                                                    | `344462a`                              |
| Order emails through Brevo                                                                                                  | `1e27f0b`                              |
| Password reset by email                                                                                                     | `e15881c`                              |
| Better search ranking                                                                                                       | `e6505fe`                              |
| Login protection (5 wrong passwords pause an email for 15 minutes); reset can't reuse the current password                  | Stage 9 (`git log --grep "Stage 9"`)   |
| Account page: name, saved address, change password (current one needed, no reuse, other devices logged out)                 | Stage 10 (`git log --grep "Stage 10"`) |
| Back-in-stock alerts: logged-in customers ask on a sold-out product's page and get one email when it's back                 | Stage 11 (`git log --grep "Stage 11"`) |
| Search suggestions: categories and the top 6 products in a dropdown while typing, with keyboard support                     | Stage 12 (`git log --grep "Stage 12"`) |
| Coupon codes: % off (with a cap), amount off or free delivery; minimum order, last day, total uses; once per customer       | Stage 13 (`git log --grep "Stage 13"`) |
| Sales dashboard: revenue per day, totals against the period before, best sellers, orders to ship, low stock                 | Stage 14 (`git log --grep "Stage 14"`) |
| New-order alerts: admins are emailed each order once it's placed (COD at once, online once paid)                            | Stage 15 (`git log --grep "Stage 15"`) |
| Unused uploads deleted after a day (photos that products or past orders use are kept)                                       | Stage 16 (`git log --grep "Stage 16"`) |
| Login limit per network: 20 wrong passwords from one address (or IPv6 /64) in 15 minutes, using Render's `CF-Connecting-IP` | Stage 17 (`git log --grep "Stage 17"`) |
| Change email: confirmed by a link to the new address (24 hours), the old address told, old reset links stop                 | Stage 18 (`git log --grep "Stage 18"`) |
| Printable invoices for customers and admins (print or save as PDF)                                                          | Stage 19 (`git log --grep "Stage 19"`) |
| Export orders as CSV for a date range (and status) from the admin dashboard                                                 | Stage 20 (`git log --grep "Stage 20"`) |
| Product variants: one kind of option (size, colour…) with its own price, MRP and stock each                                 | Stage 21 (`git log --grep "Stage 21"`) |
| Photos per variant, picked from the product's photos                                                                        | Stage 22 (`git log --grep "Stage 22"`) |
| Back-in-stock alerts for one sold-out size or colour                                                                        | Stage 23 (`git log --grep "Stage 23"`) |
| Two kinds of option (e.g. colour and size) with a combination grid in the admin form                                        | Stage 24 (`git log --grep "Stage 24"`) |
| Database backups to a dated folder on your computer, and restore                                                            | Stage 25 (`git log --grep "Stage 25"`) |
| Tracking numbers: courier, number and tracking link on the order page, shipped email and export                             | Stage 26 (`git log --grep "Stage 26"`) |
| Link previews: product name, price, brand and photo in shared links (Open Graph), store image otherwise                     | Stage 27 (`git log --grep "Stage 27"`) |
| Returns: chosen items within 7 days of delivery, admin approve (stock back, refund) or decline                              | Stage 28 (`git log --grep "Stage 28"`) |
| Delivery PIN check on product pages, areas by PIN prefix in the admin panel, refused at checkout                            | Stage 29 (`git log --grep "Stage 29"`) |
| Two-step login with an authenticator app, recovery codes, admin reminder                                                    | Stage 30 (`git log --grep "Stage 30"`) |
