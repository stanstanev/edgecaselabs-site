# edgecaselabs-site

Marketing site for [EdgeCase Labs](https://edgecaselabs.app), makers of [CamCut](https://edgecaselabs.app/camcut).

Static HTML. Deployed on Vercel. No build step.

## Structure

```
index.html        — EdgeCase Labs studio landing
camcut/index.html — CamCut product page
privacy.html      — Privacy Policy
terms.html        — Terms of Service
support.html      — Support + FAQ
```

## Local preview

Open `index.html` directly in a browser, or:

```bash
python3 -m http.server 8000
```

Then visit http://localhost:8000.

## Deploy

Auto-deploys to Vercel on push to `main`.
