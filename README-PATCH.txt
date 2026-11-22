ROOM/05 FRONT-END UI PATCH

This archive contains the four project files uploaded in this conversation, placed directly at the ZIP root:
- .env.example
- .gitignore
- auth.css
- auth.js

UI adjustments in this revision:
- Removed the separate fixed-position top-right control bar.
- Added compact icon-only profile and fullscreen actions.
- Places the profile avatar first (left), followed by fullscreen, in the existing camera/tool control group when a camera control can be detected.
- Profile menu contains username, ROOM/05 user ID, and logout; logout is not shown as a permanent page control.
- Uses neutral touch feedback and suppresses the blue mobile tap highlight.
- Preserves the existing authentication API routes and request payloads.

IMPORTANT:
Only four files were uploaded for editing. The main HTML, other site styles/scripts, server files, and static assets were not included. Therefore this is a patch ZIP, not a complete website export. Extract these files into the existing repository and replace the matching files. Do not delete or replace the rest of the repository with this ZIP.
