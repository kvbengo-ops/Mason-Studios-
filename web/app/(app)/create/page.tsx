import { Suspense, type JSX } from "react";
import { requireUser } from "@/actions/guard";
import {
  CreateModeContent,
  CreateModeSkeleton,
  CreateModeSwitch,
} from "@/components/create-mode-switch";
import { CreateVideoConsole } from "@/components/create-video-console";
import { ImageGeneratorConsole } from "@/components/image-generator-console";
import { getAccountBudgetSnapshot } from "@/lib/spend";

async function CreateVideoTab({ scene }: { scene?: string }): Promise<JSX.Element> {
  const { user, profile } = await requireUser();
  const snapshot = await getAccountBudgetSnapshot(user.id, profile);
  return <CreateVideoConsole snapshot={snapshot} initialSceneId={scene} />;
}

// ONE PLACE TO MAKE THINGS. The Image tab is the personal image generator,
// unchanged; the Video tab is the /ugc prompt bar, starting a new clip
// project on each Generate. The tab is a search param rather than client
// state so a link, a refresh and the back button all land on the same tab.
// Each console runs its own requireUser, exactly as /image-generator does.
export default async function CreatePage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string; scene?: string }>;
}): Promise<JSX.Element> {
  const { tab, scene } = await searchParams;
  const video = tab === "video";
  await requireUser();

  return (
    <div data-create-page className="flex min-h-full w-full flex-col px-4 md:px-6">
      <header className="flex flex-wrap items-start justify-between gap-4 px-0 pb-4 pt-6">
        <div className="flex flex-col gap-1">
          <h1 className="text-3xl font-semibold tracking-tight">Create</h1>
          <p className="text-sm text-muted-foreground">
            Everything you generate lands here, newest first.
          </p>
        </div>
      </header>

      {/* Center the mode switch and keep Runs pinned at the top right. */}
      <div className="fixed left-1/2 top-16 z-20 -translate-x-1/2">
        <div className="w-64 overflow-hidden rounded-2xl border border-border bg-background/80 p-2 text-foreground shadow-lg backdrop-blur-md [&_nav]:w-full [&_nav]:border-0 [&_nav]:bg-muted/60 [&_nav]:shadow-none [&_nav]:backdrop-blur-none [&_nav_a]:flex-1 [&_nav_a]:justify-center">
          <CreateModeSwitch video={video} imageHref="/create" videoHref="/create?tab=video" />
        </div>
      </div>
      <div id="create-runs-control" className="fixed right-6 top-20 z-20" />

      <CreateModeContent video={video}>
        <Suspense key={video ? "video" : "image"} fallback={<CreateModeSkeleton video={video} />}>
          {video ? <CreateVideoTab scene={scene} /> : <ImageGeneratorConsole />}
        </Suspense>
      </CreateModeContent>
    </div>
  );
}
