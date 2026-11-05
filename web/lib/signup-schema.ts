// The one schema web/app/signup/page.tsx (react-hook-form + zodResolver)
// and actions/auth.ts's signUp both parse. If a username or password this
// schema accepts gets rejected by the other side, or vice versa, that's a
// bug in this file — not two implementations drifting apart.
//
// Deliberately excludes two rules that live in lib/signup-allowlist.ts and
// actions/auth.ts instead:
//   - SIGNUP_ALLOWED_DOMAINS: a server-only env var, unavailable in the
//     browser, so it can't be checked client-side at all.
//   - account availability (email and username): hits the database.
// Both stay server-only checks run after this schema passes, so this file
// never imports lib/signup-allowlist.ts or touches Supabase.

import { z } from "zod";
import { signupPasswordSchema } from "./signup-password";
import { usernameFieldSchema } from "./signup-username";

export const signupFormSchema = z
  .object({
    username: usernameFieldSchema,
    email: z.string().min(1, "Email is required.").email("Enter a valid email address."),
  })
  .and(signupPasswordSchema);

export type SignupFormValues = z.infer<typeof signupFormSchema>;
