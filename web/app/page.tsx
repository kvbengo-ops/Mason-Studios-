import { redirect } from "next/navigation";

// The app is behind a login; proxy.ts sends signed-out visitors to /login,
// and authenticated visitors arriving at "/" start at the Create page.
export default function RootPage(): never {
  redirect("/create");
}
