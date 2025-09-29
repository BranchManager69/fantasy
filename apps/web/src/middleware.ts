import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { hostToLeagueSlug, defaultLeagueSlug } from "@/lib/league-host";

export function middleware(request: NextRequest) {
  const host = request.headers.get("host") || request.nextUrl.hostname;
  const slug = hostToLeagueSlug(host) || defaultLeagueSlug();
  const response = NextResponse.next();
  if (slug) {
    response.headers.set("x-fantasy-league-slug", slug);
  }
  return response;
}

export const config = {
  matcher: "/:path*",
};
