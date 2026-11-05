import { useId } from "react";
import type { JSX, SVGProps } from "react";

export function MaisonLogo(props: SVGProps<SVGSVGElement>): JSX.Element {
  const filterId = `maison-mark-${useId().replaceAll(":", "")}`;

  return (
    <svg viewBox="0 0 609 440" aria-hidden="true" focusable="false" {...props}>
      <defs>
        {/* Extract the blue mark from the white JPEG and tint it with the active theme color. */}
        <filter id={filterId} colorInterpolationFilters="sRGB">
          <feColorMatrix
            in="SourceGraphic"
            type="matrix"
            values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 -2.1 0 0 0 2.04"
            result="mark-mask"
          />
          <feFlood floodColor="currentColor" result="theme-color" />
          <feComposite in="theme-color" in2="mark-mask" operator="in" />
        </filter>
      </defs>
      <image
        href="/maison-cosmetics-logo.jpg"
        width="609"
        height="536"
        filter={`url(#${filterId})`}
      />
    </svg>
  );
}

export function MaisonWordmark({ className }: { className?: string }): JSX.Element {
  return (
    <span className={className}>
      <span className="block font-serif text-[15px] uppercase leading-none tracking-[0.17em]">
        Maison
      </span>
      <span className="mt-1 block text-[9px] font-medium uppercase leading-none tracking-[0.34em] opacity-65">
        Studios
      </span>
    </span>
  );
}
