import { NextResponse } from "next/server";
import { studioHeaders } from "./league-studio-auth";
import { PhotoLibraryError } from "./league-studio-photos";

export function photoError(error: unknown) {
  const status = error instanceof PhotoLibraryError ? error.status : (error as NodeJS.ErrnoException)?.code === "ENOENT" ? 404 : 400;
  const message = status === 404 ? "Photo unavailable" : error instanceof PhotoLibraryError ? error.message : "This photo could not be saved. Check the image and its labels.";
  return NextResponse.json({ error: message }, { status, headers: studioHeaders });
}
