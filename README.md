# ROOM/05 — Peer-to-peer video rooms (v6.2)

ROOM/05 is a private browser-based room for video, voice, chat, reactions and screen sharing. Calls use browser WebRTC connections between participants. The Node server serves the website and relays the small signaling messages needed to connect peers.

## Accounts and first-visit agreement

**Source-file note:** the uploaded source set did not include `style.css` or `terms.html`, although the original HTML/server referenced them. This package includes a recreated `style.css` based on the supplied HTML structure and the supplied `legal.css`, plus the new Terms page. The recreated stylesheet restores the missing styles but cannot be a byte-for-byte copy of the omitted original design file.


- On a browser's first visit (and whenever the legal versions change), the Terms & Conditions and Privacy Policy agreement appears before login.
- Users can create an account with a unique username and password, or sign in on another device with the same credentials.
- Each account receives a permanent `R05-...` user ID. The ID is displayed in the account chip after sign-in.
- Passwords are stored as salted Node.js `scrypt` hashes, not plain text. No email, social login, third-party identity provider or external database is used.
- There is no password-reset or self-service account-deletion feature. Users should keep their password safe.
- Account records and the session-signing secret are written to `DATA_DIR`.

## Important: Render storage requirement

Cross-device accounts must be stored somewhere that survives server restarts. Render's Free web services use an ephemeral filesystem and cannot attach persistent disks. This project therefore configures a **Starter** web service with a **1 GB persistent disk** mounted at `/var/data`. The Blueprint sets `DATA_DIR=/var/data`. The Render Starter web-service tier and persistent disk are paid resources; the default pricing shown by Render is approximately $7/month for the service plus $0.25/month for a 1 GB disk, before taxes or pricing changes. Check Render's current pricing before deploying.

Do not change the service back to the Free plan or remove the disk: doing so will stop the account store from being durable. Keep one service instance because this project uses a local account file and an in-memory room list. Back up the account disk before making destructive changes.

## Deploy on Render

1. Upload every file from this ZIP to the root of a GitHub repository.
2. In Render, create a new Blueprint and connect that repository. Render reads `render.yaml`.
3. Review the Starter service and persistent disk resources and confirm them in Render.
4. Keep the service at one instance. The disk mount path must remain `/var/data`.
5. Open the HTTPS `onrender.com` URL. HTTPS is required for browser camera and microphone access.

If the service already exists as a Free web service, make sure the account service is upgraded and the persistent disk is attached and mounted at `/var/data` before relying on permanent accounts.

## Local run

```bash
npm install
npm start
```

Open `http://localhost:3000`. Local account data is stored in the ignored `data/` directory by default. You can set `DATA_DIR` to choose another writable directory.

## Existing room features

- Up to five participants per room.
- Direct WebRTC video/audio, with server-relayed signaling.
- Live chat and reactions; chat is not archived.
- Camera, microphone, screen-share and device setup controls where browser support allows.
- Reconnect handling, room-tab protection, theme options and adaptive video-quality presets.
- Terms page at `/terms.html` and Privacy Policy at `/privacy.html`.

## Environment variables

- `PORT` — Render supplies this automatically.
- `MAX_PEOPLE` — room limit, default 5 (hard maximum 5).
- `DATA_DIR` — writable durable account-storage directory. Use `/var/data` on Render with the included disk configuration.
- `TURN_URL`, `TURN_USER`, `TURN_PASS` — optional TURN relay configuration for restrictive networks.

## Important limitations

- Peer-to-peer quality depends on each participant's upload speed and network.
- Some networks require a TURN relay.
- Screen sharing depends on browser support and may not work in some mobile browsers.
- Anyone with a valid room code can attempt to join while a seat is available.
- Keep the Render persistent disk and its backups safe: the account file is the source of truth for usernames, user IDs and password hashes.
