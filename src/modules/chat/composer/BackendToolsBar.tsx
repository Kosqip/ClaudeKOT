import { useState } from 'react';
import type { ReactNode } from 'react';

import { cn } from '@/shared/utils';

type BackendTool = {
  id: string;
  label: string;
  content: ReactNode;
};

/**
 * One row of buttons under the composer, each opening a multi-backend tool
 * (send to several sessions, route by task type, split into subtasks). Closed
 * by default and one at a time, so the tools cost the transcript a single
 * line instead of a stack of always-open forms. A closed tool stays mounted,
 * only hidden: its result (the sessions it started, with their links) is
 * still there when it is opened again.
 */
export default function BackendToolsBar({ tools }: { tools: BackendTool[] }) {
  const [openToolId, setOpenToolId] = useState<string | null>(null);

  if (tools.length === 0) {
    return null;
  }

  return (
    <div className="px-4 pb-2">
      <div className="flex flex-wrap items-center gap-2">
        {tools.map((tool) => (
          <button
            key={tool.id}
            type="button"
            aria-expanded={openToolId === tool.id}
            onClick={() => setOpenToolId((current) => (current === tool.id ? null : tool.id))}
            className={cn(
              'rounded-full border px-3 py-1 text-xs transition-colors',
              openToolId === tool.id
                ? 'border-primary bg-primary/10 text-foreground'
                : 'border-border text-muted-foreground hover:bg-accent hover:text-foreground',
            )}
          >
            {tool.label}
          </button>
        ))}
      </div>
      {tools.map((tool) => (
        <div key={tool.id} hidden={openToolId !== tool.id} className="mt-2 max-h-[40vh] overflow-y-auto">
          {tool.content}
        </div>
      ))}
    </div>
  );
}
