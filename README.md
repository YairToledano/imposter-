# אימפוסטר (Impostor)

[![Play Now](https://img.shields.io/badge/▶_Play_Now-2ea44f?style=for-the-badge)](https://yairtoledano.github.io/imposter-/)

חדש: גילוי מי היה האימפוסטר בסוף כל סבב

Offline, pass-the-phone party game. One shared phone, no accounts, no backend,
no build step — plain HTML/CSS/JS.

## Files

- `index.html` — the single page / entry point
- `styles.css` — dark theme, card flip animation, RTL layout
- `app.js` — game logic, screens, randomization, localStorage persistence
- `words.js` — the two word banks (`WORDS_GENERIC`, `WORDS_ISRAELI`) — edit these arrays to add/remove words
- `manifest.webmanifest` — PWA manifest (installable to home screen)
- `sw.js` — service worker that caches all assets for full offline use
- `icons/icon-192.png`, `icons/icon-512.png` — app icons

## Run it

No build step, no dependencies. Any static file server works.

```bash
# from this folder
npx serve .
# or
python -m http.server 8080
```

Then open the printed URL (e.g. `http://localhost:8080`) on your phone or in
a desktop browser. `index.html` can also be opened directly via `file://`,
but installing as a PWA and registering the service worker requires serving
over `http://` or `https://` (service workers don't run on `file://`).

## Install to home screen

- **Android (Chrome):** open the site, tap the ⋮ menu → "Add to Home screen" /
  "Install app".
- **iOS (Safari):** open the site, tap the Share icon → "Add to Home Screen".

Once installed, the app works fully offline (airplane mode included) — the
service worker pre-caches every file on first load.

## Playing

1. On the home screen, add at least 3 players (in the order you'll pass the
   phone), adjust settings if you like, then tap **התחל סבב**.
2. Pass the phone to each named player in turn. They tap the face-down card
   to privately reveal their word (or "אימפוסטר" if they're the impostor),
   then tap **העבר לשחקן הבא** to pass it on. There's no way to go back and
   peek at a previous player's card.
3. After the last player, the app announces who starts. Start a new round
   with the same players/settings via **סבב חדש**, or go back to the home
   screen.

Player list and settings persist across app restarts; a mid-round refresh
resumes exactly where you left off, face down.
