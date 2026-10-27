# FILME backend

The Node.js / Express / MongoDB REST API of **FILME**, a cinema booking system (MERN). It handles accounts and sessions, movies, auditoriums, showtimes, seat claims, bookings, simulated payments and refunds, and the administrator tools.

- Frontend repository: https://github.com/fms-mn/final-project-2-frontend-webdevt
- Backend repository: this one
- Live site: https://filme-eqd4.onrender.com (backend on Render, MongoDB Atlas database)

Group 2, Section C3A.

## Tech

Node.js 18+, Express 4, Mongoose 8 (MongoDB with transactions), bcryptjs, JSON Web Tokens in HttpOnly cookies with CSRF protection.

## Run it locally

```bash
npm ci
cp .env.example .env     # then fill in MONGODB_URI and JWT_SECRET
npm run init-indexes     # collections, unique indexes, transaction check
npm run seed             # optional: sample movies, rooms and showtimes
ADMIN_EMAIL=you@example.com ADMIN_PASSWORD='at least 8 chars' npm run create-admin
npm run dev              # http://localhost:5000
```

MongoDB must support transactions, so use a free MongoDB Atlas cluster (a plain local `mongod` does not). On Windows PowerShell set the variables first, for example `$env:ADMIN_EMAIL = 'you@example.com'`, and use `npm.cmd`.

## Tests

```bash
npm test                 # about 210 automated tests, no database needed
npm run smoke            # end-to-end check against a real database
npm run concurrency      # many simultaneous requests for the same seat
```

## Deploy on Render

1. On render.com choose **New, Web Service** and pick this repository.
2. Settings: **Runtime** Node, **Build Command** `npm ci`, **Start Command** `npm start`, **Health Check Path** `/api/health`.
3. Environment variables:

| Name | Value |
|---|---|
| `NODE_ENV` | `production` |
| `TRUST_PROXY` | `1` |
| `MONGODB_URI` | your Atlas connection string |
| `JWT_SECRET` | a long random string (32+ characters) |
| `ALLOWED_ORIGINS` | the frontend address, for example `https://filme-frontend.vercel.app` (several are separated by commas) |
| `APP_URL` | the same frontend address, used in emails |

Do not set `PORT`. Never commit real values. After the first deploy open `/api/health`; it should answer `{"status":"ok",...}`.

### How the frontend reaches this API

The frontend on Vercel forwards `/api/*` to this server with a rewrite (see `vercel.json` in the frontend repository), so the browser only ever talks to one address and the login cookie stays first-party. This server must list the frontend address in `ALLOWED_ORIGINS`, because writes are only accepted from allowed origins.

## Emails (booking confirmations, cancellations, reminders)

The site sends these emails to customers: **welcome**, **booking confirmed with the receipt**, **booking cancelled** (with the refund), **showing cancelled by the cinema** (with the refund), **showing moved**, and a **reminder** a few hours before the showing. Nothing breaks if email is not set up: bookings work as usual and the emails are simply not delivered.

**To see how they look without setting anything up**, run `npm run mail:preview` in this folder and open `.mail-preview/index.html`. While developing, every email the app "sends" is also saved as a web page in `.mail-outbox/`.

**To really send them**, use [Brevo](https://www.brevo.com) (free: 300 emails a day). It sends over HTTPS, so it works on Render's free plan, which blocks the usual email ports.

1. Create a free Brevo account.
2. In Brevo, open **Senders, Domains & Dedicated IPs → Senders** and add the email address emails should come from (your own Gmail is fine). Brevo emails you a link to **verify** it. Until it is verified, Brevo refuses to send.
3. Open **SMTP & API → API Keys** and create a key. Copy it once; Brevo does not show it again.
4. In Render, open your web service → **Environment** and add:

   | Name | Value |
   | --- | --- |
   | `BREVO_API_KEY` | the key from step 3 |
   | `MAIL_FROM` | the sender address you verified in step 2 |
   | `MAIL_FROM_NAME` | `filme` (the name customers see) |
   | `APP_URL` | your website's address, such as `https://filme-frontend.vercel.app` (the Vercel address of the frontend), so the buttons and logo work |

5. Save; Render restarts the service. In the website, open **Admin → Settings → Email notifications**: it should say **Connected**. Press **Send me a test email** and check your inbox (and the spam folder the first time).

`REMINDER_HOURS` (default 3) changes how long before a showing the reminder goes out. Resend works too: set `RESEND_API_KEY` and `MAIL_FROM` instead (Resend only sends to other people once you verify a domain).

### Reminders when the free server is asleep

The reminder emails (and the "remind me when it opens" emails) are sent by a check the server runs every 10 minutes. A free Render server goes to sleep when nobody visits, and a sleeping server checks nothing, so reminders can arrive late or, if the showing has already started, not at all. To fix that for free, have a scheduler wake the server and run the check:

1. In Render → **Environment**, add `CRON_SECRET` with a long random value (16+ characters, for example from a password generator). Save; Render restarts the service. Without it the address below does not exist.
2. Create a free account at [cron-job.org](https://cron-job.org) and add a job:
   - **URL:** `https://YOUR-SERVICE.onrender.com/api/internal/sweep-reminders`
   - **Schedule:** every 10 minutes
   - **Request method:** `POST` (under *Advanced*)
   - **Headers:** `Authorization` = `Bearer ` followed by your `CRON_SECRET`
   - **Timeout:** the longest it allows (60 seconds). A sleeping server needs up to a minute to wake; if the first call times out the server still wakes up and checks by itself about a minute later, and the next call finds it awake.
3. Check it: run the job once. The answer should look like `{"showings":{"sent":0,"checked":0},"releases":{"sent":0,"checked":0}}`. A `401` means the token does not match `CRON_SECRET`; a `404` means `CRON_SECRET` is missing or shorter than 16 characters.

Calling it more often than needed is harmless: each reminder is marked as sent, and two checks that overlap are merged into one. Keep `CRON_SECRET` private like any other password. The cinema still has the in-server timer as a backup, and a paid always-on Render instance makes all of this unnecessary.

### Forgot password, and the code after a long time away

These two use the same email setup, so they work as soon as emails do:

- **Forgot password.** The sign-in page links to it. The customer types their email and gets a link that works for 60 minutes and only once (`RESET_MINUTES` changes this). Choosing a new password signs them out everywhere and sends a "your password was changed" notice. The page gives the same answer whether or not the email has an account.
- **A code after a long time away.** An account that has not signed in for 30 days (`VERIFY_AFTER_DAYS`, `0` turns it off) must enter a 6-digit code emailed to it, after the correct password. The code works for 10 minutes (`LOGIN_CODE_MINUTES`), five wrong tries end it, and a new one can be sent once a minute, three times in all. Accounts with no sign-in on record yet are not asked; their next sign-in starts the record.
- **Safety net.** If no email provider is set up (the Settings card does not say Connected), or the provider is down at that moment, nobody is asked for a code, so the site never locks everyone out.
- **Session ended.** The login session lasts a couple of hours (`SESSION_HOURS`). When it ends, the sign-in page says "Your session ended" instead of showing a bare form.


## How login works

The API uses a session cookie, not a token the page handles:

1. `POST /api/auth/login` (or `/register`) with `{ "email", "password" }`. The response sets an
   **HttpOnly** cookie (`filme_session`, valid 2 hours) and returns `{ user, csrfToken }`.
2. Send requests with cookies included (`fetch(..., { credentials: 'include' })`, or axios
   `withCredentials: true`). In development the page (`http://localhost:3000`) can call the API
   directly at `http://localhost:5000/api`: that origin is allowed and `localhost` ports count as the
   same site, so the cookie is sent. (Alternatively, add a Vite `/api` proxy to `localhost:5000`.)
3. On every write (`POST`, `PUT`, `PATCH`, `DELETE`) also send the header `X-CSRF-Token: <csrfToken>`.
   After a page reload, `GET /api/users/me` returns `{ user, csrfToken }` again (or 401 if signed out).
4. `POST /api/auth/logout` clears the cookie.

Errors are always JSON `{ "message": "..." }` (plus `"errors": { field: message }` for validation):
400 invalid input, 401 not signed in, 403 forbidden or deactivated, 404 not found, 409 conflict
(for example a duplicate email), 429 too many failed logins. The browser origin must be listed in
`ALLOWED_ORIGINS` (defaults to `http://localhost:3000` in development).

Public registration only ever creates regular users. The only way to create an administrator is the
`create-admin` script.

## Catalog, auditorium and showtime API

Prices are whole **centavos** (400.00 pesos is `40000`) and times are ISO dates in UTC. A `date`
filter means that calendar day in Asia/Manila.

| Who | Call | What it does |
|---|---|---|
| Public | `GET /api/movies`, `GET /api/movies/:id` | Published movies only. Filters: `search`, `genre`, `releaseFrom`, `releaseTo` (`YYYY-MM-DD`). Each movie has `trailerId` (a YouTube video id, or `null`), and what customers can book: `showStatus` (`coming_soon` before its release day, `now_showing` once released and it has a showing that can still be booked, `not_showing` when released with nothing to book), `upcomingShowings`, `nextShowing` and `fromPrice` (cheapest bookable ticket, centavos, or `null`). |
| Customer | `GET /api/reminders`, `PUT/DELETE /api/reminders/:movieId` | **Email reminders for coming-soon movies.** A signed-in customer turns a reminder on for a published movie that has not opened yet (409 once it has; admins get 403). The server emails the account address once, `RELEASE_REMINDER_DAYS` days before the release day (default 1, so the day before), and a swept job sends it, so someone who asks on the last day is emailed within minutes. The email says whether advance tickets are on sale. Removing an account removes its reminders. |
| Scheduler | `POST /api/internal/sweep-reminders` | Runs the reminder-email check on demand, so a scheduler can wake a sleeping free server and still get reminders out. Needs `Authorization: Bearer <CRON_SECRET>` (401 if wrong); without `CRON_SECRET` (16+ characters) the address returns 404. Overlapping calls share one sweep. See `docs/DEPLOY.md`. |
| Public | `GET /api/showtimes?movie=<id>&date=YYYY-MM-DD` | Future scheduled showtimes with auditorium, price, `remainingSeats` and `totalSeats`. |
| Public | `GET /api/showtimes/:id/seats` | Every seat label as `available`, `booked` or `blocked`. No customer information. `bookable` turns false once the sales cutoff has passed. Hidden showings are 404. |
| Admin | `GET/POST /api/admin/movies`, `PATCH /api/admin/movies/:id` | All statuses. A movie with upcoming showtimes cannot be archived, unpublished or change its duration. **A movie that is already released can only be published (created or changed to `published`) when it has at least one upcoming showing customers can book (409 otherwise); a coming-soon movie, whose release day is still ahead, may be published without showings.** Optional `trailerUrl` must be a YouTube link; an empty text clears it. The list also carries `showStatus`, `upcomingShowings`, `nextShowing`, `fromPrice`, `scheduledShowings` (all future scheduled showings), and `hiddenShowings` (hidden future showings). The release date cannot move past a showing that is already scheduled, and no showing can start before the movie's release day (create, edit, move, bulk and copy all check it). |
| Admin | `POST /api/admin/movies/:id/withdraw` | Takes a movie off sale in one step: cancels every coming showing and the confirmed bookings on them (seats freed), then archives the movie (`status: "draft"` moves it to draft instead). `{ "dryRun": true }` only returns how many showings and bookings it would cancel. Safe to repeat. |
| Admin | `DELETE /api/movies/:id` | Only a movie no showtime ever used (otherwise 409: archive it). |
| Admin | `GET/POST /api/auditoriums`, `PATCH/DELETE /api/auditoriums/:id` | Seat labels are generated from `rows` x `seatsPerRow`. The layout locks once a showtime uses it; delete only when unused (otherwise deactivate). |
| Admin | `POST /api/showtimes`, `PATCH /api/showtimes/:id` | The movie must not be archived (a draft is fine: customers cannot see or book its showings until the movie is published, the scheduler can publish the movie and showings together), the auditorium active, the start in the future. Overlaps in one auditorium are 409 (back-to-back is fine). Editing is blocked after the first booking. |
| Admin | `PATCH /api/showtimes/:id/cancel` | Cancels the showtime and all its confirmed bookings and frees the seats, in one transaction. Safe to repeat. |
| Admin | `DELETE /api/showtimes/:id` | Only a showtime with no booking history. |
| Admin | `GET/PATCH /api/admin/settings` | The cinema rules: `turnaroundMinutes` (gap an auditorium needs between shows, default 15), `salesCutoffMinutes` (online booking closes this long before the start, default 15) and `autoArchiveDays` (a released, published movie with no showings for this many days is archived by itself; default 30, `0` = off). Saved rules apply at once; showings already scheduled are not changed. |
| Admin | `GET/POST /api/admin/movies/auto-archive` | `GET` lists the movies the archive rule would archive right now (changes nothing); `POST` runs the rule now. The rule also runs every hour. A movie counts as quiet from the latest of its last showing, its release date and its last admin edit; a movie with a showing still to come is never archived. |
| Admin | `POST /api/showtimes/bulk` | One movie in one auditorium on a range of days (max 31) at several start times (`times: ["10:00","13:30"]`, cinema time), optional `weekdays` (0 = Sunday), `ticketPrice`, `published`. All or nothing, unless `skipConflicts: true`. `dryRun: true` only reports what would happen. `publishMovie: true` (also supported by `/api/showtimes/slots` for reviewed plans) publishes the movie and creates visible showings in the same transaction, requires at least one accepted showing beyond the sales cutoff, and refuses `published: false`. Max 200 showings per request. |
| Admin | `POST /api/showtimes/copy` | Copies the scheduled showings of `fromDate` (same movie, room, clock time, price) to each of `toDates`. Same `skipConflicts`, `dryRun` and `published` options. |
| Admin | `PATCH /api/showtimes/:id/reschedule` | New `startTime` and/or `auditorium` for a showing that may already have bookings. Customers keep their seats and price. A new room must have every booked seat open. The move is recorded (`rescheduledAt`, `originalStartTime`). |
| Admin | `PATCH /api/showtimes/:id/visibility` | `{ "published": false }` hides a showing from customers (not listed, not bookable). Refused while customers hold confirmed tickets. |
| Admin | `PUT /api/auditoriums/:id/blocked-seats`, `PUT /api/showtimes/:id/blocked-seats` | Replace the blocked seats of a room (every showing) or of one showing: `{ "seats": ["A1","B3"] }`. Blocked seats cannot be booked and do not count as seats for sale. A seat a customer holds cannot be newly blocked. |
| Admin | `GET /api/admin/showtimes` | Every showtime, any status. Filters: `movie`, `auditorium`, `status`, `date`. |

## Booking API

Send `{ "showtime": "<id>", "seats": ["A1", "A2"] }`. Everything else (owner, price, total, booking
code, status) is decided by the server, and any such field in the request is ignored.

| Who | Call | What it does |
|---|---|---|
| Signed in | `POST /api/bookings` | Holds all the seats or none, in one transaction. `201` with a `pending` booking whose seats stay held until `holdExpiresAt` (5 minutes): pay for it with `POST /api/bookings/:id/pay`. (With `PAYMENT_REQUIRED=false` it confirms at once.) `409` if a seat was just taken (nothing is kept: refresh `GET /api/showtimes/:id/seats` and choose again), or the showtime is cancelled, started or past the sales cutoff, or a seat is blocked. `404` for a hidden showing. `400` for bad seats. At most 10 seats. |
| Owner | `POST /api/bookings/:id/pay` | Pays a pending booking with the **simulated** gateway (no real money). Card: `{ method: "card", number, expiry: "MM/YY", cvc }` is charged at once (`200` with the confirmed booking, or `402` with the reason; the hold stays so the customer can retry). Wallet: `{ method: "gcash" or "maya", mobile }` answers `202` with a payment to approve. `409` if the hold ran out. Pressing Pay twice never charges twice. Test cards are listed in `server/services/payments.js` (4242 4242 4242 4242 succeeds, 4000 0000 0000 0002 is declined, ...). |
| Owner | `POST /api/payments/:id/authorize` | The simulated wallet app: `{ approve: true }` confirms the booking, `{ approve: false }` declines (`402`, hold kept). |
| Owner | `POST /api/bookings/:id/release` | Gives up an unpaid hold: the seats go back on sale at once. |
| Signed in | `GET /api/bookings/my` | Your tickets, newest first, with movie, showtime, auditorium and payment (`paymentStatus` paid or refunded, `payment` with method, last four digits, reference). Cancelled ones stay. Optional `?status=confirmed` or `cancelled`. Unpaid holds are not tickets. |
| Owner or admin | `GET /api/bookings/:id` | One booking. Anyone else gets `404`. |
| Signed in | `GET /api/bookings/my?scope=history&limit=5&page=1` | Backend-paginated History: cancelled tickets and confirmed tickets whose showtime has started. Optional `filter=all/cancelled/past`, literal title/reference `search`, and `order=newest/oldest`. Filtering precedes pagination; sorting uses showtime then ascending booking ID. Returns `{ records, total, overallTotal, page, limit, hasMore, nextPage, dayCounts }`. `total` matches the controls, `overallTotal` is all History, and `dayCounts` contains matching Manila date-group totals. |
| Signed in | `GET /api/bookings/my?scope=upcoming&limit=50&page=1` | Independently paged future confirmed tickets, ordered by showtime then booking ID. Same response metadata; no History search/filter applies. Ownership comes from the authenticated session. Without `scope`, the existing array response and booked-at ordering remain unchanged. |
| Owner or admin | `PATCH /api/bookings/:id/cancel` | Cancels and frees the seats, only before the showtime starts (`409` after). A paid booking is refunded in full (`paymentStatus: "refunded"`, with a refund reference). Cancelling a showing refunds all its paid bookings. Repeating is harmless. |
| Admin | `GET /api/admin/stats?from=2026-10-01&to=2026-10-07` | Revenue, tickets, customers, seats filled, a daily series and the top movies for up to 92 Asia/Manila days, plus the totals of the period before for comparison. Cancelled bookings never count as revenue. |
| Admin | `GET /api/bookings` | Every booking with its customer. Filters: `status`, `showtime`, `date`, plus `page` and `limit`. |

A booking cannot be edited: to change seats or showtime, cancel it and book again. The price is a
snapshot taken when booking, so later price changes never alter an existing booking.

