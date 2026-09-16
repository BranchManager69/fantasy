export type PhotoLabel = {
  memberId?: string;
  name: string;
  position?: string;
  basis: "user_supplied";
};

export type PhotoMeme = {
  title: string;
  triggers: string[];
  caption: string;
  alternateCaption?: string;
  editPlan: string;
  prompt: string;
  priority: "high" | "medium" | "low";
};

export type PhotoCutout = {
  assetId: string;
  filename: string;
  memberIds: string[];
  createdAt: string;
};

export type PhotoTemplate = {
  id: string;
  filename: string;
  sourceAssetId: string;
  width: number;
  height: number;
  scene: string;
  editNotes: string;
  visibleText: string[];
  labels: PhotoLabel[];
  memes: PhotoMeme[];
  cutouts: PhotoCutout[];
  revision: number;
  createdAt: string;
  updatedAt: string;
};

export type PhotoSourceInput = Omit<PhotoTemplate, "sourceAssetId" | "cutouts" | "revision" | "createdAt" | "updatedAt">;
export type PhotoPatch = {
  revision: number;
  labels?: PhotoLabel[];
  scene?: string;
  editNotes?: string;
  cutoutAssignments?: { assetId: string; memberIds: string[] }[];
};
