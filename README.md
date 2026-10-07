# Gmajna Music

## Windows installer and automatic updates

The Windows installer is built with `npm run dist`. Users on older portable or
unpacked builds must install this version once; those older builds cannot update
themselves. Later installed versions check GitHub Releases, download updates in
the background, and ask the user to restart to install them.

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
