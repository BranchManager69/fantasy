import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { studioDirectory, privateDirectory } from "./league-studio-core";

export const STUDIO_COOKIE = "fantasy_studio";
const SESSION_SECONDS = 7 * 24 * 60 * 60;
export async function studioAccessToken(): Promise<string> {
  if (process.env.FANTASY_STUDIO_TOKEN) {
    if (process.env.FANTASY_STUDIO_TOKEN.length < 32) throw new Error("Studio access token must have at least 32 characters");
    return process.env.FANTASY_STUDIO_TOKEN;
  }
  const directory = studioDirectory();
  await privateDirectory(directory);
  const filename = path.join(directory, "access-token");
  try { await fs.writeFile(filename, randomBytes(32).toString("base64url"), { mode: 0o600, flag: "wx" }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  const stat = await fs.lstat(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 200) throw new Error("Studio access is unavailable");
  const token = (await fs.readFile(filename, "utf8")).trim();
  if (token.length < 32) throw new Error("Studio access is unavailable");
  return token;
}
function same(a: string, b: string) {
  return timingSafeEqual(createHash("sha256").update(a).digest(), createHash("sha256").update(b).digest());
}
export function sameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  const url = new URL(request.url);
  const host = request.headers.get("host");
  return origin === url.origin || origin === `${url.protocol}//${host}` || origin === `https://${host}`;
}
export async function createStudioSession(token: string, now = Date.now()) {
  const secret = await studioAccessToken();
  if (token.length > 200 || !same(token, secret)) throw new Error("That access code did not match");
  const expires = Math.floor(now / 1000) + SESSION_SECONDS;
  const payload = `v1.${expires}`;
  return `${payload}.${createHmac("sha256", secret).update(payload).digest("base64url")}`;
}
export async function studioAuthorized(request: Request, now = Date.now()) {
  const cookie = request.headers.get("cookie")?.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${STUDIO_COOKIE}=`))?.slice(STUDIO_COOKIE.length + 1);
  if (!cookie || cookie.length > 200) return false;
  const [version, expires, signature, extra] = cookie.split(".");
  if (version !== "v1" || extra || !/^\d{10}$/.test(expires) || !signature
    || Number(expires) <= Math.floor(now / 1000) || Number(expires) > Math.floor(now / 1000) + SESSION_SECONDS) return false;
  return same(signature, createHmac("sha256", await studioAccessToken()).update(`${version}.${expires}`).digest("base64url"));
}
export const studioHeaders = { "cache-control": "private, no-store", "x-content-type-options": "nosniff" };
