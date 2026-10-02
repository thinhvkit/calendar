# Calendar

A simple, private calendar for **events** and **daily notes**, with a built-in **assistant**. You can install it as an app (PWA) on iPhone, Android and desktop, and it works offline.

## Assistant (✦ button, or press `A`)
- **This week**: shows how many events you have, the busiest day, open days, overlapping or back-to-back events, important events, and a preview of the next week. It runs offline and is always available.
- **Ask**: ask questions about your events and notes, e.g. "when is the dentist?", "am I free this weekend?", "what's on next Monday?".
  - Exact answers are built from your own events and show up instantly.
  - **On-device AI** (optional): downloads Qwen 2.5 0.5B (≈280 MB) or Llama 3.2 1B (≈700 MB) once, and runs it with WebLLM on WebGPU. It adds a friendly sentence to each answer. Anything the AI writes is fact-checked against your calendar, and sentences with wrong days, times or "important" labels are removed.
- **Urgent alerts**:
  - A banner at the top of the app shows events starting soon and important events.
  - Notifications fire while the app is open or was used recently. On Chrome and Android, installed copies of the app can also check in the background.
  - You choose the lead time (15 min to 2 h). Important events can also get a heads-up a day early.
- **Weekly digest**: the first time you open the app each week, it shows a summary of the week ahead.

Mark an event **Important** in the editor so it gets earlier alerts and is highlighted.

## Your data
- Stored only on your device (IndexedDB). Nothing is uploaded, including what you ask the AI.
- **Back up** saves a `.json` file. On phones it opens the share sheet, so you can save to Files, iCloud Drive or Google Drive.
- **Restore** loads a backup file (with undo).
- On desktop Chrome or Edge you can **link a file** that updates automatically after every change.

## Install on your phone
- **iPhone (Safari):** Share → *Add to Home Screen*. You need to do this before notifications will work.
- **Android (Chrome):** menu → *Install app*

## Keyboard (desktop)
| Key | Action |
|---|---|
| `←` `→` `↑` `↓` | Move between days |
| `PgUp` / `PgDn` | Previous / next month |
| `T` | Today |
| `N` or `Enter` | New event |
| `A` | Open the assistant |
| `/` | Ask a question |

## Hosting
The app is static files only, so any HTTPS host works (GitHub Pages, Netlify, Cloudflare Pages).
Bump `VERSION` in `sw.js` when you publish changes.
