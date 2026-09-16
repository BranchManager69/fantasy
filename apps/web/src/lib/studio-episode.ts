export type StudioEpisodeCastMember = {
  id: string;
  name: string;
  kind: "member" | "player";
  portraitUrl?: string;
};

export type StudioEpisodeScene = {
  id: string;
  kind: "replay" | "lineup" | "result" | "roast";
  title: string;
  commentary: string;
  assetUrl?: string;
  cast: StudioEpisodeCastMember[];
};

export type StudioEpisode = {
  id: string;
  title: string;
  season: number;
  week: number;
  teamId: number;
  createdAt: string;
  scenes: StudioEpisodeScene[];
};

export type StudioEpisodeResponse = { episode: StudioEpisode | null; owners: Record<string, StudioEpisodeCastMember[]> };
export type StudioEpisodeSelection = { season: number; week: number; teamId: number };
