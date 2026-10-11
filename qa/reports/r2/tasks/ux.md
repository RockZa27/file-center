Start the app with UPDATE_PUBLIC_KEY set to a key you create in your scratchpad with `bun scripts/package.ts --gen-key <scratch dir>`, and SECURE_COOKIE unset (plain http).
1. csp-tour: visit as admin: dashboard, files (upload an image and a PDF, open the preview of each), users, activity, trash, update, backup, settings (upload a PNG logo), and the public page signed out. Count every console message that mentions "Content Security Policy" or "Refused to" as an error. Pass only with zero.
2. weak-password: open change password; type a 6-character password and then one equal to the username: the page shows the rule and the server refuses both with a message; a strong new password works and you stay signed in.
3. user-weak-password: on the users page try to create a user with password "password123"; it is refused with a message; with a strong password it is created.
4. update-unsigned-refused: build an unsigned package with a higher version (`bun scripts/package.ts --skip-web --version <higher> --out <scratch>`), drop it on the update page: it is refused with a message about the signature.
5. update-signed: build the same version signed with your key (`--sign <key file>`): the page shows it as signed and verified; install it; the page comes back on the new version.
6. health-anonymous: in a signed-out browser tab, open /api/health: only {"status":"ok"} (no version).
7. mobile: at 375 x 812 the change-password dialog and the update page have no horizontal scrolling.
