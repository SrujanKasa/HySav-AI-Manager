# HySav — marketing site + interactive dashboard demo

Launch-ready marketing website for **HySav**, a lightweight dashboard that shows small teams
every AI subscription they pay for, what's actually being used, and what's going to waste.

Static site — plain HTML/CSS/JS, no build step, no backend.

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
               differentiation, social-proof placeholders, waitlist form, footer
demo.html      Interactive dashboard demo (also embedded in index via iframe ?embed=1)
demo.js        Demo logic + all mock data (fictional company "Otterworks")
pricing.html   Pricing page: 3 flat tiers + FAQ
styles.css     Full design system (palette, type, components, responsive rules)
site.js        Shared behavior: scroll reveals, hero bars, waitlist form (mocked)
assets/        Brand assets: logo.svg (full lockup, dark), favicon.svg
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

- **Waitlist form is mocked** — it validates, captures email/team size/tool multi-select,
  logs the payload to the console, and shows a success state. Wire the `submit` handler
  in `site.js` to a real endpoint when ready.
- **Demo data** lives at the top of `demo.js` (`MEMBERS`, `TOOLS`, `ALERTS`) — edit freely.
- Icons: [Lucide](https://lucide.dev) via CDN. Fonts: Space Grotesk + Inter via Google Fonts.
- No stock imagery, no build tooling, fully responsive.
