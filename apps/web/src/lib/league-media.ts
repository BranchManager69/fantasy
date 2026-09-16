import type { StudioEpisode, StudioEpisodeCastMember } from "./studio-episode";

export type LeagueImageCrop = { x: number; y: number; width: number; height: number };
export type LeagueTeamImage = {
  teamId: number;
  imageUrl: string;
  kind: "photo" | "portrait" | "team-logo";
  peopleNames: string[];
  memberId?: string;
  crop?: LeagueImageCrop;
  imageWidth?: number;
  imageHeight?: number;
};
export type WeekLeagueMedia = {
  owners: Record<string, StudioEpisodeCastMember[]>;
  teamImages: Record<string, LeagueTeamImage[]>;
};
export type PublicLeagueEpisodeResponse = WeekLeagueMedia & { episode: StudioEpisode | null };
