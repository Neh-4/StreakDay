# DayForge

A daily productivity tracker for exercise, study, diet, and personal practice — built as an installable Progressive Web App (PWA) that works on phones, tablets, and desktops without going through an app store.

DayForge tracks five areas of a daily routine: workouts with auto-calculated lifting volume, Pomodoro study sessions, macro-nutrient intake from meals, a journaling/check-in practice, and one fully custom streak habit the user names themselves. Every module tracks a streak, keeps daily/weekly/monthly history, and syncs across devices.

---

## Table of contents

- [Features](#features)
- [Tech stack](#tech-stack)
- [Project structure](#project-structure)
- [Getting started locally](#getting-started-locally)
- [Setting up Firebase](#setting-up-firebase)
- [Deploying to Netlify](#deploying-to-netlify)
- [Installing as an app](#installing-as-an-app-pwa)
- [Data model](#data-model)
- [Known limitations](#known-limitations)
- [Roadmap](#roadmap)
- [License](#license)

---

## Features

**Exercise** — Log a workout by name (e.g. "Leg day"), add exercises with live autocomplete grouped by muscle group, record reps and weight per set, and watch total volume (reps × kg) calculate automatically per exercise and per day. History view breaks data down daily, weekly (volume + muscle groups trained), and monthly (frequency and volume per muscle group). Streak logic allows up to 2 rest days per week without breaking the streak.

**Study** — Pomodoro timer with 30 or 60 minute sessions, subject and topic tagging, a post-session difficulty rating, and a configurable break timer. Daily total hours are calculated automatically. History mirrors the Exercise module's daily/weekly/monthly structure. Streak breaks after 2 consecutive missed days.

**Diet** — Track protein, carbs, fats, and calories per meal. Choose from a 60+ item pre-loaded food library (including Indian staples like dal varieties, paneer, soya chunks, and sprouts) with live macro calculation by quantity, or switch to manual entry for home-cooked meals where macros are typed directly. Eggs are tracked by count rather than grams, calculated against a 50g medium egg. Users can save custom manual entries back into their personal library. Streak fires when the daily protein goal is met.

**Journal** — A daily check-in with an optional 10-minute timer and a free-text reflection field. A 28-day dot calendar visualizes consistency at a glance. Streak target (days per week) is configurable per user.

**Custom streak** — A fifth module left intentionally blank for the user to define — rename it to anything (Cold Shower, No Sugar, Read 10 Pages) via the in-app editor. Just a single check-in button and a streak counter.

**Cross-cutting features** — Multi-user support via username + PIN, editable profile (avatar, bodyweight, protein/calorie goals, PIN change), dark/light mode toggle, and a home dashboard summarizing all five streaks and today's progress in one view.

---

## Tech stack

| Layer | Technology |
|---|---|
| Frontend | Vanilla HTML, CSS, JavaScript (no framework, no build step) |
| Cloud database | Firebase Firestore |
| Authentication | Firebase Anonymous Auth (backstage identity; app-level login is username + PIN) |
| Offline cache | IndexedDB (browser-native) |
| Hosting | Netlify (static site, global CDN) |
| Installability | Web App Manifest + Service Worker (PWA) |

No npm install, no bundler, no backend server to maintain. The entire app is a single `index.html` file plus three small support files.

---

## Project structure

```
dayforge/
├── index.html           Main application — UI, logic, all 5 modules
├── manifest.json         PWA metadata (name, icons, theme color, display mode)
├── service-worker.js     Offline caching, background sync, push notifications
├── storage.js            (Reference) Firebase + IndexedDB storage adapter
├── _redirects            Netlify SPA routing fix
├── icons/
│   ├── icon-192.png
│   └── icon-512.png
└── README.md              This file
```

---

## Getting started locally

DayForge has no build step — you can open `index.html` directly in a browser to preview the UI. However, data storage requires Firebase to be configured (see below), so for full functionality:

1. Clone this repository
   ```bash
   git clone https://github.com/YOUR_USERNAME/dayforge.git
   cd dayforge
   ```
2. Open `index.html` in a browser, or serve it locally to test service worker behavior properly:
   ```bash
   npx serve .
   ```
3. Without Firebase configured, the app will load but data will not save. Continue to the Firebase setup section below.

---

## Setting up Firebase

DayForge uses Firebase for its cloud database (Firestore) and for satisfying security rules via Anonymous Authentication.

1. Go to [console.firebase.google.com](https://console.firebase.google.com) and create a new project.
2. **Authentication** → Sign-in method → enable **Anonymous**.
3. **Firestore Database** → Create database → Production mode → choose a region close to your users.
4. **Firestore → Rules** tab → paste:

   ```
   rules_version = '2';
   service cloud.firestore {
     match /databases/{database}/documents {
       match /users/{userId}/{document=**} {
         allow read, write: if request.auth != null && request.auth.uid == userId;
       }
       match /shared/{docId} {
         allow read: if request.auth != null;
         allow write: if request.auth != null;
       }
     }
   }
   ```

5. **Project settings** (gear icon) → Your apps → Web app (`</>`) → register the app → copy the `firebaseConfig` object.
6. Open `index.html`, find the `firebaseConfig` placeholder near the top of the `<script>` block, and paste your real values in.

---

## Deploying to Netlify

1. Create a free account at [netlify.com](https://netlify.com).
2. Drag and drop the entire `dayforge` folder onto the Netlify dashboard, **or** connect your GitHub repository for continuous deployment (recommended — every `git push` auto-deploys).
3. Netlify provides a URL like `your-app-name.netlify.app`.
4. Back in Firebase Console → Authentication → Settings → Authorized domains → add your Netlify domain. Without this step, sign-in will fail.
5. (Optional) Add a custom domain under Netlify → Domain management.

---

## Installing as an app (PWA)

**Android (Chrome)** — open the site, tap the three-dot menu → "Install app", or wait for the automatic install banner.

**iPhone (Safari only)** — open the site in Safari, tap the Share icon, scroll down and tap "Add to Home Screen", then tap Add. Chrome and Firefox on iOS cannot install PWAs due to platform restrictions; it must be Safari.

**Desktop (Chrome/Edge)** — an install icon appears in the address bar; click it to add DayForge as a standalone desktop app.

Once installed, the app opens fullscreen with no browser address bar and an icon on the home screen indistinguishable from a native app.

---

## Data model

All data is stored in Firestore under a `shared` collection, namespaced by key prefix (mirroring the original Claude-artifact storage pattern). Each user's records live under `u:{username}:...` keys, for example:

```
dayforge:u:arjun:day:2026-06-17        → daily summary (volume, hours, protein, etc.)
dayforge:u:arjun:ex:2026-06-17         → exercise log for that day
dayforge:u:arjun:study:2026-06-17      → study sessions for that day
dayforge:u:arjun:diet:2026-06-17       → meals logged for that day
dayforge:u:arjun:chant:2026-06-17      → journal check-in for that day
dayforge:u:arjun:custom:2026-06-17     → custom streak check-in for that day
dayforge:u:arjun:streaks               → current streak counts, all modules
dayforge:users                         → username → profile + PIN lookup table
```

A write-through cache to IndexedDB ensures the app remains responsive offline and that no data is lost if the app crashes mid-save; pending writes sync to Firestore automatically once connectivity returns.

---

## Known limitations

- Login is username + PIN rather than email-based — there is no password recovery flow. Losing both is unrecoverable for that account's data.
- All users currently share one Firestore "shared" collection namespaced by username string rather than being isolated by Firebase UID. This is simple and works well for personal or small group use, but does not provide hard data isolation guarantees at the database rule level.
- No automated backup/export is wired into the UI yet (see Roadmap).
- Push notifications (e.g. Pomodoro completion while backgrounded) require additional Firebase Cloud Messaging setup not yet included.

---

## Roadmap

- [ ] Migrate from username/PIN to Firebase email/password auth with password reset
- [ ] Move per-user data under `users/{uid}/...` paths for proper Firestore-level isolation
- [ ] Add in-app JSON export/import for manual backups
- [ ] Wire up push notifications for Pomodoro and streak-at-risk reminders
- [ ] Add weekly/monthly summary charts to the home dashboard
- [ ] Archive logs older than 90 days to keep Firestore usage within free tier as the user base grows

---

## License

This project is provided as-is for personal use. Adapt freely.
