ROOM/05 FRONT-END PATCH (PARTIAL)

This archive contains only the four files that were uploaded in this conversation:
.env.example
.gitignore
auth.css
auth.js

The supplied auth.css and auth.js include the requested frontend changes:
- A fullscreen toggle is added at the top of the page.
- Signed-in users get a profile/avatar menu with their username and ROOM/05 user ID.
- Logout is available inside that menu instead of being shown as a permanent inline action.
- Mobile tap highlight is suppressed and the new controls use restrained transitions.
- Existing API endpoints and backend requests are preserved.

IMPORTANT: This is not a complete website/repository export. The main HTML, other stylesheets/scripts, package files, server files, and any images/fonts/assets were not included in the upload. Do not use this partial archive to replace the entire GitHub repository. Replace the matching files in the existing repository, or provide the full project ZIP to produce a complete deploy-ready archive.
