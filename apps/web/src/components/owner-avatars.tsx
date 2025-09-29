"use client";

import Image from "next/image";
import { useMemo, useState } from "react";

type Props = {
  teamId: number;
  ownersCount: number;
  size?: number;
  max?: number;
  className?: string;
};

function OwnerAvatar({ candidates, size, alt, onAllFail, zIndex, offset }: {
  candidates: string[];
  size: number;
  alt: string;
  zIndex: number;
  offset: number;
  onAllFail: () => void;
}) {
  const [index, setIndex] = useState(0);
  const src = candidates[index] ?? null;
  if (!src) return null;
  return (
    <Image
      src={src}
      alt={alt}
      width={size}
      height={size}
      unoptimized
      onError={() => {
        const next = index + 1;
        if (next < candidates.length) setIndex(next);
        else onAllFail();
      }}
      priority={false}
      style={{
        borderRadius: 9999,
        display: "inline-block",
        border: "1px solid rgba(255,255,255,0.25)",
        boxShadow: "0 0 0 1px rgba(8,14,28,0.6)",
        marginLeft: offset,
        zIndex,
        position: "relative",
      }}
    />
  );
}

export function OwnerAvatars({ teamId, ownersCount, size = 16, max = 2, className }: Props) {
  const count = Math.max(0, Math.min(ownersCount, max));
  const [hidden, setHidden] = useState<Record<number, boolean>>({});

  const candidates = useMemo(() => {
    if (count <= 0) return [] as string[][];
    const out: string[][] = [];
    for (let i = 1; i <= count; i += 1) {
      const list: string[] = [
        `/owners/${teamId}-${i}.png`,
        `/owners_alt/${teamId}-${i}.png`,
      ];
      if (i === 1) {
        list.push(`/owners/${teamId}.png`, `/owners_alt/${teamId}.png`);
      }
      out.push(list);
    }
    return out;
  }, [count, teamId]);

  if (count === 0) return null;

  const visible = candidates.filter((_, i) => !hidden[i]);
  if (visible.length === 0) return null;

  return (
    <span className={className ?? "owner-avatars"} aria-hidden>
      {visible.map((cands, index) => (
        <OwnerAvatar
          key={`${teamId}-slot-${index}`}
          candidates={cands}
          size={size}
          alt="Owner avatar"
          zIndex={100 - index}
          offset={index === 0 ? 0 : -6}
          onAllFail={() => setHidden((prev) => ({ ...prev, [index]: true }))}
        />
      ))}
    </span>
  );
}
