import { redirect } from "next/navigation";

// Spend is part of Accounts Control now — one admin page for the team's money
// and what it bought. Kept as a redirect so old bookmarks still land.
export default function SpendPage(): never {
  redirect("/accounts-control");
}
