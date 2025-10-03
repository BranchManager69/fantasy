import Link from "next/link";

type AppNavProps = {
  brandHref?: string;
  brandLabel?: string;
};

export function AppNav({ brandHref = "/", brandLabel = "Fantasy League Engine" }: AppNavProps) {
  return (
    <nav className="app-nav">
      <Link href={brandHref} className="app-nav__brand">
        {brandLabel}
      </Link>
    </nav>
  );
}
