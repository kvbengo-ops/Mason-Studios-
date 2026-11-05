// The one schema web/app/login/page.tsx (react-hook-form + zodResolver) and
// actions/auth.ts's signIn both parse. Unlike lib/signup-schema.ts, there is
// no separate pure-function module behind this: login has no rule beyond
// "these were typed in" for the client to check ahead of time — whether the
// credentials are actually valid is answered by
// supabase.auth.signInWithPassword, which this schema makes no attempt to
// replicate.

import { z } from "zod";

export const loginFormSchema = z.object({
  email: z.string().min(1, "Email is required.").email("Enter a valid email address."),
  password: z.string().min(1, "Password is required."),
});

export type LoginFormValues = z.infer<typeof loginFormSchema>;
