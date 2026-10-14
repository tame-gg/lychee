/*
 * What's new in each version: the top of its GitHub Release's notes (scripts/release-notes.mjs).
 * A version tag with no entry here doesn't build (.github/workflows/release.yml), so add the
 * entry in the same PR as the version bump, newest first.
 *
 * `kind` is one of new, faster, improved or fixed; `text` may wrap `code` in backticks.
 */
;(function (root) {
  'use strict'

  root.LycheeChangelog = [
    {
      version: 'v0.1.1',
      items: [
        {
          kind: 'new',
          title: 'Automatic updates',
          text: 'Lychee now checks cdn.tame.gg for new versions and installs them (on Mac, via Homebrew).'
        },
        {
          kind: 'fixed',
          title: 'Mac app opens again',
          text: 'The Mac build is now signed correctly (ad-hoc), so macOS no longer reports it as damaged.'
        }
      ]
    },
    {
      version: 'v0.1.0',
      items: [
        {
          kind: 'new',
          title: 'First Lychee release',
          text: 'Lychee is a tame.gg download accelerator: parallel connections across every network you have, pause and resume, torrents, and a browser extension for Chrome and Firefox. Based on Plexo by Anmol Kapil, MIT license.'
        }
      ]
    }
  ]
})(typeof window !== 'undefined' ? window : module.exports)
