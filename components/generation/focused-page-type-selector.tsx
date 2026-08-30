'use client';

import { Box, CircleHelp, Gamepad2, Network, SlidersHorizontal } from 'lucide-react';
import type { FocusedPageType } from '@/lib/types/generation';
import { cn } from '@/lib/utils';

const PAGE_TYPES: Array<{
  value: FocusedPageType;
  label: string;
  icon: typeof Box;
}> = [
  { value: 'visualization3d', label: '3D 可视化', icon: Box },
  { value: 'simulation', label: '互动模拟', icon: SlidersHorizontal },
  { value: 'game', label: '教学游戏', icon: Gamepad2 },
  { value: 'mindmap', label: '思维导图', icon: Network },
  { value: 'quiz', label: '测验', icon: CircleHelp },
];

export function FocusedPageTypeSelector({
  value,
  onChange,
  disabled,
}: {
  value: FocusedPageType;
  onChange: (value: FocusedPageType) => void;
  disabled?: boolean;
}) {
  return (
    <div
      role="radiogroup"
      aria-label="选择单页内容类型"
      className="grid grid-cols-2 gap-1.5 px-3 pb-2 sm:grid-cols-5"
    >
      {PAGE_TYPES.map((item) => {
        const Icon = item.icon;
        const selected = value === item.value;
        return (
          <button
            key={item.value}
            type="button"
            role="radio"
            aria-checked={selected}
            disabled={disabled}
            onClick={() => onChange(item.value)}
            className={cn(
              'flex min-h-10 cursor-pointer items-center justify-center gap-1.5 rounded-lg border px-2 text-xs font-medium transition-colors',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/45 focus-visible:ring-offset-1',
              selected
                ? 'border-primary/45 bg-primary/10 text-primary'
                : 'border-border/60 bg-background/45 text-muted-foreground hover:border-primary/25 hover:bg-muted/60 hover:text-foreground',
              disabled && 'cursor-not-allowed opacity-50',
            )}
          >
            <Icon className="size-3.5 shrink-0" aria-hidden="true" />
            <span>{item.label}</span>
          </button>
        );
      })}
    </div>
  );
}
