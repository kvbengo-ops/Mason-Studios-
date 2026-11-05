import type { JSX } from "react";
import { ImageGeneratorConsole } from "@/components/image-generator-console";

// The console itself lives in components/image-generator-console.tsx, shared
// with /create's Image tab. See that file for the guard and data notes.
export default function ImageGeneratorPage(): JSX.Element {
  return (
    <div className="flex min-h-full flex-col">
      <header className="sticky top-0 z-20 flex items-baseline gap-3 border-b border-border bg-background/85 px-4 py-3 backdrop-blur">
        <h1 className="text-sm font-semibold tracking-tight">Image Generator</h1>
        <p className="hidden text-xs text-muted-foreground sm:block">
          Describe the image you want to create.
        </p>
      </header>
      <ImageGeneratorConsole />
    </div>
  );
}
