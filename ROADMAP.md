# Roadmap

Ideas for the store that are suggested but not built yet, and the ones that were set aside. Each idea says why it is
worth doing and what to type to start it. When one is built, it moves to **Done** with its commit.

Live site: https://bazaar-jup1.onrender.com (Render free plan; every push to `main` deploys).

## Next

| #   | Idea                          | Why                                                                                                                                                                                                             | To start                           |
| --- | ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| 1   | Email the admin on new orders | So nobody has to keep checking the admin panel.                                                                                                                                                                 | "email me new orders"              |
| 2   | Clean up unused uploads       | Images uploaded in the admin panel but never saved to a product stay in MongoDB forever; Atlas's free tier is 512 MB.                                                                                           | "clean up unused uploads"          |
| 3   | Limit login tries per network | Login is limited per email (below), but one person could try one common password on many accounts. Needs a check first of which address Render passes on as the visitor's IP, so shared proxies aren't blocked. | "limit login tries per network"    |
| 4   | Change email                  | The account page can't change the email: the new address must be confirmed by a link sent to it first, and the old address told.                                                                                | "let customers change their email" |

## Set aside

- **A domain of your own** (e.g. `bazaar.in`, about ₹800 a year): a nicer address, and emails that land in spam less
  often (Brevo can then sign them for the domain). Postponed on 2026-10-22: nothing to buy for now. To start: "start
  the domain setup".
- **Render Starter plan** ($7 a month): no sleeping after 15 idle minutes, no slow first visit, and the unpaid-order
  sweep runs on time. A switch on Render, no code change.
- **Partial search matches**: every search word must match something, so "wireless earbuds" finds nothing. Showing
  products that match only some words would also bring in weak results; left out on purpose.

## Done

| What                                                                                                                  | Commit                                 |
| --------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| Stages 1–5: catalog, accounts and checkout, admin panel, Razorpay (test), reviews                                     | `480ad9a`                              |
| Deployed on Render, with health check and Secure cookies                                                              | `344462a`                              |
| Order emails through Brevo                                                                                            | `1e27f0b`                              |
| Password reset by email                                                                                               | `e15881c`                              |
| Better search ranking                                                                                                 | `e6505fe`                              |
| Login protection (5 wrong passwords pause an email for 15 minutes); reset can't reuse the current password            | Stage 9 (`git log --grep "Stage 9"`)   |
| Account page: name, saved address, change password (current one needed, no reuse, other devices logged out)           | Stage 10 (`git log --grep "Stage 10"`) |
| Back-in-stock alerts: logged-in customers ask on a sold-out product's page and get one email when it's back           | Stage 11 (`git log --grep "Stage 11"`) |
| Search suggestions: categories and the top 6 products in a dropdown while typing, with keyboard support               | Stage 12 (`git log --grep "Stage 12"`) |
| Coupon codes: % off (with a cap), amount off or free delivery; minimum order, last day, total uses; once per customer | Stage 13 (`git log --grep "Stage 13"`) |
| Sales dashboard: revenue per day, totals against the period before, best sellers, orders to ship, low stock           | Stage 14 (`git log --grep "Stage 14"`) |
