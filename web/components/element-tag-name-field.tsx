"use client";

import { useId, useRef, useState } from "react";
import type { JSX } from "react";
import { checkElementUploadName } from "@/actions/check-element-upload-name";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";

export function ElementTagNameField({
  value,
  onChange,
  shared = true,
  disabled = false,
  label = "Tag name",
  name,
}: {
  value: string;
  onChange: (value: string) => void;
  shared?: boolean;
  disabled?: boolean;
  label?: string;
  name?: string;
}): JSX.Element {
  const id = useId();
  const sequence = useRef(0);
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<{
    value: string;
    shared: boolean;
    error: string | null;
  } | null>(null);
  const current = result?.value === value && result.shared === shared ? result : null;
  async function check(): Promise<void> {
    const request = ++sequence.current;
    setChecking(true);
    try {
      const error = await checkElementUploadName(value, shared);
      if (request === sequence.current) setResult({ value, shared, error });
    } catch {
      if (request === sequence.current)
        setResult({ value, shared, error: "Could not check the tag. Try again." });
    } finally {
      if (request === sequence.current) setChecking(false);
    }
  }
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      <div className="flex items-center gap-2">
        <Input
          id={id}
          name={name}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          required
          maxLength={64}
          placeholder="e.g. coffee_front"
          disabled={disabled}
          aria-describedby={`${id}-status`}
        />
        <Button
          type="button"
          variant="outline"
          disabled={disabled || checking || !value.trim()}
          onClick={() => void check()}
        >
          {checking ? "Checking..." : "Check name"}
        </Button>
      </div>
      <p
        id={`${id}-status`}
        role="status"
        className={`text-xs ${current?.error ? "text-destructive" : "text-muted-foreground"}`}
      >
        {current
          ? (current.error ?? `@${value.trim()} is available.`)
          : "Letters, numbers, - and _ only. Enter the name without @."}
      </p>
    </div>
  );
}
