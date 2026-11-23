# Turn timings

A Hermes Desktop pane that shows how long turns take. It follows your selected chat, lists recent replies oldest first, and shows the running timer at the bottom. The package has no Python entry point or external dependencies.

## Try the review build locally

1. Check out the review branch. In the active Hermes Desktop installation, use the plugin directory shown under **Capabilities > Plugins**.
2. Copy `desktop/plugin.js` to `turn-timings/plugin.js` inside that directory. If a standalone copy already exists there, it takes precedence over a packaged install; use a separate test environment or keep using the existing copy instead of overwriting it.
3. Send a new prompt and check that the timer stays on its prompt row after the reply finishes. Reopen the chat to check that the duration persists. To hide the pane without disabling the plugin, right-click inside it and choose **Minimize**.

## Data and limitations

The plugin reads chat history through the Hermes gateway to show short prompt labels. Its local storage contains durations keyed by connection, profile, and message row ID, not prompt text or replies. It does not send telemetry or contact external services directly.

The plugin does not backfill earlier turns. A reload during a turn can lose the in-memory start time. Background turns can only be recorded when Hermes delivers both events with enough routing information to identify the chat. A missing measurement is shown as **Not recorded**.

## Verify the package

```sh
node --check desktop/plugin.js
node --test tests/plugin.test.mjs
hermes plugins validate . --install-deps
```
