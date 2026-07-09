# HySav — marketing site + interactive dashboard demo

Launch-ready marketing website for **HySav**, a lightweight dashboard that shows small teams
every AI subscription they pay for, what's actually being used, and what's going to waste.

Static site — plain HTML/CSS/JS, no build step. Talks to the `hysav-api`
backend when served alongside it (auth, billing, live demo data); degrades to
built-in sample data when hosted purely statically.

## Run locally

Open `index.html` in a browser, or serve the folder (recommended, so the embedded demo iframe works everywhere):

```bash
npx serve .
# or
python -m http.server 8000
```

Then visit `http://localhost:8000` (or the port `serve` prints).

## Structure

```
index.html     Landing page: hero, problem, embedded demo, how-it-works,
               differentiation, social-proof placeholders, get-started CTA, footer
demo.html      Interactive dashboard demo (also embedded in index via iframe ?embed=1)
demo.js        Demo logic (fetches /api/v1/demo/dashboard, falls back to mock data)
pricing.html   Pricing page: trial + 2 paid tiers, FAQ, Razorpay checkout wiring
login.html     Email/password login (+ Google button when OAuth configured)
signup.html    Workspace signup — the front door to the 3-day trial
account.html   Logged-in view: plan/billing, subscribe via Razorpay, team list
auth.js        Session helpers (bearer token in localStorage, API fetch wrapper)
billing.js     Razorpay Checkout flow (subscription create → verify)
styles.css     Full design system (palette, type, components, responsive rules)
site.js        Shared behavior: scroll reveals, hero bars, auth-aware nav link
assets/        Brand assets: logo.svg (wordmark, dark), favicon.svg
assets/logos/  Real product icons for the AI tools shown on the site
               (hero card, demo tool cards, team chips)
```

## Branding

The logo is the **HySav | AI MONIT** wordmark: "Hy" in an orange gradient,
"Sav" in a blue→purple gradient, with the "AI MONIT" tag after a divider.
In page headers/footers it's rendered as pure CSS gradient text
(`.brand-hy`, `.brand-sav`, `.brand-tag` in `styles.css`); standalone SVG
versions live in `assets/` (`logo.svg` for the full dark lockup,
`favicon.svg` for the browser tab icon).

## Renaming the product

The brand name is the plain string `HySav` everywhere (markup, titles, copy).
Find & replace `HySav` across the folder to rename, and update the wordmark
spans (`brand-hy` / `brand-sav`) plus the SVGs in `assets/`.

## Notes

- **Signup/login are real** — they call the hysav-api backend; there is no
  waitlist anymore. Users sign up, get a 3-day full trial, and pay via
  Razorpay to keep the product.
- **Demo fallback data** lives at the top of `demo.js` (`MEMBERS`, `TOOLS`,
  `ALERTS`) — used only when the API isn't reachable.
- Icons: [Lucide](https://lucide.dev) via CDN. Fonts: Space Grotesk + Inter via Google Fonts.
- No stock imagery, no build tooling, fully responsive.
