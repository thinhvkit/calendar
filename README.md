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

## Repeating events
In the event editor, pick **Never / Daily / Weekly / Monthly / Yearly**, and optionally an end date.
- Monthly on the 29th–31st skips months that don't have that day. A yearly event on Feb 29 only appears in leap years.
- When you edit or delete one occurrence, the app asks whether to change **This event only**, **This and following events**, or **All events in the series**.

## Quick add
When you create an event, type it the way you'd say it, for example "Lunch with Mai tomorrow 12:30", "Gym every monday 6:30pm !" or "Họp nhóm thứ 2 9h30". The app fills in the date, time, repeat and Important flag, and shows what it understood. Tap **Keep as typed** to turn this off for that event. Anything you set by hand is never overwritten.

## Lunar calendar (âm lịch)
Each day shows its lunar date. The first day of each lunar month shows as "1/9", and leap months are marked with "n". Vietnamese holidays (Tết, Giỗ Tổ, Trung Thu, Quốc khánh…) appear in the month view, and the day panel shows the full lunar date and year name (e.g. *Bính Ngọ*).
- Dates are calculated for Vietnam time (UTC+7).
- It's on by default for Vietnamese devices. Turn it on or off in **Data & settings → Display**.

## Photos
Each day has a **Photos** section with **Take photo** (opens the camera) and **From library**. On desktop you can also drag photos onto the day panel.
- Photos are copied into the app's private storage on your device, so they stay in the app even if you delete them from your phone's photo library.
- Browsers never let web pages keep a link to a file in your photo library, which is why the app keeps its own copy.
- If a library photo was taken on a different day, the app offers to **move it to that day**, based on the date stored inside the photo.
- Tap a photo to open the full-screen viewer. Swipe between photos, **Save to Photos** (share sheet), or remove it (with undo).
- **Back up** includes photos by default, so a single file restores everything.

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
