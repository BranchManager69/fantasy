import test from "node:test";
import assert from "node:assert/strict";
import twilio from "twilio";
import { answerXml, authorizedControl, phoneConfig, PlaybackReceipts, validTwilioRequest, validateMediaStart } from "./interview-phone";

const env = {
  NODE_ENV: "test" as const,
  TWILIO_ACCOUNT_SID: "AC" + "a".repeat(32), TWILIO_AUTH_TOKEN: "test-auth",
  TWILIO_PHONE_NUMBER: "+15550000001", FANTASY_INTERVIEW_TEST_TO: "+15550000002",
  OPENAI_API_KEY: "test-key", FANTASY_INTERVIEW_CONTROL_TOKEN: "x".repeat(32),
  FANTASY_INTERVIEW_PUBLIC_ORIGIN: "https://league.example",
};
test("only the configured self-test recipient is accepted and duration is bounded", () => {
  assert.equal(phoneConfig(env).to, env.FANTASY_INTERVIEW_TEST_TO);
  assert.throws(() => phoneConfig({ ...env, FANTASY_INTERVIEW_TEST_TO: "" }));
  assert.throws(() => phoneConfig({ ...env, FANTASY_INTERVIEW_TEST_TO: env.TWILIO_PHONE_NUMBER }));
  assert.throws(() => phoneConfig({ ...env, FANTASY_INTERVIEW_MAX_SECONDS: "1000" }));
  assert.throws(() => phoneConfig({ ...env, FANTASY_INTERVIEW_PUBLIC_ORIGIN: "https://league.example/evil" }));
});
test("callback authentication binds the signed body and exact public route", () => {
  const config = phoneConfig(env);
  const path = "/interview/status/uuid";
  const body = { CallSid: "CA" + "b".repeat(32), CallStatus: "completed" };
  const signature = twilio.getExpectedTwilioSignature(config.authToken, config.publicOrigin + path, body);
  assert.equal(validTwilioRequest(config, signature, path, body), true);
  assert.equal(validTwilioRequest(config, signature, path, { ...body, CallStatus: "ringing" }), false);
  assert.equal(validTwilioRequest(config, signature, "/interview/status/other", body), false);
  assert.equal(validTwilioRequest(config, undefined, path, body), false);
  assert.equal(authorizedControl("Bearer " + config.controlToken, config.controlToken), true);
  assert.equal(authorizedControl("Bearer wrong", config.controlToken), false);
});
test("a signed socket must still belong to its single reserved call and audio codec", () => {
  const expected = { accountSid: env.TWILIO_ACCOUNT_SID, callSid: "CA" + "b".repeat(32), token: "z".repeat(32) };
  const start = { accountSid: expected.accountSid, callSid: expected.callSid,
    streamSid: "MZ" + "c".repeat(32), customParameters: { token: expected.token },
    mediaFormat: { encoding: "audio/x-mulaw", sampleRate: 8000, channels: 1 } };
  assert.equal(validateMediaStart(start, expected), start.streamSid);
  assert.throws(() => validateMediaStart({ ...start, callSid: "CA" + "d".repeat(32) }, expected));
  assert.throws(() => validateMediaStart({ ...start, mediaFormat: { ...start.mediaFormat, sampleRate: 24000 } }, expected));
  assert.throws(() => validateMediaStart({ ...start, customParameters: { token: "wrong" } }, expected));
  assert.match(answerXml("https://league.example", "run-1", expected.token), /wss:\/\/league.example\/interview\/media\/run-1/);
});
test("cleared Twilio marks never establish that the caller heard the audio", () => {
  const receipts = new PlaybackReceipts();
  const first = receipts.sent(1600);
  const second = receipts.sent(1600);
  assert.equal(receipts.backlogMs, 400);
  receipts.acknowledge(first);
  assert.equal(receipts.playedBytes, 1600);
  receipts.clear();
  receipts.acknowledge(second);
  assert.equal(receipts.playedBytes, 1600);
  assert.equal(receipts.pendingCount, 0);
  const third = receipts.sent(800);
  receipts.acknowledge(third);
  assert.equal(receipts.playedBytes, 2400);
  assert.equal(receipts.backlogMs, 0);
});
