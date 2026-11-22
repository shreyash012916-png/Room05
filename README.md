# ROOM/05 — Peer-to-peer video rooms (v6.7 Free deployment)

ROOM/05 is a browser-based room for video, voice, chat, reactions and screen sharing. Calls use browser WebRTC connections between participants. The Node server serves the website and relays the small signaling messages needed to connect peers.

## Latest interface refinements

- The account avatar is placed directly in the landing and in-call toolbars. Its menu shows the username, permanent ROOM/05 ID, Terms & Conditions, Privacy Policy, and sign-out action. The sign-out action is not permanently displayed.
- The in-call page hides the landing header and fullscreen targets only the call screen, preventing stacked/doubled headers.
- On small screens, the call controls remain visible in a compact two-row dock while the video area scrolls independently.
- Mobile tap highlighting is suppressed and toolbar/control feedback uses short, restrained transitions.

## What this package changes

- The Render service is configured as **Free**. There is no paid Starter plan, paid persistent disk, or `DATA_DIR` setting in this package.
- User accounts are stored in a separate PostgreSQL database (Neon), not in Render's local filesystem. This is required because a Render Free service has an ephemeral filesystem.
- The session-signing secret is also stored in PostgreSQL so a service restart does not invalidate every session.
- Username/password login remains part of ROOM/05 itself. Neon is only the database; it is not an external login or identity provider.
- Existing account, legal and room functionality is retained. This version adds room-wide Normal / Theater layouts, shared local-video playback in Theater mode (where the browser supports media capture), separate camera and presentation video tracks, one-presenter-at-a-time coordination, additional camera filters, Aarti effects, and an original synthesized room beat.
- Automatic video quality now reduces resolution, frame rate and per-peer bitrate as rooms grow; high manual presets are automatically capped in larger groups, and individual peer video bitrate adapts when packet loss is reported.

## Accounts and first-visit agreement

- On a browser's first visit (and whenever the legal policy versions change), the Terms & Conditions and Privacy Policy agreement appears before login.
- Users can create an account with a unique username and password, then sign in on another device with the same credentials.
- Each account receives a permanent `R05-...` user ID.
- Passwords are stored as salted Node.js `scrypt` hashes, not plain text.
- Account records and the session-signing secret are stored in PostgreSQL.
- There is no password-reset or self-service account-deletion feature. Users should keep their password safe.

## Free deployment overview

You need two free services:

1. **GitHub** — stores the project source code.
2. **Render Free Web Service + Neon Free PostgreSQL** — Render runs the website and Neon stores the accounts.

The providers can change their free-tier limits. This package creates no paid Render resource by design, but check the provider dashboards before confirming deployment and do not select a paid instance or add-on.

### Step 1 — Create the database on Neon

1. Create a project on Neon using its Free plan.
2. Open the project and select **Connect**.
3. Copy the PostgreSQL connection string. Use the pooled connection string shown by Neon and keep its `sslmode=require` parameter (and any other parameters Neon includes).
4. Keep this connection string private. Do not paste it into your website files or a public GitHub repository.

### Step 2 — Upload the project to GitHub

1. Create a new GitHub repository.
2. Upload **all files from this ZIP directly into the repository's root**. Do not create a subfolder for the files.
3. Confirm that `server.js`, `package.json`, `render.yaml`, `index.html`, and the CSS/JS files are visible at the repository's top level.

### Step 3 — Create the Render service

1. In Render, choose **New → Web Service** and connect the GitHub repository.
2. Set the service name to `room05` if Render asks.
3. Use the Node runtime, `npm install` as the build command, and `npm start` as the start command.
4. Select the **Free** instance type. Do not select Starter or another paid type. Do not add a persistent disk.
5. In the service's **Environment** settings, add:
   - Key: `DATABASE_URL`
   - Value: the private Neon connection string copied in Step 1
   - Key: `MAX_PEOPLE`
   - Value: `5`
6. Deploy. Render should install `pg` and `ws` from `package.json`.

The included `render.yaml` is also set to `plan: free`, has no disk, and asks for `DATABASE_URL` as a secret environment value. If you choose a Blueprint-based setup instead of creating a Web Service manually, check that the resulting service is still Free before confirming it.

### Step 4 — Verify the deployment

1. Open the deployed `https://...onrender.com` address.
2. Check `https://YOUR-SERVICE.onrender.com/health`. A successful response includes `"ok":true` and `"database":"connected"`.
3. Register a test account and note its `R05-...` ID.
4. Sign out, then sign in with the same credentials. After that, try signing in from another device/browser.
5. Confirm that the Terms & Conditions and Privacy Policy acceptance is shown on first visit.

## Free-tier behaviour and limitations

- Render Free web services can spin down after 15 minutes without inbound traffic. The next visit can take about a minute while the service starts again.
- Render Free web services have an ephemeral local filesystem and cannot attach persistent disks. ROOM/05 does not use the local filesystem for account data.
- Neon Free currently lists 1 GB of PostgreSQL storage per project and 100 compute-unit hours per project per month. When a provider quota is exhausted, database access or deployment availability can be affected until the quota resets or the plan changes.
- Free-tier limits and provider policies can change. “Free” is subject to those limits and is not a guarantee of unlimited usage or permanent future availability.
- The service keeps its active room list in memory. If Render restarts or spins down, active calls end; users can start a new room after it wakes. Registered accounts remain in Neon.
- The free setup uses public STUN servers. Some restrictive networks may still need a separately configured TURN relay; no paid TURN service is included.

## Local development

Node.js 18 or newer is required. Create a `.env` file using `.env.example` as a template and add your Neon `DATABASE_URL`, then run:

```bash
npm install
npm start
```

Open `http://localhost:3000`. Keep `.env` private; `.gitignore` excludes it.

## Environment variables

- `PORT` — supplied automatically by Render; defaults to `3000` locally.
- `DATABASE_URL` — required PostgreSQL connection string from Neon.
- `MAX_PEOPLE` — room limit, default 5 (hard maximum 5).
- `TURN_URL`, `TURN_USER`, `TURN_PASS` — optional TURN relay configuration for restrictive networks.

## Existing room features

- Up to five participants per room.
- Direct WebRTC video/audio, with server-relayed signaling.
- Live chat and reactions; chat is not archived.
- Camera, microphone, screen-share and device setup controls where browser support allows.
- Reconnect handling, room-tab protection, theme options, per-peer adaptive video quality, and room-wide Normal / Theater layout selection.
- Theater mode keeps camera tiles in a bottom filmstrip while one selected local video or screen presentation occupies the main stage. The person presenting controls playback; a new presenter must wait for the current one to stop.
- Extra reactions include an Aarti-style diya orbit and a synchronized original synthesized lo-fi loop. Filters remain local to each viewer.
- Terms page at `/terms.html` and Privacy Policy at `/privacy.html`.

## Provider documentation

- Render Free service limits: https://render.com/docs/free
- Render Blueprint configuration: https://render.com/docs/blueprint-spec
- Neon Free plan limits: https://neon.com/pricing
- Neon connection strings and Node.js clients: https://neon.com/docs/connect/connect-from-any-app

## Important notes

- Peer-to-peer mesh call quality depends on each participant's upload speed and network. Larger rooms automatically reduce camera resolution and bitrate, but this is still not an SFU architecture and cannot guarantee that every network can connect.
- For users behind strict NATs or carrier-grade firewalls, configure a reliable TURN relay using `TURN_URL`, `TURN_USER`, and `TURN_PASS`. A proper SFU deployment would be the next architectural step for consistently smooth larger group calls; it is not included in this free Render package.
- Screen sharing depends on browser support and may not work in some mobile browsers.
- Anyone with a valid room code can attempt to join while a seat is available.
- This ZIP does not contain your Neon database connection string or any other secret. Add secrets in Render's Environment settings.
- This version creates a fresh PostgreSQL account store; it does not automatically import accounts from an older v6.2 JSON-file deployment. If that older version already contains registered users, keep its old storage intact until those records are safely migrated.
