import type { JSX } from "react";
import { requireUser } from "@/actions/guard";
import { NewProjectForm } from "./new-project-form";

export default async function NewProjectPage(): Promise<JSX.Element> {
  await requireUser();

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-6 p-6">
      <div>
        <h1 className="text-2xl font-medium text-foreground">New project</h1>
        <p className="text-sm text-muted-foreground">
          Paste the script. Character setup comes next — this step is free.
        </p>
      </div>
      <NewProjectForm />
    </div>
  );
}
