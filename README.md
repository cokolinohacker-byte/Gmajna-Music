# Gmajna Music

## Desktop menus and plugins

The desktop app uses YouTube Music's native interface with Gmajna branding,
Jam, and built-in visual extensions. Search and playback use YouTube Music,
so an internet connection and YouTube Music availability are still required.
The custom home, search, library, and playback-bar interface can be enabled
with `GMAJNA_CUSTOM_UI=1`; it is disabled by default. The custom title bar has
`Plugins`, `Options`, `View`, `Navigation`, and `About`, plus window controls.
Open
`Plugins > Manage Plugins` to enable or disable the built-in visual extensions,
including a subtle moving highlight on the active progress line while music is
playing, or choose `Options > Appearance and themes` to change the saved color
theme. The Gmajna logo and name appear at the upper left below the app menu
and change with the selected theme: gold, blue, or purple. They are hidden
while the app is in fullscreen mode.
The Jam control is available at the bottom left and from the `Plugins` menu.

Run `npm run start:unpacked` to rebuild and launch the desktop app in
`dist/win-unpacked`. Desktop edits in `main.js`, `preload.js`, and `assets`
are included in that build. Android/APK changes remain separate in
`android-app`.

## Windows installer and automatic updates

The Windows installer is the `.exe` asset on the GitHub Releases page. Do not
open the `.blockmap` or `latest.yml` assets; they are updater metadata. Users on
older portable or unpacked builds must install this version once; those older
builds cannot update themselves. Later installed versions check GitHub Releases,
download updates in the background, and ask the user to restart to install them.

The release workflow publishes to the public repository
`cokolinohacker-byte/gmajna-music`. Create that repository and push this project,
including `.github/workflows/release.yml`, before publishing the first release.

To publish an update:

1. Increment `version` in `package.json` and keep `package-lock.json` in sync
   (`npm install` does this).
2. Commit and push the changes to the default branch.
3. Create and push a matching version tag, for example:

   ```powershell
   git tag v1.1.1
   git push origin v1.1.1
   ```

GitHub Actions builds the Windows installer and publishes a GitHub Release.
Installed copies check for releases at startup and every six hours. The
repository must remain public so the updater can fetch releases without a
personal access token.
