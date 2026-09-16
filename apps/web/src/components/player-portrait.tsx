"use client";

import Image from "next/image";
import { useState } from "react";

type PlayerPortraitProps = {
  id?: number;
  name: string;
  className?: string;
  description?: string;
  priority?: boolean;
};

export function PlayerPortrait({ id, name, className = "", description, priority = false }: PlayerPortraitProps) {
  const [failedId, setFailedId] = useState<number>();
  const hasImage = id !== undefined && Number.isInteger(id) && id > 0 && failedId !== id;
  const initials = name.trim().split(/\s+/).filter(Boolean).map((part) => part[0]).filter((_, index, parts) => index === 0 || index === parts.length - 1).join("");

  return <span className={`week-portrait ${className}`} title={description ?? name}>
    {hasImage ? <Image
      src={`https://a.espncdn.com/i/headshots/nfl/players/full/${id}.png`}
      alt={description ?? ""}
      width={350}
      height={254}
      unoptimized
      priority={priority}
      onError={() => setFailedId(id)}
    /> : <span className="week-portrait-fallback" aria-label={description} aria-hidden={!description}>{initials || "?"}</span>}
  </span>;
}
