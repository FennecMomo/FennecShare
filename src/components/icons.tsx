interface IconProps {
  size?: number;
  className?: string;
}

function base(size: number | undefined, className: string | undefined) {
  return {
    width: size ?? 18,
    height: size ?? 18,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.9,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    className,
    'aria-hidden': true,
    focusable: false,
  };
}

export function IconClose({ size, className }: IconProps) {
  return (
    <svg {...base(size, className)}>
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}

export function IconChevronLeft({ size, className }: IconProps) {
  return (
    <svg {...base(size, className)}>
      <path d="M15 5l-7 7 7 7" />
    </svg>
  );
}

export function IconChevronRight({ size, className }: IconProps) {
  return (
    <svg {...base(size, className)}>
      <path d="M9 5l7 7-7 7" />
    </svg>
  );
}

export function IconDownload({ size, className }: IconProps) {
  return (
    <svg {...base(size, className)}>
      <path d="M12 4v10m0 0l-4-4m4 4l4-4" />
      <path d="M4 17v2a1 1 0 001 1h14a1 1 0 001-1v-2" />
    </svg>
  );
}

export function IconExternal({ size, className }: IconProps) {
  return (
    <svg {...base(size, className)}>
      <path d="M14 4h6v6" />
      <path d="M20 4l-8.5 8.5" />
      <path d="M18 14v5a1 1 0 01-1 1H5a1 1 0 01-1-1V7a1 1 0 011-1h5" />
    </svg>
  );
}

export function IconRefresh({ size, className }: IconProps) {
  return (
    <svg {...base(size, className)}>
      <path d="M20 11a8 8 0 10-2.6 5.9" />
      <path d="M20 5v6h-6" />
    </svg>
  );
}

export function IconInbox({ size, className }: IconProps) {
  return (
    <svg {...base(size, className)}>
      <path d="M4 13l2.2-6.6A2 2 0 018.1 5h7.8a2 2 0 011.9 1.4L20 13" />
      <path d="M4 13v5a1 1 0 001 1h14a1 1 0 001-1v-5" />
      <path d="M9 13h6" />
    </svg>
  );
}

export function IconAlert({ size, className }: IconProps) {
  return (
    <svg {...base(size, className)}>
      <path d="M12 8v5" />
      <path d="M12 16.5h.01" />
      <path d="M10.3 4.3L3.6 16a1.4 1.4 0 001.2 2.1h14.4a1.4 1.4 0 001.2-2.1L13.7 4.3a1.9 1.9 0 00-3.4 0z" />
    </svg>
  );
}

export function IconShare({ size, className }: IconProps) {
  return (
    <svg {...base(size, className)}>
      <path d="M12 15V4" />
      <path d="M8.5 7.5L12 4l3.5 3.5" />
      <path d="M6 12v6a1 1 0 001 1h10a1 1 0 001-1v-6" />
    </svg>
  );
}

export function IconCheck({ size, className }: IconProps) {
  return (
    <svg {...base(size, className)}>
      <path d="M5 12.5l4.5 4.5L19 7" />
    </svg>
  );
}

export function IconFilter({ size, className }: IconProps) {
  return (
    <svg {...base(size, className)}>
      <path d="M4 6h16M7 12h10M10 18h4" />
    </svg>
  );
}
