"use client";

import { useState } from "react";
import type { ChangeEvent, JSX } from "react";
import { createProject } from "@/actions/project";
import { ActionForm } from "@/components/action-form";
import { SubmitButton } from "@/components/submit-button";
import { PendingFieldset } from "@/components/pending-fieldset";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { MAX_TITLE_LENGTH } from "@/lib/title-guard";

// docs/architecture.md § "User flow": the compiler targets ~8s scenes,
// which read at roughly 15 spoken words. This is a rough operator-facing
// estimate only — the real scene count comes from the Claude compile step.
const WORDS_PER_SCENE = 15;

function estimateSceneCount(script: string): number {
  const trimmed = script.trim();
  if (trimmed.length === 0) {
    return 0;
  }
  const wordCount = trimmed.split(/\s+/).length;
  return Math.max(1, Math.ceil(wordCount / WORDS_PER_SCENE));
}

export function NewProjectForm(): JSX.Element {
  const [script, setScript] = useState("");

  const characterCount = script.length;
  const sceneEstimate = estimateSceneCount(script);

  function handleScriptChange(event: ChangeEvent<HTMLTextAreaElement>): void {
    setScript(event.target.value);
  }

  return (
    <ActionForm
      action={createProject}
      className="flex flex-col gap-6"
      fallbackErrorMessage="Failed to create project."
    >
      <PendingFieldset className="flex flex-col gap-6">
        <div className="flex flex-col gap-2">
          <Label htmlFor="title" required>
            Title
          </Label>
          <Input
            id="title"
            name="title"
            required
            maxLength={MAX_TITLE_LENGTH}
            placeholder="Q4 launch ad"
          />
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="script_raw" required>
            Script
          </Label>
          <Textarea
            id="script_raw"
            name="script_raw"
            required
            rows={16}
            placeholder="Paste the full script here…"
            value={script}
            onChange={handleScriptChange}
            className="font-mono"
          />
          <div className="flex justify-between text-xs text-muted-foreground">
            <span>{characterCount.toLocaleString()} characters</span>
            <span>
              ~{sceneEstimate} scene{sceneEstimate === 1 ? "" : "s"} estimated
            </span>
          </div>
        </div>
        <SubmitButton className="self-start" pendingLabel="Creating…">
          Create project
        </SubmitButton>
      </PendingFieldset>
    </ActionForm>
  );
}
