import { timingSafeEqual } from "node:crypto";
import twilio from "twilio";

export interface PhoneConfig {
  accountSid: string; authToken: string; from: string; to: string;
  apiKey: string; controlToken: string; publicOrigin: string;
  port: number; maxSeconds: number; voice: string; backendModel: string;
}

export function phoneConfig(env: NodeJS.ProcessEnv): PhoneConfig {
  const required = (name: string) => {
    const value = env[name]?.trim();
    if (!value) throw new Error(`Missing ${name}`);
    return value;
  };
  const from = required("TWILIO_PHONE_NUMBER");
  const to = required("FANTASY_INTERVIEW_TEST_TO");
  if (![from, to].every((v) => /^\+[1-9]\d{7,14}$/.test(v))) throw new Error("Phone configuration must use E.164 numbers");
  if (from === to) throw new Error("The caller and recipient must differ");
  const publicOrigin = required("FANTASY_INTERVIEW_PUBLIC_ORIGIN");
  const url = new URL(publicOrigin);
  if (url.protocol !== "https:" || url.origin !== publicOrigin || url.username || url.password) {
    throw new Error("The interview public origin must be an HTTPS origin without a path");
  }
  const controlToken = required("FANTASY_INTERVIEW_CONTROL_TOKEN");
  if (controlToken.length < 32) throw new Error("The local control token is too short");
  const port = Number(env.FANTASY_INTERVIEW_PORT || 40438);
  const maxSeconds = Number(env.FANTASY_INTERVIEW_MAX_SECONDS || 240);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("Invalid interview port");
  if (!Number.isInteger(maxSeconds) || maxSeconds < 30 || maxSeconds > 300) throw new Error("Interview duration must be 30-300 seconds");
  return {
    accountSid: required("TWILIO_ACCOUNT_SID"), authToken: required("TWILIO_AUTH_TOKEN"),
    from, to, apiKey: required("OPENAI_API_KEY"), controlToken, publicOrigin, port, maxSeconds,
    voice: env.FANTASY_INTERVIEW_VOICE || "marin",
    backendModel: env.FANTASY_INTERVIEW_BACKEND_MODEL || "gpt-6-astra",
  };
}

export function authorizedControl(header: string | undefined, token: string): boolean {
  const candidate = Buffer.from(header || "");
  const expected = Buffer.from(`Bearer ${token}`);
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}

export function validTwilioRequest(config: Pick<PhoneConfig, "authToken" | "publicOrigin">,
  signature: string | undefined, pathname: string, params: Record<string, string>, websocket = false): boolean {
  if (!signature || !pathname.startsWith("/interview/") || pathname.includes("?") || pathname.includes("#")) return false;
  // The WebSocket upgrade is an HTTPS request. Accept the signed WSS spelling too;
  // both fixed URLs identify this exact route, with no request-controlled host.
  const https = config.publicOrigin + pathname;
  return twilio.validateRequest(config.authToken, signature, https, params)
    || (websocket && twilio.validateRequest(config.authToken, signature, https.replace(/^https:/, "wss:"), params));
}

export function answerXml(origin: string, runId: string, streamToken: string): string {
  const response = new twilio.twiml.VoiceResponse();
  const stream = response.connect().stream({ url: `${origin.replace(/^https:/, "wss:")}/interview/media/${runId}` });
  stream.parameter({ name: "token", value: streamToken });
  response.hangup();
  return response.toString();
}

export function validateMediaStart(start: Record<string, unknown>, expected: {
  accountSid: string; callSid: string; token: string;
}): string {
  const media = start.mediaFormat as Record<string, unknown> | undefined;
  const custom = start.customParameters as Record<string, unknown> | undefined;
  if (start.accountSid !== expected.accountSid || start.callSid !== expected.callSid
      || typeof custom?.token !== "string" || !authorizedControl(`Bearer ${custom.token}`, expected.token)) {
    throw new Error("Media stream does not match the reserved call");
  }
  if (media?.encoding !== "audio/x-mulaw" || media.sampleRate !== 8000 || media.channels !== 1) {
    throw new Error("Unexpected telephone audio format");
  }
  if (typeof start.streamSid !== "string" || !/^MZ[0-9a-f]{32}$/i.test(start.streamSid)) throw new Error("Invalid stream identifier");
  return start.streamSid;
}

/** Track Twilio playback receipts. A clear acknowledgement is never counted as heard. */
export class PlaybackReceipts {
  sentBytes = 0;
  playedBytes = 0;
  clearedBytes = 0;
  private nextMark = 0;
  private pending = new Map<string, { bytes: number; cleared: boolean }>();
  sent(bytes: number): string {
    this.sentBytes += bytes;
    const name = `audio-${++this.nextMark}`;
    this.pending.set(name, { bytes, cleared: false });
    return name;
  }
  acknowledge(name: string) {
    const mark = this.pending.get(name);
    if (!mark) return;
    if (!mark.cleared) this.playedBytes += mark.bytes;
    this.pending.delete(name);
  }
  clear() { for (const mark of this.pending.values()) { if (!mark.cleared) this.clearedBytes += mark.bytes; mark.cleared = true; } }
  get backlogMs() { return (this.sentBytes - this.playedBytes - this.clearedBytes) / 8; }
  get pendingCount() { return this.pending.size; }
}
