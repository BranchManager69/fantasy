# Postgame calls

Claire calls the configured test recipient for a short interview about a completed matchup. She uses GPT-Live 1 for speech and a separately configurable Responses model for football research. Before dialing, the service prepares the official score, legal hindsight lineup, notable plays, league context, and explicitly mapped owner profiles. Her follow-up questions respond to the caller's answers.

The first version calls one configured recipient. It has no league-wide scheduler. The existing Twilio number can supply caller ID through per-call callbacks; its incoming-call configuration does not change. Owners do not need an account or an interview link.

## Run the service

The web package already pins OpenAI 7.15.0, which includes `LiveWS`. Twilio and `ws` provide the phone connection. Node 22 is required.

1. Set the server-only settings listed under the telephone reporter in `.env.example`, plus `OPENAI_API_KEY`, `FANTASY_REPO_ROOT`, and `DATA_ROOT`. Use an existing voice-capable Twilio number and the intended self-test recipient in E.164 format.
2. In the frontend package directory, install dependencies and verify the service with `npm ci`, `npm run test:interview`, and `npm run build:interview`.
3. Start `.phone-build/interview-server.cjs` under PM2 with those settings. It binds only to `127.0.0.1`, on port 40438 by default. Use one process instance.
4. Proxy `/interview/` from the HTTPS league hostname to that port. Preserve the route prefix, support WebSocket upgrades, disable proxy buffering, and allow at least the configured call duration plus 30 seconds. Do not proxy `/internal/`.

Public callbacks require Twilio signatures. A media connection also requires the token issued by its answer callback and matching account/call identifiers. Local operator commands require a bearer token; this is service authentication, not a member sign-in flow.

## Prepare and test

The following commands run from `apps/web` with `FANTASY_INTERVIEW_CONTROL_TOKEN` in the environment:

```bash
npm run interview -- status
npm run interview -- preflight
npm run interview -- prepare 2026 1 8 first-owner-test
npm run interview -- dial RUN_ID
npm run interview -- status
```

`prepare` reads the selected matchup and returns its brief without calling anyone. Its request identifier prevents duplicate preparation. `dial` first checks access to GPT-Live 1; a provider billing or connection failure stops before Twilio dials. A successful preflight establishes voice-session access, not the quality of an interview or success of a delegated research request.

Calls end when the reporter finishes, the caller hangs up, or the duration limit is reached. `npm run interview -- end RUN_ID` ends a reserved call. There are three dial attempts per UTC day by default, with a four-minute maximum for each. No failed or unanswered call is automatically retried.

Use a fresh request identifier for an intentional new test. If dispatch times out, its outcome is `unknown` and further calls remain blocked. Use `reconcile RUN_ID` once a call SID is known; check Twilio's call records before resolving an attempt with no SID. Never retry an uncertain outbound creation.

## Review the interview

Records live under `DATA_ROOT/private/interviews`. The service saves the prepared brief, speaker transcript fragments with timestamps, tool events, provider status, and raw 8 kHz mu-law audio for each side. These files are not public website media. The reporter identifies herself as an AI reporter and mentions that the test is recorded.

Final voice usage is confirmed only by `session.closed`. Backend usage is recorded separately. Twilio playback marks show which output reached the provider's playback queue completion; they do not establish that a person listened. A provider `completed` status alone is insufficient to call the interview successful.

Listen for whether Claire waits for an answer, follows a correction, stops speaking when interrupted, and asks a useful follow-up. Test a claim that needs `get_best_lineup`, then confirm the spoken result matches the evidence. Distinguish lineup hindsight from a decision the owner could have made before kickoff.

## Change the reporter

Edit `prompts/interview/reporter.md` for delivery and interview behavior, and `prompts/interview/researcher.md` for research instructions. Owner context comes from the existing studio profiles and explicitly sourced memories. The evidence preparation is independent of the speech and backend models.

Run the interview tests, build the service, and restart its PM2 process after code changes. Prompt changes take effect for newly prepared calls. Save feedback before changing multiple aspects of delivery at once.

Protocol references: [OpenAI Live WebSockets](https://developers.openai.com/api/docs/guides/voice-websockets?api=live), [delegation](https://developers.openai.com/api/docs/guides/live-delegation), and [Twilio media events](https://www.twilio.com/docs/voice/media-streams/websocket-messages).
